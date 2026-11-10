// A protocol client for the room server: the browser uses the global WebSocket, headless clients (tests, the smoke check)
// pass the `ws` package's class. It keeps the private reconnect token in memory only (never in a URL or log), numbers held
// controls and actions, and resends held controls as a heartbeat so the server's input timeout never fires while a pedal
// is really held. An app-level ping and a receive watchdog notice a socket that died without a close event (half-open TCP
// behind a proxy, a sleeping phone, a NAT timeout): the server has hung up, but nothing tells the browser.
import { PROTOCOL_NAME, PROTOCOL_VERSION, type ClientMsg, type PublicRoom, type ServerMsg } from './protocol';
import type { ActionType } from '../race';

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketCtor = new (url: string, protocols?: string | string[], opts?: never) => SocketLike;

export const HEARTBEAT_MS = 250;
export const CONNECT_TIMEOUT_MS = 8000;
/** An app-level ping this often while any socket is open, so an idle lobby or results screen still hears from the server. */
export const PING_MS = 5000;
/** Silence that means the socket is dead: snapshots come at 20 Hz in a race; elsewhere a pong is due every PING_MS. */
export const WATCHDOG_RACE_MS = 4000;
export const WATCHDOG_IDLE_MS = 12000;
/** How often the keepalive looks at the clock; a tick this much later than due means this page itself was suspended. */
export const KEEPALIVE_TICK_MS = 1000;
export const SUSPEND_GAP_MS = 3000;

/**
 * Message history policy (#50). Keeping every decoded message (once capped at 20,000) cost ~4 KB of heap per four-car
 * snapshot: 60-80 MB after ~15 min of racing, held across rematches, for nothing the page ever read. So:
 * - By default (the browser, NetSession) no message is kept. `rx` counts what arrived and `latest` holds the newest message
 *   of each type, so retention is one message per type however long the session runs.
 * - A test or diagnostic opts in with `recordHistory()`. `received` then keeps the newest messages, never more than
 *   HISTORY_MAX (oldest dropped first and counted in `rx.dropped`, so a consumer that needs a complete record can check it
 *   lost nothing). It is never cleared by a reconnect or a rematch; `clearHistory()` empties it.
 * Budget: default mode retains O(1), ~0 MB measured after 20,001 snapshots and rematches. HISTORY_DEFAULT_CAP covers the
 * longest test race over real sockets (~2,250 messages) with margin, about 3.3 min of 20 Hz snapshots and ~17 MB of Node
 * heap at four cars. HISTORY_MAX is the hard ceiling for any opt-in, ~35 MB.
 */
export const HISTORY_OFF = 0;
export const HISTORY_DEFAULT_CAP = 4000;
export const HISTORY_MAX = 8000;

/** The protocol's server message types: per-type counters and `latest` only ever key on these, so they cannot grow. */
const SERVER_TYPES: Record<ServerMsg['t'], true> = { welcome: true, joined: true, room: true, state: true, ack: true, nack: true, result: true, awards: true, pong: true, bye: true };

/** Receive counters: kept in every mode, constant size. */
export interface RxStats { total: number; byType: Partial<Record<ServerMsg['t'], number>>; dropped: number; }

export class OnlineClient {
  ws: SocketLike | null = null;
  room: PublicRoom | null = null;
  me: string | null = null;
  /** private reconnect credential: memory only */
  private token: string | null = null;
  ctlSeq = 0; actSeq = 0;
  held = { up: false, down: false };
  /** Decoded messages, oldest first: empty unless recordHistory() opted in (see the policy above). */
  readonly received: ServerMsg[] = [];
  /** How many messages `received` may hold: HISTORY_OFF until recordHistory(). */
  historyCap = HISTORY_OFF;
  readonly rx: RxStats = { total: 0, byType: {}, dropped: 0 };
  /** The newest message of each type (bounded by the number of message types). */
  readonly latest: Partial<Record<ServerMsg['t'], ServerMsg>> = {};
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private hb: ReturnType<typeof setInterval> | null = null;
  private ka: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  /** when the current socket last delivered a message, when the last ping went out and when the keepalive last ran */
  lastRxAt = 0;
  private lastPingAt = 0;
  private lastTickAt = 0;
  /** the current socket's create/join/resume has been answered: until then `room` is still the last connection's room */
  private answered = false;
  onMessage: ((m: ServerMsg) => void) | null = null;
  /** the open socket closed (after a completed connect) */
  onClose: ((e: { code: number; reason: string }) => void) | null = null;

  constructor(private url: string, private Ctor: SocketCtor, private opts?: unknown, private now = () => Date.now()) {}

  /**
   * Opt in to keeping decoded messages in `received` (tests and diagnostics only; the browser never calls this). The cap is
   * clamped to 0..HISTORY_MAX, and lowering it trims the oldest at once. Returns the client, for `new OnlineClient(...).recordHistory()`.
   */
  recordHistory(cap = HISTORY_DEFAULT_CAP): this {
    this.historyCap = Math.max(HISTORY_OFF, Math.min(HISTORY_MAX, Math.floor(cap)));
    this.trimHistory();
    return this;
  }
  /** Empty the recorded history (counters and `latest` are kept). */
  clearHistory(): void { this.received.length = 0; }
  private trimHistory(): void {
    const over = this.received.length - this.historyCap;
    if (over > 0) { this.received.splice(0, over); this.rx.dropped += over; }
  }

  /** Open the socket and complete the versioned hello. Rejects on a protocol mismatch. */
  async connect(version = PROTOCOL_VERSION): Promise<void> {
    this.closed = null;
    // never leave the previous socket open behind a new one (a failed reconnect attempt): each holds a server connection slot
    this.drop();
    const ws = new this.Ctor(this.url, undefined, this.opts as never);
    this.ws = ws;
    await new Promise<void>((res, rej) => {
      // a socket that neither opens nor fails (a dead network path) is given up, so a reconnect loop can try again
      const timer = setTimeout(() => { rej(new Error('connect timeout')); try { ws.close(); } catch { /* not open */ } }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error('connect failed')); };
      ws.onclose = (e) => { clearTimeout(timer); rej(new Error(`closed ${e.code}`)); };
    });
    // a replaced socket (a reconnect) is ignored from here on: its late close or messages never touch the new connection
    ws.onmessage = (ev) => { if (this.ws === ws) this.receive(String(ev.data)); };
    ws.onclose = (e) => this.lost(ws, e);
    ws.onerror = () => undefined;
    this.send({ t: 'hello', v: version, proto: PROTOCOL_NAME });
    let m: ServerMsg;
    try { m = await this.wait((x) => x.t === 'welcome' || (x.t === 'nack' && x.ref === 'hello')); } catch (e) { this.drop(); throw e; }
    // a refused hello is closed by the server, with a code the caller reads from `closed`
    if (m.t !== 'welcome') throw new Error(`hello refused: ${(m as { code: string }).code}`);
    if (this.ws === ws) { this.answered = false; this.startKeepalive(ws); }
  }

  /** The open socket `ws` is gone (closed, or declared dead by the watchdog): reported once through onClose. */
  private lost(ws: SocketLike, e: { code: number; reason: string }): void {
    // a replaced or already-lost socket's late close never reports a second time, so only one reconnect loop ever runs
    if (this.ws !== ws) return;
    this.ws = null;
    this.closed = { code: e.code, reason: e.reason };
    this.stopHeartbeat();
    this.stopKeepalive();
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error(`closed ${e.code}`)); }
    this.onClose?.(e);
  }

  private startKeepalive(ws: SocketLike): void {
    this.stopKeepalive();
    const t = this.now();
    this.lastRxAt = t; this.lastPingAt = t; this.lastTickAt = t;
    this.ka = setInterval(() => {
      if (this.ws !== ws) return;
      const now = this.now();
      // A tick far later than due means this page was not running (a background tab's throttled timers, a frozen iOS page,
      // a stalled machine), not that the server went quiet: messages sent meanwhile may still be waiting to be delivered.
      // So the silence is not held against the socket. It gets a fresh window and a ping to prove itself; if it really
      // died, the next window runs out and the normal resume follows, once.
      if (now - this.lastTickAt > SUSPEND_GAP_MS) { this.wake(); return; }
      this.lastTickAt = now;
      // A reconnect attempt still holds the old room, seen racing. Snapshots only flow once the server has answered the
      // resume, and a signed-in resume waits on a database check that can take longer than the race window, so until the
      // handshake is answered the idle window applies (pongs still come every PING_MS) or every attempt would be cut off.
      const racing = this.answered && this.room?.state === 'race';
      if (now - this.lastRxAt > (racing ? WATCHDOG_RACE_MS : WATCHDOG_IDLE_MS)) { this.abandon('no traffic'); return; }
      if (now - this.lastPingAt >= PING_MS) this.ping();
    }, KEEPALIVE_TICK_MS);
  }
  private stopKeepalive(): void { if (this.ka) { clearInterval(this.ka); this.ka = null; } }
  private ping(): void { this.lastPingAt = this.now(); this.send({ t: 'ping', id: ++this.pingId }); }

  /**
   * Give up on the open socket as dead and report it through onClose exactly as a close would (the session then resumes
   * once). Used by the watchdog and by a screen that has heard nothing it expected for too long (#43). Closing a half-open
   * socket may take minutes to report; its late close is ignored, since lost() runs once per socket.
   */
  abandon(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(4000, reason); } catch { /* not open */ }
    this.lost(ws, { code: 4000, reason });
  }

  /** This page is running again after being suspended (or shown again): restart the silence window and ping at once. */
  wake(): void {
    if (!this.ka) return;
    const t = this.now();
    this.lastRxAt = t; this.lastTickAt = t;
    this.ping();
  }

  /** Close the current socket, if any, without reporting it through onClose: the caller has already given up on it. */
  drop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.stopHeartbeat();
    this.stopKeepalive();
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error('dropped')); }
    try { ws.close(1000, 'bye'); } catch { /* not open yet */ }
  }

  private receive(s: string): void {
    let m: ServerMsg;
    this.lastRxAt = this.now();
    try { m = JSON.parse(s) as ServerMsg; } catch { return; }
    this.rx.total++;
    if (Object.hasOwn(SERVER_TYPES, m?.t)) { this.rx.byType[m.t] = (this.rx.byType[m.t] ?? 0) + 1; this.latest[m.t] = m; }
    if (this.historyCap > 0) { this.received.push(m); if (this.received.length > this.historyCap) { this.received.shift(); this.rx.dropped++; } }
    if (m.t === 'joined') { this.room = m.room; this.me = m.you; this.token = m.token; this.ctlSeq = Math.max(this.ctlSeq, m.ctlSeq); this.actSeq = Math.max(this.actSeq, m.actSeq); }
    if (m.t === 'room') this.room = m.room;
    if (m.t === 'joined' || (m.t === 'nack' && (m.ref === 'resume' || m.ref === 'join' || m.ref === 'create'))) this.answered = true;
    this.onMessage?.(m);
    for (const w of [...this.waiters]) if (w.pred(m)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
  }

  send(m: ClientMsg | Record<string, unknown>): void { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sendRaw(s: string): void { if (this.ws && this.ws.readyState === 1) this.ws.send(s); }

  wait(pred: (m: ServerMsg) => boolean, ms = 10000): Promise<ServerMsg> {
    return new Promise((res, rej) => {
      const w = { pred, res, rej, timer: setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); rej(new Error('timeout')); }, ms) };
      this.waiters.push(w);
    });
  }

  /** Send a request and wait for its private reply (joined) or its refusal (a nack for that message type). */
  async request(m: ClientMsg): Promise<ServerMsg> {
    const p = this.wait((x) => x.t === 'joined' || (x.t === 'nack' && x.ref === m.t));
    this.send(m);
    return p;
  }

  /** The reconnect credential for this seat, for the caller to keep for the session (e.g. sessionStorage in the browser). */
  credential(): { room: string; participant: string; token: string } | null {
    return this.room && this.me && this.token ? { room: this.room.id, participant: this.me, token: this.token } : null;
  }

  setHeld(up: boolean, down: boolean): void {
    this.held = { up, down };
    this.send({ t: 'ctl', seq: ++this.ctlSeq, up, down });
  }
  action(type: ActionType): number { const seq = ++this.actSeq; this.send({ t: 'act', seq, type }); return seq; }

  startHeartbeat(ms = HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.hb = setInterval(() => this.send({ t: 'ctl', seq: ++this.ctlSeq, up: this.held.up, down: this.held.down }), ms);
  }
  stopHeartbeat(): void { if (this.hb) { clearInterval(this.hb); this.hb = null; } }

  close(): void { this.stopHeartbeat(); this.stopKeepalive(); this.ws?.close(1000, 'bye'); }
}
