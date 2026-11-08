// Service obligations: optional requests, deferral, lap-anchored deadlines, the latched breach and final-lap disqualification.
// See docs/penalties.md for the rules these encode.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, Input, LAPS, PEN, Race, SERVICE_READY } from '../src/race';
import * as R from '../src/records';
import { DT, NONE, UP, crossLine, fresh, memStorage, msgs, place, seedRandom, stepEvents } from './helpers';

beforeEach(() => seedRandom(11));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const OUTSIDE = -1, INSIDE = 1;
const BRAKE: Input = { up: false, down: true };

/** The player alone on lap `lap`, on the road well before that lap's pit entrance. */
function solo(lap = 3, track = 'circuit-1'): { r: Race; P: Car; rival: Car } {
  const r = fresh(track);
  const rival = r.cars[1];
  r.cars.splice(1);
  const P = r.player;
  P.isPlayer = true;
  onLap(P, lap, 60);
  return { r, P, rival };
}
/** Put a car `into` metres past the timing line on lap `lap`. */
function onLap(c: Car, lap: number, into: number, side = OUTSIDE, v = 10): void {
  c.crossed = lap; c.lapsDone = lap - 1; c.sectors = 0; c.revMark = null;
  place(c, T.FINISH_S + (lap - 1) * T.L + into, side, v);
}
/** Just before the pit entrance of lap `lap`, and over it. */
function passEntrance(r: Race, c: Car, lap: number, side: number, input: Input = UP) {
  c.crossed = lap; c.lapsDone = lap - 1;
  place(c, lap * T.L + T.PIT_IN0 - 0.3, side, 10);
  return stepEvents(r, 3, input);
}
const award = (r: Race, P: Car, rival: Car) => { P.offences = 2; r.offence(P, rival, 'rear'); };
/** Stand still in the box until the stop is served (or `sec` runs out). */
function serveBox(r: Race, c: Car, lap: number, sec = 3.2) {
  c.mode = 'pitlane'; c.crossed = lap; c.lapsDone = lap - 1;
  c.u = lap * T.L + T.PEN_S; c.hiU = Math.max(c.hiU, c.u); c.d = T.pitD(c.u); c.v = 0; c.throttle = 0;
  return stepEvents(r, Math.ceil(sec / DT));
}
/** Stop in a free bay: after the 0.45 s turn-in, stand in service for `sec`, without pressing Throttle. */
function standInBay(r: Race, c: Car, lap: number, sec: number, bay = 1) {
  c.mode = 'pitlane'; c.crossed = lap; c.lapsDone = lap - 1; c.serviced = false;
  c.u = lap * T.L + T.BAYS[bay]; c.hiU = Math.max(c.hiU, c.u); c.d = T.pitD(c.u); c.v = 0; c.throttle = 0;
  const ev = stepEvents(r, 1);           // captured
  ev.push(...stepEvents(r, Math.ceil((0.45 + sec) / DT)));
  return ev;
}
const held = (r: Race, P: Car) => P.routeHold >= 0 && P.routeHold === r.apprLap(P);

describe('optional requests', () => {
  it('a player who never asks for a stop is never disqualified for skipping one', () => {
    const { r, P } = solo(LAPS);
    passEntrance(r, P, LAPS, OUTSIDE);
    expect(P.mode).toBe('race');
    const ev = crossLine(r, P, LAPS);
    expect(P.status).toBe('finished');
    expect(ev.some((e) => e.type === 'finish')).toBe(true);
    expect(ev.some((e) => e.type === 'dq' || e.type === 'breach')).toBe(false);
  });

  it('an optional request missed without an override, or cancelled, creates no obligation', () => {
    const { r, P } = solo(3);
    r.requestPit();
    expect([P.fuelReq, P.pitReq, P.fuelDue]).toEqual([true, true, 0]);
    // blocked in the inside lane, no override used: the request just waits for the next lap
    passEntrance(r, P, 3, INSIDE);
    expect([P.fuelReq, P.pitReq, P.fuelDue]).toEqual([true, true, 0]);
    crossLine(r, P, 3);
    expect(P.svcBreach).toBeNull();
    r.requestPit();
    expect([P.fuelReq, P.pitReq, P.fuelDue]).toEqual([false, false, 0]);
    expect(msgs(r.events)).toContain('msg.pitCancelled');
  });

  it('an optional request still armed at the flag is simply dropped: a normal finish', () => {
    const { r, P } = solo(LAPS);
    r.requestPit();
    passEntrance(r, P, LAPS, INSIDE);
    crossLine(r, P, LAPS);
    expect(P.status).toBe('finished'); expect(P.fuelReq).toBe(false);
  });
});

describe('deferring', () => {
  it('Defer commits a fuel request to the next lap, releases this approach and re-arms beyond it', () => {
    const { r, P } = solo(3);
    r.requestPit();
    expect(r.deferBlock(P)).toBeNull();
    r.requestDefer();
    expect([P.fuelReq, P.fuelDue, P.pitReq]).toEqual([false, 4, false]);
    expect(held(r, P)).toBe(true);
    expect(r.nextRoute(P)).toBeNull();
    expect(msgs(r.events)).toContain('msg.deferred');
    // the released approach: driven past in the outside lane, no entry
    passEntrance(r, P, 3, OUTSIDE);
    expect(P.mode).toBe('race');
    // beyond it, routing is back for lap 4
    stepEvents(r, 1, UP);
    expect(held(r, P)).toBe(false); expect(P.pitReq).toBe(true);
    expect(r.nextRoute(P)).toMatchObject({ to: OUTSIDE });
  });

  it('cannot be erased with a second toggle, cannot be deferred again and Pit only brings the route back', () => {
    const { r, P } = solo(3);
    r.requestPit(); r.requestDefer();
    r.events.length = 0;
    r.requestDefer();
    expect(msgs(r.events)).toEqual(['msg.deferHeld']);
    r.events.length = 0;
    r.requestPit(); // reselecting Pit: stop this lap after all
    expect(msgs(r.events)).toEqual(['msg.pitUndefer']);
    expect([P.fuelDue, P.pitReq]).toEqual([4, true]);
    r.events.length = 0;
    r.requestPit(); // and now it cannot be cancelled
    expect(msgs(r.events)).toEqual(['msg.pitDue']);
    expect([P.fuelDue, P.pitReq]).toEqual([4, true]);
    // past this approach the fuel stop is due now: no further deferral
    passEntrance(r, P, 3, INSIDE); stepEvents(r, 1, UP);
    crossLine(r, P, 3);
    expect(r.deferBlock(P)).toBe('used');
    r.requestDefer();
    expect(P.fuelDue).toBe(4);
  });

  it('a lane override that skips a requested entrance is a deferral, once, and repeated overrides never reset it', () => {
    const { r, P } = solo(3);
    r.requestPit();
    r.requestLane(); // override: inside at the next switch
    expect(P.laneOverride).toBe(true);
    const sw = T.SWITCHES.find((x) => T.ahead(x.s0, T.PIT_IN0) < T.L / 2)!;
    place(P, 2 * T.L + T.FINISH_S + T.ahead(T.FINISH_S, sw.s0) - 0.2, OUTSIDE, 10);
    stepEvents(r, 3, UP);
    for (let i = 0; i < 240 && P.change; i++) stepEvents(r, 1, UP);
    expect(P.overAppr).toBe(3);
    const ev = passEntrance(r, P, 3, INSIDE);
    expect(msgs(ev)).toContain('msg.fuelOverride');
    expect([P.fuelReq, P.fuelDue]).toEqual([false, 4]);
    // more overrides, toggles and reversing over the entrance change nothing
    for (let k = 0; k < 3; k++) { r.requestLane(); r.requestPit(); r.requestDefer(); }
    expect(P.fuelDue).toBe(4);
  });

  it('no extra-lap deferral on the final lap', () => {
    const { r, P, rival } = solo(LAPS);
    r.requestPit();
    expect(r.deferBlock(P)).toBe('final');
    r.requestDefer();
    expect(msgs(r.events)).toContain('msg.deferFinal');
    expect([P.fuelReq, P.fuelDue]).toEqual([true, 0]);
    r.requestPit(); // cancel the optional request
    award(r, P, rival);
    expect(P.sgDue).toBe(LAPS);
    expect(r.deferBlock(P)).toBe('final');
    r.requestDefer();
    expect([P.sgDue, P.sgDeferred]).toEqual([LAPS, false]);
  });

  it('is not offered in practice, in the pit lane, or with nothing to defer', () => {
    const p = fresh('circuit-1', { practice: true }); p.player.isPlayer = true;
    p.requestPit();
    expect(p.deferBlock(p.player)).toBe('phase');
    const { r, P } = solo(3);
    expect(r.deferBlock(P)).toBe('none');
    r.requestPit(); P.mode = 'pitlane';
    expect(r.deferBlock(P)).toBe('pit');
  });
});

describe('stop-and-go and the box', () => {
  it('box occupied: queueing is the default, one deferral is offered while another lap remains', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.isPlayer = true;
    onLap(P, 3, 60);
    award(r, P, A);
    // A stands in the box serving its own stop
    A.mode = 'pitlane'; A.sgOwed = 3; A.sgDue = 3; A.u = 2 * T.L + T.PEN_S; A.hiU = A.u; A.d = T.pitD(A.u); A.v = 0;
    expect(r.boxBusy(P)).toBe(true);
    expect(P.pitReq).toBe(true); // queue by default
    expect(r.deferBlock(P)).toBeNull();
    r.requestDefer();
    expect([P.sgDue, P.sgDeferred, P.pitReq]).toEqual([4, true, false]);
    expect(r.deferBlock(P)).toBe('held');
  });

  it('box occupied on the final lap: no deferral, the route stays on', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.isPlayer = true;
    onLap(P, LAPS, 60);
    award(r, P, A);
    A.mode = 'pitlane'; A.u = (LAPS - 1) * T.L + T.PEN_S; A.hiU = A.u; A.d = T.pitD(A.u); A.v = 0;
    expect(r.boxBusy(P)).toBe(true);
    expect(r.deferBlock(P)).toBe('final');
    r.requestLane(); // a manual override cannot waive it either
    expect(P.sgOwed).toBe(PEN.stopSeconds); expect(P.pitReq).toBe(true);
  });

  it('a deferred stop-and-go cannot be deferred again, and added stop time keeps the earliest deadline', () => {
    const { r, P, rival } = solo(3);
    award(r, P, rival);
    r.requestDefer();
    expect([P.sgDue, P.sgDeferred]).toEqual([4, true]);
    passEntrance(r, P, 3, OUTSIDE); stepEvents(r, 1, UP);
    expect(r.deferBlock(P)).toBe('used');
    award(r, P, rival); // a fourth offence: more stop time only
    expect([P.sgOwed, P.sgDue, P.sgDeferred]).toEqual([2 * PEN.stopSeconds, 4, true]);
    const ev = crossLine(r, P, 4);
    expect(P.svcBreach).toBe('stopGo');
    expect(msgs(ev)).toContain('msg.breachSg');
  });

  it('clears only after the full continuous stationary time in the box', () => {
    const { r, P, rival } = solo(3);
    award(r, P, rival);
    serveBox(r, P, 3, PEN.stopSeconds - 0.3);
    expect(P.sgOwed).toBe(PEN.stopSeconds); expect(P.sgDue).toBe(3);
    P.v = 1; stepEvents(r, 1); // moved off: the countdown restarts
    expect(P.sgServed).toBe(0);
    const ev = serveBox(r, P, 3, PEN.stopSeconds + 0.1);
    expect(P.sgOwed).toBe(0); expect(P.sgDue).toBe(0);
    expect(ev.some((e) => e.type === 'served')).toBe(true);
  });

  it('a stop-and-go awarded after the last reachable entry stays owed, says so at once, and disqualifies at the flag', () => {
    const { r, P, rival } = solo(LAPS);
    P.u = LAPS * T.L + T.PIT_IN0 + 2; P.hiU = P.u; // on the pit straight, past the final entrance
    award(r, P, rival);
    expect(P.sgDue).toBe(LAPS + 1);
    expect(r.dueState(P, P.sgDue)).toBe('late');
    expect(msgs(r.events)).toContain('msg.sgLate');
    const ev = crossLine(r, P, LAPS);
    expect(P.status).toBe('dq'); expect(P.dqReason).toBe('stopGo');
    expect(ev.filter((e) => e.type === 'dq')).toHaveLength(1);
  });

  it('the late stop can still be recovered by reversing to the entrance and serving it before the line', () => {
    const { r, P, rival } = solo(LAPS);
    place(P, LAPS * T.L + T.PIT_IN0 + 1.5, OUTSIDE, 0); P.crossed = LAPS; P.lapsDone = LAPS - 1;
    award(r, P, rival);
    expect(P.sgDue).toBe(LAPS + 1);
    for (let i = 0; i < 120 && !P.revOn; i++) stepEvents(r, 1, BRAKE);
    for (let i = 0; i < 600 && r.s(P) > T.PIT_IN0 - 1.5; i++) stepEvents(r, 1, BRAKE);
    stepEvents(r, 40);
    for (let i = 0; i < 120 && P.mode !== 'pitlane'; i++) stepEvents(r, 1, UP);
    expect(P.mode).toBe('pitlane');
    serveBox(r, P, LAPS);
    expect(P.sgOwed).toBe(0);
    // on to the line in the pit lane
    P.u = LAPS * T.L + T.FINISH_S - 0.3; P.hiU = P.u; P.d = T.pitD(P.u); P.v = 5;
    stepEvents(r, 6, UP);
    expect(P.status).toBe('finished');
  });
});

describe('fuel service', () => {
  it('a deferred fuel stop clears only after standing in a bay for the departure-ready time, even with a full tank', () => {
    const { r, P } = solo(3);
    r.requestPit(); r.requestDefer();
    P.fuel = 1;
    // driving through the pit lane is not service
    P.mode = 'pitlane'; P.u = 3 * T.L + T.PIT_IN1; P.hiU = P.u; P.d = T.pitD(P.u); P.v = 6;
    stepEvents(r, 30, UP);
    expect(P.fuelDue).toBe(4);
    // entering a bay is not service either
    standInBay(r, P, 4, 0);
    expect(P.mode).toBe('service'); expect(P.serviceT).toBeLessThanOrEqual(SERVICE_READY + 0.02);
    expect(P.fuelDue).toBe(4);
    const ev = stepEvents(r, Math.ceil((SERVICE_READY + 0.1) / DT));
    expect(P.fuelDue).toBe(0);
    expect(msgs(ev)).toContain('msg.fuelDone');
    expect(P.mode).toBe('service'); // done, and free to stay for fuel or leave
  });

  it('a tow is recovery, not a visit: it never settles a committed fuel stop', () => {
    const { r, P } = solo(3);
    r.requestPit(); r.requestDefer();
    P.fuel = 0; P.v = 0;
    stepEvents(r, 1);
    expect(P.mode).toBe('tow');
    stepEvents(r, Math.ceil(5 / DT));
    expect(P.towSvc).toBe(true);
    expect(P.fuelDue).toBe(4);
  });

  it('one visit can serve the stop-and-go first and then the fuel stop, and each clears only itself', () => {
    const { r, P, rival } = solo(3);
    r.requestPit(); r.requestDefer();
    award(r, P, rival);
    expect([P.sgOwed, P.fuelDue]).toEqual([PEN.stopSeconds, 4]);
    serveBox(r, P, 3);
    expect([P.sgOwed, P.fuelDue]).toEqual([0, 4]);
    standInBay(r, P, 3, SERVICE_READY + 0.1);
    expect([P.sgOwed, P.fuelDue]).toEqual([0, 0]);
  });

  it('a fuel stop served after its due lap does not undo the breach', () => {
    const { r, P } = solo(3);
    r.requestPit(); r.requestDefer();
    passEntrance(r, P, 3, OUTSIDE);
    crossLine(r, P, 3, INSIDE);
    let ev = crossLine(r, P, 4, INSIDE);
    expect(P.svcBreach).toBe('fuel');
    expect(msgs(ev)).toContain('msg.breachFuel');
    standInBay(r, P, 5, SERVICE_READY + 0.1);
    expect(P.fuelDue).toBe(0); expect(P.svcBreach).toBe('fuel');
    P.mode = 'race';
    ev = crossLine(r, P, LAPS);
    expect(P.status).toBe('dq'); expect(P.dqReason).toBe('deadline');
  });
});

describe('the final crossing', () => {
  it('service on the final lap before the line gives a normal finish', () => {
    const { r, P, rival } = solo(LAPS);
    award(r, P, rival);
    serveBox(r, P, LAPS);
    expect(P.sgOwed).toBe(0);
    P.u = LAPS * T.L + T.FINISH_S - 0.3; P.hiU = P.u; P.d = T.pitD(P.u); P.v = 5;
    const ev = stepEvents(r, 6, UP);
    expect(P.status).toBe('finished');
    expect(ev.some((e) => e.type === 'finish')).toBe(true);
    expect(ev.some((e) => e.type === 'dq')).toBe(false);
  });

  it('an obligation due on the final lap is judged before the finish is classified: one DQ, no finish', () => {
    const { r, P } = solo(LAPS - 1);
    r.requestPit(); r.requestDefer(); // due on the final lap
    expect(P.fuelDue).toBe(LAPS);
    crossLine(r, P, LAPS - 1);
    expect(P.svcBreach).toBeNull();
    const ev = crossLine(r, P, LAPS);
    expect(P.status).toBe('dq'); expect(P.dqReason).toBe('fuel');
    expect(ev.filter((e) => e.type === 'dq')).toHaveLength(1);
    expect(ev.some((e) => e.type === 'finish')).toBe(false);
    // backing over the line and crossing again changes nothing
    const again = crossLine(r, P, LAPS);
    expect(again.some((e) => e.type === 'dq' || e.type === 'finish')).toBe(false);
  });

  it('service applied earlier in the same step counts at the crossing', () => {
    const { r, P, rival } = solo(LAPS);
    award(r, P, rival);
    // the last sliver of the stop and the line in one call: the box is upstream, so serve, then drive on in the pit lane
    serveBox(r, P, LAPS, PEN.stopSeconds - DT * 1.5);
    expect(P.sgOwed).toBe(PEN.stopSeconds);
    stepEvents(r, 3);
    expect(P.sgOwed).toBe(0);
    P.u = LAPS * T.L + T.FINISH_S - 0.05; P.hiU = P.u; P.d = T.pitD(P.u); P.v = 6;
    stepEvents(r, 2, UP);
    expect(P.status).toBe('finished');
  });

  it('practice never disqualifies', () => {
    const r = fresh('circuit-1', { practice: true });
    const P = r.player; P.isPlayer = true;
    P.fuelDue = 2; P.svcBreach = 'fuel';
    const ev = crossLine(r, P, LAPS + 2);
    expect(P.finished).toBe(false); expect(P.status).toBe('running');
    expect(ev.some((e) => e.type === 'dq' || e.type === 'breach')).toBe(false);
  });
});

describe('robustness', () => {
  it('reversing over the entrance after a deferral neither re-holds the route nor offers another deferral', () => {
    const { r, P } = solo(3);
    r.requestPit(); r.requestDefer();
    place(P, 3 * T.L + T.PIT_IN0 + 1.2, OUTSIDE, 0); P.hiU = P.u;
    stepEvents(r, 1);
    expect(held(r, P)).toBe(false); expect(P.pitReq).toBe(true);
    for (let i = 0; i < 120 && !P.revOn; i++) stepEvents(r, 1, BRAKE);
    for (let i = 0; i < 600 && r.s(P) > T.PIT_IN0 - 1.5; i++) stepEvents(r, 1, BRAKE);
    expect(r.apprLap(P)).toBe(4);
    expect(held(r, P)).toBe(false);
    expect(r.deferBlock(P)).toBe('used');
    expect(P.fuelDue).toBe(4);
    // and driving in now is early, valid service
    stepEvents(r, 40);
    for (let i = 0; i < 120 && P.mode !== 'pitlane'; i++) stepEvents(r, 1, UP);
    expect(P.mode).toBe('pitlane');
  });

  it('a re-slot behind the entrance does not bring the approach back', () => {
    const { r, P, rival } = solo(3);
    award(r, P, rival);
    r.requestDefer();
    place(P, 3 * T.L + T.PIT_IN0 + 0.5, INSIDE, 10); P.hiU = P.u;
    r.deslot(P);
    stepEvents(r, Math.ceil(2 / DT));
    expect(P.mode).toBe('race');
    expect(P.u).toBeLessThan(3 * T.L + T.PIT_IN0);
    expect(r.apprLap(P)).toBe(4);
    expect([P.sgDue, P.sgDeferred]).toEqual([4, true]);
    expect(r.deferBlock(P)).toBe('used');
  });

  it('pause (clearing input and reverse) changes no obligation', () => {
    const { r, P, rival } = solo(3);
    award(r, P, rival); r.requestDefer();
    const before = JSON.stringify([P.sgOwed, P.sgDue, P.sgDeferred, P.routeHold, P.fuelDue, P.svcBreach]);
    r.clearReverse();
    expect(JSON.stringify([P.sgOwed, P.sgDue, P.sgDeferred, P.routeHold, P.fuelDue, P.svcBreach])).toBe(before);
  });

  it('a new race starts with fresh obligation and breach state', () => {
    const { P } = solo(3);
    P.fuelDue = 4; P.svcBreach = 'fuel'; P.status = 'dq';
    const r2 = new Race();
    expect(r2.player).toMatchObject({ fuelReq: false, fuelDue: 0, sgDue: 0, sgDeferred: false, routeHold: -1, overAppr: -1, svcBreach: null, status: 'running', dqReason: null });
  });
});

describe('results and settlement', () => {
  it('a DQ ends the session: the race reaches the results without waiting, and the rest of the field is run on to real results', () => {
    const r = fresh();
    const P = r.player; P.isPlayer = true;
    const [, A, B, C] = r.cars;
    for (const c of r.cars) { c.crossed = LAPS; c.lapsDone = LAPS - 1; c.lapStartT = 0; c.sectors = 7; }
    place(P, T.FINISH_S + LAPS * T.L - 0.3, OUTSIDE, 10);
    place(A, T.FINISH_S + LAPS * T.L - 40, INSIDE, 15);
    place(B, T.FINISH_S + LAPS * T.L - 80, OUTSIDE, 15);
    place(C, T.FINISH_S + LAPS * T.L - 120, INSIDE, 15);
    P.svcBreach = 'stopGo';
    const ev = stepEvents(r, 4, UP);
    expect(P.status).toBe('dq'); expect(P.dqReason).toBe('deadline');
    ev.push(...stepEvents(r, Math.ceil(3.4 / DT), UP));
    expect(r.phase).toBe('done');
    for (const c of [A, B, C]) expect(c.status).toBe('finished');
    const res = r.results();
    expect(res.map((x) => x.status)).toEqual(['finished', 'finished', 'finished', 'dq']);
    expect(res.every((x) => !x.est)).toBe(true);
    expect(res[3].car).toBe(P);
    expect(ev.filter((e) => e.type === 'dq')).toHaveLength(1);
    // championship: the DQ scores nothing and keeps its own mark
    vi.stubGlobal('localStorage', memStorage());
    const round = R.roundRecord('circuit-1', res);
    expect(round.order.map((o) => [o.idx, !!o.dq, o.dnf])).toEqual([[A.idx, false, false], [B.idx, false, false], [C.idx, false, false], [0, true, false]]);
    expect(R.roundPoints(round, 3)).toBe(0);
    const champ = R.newChamp('sunburst', 'JD'); champ.rounds.push(round);
    const st = R.standings(champ, 4);
    expect(st.find((s) => s.idx === 0)).toMatchObject({ points: 0, wins: 0, lastPos: 99 });
  });

  it('a car that cannot finish in the run-out is a DNF, never an estimate', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.isPlayer = true;
    for (const c of r.cars) { c.crossed = LAPS; c.lapsDone = LAPS - 1; c.sectors = 7; }
    place(P, T.FINISH_S + LAPS * T.L - 0.3, OUTSIDE, 10);
    place(A, 200, INSIDE, 0); A.crossed = 1; A.lapsDone = 0;
    r.ai = () => ({ t: 0, b: 1 }); // A never moves
    stepEvents(r, 4, UP);
    expect(P.status).toBe('finished');
    r.runOut(1);
    expect(A.status).toBe('dnf');
    const res = r.results();
    expect(res.map((x) => x.status)).toEqual(['finished', 'dnf']);
    expect(Number.isNaN(res[1].time)).toBe(true);
    expect(R.roundRecord('t', res).order[1]).toMatchObject({ idx: A.idx, dnf: true });
  });
});
