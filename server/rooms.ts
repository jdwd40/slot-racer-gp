// All rooms in this process: room codes, the room cap, join-failure limits and the single tick loop that pumps every room.
// One process, one thread: rooms share no mutable state (each race owns its own Track context, RNG and inputs), so no
// worker per room is needed on the 1-vCPU host. Overload policy: docs/online-server.md.
import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, LIMITS, type ChampionshipTag, type LiveryId, type Mode, type RoomSettings } from '../src/net/protocol';
import type { Config } from './config';
import type { Logger } from './log';
import type { ResultSink } from './results';
import { Room, type Fail, type JoinOk, type Peer } from './room';

export interface ManagerDeps { cfg: Config; log: Logger; sink: ResultSink; now?: () => number; seed?: () => number; }

/** Join/resume failures allowed per client address per minute (room codes are short; guessing must stay expensive). */
const JOIN_FAILS_PER_MIN = 20;
const TICK_MS = 10;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private codes = new Map<string, Room>();
  private fails = new Map<string, { n: number; until: number }>();
  private timer: NodeJS.Timeout | null = null;
  /** worst tick duration over the last health window (ms): how busy the loop is */
  tickMaxMs = 0;
  readonly now: () => number;

  constructor(private deps: ManagerDeps) { this.now = deps.now ?? (() => Date.now()); }

  get size(): number { return this.rooms.size; }
  get list(): Room[] { return [...this.rooms.values()]; }
  room(id: string): Room | undefined { return this.rooms.get(id); }
  byCode(code: string): Room | undefined { return this.codes.get(code.toUpperCase()); }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < LIMITS.codeLength; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.codes.has(c)) return c;
    }
  }

  /** Throttle guessing: true when this address has failed too many joins/resumes this minute. */
  limited(ip: string): boolean {
    const f = this.fails.get(ip);
    return !!f && f.until > this.now() && f.n >= JOIN_FAILS_PER_MIN;
  }
  noteFailure(ip: string): void {
    const now = this.now();
    if (this.fails.size > 10000) for (const [k, v] of this.fails) if (v.until <= now) this.fails.delete(k);
    const f = this.fails.get(ip);
    if (!f || f.until <= now) this.fails.set(ip, { n: 1, until: now + 60000 });
    else f.n++;
  }

  create(peer: Peer, o: { name: string; livery?: LiveryId; accountId: string | null; mode: Mode; settings: Partial<RoomSettings>; championship?: ChampionshipTag }): (JoinOk & { room: Room }) | Fail {
    if (this.rooms.size >= this.deps.cfg.roomCap) return { ok: false, code: 'unavailable', detail: 'room limit reached, try again later' };
    if (this.tickMaxMs > 50) return { ok: false, code: 'overloaded', detail: 'server busy, try again later' };
    let room: Room;
    try {
      room = new Room(this.newCode(), o.mode, o.settings, o.championship ?? null, { cfg: this.deps.cfg, log: this.deps.log, sink: this.deps.sink, seed: this.deps.seed, onClose: (r) => this.forget(r) }, this.now());
    } catch (e) {
      return { ok: false, code: 'bad_settings', detail: (e as Error).message };
    }
    this.rooms.set(room.id, room); this.codes.set(room.code, room);
    this.deps.log.info('room.create', { room: room.id, mode: o.mode, rooms: this.rooms.size });
    const r = room.join(peer, o, this.now(), true);
    if (!r.ok) { room.close('empty'); return r; }
    return { ...r, room };
  }

  join(peer: Peer, ip: string, o: { code: string; name: string; livery?: LiveryId; accountId: string | null }): (JoinOk & { room: Room }) | Fail {
    if (this.limited(ip)) return { ok: false, code: 'rate' };
    const room = this.byCode(o.code);
    if (!room) { this.noteFailure(ip); return { ok: false, code: 'not_found' }; }
    const r = room.join(peer, o, this.now());
    if (!r.ok && r.code === 'not_found') this.noteFailure(ip);
    return r.ok ? { ...r, room } : r;
  }

  resume(peer: Peer, ip: string, roomId: string, participant: string, token: string, accountId: string | null): (JoinOk & { room: Room }) | Fail {
    if (this.limited(ip)) return { ok: false, code: 'rate' };
    const room = this.rooms.get(roomId);
    if (!room) { this.noteFailure(ip); return { ok: false, code: 'expired' }; }
    const r = room.resume(peer, participant, token, accountId, this.now());
    if (!r.ok) this.noteFailure(ip);
    return r.ok ? { ...r, room } : r;
  }

  private forget(r: Room): void {
    this.rooms.delete(r.id);
    if (this.codes.get(r.code) === r) this.codes.delete(r.code);
    this.deps.log.info('room.forget', { room: r.id, rooms: this.rooms.size });
  }

  /** Pump every room once. */
  tick(): void {
    const t0 = performance.now();
    const now = this.now();
    for (const r of [...this.rooms.values()]) {
      try { r.pump(now); } catch (e) {
        // a fault in one room never stops the others: that room's race is aborted without a result and the room closed
        this.deps.log.error('room.fault', { room: r.id, error: String((e as Error)?.stack ?? e) });
        try { r.abortAndClose('fault', now); } catch { this.forget(r); }
      }
    }
    const dt = performance.now() - t0;
    this.tickMaxMs = Math.max(this.tickMaxMs * 0.98, dt);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Abort every race (no results are invented) and close every room: SIGTERM, or a test teardown. */
  shutdown(reason = 'shutdown'): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const now = this.now();
    for (const r of [...this.rooms.values()]) r.abortAndClose(reason, now);
  }

  stats(): { rooms: number; racing: number; humans: number; connected: number } {
    let racing = 0, humans = 0, connected = 0;
    for (const r of this.rooms.values()) { if (r.state === 'race') racing++; humans += r.humans; connected += r.connected; }
    return { rooms: this.rooms.size, racing, humans, connected };
  }
}
