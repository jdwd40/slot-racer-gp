// The browser's view of a server race. The client never simulates an online race: it keeps a mirror `Race` whose state is
// overwritten from each authoritative snapshot, so the HUD, arrows, bays, camera and audio read the same fields and methods
// they read offline. Car placement is drawn from a short, bounded buffer of snapshots and interpolated between the two that
// bracket a render time a little behind the newest one (docs/online-client.md).
import { Race, type Car, type CarSnapshot, type DriverId, type RaceEvent, type RaceSnapshot, type WireEvent } from '../race';
import { trackFor } from '../track';
import { STEP, blendPose, type Pose } from '../timing';

/** A mirror race for a snapshot's roster and circuit. AI personas only matter to the server, so none are given. */
export function mirrorRace(snap: RaceSnapshot): Race {
  const roster = snap.cars.map((c) => ({ id: c.id, control: c.control, slot: c.slot, name: c.name, color: c.color }));
  const r = new Race({ roster, track: trackFor(snap.track), practice: snap.practice, runOn: 'live' });
  applySnapshot(r, snap);
  return r;
}

/** Snapshot fields copied verbatim onto the mirror's cars. */
const CAR_FIELDS = [
  'status', 'dqReason', 'dnfReason', 'finished', 'mode', 'u', 'v', 'd', 'laneSide', 'x', 'y', 'z', 'h', 'roll', 'pitch', 'yawOff', 'wobble',
  'throttle', 'brake', 'fuel', 'crossed', 'lapsDone', 'lastLap', 'bestLap', 'lapStartT', 'lapValid', 'finishTime', 'pitStops',
  'offences', 'sgOwed', 'sgServed', 'sgServing', 'timePen', 'svcBreach', 'laneReq', 'pitReq', 'fuelReq', 'fuelDue', 'sgDue', 'sgDeferred',
  'routeHold', 'laneOverride', 'revOn', 'sgPhase', 'sgCtl', 'pitWait', 'exitReq', 'serviceT', 'penalty', 'towT', 'recoverT', 'bumpT',
  'hiU', 'squeezeHold', 'pitHold', 'towSvc', 'pitFuel', 'serviced', 'upPrev', 'stallT', 'stallHold', 'stallSvc', 'away',
] as const satisfies readonly (keyof CarSnapshot & keyof Car)[];

/**
 * Overwrite the mirror with authoritative state. Nothing is re-derived or replayed: laps, pit visits, penalties and results are
 * whatever the server says now, so a correction never runs a lap, a stop or an event a second time.
 */
export function applySnapshot(r: Race, s: RaceSnapshot): void {
  r.phase = s.phase; r.t = s.t; r.raceTime = s.raceTime; r.goT = s.goT; r.lights = s.lights; r.firstFlagT = s.firstFlagT;
  for (const cs of s.cars) {
    const c = r.car(cs.id);
    if (!c) continue;
    const dst = c as unknown as Record<string, unknown>;
    const src = cs as unknown as Record<string, unknown>;
    for (const k of CAR_FIELDS) if (k in src) dst[k] = src[k];
    c.change = cs.change ? { ...cs.change } : null;
    c.off = cs.off ? { ...cs.off } : null;
    c.bay = cs.bayInUse;
    if (!('hiU' in src)) c.hiU = Math.max(c.hiU, c.u);
    // `away` (#74) is sent only while true: its absence (an older server, or the hold over) means not held
    if (!('away' in src)) c.away = false;
  }
  const idx = (id: DriverId | null): number => (id === null ? -1 : r.car(id)?.idx ?? -1);
  r.pit.box = idx(s.pit.box); r.pit.exit = idx(s.pit.exit);
  r.pit.bays = s.pit.bays.map(idx); r.pit.merges = s.pit.merges.map(idx);
  r.pit.order = s.pit.order.map(idx).filter((i) => i >= 0);
  r.final = s.final ? s.final.map((x) => ({ ...x })) : null;
  if (s.final) r.phase = 'done';
}

/** A wire event with its driver IDs turned back into the mirror's cars; null if it names a car this race does not have. */
export function localEvent(r: Race, e: WireEvent): RaceEvent | null {
  const out: Record<string, unknown> = { ...e };
  for (const k of ['car', 'other'] as const) {
    if (!(k in e)) continue;
    const c = r.car((e as Record<string, unknown>)[k] as DriverId);
    if (!c) return null;
    out[k] = c;
  }
  return out as RaceEvent;
}

// ------------------------------------------------------------------------------------------------ interpolation
interface Entry { tick: number; at: number; poses: Map<DriverId, Pose>; }

export interface BufferStats {
  /** snapshots received / ignored as stale or duplicate */
  received: number; stale: number;
  /** frames drawn with the render time past the newest snapshot (the buffer ran dry: placement held, never extrapolated) */
  starved: number; frames: number;
  /** clock re-anchors after a stall or a jump in server time */
  reanchors: number;
  /** largest gap between snapshot arrivals (ms) */
  maxGapMs: number;
  /** current buffered snapshots */
  depth: number;
}

/**
 * Snapshot arrival times mapped onto server ticks. The offset (arrival time minus server time) follows the fastest recent
 * arrival, so jitter only ever delays drawing, and it is re-anchored after a stall so the view never runs seconds behind.
 */
export class SnapBuffer {
  private q: Entry[] = [];
  private offset: number | null = null;
  private lastAt = 0;
  stats: BufferStats = { received: 0, stale: 0, starved: 0, frames: 0, reanchors: 0, maxGapMs: 0, depth: 0 };

  /** delayMs: how far behind the newest snapshot to draw; max: entries kept (bounded memory however long the race) */
  constructor(public delayMs = 100, private max = 24, private stallMs = 600) {}

  get latestTick(): number { return this.q.length ? this.q[this.q.length - 1].tick : -1; }

  reset(): void { this.q = []; this.offset = null; this.lastAt = 0; }

  /** Add a snapshot received at local time `at`. Returns false (and keeps nothing) for one that is not newer than the last. */
  push(tick: number, at: number, snap: RaceSnapshot): boolean {
    this.stats.received++;
    if (this.q.length && tick <= this.latestTick) { this.stats.stale++; return false; }
    if (this.lastAt) this.stats.maxGapMs = Math.max(this.stats.maxGapMs, at - this.lastAt);
    this.lastAt = at;
    const poses = new Map<DriverId, Pose>();
    for (const c of snap.cars) poses.set(c.id, { x: c.x, y: c.y, z: c.z, h: c.h, roll: c.roll, pitch: c.pitch });
    this.q.push({ tick, at, poses });
    if (this.q.length > this.max) this.q.splice(0, this.q.length - this.max);
    const sample = at - tick * STEP * 1000;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else if (sample - this.offset > this.stallMs) { this.offset = sample; this.stats.reanchors++; }
    else this.offset += (sample - this.offset) * 0.02;   // follow slow drift (clock rate, server catch-up) without jitter
    this.stats.depth = this.q.length;
    return true;
  }

  /** Server time (ms of simulation) to draw at local time `now`. */
  renderTime(now: number): number { return this.offset === null ? 0 : now - this.offset - this.delayMs; }

  /** Interpolated placement of every buffered car at local time `now`; null before the first snapshot. */
  sample(now: number): Map<DriverId, Pose> | null {
    if (!this.q.length) return null;
    this.stats.frames++;
    const rt = this.renderTime(now);
    const ms = (e: Entry): number => e.tick * STEP * 1000;
    const last = this.q[this.q.length - 1];
    if (rt >= ms(last)) { if (rt > ms(last) + 1) this.stats.starved++; return last.poses; }
    if (rt <= ms(this.q[0])) return this.q[0].poses;
    let i = this.q.length - 2;
    while (i > 0 && ms(this.q[i]) > rt) i--;
    const a = this.q[i], b = this.q[i + 1];
    const alpha = (rt - ms(a)) / Math.max(1e-6, ms(b) - ms(a));
    const out = new Map<DriverId, Pose>();
    for (const [id, pb] of b.poses) { const pa = a.poses.get(id); out.set(id, pa ? blendPose(pa, pb, alpha) : pb); }
    // entries wholly behind the render time are no longer needed (keep one before it to interpolate from)
    if (i > 0) this.q.splice(0, i);
    this.stats.depth = this.q.length;
    return out;
  }
}
