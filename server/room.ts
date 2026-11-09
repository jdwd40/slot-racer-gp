// One private room: its lobby, its roster and the single authoritative race it owns. The room is pure logic driven by
// `pump(now)`: no sockets, timers or clocks of its own, so tests run whole races in milliseconds with a manual clock.
// Rules and their reasons: docs/online-server.md.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { DRIVERS, Race, type DriverId, type Input, type RosterEntry, type WireEvent } from '../src/race';
import { isTrackId, trackById, TRACK_IDS } from '../src/track';
import { STEP } from '../src/timing';
import {
  LIMITS, LIVERIES, cleanName, isLivery, neutral,
  type ChampionshipTag, type ClientMsg, type ErrorCode, type LiveryId, type Mode, type PublicAi, type PublicParticipant,
  type AwardsView, type AwardSync, type PublicRoom, type RoomSettings, type RoomState, type ServerMsg,
} from '../src/net/protocol';
import { CHAMP_TRACKS } from '../src/records';
import { computeAwards, makeScoring, type Scoring } from './career';
import type { Config } from './config';
import type { Logger } from './log';
import { buildEnvelope, type EnvelopeLap, type EnvelopeParticipant, type ResultEnvelope } from './envelope';
import { ResultConflict, type ResultSink } from './results';

/** A connected client as the room sees it. The WebSocket layer implements it; tests use an in-memory double. */
export interface Peer {
  send(data: string): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface RoomDeps {
  cfg: Config;
  log: Logger;
  sink: ResultSink;
  /** career points policy (server/career.ts); the default is 10/6/4 */
  scoring?: Scoring;
  /** a seed for each new race (tests fix it; the default is cryptographically random) */
  seed?: () => number;
  onClose?: (room: Room) => void;
}

interface Participant {
  id: string; name: string; accountId: string | null;
  slot: number; livery: LiveryId; liveryRequested: LiveryId | null;
  ready: boolean; joinOrder: number;
  /** SHA-256 of the private reconnect token; null once the seat may no longer be resumed */
  tokenHash: Buffer | null;
  peer: Peer | null;
  /** wall time the connection was lost (null while connected) */
  lostAt: number | null;
  held: Input; ctlSeq: number; ctlAt: number; actSeq: number;
  /** left or retired: the seat is no longer this person's to drive and is never reassigned during the race */
  left: boolean;
  /** drives a car in the current race (roster locked at the start) */
  inRace: boolean;
}

export interface ModeRules { maxHumans: number; minHumans: number; joinable: boolean; aiFill: 'setting' | 'always' | 'never'; practice: boolean; }
export const MODE_RULES: Record<Mode, ModeRules> = {
  multiplayer: { maxHumans: LIMITS.maxHumans, minHumans: 2, joinable: true, aiFill: 'setting', practice: false },
  solo: { maxHumans: 1, minHumans: 1, joinable: false, aiFill: 'always', practice: false },
  championship: { maxHumans: 1, minHumans: 1, joinable: false, aiFill: 'always', practice: false },
  practice: { maxHumans: 1, minHumans: 1, joinable: false, aiFill: 'never', practice: true },
};

/** AI fill names, by slot: never 'YOU' (DRIVERS[0].name), and always marked as AI. */
const AI_NAMES = ['Gold Flash', 'Red Comet', 'Blue Arrow', 'Green Viper'];
/** Run-on speed once every human is terminal: nobody is waiting on wall time, so the AI field is finished faster. */
const RUNON_STEPS = 8;
/** Seconds after the first finisher that a solo race (one human) waits before classifying the rest. */
const SOLO_FINISH_WINDOW = 120;
const RACE_TIME_LIMIT = 1200;

export type JoinOk = { ok: true; participant: string; token: string };
export type Fail = { ok: false; code: ErrorCode; detail?: string };

const hashToken = (t: string): Buffer => createHash('sha256').update(t, 'utf8').digest();

export class Room {
  readonly id = randomUUID();
  readonly createdAt: number;
  readonly mode: Mode;
  readonly rules: ModeRules;
  readonly championship: ChampionshipTag | null;
  settings: RoomSettings;
  state: RoomState = 'lobby';
  rev = 0;
  hostId: string | null = null;
  private parts: Participant[] = [];
  private joins = 0;
  private lastActivity: number;
  /** the latest wall time the room was given (by pump, handle, join...), for work done outside those calls */
  private clock: number;
  private resultsAt = 0;
  // ---- the current race (state 'race'); everything here is reset on start
  race: Race | null = null;
  raceId: string | null = null;
  private roster: (RosterEntry & { slot: number; livery: LiveryId; accountId: string | null })[] = [];
  private baseWall = 0;
  private stepsDone = 0;
  private lagSteps = 0;
  private startedAt = 0;
  private greenAt: number | null = null;
  private laps: EnvelopeLap[] = [];
  private evBuf: WireEvent[] = [];
  private snapEvery: number;
  /** the finalized envelope of the last race (state 'results'); built once per race */
  result: Readonly<ResultEnvelope> | null = null;
  /** the last race's career awards and where their storage stands (sent to every member, replayed on resume) */
  awards: AwardsView | null = null;
  /** every envelope this room produced, in order (one per race) */
  readonly results: Readonly<ResultEnvelope>[] = [];

  constructor(readonly code: string, mode: Mode, settings: Partial<RoomSettings>, championship: ChampionshipTag | null, private deps: RoomDeps, now: number) {
    this.mode = mode;
    this.rules = MODE_RULES[mode];
    this.championship = mode === 'championship' ? championship : null;
    this.createdAt = now; this.lastActivity = now; this.clock = now;
    this.settings = { track: TRACK_IDS[0], aiFill: this.rules.aiFill === 'always' };
    const bad = this.applySettings(settings);
    if (bad) throw new Error(bad);
    this.snapEvery = Math.max(1, Math.round(1 / STEP / deps.cfg.snapshotHz));
  }

  private get log(): Logger { return this.deps.log; }
  private get cfg(): Config { return this.deps.cfg; }

  /** Validate and apply settings; returns an error detail or null. */
  private applySettings(s: Partial<RoomSettings>): string | null {
    if (s.track !== undefined && !isTrackId(s.track)) return 'unknown track';
    if (s.aiFill !== undefined && this.rules.aiFill !== 'setting' && s.aiFill !== (this.rules.aiFill === 'always')) return `aiFill is fixed for ${this.mode}`;
    if (this.mode === 'championship') {
      // a connected championship round runs on that round's circuit (the local championship calendar)
      const c = this.championship;
      if (!c || c.round > CHAMP_TRACKS.length) return `championship round 1-${CHAMP_TRACKS.length} required`;
      const want = CHAMP_TRACKS[c.round - 1];
      if (s.track !== undefined && s.track !== want) return `round ${c.round} runs on ${want}`;
      this.settings = { track: want, aiFill: true };
      return null;
    }
    this.settings = { track: s.track ?? this.settings.track, aiFill: s.aiFill ?? this.settings.aiFill };
    return null;
  }

  // ------------------------------------------------------------------------------------------------ seats
  private active(): Participant[] { return this.parts.filter((p) => !p.left); }
  participant(id: string): Participant | undefined { return this.parts.find((p) => p.id === id); }
  get humans(): number { return this.active().length; }
  get connected(): number { return this.parts.filter((p) => p.peer).length; }

  /** The lowest free livery, starting from `want`, else from the slot's own colour; never one another car has. */
  private pickLivery(want: LiveryId | undefined, slot: number, taken: Set<LiveryId>): LiveryId {
    if (want && !taken.has(want)) return want;
    const start = LIVERIES.findIndex((l) => l.color === DRIVERS[slot].color);
    for (let k = 0; k < LIVERIES.length; k++) { const l = LIVERIES[(Math.max(0, start) + k) % LIVERIES.length].id; if (!taken.has(l)) return l; }
    return LIVERIES[0].id;
  }
  private takenLiveries(except?: Participant): Set<LiveryId> { return new Set(this.parts.filter((p) => p !== except && !p.left).map((p) => p.livery)); }

  join(peer: Peer, o: { name: string; livery?: LiveryId; accountId: string | null }, now: number, creator = false): JoinOk | Fail {
    if (this.state === 'closed') return { ok: false, code: 'not_found' };
    if (!creator && !this.rules.joinable) return { ok: false, code: 'not_found' };
    if (this.state !== 'lobby') return { ok: false, code: 'started', detail: 'the starting roster is locked' };
    if (o.accountId && this.parts.some((p) => p.accountId === o.accountId && !p.left)) return { ok: false, code: 'already_joined', detail: 'resume your existing seat' };
    const used = new Set(this.parts.map((p) => p.slot));
    if (this.humans >= this.rules.maxHumans || used.size >= DRIVERS.length) return { ok: false, code: 'full' };
    const name = cleanName(o.name);
    if (!name) return { ok: false, code: 'malformed', detail: 'name' };
    let slot = 0; while (used.has(slot)) slot++;
    const livery = this.pickLivery(o.livery, slot, this.takenLiveries());
    const token = randomBytes(32).toString('base64url');
    const p: Participant = {
      id: `p_${randomBytes(9).toString('base64url')}`, name, accountId: o.accountId, slot, livery,
      liveryRequested: o.livery && o.livery !== livery ? o.livery : null,
      ready: false, joinOrder: this.joins++, tokenHash: hashToken(token), peer, lostAt: null,
      held: neutral(), ctlSeq: 0, ctlAt: now, actSeq: 0, left: false, inRace: false,
    };
    this.parts.push(p);
    this.ensureHost();
    this.touch(now);
    this.log.info('room.join', { room: this.id, participant: p.id, slot, guest: !p.accountId, creator });
    this.broadcastRoom(peer);   // the joiner gets the room in its private `joined` reply instead
    return { ok: true, participant: p.id, token };
  }

  /** Reconnect to the same seat. The token is the credential, never the name; a signed-in seat also needs the same account. */
  resume(peer: Peer, participantId: string, token: string, accountId: string | null, now: number): JoinOk | Fail {
    const p = this.participant(participantId);
    if (!p || !p.tokenHash || p.left || this.state === 'closed') return { ok: false, code: 'expired' };
    const h = hashToken(token);
    if (h.length !== p.tokenHash.length || !timingSafeEqual(h, p.tokenHash)) return { ok: false, code: 'forbidden' };
    if (p.accountId && p.accountId !== accountId) return { ok: false, code: 'forbidden' };
    if (p.peer && p.peer !== peer) { this.sendTo(p.peer, { t: 'bye', code: 'superseded' }); p.peer.close(4001, 'superseded'); }
    p.peer = peer; p.lostAt = null; p.held = neutral(); p.ctlAt = now;
    this.ensureHost();
    this.touch(now);
    this.log.info('room.resume', { room: this.id, participant: p.id });
    this.broadcastRoom(peer);
    return { ok: true, participant: p.id, token };
  }

  /** The connection behind a seat closed. Held controls are neutral from this moment; the seat waits out the grace period. */
  disconnect(participantId: string, peer: Peer, now: number): void {
    const p = this.participant(participantId);
    if (!p || p.peer !== peer) return;
    p.peer = null; p.lostAt = now; p.held = neutral();
    this.log.info('room.disconnect', { room: this.id, participant: p.id, state: this.state });
    this.ensureHost();
    this.broadcastRoom();
  }

  /** Leave on purpose: the seat (and its reconnect token) is given up at once. In a race the car retires. */
  leave(participantId: string, now: number): void {
    const p = this.participant(participantId);
    if (!p || p.left) return;
    const peer = p.peer;
    p.peer = null; p.tokenHash = null; p.held = neutral();
    if (peer) { this.sendTo(peer, { t: 'bye', code: 'left' }); peer.close(1000, 'left'); }
    this.log.info('room.leave', { room: this.id, participant: p.id, state: this.state });
    this.dropSeat(p, now);
  }

  /** A seat whose holder is gone for good: retire its car mid-race, or free it before/after a race. */
  private dropSeat(p: Participant, now: number): void {
    p.left = true; p.tokenHash = null; p.lostAt = null;
    if (this.state === 'race' && p.inRace && this.race) {
      if (this.rules.practice) { this.finalize('ended', null, now); }
      else this.race.retire(p.id);
    } else {
      this.parts = this.parts.filter((x) => x !== p);
    }
    this.ensureHost();
    if (!this.active().length && this.state !== 'race') { this.close('empty'); return; }
    this.touch(now);
    this.broadcastRoom();
  }

  /**
   * Room control, deterministically: the current host keeps it while present (and, outside a race, connected); otherwise it
   * passes to the earliest-joined connected participant, else the earliest-joined one still holding a seat. During a race
   * the host has no power the race depends on, so a host disconnect there changes nothing until the race ends.
   */
  private ensureHost(): void {
    const act = this.active();
    const cur = act.find((p) => p.id === this.hostId);
    if (cur && (cur.peer || this.state === 'race')) return;
    const next = [...act].sort((a, b) => a.joinOrder - b.joinOrder);
    const pick = next.find((p) => p.peer) ?? next[0] ?? null;
    if (pick?.id !== this.hostId) {
      if (this.hostId) this.log.info('room.host', { room: this.id, from: this.hostId, to: pick?.id ?? null });
      this.hostId = pick?.id ?? null;
    }
  }

  // ------------------------------------------------------------------------------------------------ messages
  /** One validated message from the connection bound to `participantId`. Returns a refusal to send back, or null. */
  handle(participantId: string, m: ClientMsg, now: number): ServerMsg | null {
    const p = this.participant(participantId);
    this.clock = Math.max(this.clock, now);
    if (!p || p.left || !p.peer) return { t: 'nack', ref: m.t, code: 'not_in_room' };
    const nack = (code: ErrorCode, detail?: string, seq?: number): ServerMsg => ({ t: 'nack', ref: m.t, code, ...(seq !== undefined ? { seq } : {}), ...(detail ? { detail } : {}) });
    const host = this.hostId === p.id;
    switch (m.t) {
      case 'ctl': {
        if (m.driver !== undefined && m.driver !== p.id) return nack('forbidden', 'controls are bound to your own seat', m.seq);
        if (m.seq === p.ctlSeq) return nack('duplicate', undefined, m.seq);
        if (m.seq < p.ctlSeq) return nack('out_of_order', undefined, m.seq);
        if (m.seq > p.ctlSeq + LIMITS.maxSeqJump) return nack('malformed', 'sequence jump', m.seq);
        p.ctlSeq = m.seq; p.ctlAt = now;
        p.held = { up: m.up, down: m.down };
        return null;
      }
      case 'act': {
        if (m.driver !== undefined && m.driver !== p.id) return nack('forbidden', 'actions are bound to your own seat', m.seq);
        if (this.state !== 'race' || !this.race || !p.inRace) return nack('bad_state', undefined, m.seq);
        if (m.seq === p.actSeq) return nack('duplicate', undefined, m.seq);
        if (m.seq < p.actSeq) return nack('out_of_order', undefined, m.seq);
        if (m.seq > p.actSeq + LIMITS.maxSeqJump) return nack('malformed', 'sequence jump', m.seq);
        const r = this.race.act({ driver: p.id, seq: m.seq, type: m.type });
        if (r !== 'queued') return nack(r === 'stale' ? 'stale' : 'forbidden', undefined, m.seq);
        p.actSeq = m.seq;
        return { t: 'ack', seq: m.seq, result: 'queued' };
      }
      case 'ready':
        if (this.state !== 'lobby') return nack('bad_state');
        p.ready = m.ready; this.touch(now); this.broadcastRoom();
        return null;
      case 'livery': {
        if (this.state !== 'lobby') return nack('bad_state');
        const l = this.pickLivery(m.livery, p.slot, this.takenLiveries(p));
        p.livery = l; p.liveryRequested = l !== m.livery ? m.livery : null;
        this.touch(now); this.broadcastRoom();
        return null;
      }
      case 'settings': {
        if (!host) return nack('forbidden', 'only the room host changes settings');
        if (this.state !== 'lobby' && this.state !== 'results') return nack('bad_state');
        const bad = this.applySettings(m.settings);
        if (bad) return nack('bad_settings', bad);
        for (const x of this.parts) if (x !== p) x.ready = false;   // the race changed: everyone confirms again
        this.touch(now); this.broadcastRoom();
        return null;
      }
      case 'start': {
        if (!host) return nack('forbidden', 'only the room host starts the race');
        if (this.state !== 'lobby') return nack('bad_state');
        const act = this.active();
        if (act.length < this.rules.minHumans) return nack('not_ready', `needs ${this.rules.minHumans} drivers`);
        if (act.some((x) => !x.peer)) return nack('not_ready', 'a driver is disconnected');
        if (act.some((x) => x !== p && !x.ready)) return nack('not_ready', 'every driver must be ready');
        p.ready = true;
        this.startRace(now);
        return null;
      }
      case 'rematch':
        if (!host) return nack('forbidden', 'only the room host calls a rematch');
        if (this.state !== 'results') return nack('bad_state');
        this.state = 'lobby'; this.race = null; this.raceId = null; this.result = null; this.awards = null; this.roster = [];
        for (const x of this.parts) { x.ready = false; x.inRace = false; }
        this.touch(now); this.broadcastRoom();
        return null;
      case 'leave':
        this.leave(p.id, now);
        return null;
      default:
        return nack('bad_state');
    }
  }

  // ------------------------------------------------------------------------------------------------ the race
  private startRace(now: number): void {
    const act = this.active().sort((a, b) => a.slot - b.slot);
    const taken = new Set(act.map((p) => p.livery));
    this.roster = act.map((p) => ({ id: p.id, control: 'human' as const, slot: p.slot, name: p.name, color: liveryColor(p.livery), livery: p.livery, accountId: p.accountId }));
    if (this.settings.aiFill) {
      for (let slot = 0; slot < DRIVERS.length; slot++) {
        if (this.roster.some((e) => e.slot === slot)) continue;
        const livery = this.pickLivery(undefined, slot, taken); taken.add(livery);
        this.roster.push({ id: `ai_${slot}`, control: 'ai', slot, name: `${AI_NAMES[slot]} (AI)`, color: liveryColor(livery), livery, accountId: null });
      }
    }
    const humans = act.length;
    const seed = this.deps.seed ? this.deps.seed() : randomInt(1, 2 ** 31);
    this.race = new Race({
      track: trackById(this.settings.track),
      roster: this.roster.map(({ id, control, slot, name, color }) => ({ id, control, slot, name, color })),
      seed, practice: this.rules.practice, runOn: 'live',
      finishWindow: humans > 1 ? 90 : SOLO_FINISH_WINDOW, timeLimit: RACE_TIME_LIMIT,
    });
    this.raceId = randomUUID();
    for (const p of this.parts) { p.inRace = !p.left; p.held = neutral(); p.ready = false; }
    this.state = 'race';
    this.baseWall = now; this.stepsDone = 0; this.lagSteps = 0; this.startedAt = now; this.greenAt = null;
    this.laps = []; this.evBuf = []; this.result = null;
    this.log.info('race.start', { room: this.id, race: this.raceId, track: this.settings.track, mode: this.mode, humans, ai: this.roster.length - humans });
    this.touch(now);
    this.broadcastRoom();
    this.broadcastState(now);
  }

  /** Advance this room to wall time `now`: seat timers, idle limits and the race. Called by the manager's tick loop. */
  pump(now: number): void {
    if (this.state === 'closed') return;
    this.clock = Math.max(this.clock, now);
    this.timers(now);
    if (this.state === 'race' && this.race) this.stepRace(now);
  }

  private timers(now: number): void {
    for (const p of [...this.parts]) {
      if (p.peer && (p.held.up || p.held.down) && now - p.ctlAt > this.cfg.inputTimeoutMs) {
        p.held = neutral();   // stale controls: a frozen client never keeps a pedal down
        this.log.debug('room.input_timeout', { room: this.id, participant: p.id });
      }
      if (!p.left && !p.peer && p.lostAt !== null && now - p.lostAt > this.cfg.graceS * 1000) {
        this.log.info('room.grace_expired', { room: this.id, participant: p.id, state: this.state });
        this.dropSeat(p, now);
        if (this.state === 'closed') return;
      }
    }
    if (now - this.createdAt > this.cfg.roomMaxS * 1000) { this.abortAndClose('lifetime', now); return; }
    if (this.state === 'lobby' && now - this.lastActivity > this.cfg.lobbyIdleS * 1000) { this.close('idle'); return; }
    if (this.state === 'results' && now - this.resultsAt > this.cfg.resultsIdleS * 1000) this.close('idle');
  }

  private inputs(): Record<DriverId, Input> {
    const out: Record<DriverId, Input> = Object.create(null) as Record<DriverId, Input>;
    for (const p of this.parts) if (p.inRace && !p.left && p.peer) out[p.id] = p.held;
    return out;
  }

  /**
   * Timing policy (docs/online-server.md): race time advances in fixed STEP steps owed by elapsed wall time, at most
   * maxCatchUpSteps per tick. Time the server could not simulate yet is a backlog, never dropped: it is caught up on later
   * ticks (every car alike, so the race stays fair). A backlog above overloadAbortMs aborts the race with no result rather
   * than skipping race time or inventing one. Once every human is terminal the AI run-on goes at RUNON_STEPS per tick.
   */
  private stepRace(now: number): void {
    const race = this.race!;
    const scale = this.cfg.timeScale;
    if (race.humansDoneT >= 0) {
      for (let i = 0; i < RUNON_STEPS && this.state === 'race'; i++) this.stepOnce(now);
      this.baseWall = now - (this.stepsDone * STEP * 1000) / scale;
      this.lagSteps = 0;
      return;
    }
    const owed = Math.floor(((now - this.baseWall) * scale) / 1000 / STEP + 1e-9) - this.stepsDone;
    const n = Math.max(0, Math.min(owed, this.cfg.maxCatchUpSteps));
    for (let i = 0; i < n && this.state === 'race'; i++) this.stepOnce(now);
    if (this.state !== 'race') return;
    this.lagSteps = Math.max(0, owed - n);
    if (this.lagMs > this.cfg.overloadAbortMs) {
      this.log.warn('race.overload_abort', { room: this.id, race: this.raceId, lagMs: Math.round(this.lagMs) });
      this.finalize('aborted', 'overload', now);
    }
  }
  get lagMs(): number { return (this.lagSteps * STEP * 1000) / this.cfg.timeScale; }

  private stepOnce(now: number): void {
    const race = this.race!;
    race.update(STEP, this.inputs());
    this.stepsDone++;
    for (const e of race.drainEvents()) {
      this.evBuf.push(e);
      if (e.type === 'go') this.greenAt = now;
      if (e.type === 'lap') this.laps.push({ driver: e.car, lap: e.lapsDone, time: e.time, valid: e.valid, raceT: round3(race.raceTime) });
    }
    if (this.evBuf.length > 256) this.evBuf.splice(0, this.evBuf.length - 256);   // bounded even if no snapshot goes out
    // practice has no classification: the only way it closes on its own is the race-time limit, and that is still a
    // laps-only session end (never a DNF "timeout" result)
    if (race.final) { this.broadcastState(now); this.finalize(this.rules.practice ? 'ended' : 'completed', null, now); return; }
    if (this.stepsDone % this.snapEvery === 0) this.broadcastState(now);
  }

  /** Build this race's one result envelope, hand it to the sink once, and move the room to results. */
  private finalize(outcome: 'completed' | 'aborted' | 'ended', reason: string | null, now: number): void {
    if (this.state !== 'race' || !this.race || this.result) return;
    const race = this.race;
    const participants: EnvelopeParticipant[] = this.roster.map((e) => {
      const c = race.car(e.id)!;
      return { id: e.id, control: e.control, slot: e.slot, num: c.num, bay: c.bayHome, name: e.name ?? c.name, livery: e.livery, accountId: e.accountId };
    });
    const env = buildEnvelope({
      raceId: this.raceId!, roomId: this.id, mode: this.mode, championship: this.championship, outcome, abortReason: reason,
      trackId: this.settings.track, settings: this.settings, participants,
      classification: outcome === 'completed' && race.final ? [...race.final] : null,
      laps: this.laps,
      times: {
        roomCreatedAt: iso(this.createdAt), startedAt: iso(this.startedAt), greenAt: this.greenAt === null ? null : iso(this.greenAt),
        finishedAt: iso(now), raceTimeS: round3(race.raceTime), ticks: this.stepsDone,
      },
    });
    this.result = env;
    this.results.push(env);
    this.state = 'results'; this.resultsAt = now;
    this.log.info('race.final', { room: this.id, race: env.raceId, outcome, reason, digest: env.digest });
    this.consume(env);
    // seats given up during the race are freed now; the rest stay for a rematch
    this.parts = this.parts.filter((p) => !p.left);
    for (const p of this.parts) { p.inRace = false; p.ready = false; p.held = neutral(); }
    this.ensureHost();
    this.broadcast({ t: 'result', envelope: env });
    this.broadcast({ t: 'awards', awards: this.awards! });
    if (!this.active().length) { this.close('empty'); return; }
    this.broadcastRoom();
  }

  /**
   * Hand the envelope to storage once. The awards shown are computed from the same envelope by the same function storage
   * uses, so what every member sees is what the ledger records; `sync` says whether it is stored yet. A storage failure is
   * queued durably by the sink ('pending') and settled later through `settled`.
   */
  private consume(env: Readonly<ResultEnvelope>): void {
    this.awards = { ...computeAwards(env, this.deps.scoring ?? DEFAULT_SCORING).view, sync: 'saving' };
    this.deps.sink.consume(env).then(
      (r) => { this.log.info('result.consumed', { race: env.raceId, result: r }); this.settled(env.raceId, r === 'queued' ? 'pending' : 'saved'); },
      (err: unknown) => {
        this.log.error('result.consume_failed', { race: env.raceId, error: String(err) });
        this.settled(env.raceId, err instanceof ResultConflict ? 'failed' : 'pending');
      },
    );
  }

  /** Storage of this room's last result has moved on (stored, queued, or stored later from the queue): tell every member. */
  settled(raceId: string, sync: AwardSync): void {
    if (!this.awards || this.awards.raceId !== raceId || this.awards.sync === sync || this.awards.sync === 'saved') return;
    this.awards = { ...this.awards, sync };
    if (this.state !== 'closed') this.broadcast({ t: 'awards', awards: this.awards });
  }

  /** Stop the race (if any) without a result, then close: used for room lifetime, overload and server shutdown. */
  abortAndClose(reason: string, now: number): void {
    if (this.state === 'race') this.finalize('aborted', reason, now);
    this.close(reason);
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.log.info('room.close', { room: this.id, reason });
    for (const p of this.parts) if (p.peer) { this.sendTo(p.peer, { t: 'bye', code: reason === 'shutdown' ? 'shutdown' : 'closed', detail: reason }); p.peer.close(reason === 'shutdown' ? 1012 : 1000, reason); p.peer = null; }
    this.race = null;
    this.deps.onClose?.(this);
  }

  // ------------------------------------------------------------------------------------------------ output
  private touch(now: number): void { this.lastActivity = now; this.clock = Math.max(this.clock, now); this.rev++; }

  publicRoom(): PublicRoom {
    const ai: PublicAi[] = [];
    if (this.state === 'race' || this.state === 'results') {
      for (const e of this.roster) if (e.control === 'ai') ai.push({ id: e.id, name: e.name!, slot: e.slot, num: DRIVERS[e.slot].num, bay: e.slot, livery: e.livery, color: liveryColor(e.livery), ai: true });
    } else if (this.settings.aiFill) {
      const taken = this.takenLiveries();
      const used = new Set(this.active().map((p) => p.slot));
      for (let slot = 0; slot < DRIVERS.length; slot++) {
        if (used.has(slot)) continue;
        const livery = this.pickLivery(undefined, slot, taken); taken.add(livery);
        ai.push({ id: `ai_${slot}`, name: `${AI_NAMES[slot]} (AI)`, slot, num: DRIVERS[slot].num, bay: slot, livery, color: liveryColor(livery), ai: true });
      }
    }
    return {
      id: this.id, code: this.code, mode: this.mode, state: this.state, rev: this.rev, hostId: this.hostId,
      settings: { ...this.settings }, championship: this.championship,
      participants: this.parts.map((p): PublicParticipant => ({
        id: p.id, name: p.name, slot: p.slot, num: DRIVERS[p.slot].num, bay: p.slot, livery: p.livery, color: liveryColor(p.livery),
        liveryRequested: p.liveryRequested, ready: p.ready, connected: !!p.peer, host: p.id === this.hostId, guest: !p.accountId,
        joinOrder: p.joinOrder, left: p.left,
      })),
      ai, raceId: this.raceId, maxHumans: this.rules.maxHumans, minHumans: this.rules.minHumans, graceS: this.cfg.graceS,
    };
  }

  /** The private join reply: the only message that ever carries the reconnect token, sent to that connection alone. */
  joinedMsg(participantId: string, token: string, resumed: boolean): ServerMsg {
    const p = this.participant(participantId)!;
    return { t: 'joined', room: this.publicRoom(), you: p.id, token, ctlSeq: p.ctlSeq, actSeq: p.actSeq, resumed };
  }

  /** Race state for one late (re)joiner, so a resumed client is current at once. */
  stateMsg(now: number): string | null {
    if (!this.race) return null;
    return JSON.stringify({ t: 'state', tick: this.stepsDone, now, lagMs: Math.round(this.lagMs), snap: this.race.snapshot(), ev: [] } satisfies ServerMsg);
  }

  private broadcastRoom(except?: Peer): void { if (this.state !== 'closed') this.broadcast({ t: 'room', room: this.publicRoom() }, except); }

  private broadcastState(now: number): void {
    if (!this.race) return;
    const msg: ServerMsg = { t: 'state', tick: this.stepsDone, now, lagMs: Math.round(this.lagMs), snap: this.race.snapshot(), ev: this.evBuf };
    this.evBuf = [];
    this.broadcast(msg);
  }

  /** Every member gets the same bytes, so every client sees identical decisions. */
  private broadcast(m: ServerMsg, except?: Peer): void {
    const s = JSON.stringify(m);
    for (const p of this.parts) if (p.peer && p.peer !== except) this.sendRaw(p, s);
  }
  private sendTo(peer: Peer, m: ServerMsg): void { try { peer.send(JSON.stringify(m)); } catch { /* closing */ } }

  /** Bounded send queue: a socket that cannot keep up is dropped (and may reconnect) instead of buffering without limit. */
  private sendRaw(p: Participant, s: string): void {
    const peer = p.peer!;
    if (peer.bufferedAmount > this.cfg.sendBufferMax) {
      this.log.warn('room.slow_client', { room: this.id, participant: p.id, buffered: peer.bufferedAmount });
      peer.close(4008, 'slow');
      this.disconnect(p.id, peer, this.clock);
      return;
    }
    try { peer.send(s); } catch { /* the close handler disconnects the seat */ }
  }
}

const DEFAULT_SCORING = makeScoring();
export function liveryColor(id: LiveryId): number { return LIVERIES.find((l) => l.id === id)!.color; }
const iso = (ms: number): string => new Date(ms).toISOString();
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
export { isLivery };
