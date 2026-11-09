// Shared pit-lane traffic: queue order, stopping gaps, bay and box occupancy, bay departures, the pit exit,
// reservation lifecycles, the player's override and Brake held through automatic holds. See docs/pit-queue.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, Input, LAPS, PEN, Race, SERVICE_READY } from '../src/race';
import { PIT_Q } from '../src/pit';
import type { RaceEvent } from '../src/race';
import { DT, NONE, UP, fresh, msgs, place, seedRandom, all, me } from './helpers';

beforeEach(() => seedRandom(7));
afterEach(() => vi.restoreAllMocks());

const BRAKE: Input = { up: false, down: true };
const LAP = 3;

/** A race with `n` cars (car 0 is the player when `player` is set), all AI-driven otherwise. */
function setup(n: number, player = false): Race {
  const r = fresh();
  r.cars.splice(n);
  if (player) r.cars[0].human = true;
  for (const c of r.cars) { c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; }
  return r;
}
/** On the road, outside lane, `before` metres short of lap LAP's pit entrance. */
function approach(c: Car, before: number, v = 10): void {
  place(c, LAP * T.L + T.PIT_IN0 - before, -1, v);
  c.crossed = LAP; c.lapsDone = LAP - 1;
}
/** In the pit lane at track position s, on lap LAP + 1. */
function inPit(c: Car, s: number, v = 0): void {
  place(c, LAP * T.L + s, -1, v);
  c.mode = 'pitlane'; c.d = T.pitD(s); c.crossed = s >= T.FINISH_S ? LAP + 1 : LAP; c.lapsDone = c.crossed - 1;
}
/** An AI car that owes a stop-and-go (deadline well away). */
function owes(c: Car): void { c.sgOwed = PEN.stopSeconds; c.sgDue = LAPS; c.pitReq = true; }
/** An AI car that wants fuel at its own bay. */
function fuels(c: Car, target = 0.6): void { c.pitPlan = true; c.pitReq = true; c.fuel = 0.4; c.refuelTarget = target; }
/** Standing in bay j, serviced long enough to leave. */
function inBay(r: Race, c: Car, j: number): void {
  inPit(c, T.BAYS[j]); r.enterBay(c, j); c.mode = 'service'; c.d = T.BAY_D; c.bayT = 1; c.serviceT = SERVICE_READY + 0.1;
}

interface Watch { overlaps: number; offences: number; events: RaceEvent[]; held: Map<number, number> }
/** Step for `sec`, checking every step that no two cars on the same path overlap. */
function sim(r: Race, sec: number, input: Input | ((r: Race) => Input) = NONE, w: Watch = watch(), dt = DT, stop?: () => boolean): Watch {
  for (let t = 0; t < sec; t += dt) {
    r.update(dt, all(r, typeof input === 'function' ? input(r) : input));
    for (const e of r.events) { w.events.push(e); if (e.type === 'offence') w.offences++; }
    r.events.length = 0;
    w.overlaps += overlaps(r);
    for (const c of r.cars) if (c.pitHold) w.held.set(c.idx, (w.held.get(c.idx) ?? 0) + dt);
    if (stop?.()) break;
  }
  return w;
}
const watch = (): Watch => ({ overlaps: 0, offences: 0, events: [], held: new Map() });
function overlaps(r: Race): number {
  let n = 0;
  const on = r.cars.filter((c) => c.mode === 'pitlane' || c.mode === 'race');
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    const a = on[i], b = on[j];
    if (Math.abs(a.d - b.d) < T.CAR_W && Math.abs(T.gapS(r.s(a), r.s(b))) < T.CAR_LEN - 0.02) n++;
  }
  return n;
}
/** Grants and releases as (car, zone, op, why), for comparing runs. */
const trail = (r: Race, zone?: string) => r.pit.log.filter((e) => !zone || e.zone.startsWith(zone)).map((e) => `${e.car}:${e.zone}:${e.op}${e.why ? ':' + e.why : ''}`);
/** Every grant is followed by exactly one release, and nothing is still held. */
function paired(r: Race): void {
  const open = new Map<string, boolean>();
  for (const e of r.pit.log) {
    const k = `${e.car}:${e.zone}`;
    if (e.op === 'grant') { expect(open.get(k), `double grant ${k}`).not.toBe(true); open.set(k, true); }
    else { expect(open.get(k), `release without grant ${k}`).toBe(true); open.set(k, false); }
  }
}
const allFree = (r: Race) => r.pit.box === -1 && r.pit.exit === -1 && r.pit.bays.every((h) => h === -1) && r.pit.merges.every((h) => h === -1);
const served = (w: Watch) => w.events.filter((e): e is Extract<RaceEvent, { type: 'served' }> => e.type === 'served').map((e) => e.car.idx);
const byIdx = (r: Race, i: number) => r.cars.find((c) => c.idx === i)!;

describe('queue order', () => {
  /** A serving in the box; B and C, both owing a stop, arrive on the approach 4 m apart. */
  function twoArrive(reversed: boolean, dt: number) {
    const r = setup(4);
    r.cars.splice(0, 1);                       // no player: three AI cars
    const [A, B, C] = r.cars;
    inPit(A, T.PEN_S); owes(A);
    approach(B, 8); owes(B);
    approach(C, 12); owes(C);
    if (reversed) r.cars.reverse();
    const w = sim(r, 24, NONE, watch(), dt, () => C.sgOwed === 0 && C.mode === 'race');
    return { r, w, A, B, C };
  }

  it('two cars arriving together are served in physical order, whatever the array order or frame rate', () => {
    const base = twoArrive(false, DT);
    expect(served(base.w)).toEqual([base.A.idx, base.B.idx, base.C.idx]);
    expect(base.w.overlaps).toBe(0); expect(base.w.offences).toBe(0);
    expect(base.w.held.get(base.B.idx)).toBeGreaterThan(0.5); // B really queued behind A
    paired(base.r); expect(allFree(base.r)).toBe(true);
    const box = trail(base.r, 'box');
    for (const [rev, dt] of [[true, DT], [false, 1 / 30], [true, 1 / 144], [false, 1 / 24]] as const) {
      const v = twoArrive(rev, dt);
      expect(served(v.w)).toEqual(served(base.w));
      expect(trail(v.r, 'box')).toEqual(box);
      expect(v.w.overlaps).toBe(0); expect(v.w.offences).toBe(0);
    }
  });

  it('a tie in progress goes to the lower car number, never to array position', () => {
    for (const rev of [false, true]) {
      const r = setup(3);
      const [, A, B] = r.cars;
      inBay(r, B, 1);                         // B is in bay 1; A stands in the lane level with it
      inPit(A, T.BAYS[1]);
      if (rev) r.cars.reverse();
      r.pit.update();
      expect(r.pit.order.slice(0, 2)).toEqual([A.idx, B.idx]);
    }
  });

  /** A serving at the back of the box; B (stop-and-go), the player (fuel, on Throttle only) and D (stop-and-go) arrive in a train. */
  function fourArrive(rev: boolean, dt: number) {
    const r = setup(4, true);
    const [P, A, B, D] = r.cars;
    inPit(A, T.PEN_S - 0.8); owes(A);
    const ai = r.ai.bind(r);
    r.ai = (c, t) => (c === A && c.sgOwed > 0 ? { t: 0, b: 1 } : ai(c, t));   // A serves where it stands
    approach(B, 6); owes(B);
    approach(P, 9.5); r.requestPit(me(r).id);
    approach(D, 13); owes(D);
    if (rev) r.cars.reverse();
    let spilled = false, skipped = false;
    const w = sim(r, 40, UP, watch(), dt, () => {
      // the tail of the queue waits on the road, short of the entrance, rather than being forced in
      if (D.mode === 'race' && D.pitHold && D.v < 0.05 && T.ahead(r.s(D), T.PIT_IN0) < 2) spilled = true;
      const m = [B, P, D].filter((c) => c.mode === 'pitlane' || r.pit.approaching(c));
      if (m.length === 3 && !(r.pit.progress(B) > r.pit.progress(P) && r.pit.progress(P) > r.pit.progress(D))) skipped = true;
      return D.sgOwed === 0 && D.mode === 'race';
    });
    return { r, w, P, A, B, D, spilled, skipped };
  }

  it('four cars, mixed AI and player: the queue reaches the approach, holds without overlap and drains in order', () => {
    const base = fourArrive(false, DT);
    const { r, w, P, A, B, D } = base;
    expect(base.spilled).toBe(true);
    expect(base.skipped).toBe(false);
    expect(served(w)).toEqual([A.idx, B.idx, D.idx]);
    expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
    expect(w.held.get(P.idx)).toBeGreaterThan(1);       // the player queued on Throttle alone
    expect(P.revOn).toBe(false);
    // the player is stopped at its own bay automatically and is still in it (Throttle held on arrival never departs)
    expect(trail(r, 'bay0')).toEqual([`${P.idx}:bay0:grant`]);
    expect([P.mode, P.bay]).toEqual(['service', P.bayHome]);
    paired(r); expect(r.pit.held(P)).toEqual(['bay0']);
    for (const c of [A, B, D]) expect(r.pit.held(c)).toEqual([]);
    for (const [rev, dt] of [[true, DT], [false, 1 / 30], [true, 1 / 144]] as const) {
      const v = fourArrive(rev, dt);
      expect(v.skipped).toBe(false); expect(v.spilled).toBe(true);
      expect(served(v.w)).toEqual(served(w));
      expect(trail(v.r, 'box')).toEqual(trail(r, 'box'));
      expect(v.w.overlaps).toBe(0); expect(v.w.offences).toBe(0);
      paired(v.r); expect(v.r.pit.held(v.P)).toEqual(['bay0']);
    }
  });
});

describe('stopping gap', () => {
  it('a car brakes for a stopped leader and stops a real gap behind it', () => {
    const r = setup(2);
    const [B, A] = r.cars;
    inPit(A, 16); inPit(B, 9, 8);
    r.ai = (c) => (c === B ? { t: 1, b: 0 } : { t: 0, b: 1 });
    const w = sim(r, 3);
    const gap = T.gapS(r.s(B), r.s(A));
    expect(gap).toBeGreaterThanOrEqual(T.CAR_LEN + PIT_Q.gap - 0.1);
    expect(gap).toBeLessThan(T.CAR_LEN + PIT_Q.gap + 0.6);
    expect(B.v).toBe(0); expect(B.pitWait).toBe('queued');
    expect(w.overlaps).toBe(0);
  });

  it('a slower leader is followed without contact, and a player held behind a reversing car is never hit', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    inPit(A, 14, 3);
    inPit(P, 9, 8);
    r.ai = () => ({ t: 0.25, b: 0 });
    const w = sim(r, 1.5, UP);
    expect(w.overlaps).toBe(0);
    expect(T.gapS(r.s(P), r.s(A))).toBeGreaterThan(T.CAR_LEN);
    // now the car ahead is backing up the pit lane (the player) while an AI car drives at it: the AI car stops short
    const r2 = setup(2, true);
    const [B, Q] = r2.cars;
    inPit(B, 16); B.revOn = true; B.v = -3;
    inPit(Q, 10, 6);
    r2.ai = () => ({ t: 1, b: 0 });
    let minGap = 99, minV = 0, waited = false;
    const w2 = sim(r2, 1.5, BRAKE, watch(), DT, () => {
      minGap = Math.min(minGap, T.gapS(r2.s(Q), r2.s(B))); minV = Math.min(minV, Q.v); if (Q.pitWait === 'queued') waited = true; return false;
    });
    expect(waited).toBe(true);
    expect(minGap).toBeGreaterThan(T.CAR_LEN - 0.02);
    expect(minV).toBe(0);                      // the queued car is never pushed backwards
    expect(w2.overlaps).toBe(0); expect(w2.offences).toBe(0);
  });

  it('road cars behind a held queue on the approach each brake for the car in front, in physical order', () => {
    for (const rev of [false, true]) {
      const r = setup(4, true);
      const [P, A, B, C] = r.cars;
      inPit(C, T.PIT_IN0 + 0.9); C.pitReq = true;     // standing just inside the entrance
      approach(A, 1, 0); owes(A);                     // pit-bound, held behind it
      approach(B, 12, 8);                             // two road cars that are not pitting: an AI car, then the player
      approach(P, 18, 8);
      r.ai = (c) => (c === A || c === C ? { t: 0, b: 1 } : { t: 1, b: 0 });
      if (rev) r.cars.reverse();
      const w = sim(r, 4, UP);
      expect(A.pitHold).toBe(true); expect(B.pitHold).toBe(true); expect(P.pitHold).toBe(true);
      expect(P.pitWait).toBe('queued');
      expect(T.gapS(r.s(B), r.s(A))).toBeGreaterThan(T.CAR_LEN);
      expect(T.gapS(r.s(P), r.s(B))).toBeGreaterThan(T.CAR_LEN);
      expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
    }
  });
});

describe('occupancy', () => {
  it('a car parked in its own bay does not block the through lane', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    inBay(r, A, 1); A.refuelTarget = 2; A.fuel = 0.3;   // stays
    inPit(P, T.PIT_IN1 + 1, 7);
    let minV = 99, waited = false;
    sim(r, 3, UP, watch(), DT, () => {
      const g = T.gapS(T.BAYS[1], r.s(P));
      if (Math.abs(g) < 2) minV = Math.min(minV, P.v);
      if (P.pitWait) waited = true;
      return T.gapS(r.s(P), T.PIT_OUT0) < 1;
    });
    expect(minV).toBeGreaterThan(T.PIT_SPEED - 0.5);
    expect(waited).toBe(false);
  });

  it('a car serving in the box blocks a car bound for a downstream bay', () => {
    const r = setup(3);
    const [, A, B] = r.cars;
    inPit(A, T.PEN_S); owes(A);
    inPit(B, T.PIT_IN1 - 3, 6); fuels(B);
    let passed = false;
    const w = sim(r, 2.5, NONE, watch(), DT, () => { if (T.gapS(r.s(A), r.s(B)) > -T.CAR_LEN) passed = true; return false; });
    expect(passed).toBe(false);
    expect(B.pitWait).toBe('queued'); expect(B.v).toBeLessThan(0.05);
    expect(r.pit.box).toBe(A.idx); expect(r.pit.bays[B.bayHome]).toBe(B.idx);
    // once A has served and gone, B reaches its own bay
    sim(r, 10, NONE, w, DT, () => B.mode === 'service');
    expect(B.mode).toBe('service'); expect(B.bay).toBe(B.bayHome);
    expect(w.overlaps).toBe(0);
  });

  it('the box is exclusive: a player behind its owner is held outside it and serves nothing until granted the box', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    inPit(A, T.PEN_S + T.PEN_HALF - 0.05); owes(A); A.sgOwed = 2 * PEN.stopSeconds;   // at the very front of the box, owing 6 s
    const ai = r.ai.bind(r);
    r.ai = (c, t) => (c === A && c.sgOwed > 0 ? { t: 0, b: 1 } : ai(c, t));
    inPit(P, T.PIT_IN1 - 3, 6); P.sgOwed = PEN.stopSeconds; P.sgDue = LAPS;
    const inBox = (c: Car) => Math.abs(T.gapS(r.s(c), T.PEN_S)) < T.PEN_HALF;
    let shared = false, servedEarly = false;
    // Throttle alone while A serves; once A has gone, the player brakes in the box to serve its own stop
    const w = sim(r, 14, () => (A.sgOwed > 0 || !inBox(P) ? UP : BRAKE), watch(), DT, () => {
      if (inBox(P) && inBox(A) && A.mode === 'pitlane') shared = true;
      if (A.sgOwed > 0 && (P.sgServed > 0 || P.sgServing)) servedEarly = true;
      return P.sgOwed === 0;
    });
    expect(shared).toBe(false);
    expect(servedEarly).toBe(false);
    expect(w.held.get(P.idx)).toBeGreaterThan(1);         // queued on Throttle alone while A served
    expect(served(w)).toEqual([A.idx, P.idx]);
    expect(trail(r, 'box')).toEqual([`${A.idx}:box:grant`, `${A.idx}:box:release:done`, `${P.idx}:box:grant`, `${P.idx}:box:release:done`]);
    expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
  });

  it('a bay reservation keeps other cars out, and nobody ever holds two bays', () => {
    const r = setup(3, true);
    const [P, A, B] = r.cars;
    approach(A, 10); fuels(A); A.bay = 1;
    r.pit.update();
    expect(r.pit.bays[1]).toBe(A.idx);
    // the player stops level with A's reserved bay: it is not captured
    inPit(P, T.BAYS[1]);
    sim(r, 0.2, BRAKE);
    expect(P.mode).toBe('pitlane');
    // B's current target pointing at bay 1 changes nothing: it is given its own bay, and only one
    approach(B, 20); fuels(B); B.bay = 1;
    r.pit.update();
    expect(B.bay).toBe(B.bayHome); expect(r.pit.bays[B.bayHome]).toBe(B.idx);
    expect(r.pit.bays.filter((h) => h === B.idx)).toHaveLength(1);
    expect(r.pit.bays.filter((h) => h === A.idx)).toHaveLength(1);
  });
});

describe('bay departures', () => {
  it('an exit request waits for the gap, then completes exactly once without pressing again', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    inBay(r, P, 0);
    inPit(A, T.BAYS[0] - 2.6, 8);       // committed: cannot stop short of the merge
    r.ai = () => ({ t: 1, b: 0 });
    sim(r, DT, NONE); sim(r, DT, UP);    // one fresh press of Throttle
    const w = watch();
    let outs = 0, prev = P.mode, waited = false;
    sim(r, 4, NONE, w, DT, () => {
      if (P.mode === 'bayOut' && prev !== 'bayOut') outs++;
      if (P.waitingClear && P.pitWait === 'exit') waited = true;
      prev = P.mode; return false;
    });
    expect(waited).toBe(true);
    expect(outs).toBe(1);
    expect(['pitlane', 'race']).toContain(P.mode); expect(P.exitReq).toBe(false);
    expect(trail(r, 'merge')).toEqual([`${P.idx}:merge0:grant`, `${P.idx}:merge0:release:done`]);
    expect(w.overlaps).toBe(0);
  });

  it('adjacent bays never pull out together: the downstream bay goes first, whatever the array order', () => {
    for (const rev of [false, true]) {
      const r = setup(3);
      const [, A, B] = r.cars;
      inBay(r, A, 1); A.refuelTarget = 0; A.pitPlan = false;
      inBay(r, B, 2); B.refuelTarget = 0; B.pitPlan = false;
      if (rev) r.cars.reverse();
      let both = false;
      const w = sim(r, 4, NONE, watch(), DT, () => { if (r.pit.merges[1] >= 0 && r.pit.merges[2] >= 0) both = true; return false; });
      expect(both).toBe(false);
      const m = trail(r, 'merge');
      expect(m[0]).toBe(`${B.idx}:merge2:grant`);
      expect(m.indexOf(`${A.idx}:merge1:grant`)).toBeGreaterThan(m.indexOf(`${B.idx}:merge2:release:done`));
      expect(w.overlaps).toBe(0);
    }
  });

  it('passage priority: a bay car goes before a through car that can still stop, which then advances', () => {
    const r = setup(2);
    const [, A] = r.cars; const L = r.cars[0];
    inBay(r, A, 2); A.refuelTarget = 0; A.pitPlan = false;
    inPit(L, T.BAYS[2] - 7, 6);
    r.ai = (c) => (c === L ? { t: 1, b: 0 } : { t: 0, b: 0 });
    const w = sim(r, 0.1);
    expect(r.pit.merges[2]).toBe(A.idx);
    sim(r, 3, NONE, w, DT, () => L.mode === 'race');
    expect(w.held.get(L.idx)).toBeGreaterThan(0);        // L waited for the merge...
    expect(T.gapS(r.s(A), r.s(L))).toBeLessThan(0);      // ...and stayed behind A
    expect(w.overlaps).toBe(0);
  });

  it('no deadlock: a bay car waits for a through car standing in its merge zone, then both get out', () => {
    const r = setup(4, true);
    const [P, A, L, Q] = r.cars;
    // the player stands in the outside lane across the pit exit: the pit lane backs up past bay 3
    place(P, LAP * T.L + T.PIT_OUT1 + 0.5, -1, 0); P.crossed = LAP + 1;
    inPit(Q, T.PIT_OUT0 - 0.5);
    inPit(L, T.BAYS[3] + 0.4);
    inBay(r, A, 3); A.refuelTarget = 0; A.pitPlan = false;
    r.ai = () => ({ t: 1, b: 0 });
    const w = sim(r, 2);
    expect(Q.pitWait).toBe('exit'); expect(L.pitHold).toBe(true);
    expect(A.mode).toBe('service'); expect(A.pitWait).toBe('exit');
    // the player drives off: the exit clears, the lane moves, and the bay car leaves
    let aOut = 0, prev = A.mode;
    sim(r, 8, (rr) => (me(rr).mode === 'race' && rr.s(me(rr)) < 60 ? UP : NONE), w, DT, () => {
      if (A.mode === 'bayOut' && prev !== 'bayOut') aOut++; prev = A.mode;
      return A.mode === 'race' || A.mode === 'pitlane' && T.gapS(r.s(A), T.PIT_OUT1) < 0;
    });
    expect(aOut).toBe(1);
    expect(L.mode).toBe('race'); expect(Q.mode).toBe('race');
    expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
  });
});

describe('pit exit', () => {
  it('waits for a car standing in the outside lane at the merge, and goes once it drives off', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    place(P, LAP * T.L + T.PIT_OUT1 + 1, -1, 0); P.crossed = LAP + 1;
    inPit(A, T.PIT_OUT0 - 3, 6);
    r.ai = () => ({ t: 1, b: 0 });
    const w = sim(r, 2);
    expect(A.pitWait).toBe('exit'); expect(A.mode).toBe('pitlane');
    expect(T.gapS(r.s(A), T.PIT_OUT0)).toBeGreaterThan(0);
    sim(r, 4, (rr) => (rr.s(me(rr)) < 70 ? UP : NONE), w, DT, () => A.mode === 'race');
    expect(A.mode).toBe('race');
    expect(trail(r, 'exit')).toEqual([`${A.idx}:exit:grant`, `${A.idx}:exit:release:done`]);
    expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
  });

  it('waits for a car backing towards the merge', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    place(P, LAP * T.L + T.PIT_OUT1 + 6, -1, 0); P.crossed = LAP + 1;
    P.revOn = true; P.v = -3;
    inPit(A, T.PIT_OUT0 - 3, 6);
    r.ai = () => ({ t: 1, b: 0 });
    const w = sim(r, 1.2, BRAKE);
    expect(A.mode).toBe('pitlane'); expect(A.pitWait).toBe('exit');
    expect(w.overlaps).toBe(0); expect(w.offences).toBe(0);
  });
});

describe('reservation lifecycle', () => {
  it('Defer releases the reservation and keeps the debt; refused on the final lap', () => {
    const r = setup(2, true);
    const [P, A] = r.cars;
    approach(P, 8, 0); P.crossed = LAP; P.lapsDone = LAP - 1; P.hiU = P.u;
    P.offences = 2; r.offence(P, A, 'rear');
    r.requestPit(me(r).id);                                      // and a fuel stop
    place(A, LAP * T.L + 120, 1, 0);
    sim(r, DT);
    expect(r.pit.box).toBe(P.idx); expect(r.pit.bays[0]).toBe(P.idx);
    const owed = P.sgOwed, due = P.sgDue;
    r.requestDefer(me(r).id);
    expect(r.pit.held(P)).toEqual([]);
    expect(trail(r).filter((x) => x.includes(':release:'))).toEqual([`${P.idx}:box:release:defer`, `${P.idx}:bay0:release:defer`]);
    expect([P.sgOwed, P.sgDue, P.sgDeferred, P.fuelDue]).toEqual([owed, due + 1, true, LAP + 1]);
    sim(r, 0.5);
    expect(r.pit.held(P)).toEqual([]);                  // not taken back on this approach

    const f = setup(2, true);
    const [Q, B] = f.cars;
    place(Q, LAPS * T.L + T.PIT_IN0 - 8, -1, 0); Q.crossed = LAPS; Q.lapsDone = LAPS - 1;
    Q.offences = 2; f.offence(Q, B, 'rear');
    place(B, LAPS * T.L + 120, 1, 0);
    sim(f, DT);
    expect(f.deferBlock(Q)).toBe('final');
    f.requestDefer(me(f).id);
    expect(f.pit.box).toBe(Q.idx);
  });

  it('driving through the box, then backing into it, moves the reservation without a new deferral', () => {
    const r = setup(1, true);
    const P = r.cars[0];
    // placed inside the far end of the box too fast to stop in it (automatic control only drives a reachable stop):
    // it brakes, rolls out of the box and is then driven by hand
    inPit(P, T.PEN_S + T.PEN_HALF - 0.3, 6); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP + 1; P.sgDeferred = false;
    sim(r, 1.2, UP, watch(), DT, () => T.gapS(T.PEN_S + T.PEN_HALF + 0.3, r.s(P)) > 0);
    sim(r, 0.5, BRAKE);
    expect(r.pit.box).toBe(-1);
    expect(trail(r, 'box')).toEqual([`${P.idx}:box:grant`, `${P.idx}:box:release:passed`]);
    // a fresh Brake press (the first began inside the box, so it stays latched): back up into the box and serve
    sim(r, DT, NONE);
    sim(r, 6, BRAKE, watch(), DT, () => P.sgOwed === 0);
    expect(P.sgOwed).toBe(0);
    expect(P.sgDeferred).toBe(false);
    expect(trail(r, 'box')).toEqual([`${P.idx}:box:grant`, `${P.idx}:box:release:passed`, `${P.idx}:box:grant`, `${P.idx}:box:release:done`]);
  });

  it('a tow, a de-slot and a restart release everything exactly once', () => {
    const r = setup(3);
    const [, A, B] = r.cars;
    approach(A, 10); fuels(A); A.bay = 1;
    approach(B, 20); owes(B);
    r.pit.update();
    expect(r.pit.bays[1]).toBe(A.idx); expect(r.pit.box).toBe(B.idx);
    A.fuel = 0; A.v = 0;
    sim(r, DT);
    expect(A.mode).toBe('tow');
    r.deslot(B);
    expect(trail(r).filter((x) => x.includes(':release:'))).toEqual([`${A.idx}:bay1:release:terminal`, `${B.idx}:box:release:terminal`]);
    // the tow lands in a bay it now holds, and releases it once it has merged out again
    const w = sim(r, 30, NONE, watch(), DT, () => A.mode === 'race');
    expect(A.mode).toBe('race');
    paired(r);
    expect(r.pit.bays.includes(A.idx)).toBe(false);
    expect(w.overlaps).toBe(0);
    const again = new Race();
    expect(allFree(again)).toBe(true); expect(again.pit.log).toEqual([]);
  });
});

describe('player controls', () => {
  /** The player queued in the pit lane behind an AI car serving in the box. */
  function queued() {
    const r = setup(2, true);
    const [P, A] = r.cars;
    inPit(A, T.PEN_S); owes(A);
    inPit(P, T.PIT_IN0 + 1.5, 6);
    return { r, P, A };
  }

  it('a lane change in the pit lane is refused with a reason, and moves nothing', () => {
    const { r, P } = queued();
    sim(r, 1, UP);
    expect(P.pitWait).toBe('queued');
    const before = { u: P.u, d: P.d, side: P.laneSide, order: [...r.pit.order] };
    r.requestLane(me(r).id);
    expect(msgs(r.events)).toContain('msg.pitSingleFile');
    sim(r, 0.5, UP);
    expect({ u: P.u, d: P.d, side: P.laneSide, order: [...r.pit.order] }).toEqual(before);
    expect(P.laneOverride).toBe(false); expect(P.change).toBeNull();
  });

  it('queued on the approach with no switch left, the override is refused with a reason', () => {
    const r = setup(3, true);
    const [P, A, B] = r.cars;
    inPit(A, T.PEN_S - 0.8); owes(A);
    inPit(B, T.PIT_IN0 + 1.2); B.pitReq = true;
    r.ai = () => ({ t: 0, b: 1 });
    approach(P, 5, 4); r.requestPit(me(r).id);
    sim(r, 1.5, UP);
    expect(P.mode).toBe('race'); expect(P.pitWait).toBe('queued');
    expect(r.switchBeforeEntry(P)).toBe(false);
    const u = P.u;
    r.requestLane(me(r).id);
    expect(msgs(r.events)).toContain('msg.queueNoSwitch');
    expect(P.laneOverride).toBe(false);
    sim(r, 0.5, UP);
    expect(P.u).toBe(u); expect(P.laneSide).toBe(-1);
  });

  it('an override before the entrance releases the route at a safe switch and keeps the committed stop owed', () => {
    const r = setup(1, true);
    const P = r.cars[0];
    const s0 = T.wrapS(T.PIT_IN0 - 20);
    T.SWITCHES.push({ s0, s1: s0 + T.SWITCH_LEN });
    approach(P, 30, 8); P.fuelDue = LAP;              // a committed fuel stop due this lap
    r.syncRoute(P);
    sim(r, DT, UP);
    expect(r.pit.bays[0]).toBe(P.idx);
    r.requestLane(me(r).id);                                  // one-switch override: stay off the pit route
    sim(r, DT, UP);
    expect(r.pit.held(P)).toEqual([]);
    expect(trail(r, 'bay0')).toEqual([`${P.idx}:bay0:grant`, `${P.idx}:bay0:release:route`]);
    sim(r, 3, UP, watch(), DT, () => T.ahead(r.s(P), T.PIT_IN0) > 100);
    expect(P.mode).toBe('race'); expect(P.laneSide).toBe(1);   // took the real switch, never the pit
    expect(P.fuelDue).toBe(LAP);                     // the debt is untouched
  });

  it('Brake held through a queue hold never reverses; a fresh press afterwards still can', () => {
    const { r, P, A } = queued();
    sim(r, 1, UP);
    expect(P.pitHold).toBe(true);
    sim(r, 2, BRAKE);
    expect(P.revOn).toBe(false); expect(P.revLatch).toBe(true);
    expect(r.reverseBlock(P)).toBe('assist');
    // the box car serves and leaves; Brake is still held: the car never backs away
    let minV = 0;
    sim(r, 5, BRAKE, watch(), DT, () => { minV = Math.min(minV, P.v); return false; });
    expect(A.sgOwed).toBe(0);
    expect(P.pitHold).toBe(false);
    expect(minV).toBe(0); expect(P.revOn).toBe(false);
    // a fresh press, now out of assisted control, is deliberate reverse
    sim(r, DT, NONE);
    sim(r, 1, BRAKE);
    expect(P.revOn).toBe(true);
  });
});
