// A protocol client for the room server: the browser uses the global WebSocket, headless clients (tests, the smoke check)
// pass the `ws` package's class. It keeps the private reconnect token in memory only (never in a URL or log), numbers held
// controls and actions, and resends held controls as a heartbeat so the server's input timeout never fires while a pedal
// is really held.
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

export class OnlineClient {
  ws: SocketLike | null = null;
  room: PublicRoom | null = null;
  me: string | null = null;
  /** private reconnect credential: memory only */
  private token: string | null = null;
  ctlSeq = 0; actSeq = 0;
  held = { up: false, down: false };
  readonly received: ServerMsg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private hb: ReturnType<typeof setInterval> | null = null;
  onMessage: ((m: ServerMsg) => void) | null = null;

  constructor(private url: string, private Ctor: SocketCtor, private opts?: unknown) {}

  /** Open the socket and complete the versioned hello. Rejects on a protocol mismatch. */
  async connect(version = PROTOCOL_VERSION): Promise<void> {
    this.closed = null;
    const ws = new this.Ctor(this.url, undefined, this.opts as never);
    this.ws = ws;
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('connect failed'));
      ws.onclose = (e) => rej(new Error(`closed ${e.code}`));
    });
    ws.onmessage = (ev) => this.receive(String(ev.data));
    ws.onclose = (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.stopHeartbeat();
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.rej(new Error(`closed ${e.code}`)); }
    };
    ws.onerror = () => undefined;
    this.send({ t: 'hello', v: version, proto: PROTOCOL_NAME });
    const m = await this.wait((x) => x.t === 'welcome' || (x.t === 'nack' && x.ref === 'hello'));
    if (m.t !== 'welcome') throw new Error(`hello refused: ${(m as { code: string }).code}`);
  }

  private receive(s: string): void {
    let m: ServerMsg;
    try { m = JSON.parse(s) as ServerMsg; } catch { return; }
    this.received.push(m);
    if (this.received.length > 20000) this.received.splice(0, 5000);
    if (m.t === 'joined') { this.room = m.room; this.me = m.you; this.token = m.token; this.ctlSeq = Math.max(this.ctlSeq, m.ctlSeq); this.actSeq = Math.max(this.actSeq, m.actSeq); }
    if (m.t === 'room') this.room = m.room;
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

  close(): void { this.stopHeartbeat(); this.ws?.close(1000, 'bye'); }
}
