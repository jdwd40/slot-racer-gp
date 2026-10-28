// Lap counting, finishing and lap validity.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { LAPS, RaceEvent } from '../src/race';
import { fresh, place, park, stepEvents, seedRandom, UP, DT } from './helpers';

beforeEach(() => seedRandom(3));
afterEach(() => vi.restoreAllMocks());

const laps = (ev: RaceEvent[]) => ev.filter((e): e is Extract<RaceEvent, { type: 'lap' }> => e.type === 'lap');

describe('lap counting', () => {
  it('emits exactly one lap event per timing-line crossing', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = 1; P.lapStartT = 0; P.sectors = 7; P.lapValid = true;
    place(P, T.FINISH_S + T.L - 0.5, 1, 10);
    const ev = stepEvents(r, 60, UP);
    expect(laps(ev)).toHaveLength(1);
    expect(P.crossed).toBe(2); expect(P.lapsDone).toBe(1);
    expect(laps(ev)[0].lapsDone).toBe(1);
  });

  it('interpolates the crossing time to sub-step precision', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = 1; P.lapStartT = 0; P.sectors = 7;
    place(P, T.FINISH_S + T.L - 0.15, 1, 12);
    const before = r.raceTime;
    const ev = stepEvents(r, 1, UP);
    expect(laps(ev)).toHaveLength(1);
    const lt = laps(ev)[0].time;
    expect(lt).toBeGreaterThan(before);
    expect(lt).toBeLessThan(before + DT);
    expect(P.lapStartT).toBeCloseTo(lt, 9);
  });

  it('finishes the race on the last lap and ends the session shortly after the player finishes', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = LAPS; P.lapsDone = LAPS - 1; P.lapStartT = 0; P.sectors = 7;
    place(P, T.FINISH_S + LAPS * T.L - 0.5, 1, 10);
    const ev = stepEvents(r, 10, UP);
    expect(P.finished).toBe(true);
    expect(P.lapsDone).toBe(LAPS);
    expect(ev.some((e) => e.type === 'finish' && e.car === P)).toBe(true);
    expect(r.phase).toBe('racing');
    stepEvents(r, 60 * 4, UP);
    expect(r.phase).toBe('done');
    expect(P.lapsDone).toBe(LAPS); // no laps counted after the flag
  });

  it('never finishes in practice', () => {
    const r = fresh('circuit-1', { practice: true }); park(r);
    const P = r.player; P.isPlayer = true;
    expect(r.cars).toHaveLength(1);
    P.crossed = LAPS; P.lapsDone = LAPS - 1; P.lapStartT = 0; P.sectors = 7;
    place(P, T.FINISH_S + LAPS * T.L - 0.5, 1, 10);
    stepEvents(r, 10, UP);
    expect(P.finished).toBe(false);
    expect(P.lapsDone).toBe(LAPS);
  });
});

describe('lap validity', () => {
  it('marks a lap invalid when the sectors were not passed in order', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = 1; P.lapStartT = 0; P.sectors = 0; P.lapValid = true;
    place(P, T.FINISH_S + T.L - 0.5, 1, 10);
    const ev = stepEvents(r, 60, UP);
    expect(laps(ev)[0].valid).toBe(false);
    expect(laps(ev)[0].best).toBe(false);
    expect(P.bestLap).toBe(0);
  });

  it('does not let a collision-affected lap set a best time', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = 1; P.lapStartT = 0; P.sectors = 7; P.lapValid = false;
    place(P, T.FINISH_S + T.L - 0.5, 1, 10);
    const ev = stepEvents(r, 60, UP);
    expect(laps(ev)[0].valid).toBe(false);
    expect(P.bestLap).toBe(0);
    expect(P.lastLap).toBeGreaterThan(0);
  });

  it('records a clean lap as the best lap', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    P.crossed = 1; P.lapStartT = 0; P.sectors = 7; P.lapValid = true;
    place(P, T.FINISH_S + T.L - 0.5, 1, 10);
    const ev = stepEvents(r, 60, UP);
    expect(laps(ev)[0].valid).toBe(true);
    expect(laps(ev)[0].best).toBe(true);
    expect(P.bestLap).toBeGreaterThan(0);
    expect(P.lapValid).toBe(true); // fresh lap starts valid
    expect(P.sectors).toBe(0);
  });

  it('invalidates the lap on a de-slot and on entering the pits', () => {
    const r = fresh(); park(r);
    const P = r.player; P.isPlayer = true;
    place(P, 40, 1, 10); P.lapValid = true;
    r.deslot(P);
    expect(P.lapValid).toBe(false); expect(P.mode).toBe('off');

    const Q = r.cars[1]; Q.isPlayer = true; Q.lapValid = true;
    place(Q, T.PIT_IN0 - 0.5, -1, 10); Q.pitReq = true;
    stepEvents(r, 6, UP);
    expect(Q.mode).toBe('pitlane'); expect(Q.lapValid).toBe(false);
  });
});
