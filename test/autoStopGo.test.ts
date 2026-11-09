// Automatic stop-and-go for the player: takeover on the approach, entry at the pit limit, the shared queue, the box stop
// and hold, the exit handover, and how deferral, overrides, late approaches, fuel visits, Brake, pauses and frame rate
// interact with it. See docs/auto-stop-go.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { AUTO, BRAKE as BRAKE_DECEL, COAST, DRAG, VMAX, Car, Input, LAPS, PEN, Race, SgPhase } from '../src/race';
import { DrivingInput } from '../src/input';
import type { RaceEvent } from '../src/race';
import { DT, NONE, UP, fresh, msgs, place, seedRandom } from './helpers';

beforeEach(() => seedRandom(19));
afterEach(() => vi.restoreAllMocks());

const BRAKE: Input = { up: false, down: true };
const LAP = 3;
const ids = T.TRACKS.map((d) => d.id);

/** `n` cars on `track`, car 0 the player, the rest AI. Every car is on lap LAP. A spare rival is kept for awarding offences. */
function setup(track = 'circuit-1', n = 1): { r: Race; P: Car; rival: Car } {
  const r = fresh(track);
  const rival = r.cars[r.cars.length - 1];
  r.cars.splice(n);
  r.cars[0].isPlayer = true;
  for (const c of r.cars) { c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; }
  return { r, P: r.cars[0], rival };
}
/** On the road `before` metres short of lap `lap`'s pit entrance. */
function approach(r: Race, c: Car, before: number, side = -1, v = 15, lap = LAP): void {
  place(c, lap * T.L + T.PIT_IN0 - before, side, v);
  c.crossed = lap; c.lapsDone = lap - 1; c.revMark = null;
  r.squeezeQ.length = 0;
}
function inPit(c: Car, s: number, v = 0, lap = LAP): void {
  place(c, lap * T.L + s, -1, v);
  c.mode = 'pitlane'; c.d = T.pitD(s); c.crossed = s >= T.FINISH_S ? lap + 1 : lap; c.lapsDone = c.crossed - 1;
}
/** A third offence: a stop-and-go of PEN.stopSeconds, due on the first entrance the car can still make. */
function award(r: Race, P: Car, rival: Car, secs = PEN.stopSeconds): void {
  P.offences = 2;
  for (let k = 0; k < secs / PEN.stopSeconds; k++) r.offence(P, rival, 'rear');
  r.events.length = 0;
}
/** An AI car owing a stop with a deadline well away. */
function owes(c: Car, secs = PEN.stopSeconds): void { c.sgOwed = secs; c.sgDue = LAPS; c.pitReq = true; }

/**
 * A driver that never brakes: before the takeover it uses Throttle only (below the player's cornering profile), and once
 * automatic control has the car it gives `held` (Throttle held, nothing, Brake held...).
 */
function driver(held: Input): (r: Race) => Input {
  return (r) => {
    const P = r.player;
    if (P.sgCtl || P.sgLeave) return held;
    const prof = r.profiles['-1'];
    return { up: P.v < prof[Math.floor(r.s(P) / T.PROFILE_STEP) % prof.length] * 0.97, down: false };
  };
}

interface Trace {
  events: RaceEvent[]; msgs: string[]; phases: SgPhase[];
  brakeAfterTakeover: boolean; minV: number; maxDecel: number; maxJump: number;
  vIn: number; handoverS: number; fuelUp: boolean; overlaps: number; offences: number; held: number;
}
/** Step frames of `dt` until `stop`, or `sec` of simulation time, recording what the acceptance checks need. */
function run(r: Race, input: Input | ((r: Race) => Input), sec: number, stop?: (r: Race) => boolean, dt = DT): Trace {
  const P = r.player;
  const tr: Trace = { events: [], msgs: [], phases: [], brakeAfterTakeover: false, minV: 0, maxDecel: 0, maxJump: 0, vIn: -1, handoverS: -1, fuelUp: false, overlaps: 0, offences: 0, held: 0 };
  let took = false;
  for (let t = 0; t < sec; t += dt) {
    const inp = typeof input === 'function' ? input(r) : input;
    if (P.sgCtl) took = true;
    if (took && inp.down) tr.brakeAfterTakeover = true;
    const m = P.mode, v = P.v, u = P.u, f = P.fuel, ctl = P.sgCtl || P.sgLeave;
    r.update(dt, inp);
    for (const e of r.events) { tr.events.push(e); if (e.type === 'offence') tr.offences++; }
    tr.msgs.push(...msgs(r.events));
    r.events.length = 0;
    if (P.sgPhase !== tr.phases[tr.phases.length - 1]) tr.phases.push(P.sgPhase);
    tr.minV = Math.min(tr.minV, P.v);
    if (ctl) tr.maxDecel = Math.max(tr.maxDecel, (v - P.v) / dt);
    if (P.mode === 'race' || P.mode === 'pitlane') tr.maxJump = Math.max(tr.maxJump, Math.abs(P.u - u) - Math.max(Math.abs(v), Math.abs(P.v)) * dt * 1.5);
    if (m === 'race' && P.mode === 'pitlane') tr.vIn = P.v;
    if (m === 'pitlane' && P.mode === 'race') tr.handoverS = r.s(P);
    if (P.fuel > f + 1e-9) tr.fuelUp = true;
    if (P.pitHold) tr.held += dt;
    tr.overlaps += overlaps(r);
    if (stop?.(r)) break;
  }
  return tr;
}
function overlaps(r: Race): number {
  let n = 0;
  const on = r.cars.filter((c) => c.mode === 'pitlane' || c.mode === 'race');
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    const a = on[i], b = on[j];
    if (Math.abs(a.d - b.d) < T.CAR_W && Math.abs(T.gapS(r.s(a), r.s(b))) < T.CAR_LEN - 0.02) n++;
  }
  return n;
}
const doneAndOut = (r: Race) => r.player.sgOwed === 0 && r.player.mode === 'race';
const served = (tr: Trace) => tr.events.filter((e): e is Extract<RaceEvent, { type: 'served' }> => e.type === 'served').map((e) => e.car.idx);
const grantsFor = (r: Race, c: Car, zone: string) => r.pit.log.filter((e) => e.car === c.idx && e.zone.startsWith(zone) && e.op === 'grant').length;
/** Every grant is followed by exactly one release, and nothing is still held. */
function paired(r: Race): void {
  const open = new Map<string, boolean>();
  for (const e of r.pit.log) {
    const k = `${e.car}:${e.zone}`;
    if (e.op === 'grant') { expect(open.get(k), `double grant ${k}`).not.toBe(true); open.set(k, true); }
    else { expect(open.get(k), `release without grant ${k}`).toBe(true); open.set(k, false); }
  }
}
/** Seconds the player stood still in the box holding its reservation before `served`. */
function stationaryInBox(r: Race, input: Input, sec: number): { still: number; servedAt: number } {
  const P = r.player;
  let still = 0, servedAt = -1;
  for (let t = 0; t < sec && servedAt < 0; t += DT) {
    const owed = P.sgOwed;
    r.update(DT, input);
    if (r.events.some((e) => e.type === 'served')) servedAt = t;
    r.events.length = 0;
    if (owed > 0 && r.pit.box === P.idx && Math.abs(P.v) < 0.02 && Math.abs(T.gapS(r.s(P), T.PEN_S)) < T.PEN_HALF) still += DT;
  }
  return { still, servedAt };
}

describe('every circuit, both lanes, no manual Brake', () => {
  for (const id of ids) for (const side of [-1, 1]) for (const held of [UP, NONE]) {
    it(`${id}, ${side < 0 ? 'outside' : 'inside'} lane, ${held.up ? 'Throttle held' : 'no pedal'} after the takeover`, () => {
      const { r, P, rival } = setup(id);
      approach(r, P, 120, side, 15);
      award(r, P, rival);
      expect(P.sgDue).toBe(LAP);
      const fuel0 = P.fuel, stops0 = P.pitStops;
      const tr = run(r, driver(held), 40, doneAndOut);
      expect(P.sgOwed).toBe(0);
      expect(P.mode).toBe('race');
      expect(tr.brakeAfterTakeover).toBe(false);
      expect(tr.phases.filter(Boolean)).toEqual(['armed', 'entry', 'serving', 'leaving']);
      // the pit limit is observed from the entrance, the car never goes backwards, jumps, or brakes beyond a normal full brake
      expect(tr.vIn).toBeGreaterThan(0); expect(tr.vIn).toBeLessThanOrEqual(T.PIT_SPEED + 0.05);
      expect(tr.minV).toBe(0);
      expect(tr.maxJump).toBeLessThan(1e-6);
      expect(tr.maxDecel).toBeLessThanOrEqual(BRAKE_DECEL + COAST + DRAG * VMAX * VMAX + 0.5);   // a normal full brake, never the 45 m/s² limiter
      // handed over just past the pit-exit merge, back in the outside lane
      expect(tr.handoverS).toBeGreaterThanOrEqual(T.PIT_OUT1); expect(tr.handoverS).toBeLessThan(T.PIT_OUT1 + 0.2);
      expect(P.laneSide).toBe(-1); expect(P.sgCtl).toBe(false); expect(P.sgPhase).toBe(null);
      expect(tr.msgs).toContain('msg.sgHandover');
      // a penalty-only visit: no bay, no fuel, no extra stop counted, and the lap is counted once at the line
      expect(grantsFor(r, P, 'bay')).toBe(0);
      expect(tr.fuelUp).toBe(false); expect(P.fuel).toBeLessThanOrEqual(fuel0);
      expect(P.pitStops).toBe(stops0);
      expect(P.crossed).toBe(LAP + 1);
      expect(P.sgDeferred).toBe(false); expect(P.svcBreach).toBe(null);
      paired(r);
    });
  }
});

describe('the box', () => {
  it('stops accurately in a clear box and holds still for the whole stop, for several stop durations', () => {
    for (const secs of [3, 6, 9]) {
      const { r, P, rival } = setup();
      approach(r, P, 30, -1, 14);
      award(r, P, rival, secs);
      expect(P.sgOwed).toBe(secs);
      run(r, UP, 20, () => P.sgServing);
      expect(Math.abs(T.gapS(r.s(P), T.PEN_S))).toBeLessThan(AUTO.stopTol + 0.05);
      const { still, servedAt } = stationaryInBox(r, UP, secs + 2);
      expect(servedAt).toBeGreaterThan(0);
      expect(still).toBeGreaterThanOrEqual(secs - 2 * DT);
      expect(still).toBeLessThanOrEqual(secs + 2 * DT);
    }
  });

  it('accumulated stop time is served in full, and more time awarded on the approach adds to it', () => {
    const { r, P, rival } = setup();
    approach(r, P, 60, -1, 14);
    award(r, P, rival);
    run(r, driver(UP), 10, () => P.sgCtl);
    r.offence(P, rival, 'rear');                 // a fourth offence before the box: 3 s more, same deadline
    expect([P.sgOwed, P.sgDue]).toEqual([2 * PEN.stopSeconds, LAP]);
    run(r, UP, 20, () => P.sgServing);
    const { still } = stationaryInBox(r, UP, 10);
    expect(still).toBeGreaterThanOrEqual(2 * PEN.stopSeconds - 2 * DT);
    expect(P.sgOwed).toBe(0);
  });

  it('rolling backwards in the box is not stationary: it is braked to rest first, then the stop counts', () => {
    const { r, P } = setup();
    inPit(P, T.PEN_S + 0.6, -1.5); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP;
    r.update(DT, NONE); r.events.length = 0;
    expect(P.sgCtl).toBe(true);
    expect(P.sgServed).toBe(0);
    let countedRolling = false;
    for (let i = 0; i < 30; i++) { r.update(DT / 4, NONE); if (P.v < -0.02 && P.sgServed > 0) countedRolling = true; }
    expect(countedRolling).toBe(false);
    expect(P.v).toBe(0);
    expect(Math.abs(T.gapS(r.s(P), T.PEN_S))).toBeLessThan(T.PEN_HALF);
    const { servedAt } = stationaryInBox(r, NONE, 5);
    expect(servedAt).toBeGreaterThan(0);
  });

  it('Throttle and Brake during the stop change nothing: no early movement, reset or early clearance', () => {
    const { r, P } = setup();
    inPit(P, T.PEN_S); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP;
    const u = P.u;
    const tr = run(r, (rr) => ({ up: Math.floor(rr.t * 4) % 2 === 0, down: Math.floor(rr.t * 3) % 2 === 0 }), PEN.stopSeconds - 0.3);
    expect(P.u).toBe(u); expect(P.sgOwed).toBe(PEN.stopSeconds);
    expect(tr.msgs).not.toContain('msg.penReset');
    expect(P.revOn).toBe(false);
  });

  it('occupied: the player queues short of the box behind a serving car, moves up when it leaves, and serves', () => {
    const { r, P, rival } = setup('circuit-1', 2);
    const A = r.cars[1];
    inPit(A, T.PEN_S); owes(A, 2 * PEN.stopSeconds);
    approach(r, P, 30, -1, 14);
    award(r, P, rival);
    const tr = run(r, UP, 40, doneAndOut);
    expect(served(tr)).toEqual([A.idx, P.idx]);
    expect(tr.phases).toContain('queued');
    expect(tr.held).toBeGreaterThan(1);
    expect(tr.overlaps).toBe(0); expect(tr.offences).toBe(0);
    expect(tr.brakeAfterTakeover).toBe(false);
    paired(r);
  });

  for (const n of [2, 4]) {
    it(`a ${n}-car queue for the box is served in order, the player last, on Throttle alone`, () => {
      const { r, P, rival } = setup('circuit-1', n);
      const ai = r.cars.slice(1);
      inPit(ai[0], T.PEN_S); owes(ai[0]);
      ai.slice(1).forEach((c, i) => { approach(r, c, 4 + i * 4, -1, 6); owes(c); });
      approach(r, P, 14 + n * 4, -1, 10);
      award(r, P, rival);
      const tr = run(r, UP, 60, doneAndOut);
      expect(served(tr)).toEqual([...ai.map((c) => c.idx), P.idx]);
      expect(tr.phases).toContain('queued');
      expect(tr.overlaps).toBe(0); expect(tr.offences).toBe(0);
      expect(P.mode).toBe('race');
      // and the same at a very different frame rate
      const again = setup('circuit-1', n);
      const ai2 = again.r.cars.slice(1);
      inPit(ai2[0], T.PEN_S); owes(ai2[0]);
      ai2.slice(1).forEach((c, i) => { approach(again.r, c, 4 + i * 4, -1, 6); owes(c); });
      approach(again.r, again.P, 14 + n * 4, -1, 10);
      award(again.r, again.P, again.rival);
      const tr2 = run(again.r, UP, 60, doneAndOut, 1 / 24);
      expect(served(tr2)).toEqual(served(tr));
      expect(tr2.overlaps).toBe(0);
    });
  }
});

describe('the approach', () => {
  it('a late award too fast to brake for is not entered, never stopped instantly, and is due at the next entrance', () => {
    const { r, P, rival } = setup();
    approach(r, P, 6.5, -1, 24);
    award(r, P, rival);
    expect(P.sgDue).toBe(LAP + 1);              // the policy decides: this entrance was out of reach
    const tr = run(r, UP, 2, () => r.s(P) > T.PIT_IN0 + 3 && r.s(P) < 50);
    expect(P.mode).toBe('race');
    expect(tr.msgs).toContain('msg.sgTooLate');
    expect(tr.maxDecel).toBe(0);
    expect(P.sgDeferred).toBe(false);
    // the next lap's entrance is taken over and served normally
    approach(r, P, 80, -1, 15, LAP + 1);
    const tr2 = run(r, driver(UP), 40, doneAndOut);
    expect(P.sgOwed).toBe(0); expect(tr2.vIn).toBeLessThanOrEqual(T.PIT_SPEED + 0.05);
  });

  it('a fast approach that can still be braked for is taken over and served', () => {
    const { r, P, rival } = setup();
    approach(r, P, 30, -1, 26);
    award(r, P, rival);
    expect(P.sgDue).toBe(LAP);
    run(r, UP, 0.2);
    expect(P.sgCtl).toBe(true);                 // 30 m at 26 m/s can be braked for: taken over
    run(r, UP, 20, doneAndOut);
    expect(P.sgOwed).toBe(0);
  });

  it('a blocked last switch misses the entrance on the inside lane, with no snap, and the debt policy applies', () => {
    const { r, P, rival } = setup('circuit-1', 2);
    const B = r.cars[1];
    const sw = T.SWITCHES.reduce((a, b) => (T.ahead(b.s0, T.PIT_IN0) < T.ahead(a.s0, T.PIT_IN0) ? b : a));
    const before = T.ahead(sw.s0, T.PIT_IN0);
    approach(r, P, before + 8, 1, 12);
    // a car standing in the outside lane right at the switch: the move outside is never clear
    approach(r, B, before - 1, -1, 0);
    r.ai = (c) => (c === B ? { t: 0, b: 1 } : { t: 0, b: 0 });
    award(r, P, rival);
    let maxDJump = 0, d = P.d;
    const tr = run(r, driver(UP), 6, () => { maxDJump = Math.max(maxDJump, Math.abs(P.d - d)); d = P.d; return r.s(P) > T.PIT_IN0 + 2 && r.s(P) < 40; });
    expect(tr.msgs).toContain('msg.routeBlocked');
    expect(P.mode).toBe('race'); expect(P.laneSide).toBe(1);
    expect(maxDJump).toBeLessThan(0.05);
    expect(P.sgCtl).toBe(false);
    expect(tr.offences).toBe(0);
    // the lap ends with the stop unserved: its one deferral is used automatically
    const tr2 = run(r, driver(UP), 4, () => P.crossed === LAP + 1);
    expect([P.sgDue, P.sgDeferred, P.svcBreach]).toEqual([LAP + 1, true, null]);
    expect(tr2.msgs).toContain('msg.sgLastLap');
  });

  it('ordinary controls before the approach: Brake and Throttle work, and nothing is taken over', () => {
    const { r, P, rival } = setup();
    approach(r, P, 90, -1, 15);
    award(r, P, rival);
    run(r, BRAKE, 0.5);
    expect(P.sgCtl).toBe(false); expect(P.sgPhase).toBe('armed');
    expect(P.v).toBeLessThan(5);
  });
});

describe('deferral and overrides', () => {
  it('a valid deferral before the takeover releases the approach, and the stop is served automatically next lap', () => {
    const { r, P, rival } = setup();
    approach(r, P, 80, -1, 15);
    award(r, P, rival);
    r.requestDefer();
    expect([P.sgDue, P.sgDeferred]).toEqual([LAP + 1, true]);
    const tr = run(r, driver(UP), 6, () => r.s(P) > T.PIT_IN0 + 3 && r.s(P) < 40);
    expect(tr.phases).toContain('deferred');
    expect(tr.phases).not.toContain('entry');
    expect(P.mode).toBe('race');
    approach(r, P, 80, -1, 15, LAP + 1);
    const tr2 = run(r, driver(UP), 40, doneAndOut);
    expect(P.sgOwed).toBe(0); expect(tr2.phases).toContain('serving');
  });

  it('Defer during the automatic entry hands control straight back and keeps the debt', () => {
    const { r, P, rival } = setup();
    approach(r, P, 35, -1, 12);
    award(r, P, rival);
    run(r, UP, 0.1);
    expect(P.sgCtl).toBe(true);
    r.requestDefer();
    run(r, UP, 0.05);
    expect(P.sgCtl).toBe(false); expect(P.sgPhase).toBe('deferred');
    expect([P.sgOwed, P.sgDue, P.sgDeferred]).toEqual([PEN.stopSeconds, LAP + 1, true]);
    expect(r.pit.held(P)).toEqual([]);
  });

  it('repeated lane overrides skip the stop twice: the first uses the deferral, the second disqualifies at the flag', () => {
    const { r, P, rival } = setup('circuit-2');
    const L1 = LAPS - 1;
    // circuit-2's last switch is inside the takeover window, so the override is used while the controller has the car
    approach(r, P, 39, -1, 12, L1);
    award(r, P, rival);
    expect(P.sgDue).toBe(L1);
    run(r, UP, 0.1);
    expect(P.sgCtl).toBe(true);
    r.requestLane();
    expect(P.laneOverride).toBe(true);
    const a = run(r, driver(UP), 12, () => P.crossed === L1 + 1);
    expect(a.msgs).toContain('msg.laneGo');
    expect(P.mode).toBe('race');
    expect([P.sgDue, P.sgDeferred, P.svcBreach]).toEqual([LAPS, true, null]);
    expect(a.msgs).toContain('msg.sgLastLapFinal');
    // the final lap: no deferral is offered, and the override is still the driver's choice
    expect(r.deferBlock(P)).not.toBe(null);
    P.change = null; approach(r, P, 39, -1, 12, LAPS); P.crossed = LAPS; P.lapsDone = LAPS - 1;
    run(r, UP, 0.1);
    expect(P.sgCtl).toBe(true);
    r.requestLane();
    const b = run(r, driver(UP), 12, () => P.finished);
    expect(b.events.some((e) => e.type === 'breach')).toBe(true);
    expect(P.status).toBe('dq'); expect(P.dqReason).toBe('stopGo');
  });

  it('on the final lap the default is still to queue and serve: classified, not disqualified', () => {
    const { r, P, rival } = setup('circuit-1', 2);
    const A = r.cars[1];
    inPit(A, T.PEN_S, 0, LAPS); owes(A); A.crossed = LAPS; A.lapsDone = LAPS - 1;
    approach(r, P, 30, -1, 14, LAPS);
    award(r, P, rival);
    expect(r.deferBlock(P)).toBe('final');
    const tr = run(r, UP, 40, () => P.finished);
    expect(served(tr)).toEqual([A.idx, P.idx]);
    expect(tr.phases).toContain('queued');
    expect(P.status).toBe('finished');
  });
});

describe('out of fuel in the pit lane', () => {
  it('running dry after a penalty-only stop hands back control, so the car is captured by the bay it stops beside and refuelled', () => {
    const { r, P } = setup();
    inPit(P, T.PEN_S); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP; P.fuel = 0.0015;
    const tr = run(r, UP, 10, () => P.mode === 'service');
    expect(served(tr)).toEqual([P.idx]);
    expect(tr.msgs).toContain('msg.sgDry');
    expect([P.sgCtl, P.sgLeave]).toEqual([false, false]);
    expect(P.mode).toBe('service');
    expect(T.BAYS[P.bay]).toBe(15.5);
    run(r, NONE, 2);
    expect(P.fuel).toBeGreaterThan(0.0015);
    expect(P.towSvc).toBe(false);
  });

  it('standing in the box with no fuel, the stop is served in full before the tow takes the car to a bay', () => {
    const { r, P } = setup();
    inPit(P, T.PEN_S); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP; P.fuel = 0;
    const tr = run(r, NONE, 10, () => P.mode === 'service');
    const iServed = tr.events.findIndex((e) => e.type === 'served');
    const iTow = tr.events.findIndex((e) => e.type === 'tow');
    expect(iServed).toBeGreaterThanOrEqual(0);
    expect(iTow).toBeGreaterThan(iServed);
    expect(P.sgOwed).toBe(0);
    expect([P.mode, P.towSvc]).toEqual(['service', true]);
    expect(P.crossed).toBe(LAP);
  });

  it('running dry on the entry short of the box is towed rather than stuck, and the stop stays owed', () => {
    const { r, P } = setup();
    inPit(P, T.PIT_IN0 + 2); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP; P.fuel = 0;
    const tr = run(r, UP, 6, () => P.mode === 'service');
    expect(tr.events.some((e) => e.type === 'tow')).toBe(true);
    expect([P.mode, P.towSvc]).toEqual(['service', true]);
    expect(P.sgOwed).toBe(PEN.stopSeconds);
    expect(P.crossed).toBe(LAP);
  });

  it('a tow from beyond the last bay pulls the car back up the pit lane, never round a lap, and the timing line is not counted twice', () => {
    const { r, P } = setup();
    inPit(P, T.FINISH_S + 1.5); P.fuel = 0;
    const crossed = P.crossed, laps = P.lapsDone, u = P.u, hi = P.hiU;
    run(r, NONE, 3, () => P.mode === 'service');
    expect(P.mode).toBe('service');
    expect(T.BAYS[P.bay]).toBe(T.BAYS[T.BAYS.length - 1]);
    expect(P.u).toBeCloseTo(u - (T.FINISH_S + 1.5 - T.BAYS[P.bay]), 6);
    expect(P.hiU).toBe(hi);
    run(r, UP, 20, () => P.mode === 'race');
    expect(P.mode).toBe('race');
    expect([P.crossed, P.lapsDone]).toEqual([crossed, laps]);
  });
});

describe('combined fuel visit', () => {
  it('an optional fuel request survives the penalty: control returns at the box with the bay still reserved', () => {
    const { r, P, rival } = setup();
    approach(r, P, 60, -1, 14);
    P.fuel = 0.5;
    r.requestPit();
    award(r, P, rival);
    const tr = run(r, driver(UP), 30, () => P.sgOwed === 0);
    expect(tr.vIn).toBeLessThanOrEqual(T.PIT_SPEED + 0.05);
    r.update(DT, NONE);
    expect(P.sgCtl).toBe(false); expect(P.sgLeave).toBe(false); expect(P.sgPhase).toBe(null);
    expect(P.mode).toBe('pitlane'); expect(P.pitFuel).toBe(true);
    const bay = r.pit.bayOf(P);
    expect(bay).toBeGreaterThanOrEqual(0);
    // manual from here until the assigned-bay controller lands: creep to the bay and brake there
    run(r, UP, 3, () => T.gapS(r.s(P), T.BAYS[bay]) < 0.6);
    run(r, BRAKE, 3, () => P.mode === 'service');
    expect(P.mode).toBe('service');
    run(r, NONE, 1);
    expect(P.fuel).toBeGreaterThan(0.5);
  });

  it('a committed fuel stop and the stop-and-go clear independently on one visit', () => {
    const { r, P, rival } = setup();
    approach(r, P, 80, -1, 14);
    r.requestPit(); r.requestDefer();
    expect(P.fuelDue).toBe(LAP + 1);
    approach(r, P, 60, -1, 14, LAP + 1);
    award(r, P, rival);
    expect(P.sgDue).toBe(LAP + 1);
    run(r, driver(UP), 30, () => P.sgOwed === 0);
    expect([P.sgOwed, P.fuelDue]).toEqual([0, LAP + 1]);
    r.update(DT, NONE);
    expect(P.sgCtl).toBe(false);
    const bay = r.pit.bayOf(P);
    run(r, UP, 3, () => T.gapS(r.s(P), T.BAYS[bay]) < 0.6);
    run(r, BRAKE, 3, () => P.mode === 'service');
    run(r, NONE, 1);
    expect(P.fuelDue).toBe(0);
  });

  it('a penalty-only visit never captures a bay, even with Brake held while passing one', () => {
    const { r, P, rival } = setup();
    approach(r, P, 30, -1, 14);
    P.fuel = 0.4;
    award(r, P, rival);
    run(r, UP, 20, () => P.sgOwed === 0);
    const tr = run(r, BRAKE, 10, doneAndOut);
    expect(P.mode).toBe('race');
    expect(grantsFor(r, P, 'bay')).toBe(0);
    expect(tr.fuelUp).toBe(false);
  });
});

describe('Brake, reverse, pause and frames', () => {
  it('Brake held through entry, the queue and the box never reverses at the handover; a fresh press can', () => {
    const { r, P, rival } = setup('circuit-1', 2);
    const A = r.cars[1];
    inPit(A, T.PEN_S); owes(A);
    approach(r, P, 30, -1, 14);
    award(r, P, rival);
    run(r, UP, 0.1);
    expect(P.sgCtl).toBe(true);
    const tr = run(r, BRAKE, 40, doneAndOut);
    expect(P.sgOwed).toBe(0); expect(P.mode).toBe('race');
    expect(tr.phases).toContain('queued');
    expect(tr.minV).toBe(0);
    const after = run(r, BRAKE, 3);
    expect(after.minV).toBe(0); expect(P.revOn).toBe(false); expect(P.v).toBe(0);
    // release, press again and hold: ordinary reverse under the existing rules
    run(r, NONE, DT);
    run(r, BRAKE, 1.5);
    expect(P.revOn).toBe(true); expect(P.v).toBeLessThan(0);
  });

  it('pause (or tab return) mid-queue clears inputs and reverse, keeps the debt, and duplicates no reservation', () => {
    const { r, P, rival } = setup('circuit-1', 2);
    const A = r.cars[1];
    inPit(A, T.PEN_S); owes(A, 2 * PEN.stopSeconds);
    approach(r, P, 30, -1, 14);
    award(r, P, rival);
    run(r, BRAKE, 20, () => P.pitHold && P.v === 0);
    expect(P.sgPhase).toBe('queued');
    const before = { owed: P.sgOwed, due: P.sgDue, box: r.pit.box, log: r.pit.log.length };
    // what main.ts does on pause, blur or a hidden tab: inputs released, reverse forgotten, no simulation while away
    const input = new DrivingInput({ lane() {}, pit() {}, defer() {}, view() {}, pause() {} });
    input.press('key:KeyS', 'brake'); input.press('pointer:3', 'brake');
    input.clear(); r.clearReverse();
    expect(input.held('brake')).toBe(false);
    expect({ owed: P.sgOwed, due: P.sgDue, box: r.pit.box, log: r.pit.log.length }).toEqual(before);
    // resumed with nothing pressed: it still completes on its own
    const tr = run(r, NONE, 40, doneAndOut);
    expect(served(tr)).toEqual([A.idx, P.idx]);
    paired(r);
    // a restart is a new race: nothing owed, nothing reserved
    const fresh2 = new Race();
    expect(fresh2.player.sgOwed).toBe(0); expect(fresh2.pit.box).toBe(-1); expect(fresh2.player.sgCommit).toBe(-1);
  });

  it('slow render frames give the same stop, the same stop time and the same handover', () => {
    const results = [1 / 144, 1 / 60, 1 / 20, 1 / 8].map((dt) => {
      const { r, P, rival } = setup();
      approach(r, P, 30, -1, 14);
      award(r, P, rival);
      let stopS = -1;
      const tr = run(r, UP, 30, (rr) => { if (P.sgServing && stopS < 0) stopS = rr.s(P); return doneAndOut(rr); }, dt);
      return { stopS, served: P.sgOwed === 0, vIn: tr.vIn, handover: tr.handoverS, t: r.t };
    });
    for (const x of results) {
      expect(x.served).toBe(true);
      expect(Math.abs(x.stopS - results[0].stopS)).toBeLessThan(0.02);
      expect(x.vIn).toBeLessThanOrEqual(T.PIT_SPEED + 0.05);
      expect(x.handover).toBeLessThan(T.PIT_OUT1 + 1.1);
      expect(Math.abs(x.t - results[0].t)).toBeLessThan(0.15);   // frame-size rounding only
    }
  });

  it('duplicate and refused controls during automatic service change no debt', () => {
    const { r, P, rival } = setup();
    approach(r, P, 30, -1, 14);
    award(r, P, rival);
    run(r, UP, 20, () => P.mode === 'pitlane');
    const snap = () => [P.sgOwed, P.sgDue, P.sgDeferred, P.fuelReq, P.fuelDue, P.svcBreach, r.pit.box];
    const s0 = snap();
    const ev: string[] = [];
    for (let k = 0; k < 3; k++) { r.requestDefer(); r.requestLane(); r.requestPit(); ev.push(...msgs(r.events)); r.events.length = 0; }
    expect(snap()).toEqual(s0);
    expect(ev).toContain('msg.deferPit'); expect(ev).toContain('msg.pitSingleFile');
    // keyboard and touch holding Throttle together: one letting go keeps it held, neither moves the car in the box
    const input = new DrivingInput({ lane() {}, pit() {}, defer() {}, view() {}, pause() {} });
    input.press('key:KeyW', 'throttle'); input.press('pointer:1', 'throttle'); input.release('key:KeyW');
    expect(input.held('throttle')).toBe(true);
    run(r, { up: input.held('throttle'), down: false }, 20, doneAndOut);
    expect(P.sgOwed).toBe(0);
    expect(r.pit.log.filter((e) => e.car === P.idx && e.zone === 'box' && e.op === 'grant')).toHaveLength(1);
  });

  it('AI cars are never taken over', () => {
    const { r } = setup('circuit-1', 2);
    const A = r.cars[1];
    approach(r, A, 30, -1, 14); owes(A);
    run(r, NONE, 10, () => A.sgOwed === 0);
    expect(A.sgOwed).toBe(0);
    expect(A.sgCtl).toBe(false); expect(A.sgPhase).toBe(null);
  });
});
