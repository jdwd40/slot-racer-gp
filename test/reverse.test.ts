// Hold-Brake reverse: engagement, release and Throttle, service protection, pit-lane and entrance recovery,
// collisions, timing and penalty integrity, fuel, and the shared keyboard/touch input. See docs/reverse.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, Input, LAPS, PEN, Race, REV, REV_CAP, REV_PIT_MIN, VMAX } from '../src/race';
import { DrivingInput, PadButton, TouchPad } from '../src/input';
import { reversing } from '../src/hud';
import { DT, NONE, UP, crossLine, fresh, msgs, place, seedRandom, stepEvents, all, me } from './helpers';
import type { RaceEvent } from '../src/race';

beforeEach(() => seedRandom(11));
afterEach(() => vi.restoreAllMocks());

const BRAKE: Input = { up: false, down: true };
const BOTH: Input = { up: true, down: true };

/** The player alone on circuit-1 (or a given track), racing. */
function solo(track = 'circuit-1'): { r: Race; P: Car } {
  const r = fresh(track);
  r.cars.splice(1);
  me(r).human = true;
  return { r, P: me(r) };
}
/** Step for `sec` seconds of frames; `each` sees every frame and the events it produced. */
function run(r: Race, input: Input, sec: number, each?: (ev: RaceEvent[]) => void): RaceEvent[] {
  const all: RaceEvent[] = [];
  for (let i = 0; i < Math.round(sec / DT); i++) { const ev = stepEvents(r, 1, input); all.push(...ev); each?.(ev); }
  return all;
}
/** Step with `input` while `cond` holds, failing instead of hanging if it never ends. */
function until(r: Race, input: Input, cond: () => boolean, each?: () => void, maxSec = 20): void {
  for (let i = 0; cond(); i++) { if (i > maxSec / DT) throw new Error('condition never ended'); stepEvents(r, 1, input); each?.(); }
}
/** Rival cars hold their brakes where they are put (still AI-driven, so still forward-only). */
function parkAI(r: Race): void { r.ai = () => ({ t: 0, b: 1 }); }
function inPit(c: Car, s: number, v = 0): void {
  c.mode = 'pitlane'; c.u = s; c.d = T.pitD(s); c.v = v; c.laneSide = -1; c.change = null; c.throttle = 0;
}
/** Stationary, then Brake held until reverse engages: returns the seconds it took. */
function engage(r: Race, P: Car): number {
  let t = 0;
  while (!P.revOn && t < 3) { stepEvents(r, 1, BRAKE); t += DT; }
  return t;
}

describe('engagement', () => {
  it('brakes normally while moving and engages only after the named stationary delay', () => {
    const { r, P } = solo();
    place(P, 120, 1, 12);
    let stoppedAt = -1, t = 0;
    while (!P.revOn && t < 5) {
      stepEvents(r, 1, BRAKE); t += DT;
      if (!P.revOn) expect(P.v).toBeGreaterThanOrEqual(0);
      if (stoppedAt < 0 && P.v === 0) stoppedAt = t;
      if (stoppedAt < 0) expect(P.revHoldT).toBe(0); // braking before the stop never pre-charges reverse
    }
    expect(stoppedAt).toBeGreaterThan(0.3);
    expect(t - stoppedAt).toBeGreaterThanOrEqual(REV.engage - DT);
    expect(t - stoppedAt).toBeLessThan(REV.engage + 2 * DT);
  });

  it('a short hold, released and pressed again, starts the delay over', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    for (let k = 0; k < 4; k++) { run(r, BRAKE, REV.engage * 0.8); run(r, NONE, 0.05); }
    expect(P.revOn).toBe(false);
    expect(P.u).toBe(120);
  });

  it('reverses gently along the slot, capped by magnitude under the pit limit', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    engage(r, P);
    let minV = 0;
    run(r, BRAKE, 3, () => { minV = Math.min(minV, P.v); expect(P.d).toBe(P.laneSide * T.laneHalf(r.s(P))); });
    expect(REV_CAP).toBeLessThanOrEqual(T.PIT_SPEED);
    expect(REV_CAP).toBeLessThan(VMAX / 4);
    expect(minV).toBeGreaterThanOrEqual(-REV_CAP);
    expect(P.v).toBeCloseTo(-REV_CAP, 5);
    expect(P.u).toBeLessThan(120 - 6);
    expect(P.laneSide).toBe(1);
    expect(reversing(P)).toBe(true);
  });

  it('releasing Brake cancels a pending engagement and brings a reversing car to rest, with nothing latched', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    run(r, BRAKE, REV.engage * 0.7);
    run(r, NONE, DT);
    expect(P.revHoldT).toBe(0);
    engage(r, P);
    run(r, BRAKE, 1.5);
    expect(P.v).toBeLessThan(-2);
    let prev = P.v;
    run(r, NONE, 1, () => { expect(P.v).toBeGreaterThanOrEqual(prev); expect(P.v).toBeLessThanOrEqual(0); prev = P.v; });
    expect(P.v).toBe(0);
    expect(P.revOn).toBe(false);
    const u = P.u;
    run(r, NONE, 1);
    expect(P.u).toBe(u);
    // a new press needs the full delay again
    run(r, BRAKE, REV.engage * 0.8);
    expect(P.revOn).toBe(false);
  });

  it('Throttle while reversing stops the car first, then drives forward, without a sign flip in one step', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    engage(r, P);
    run(r, BRAKE, 1.5);
    let prev = P.v, sawZero = false;
    run(r, UP, 1.5, () => {
      if (prev < 0) expect(P.v).toBeLessThanOrEqual(0);
      if (P.v === 0) sawZero = true;
      prev = P.v;
    });
    expect(sawZero).toBe(true);
    expect(P.v).toBeGreaterThan(5);
    expect(P.revOn).toBe(false);
  });

  it('with both pedals held, braking wins and reverse never arms', () => {
    const { r, P } = solo();
    place(P, 120, 1, 8);
    run(r, BOTH, 3);
    expect(P.v).toBe(0);
    expect(P.revOn).toBe(false);
    expect(P.revHoldT).toBe(0);
    const u = P.u;
    run(r, BOTH, 2);
    expect(P.u).toBe(u);
    // already reversing: adding Throttle brakes to rest and stays there
    engage(r, P);
    run(r, BRAKE, 1);
    run(r, BOTH, 1);
    expect(P.v).toBe(0);
    expect(P.revOn).toBe(false);
  });

  it('clearing the controls (pause, blur, hidden) forgets the hold and the gear; resume coasts to rest', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    engage(r, P);
    run(r, BRAKE, 1);
    r.clearReverse();
    expect(P.revOn).toBe(false); expect(P.revHoldT).toBe(0); expect(P.revLatch).toBe(false);
    run(r, NONE, 1);
    expect(P.v).toBe(0);
    run(r, BRAKE, REV.engage * 0.8);
    expect(P.revOn).toBe(false);
  });

  it('a restart begins with reverse disengaged', () => {
    T.setTrack('circuit-1');
    const P = me(new Race());
    expect([P.revOn, P.revHoldT, P.revLatch, P.revMark]).toEqual([false, 0, false, null]);
  });
});

describe('where reverse is refused', () => {
  it('never during the countdown, and Brake held through the start stays latched until pressed again', () => {
    T.setTrack('circuit-1');
    const r = new Race({ practice: true });
    const P = me(r);
    const u = P.u;
    until(r, BRAKE, () => r.phase === 'countdown');
    run(r, BRAKE, 2);
    expect(P.u).toBe(u);
    expect(P.revLatch).toBe(true);
    run(r, NONE, DT);
    expect(engage(r, P)).toBeLessThan(REV.engage + 2 * DT);
  });

  it('never after the finish', () => {
    const { r, P } = solo();
    place(P, 120, 1, 0);
    P.finished = true; // the cool-down lap is driven for the player
    run(r, BRAKE, 2, () => { expect(P.revOn).toBe(false); expect(P.v).toBeGreaterThanOrEqual(0); });
  });

  it('never while off the slot or towed, and the press stays latched afterwards', () => {
    const { r, P } = solo();
    place(P, 120, 1, 15);
    r.deslot(P);
    run(r, BRAKE, 2.5);
    expect(P.mode).toBe('race');
    run(r, BRAKE, 1.5);
    expect(P.v).toBe(0); expect(P.revLatch).toBe(true);
    place(P, 120, -1, 0); P.fuel = 0;
    run(r, BRAKE, 1);
    expect(P.mode).toBe('tow');
    expect(P.revOn).toBe(false);
  });

  it('AI cars stay forward-only', () => {
    const r = fresh();
    for (const c of r.cars) place(c, 100 + c.idx * 20, 1, 0);
    let minV = 0;
    run(r, BRAKE, 3, () => { for (const c of r.cars) minV = Math.min(minV, c.v); });
    expect(minV).toBe(0);
    expect(r.cars.every((c) => !c.revOn)).toBe(true);
  });
});

describe('protecting stop-and-go service', () => {
  it('Brake held through the whole stop keeps the car still, and no reverse follows on the same press', () => {
    const { r, P } = solo();
    inPit(P, T.PEN_S); P.sgOwed = 3; P.sgDue = 2;
    const u = P.u;
    let minV = 0;
    const ev: RaceEvent[] = [];
    for (let i = 0; i < (PEN.stopSeconds + 1) / DT && !ev.some((e) => e.type === 'served'); i++) ev.push(...stepEvents(r, 1, BRAKE));
    expect(ev.some((e) => e.type === 'served')).toBe(true);
    expect(msgs(ev)).not.toContain('msg.penReset');
    expect(Math.abs(P.u - u)).toBeLessThan(0.01);    // still at the stop (it may pull away in the frame's last substep)
    expect(P.revOn).toBe(false);
    // automatic control then drives the penalty-only visit to the exit with Brake still held, and hands over there
    until(r, BRAKE, () => P.mode === 'pitlane', () => { minV = Math.min(minV, P.v); });
    expect(P.sgCtl).toBe(false);
    run(r, BRAKE, 2, () => { minV = Math.min(minV, P.v); });
    expect(minV).toBe(0);                    // never backwards on the press held through the box
    expect(P.revOn).toBe(false); expect(P.v).toBe(0);
    // a fresh press may back up again
    const at = P.u;
    run(r, NONE, DT);
    engage(r, P);
    run(r, BRAKE, 0.5);
    expect(P.u).toBeLessThan(at);
  });

  it('an overshot box: stop beyond it, back up into it, and the stop is served in full', () => {
    const { r, P } = solo();
    inPit(P, T.PEN_S + T.PEN_HALF + 0.5); P.sgOwed = 3; P.sgDue = 2;
    engage(r, P);
    // backing into the box ends reverse there: automatic control takes the car and holds it for the stop
    const ev: RaceEvent[] = [];
    for (let i = 0; i < (PEN.stopSeconds + 3) / DT && !ev.some((x) => x.type === 'served'); i++) ev.push(...stepEvents(r, 1, BRAKE));
    expect(ev.some((x) => x.type === 'served')).toBe(true);
    expect(Math.abs(T.gapS(r.s(P), T.PEN_S))).toBeLessThan(T.PEN_HALF);
    expect(P.sgOwed).toBe(0); expect(P.timePen).toBe(0);
    expect(msgs(ev)).toContain('msg.penServed');
    // still held after service: no reverse until a fresh press
    expect(P.v).toBe(0); expect(P.revOn).toBe(false);
  });

  it('backing up into the box, released there, also serves; moving off early resets as before', () => {
    const { r, P } = solo();
    inPit(P, T.PEN_S + T.PEN_HALF + 0.5); P.sgOwed = 3; P.sgDue = 2;
    engage(r, P);
    until(r, BRAKE, () => Math.abs(T.gapS(r.s(P), T.PEN_S)) >= T.PEN_HALF + 0.1);
    run(r, NONE, 1.5);
    expect(P.v).toBe(0);
    expect(P.sgServing).toBe(true);
    // Throttle while serving cannot move the car: the stop is never reset early, and never cleared early either
    const before = P.sgServed, u = P.u;
    const ev = run(r, UP, 0.5);
    expect(msgs(ev)).not.toContain('msg.penReset');
    expect(P.u).toBe(u); expect(P.sgServed).toBeGreaterThan(before); expect(P.sgOwed).toBe(3);
  });

  it('a reversing car is not stationary: no service while it rolls backwards through the box', () => {
    const { r, P } = solo();
    inPit(P, T.PEN_S, -2); P.sgOwed = 3; P.sgDue = 2;
    stepEvents(r, 1, NONE);
    expect(P.sgServing).toBe(false);
    expect(P.sgServed).toBe(0);
  });
});

describe('recovering an overshot bay', () => {
  it('reversing past a bay at speed never captures it, and the pit lane ends at its upstream boundary', () => {
    const { r, P } = solo();
    inPit(P, T.BAYS[3] + T.BAY_HALF + 0.5);
    engage(r, P);
    run(r, BRAKE, 12, () => { expect(P.mode).toBe('pitlane'); expect(T.gapS(REV_PIT_MIN, r.s(P))).toBeGreaterThanOrEqual(-1e-9); });
    expect(P.v).toBe(0);
    expect(r.s(P)).toBeCloseTo(REV_PIT_MIN, 6);
    expect(P.pitStops).toBe(0);
    expect(P.d).toBe(T.pitD(r.s(P)));
  });

  it('a car just inside the pit branch cannot back out onto the road', () => {
    const { r, P } = solo();
    inPit(P, T.PIT_IN0 + 1);
    run(r, BRAKE, 3);
    expect(P.u).toBe(T.PIT_IN0 + 1);
    expect(P.mode).toBe('pitlane');
  });

  it('back up into its own bay, release, refuel; Brake held through service and the automatic exit does not reverse', () => {
    const { r, P } = solo();
    P.fuel = 0.3;
    const bs = T.BAYS[P.bayHome];
    inPit(P, bs + T.BAY_HALF + 0.5);
    engage(r, P);
    until(r, BRAKE, () => T.gapS(bs, r.s(P)) > 0.2);
    for (let i = 0; i < 120 && P.mode === 'pitlane'; i++) stepEvents(r, 1, NONE);
    expect(P.mode).toBe('bayIn');
    expect(P.bay).toBe(P.bayHome);
    expect(P.pitStops).toBe(1);
    run(r, BRAKE, 2);
    expect(P.mode).toBe('service');
    expect(P.fuel).toBeGreaterThan(0.5);
    // leave with a fresh Throttle press, then hold Brake from the bay exit onwards: driven to the exit, never backwards
    until(r, UP, () => P.mode === 'service');
    until(r, BRAKE, () => P.mode === 'bayOut');
    until(r, BRAKE, () => P.mode === 'pitlane', () => { expect(P.v).toBeGreaterThanOrEqual(0); expect(P.revOn).toBe(false); });
    run(r, BRAKE, 2, () => { expect(P.v).toBeGreaterThanOrEqual(0); expect(P.revOn).toBe(false); });
    expect(P.mode).toBe('race'); expect(P.v).toBe(0);
    expect(P.revLatch).toBe(true);
  });

  it('an occupied bay is never captured backing up, even the car\'s own', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.human = true;
    const j = P.bayHome;
    inPit(A, T.BAYS[j]); r.enterBay(A, j); A.mode = 'service'; A.refuelTarget = 2;
    inPit(P, T.BAYS[j] + T.BAY_HALF + 0.5);
    engage(r, P);
    until(r, BRAKE, () => T.gapS(T.BAYS[j], r.s(P)) > -0.3);
    run(r, NONE, 1.5);
    expect(P.mode).toBe('pitlane');
    expect(P.pitStops).toBe(0);
  });
});

describe('recovering a missed pit entrance', () => {
  it('back up on the road past the entrance, then enter driving forward with the request on', () => {
    const { r, P } = solo();
    place(P, T.PIT_IN0 + 1.2, -1, 0);
    r.requestPit(me(r).id);
    expect(P.pitReq).toBe(true);
    engage(r, P);
    // backing over the entrance brings the fuel visit inside the automatic window: it is taken over (and reverse with it)
    until(r, BRAKE, () => !P.sgCtl, () => { expect(P.mode).toBe('race'); expect(P.d).toBe(-T.LANE_HALF); });
    expect(T.gapS(r.s(P), T.PIT_IN0)).toBeGreaterThan(0);
    expect(P.revOn).toBe(false); expect(P.revLatch).toBe(true);
    const ev = run(r, BRAKE, 3, () => expect(P.revOn).toBe(false));
    expect(P.mode).not.toBe('race');
    expect(msgs(ev)).toContain('msg.pitIn');
    expect(P.pitReq).toBe(false);
  });

  it('repeated back-and-forth at the entrance keeps the deadline and the unused deferral, and adds no penalty', () => {
    const { r, P } = solo();
    // inside lane on lap 3: every pass misses
    P.crossed = 3; P.lapsDone = 2;
    place(P, 3 * T.L + T.PIT_IN0 - 2, 1, 5);
    P.sgOwed = 3; P.sgDue = 3; P.pitReq = true; P.pitPenaltyOnly = true;
    run(r, UP, 0.8);
    expect(T.gapS(T.PIT_IN0, r.s(P))).toBeGreaterThan(0);
    const appr = r.apprLap(P);
    expect(appr).toBe(4);
    for (let k = 0; k < 3; k++) {
      run(r, BRAKE, 1); engage(r, P);
      until(r, BRAKE, () => r.s(P) > T.PIT_IN0 - 1.5);
      expect(r.apprLap(P)).toBe(appr); // backing up never brings the approach back
      run(r, NONE, 0.6);
      const ev = run(r, UP, 1);
      expect(T.gapS(T.PIT_IN0, r.s(P))).toBeGreaterThan(0);
      expect(ev.some((e) => e.type === 'breach' || e.type === 'dq')).toBe(false);
    }
    expect([P.sgDue, P.sgDeferred, P.sgOwed, P.timePen, P.pitReq, P.lapsDone, P.svcBreach]).toEqual([3, false, 3, 0, true, 2, null]);
    // the line ending the due lap uses the one deferral, exactly once
    P.revMark = null;
    const ev = crossLine(r, P, 3, 1);
    expect([P.sgDue, P.sgDeferred, P.svcBreach]).toEqual([4, true, null]);
    expect(msgs(ev).filter((m) => m === 'msg.sgLastLap')).toHaveLength(1);
  });

  it('a latched breach is not undone by backing up, entering and serving', () => {
    const { r, P } = solo();
    P.crossed = 3; P.lapsDone = 2;
    place(P, 3 * T.L + T.PIT_IN0 + 1, -1, 0);
    P.sgOwed = 3; P.sgDue = 2; P.sgDeferred = true; P.svcBreach = 'stopGo';
    P.change = { from: 1, to: -1, s0: T.PIT_IN0 - 4, s1: T.PIT_IN0 + 3 }; // a late change made it miss
    P.u = 3 * T.L + T.PIT_IN0 - 0.5; P.v = 4;
    run(r, UP, 0.5);
    expect(P.mode).toBe('race');
    until(r, UP, () => P.change === null);
    run(r, BRAKE, 1.5); engage(r, P);
    // backing up over the entrance: automatic entry takes over short of it (an owed stop keeps routing on, no Pit press)
    until(r, BRAKE, () => !P.sgCtl && r.s(P) > T.PIT_IN0 - 1.5);
    expect(P.pitReq).toBe(true);
    // with no pedal at all, it enters, stops in the box and serves: the stop is settled, the breach is not
    until(r, NONE, () => P.sgOwed > 0);
    expect(P.mode).toBe('pitlane');
    expect(P.sgOwed).toBe(0);
    expect([P.svcBreach, P.timePen]).toEqual(['stopGo', 0]);
  });
});

describe('lane changes and routing', () => {
  it('an attempted reverse during a committed change is refused for that press, and the change completes going forward', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    place(P, sw.s0 + 2, 1, 0);
    P.change = { from: 1, to: -1, s0: sw.s0, s1: sw.s1 };
    const ev = run(r, BRAKE, 2);
    expect(msgs(ev).filter((m) => m === 'msg.revChange')).toHaveLength(1);
    expect(P.u).toBe(sw.s0 + 2);
    expect(P.change).not.toBeNull();
    run(r, UP, 2);
    expect(P.change).toBeNull();
    expect(P.laneSide).toBe(-1);
  });

  it('reverse never starts a switch, and a switch already passed is not decided again on the way forward', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    place(P, sw.s0 + 1.5, 1, 0);
    r.requestLane(me(r).id);
    expect(P.laneReq).toBe(true);
    engage(r, P);
    let d0 = P.d;
    until(r, BRAKE, () => r.s(P) > sw.s0 - 3, () => { expect(P.change).toBeNull(); expect(Math.abs(P.d - d0)).toBeLessThan(0.05); d0 = P.d; });
    run(r, NONE, 0.6);
    let prevD = P.d;
    run(r, UP, 1, () => { expect(Math.abs(P.d - prevD)).toBeLessThan(0.05); prevD = P.d; });
    expect(T.gapS(sw.s0, r.s(P))).toBeGreaterThan(0);
    expect(P.change).toBeNull();
    expect(P.laneReq).toBe(true); // still armed for the next switch on new ground
    // beyond where it reversed, switches work as normal
    place(P, T.SWITCHES[1].s0 - 1, 1, 8);
    run(r, UP, 0.3);
    expect(P.change).not.toBeNull();
  });

  it('the one-switch override is not given back by reversing over the switch it was used at', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    place(P, sw.s0 - 0.3, 1, 8);
    P.pitReq = true; P.laneOverride = true;
    run(r, UP, 0.2);
    expect(P.laneOverride).toBe(false);
    expect(P.change).toBeNull();
    run(r, BRAKE, 1.5); engage(r, P);
    until(r, BRAKE, () => r.s(P) > sw.s0 - 3);
    run(r, NONE, 0.6);
    run(r, UP, 1);
    expect(T.gapS(sw.s0, r.s(P))).toBeGreaterThan(0);
    expect([P.change, P.laneSide, P.pitReq]).toEqual([null, 1, true]);
    expect(r.nextRoute(P)).toEqual({ to: -1, stay: false, override: false });
  });
});

describe('collisions', () => {
  it('backing into a parked car stops against it: no pass-through, nobody shoved backwards, no offence', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.human = true;
    place(P, 120, 1, 0); place(A, 116, 1, 0); parkAI(r);
    engage(r, P);
    const ev = run(r, BRAKE, 3, () => {
      expect(T.gapS(r.s(A), r.s(P))).toBeGreaterThan(T.CAR_LEN - 0.06);
      expect(A.u).toBe(116);
      expect(A.v).toBeGreaterThanOrEqual(0);
    });
    expect(ev.some((e) => e.type === 'offence')).toBe(false);
    expect(ev.filter((e) => e.type === 'bump').length).toBeLessThanOrEqual(1);
  });

  it('a car arriving fast behind a reversing player is resolved forwards and not judged', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.human = true;
    place(P, 120, 1, 0);
    engage(r, P); run(r, BRAKE, 0.8);
    place(A, P.u - T.CAR_LEN - 0.2, 1, 10);
    const ev = run(r, BRAKE, 0.5, () => {
      expect(T.gapS(r.s(A), r.s(P))).toBeGreaterThan(T.CAR_LEN - 0.3);
      expect(A.v).toBeGreaterThanOrEqual(0);
    });
    expect(ev.some((e) => e.type === 'offence')).toBe(false);
    expect(P.offences + A.offences).toBe(0);
  });

  it('cars on the other level of a bridge are never touched while backing over or under it', () => {
    const r2 = fresh('circuit-4'); r2.cars.splice(2);
    const x = T.CROSSINGS[0];
    const [P, A] = r2.cars; P.human = true; parkAI(r2);
    for (const [mine, theirs] of [[x.sHi, x.sLo], [x.sLo, x.sHi]]) {
      place(P, mine + 2, 1, 0); place(A, theirs, 1, 0); P.revMark = null; P.revLatch = false;
      run(r2, NONE, DT);
      engage(r2, P);
      const ev = run(r2, BRAKE, 2.5);
      expect(T.gapS(r2.s(P), mine)).toBeGreaterThan(1); // backed right over the crossing point
      expect(A.u).toBe(theirs);
      expect(ev.some((e) => e.type === 'bump' || e.type === 'offence')).toBe(false);
    }
  });

  it('backing up in the squeeze leaves the priority queue, so queue order can never push a car through another', () => {
    const r = fresh();
    r.cars.splice(2);
    const [P, A] = r.cars; P.human = true;
    place(P, T.SQ_ENTRY + 6, 1, 0); place(A, T.SQ_ENTRY + 2, -1, 0); parkAI(r);
    r.squeezeQ.length = 0; r.squeezeQ.push(P, A);
    engage(r, P);
    run(r, BRAKE, 1.5, () => expect(T.gapS(r.s(A), r.s(P))).toBeGreaterThan(-0.01));
    expect(r.squeezeQ).not.toContain(P);
  });
});

describe('timing and records', () => {
  it('backing over the timing line and driving over it again awards no second lap; the next real crossing restores eligibility', () => {
    const { r, P } = solo();
    place(P, T.FINISH_S + T.L - 1, 1, 8);
    P.crossed = 1; P.lapStartT = 0; P.sectors = 7; P.lapValid = true;
    let ev = run(r, UP, 0.5);
    expect(ev.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect([P.crossed, P.lapsDone, P.lapValid]).toEqual([2, 1, true]);
    const best = P.bestLap;
    run(r, BRAKE, 1.5); engage(r, P);
    until(r, BRAKE, () => P.u > T.FINISH_S + T.L - 2);
    expect(P.lapValid).toBe(false);
    run(r, NONE, 0.6);
    ev = run(r, UP, 1.5);
    expect(ev.filter((e) => e.type === 'lap' || e.type === 'finish')).toHaveLength(0);
    expect([P.crossed, P.lapsDone, P.bestLap]).toEqual([2, 1, best]);
    // the current lap stays invalid up to its line, where the usual rule starts a clean one
    place(P, T.FINISH_S + 2 * T.L - 1, 1, 8); P.sectors = 7;
    ev = run(r, UP, 0.5);
    const lap = ev.find((e): e is Extract<RaceEvent, { type: 'lap' }> => e.type === 'lap');
    expect(lap?.valid).toBe(false);
    expect(P.bestLap).toBe(best);
    expect([P.lapValid, P.sectors, P.crossed]).toEqual([true, 0, 3]);
  });

  it('sector checkpoints are not passed twice', () => {
    const { r, P } = solo();
    const q = T.wrapS(T.FINISH_S + T.L / 4);
    place(P, q - 1, 1, 8); P.sectors = 0; P.lapValid = true;
    run(r, UP, 0.3);
    expect(P.sectors).toBe(1);
    run(r, BRAKE, 1.5); engage(r, P);
    until(r, BRAKE, () => r.s(P) > q - 1);
    run(r, NONE, 0.6); run(r, UP, 1);
    expect(P.sectors).toBe(1);
  });

  it('cannot finish twice or reverse after the flag', () => {
    const { r, P } = solo();
    place(P, T.FINISH_S + LAPS * T.L - 1, 1, 8);
    P.crossed = LAPS; P.lapsDone = LAPS - 1; P.sectors = 7;
    const ev = run(r, UP, 0.4);
    expect(ev.filter((e) => e.type === 'finish')).toHaveLength(1);
    expect(P.finished).toBe(true);
    run(r, BRAKE, 3);
    expect(P.v).toBeGreaterThanOrEqual(0);
  });
});

describe('fuel', () => {
  it('backing up burns fuel and never refills the tank', () => {
    const { r, P } = solo();
    r.practice = false;
    place(P, 120, 1, 0); P.fuel = 0.5;
    engage(r, P);
    let prev = P.fuel;
    run(r, BRAKE, 2, () => { expect(P.fuel).toBeLessThanOrEqual(prev); prev = P.fuel; });
    run(r, NONE, 1, () => { expect(P.fuel).toBeLessThanOrEqual(prev); prev = P.fuel; });
    expect(P.fuel).toBeLessThan(0.5);
  });

  it('running dry while reversing stops the car and the usual tow recovers it', () => {
    const { r, P } = solo();
    place(P, 120, -1, 0); P.fuel = 0.0004;
    engage(r, P);
    run(r, BRAKE, 2);
    expect(P.fuel).toBe(0);
    expect(P.mode === 'tow' || P.mode === 'service').toBe(true);
    run(r, NONE, 3);
    expect(P.mode).toBe('service');
    expect(P.v).toBe(0);
  });
});

// ------------------------------------------------------------ keyboard and touch share one path
class Btn extends EventTarget implements PadButton {
  captured = new Set<number>();
  classList = { toggle: (): void => undefined };
  constructor(public dataset: { hold?: string; tap?: string }) { super(); }
  setPointerCapture(id: number): void { this.captured.add(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  fire(type: string, pointerId: number): void { this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId })); }
}

describe('keyboard and touch Brake', () => {
  function rig() {
    const input = new DrivingInput({ lane: () => {}, pit: () => {}, defer: () => {}, view: () => {}, pause: () => {} });
    const brake = new Btn({ hold: 'brake' }), throttle = new Btn({ hold: 'throttle' });
    const pad = new TouchPad([brake, throttle], input, () => {});
    const { r, P } = solo();
    place(P, 120, 1, 6);
    const step = (sec: number): number[] => { const vs: number[] = []; for (let i = 0; i < Math.round(sec / DT); i++) { r.update(DT, all(r, { up: input.held('throttle'), down: input.held('brake') })); r.events.length = 0; vs.push(P.v); } return vs; };
    return { input, brake, pad, r, P, step };
  }

  it('the Brake key and the Brake button produce the same stop, engagement and reverse', () => {
    const k = rig(), t = rig();
    k.input.press('key:KeyS', 'brake');
    t.brake.fire('pointerdown', 3);
    const a = [...k.step(2), ...(k.input.release('key:KeyS'), k.step(1))];
    const b = [...t.step(2), ...(t.brake.fire('pointerup', 3), t.step(1))];
    expect(b).toEqual(a);
    expect(Math.min(...a)).toBeLessThan(-1);
    expect(a[a.length - 1]).toBe(0);
  });

  it('a cancelled pointer releases Brake: reverse ends and the car comes to rest', () => {
    const { brake, step, P } = rig();
    brake.fire('pointerdown', 4);
    step(2);
    expect(P.v).toBeLessThan(-1);
    brake.fire('pointercancel', 4);
    step(1);
    expect(P.v).toBe(0); expect(P.revOn).toBe(false);
  });

  it('switching apps (pad reset, input clear, race clearReverse) cannot restore reverse on resume', () => {
    const { input, brake, pad, r, step, P } = rig();
    brake.fire('pointerdown', 5);
    input.press('key:ArrowDown', 'brake');
    step(2);
    expect(P.revOn).toBe(true);
    pad.reset(); input.clear(); r.clearReverse();
    step(1);
    expect(P.v).toBe(0); expect(P.revOn).toBe(false);
    // the finger is still on the glass but its late release and the stale key do nothing
    brake.fire('pointerup', 5);
    expect(input.held('brake')).toBe(false);
  });
});
