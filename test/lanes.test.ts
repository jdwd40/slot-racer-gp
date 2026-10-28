// Lane-change requests, switch locations, gap checks and pit entry.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { PEN } from '../src/race';
import { fresh, place, park, stepEvents, msgs, seedRandom, UP } from './helpers';

beforeEach(() => seedRandom(5));
afterEach(() => vi.restoreAllMocks());

describe('lane change requests', () => {
  it('toggles the request and reports it', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    r.requestLane(); expect(P.laneReq).toBe(true); expect(msgs(r.events)).toContain('msg.laneReady');
    r.events.length = 0;
    r.requestLane(); expect(P.laneReq).toBe(false); expect(msgs(r.events)).toContain('msg.laneCancelled');
  });

  it('only executes when the car crosses the start of a switch', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    const sw = T.SWITCHES[0];
    place(P, sw.s0 - 8, 1, 10); P.laneReq = true;
    stepEvents(r, 10, UP); // still short of the switch
    expect(P.change).toBeNull(); expect(P.laneReq).toBe(true);
    let ev: ReturnType<typeof stepEvents> = [];
    for (let i = 0; i < 240 && P.change === null; i++) ev.push(...stepEvents(r, 1, UP));
    expect(P.change).not.toBeNull();
    expect(P.change!.s0).toBe(sw.s0); expect(P.change!.to).toBe(-1);
    expect(msgs(ev)).toContain('msg.laneGo');
    expect(P.laneReq).toBe(false);
    // the change takes the length of the switch section and then marks a cut-in window
    for (let i = 0; i < 240 && P.change !== null; i++) stepEvents(r, 1, UP);
    expect(P.change).toBeNull(); expect(P.laneSide).toBe(-1);
    expect(P.d).toBeCloseTo(-T.LANE_HALF, 6);
  });

  it('sets the cut-in window when the change completes', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    const sw = T.SWITCHES[0];
    place(P, sw.s0 - 0.2, 1, 10); P.laneReq = true;
    for (let i = 0; i < 120 && P.change === null; i++) stepEvents(r, 1, UP);
    for (let i = 0; i < 240 && P.change !== null; i++) stepEvents(r, 1, UP);
    expect(P.change).toBeNull();
    expect(P.cutT).toBeGreaterThan(PEN.cutInWindow - 0.1);
  });

  it('refuses the change when the target lane is occupied alongside', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true; const O = r.cars[1];
    const sw = T.SWITCHES[0];
    place(P, sw.s0 - 0.2, 1, 10); P.laneReq = true;
    place(O, sw.s0 - 0.2 + 0.5, -1, 10); // half a car ahead in the other lane
    const ev = stepEvents(r, 3, UP);
    expect(P.change).toBeNull(); expect(P.laneReq).toBe(false);
    expect(msgs(ev)).toContain('msg.laneBlocked');
  });

  it('judges the gap with closing-speed margins', () => {
    const r = fresh(); park(r);
    const P = r.player, O = r.cars[1];
    place(P, 60, 1, 20); place(O, 60 + T.CAR_LEN + 0.6, -1, 20);
    expect(r.laneClear(P, -1)).toBe(true);  // same speed: just over a car length is enough
    place(O, 60 + T.CAR_LEN + 0.6, -1, 10);
    expect(r.laneClear(P, -1)).toBe(false); // closing at 10 m/s: not enough
    place(O, 60 - 30, -1, 20);
    expect(r.laneClear(P, -1)).toBe(true);  // far behind
    place(O, 60 - 3, -1, 24);
    expect(r.laneClear(P, -1)).toBe(false); // close behind and faster
  });
});

describe('pit entry', () => {
  it('requires the outside lane', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    place(P, T.PIT_IN0 - 0.5, 1, 10); P.pitReq = true;
    let ev = stepEvents(r, 6, UP);
    expect(P.mode).toBe('race'); expect(P.pitReq).toBe(false); expect(msgs(ev)).toContain('msg.pitMissed');

    park(r); place(P, T.PIT_IN0 - 0.5, -1, 10); P.pitReq = true;
    ev = stepEvents(r, 6, UP);
    expect(P.mode).toBe('pitlane'); expect(msgs(ev)).toContain('msg.pitIn');
    expect(P.v).toBeLessThanOrEqual(T.PIT_SPEED + 0.01);
  });

  it('limits speed in the pit lane and rejoins on the outside lane', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    place(P, T.PIT_IN0 - 0.5, -1, 10); P.pitReq = true;
    stepEvents(r, 6, UP);
    expect(P.mode).toBe('pitlane');
    let maxV = 0;
    for (let i = 0; i < 60 * 8 && P.mode !== 'race'; i++) { stepEvents(r, 1, UP); if (P.mode === 'pitlane') maxV = Math.max(maxV, P.v); }
    expect(maxV).toBeLessThanOrEqual(T.PIT_SPEED + 0.01);
    expect(P.mode).toBe('race'); expect(P.laneSide).toBe(-1);
    expect(P.graceT).toBeGreaterThan(0);
    expect(r.s(P)).toBeGreaterThanOrEqual(T.PIT_OUT1);
  });
});
