// Post-race debrief (#134): per-driver metrics collected by the shared race core, in simulation time, from the green light to
// that driver's own terminal result (finish, DQ or DNF), then frozen. The same collector runs in the browser (local races and
// championship rounds) and on the room server (online races, whose envelope carries the frozen summaries), so a seeded race
// with the same inputs gives the same summary on both. It only reads race state: nothing here changes the simulation.
// Plain data and pure functions only (no DOM, no strings table): the room server bundles it. Definitions: docs/race-debrief.md.
import type { Car, DnfReason, DqReason, Race, RaceEvent } from './race';

/** Version of the summary model inside an envelope's `debrief` (a later, incompatible model raises it; readers skip others). */
export const DEBRIEF_VERSION = 1;

/** What kind of visit a car is on: entered by the driver through the pit entrance, towed in out of fuel, or recovered after stopping. */
export type VisitKind = 'pit' | 'tow' | 'recover';

/** One driver's frozen summary: counts, and durations in seconds of race time (rounded to the millisecond). */
export interface DriverDebrief {
  driver: string;
  /** laps completed (the lap events of this race, the flag lap included) */
  laps: number;
  /** valid flying laps: valid in the race core (clean sectors, no pit, contact, reverse or recovery) and not lap 1 (standing start) */
  valid: number;
  /** fastest valid flying lap (s) and its lap number; null without one */
  best: number | null; bestLap: number | null;
  /** mean of the valid flying laps (s); null without one */
  mean: number | null;
  /** standard deviation of the valid flying laps (s, population); null with fewer than two */
  sd: number | null;
  /** de-slots, and the time spent off the slot until the marshal put the car back */
  deslots: number; offS: number;
  /** collision offences charged to this driver; stop-and-go penalties those offences awarded; offences charged to others for hitting this car */
  offences: number; stopGos: number; hitBy: number;
  /** stop-and-go penalties served in the box */
  served: number;
  /** out-of-fuel tows and stopped-on-track recoveries */
  tows: number; recoveries: number;
  /**
   * Visits the driver entered through the pit entrance. `s`: pit entrance to pit exit (closed early by a tow or the end of the
   * driver's race). Components, never summed into anything: `bayS` in the bay (turn in, service, departure), `serveS` standing
   * in the box serving a stop-and-go, `queueS` held in the pit queue or at the exit; at each step at most one of them counts
   * (bay, then box, then queue), so together they are never more than `s`.
   */
  pit: { visits: number; fuel: number; s: number; queueS: number; serveS: number; bayS: number };
  /**
   * Forced visits: `towS` from running dry to the pit exit, `recS` from a stopped-on-track recovery to the pit exit; `penS`
   * the part of `towS` the car was held in its bay by the tow penalty.
   */
  forced: { towS: number; recS: number; penS: number };
  /** a visit still under way when the driver's race ended (closed at that moment), or null */
  open: VisitKind | null;
}

/** Mutable accumulator for one car while its race runs. */
interface Acc {
  frozen: boolean; lastT: number; visit: VisitKind | null; open: VisitKind | null; wasBayIn: boolean;
  laps: number; valid: number; mean: number; m2: number; best: number; bestLap: number;
  deslots: number; offS: number; offences: number; stopGos: number; hitBy: number; served: number; tows: number; recoveries: number;
  pitN: number; fuel: number; pitS: number; queueS: number; serveS: number; bayS: number;
  towS: number; recS: number; penS: number;
}
const fresh = (t: number): Acc => ({
  frozen: false, lastT: t, visit: null, open: null, wasBayIn: false,
  laps: 0, valid: 0, mean: 0, m2: 0, best: 0, bestLap: 0,
  deslots: 0, offS: 0, offences: 0, stopGos: 0, hitBy: 0, served: 0, tows: 0, recoveries: 0,
  pitN: 0, fuel: 0, pitS: 0, queueS: 0, serveS: 0, bayS: 0, towS: 0, recS: 0, penS: 0,
});

const BAY_MODES = new Set(['bayIn', 'service', 'bayOut']);
const ms = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Collects every car's debrief inside a Race. Fixed size per car (running sums, no lap or event history), so memory is
 * bounded whatever the race length. `event` sees each race event as it is emitted; `observe` runs once per simulation step,
 * after every transition of that step (moves, contacts, the bounded end and stopped-on-track recoveries).
 */
export class DebriefCollector {
  private accs = new Map<string, Acc>();
  private started = false;

  private acc(c: Car, t: number): Acc {
    let a = this.accs.get(c.id);
    if (!a) { a = fresh(t); this.accs.set(c.id, a); }
    return a;
  }

  /** Collection starts at the green light: every car from zero at that race time. */
  private start(r: Race): boolean {
    if (this.started) return true;
    if (r.phase === 'countdown') return false;
    this.started = true;
    for (const c of r.cars) this.acc(c, r.raceTime);
    return true;
  }

  /** An emitted race event. Only a car still running counts it, so nothing after its finish, DQ or DNF is ever added. */
  event(r: Race, e: RaceEvent): void {
    if (!this.start(r)) return;
    const live = (c: Car): Acc | null => { const a = this.acc(c, r.raceTime); return a.frozen || c.status !== 'running' ? null : a; };
    switch (e.type) {
      case 'lap': {
        const a = live(e.car); if (!a) break;
        a.laps++;
        // a flying lap: valid in the race core and started at a flying crossing (lap 1 starts from the grid)
        if (e.valid && e.lapsDone >= 2) {
          a.valid++;
          const d = e.time - a.mean; a.mean += d / a.valid; a.m2 += d * (e.time - a.mean);
          if (a.valid === 1 || e.time < a.best) { a.best = e.time; a.bestLap = e.lapsDone; }
        }
        break;
      }
      case 'deslot': { const a = live(e.car); if (a) a.deslots++; break; }
      case 'offence': {
        const a = live(e.car); if (a) { a.offences++; if (e.stop) a.stopGos++; }
        const o = live(e.other); if (o) o.hitBy++;
        break;
      }
      case 'served': { const a = live(e.car); if (a) a.served++; break; }
      // a tow ends a pit visit it happens in (the car ran dry in the pit lane): from here on it is forced
      case 'tow': { const a = live(e.car); if (a) { a.tows++; a.visit = 'tow'; } break; }
      case 'recover': { const a = live(e.car); if (a) { a.recoveries++; a.visit = 'recover'; } break; }
      default: break;
    }
  }

  /**
   * Once per step: durations from race time (so the countdown and a paused race add nothing), visits opened and closed from
   * the car's mode, and a car that became terminal this step frozen (any visit closed at that moment). A step's time goes to
   * the state the car is in at the end of it, so every interval is exact to within one simulation step.
   */
  observe(r: Race): void {
    if (!this.start(r)) return;
    for (const c of r.cars) {
      const a = this.acc(c, r.raceTime);
      if (a.frozen) continue;
      const dt = r.raceTime - a.lastT;
      a.lastT = r.raceTime;
      if (c.status !== 'running') { a.open = a.visit; a.visit = null; a.frozen = true; continue; }
      if (a.visit === null && c.mode === 'pitlane') { a.visit = 'pit'; a.pitN++; }
      else if (a.visit !== null && c.mode === 'race') a.visit = null;
      const bayIn = c.mode === 'bayIn';
      if (bayIn && !a.wasBayIn && a.visit === 'pit') a.fuel++;
      a.wasBayIn = bayIn;
      if (c.mode === 'off') a.offS += dt;
      if (a.visit === 'pit') {
        a.pitS += dt;
        if (BAY_MODES.has(c.mode)) a.bayS += dt;
        else if (c.sgServing) a.serveS += dt;
        else if (c.mode === 'pitlane' && c.pitHold) a.queueS += dt;
      } else if (a.visit === 'tow') {
        a.towS += dt;
        if (c.mode === 'service' && c.penalty > 0) a.penS += dt;
      } else if (a.visit === 'recover') a.recS += dt;
    }
  }

  /** The summary of one driver as collected so far (frozen once that driver is terminal); null for an unknown driver. */
  summary(id: string): DriverDebrief | null {
    const a = this.accs.get(id);
    if (!a) return null;
    return {
      driver: id, laps: a.laps, valid: a.valid,
      best: a.valid ? ms(a.best) : null, bestLap: a.valid ? a.bestLap : null,
      mean: a.valid ? ms(a.mean) : null, sd: a.valid >= 2 ? ms(Math.sqrt(Math.max(0, a.m2 / a.valid))) : null,
      deslots: a.deslots, offS: ms(a.offS), offences: a.offences, stopGos: a.stopGos, hitBy: a.hitBy, served: a.served,
      tows: a.tows, recoveries: a.recoveries,
      pit: { visits: a.pitN, fuel: a.fuel, s: ms(a.pitS), queueS: ms(a.queueS), serveS: ms(a.serveS), bayS: ms(a.bayS) },
      forced: { towS: ms(a.towS), recS: ms(a.recS), penS: ms(a.penS) },
      open: a.frozen ? a.open : a.visit,
    };
  }

  /** Whether this driver's metrics are final (its race is over). */
  frozen(id: string): boolean { return !!this.accs.get(id)?.frozen; }
}

// ------------------------------------------------------------------------------------------------ reading a received summary
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const cnt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const numOrNull = (x: unknown): boolean => x === null || num(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * One driver's summary from a result envelope, checked field by field. Anything missing, of another model version or
 * malformed is null: shown as unavailable, never read as zeros.
 */
export function readDebrief(env: unknown, driver: string): DriverDebrief | null {
  if (!isObj(env) || !isObj(env.debrief) || env.debrief.v !== DEBRIEF_VERSION || !Array.isArray(env.debrief.drivers)) return null;
  const d = (env.debrief.drivers as unknown[]).find((x) => isObj(x) && x.driver === driver);
  if (!isObj(d) || !isObj(d.pit) || !isObj(d.forced)) return null;
  const p = d.pit, f = d.forced;
  const ok = cnt(d.laps) && cnt(d.valid) && numOrNull(d.best) && (d.bestLap === null || cnt(d.bestLap)) && numOrNull(d.mean) && numOrNull(d.sd)
    && cnt(d.deslots) && num(d.offS) && cnt(d.offences) && cnt(d.stopGos) && cnt(d.hitBy) && cnt(d.served) && cnt(d.tows) && cnt(d.recoveries)
    && cnt(p.visits) && cnt(p.fuel) && num(p.s) && num(p.queueS) && num(p.serveS) && num(p.bayS) && num(f.towS) && num(f.recS) && num(f.penS)
    && (d.open === null || d.open === 'pit' || d.open === 'tow' || d.open === 'recover');
  return ok ? (d as unknown as DriverDebrief) : null;
}

// ------------------------------------------------------------------------------------------------ progress and takeaway
/** The compatible personal best from before the race (ms), and this race's best valid lap (ms). */
export interface PbCompare { before: number; best: number; delta: number; improved: boolean; }

/**
 * This race's best valid lap against a compatible personal best captured before the race. null when either is missing:
 * no baseline, no comparison (never a "new PB" against nothing).
 */
export function comparePb(beforeMs: number | null | undefined, bestS: number | null | undefined): PbCompare | null {
  if (!beforeMs || !(beforeMs > 0) || !bestS || !(bestS > 0)) return null;
  const best = Math.round(bestS * 1000);
  return { before: beforeMs, best, delta: (best - beforeMs) / 1000, improved: best < beforeMs };
}

/** The result row a takeaway is judged against: the classification's status, reasons and time penalty. */
export interface ResultFacts { status: 'finished' | 'dq' | 'dnf' | 'running'; dqReason: DqReason | null; dnfReason: DnfReason | null; timePen: number; }

/** A takeaway: a strings-table id and its values. Every value is a figure the debrief also shows. */
export interface Takeaway { id: string; vars?: Record<string, string | number>; }

/**
 * One short takeaway, from fixed rules in a fixed order (docs/race-debrief.md). Only facts the debrief displays are used, so
 * the message is always backed by a figure on the card. Without a summary there is no takeaway at all.
 */
export function takeaway(d: DriverDebrief | null, r: ResultFacts, pb: PbCompare | null): Takeaway | null {
  if (!d) return null;
  if (r.status === 'dq') return { id: `deb.tk.dq.${r.dqReason ?? 'deadline'}` };
  if (pb?.improved) return { id: 'deb.tk.pb', vars: { d: Math.abs(pb.delta).toFixed(3) } };
  if (d.tows > 0) return { id: 'deb.tk.tow', vars: { n: d.tows } };
  if (d.deslots > 0) return { id: d.deslots === 1 ? 'deb.tk.deslot1' : 'deb.tk.deslots', vars: { n: d.deslots } };
  if (d.offences > 0) return { id: d.offences === 1 ? 'deb.tk.offence1' : 'deb.tk.offences', vars: { n: d.offences } };
  if (d.recoveries > 0) return { id: 'deb.tk.stall', vars: { n: d.recoveries } };
  if (r.status === 'dnf') return { id: 'deb.tk.dnf', vars: { n: d.laps } };
  if (d.valid < 2) return { id: 'deb.tk.fewLaps', vars: { n: d.valid } };
  if (r.timePen > 0) return { id: 'deb.tk.timePen', vars: { n: r.timePen } };
  return { id: 'deb.tk.clean' };
}
