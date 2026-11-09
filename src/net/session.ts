// One browser's online seat: the connection, the room it is in, reconnection within the server's grace period and the
// result of each race. No race logic and no DOM: main.ts renders what this reports, and tests drive it with the `ws` package.
// The private reconnect token is kept in memory and in sessionStorage (this tab only), never in a URL, log or the page.
import { OnlineClient, type SocketCtor } from './client';
import type { AwardsView, ChampionshipTag, ClientMsg, ErrorCode, LiveryId, Mode, PublicRoom, RoomSettings, ServerMsg } from './protocol';
import type { ActionType, DriverId, Standing } from '../race';

export type Conn = 'offline' | 'connecting' | 'connected' | 'reconnecting';
/** Why a session ended for good. `expired`: the seat can no longer be resumed (it is never re-claimed as a new driver). */
export type EndReason = 'left' | 'expired' | 'closed' | 'shutdown' | 'superseded' | 'lost';

export interface Seat { room: string; participant: string; token: string; code: string; }

/** The parts of the server's result envelope (server/envelope.ts) the client shows. */
export interface ResultView {
  raceId: string; roomId: string; mode: Mode; championship?: ChampionshipTag | null; outcome: 'completed' | 'aborted' | 'ended'; abortReason: string | null;
  track: { id: string }; participants: { id: string; control: 'human' | 'ai'; slot: number; num: number; name: string; livery: string }[];
  classification: Standing[] | null; digest: string;
}

export interface NetHooks {
  room?(room: PublicRoom): void;
  /** an authoritative state message, with the local time it arrived */
  state?(m: Extract<ServerMsg, { t: 'state' }>, at: number): void;
  /** `fresh` is false for a result this tab has already seen (a resend after a reconnect, or a duplicate message) */
  result?(r: ResultView, fresh: boolean): void;
  /** the server's career awards for the last result and whether they are stored yet (saving, saved, pending, unsaved, failed) */
  awards?(a: AwardsView): void;
  conn?(c: Conn): void;
  end?(why: EndReason, detail?: string): void;
  nack?(m: Extract<ServerMsg, { t: 'nack' }>): void;
}

export type Outcome = { ok: true } | { ok: false; code: ErrorCode | 'unreachable'; detail?: string };

const SEAT_KEY = 'srgp.seat';
const SEEN_KEY = 'srgp.netResults';
const SEEN_MAX = 32;

/** Minimal storage (sessionStorage in the browser, a Map in tests). Failures are ignored: the seat then lasts this page only. */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; }

export function loadSeat(kv: KV | null): Seat | null {
  try {
    const s = JSON.parse(kv?.getItem(SEAT_KEY) ?? 'null') as Seat | null;
    return s && typeof s.room === 'string' && typeof s.participant === 'string' && typeof s.token === 'string' && typeof s.code === 'string' ? s : null;
  } catch { return null; }
}

export class NetSession {
  conn: Conn = 'offline';
  room: PublicRoom | null = null;
  me: DriverId | null = null;
  result: ResultView | null = null;
  awards: AwardsView | null = null;
  ended: EndReason | null = null;
  readonly client: OnlineClient;
  private seat: Seat | null = null;
  private closing = false;
  private held = { up: false, down: false };
  private seen: string[];
  /** reconnection attempts made (diagnostics) */
  reconnects = 0;

  constructor(url: string, Ctor: SocketCtor, private hooks: NetHooks = {}, private kv: KV | null = null, opts?: unknown, private now = () => Date.now()) {
    this.client = new OnlineClient(url, Ctor, opts);
    this.client.onMessage = (m) => this.receive(m);
    this.client.onClose = () => this.dropped();
    try { this.seen = (JSON.parse(kv?.getItem(SEEN_KEY) ?? '[]') as string[]).filter((x) => typeof x === 'string').slice(-SEEN_MAX); } catch { this.seen = []; }
  }

  get inRace(): boolean { return this.room?.state === 'race'; }
  get host(): boolean { return !!this.room && this.room.hostId === this.me; }

  private setConn(c: Conn): void { if (this.conn !== c) { this.conn = c; this.hooks.conn?.(c); } }

  /** Create a room (any mode), join one by code, or resume a stored seat. */
  /** `expectAccount`: who the page shows ('' = guest, an account id when signed in); a socket signed in otherwise is refused. */
  create(name: string, mode: Mode, settings: Partial<RoomSettings>, livery?: LiveryId, expectAccount?: string, championship?: ChampionshipTag): Promise<Outcome> {
    return this.begin({ t: 'create', name, mode, settings, ...(livery ? { livery } : {}), ...(expectAccount !== undefined ? { expectAccount } : {}), ...(championship ? { championship } : {}) });
  }
  join(code: string, name: string, livery?: LiveryId, expectAccount?: string): Promise<Outcome> {
    return this.begin({ t: 'join', code: code.trim().toUpperCase(), name, ...(livery ? { livery } : {}), ...(expectAccount !== undefined ? { expectAccount } : {}) });
  }
  resume(seat: Seat): Promise<Outcome> { this.seat = seat; return this.begin({ t: 'resume', room: seat.room, participant: seat.participant, token: seat.token }); }

  private async begin(req: ClientMsg): Promise<Outcome> {
    this.closing = false; this.ended = null;
    this.setConn('connecting');
    try { await this.client.connect(); } catch (e) {
      this.setConn('offline');
      const msg = String((e as Error).message);
      return msg.includes('protocol') ? { ok: false, code: 'protocol' } : { ok: false, code: 'unreachable' };
    }
    let r: ServerMsg;
    try { r = await this.client.request(req); } catch { this.client.drop(); this.setConn('offline'); return { ok: false, code: 'unreachable' }; }
    if (r.t !== 'joined') {
      const n = r as Extract<ServerMsg, { t: 'nack' }>;
      this.closing = true; this.client.close(); this.setConn('offline');
      if (req.t === 'resume' && (n.code === 'expired' || n.code === 'forbidden' || n.code === 'not_found')) this.forgetSeat();
      return { ok: false, code: n.code, detail: n.detail };
    }
    this.adopt(r);
    return { ok: true };
  }

  private adopt(r: Extract<ServerMsg, { t: 'joined' }>): void {
    this.room = r.room; this.me = r.you;
    const cred = this.client.credential();
    if (cred) { this.seat = { ...cred, code: r.room.code }; try { this.kv?.setItem(SEAT_KEY, JSON.stringify(this.seat)); } catch { /* storage unavailable */ } }
    this.setConn('connected');
    this.syncHeartbeat();
    this.hooks.room?.(r.room);
  }

  private receive(m: ServerMsg): void {
    switch (m.t) {
      case 'room': this.room = m.room; this.syncHeartbeat(); this.hooks.room?.(m.room); break;
      case 'state': this.hooks.state?.(m, this.now()); break;
      case 'result': {
        const r = m.envelope as ResultView;
        const fresh = !this.seen.includes(r.raceId);
        if (fresh) { this.seen.push(r.raceId); this.seen = this.seen.slice(-SEEN_MAX); try { this.kv?.setItem(SEEN_KEY, JSON.stringify(this.seen)); } catch { /* ignore */ } }
        this.result = r;
        this.hooks.result?.(r, fresh);
        break;
      }
      case 'awards':
        // the latest word wins; an earlier race's awards never replace the current result's
        if (this.result && m.awards.raceId !== this.result.raceId) break;
        this.awards = m.awards;
        this.hooks.awards?.(m.awards);
        break;
      case 'nack': this.hooks.nack?.(m); break;
      case 'bye': {
        const why: EndReason | null = m.code === 'left' ? 'left' : m.code === 'closed' ? 'closed' : m.code === 'shutdown' ? 'shutdown' : m.code === 'superseded' ? 'superseded' : null;
        if (why) this.finish(why, m.detail);
        break;
      }
      default: break;
    }
  }

  private syncHeartbeat(): void {
    if (this.inRace && this.conn === 'connected') this.client.startHeartbeat(); else this.client.stopHeartbeat();
  }

  /** The socket closed without a goodbye: hold the seat and try to resume it within the server's grace period. */
  private dropped(): void {
    this.client.stopHeartbeat();
    if (this.conn === 'reconnecting') return;   // the reconnect loop owns this
    if (this.closing || this.ended || !this.seat) { this.setConn('offline'); return; }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const seat = this.seat!;
    this.setConn('reconnecting');
    const graceMs = (this.room?.graceS ?? 20) * 1000;
    const deadline = this.now() + graceMs + 3000;
    let wait = 500;
    while (!this.closing && !this.ended) {
      this.reconnects++;
      try {
        await this.client.connect();
        const r = await this.client.request({ t: 'resume', room: seat.room, participant: seat.participant, token: seat.token });
        // given up (left, closed) while this attempt was in flight: the seat is not taken back
        if (this.closing || this.ended) break;
        if (r.t === 'joined') { this.held = { up: false, down: false }; this.adopt(r); return; }
        const n = r as Extract<ServerMsg, { t: 'nack' }>;
        if (n.code === 'expired' || n.code === 'forbidden' || n.code === 'not_found') { this.client.drop(); this.finish('expired', n.detail); return; }
      } catch { /* not reachable yet */ }
      // a refused or failed attempt gives its socket up before the next one, or each retry would hold another server connection
      this.client.drop();
      if (this.now() > deadline) { this.finish('expired', 'reconnect window passed'); return; }
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(2000, wait * 1.5);
    }
    this.client.drop();
  }

  private finish(why: EndReason, detail?: string): void {
    if (this.ended) return;
    this.ended = why;
    this.closing = true;
    this.client.stopHeartbeat();
    this.forgetSeat();
    this.setConn('offline');
    this.hooks.end?.(why, detail);
  }

  private forgetSeat(): void { this.seat = null; try { this.kv?.removeItem(SEAT_KEY); } catch { /* ignore */ } }

  // ------------------------------------------------------------------------------------------------ commands
  /** This browser's held pedals for its own seat. Sent at once on any change; the heartbeat repeats them while racing. */
  setHeld(up: boolean, down: boolean): void {
    if (up === this.held.up && down === this.held.down) return;
    this.held = { up, down };
    if (this.conn === 'connected' && this.inRace) this.client.setHeld(up, down);
    else this.client.held = { up: false, down: false };
  }
  /** Let go of everything now (menu, lost focus, backgrounded) and tell the server, even if nothing seemed held. */
  release(): void {
    this.held = { up: false, down: false };
    if (this.conn === 'connected' && this.inRace) this.client.setHeld(false, false);
  }
  action(type: ActionType): void { if (this.conn === 'connected' && this.inRace) this.client.action(type); }
  ready(on: boolean): void { this.client.send({ t: 'ready', ready: on }); }
  settings(s: Partial<RoomSettings>): void { this.client.send({ t: 'settings', settings: s }); }
  livery(l: LiveryId): void { this.client.send({ t: 'livery', livery: l }); }
  start(): void { this.client.send({ t: 'start' }); }
  rematch(): void { this.client.send({ t: 'rematch' }); }
  /** Give the seat up on purpose (the car retires if racing); no reconnection follows. */
  leave(): void {
    if (this.conn === 'connected') this.client.send({ t: 'leave' });
    this.finish('left');
    setTimeout(() => this.client.close(), 200);
  }
  /** Stop without leaving (page teardown): the seat waits out its grace on the server. */
  close(): void { this.closing = true; this.client.close(); this.setConn('offline'); }
}

/** Plain-language reason for a refused request; the caller shows it with a way back. */
export function refusalText(code: string): string {
  return `net.err.${['not_found', 'full', 'started', 'expired', 'protocol', 'unavailable', 'overloaded', 'rate', 'unreachable', 'already_joined', 'malformed', 'forbidden'].includes(code) ? code : 'other'}`;
}
