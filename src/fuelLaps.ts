// Approximate laps of fuel left, for the HUD's fuel meter (#87). Client-only and read-only: it watches the local car's tank
// and slot distance and never feeds anything back into the race. Imported by src/hud.ts and its unit tests only, never by
// src/race.ts, src/net/ or server/, so the server bundle, PROTOCOL_VERSION and RULES_VERSION are untouched (docs/fuel-laps.md).
//
// Burn in the race core is per distance, scaled by throttle (src/race.ts: `abs(v) * dt * fuelRate(L) * (0.5 + 0.7*thr)`), so
// a figure from the car's own recent burn per metre of slot says how far the tank will go at the current driving style:
//   laps left = fuel / (burnPerDistance * L)
// Before half a lap has been measured (grid, first half-lap, a stint after a refill with no earlier rate) it uses the nominal
// rate times FALLBACK_BURN. Online it reads the mirror's `fuel` (3 decimals, a non-empty tank never 0) and `u`, which the
// snapshots already carry: the measurement telescopes over whole chunks of distance, so the 0.001 quantum never accumulates.
import { fuelRate } from './race';

/** smallest step of the online fuel reading (src/net/snapwire.ts: 3 decimals): a rise this small is rounding, not a refill */
export const SNAP_EPS = 0.001;
/** burn multiplier assumed before any is measured: between nominal 1.0 (7.4 laps a tank) and full throttle 1.2 (6.17) */
export const FALLBACK_BURN = 1.1;
/** laps of measured distance a stint needs before its own rate is used */
export const MIN_SAMPLE_LAPS = 0.5;
/** the rolling rate covers about this many laps of the newest measured distance */
export const WINDOW_LAPS = 1;
/** measurement unit: burn and distance are banked in chunks this long (a fraction of a lap) */
export const CHUNK_LAPS = 0.25;
/** implied burn multipliers (rate / fuelRate(L)) outside this band are outliers: coast is 0.5, full throttle 1.2 */
export const MULT_MIN = 0.4, MULT_MAX = 2;
/** race-clock seconds between two readings beyond which they are not compared (reconnect, missed snapshots) */
export const SAMPLE_GAP = 0.35;
/** fastest believable slot travel per second of race clock (VMAX is 26), plus slack for one coarse reading */
const MAX_SPEED = 40, SPEED_SLACK = 0.5;
/** a backward move up to this (the 1.6 m marshal re-slot, reversing) adds no distance; a larger one is a jump: resync */
export const BACK_TOL = 2;
/** the shown figure changes at most this often (race-clock seconds), so 3.41 / 3.39 does not shimmer */
export const SHOW_EVERY = 0.5;

/** One HUD reading of the local car. `u` is the unwrapped slot distance (Car.u), `now` the race clock (Race.raceTime). */
export interface FuelSample { fuel: number; u: number; L: number; now: number; }

export type FuelLapsSource = 'fallback' | 'observed' | 'previous';
export interface FuelLapsReading {
  /** laps of racing-lap length the tank still covers at `burnPerDistance` (>= 0) */
  laps: number;
  /** fuel per metre of slot used for `laps` */
  burnPerDistance: number;
  /** what the rate is: the nominal fallback, this stint's measurement, or the last stint's kept across a refill */
  source: FuelLapsSource;
}

interface Chunk { burn: number; dist: number; }

/**
 * Rolling burn-per-distance estimator for one car in one race. Feed it every HUD frame with `update`; `reset` for a new race
 * or a different car. Rules:
 * - Distance is counted only for believable forward travel between consecutive readings. A tiny backward move adds nothing;
 *   a big jump (tow, stopped-on-track recovery, reconnect), a race-clock gap over SAMPLE_GAP or an unexplained fuel drop
 *   resyncs: neither the distance nor the fuel across it is counted.
 * - Burn is the drop in fuel over a stretch of counted readings, so the reading's rounding cancels out along a chunk.
 * - A rise of more than SNAP_EPS over the lowest fuel seen since the last resync is a refill: the current stint (its chunks
 *   and the open chunk, the in-lap included) is dropped, and the last accepted rate is kept until the new stint has its own.
 * - A chunk whose implied multiplier is outside MULT_MIN..MULT_MAX is ignored.
 */
export class FuelLapsEstimator {
  private last: FuelSample | null = null;
  /** closed chunks of the current stint, oldest first (only accepted ones) */
  private chunks: Chunk[] = [];
  /** open chunk: burn banked from finished segments, counted distance, and the fuel the current segment started at */
  private openBurn = 0; private openDist = 0; private segFuel = 0;
  /** lowest fuel since the last resync or refill: refills are judged against it, so a 0.001 flicker is not one */
  private minFuel = 0;
  /** the last accepted observed rate (kept across refills) */
  private observed: number | null = null;
  private L = 0;
  /** refills seen (one per stop, however many readings it rises over) and resyncs done: diagnostics and tests */
  refills = 0; resyncs = 0;
  private refilling = false;

  reset(): void {
    this.last = null; this.chunks = []; this.openBurn = 0; this.openDist = 0; this.segFuel = 0; this.minFuel = 0;
    this.observed = null; this.L = 0; this.refills = 0; this.resyncs = 0; this.refilling = false;
  }

  /** distance of accepted measurement in the current stint (metres) */
  get stintDist(): number { return this.chunks.reduce((a, c) => a + c.dist, 0); }

  update(x: FuelSample): FuelLapsReading {
    if (!(x.L > 0)) return { laps: 0, burnPerDistance: 0, source: 'fallback' };
    if (x.L !== this.L) { this.reset(); this.L = x.L; }
    const fuel = Math.max(0, x.fuel);
    const p = this.last;
    const floor = this.minFuel;   // the lowest reading before this one (the branches below move it)
    const refill = !!p && fuel > floor + SNAP_EPS + 1e-9;
    if (!p) this.startSegment(fuel);
    else if (refill) {
      // refill: the stint ends here; the in-lap is not a burn sample
      if (!this.refilling) this.refills++;
      this.chunks = []; this.openBurn = 0; this.openDist = 0;
      this.startSegment(fuel);
    } else {
      const dt = x.now - p.now, du = x.u - p.u, drop = p.fuel - fuel;
      const nominal = fuelRate(x.L);
      const jump = dt < 0 || dt > SAMPLE_GAP || du > MAX_SPEED * dt + SPEED_SLACK || du < -BACK_TOL
        || drop > MULT_MAX * nominal * Math.max(0, du) + 2 * SNAP_EPS;
      if (jump) {
        // bank what the segment measured up to the last good reading, then start again from here
        this.openBurn += this.segFuel - p.fuel;
        this.startSegment(fuel);
        this.resyncs++;
      } else {
        if (du > 0) this.openDist += du;
        this.minFuel = Math.min(this.minFuel, fuel);
        if (this.openDist >= CHUNK_LAPS * x.L) this.closeChunk(fuel, nominal);
      }
    }
    // a refill stays one refill through flat readings while the tank fills; it ends once the car burns fuel again
    this.refilling = refill || (this.refilling && fuel >= floor);
    this.last = { fuel, u: x.u, L: x.L, now: x.now };
    return this.reading(fuel, x.L);
  }

  /** a new segment starts at `fuel`; refills are judged against it from here on */
  private startSegment(fuel: number): void { this.segFuel = fuel; this.minFuel = fuel; }

  private closeChunk(fuel: number, nominal: number): void {
    const burn = this.openBurn + this.segFuel - fuel, dist = this.openDist;
    const m = burn / dist / nominal;
    if (m >= MULT_MIN && m <= MULT_MAX) {
      this.chunks.push({ burn, dist });
      // keep only what the window can use
      let d = 0, k = this.chunks.length;
      while (k > 0 && d < WINDOW_LAPS * this.L) d += this.chunks[--k].dist;
      if (k > 0) this.chunks.splice(0, k);
    }
    this.openBurn = 0; this.openDist = 0; this.segFuel = fuel;
  }

  private reading(fuel: number, L: number): FuelLapsReading {
    let rate: number | null = null, source: FuelLapsSource = 'fallback';
    if (this.stintDist >= MIN_SAMPLE_LAPS * L - 1e-9) {
      let b = 0, d = 0;
      for (let k = this.chunks.length - 1; k >= 0 && d < WINDOW_LAPS * L - 1e-9; k--) { b += this.chunks[k].burn; d += this.chunks[k].dist; }
      const r = b / d, m = r / fuelRate(L);
      if (m >= MULT_MIN && m <= MULT_MAX) { this.observed = r; rate = r; source = 'observed'; }
    }
    if (rate === null && this.observed !== null) { rate = this.observed; source = 'previous'; }
    if (rate === null) rate = fuelRate(L) * FALLBACK_BURN;
    return { laps: fuel / (rate * L), burnPerDistance: rate, source };
  }
}

/**
 * Laps still to drive to the flag, the rest of the current lap included: the distance Race.fuelToFinish() plans with
 * ((laps - lapsDone) * L - ahead(FINISH_S, s)), without the AI's PLAN_BURN, in laps. `pastLine` is ahead(FINISH_S, s), the
 * distance driven since the finish line. Before the car has first crossed the line (`crossed` 0, on the grid) the lap count
 * has not started yet, so the run-up to the line is added to the full race (`pastLine` is then nearly a lap).
 */
export function lapsToFlag(laps: number, lapsDone: number, pastLine: number, L: number, crossed = 1): number {
  if (crossed < 1) return laps + (L - pastLine) / L;
  return Math.max(0, laps - lapsDone - pastLine / L);
}

export type FuelWarning = 'none' | 'short' | 'low';
/** 'low' (red) under one lap of fuel; 'short' (orange) when the tank will probably not reach the flag; otherwise 'none'. */
export function fuelWarning(estLaps: number, toFlag: number): FuelWarning {
  if (estLaps < 1) return 'low';
  if (estLaps < toFlag) return 'short';
  return 'none';
}

/** Whether the figure is shown: a live race (grid, countdown, racing) for a car still running. Hidden in practice. */
export function fuelLapsVisible(x: { practice: boolean; finished: boolean; status: string; phase: string }): boolean {
  return !x.practice && !x.finished && x.status === 'running' && (x.phase === 'countdown' || x.phase === 'racing');
}

/**
 * Holds the shown figure steady: one decimal, and a new value at most every SHOW_EVERY seconds of race clock (a clock that
 * goes back, a new race, shows at once). Returns the one-decimal text.
 */
export class SteadyFigure {
  private text: string | null = null; private at = 0;
  reset(): void { this.text = null; }
  show(laps: number, now: number): string {
    const next = (Math.round(Math.max(0, laps) * 10) / 10).toFixed(1);
    if (this.text === null || now < this.at || now - this.at >= SHOW_EVERY || next === '0.0') { this.text = next; this.at = now; }
    return this.text;
  }
}
