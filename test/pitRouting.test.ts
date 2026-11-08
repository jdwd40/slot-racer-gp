// Automatic outside-lane routing for pit requests and stop-and-go penalties, with the one-switch manual override.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, PEN, Race } from '../src/race';
import { routeChipId } from '../src/hud';
import { t } from '../src/i18n';
import { fresh, place, stepEvents, msgs, seedRandom, crossLine, NONE, UP } from './helpers';

beforeEach(() => seedRandom(5));
afterEach(() => vi.restoreAllMocks());

const INSIDE = 1, OUTSIDE = -1;
const ids = T.TRACKS.map((d) => d.id);

/** The player alone on track, so a long run cannot be disturbed by traffic. `rival` stays usable as the other party to an offence. */
function solo(track = 'circuit-1'): { r: Race; P: Car; rival: Car } {
  const r = fresh(track);
  const rival = r.cars[1];
  r.cars.splice(1);
  r.player.isPlayer = true;
  return { r, P: r.player, rival };
}
/** Run the car over a position and return what happened. */
const cross = (r: Race, s: number, side: number) => { place(r.player, s - 0.2, side, 10); return stepEvents(r, 3, UP); };
const crossSwitch = (r: Race, i: number, side: number) => cross(r, T.SWITCHES[i].s0, side);
/** Finish whatever change is under way. */
const settle = (r: Race) => { for (let i = 0; i < 240 && r.player.change; i++) stepEvents(r, 1, UP); };
const award = (r: Race, P: Car, rival: Car) => { P.offences = 2; r.offence(P, rival, 'rear'); r.events.length = 0; };
/** Into the pit lane at the entrance, then out of the far end without stopping. */
/** At the pit limit, so a stop-and-go entrance is not refused as too fast (see docs/auto-stop-go.md). */
const enterPit = (r: Race) => { place(r.player, T.PIT_IN0 - 0.2, OUTSIDE, T.PIT_SPEED); return stepEvents(r, 3, UP); };
function exitPit(r: Race): ReturnType<typeof stepEvents> {
  const P = r.player;
  P.u = T.PIT_OUT1 - 0.3; P.d = T.pitD(P.u); P.v = 5;
  return [...stepEvents(r, 6, UP), ...stepEvents(r, 2, UP)];
}
function serve(r: Race): ReturnType<typeof stepEvents> {
  const P = r.player;
  P.mode = 'pitlane'; P.u = T.PEN_S; P.d = T.pitD(P.u); P.v = 0;
  return stepEvents(r, Math.ceil(P.sgOwed * 60) + 5);
}

describe('routing table at the next switch', () => {
  it('moves an inside car outside automatically', () => {
    const { r, P } = solo();
    r.requestPit();
    expect(P.laneReq).toBe(false);
    const ev = crossSwitch(r, 0, INSIDE);
    expect(P.change).toMatchObject({ from: INSIDE, to: OUTSIDE, s0: T.SWITCHES[0].s0 });
    expect(msgs(ev)).toContain('msg.laneGo');
    settle(r);
    expect(P.laneSide).toBe(OUTSIDE);
    expect(P.pitReq).toBe(true);
  });
  it('keeps an outside car outside', () => {
    const { r, P } = solo();
    place(P, 10, OUTSIDE, 10); r.requestPit();
    const ev = crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(OUTSIDE);
    expect(ev.some((e) => e.type === 'switch')).toBe(false);
  });
  it('keeps an inside car inside for one switch on the override', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    expect(P.laneOverride).toBe(true);
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(INSIDE);
  });
  it('moves an outside car inside for one switch on the override', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toMatchObject({ from: OUTSIDE, to: INSIDE });
    settle(r);
    expect(P.laneSide).toBe(INSIDE);
  });
});

describe.each(ids)('%s repeated switches', (id) => {
  it('routes outside at every switch and stays there', () => {
    const { r, P } = solo(id);
    r.requestPit();
    T.SWITCHES.forEach((sw, i) => {
      crossSwitch(r, i, INSIDE);
      expect(P.change).toMatchObject({ to: OUTSIDE, s0: sw.s0 });
      settle(r);
      expect(P.laneSide).toBe(OUTSIDE);
      crossSwitch(r, i, OUTSIDE);
      expect(P.change).toBeNull();
    });
    expect(P.pitReq).toBe(true);
  });
  it('reaches the pits from the inside lane with no lane input', () => {
    const { r, P } = solo(id);
    r.requestPit();
    const last = [...T.SWITCHES].filter((sw) => T.ahead(sw.s1, T.PIT_IN0) < T.L / 2).sort((a, b) => T.ahead(a.s1, T.PIT_IN0) - T.ahead(b.s1, T.PIT_IN0))[0];
    cross(r, last.s0, INSIDE);
    settle(r);
    expect(P.laneSide).toBe(OUTSIDE);
    enterPit(r);
    expect(P.mode).toBe('pitlane');
  });
});

describe('manual override', () => {
  it('applies to the next switch only, then automatic routing resumes', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull(); expect(P.laneOverride).toBe(false);
    crossSwitch(r, 1, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
  });
  it('a second action before the switch restores automatic outside', () => {
    const { r, P } = solo();
    r.requestPit();
    r.requestLane(); expect(msgs(r.events)).toContain('msg.routeInside');
    r.requestLane(); expect(msgs(r.events)).toContain('msg.routeOutside');
    expect(P.laneOverride).toBe(false); expect(P.laneReq).toBe(false);
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
  });
  it('is consumed even when the requested move is blocked, and nothing changes back', () => {
    const { r, P } = solo();
    const O = fresh().cars[1]; r.cars.push(O);
    r.requestPit(); r.requestLane();
    place(O, T.SWITCHES[0].s0 + 0.5, INSIDE, 10);
    const ev = crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toBeNull(); expect(P.laneOverride).toBe(false);
    expect(msgs(ev)).toContain('msg.laneBlocked');
    r.cars.pop();
    crossSwitch(r, 1, OUTSIDE);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(OUTSIDE);
  });
  it('replaces a normal lane request when the pit request is armed', () => {
    const { r, P } = solo();
    r.requestLane(); expect(P.laneReq).toBe(true);
    r.requestPit();
    expect(P.laneReq).toBe(false); expect(P.laneOverride).toBe(false);
    crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toBeNull();
  });
  it('leaves normal lane controls alone without a request', () => {
    const { r, P } = solo();
    r.requestLane();
    expect(P.laneReq).toBe(true); expect(P.laneOverride).toBe(false); expect(msgs(r.events)).toContain('msg.laneReady');
    r.requestLane();
    expect(P.laneReq).toBe(false); expect(msgs(r.events)).toContain('msg.laneCancelled');
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull();
    r.requestLane();
    crossSwitch(r, 1, OUTSIDE);
    expect(P.change).toMatchObject({ to: INSIDE });
    expect(r.nextRoute(P)).toBeNull();
    // without a request a car in mid-change still ignores the lane action
    r.requestLane();
    expect(P.laneReq).toBe(false);
  });
});

describe('clearance, committed changes and geometry', () => {
  it('retries a blocked automatic change at a later switch', () => {
    const { r, P } = solo();
    const O = fresh().cars[1]; r.cars.push(O);
    r.requestPit();
    place(O, T.SWITCHES[0].s0 + 0.5, OUTSIDE, 10);
    const ev = crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(INSIDE); expect(P.d).toBeCloseTo(INSIDE * T.laneHalf(r.s(P)), 6);
    expect(msgs(ev)).toContain('msg.routeBlocked');
    expect(P.pitReq).toBe(true); expect(P.laneReq).toBe(false);
    r.cars.pop();
    crossSwitch(r, 1, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
  });
  it('never moves between switches', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    r.requestPit();
    place(P, sw.s0 - 8, INSIDE, 10);
    while (T.ahead(r.s(P), sw.s0) > 0.3 && T.ahead(r.s(P), sw.s0) < 20) {
      stepEvents(r, 1, UP);
      expect(P.change).toBeNull(); expect(P.laneSide).toBe(INSIDE);
    }
  });
  it('does not reverse a committed change, and routes at the following switch', () => {
    const { r, P } = solo();
    r.requestLane();
    crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toMatchObject({ to: INSIDE });
    r.requestPit();
    expect(P.change).toMatchObject({ to: INSIDE });
    expect(r.nextRoute(P)).toMatchObject({ to: OUTSIDE, stay: false, override: false });
    settle(r);
    expect(P.laneSide).toBe(INSIDE);
    crossSwitch(r, 1, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
  });
  it('holds a committed change when the next switch comes up mid-change, and still uses up the override', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    r.requestPit();
    place(P, sw.s0 - 0.2, INSIDE, 10);
    P.change = { from: OUTSIDE, to: INSIDE, s0: sw.s0 - 3, s1: sw.s0 - 3 + T.SWITCH_LEN };
    r.requestLane();
    expect(P.laneOverride).toBe(true);
    stepEvents(r, 3, UP);
    expect(P.change).toMatchObject({ s0: sw.s0 - 3, to: INSIDE }); expect(P.laneOverride).toBe(false);
  });
  it('leaves no stale lane request when automatic routing meets a switch mid-change', () => {
    const { r, P } = solo();
    const sw = T.SWITCHES[0];
    r.requestPit();
    place(P, sw.s0 - 0.2, INSIDE, 10);
    P.change = { from: OUTSIDE, to: INSIDE, s0: sw.s0 - 3, s1: sw.s0 - 3 + T.SWITCH_LEN };
    stepEvents(r, 3, UP);
    expect(P.change).toMatchObject({ s0: sw.s0 - 3, to: INSIDE }); expect(P.laneReq).toBe(false);
  });
  it('finds the next switch across the timing line', () => {
    const { r, P } = solo();
    const sorted = [...T.SWITCHES].sort((a, b) => a.s0 - b.s0);
    r.requestPit();
    place(P, sorted[sorted.length - 1].s0 + 1, INSIDE, 10);
    expect(r.nextSwitch(P).s0).toBe(sorted[0].s0);
    place(P, T.L + sorted[0].s0 - 0.2, INSIDE, 10); // second lap: u is past one full length
    stepEvents(r, 3, UP);
    expect(P.change).toMatchObject({ to: OUTSIDE, s0: sorted[0].s0 });
  });
  it('routes at a switch straddling the wrap of the track position', () => {
    const { r, P } = solo();
    const s0 = T.L - 3;
    T.SWITCHES.push({ s0, s1: s0 + T.SWITCH_LEN });
    r.requestPit();
    place(P, s0 - 0.2, INSIDE, 10);
    stepEvents(r, 3, UP);
    expect(P.change).toMatchObject({ to: OUTSIDE });
    settle(r);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(OUTSIDE);
    expect(r.s(P)).toBeLessThan(T.SWITCH_LEN);
  });
  it.each(['pitlane', 'off', 'tow', 'service'] as const)('ignores the lane action and changes nothing in mode %s', (mode) => {
    const { r, P } = solo();
    r.requestPit();
    P.mode = mode;
    r.requestLane();
    expect(P.laneOverride).toBe(false);
    expect(r.nextRoute(P)).toBeNull();
  });
  it('does not change road lanes while running down the pit lane over a switch', () => {
    const { r, P } = solo();
    const s0 = T.PIT_IN1 + 1;
    T.SWITCHES.push({ s0, s1: s0 + T.SWITCH_LEN });
    P.mode = 'pitlane'; P.pitReq = true; P.u = s0 - 0.2; P.d = T.pitD(P.u); P.v = 5; P.laneSide = INSIDE;
    stepEvents(r, 6, UP);
    expect(P.change).toBeNull(); expect(P.mode).toBe('pitlane');
  });
});

describe('voluntary request lifecycle', () => {
  it('stays armed after a missed entry and routes to the next approach', () => {
    const { r, P } = solo();
    r.requestPit();
    const ev = cross(r, T.PIT_IN0, INSIDE);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(true); expect(msgs(ev)).toContain('msg.pitMissed');
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
    settle(r);
    enterPit(r);
    expect(P.mode).toBe('pitlane'); expect(P.pitReq).toBe(false);
  });
  it('stays armed when a lane change in progress blocks the entry', () => {
    const { r, P } = solo();
    r.requestPit();
    place(P, T.PIT_IN0 - 0.2, OUTSIDE, 10);
    P.change = { from: INSIDE, to: OUTSIDE, s0: T.PIT_IN0 - 2, s1: T.PIT_IN0 - 2 + T.SWITCH_LEN };
    const ev = stepEvents(r, 3, UP);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(true); expect(msgs(ev)).toContain('msg.pitMissed');
  });
  it('clears the request and any override on entry, with no later routing', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    enterPit(r);
    expect(P.mode).toBe('pitlane');
    expect(P.pitReq).toBe(false); expect(P.laneOverride).toBe(false);
    exitPit(r);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(false);
    enterPit(r);
    expect(P.mode).toBe('race');
  });
  it('clears on deliberate cancellation, override included', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    r.requestPit();
    expect(P.pitReq).toBe(false); expect(P.laneOverride).toBe(false); expect(msgs(r.events)).toContain('msg.pitCancelled');
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull();
    enterPit(r);
    expect(P.mode).toBe('race');
  });
  it('a de-slot drops the override but the request carries on after recovery', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    place(P, 60, INSIDE, 10);
    r.deslot(P);
    expect(P.laneOverride).toBe(false); expect(P.pitReq).toBe(true); expect(r.nextRoute(P)).toBeNull();
    stepEvents(r, 150);
    expect(P.mode).toBe('race');
    expect(r.nextRoute(P)).toMatchObject({ to: OUTSIDE, override: false });
  });
  it('a tow clears the request and the override', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    place(P, 60, INSIDE, 0); P.fuel = 0;
    stepEvents(r, 1);
    expect(P.mode).toBe('tow');
    expect(P.pitReq).toBe(false); expect(P.laneOverride).toBe(false);
  });
  it('the flag clears everything', () => {
    const { r, P } = solo();
    r.requestPit(); r.requestLane();
    P.crossed = 13; P.lapsDone = 12; P.sectors = 7;
    place(P, T.FINISH_S + 13 * T.L - 0.2, OUTSIDE, 10);
    stepEvents(r, 3, UP);
    expect(P.finished).toBe(true);
    expect(P.pitReq).toBe(false); expect(P.laneOverride).toBe(false); expect(r.nextRoute(P)).toBeNull();
    r.requestLane(); r.requestPit();
    expect(P.laneOverride).toBe(false); expect(P.pitReq).toBe(false);
  });
  it('a restarted session starts with no routing state', () => {
    const { P } = solo();
    const r2 = new Race();
    expect(r2.player).not.toBe(P);
    expect(r2.player).toMatchObject({ pitReq: false, pitPenaltyOnly: false, laneOverride: false });
  });
});

describe('stop-and-go routing', () => {
  it('routes outside from the award with no pit request made', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(true);
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
    settle(r);
    crossSwitch(r, 1, OUTSIDE);
    expect(P.change).toBeNull();
  });
  it('replaces a pending normal lane request at the award', () => {
    const { r, P, rival } = solo();
    r.requestLane();
    award(r, P, rival);
    expect(P.laneReq).toBe(false);
    crossSwitch(r, 0, OUTSIDE);
    expect(P.change).toBeNull();
  });
  it('a manual override neither cancels the penalty nor moves its deadline', () => {
    const { r, P, rival } = solo();
    place(P, 60, INSIDE, 10);
    award(r, P, rival);
    const due = P.sgDue;
    r.requestLane();
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull(); expect(P.sgOwed).toBe(PEN.stopSeconds); expect(P.pitReq).toBe(true);
    cross(r, T.PIT_IN0, INSIDE);
    r.requestLane(); r.requestLane(); r.requestLane();
    expect([P.sgDue, P.sgDeferred, P.sgOwed, P.timePen, P.svcBreach]).toEqual([due, false, PEN.stopSeconds, 0, null]);
  });
  it('an entrance out of reach at the award is not the due one', () => {
    const { r, P, rival } = solo();
    place(P, T.PIT_IN0 - 3, INSIDE, 15);
    award(r, P, rival);
    expect(P.sgDue).toBe(r.apprLap(P) + 1);
  });
  it('ends penalty-only routing when served, with no extra pit visit', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    enterPit(r);
    expect(P.mode).toBe('pitlane'); expect(P.pitReq).toBe(false);
    const ev = serve(r);
    expect(ev.some((e) => e.type === 'served')).toBe(true);
    expect(P.sgOwed).toBe(0); expect(P.timePen).toBe(0);
    exitPit(r);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(false); expect(P.pitPenaltyOnly).toBe(false);
    enterPit(r);
    expect(P.mode).toBe('race');
  });
  it('ends the request if the penalty is served with it still flagged', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    serve(r);
    expect(P.sgOwed).toBe(0); expect(P.pitReq).toBe(false); expect(P.pitPenaltyOnly).toBe(false);
  });
  it('resumes on pit exit while the stop is still owed', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    r.requestLane(); // override is dropped by the pit visit
    const due = P.sgDue;
    enterPit(r);
    expect(P.mode).toBe('pitlane');
    expect(P.sgOwed).toBe(PEN.stopSeconds); // entering is not serving
    const ev = exitPit(r);
    expect(P.mode).toBe('race'); expect(P.sgOwed).toBe(PEN.stopSeconds); expect(msgs(ev)).toContain('msg.penStillOwed');
    expect(P.sgDue).toBe(due);
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(true); expect(P.laneOverride).toBe(false);
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toMatchObject({ to: OUTSIDE });
  });
  it('resumes after a tow that left the stop owed', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    place(P, 60, OUTSIDE, 0); P.fuel = 0;
    stepEvents(r, 1);
    expect(P.mode).toBe('tow'); expect(P.pitReq).toBe(false);
    P.fuel = 1; P.mode = 'pitlane';
    exitPit(r);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(true);
  });
  it('a missed deadline is never converted to a time penalty, and routing stays on so the stop can still be settled', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    P.sgDue = 3; P.sgDeferred = true;
    r.requestLane();
    const ev = crossLine(r, P, 3, INSIDE);
    expect(P.svcBreach).toBe('stopGo'); expect(msgs(ev)).toContain('msg.breachSg');
    expect(P.timePen).toBe(0); expect(P.sgOwed).toBe(PEN.stopSeconds);
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(true);
  });
  it('an offence on the cool-down lap arms nothing', () => {
    const { r, P, rival } = solo();
    P.crossed = 13; P.lapsDone = 12; P.sectors = 7;
    place(P, T.FINISH_S + 13 * T.L - 0.2, OUTSIDE, 10);
    stepEvents(r, 3, UP);
    expect(P.finished).toBe(true);
    award(r, P, rival);
    expect(P.sgOwed).toBe(PEN.stopSeconds); expect(P.pitReq).toBe(false);
    const ev = cross(r, T.PIT_IN0, OUTSIDE);
    expect(P.pitReq).toBe(false); expect(P.mode).toBe('race'); expect(msgs(ev)).not.toContain('msg.pitMissed');
  });
  it('a stale request cannot survive a finish that disqualifies', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    P.crossed = 13; P.lapsDone = 12; P.sectors = 7;
    place(P, T.FINISH_S + 13 * T.L - 0.2, OUTSIDE, 10);
    stepEvents(r, 3, UP);
    expect(P.finished).toBe(true); expect(P.status).toBe('dq'); expect(P.sgOwed).toBe(PEN.stopSeconds);
    expect(P.pitReq).toBe(false); expect(P.pitPenaltyOnly).toBe(false);
    stepEvents(r, 3, UP);
    expect(P.pitReq).toBe(false);
  });
});

describe('voluntary request overlapping a stop-and-go', () => {
  it('keeps the optional fuel stop when the penalty is served, and routing carries on for it', () => {
    const { r, P, rival } = solo();
    r.requestPit();
    award(r, P, rival);
    expect(P.pitPenaltyOnly).toBe(false); expect(P.fuelReq).toBe(true);
    serve(r);
    expect(P.sgOwed).toBe(0);
    // serve() puts the car in the box by script, with no pit entry: the optional request was never consumed and carries on alone
    place(P, 60, INSIDE, 10);
    stepEvents(r, 1, UP);
    expect(P.fuelReq).toBe(true); expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(false);
    expect(r.nextRoute(P)).toMatchObject({ to: OUTSIDE });
  });
  it('one visit settles both, and the penalty alone resumes if it stays owed', () => {
    const { r, P, rival } = solo();
    r.requestPit();
    award(r, P, rival);
    enterPit(r);
    expect(P.mode).toBe('pitlane'); expect(P.pitReq).toBe(false);
    exitPit(r);
    expect(P.sgOwed).toBeGreaterThan(0);
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(true);
    enterPit(r);
    serve(r);
    expect(P.sgOwed).toBe(0); expect(P.pitReq).toBe(false);
  });
  it('P adds a fuel stop to an owed penalty and P again drops it, never cancelling the penalty route', () => {
    const { r, P, rival } = solo();
    award(r, P, rival);
    r.requestPit();
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(false); expect(P.fuelReq).toBe(true);
    expect(msgs(r.events)).toEqual(['msg.pitRequired', 'msg.pitFuelToo']);
    r.events.length = 0;
    r.requestPit();
    expect(P.pitReq).toBe(true); expect(P.pitPenaltyOnly).toBe(true); expect(P.fuelReq).toBe(false);
    expect(msgs(r.events)).toEqual(['msg.pitRequired']);
    expect(P.sgOwed).toBe(PEN.stopSeconds);
  });
  it('cancelling the fuel stop after the penalty is served ends routing normally', () => {
    const { r, P, rival } = solo();
    r.requestPit();
    award(r, P, rival);
    P.sgOwed = 0; P.sgDue = 0;
    r.events.length = 0;
    r.requestPit();
    expect(P.pitReq).toBe(false); expect(msgs(r.events)).toContain('msg.pitCancelled');
  });
  it('an override survives while the fuel stop keeps routing active', () => {
    const { r, P, rival } = solo();
    r.requestPit(); r.requestLane();
    award(r, P, rival);
    P.sgOwed = 0; P.sgDue = 0;
    expect(P.laneOverride).toBe(true);
    crossSwitch(r, 0, INSIDE);
    expect(P.change).toBeNull();
  });
});

describe('AI is not assisted', () => {
  it('drops its own request on a miss and is never routed', () => {
    const r = fresh();
    r.cars.splice(2);
    const B = r.cars[1];
    place(r.player, 60, INSIDE, 0);
    expect(r.pitAssist(B)).toBe(false);
    B.pitReq = true;
    expect(r.nextRoute(B)).toBeNull();
    B.offences = 2; r.offence(B, r.player, 'rear');
    expect(B.pitPenaltyOnly).toBe(false);
  });
});

describe('HUD route text', () => {
  it('names all four outcomes, including staying in the current lane', () => {
    const { r, P } = solo();
    r.requestPit();
    const chip = (side: number) => { place(P, 20, side, 0); return routeChipId(r.nextRoute(P)!); };
    expect(chip(INSIDE)).toBe('hud.routeOutsideMove');
    expect(chip(OUTSIDE)).toBe('hud.routeOutsideStay');
    r.requestLane();
    expect(chip(INSIDE)).toBe('hud.routeInsideStay');
    expect(chip(OUTSIDE)).toBe('hud.routeInsideMove');
    for (const id of ['hud.routeOutsideMove', 'hud.routeOutsideStay', 'hud.routeInsideMove', 'hud.routeInsideStay', 'hud.pitFuelToo', 'msg.routeInside', 'msg.routeOutside', 'msg.routeBlocked', 'msg.pitFuelToo']) expect(t(id)).not.toBe(id);
  });
  it('reads the lane a committed change will end in', () => {
    const { r, P } = solo();
    r.requestPit();
    place(P, 20, OUTSIDE, 0);
    P.change = { from: OUTSIDE, to: INSIDE, s0: 19, s1: 19 + T.SWITCH_LEN };
    expect(r.nextRoute(P)).toMatchObject({ to: OUTSIDE, stay: false });
  });
});
