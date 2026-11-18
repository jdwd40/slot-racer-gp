// Post-race debrief (#134): metrics the shared race core collects per driver, from the green light to that driver's own
// terminal result. Scripted scenarios check exact counts and durations within one simulation step (pit visits with queue,
// stop-and-go service and bay time; a tow with its penalty, also out of fuel in the pit lane; a stopped-on-track recovery;
// de-slots; offences charged and suffered), lap validity, freezing at the finish, DQ and DNF, the takeaway rules, the
// personal-best comparison and reading a received summary. Collecting never changes the race (pinned digests elsewhere).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { PEN, Race, type Car, type Input, type RaceEvent, type RosterEntry } from '../src/race';
import { STEP } from '../src/timing';
import { DEBRIEF_VERSION, comparePb, readDebrief, takeaway, type DriverDebrief, type ResultFacts } from '../src/debrief';
import * as R from '../src/records';
import { NONE, UP, fresh, memStorage, place, park, seedRandom } from './helpers';

beforeEach(() => seedRandom(11));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const LAP = 3;
/** a human-driven race already under way (no countdown, no start grace), every car on lap LAP; AI cars hold their brakes */
function racing(roster: RosterEntry[], track = 'circuit-1'): Race {
  T.setTrack(track);
  const r = new Race({ roster, seed: 3, track });
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; c.pitPlan = false; }
  r.ai = () => ({ t: 0, b: 1 });
  return r;
}
const solo = (): Race => racing([{ id: 'p', control: 'human', slot: 0 }]);

/** Independent per-step bookkeeping of one car, at STEP: what the debrief must agree with (to within a step). */
interface Seen { pitIn: number[]; pitOut: number[]; bay: number; serve: number; queue: number; off: number; svcPen: number; events: RaceEvent[] }
function watch(): Seen { return { pitIn: [], pitOut: [], bay: 0, serve: 0, queue: 0, off: 0, svcPen: 0, events: [] }; }
/** Step at STEP with `input(r)` for `sec` (or until `stop`), recording what the car did. */
function run(r: Race, c: Car, input: (r: Race) => Input, sec: number, w: Seen, stop?: (r: Race) => boolean): void {
  for (let t = 0; t < sec; t += STEP) {
    const m = c.mode;
    r.update(STEP, { [c.id]: input(r) });
    w.events.push(...r.events); r.events.length = 0;
    if (c.status !== 'running') { if (stop?.(r)) break; continue; }
    if (m !== 'pitlane' && c.mode === 'pitlane' && m === 'race') w.pitIn.push(r.raceTime);
    if (m !== 'race' && c.mode === 'race' && m !== 'off') w.pitOut.push(r.raceTime);
    if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') w.bay += STEP;
    else if (c.sgServing) w.serve += STEP;
    else if (c.mode === 'pitlane' && c.pitHold) w.queue += STEP;
    if (c.mode === 'off') w.off += STEP;
    if (c.mode === 'service' && c.penalty > 0) w.svcPen += STEP;
    if (stop?.(r)) break;
  }
}
/** a driver that holds Throttle except for a release every half second (so a bay departure gets its fresh press) */
const pulse = (r: Race): Input => ({ up: Math.floor(r.raceTime * 2) % 2 === 0, down: false });
const near = (got: number, want: number, steps = 1): void => { expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThanOrEqual(steps * STEP + 1e-9); };

describe('pace: valid flying laps only', () => {
  const lap = (r: Race, c: Car, lapsDone: number, time: number, valid: boolean): void => r.emit({ type: 'lap', car: c, time, best: false, valid, lapsDone });
  it('lap 1 (standing start) and invalid laps never count; mean, consistency (population SD) and the fastest lap are exact', () => {
    const r = solo(), c = r.cars[0];
    lap(r, c, 1, 12.0, true);      // standing start: fastest of all, still not a flying lap
    lap(r, c, 2, 14.0, true);
    lap(r, c, 3, 13.0, false);     // contact, pit, reverse or recovery: invalid in the race core
    lap(r, c, 4, 14.5, true);
    const d = r.debrief('p')!;
    expect(d).toMatchObject({ laps: 4, valid: 2, best: 14, bestLap: 2, mean: 14.25, sd: 0.25 });
  });
  it('no valid flying lap: no pace and an em dash for consistency; one: pace without a consistency score', () => {
    const r = solo(), c = r.cars[0];
    lap(r, c, 1, 15, true); lap(r, c, 2, 15, false);
    expect(r.debrief('p')).toMatchObject({ laps: 2, valid: 0, best: null, bestLap: null, mean: null, sd: null });
    lap(r, c, 3, 14.2, true);
    expect(r.debrief('p')).toMatchObject({ valid: 1, best: 14.2, bestLap: 3, mean: 14.2, sd: null });
  });
  it('a fastest lap on the flag lap counts; laps after the driver is terminal never do', () => {
    const r = solo(), c = r.cars[0];
    lap(r, c, 2, 14.5, true); lap(r, c, 3, 14.6, true);
    // the race core emits the flag lap before classifying the finish: it is in
    lap(r, c, 4, 14.1, true);
    c.status = 'finished'; c.finished = true;
    lap(r, c, 5, 13.0, true);
    r.emit({ type: 'deslot', car: c });
    r.update(STEP, {});
    expect(r.debrief('p')).toMatchObject({ laps: 3, valid: 3, best: 14.1, bestLap: 4, deslots: 0 });
    expect(r.debriefs.frozen('p')).toBe(true);
  });
  it('a real race: the summary agrees with the race core\'s own lap events and best lap', () => {
    T.setTrack('circuit-2');
    const r = new Race({ track: 'circuit-2', seed: 21, roster: [{ id: 'p', control: 'human', slot: 0 }, { id: 'a1', control: 'ai', slot: 1 }] });
    const laps: { t: number; v: boolean; n: number }[] = [];
    for (let i = 0; i < 120 * 600 && r.phase !== 'done'; i++) {
      const c = r.car('p')!;
      const prof = r.profiles[c.laneSide > 0 ? '1' : '-1'];
      const want = prof[Math.floor(((r.T.wrapS(c.u) + 6) % r.T.L) / r.T.PROFILE_STEP) % prof.length] * 0.93;
      if (c.fuel < 0.25 && !c.pitReq && c.mode === 'race' && i % 60 === 0) r.requestPit('p');
      r.update(STEP, { p: c.mode === 'race' ? { up: c.v < want, down: c.v > want + 2 } : { up: i % 80 < 40, down: false } });
      for (const e of r.events) if (e.type === 'lap' && e.car.id === 'p') laps.push({ t: e.time, v: e.valid, n: e.lapsDone });
      r.events.length = 0;
    }
    const c = r.car('p')!, d = r.debrief('p')!;
    const fly = laps.filter((l) => l.v && l.n >= 2).map((l) => l.t);
    const mean = fly.reduce((a, b) => a + b, 0) / fly.length;
    expect(c.status).toBe('finished');
    expect(d.laps).toBe(laps.length);
    expect(d.laps).toBe(c.lapsDone);
    expect(d.valid).toBe(fly.length);
    expect(d.best).toBeCloseTo(Math.min(...fly), 3);
    expect(d.mean).toBeCloseTo(mean, 3);
    expect(d.sd).toBeCloseTo(Math.sqrt(fly.reduce((a, b) => a + (b - mean) ** 2, 0) / fly.length), 3);
    // the core's best valid lap (any lap, lap 1 too) is the same lap whenever lap 1 is not the fastest
    expect(d.best).toBeCloseTo(c.bestLap, 3);
    expect(d.pit.fuel).toBe(c.pitStops - d.tows);
  });
});

describe('pits, tows and recoveries: exact durations', () => {
  it('a combined visit (queue, stop-and-go in the box, fuel in the bay): each component and the entry-to-exit time, never summed', () => {
    const r = racing([{ id: 'p', control: 'human', slot: 0 }, { id: 'x', control: 'ai', slot: 3 }]);
    const P = r.car('p')!, X = r.car('x')!;
    // the rival stands in the box, so the player queues behind it before serving; it is let go after a while
    place(P, LAP * T.L + T.PIT_IN0 - 60, -1, 14); P.fuel = 0.5;
    place(X, LAP * T.L + T.PEN_S, -1, 0); X.mode = 'pitlane'; X.d = T.pitD(T.PEN_S);
    r.requestPit('p');
    P.offences = 2; r.offence(P, X, 'rear'); r.events.length = 0;
    const w = watch();
    let released = false;
    r.ai = (c) => (c === X && !released ? { t: 0, b: 1 } : { t: 1, b: 0 });
    run(r, P, (rr) => { if (!released && P.pitHold && w.queue > 1.5) { released = true; X.sgOwed = 0; } return pulse(rr); }, 60, w, () => w.pitOut.length > 0);
    const d = r.debrief('p')!;
    expect(w.pitIn).toHaveLength(1); expect(w.pitOut).toHaveLength(1);
    expect(d.pit.visits).toBe(1); expect(d.pit.fuel).toBe(1);
    expect(d).toMatchObject({ offences: 1, stopGos: 1, served: 1, tows: 0, recoveries: 0, open: null });
    near(d.pit.s, w.pitOut[0] - w.pitIn[0], 2);
    near(d.pit.bayS, w.bay, 2);
    near(d.pit.serveS, w.serve, 2);
    near(d.pit.queueS, w.queue, 2);
    // independent: a stop-and-go needs PEN.stopSeconds standing still in the box
    near(d.pit.serveS, PEN.stopSeconds, 2);
    expect(d.pit.queueS).toBeGreaterThan(1.4);
    expect(d.pit.bayS + d.pit.serveS + d.pit.queueS).toBeLessThanOrEqual(d.pit.s + 1e-9);
    // the takeaway names the offence the visit was for, a figure the card shows
    expect(takeaway(d, { status: 'running', dqReason: null, dnfReason: null, timePen: 0 }, null)).toEqual({ id: 'deb.tk.offence1', vars: { n: 1 } });
  });

  it('out of fuel on the road: a tow (not a fuel visit), timed from running dry to the pit exit, its penalty held in the bay', () => {
    const r = solo(), P = r.cars[0];
    place(P, LAP * T.L + 30, 1, 0.2); P.fuel = 0;
    const w = watch();
    let towAt = -1;
    run(r, P, (rr) => { if (towAt < 0 && P.mode === 'tow') towAt = rr.raceTime; return pulse(rr); }, 60, w, () => w.pitOut.length > 0);
    const d = r.debrief('p')!;
    expect(d).toMatchObject({ tows: 1, recoveries: 0, pit: { visits: 0, fuel: 0, s: 0 } });
    expect(P.pitStops).toBe(1);   // the race core counts the tow as a stop; the debrief does not call it a fuel visit
    near(d.forced.towS, w.pitOut[0] - towAt, 2);
    near(d.forced.penS, w.svcPen, 2);
    // independent: the tow penalty (8 s plus the tow distance) is held in full before the car may leave
    expect(d.forced.penS).toBeGreaterThanOrEqual(8 - 2 * STEP);
    expect(takeaway(d, { status: 'running', dqReason: null, dnfReason: null, timePen: 0 }, null)).toEqual({ id: 'deb.tk.tow', vars: { n: 1 } });
  });

  it('running dry inside a pit visit ends the visit there and starts the tow: no time is counted twice', () => {
    const r = solo(), P = r.cars[0];
    place(P, LAP * T.L + T.PIT_IN0 - 60, -1, 14); P.fuel = 0.6;
    r.requestPit('p');
    const w = watch();
    let towAt = -1;
    // the tank runs dry just past the pit entrance: the car rolls to a stop in the pit lane and is towed to its bay
    run(r, P, (rr) => { if (P.mode === 'pitlane' && w.pitIn.length && towAt < 0 && rr.raceTime - w.pitIn[0] > 0.5) P.fuel = 0; if (towAt < 0 && P.mode === 'tow') towAt = rr.raceTime; return pulse(rr); }, 60, w, () => w.pitOut.length > 0);
    const d = r.debrief('p')!;
    expect(towAt).toBeGreaterThan(0);
    expect(d).toMatchObject({ tows: 1, pit: { visits: 1, fuel: 0 } });
    near(d.pit.s, towAt - w.pitIn[0], 2);
    near(d.forced.towS, w.pitOut[0] - towAt, 2);
    near(d.pit.s + d.forced.towS, w.pitOut[0] - w.pitIn[0], 2);
  });

  it('stopped on track: one recovery, timed from the recovery to the pit exit; not a pit visit', () => {
    const r = solo(), P = r.cars[0];
    place(P, LAP * T.L + 30, 1, 0); P.fuel = 0.8;
    const w = watch();
    let recAt = -1;
    run(r, P, (rr) => { if (recAt < 0 && w.events.some((e) => e.type === 'recover')) recAt = rr.raceTime; return recAt < 0 ? NONE : pulse(rr); }, 30, w, () => w.pitOut.length > 0);
    const d = r.debrief('p')!;
    expect(d).toMatchObject({ recoveries: 1, tows: 0, pit: { visits: 0 } });
    near(d.forced.recS, w.pitOut[0] - recAt, 2);
    expect(takeaway(d, { status: 'running', dqReason: null, dnfReason: null, timePen: 0 }, null)).toEqual({ id: 'deb.tk.stall', vars: { n: 1 } });
  });

  it('a de-slot: counted once, with the time off the slot until the marshal puts the car back', () => {
    const r = solo(), P = r.cars[0];
    let k = 0, best = 0;
    for (let s = 0; s < T.L; s += 0.5) { const c = Math.abs(T.curvature(s)); if (c > best) { best = c; k = s; } }
    place(P, LAP * T.L + k - 1, 1, 26);
    const w = watch();
    run(r, P, () => NONE, 6, w);
    const d = r.debrief('p')!;
    expect(w.events.filter((e) => e.type === 'deslot')).toHaveLength(1);
    expect(d.deslots).toBe(1);
    near(d.offS, w.off, 1);
    expect(d.offS).toBeGreaterThanOrEqual(1.7 - STEP);
  });

  it('a rear-end offence is charged to the car behind; the car hit counts it as hit by others, not as its own', () => {
    const r = fresh(); park(r);
    const A = r.cars[2], B = r.cars[3];
    place(A, 40, 1, 10); place(B, 40 - T.CAR_LEN + 0.1, 1, 16);
    r.update(1 / 60, {});
    expect(r.debrief(B.id)).toMatchObject({ offences: 1, hitBy: 0, stopGos: 0 });
    expect(r.debrief(A.id)).toMatchObject({ offences: 0, hitBy: 1 });
  });
});

describe('frozen at the driver\'s own terminal result', () => {
  it('retired part-way through a pit visit: the visit is closed at that moment, marked open, and nothing is added afterwards', () => {
    const r = solo(), P = r.cars[0];
    place(P, LAP * T.L + T.PIT_IN0 - 60, -1, 14); P.fuel = 0.6;
    r.requestPit('p');
    const w = watch();
    run(r, P, pulse, 20, w, () => P.mode === 'service' && P.serviceT > 1);
    expect(P.mode).toBe('service');
    const t0 = r.raceTime;
    r.retire('p');
    r.update(STEP, {});
    const d = r.debrief('p')!;
    run(r, P, pulse, 10, watch());
    expect(r.debrief('p')).toEqual(d);
    expect(d.open).toBe('pit');
    near(d.pit.s, t0 - w.pitIn[0], 2);
    expect(takeaway(d, { status: 'dnf', dqReason: null, dnfReason: 'retired', timePen: 0 }, null)).toEqual({ id: 'deb.tk.dnf', vars: { n: 0 } });
  });

  it('after the flag: the cool-down lap, the AI run-on and a later de-slot add nothing; a DQ keeps its metrics too', () => {
    const r = solo(), P = r.cars[0];
    const w = watch();
    P.crossed = r.targetLaps; P.lapsDone = r.targetLaps - 1; P.sectors = 7;
    place(P, T.FINISH_S + r.targetLaps * T.L - 0.3, -1, 10);
    run(r, P, () => UP, 0.1, w);
    expect(P.status).toBe('finished');
    const d = r.debrief('p')!;
    P.mode = 'race'; P.v = 30;
    r.deslot(P);
    run(r, P, () => UP, 30, watch());
    expect(r.debrief('p')).toEqual(d);
    expect(d.deslots).toBe(0);

    const q = solo(), Q = q.cars[0];
    Q.crossed = q.targetLaps; Q.lapsDone = q.targetLaps - 1; Q.sectors = 7; Q.sgOwed = PEN.stopSeconds; Q.sgDue = 99;
    place(Q, T.FINISH_S + q.targetLaps * T.L - 0.3, -1, 10);
    run(q, Q, () => UP, 0.1, watch());
    expect(Q.status).toBe('dq');
    expect(takeaway(q.debrief('p'), { status: 'dq', dqReason: Q.dqReason, dnfReason: null, timePen: 0 }, null)).toEqual({ id: 'deb.tk.dq.stopGo' });
  });

  it('a new race (rematch) starts from zero; nothing is collected before the green light', () => {
    const r = new Race({ roster: [{ id: 'p', control: 'human', slot: 0 }], seed: 1, track: 'circuit-1' });
    for (let i = 0; i < 120 && r.phase === 'countdown'; i++) r.update(STEP, {});
    expect(r.phase).toBe('countdown');
    expect(r.debrief('p')).toBeNull();
    for (let i = 0; i < 1200 && r.phase === 'countdown'; i++) r.update(STEP, {});
    r.update(STEP, {});
    expect(r.debrief('p')).toMatchObject({ laps: 0, valid: 0, deslots: 0, pit: { visits: 0, s: 0 }, forced: { towS: 0, recS: 0 } });
  });

  it('bounded: a fixed-size summary per driver whatever the race length', () => {
    T.setTrack('circuit-4');
    const sizes: number[] = [];
    for (const length of ['sprint', 'endurance'] as const) {
      const r = new Race({ track: 'circuit-4', seed: 8, length, roster: [0, 1, 2, 3].map((slot) => ({ id: `a${slot}`, control: 'ai' as const, slot })) });
      while (r.phase !== 'done') { r.update(1 / 30, {}); r.events.length = 0; }
      const d = r.debrief('a1')!;
      expect(d.laps).toBeGreaterThan(0);
      sizes.push(JSON.stringify(d).length);
    }
    expect(Math.max(...sizes)).toBeLessThan(600);
  });
});

describe('takeaway: fixed rules, every one backed by a figure on the card', () => {
  const base = (): DriverDebrief => ({ driver: 'p', laps: 13, valid: 10, best: 14, bestLap: 5, mean: 14.3, sd: 0.2, deslots: 0, offS: 0, offences: 0, stopGos: 0, hitBy: 0, served: 0, tows: 0, recoveries: 0, pit: { visits: 1, fuel: 1, s: 9, queueS: 0, serveS: 0, bayS: 4 }, forced: { towS: 0, recS: 0, penS: 0 }, open: null });
  const fin: ResultFacts = { status: 'finished', dqReason: null, dnfReason: null, timePen: 0 };
  it('in order: DQ reason, new PB, tows, de-slots, offences, recoveries, DNF, too few laps, time penalty, clean', () => {
    const pb = comparePb(14240, 14);
    expect(takeaway({ ...base(), deslots: 2 }, { ...fin, status: 'dq', dqReason: 'fuel' }, pb)).toEqual({ id: 'deb.tk.dq.fuel' });
    expect(takeaway({ ...base(), deslots: 2 }, fin, pb)).toEqual({ id: 'deb.tk.pb', vars: { d: '0.240' } });
    expect(takeaway({ ...base(), deslots: 2, tows: 1 }, fin, null)).toEqual({ id: 'deb.tk.tow', vars: { n: 1 } });
    expect(takeaway({ ...base(), deslots: 2, offences: 1 }, fin, null)).toEqual({ id: 'deb.tk.deslots', vars: { n: 2 } });
    expect(takeaway({ ...base(), offences: 3, stopGos: 1 }, fin, null)).toEqual({ id: 'deb.tk.offences', vars: { n: 3 } });
    expect(takeaway({ ...base(), recoveries: 2 }, fin, null)).toEqual({ id: 'deb.tk.stall', vars: { n: 2 } });
    expect(takeaway(base(), { ...fin, status: 'dnf', dnfReason: 'window' }, null)).toEqual({ id: 'deb.tk.dnf', vars: { n: 13 } });
    expect(takeaway({ ...base(), valid: 1, sd: null }, fin, null)).toEqual({ id: 'deb.tk.fewLaps', vars: { n: 1 } });
    expect(takeaway(base(), { ...fin, timePen: 5 }, null)).toEqual({ id: 'deb.tk.timePen', vars: { n: 5 } });
    expect(takeaway(base(), fin, comparePb(13900, 14))).toEqual({ id: 'deb.tk.clean' });
  });
  it('no summary (an older result): no takeaway at all, never an inferred clean race', () => {
    expect(takeaway(null, fin, null)).toBeNull();
  });
});

describe('personal best comparison', () => {
  it('against the value from before the race; nothing without a baseline or a valid lap', () => {
    expect(comparePb(14240, 14.0)).toEqual({ before: 14240, best: 14000, delta: -0.24, improved: true });
    expect(comparePb(14000, 14.0)).toMatchObject({ delta: 0, improved: false });
    expect(comparePb(13900, 14.0)).toMatchObject({ improved: false });
    expect(comparePb(13900, 14.0)!.delta).toBeCloseTo(0.1, 9);
    expect(comparePb(null, 14)).toBeNull();
    expect(comparePb(14000, null)).toBeNull();
    expect(comparePb(14000, 0)).toBeNull();
  });
  it('local baseline: this driver\'s own fastest row on that setup\'s race board, read before the race adds a lap', () => {
    vi.stubGlobal('localStorage', memStorage());
    expect(R.personalBest('race', 'circuit-1', 'balanced', 'JD')).toBeNull();
    R.submitLap('race', 'circuit-1', 'JD', 'sunburst', 14321, 'balanced');
    R.submitLap('race', 'circuit-1', 'XY', 'sunburst', 13000, 'balanced');
    R.submitLap('race', 'circuit-1', 'JD', 'sunburst', 14500, 'balanced');
    R.submitLap('race', 'circuit-1', 'JD', 'sunburst', 12000, 'grip');
    R.submitLap('practice', 'circuit-1', 'JD', 'sunburst', 11000, 'balanced');
    expect(R.personalBest('race', 'circuit-1', 'balanced', 'JD')).toBe(14321);
    expect(R.personalBest('race', 'circuit-1', 'grip', 'JD')).toBe(12000);
    expect(R.personalBest('race', 'circuit-1', 'speed', 'JD')).toBeNull();
    expect(R.personalBest('race', 'circuit-2', 'balanced', 'JD')).toBeNull();
  });
});

describe('reading a received summary', () => {
  const d: DriverDebrief = { driver: 'h1', laps: 5, valid: 3, best: 14.1, bestLap: 4, mean: 14.3, sd: 0.15, deslots: 1, offS: 1.8, offences: 0, stopGos: 0, hitBy: 1, served: 0, tows: 0, recoveries: 0, pit: { visits: 0, fuel: 0, s: 0, queueS: 0, serveS: 0, bayS: 0 }, forced: { towS: 0, recS: 0, penS: 0 }, open: null };
  it('a current envelope\'s summary for that driver', () => {
    expect(readDebrief({ debrief: { v: DEBRIEF_VERSION, drivers: [d] } }, 'h1')).toEqual(d);
  });
  it('missing (an older server), another model version, another driver or malformed: unavailable, never zeros', () => {
    expect(readDebrief({}, 'h1')).toBeNull();
    expect(readDebrief({ debrief: null }, 'h1')).toBeNull();
    expect(readDebrief({ debrief: { v: 2, drivers: [d] } }, 'h1')).toBeNull();
    expect(readDebrief({ debrief: { v: 1, drivers: [d] } }, 'h2')).toBeNull();
    expect(readDebrief({ debrief: { v: 1, drivers: [{ ...d, laps: -1 }] } }, 'h1')).toBeNull();
    expect(readDebrief({ debrief: { v: 1, drivers: [{ ...d, best: 'fast' }] } }, 'h1')).toBeNull();
    expect(readDebrief({ debrief: { v: 1, drivers: [{ ...d, pit: undefined }] } }, 'h1')).toBeNull();
    expect(readDebrief({ debrief: { v: 1, drivers: [{ ...d, open: 'lunch' }] } }, 'h1')).toBeNull();
  });
});
