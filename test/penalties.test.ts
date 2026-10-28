// Rear-end judging, warnings, stop-and-go service, deadlines and AI compliance.
// Ported from the scripted checks used to verify the penalty system when it was built.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as T from '../src/track';
import { Race, Car, PEN, LAPS } from '../src/race';
import { fresh, place, park, stepEvents, offences, msgs, seedRandom, UP, DT } from './helpers';

beforeEach(() => seedRandom(7));
afterEach(() => { vi.restoreAllMocks(); });
import { vi } from 'vitest';

/** rear-end A at 10 m/s with B closing at 16 m/s, one step */
function hit(r: Race, A: Car, B: Car, u = 40) {
  place(A, u, 1, 10); place(B, u - T.CAR_LEN + 0.1, 1, 16);
  return offences(stepEvents(r, 1));
}
function separate(r: Race, A: Car, B: Car) { place(B, A.u - 6, 1, 10); stepEvents(r, 2); }

describe('offence escalation', () => {
  it('warns twice, then issues a stop-and-go, then adds stop time', () => {
    const r = fresh(); park(r);
    const A = r.cars[2], B = r.cars[3];
    let o = hit(r, A, B);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ car: B, other: A, n: 1, cause: 'rear', stop: false });
    expect(A.lapValid).toBe(false); expect(B.lapValid).toBe(false);

    separate(r, A, B); o = hit(r, A, B);
    expect(o[0]).toMatchObject({ n: 2, stop: false });

    separate(r, A, B); o = hit(r, A, B);
    expect(o[0]).toMatchObject({ n: 3, stop: true });
    expect(B.sgOwed).toBe(PEN.stopSeconds);
    expect(B.sgChances).toBe(PEN.opportunities);

    separate(r, A, B); o = hit(r, A, B);
    expect(o[0]).toMatchObject({ n: 4, stop: true });
    expect(B.sgOwed).toBe(2 * PEN.stopSeconds);
    expect(B.sgChances).toBe(PEN.opportunities);
    expect(A.offences).toBe(0);
  });

  it('counts continuous contact as a single incident', () => {
    const r = fresh(); park(r);
    const A = r.cars[2], B = r.cars[3];
    hit(r, A, B);
    let more = 0;
    for (let i = 0; i < 60; i++) { A.v = 10; B.v = 14; B.u = A.u - T.CAR_LEN + 0.05; more += offences(stepEvents(r, 1)).length; }
    expect(more).toBe(0);
    expect(B.offences).toBe(1);
  });

  it('starts every race with a clean sheet', () => {
    const r = fresh();
    for (const c of r.cars) { expect(c.offences).toBe(0); expect(c.sgOwed).toBe(0); expect(c.timePen).toBe(0); }
  });
});

describe('contacts that are not offences', () => {
  it('ignores light contact and keeps the lap valid', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    place(A, 40, 1, 10); place(B, 40 - T.CAR_LEN + 0.1, 1, 12);
    expect(offences(stepEvents(r))).toHaveLength(0);
    expect(B.lapValid).toBe(true);
  });
  it('ignores crawling contact', () => {
    const r = fresh(); park(r);
    place(r.cars[1], 40, 1, 1); place(r.cars[2], 40 - T.CAR_LEN + 0.1, 1, 3.5);
    expect(offences(stepEvents(r))).toHaveLength(0);
  });
  it('ignores contact during respawn, pit-exit or start grace', () => {
    const r = fresh(); park(r);
    place(r.cars[1], 40, 1, 10); place(r.cars[2], 40 - T.CAR_LEN + 0.1, 1, 16); r.cars[2].graceT = 1;
    expect(offences(stepEvents(r))).toHaveLength(0);
  });
  it('ignores contact with a car still being re-slotted', () => {
    const r = fresh(); park(r);
    place(r.cars[1], 40, 1, 10); place(r.cars[2], 40 - T.CAR_LEN + 0.1, 1, 16); r.cars[1].recoverT = 0.5;
    expect(offences(stepEvents(r))).toHaveLength(0);
  });
  it('ignores pit-lane shuffles', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    place(A, 12, -1, 5); place(B, 12 - T.CAR_LEN + 0.1, -1, 8);
    A.mode = 'pitlane'; B.mode = 'pitlane'; A.d = T.pitD(12); B.d = T.pitD(B.u);
    expect(offences(stepEvents(r))).toHaveLength(0);
  });
  it('never collides cars in different lanes', () => {
    const r = fresh(); park(r);
    place(r.cars[1], 40, 1, 10); place(r.cars[2], 40 - T.CAR_LEN + 0.1, -1, 16);
    expect(offences(stepEvents(r))).toHaveLength(0);
  });
});

describe('attribution', () => {
  it('blames the lane changer for an unsafe cut-in just completed', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    place(A, 40, 1, 10); place(B, 40 - T.CAR_LEN + 0.1, 1, 16); A.cutT = PEN.cutInWindow;
    const o = offences(stepEvents(r));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ car: A, cause: 'cut' });
    expect(B.offences).toBe(0);
  });
  it('blames the lane changer while the change is still in progress', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    place(A, 40, 1, 10); place(B, 40 - T.CAR_LEN + 0.1, 1, 16);
    A.cutT = 0; A.change = { from: -1, to: 1, s0: 30, s1: 37 }; A.laneSide = 0.9;
    const o = offences(stepEvents(r));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ car: A, cause: 'cut' });
  });
  it('blames only the rearmost car in a chain collision', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2], C = r.cars[3];
    place(A, 40, 1, 10); place(B, 40 - T.CAR_LEN - 0.3, 1, 10); place(C, B.u - T.CAR_LEN + 0.1, 1, 20);
    const blamed: number[] = [];
    for (let i = 0; i < 12; i++) { A.v = Math.min(A.v, 10); blamed.push(...offences(stepEvents(r)).map((e) => e.car.idx)); }
    expect(blamed).toContain(3);
    expect(blamed).not.toContain(2);
    expect(blamed).not.toContain(1);
  });
});

describe('pit entrance reachability', () => {
  it('judges whether the upcoming entrance can still be made', () => {
    const r = fresh(); park(r);
    const B = r.cars[2];
    place(B, T.PIT_IN0 - 3, -1, 15); expect(r.reachablePitEntry(B)).toBe(false);
    place(B, T.PIT_IN0 - 20, -1, 15); expect(r.reachablePitEntry(B)).toBe(true);
    place(B, T.PIT_IN0 - 10, 1, 15); expect(r.reachablePitEntry(B)).toBe(false);
    place(B, T.SWITCHES[0].s0 - 5, 1, 15);
    const expected = T.ahead(B.u, T.SWITCHES[0].s0) + T.SWITCH_LEN + 3 < T.ahead(B.u, T.PIT_IN0);
    expect(r.reachablePitEntry(B)).toBe(expected);
  });
  it('does not count an entrance that was already beyond reach when the penalty was issued', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    B.offences = 2; place(A, T.PIT_IN0 - 2, 1, 10); place(B, A.u - T.CAR_LEN + 0.1, 1, 16);
    stepEvents(r);
    expect(B.sgOwed).toBe(PEN.stopSeconds); expect(B.sgSkipNext).toBe(true); expect(B.sgChances).toBe(PEN.opportunities);
    B.pitReq = false; B.pitPlan = false; B.sgOwed = 3;
    place(B, T.PIT_IN0 - 0.5, 1, 10); stepEvents(r, 6);
    expect(B.sgChances).toBe(PEN.opportunities); expect(B.sgSkipNext).toBe(false); expect(B.sgOwed).toBe(3);
  });
});

describe('missed deadline', () => {
  it('converts the stop into a result-time penalty exactly once after two missed entrances', () => {
    const r = fresh(); park(r);
    const B = r.cars[2];
    B.sgOwed = 3; B.sgChances = 2; B.sgSkipNext = false; B.pitPlan = false; B.isPlayer = true;
    place(B, T.PIT_IN0 - 0.5, 1, 10);
    let ev = stepEvents(r, 6);
    expect(B.sgChances).toBe(1); expect(B.sgOwed).toBe(3); expect(msgs(ev)).toContain('msg.penChances');

    place(B, T.PIT_IN0 - 0.5, 1, 10); ev = stepEvents(r, 6);
    const tp = ev.find((e) => e.type === 'timePen');
    expect(tp).toMatchObject({ reason: 'missed', secs: PEN.unservedDetour + 3 });
    expect(B.timePen).toBe(10); expect(B.sgOwed).toBe(0);

    place(B, T.PIT_IN0 - 0.5, 1, 10); ev = stepEvents(r, 6);
    expect(B.timePen).toBe(10);
    expect(ev.some((e) => e.type === 'timePen')).toBe(false);
  });
});

describe('serving in the penalty box', () => {
  it('counts only a continuous stationary stop inside the box and suspends refuelling', () => {
    const r = fresh(); park(r);
    const B = r.cars[2]; B.isPlayer = true;
    B.sgOwed = 3; B.sgChances = 2; B.mode = 'pitlane'; B.u = T.PEN_S - 0.2; B.d = T.pitD(B.u); B.v = 0; B.fuel = 0.4;
    let ev = stepEvents(r, 90);
    expect(B.sgServing).toBe(true);
    expect(B.sgServed).toBeGreaterThan(1.4); expect(B.sgServed).toBeLessThan(1.6);
    expect(B.sgOwed).toBe(3);
    expect(ev.some((e) => e.type === 'served')).toBe(false);
    expect(B.fuel).toBe(0.4);

    B.v = 1; ev = stepEvents(r, 1);
    expect(B.sgServed).toBe(0); expect(B.sgServing).toBe(false); expect(msgs(ev)).toContain('msg.penReset');

    B.v = 0; B.u = T.PEN_S + 0.3; ev = stepEvents(r, 185);
    expect(B.sgOwed).toBe(0);
    expect(ev.some((e) => e.type === 'served')).toBe(true);
    expect(msgs(ev)).toContain('msg.penServed');

    B.sgOwed = 3; B.u = T.PEN_S + T.PEN_HALF + 0.5; B.v = 0; stepEvents(r, 60);
    expect(B.sgServed).toBe(0); expect(B.sgOwed).toBe(3);
  });
});

describe('unserved at the flag', () => {
  it('converts once and classifies on finish time plus penalty', () => {
    const r = fresh(); park(r);
    const A = r.cars[1], B = r.cars[2];
    for (const c of [A, B]) { c.crossed = LAPS; c.lapsDone = LAPS - 1; c.lapStartT = 0; c.sectors = 7; }
    B.sgOwed = 3; B.sgChances = 1;
    const uF = T.FINISH_S + LAPS * T.L;
    place(B, uF - 0.5, 1, 15); place(A, uF - 0.5 - 15 * 3, -1, 15);
    const ev = [];
    for (let i = 0; i < 60 * 4; i++) { ev.push(...stepEvents(r)); A.v = 15; }
    expect(B.finished).toBe(true); expect(A.finished).toBe(true);
    expect(B.timePen).toBe(10);
    expect(ev.filter((e) => e.type === 'timePen')).toHaveLength(1);
    const res = r.results();
    expect(res[0].car).toBe(A); expect(res[1].car).toBe(B);
    expect(res[1].time - res[0].time).toBeGreaterThan(5);
    expect(r.order()[0]).toBe(A);
    const fin = ev.filter((e): e is Extract<typeof e, { type: 'finish' }> => e.type === 'finish');
    expect(fin).toHaveLength(2);
    expect(fin.find((e) => e.car === A)?.pos).toBe(1);
  });
});

describe('AI compliance', () => {
  it('enters the pits, stands still in the box for the full stop and rejoins', () => {
    const r = fresh();
    r.player.isPlayer = true;
    const B = r.cars[2];
    for (const c of r.cars) place(c, T.FINISH_S + 30 + c.idx * 3, c.idx % 2 ? 1 : -1, 12);
    B.offences = 2; B.sgOwed = 3; B.sgChances = PEN.opportunities; B.sgSkipNext = !r.reachablePitEntry(B);
    let served = false, enteredPit = false, inBox = false, maxVServing = 0, t = 0;
    while (t < 120 && !served) {
      for (const e of stepEvents(r, 1, UP)) if (e.type === 'served' && e.car === B) served = true;
      if (B.mode === 'pitlane') enteredPit = true;
      if (B.sgServing) { inBox = Math.abs(T.gapS(r.s(B), T.PEN_S)) < T.PEN_HALF; maxVServing = Math.max(maxVServing, B.v); }
      t += DT;
    }
    expect(served).toBe(true); expect(enteredPit).toBe(true); expect(inBox).toBe(true);
    expect(maxVServing).toBeLessThan(0.05);
    expect(B.timePen).toBe(0);
    for (let i = 0; i < 60 * 8; i++) stepEvents(r, 1, UP);
    expect(B.mode).toBe('race'); expect(B.v).toBeGreaterThan(5);
  });
});

describe('player penalty', () => {
  it('arms the pit request and refuses to cancel it while a stop is outstanding', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true; const A = r.cars[1];
    P.offences = 2; place(A, 60, 1, 10); place(P, 60 - T.CAR_LEN + 0.1, 1, 16);
    const ev = stepEvents(r);
    expect(P.sgOwed).toBe(3); expect(P.pitReq).toBe(true);
    expect(ev.some((e) => e.type === 'offence' && e.car === P && e.stop)).toBe(true);
    r.requestPit();
    expect(P.pitReq).toBe(true);
    expect(msgs(r.events)).toContain('msg.pitRequired');
  });
});
