// All rooms in this process: room codes, the room cap, join-failure limits and the single tick loop that pumps every room.
// One process, one thread: rooms share no mutable state (each race owns its own Track context, RNG and inputs), so no
// worker per room is needed on the 1-vCPU host. Overload policy: docs/online-server.md.
import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, LIMITS, type ChampionshipTag, type LiveryId, type Mode, type RoomSettings } from '../src/net/protocol';
import type { Config } from './config';
import type { Logger } from './log';
import type { Scoring } from './career';
import type { ResultSink } from './results';
import { CreateQuota } from './quota';
import { Room, type Fail, type JoinOk, type Peer } from './room';

export interface ManagerDeps { cfg: Config; log: Logger; sink: ResultSink; scoring?: Scoring; now?: () => number; seed?: () => number; }

/** Join/resume failures allowed per client address per minute (room codes are short; guessing must stay expensive). */
const JOIN_FAILS_PER_MIN = 20;
const TICK_MS = 10;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private codes = new Map<string, Room>();
  private fails = new Map<string, { n: number; until: number }>();
  private timer: NodeJS.Timeout | null = null;
  /** start() was called and shutdown() not since: the tick timer runs while this is set and at least one room exists */
  private enabled = false;
  /** worst tick duration over the last health window (ms): how busy the loop is */
  tickMaxMs = 0;
  readonly now: () => number;
  /** per-address and per-account room creation allowance (server/quota.ts) */
  readonly quota: CreateQuota;

  constructor(private deps: ManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
    const c = deps.cfg;
    this.quota = new CreateQuota({ perIp: c.roomsPerIp, perAccount: c.roomsPerAccount, creates: c.roomCreates, windowMs: c.roomCreateWindowS * 1000 }, this.now);
  }

  get size(): number { return this.rooms.size; }
  /** the tick timer is active (only while started and at least one room exists: no idle wakeups) */
  get running(): boolean { return this.timer !== null; }
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

  /**
   * Create a room and seat its creator. `ip` is the creator's client address as the WebSocket layer established it; with it
   * the room counts against that address's (and the account's) creation allowance until it closes. In-process tests that
   * leave it out are not limited.
   */
  create(peer: Peer, o: { name: string; livery?: LiveryId; accountId: string | null; mode: Mode; settings: Partial<RoomSettings>; championship?: ChampionshipTag; ip?: string }): (JoinOk & { room: Room }) | Fail {
    if (this.rooms.size >= this.deps.cfg.roomCap) return { ok: false, code: 'unavailable', detail: 'room limit reached, try again later' };
    if (this.tickMaxMs > 50) return { ok: false, code: 'overloaded', detail: 'server busy, try again later' };
    const keys = o.ip === undefined ? null : CreateQuota.keys(o.ip, o.accountId);
    const refused = keys && this.quota.check(keys);
    if (refused) { this.deps.log.info('room.create_refused', { code: refused.code, guest: !o.accountId }); return refused; }
    let room: Room;
    try {
      room = new Room(this.newCode(), o.mode, o.settings, o.championship ?? null, { cfg: this.deps.cfg, log: this.deps.log, sink: this.deps.sink, scoring: this.deps.scoring, seed: this.deps.seed, onClose: (r) => this.forget(r) }, this.now());
    } catch (e) {
      return { ok: false, code: 'bad_settings', detail: (e as Error).message };
    }
    this.rooms.set(room.id, room); this.codes.set(room.code, room);
    this.syncTimer();
    this.deps.log.info('room.create', { room: room.id, mode: o.mode, rooms: this.rooms.size });
    const r = room.join(peer, o, this.now(), true);
    if (!r.ok) { room.close('empty'); return r; }
    // charged only once the room exists with its creator in it: a create that fails anywhere above costs no allowance. The
    // join is synchronous, so the room cannot have closed in between; its close (any reason) releases the charge in forget
    if (keys) this.quota.charge(room.id, keys);
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

  /** A queued result moved on (server/spool.ts): stored later, refused, or written to the spool; its room says so. */
  settled(raceId: string, sync: 'saved' | 'failed' | 'pending'): void {
    for (const r of this.rooms.values()) if (r.awards?.raceId === raceId) r.settled(raceId, sync);
  }

  private forget(r: Room): void {
    this.quota.release(r.id);
    this.rooms.delete(r.id);
    if (this.codes.get(r.code) === r) this.codes.delete(r.code);
    this.deps.log.info('room.forget', { room: r.id, rooms: this.rooms.size });
    this.syncTimer();
  }

  /**
   * Run the tick timer only while it has rooms to pump. Restarting it needs no clock reset: rooms and races are timed from
   * their own wall timestamps (createdAt, baseWall), never from the interval between ticks, so an idle period is never
   * caught up. Stopping it resets tickMaxMs, which can no longer decay without ticks, so it never blocks the next room.
   */
  private syncTimer(): void {
    if (this.enabled && this.rooms.size > 0) {
      if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    } else if (this.timer) {
      clearInterval(this.timer); this.timer = null;
      this.tickMaxMs = 0;
    }
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
    this.tickMaxMs = this.rooms.size ? Math.max(this.tickMaxMs * 0.98, dt) : 0;
  }

  /** Enable the tick loop; the timer itself starts with the first room and stops with the last. */
  start(): void {
    this.enabled = true;
    this.syncTimer();
  }

  /** Abort every race (no results are invented) and close every room: SIGTERM, or a test teardown. */
  shutdown(reason = 'shutdown'): void {
    this.enabled = false;
    this.syncTimer();
    const now = this.now();
    for (const r of [...this.rooms.values()]) r.abortAndClose(reason, now);
  }

  stats(): { rooms: number; racing: number; humans: number; connected: number } {
    let racing = 0, humans = 0, connected = 0;
    for (const r of this.rooms.values()) { if (r.state === 'race') racing++; humans += r.humans; connected += r.connected; }
    return { rooms: this.rooms.size, racing, humans, connected };
  }
}
