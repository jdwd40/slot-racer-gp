// Every circuit builds a closed loop with sane geometry, and an all-AI race on each stays numerically sound.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Race, LAPS, VMAX, AI_GRIP } from '../src/race';
import { seedRandom, NONE, DT } from './helpers';

beforeEach(() => seedRandom(11));
afterEach(() => vi.restoreAllMocks());

const ids = T.TRACKS.map((d) => d.id);
const MODES = ['grid', 'race', 'pitlane', 'bayIn', 'service', 'bayOut', 'off', 'tow'];

describe.each(ids)('%s geometry', (id) => {
  it('closes the loop and keeps the pit lane on the main straight', () => {
    T.setTrack(id);
    expect(T.DEF.id).toBe(id);
    expect(T.L).toBeGreaterThan(100); expect(Number.isFinite(T.L)).toBe(true);
    const a = T.center(0), b = T.center(T.L - 1e-6);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.01);
    const dh = ((b.h - a.h) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    expect(Math.min(dh, 2 * Math.PI - dh)).toBeLessThan(0.01);
    expect(T.MAIN_LEN).toBeGreaterThan(T.PIT_OUT1 + 2);
    expect(T.SEGS[0].kind).toBe('S');
  });
  it('places switches on straights, outside the single-file section and clear of each other', () => {
    T.setTrack(id);
    expect(T.SWITCHES.length).toBeGreaterThanOrEqual(4);
    const sorted = [...T.SWITCHES].sort((p, q) => p.s0 - q.s0);
    for (let i = 0; i < sorted.length; i++) {
      const sw = sorted[i];
      expect(sw.s0).toBeGreaterThanOrEqual(0); expect(sw.s1).toBeLessThanOrEqual(T.L);
      for (let s = sw.s0; s <= sw.s1; s += 0.5) expect(T.curvature(s)).toBe(0);
      // lanes are narrowed to single file between SQ_Q0 and SQ_Q2; a switch must not run through it
      // (two circuits deliberately put a switch on the approach or exit ramp, which the AI defend logic treats specially)
      expect(sw.s1 <= T.SQ_Q0 || sw.s0 >= T.SQ_Q2).toBe(true);
      if (i) expect(sw.s0).toBeGreaterThanOrEqual(sorted[i - 1].s1);
    }
  });
  it('builds finite AI speed profiles within the speed limit', () => {
    T.setTrack(id);
    for (const side of [-1, 1]) {
      const p = T.buildProfile(side, AI_GRIP, VMAX, 20);
      expect(p.length).toBe(Math.ceil(T.L / T.PROFILE_STEP));
      for (const v of p) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(3); expect(v).toBeLessThanOrEqual(VMAX); }
      expect(Math.min(...p)).toBeLessThan(VMAX); // at least one corner slows the car
    }
  });
  it('reports finite surface heights and banking everywhere', () => {
    T.setTrack(id);
    for (let s = 0; s < T.L; s += 0.5) {
      const p = T.point3(s, T.LANE_HALF);
      for (const v of [p.x, p.y, p.z, p.h, T.slopeZ(s), T.rollAt(s), T.gripScale(s)]) expect(Number.isFinite(v)).toBe(true);
      expect(T.gripScale(s)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe.each(ids)('%s all-AI simulation', (id) => {
  it('runs 90 s with every car in a valid state and making progress', () => {
    T.setTrack(id);
    const r = new Race();
    r.player.isPlayer = false;
    const startU = r.cars.map((c) => c.u);
    let n = 0;
    for (let t = 0; t < 90; t += DT) {
      r.update(DT, NONE);
      if (++n % 10) { r.events.length = 0; continue; }
      for (const e of r.events) expect(['msg', 'bump', 'deslot', 'switch', 'lap', 'finish', 'tow', 'offence', 'served', 'timePen', 'go', 'light']).toContain(e.type);
      r.events.length = 0;
      for (const c of r.cars) {
        for (const v of [c.u, c.v, c.d, c.x, c.y, c.z, c.h, c.fuel, c.slip]) expect(Number.isFinite(v)).toBe(true);
        expect(c.v).toBeGreaterThanOrEqual(0); expect(c.v).toBeLessThanOrEqual(VMAX + 0.5);
        expect(c.fuel).toBeGreaterThanOrEqual(0); expect(c.fuel).toBeLessThanOrEqual(1);
        expect(MODES).toContain(c.mode);
        expect(Math.abs(c.d)).toBeLessThanOrEqual(Math.abs(T.BAY_D) + 0.01);
      }
    }
    expect(r.phase).toBe('racing');
    for (const c of r.cars) {
      expect(c.u - startU[c.idx]).toBeGreaterThan(T.L); // at least one lap in 90 s
      expect(c.lapsDone).toBeGreaterThanOrEqual(1);
      expect(c.lapsDone).toBeLessThan(LAPS);
      expect(c.lapsDone).toBe(Math.max(0, c.crossed - 1));
    }
  });
});

describe('full race', () => {
  it('completes a 13-lap race on Clubman Park with a consistent classification', () => {
    T.setTrack('circuit-1');
    const r = new Race();
    r.player.isPlayer = false;
    let t = 0;
    while (r.phase !== 'done' && t < 900) { r.update(DT, NONE); r.events.length = 0; t += DT; }
    expect(r.phase).toBe('done');
    const res = r.results();
    expect(res.filter((x) => !x.est).length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < res.length; i++) expect(res[i].time).toBeGreaterThanOrEqual(res[i - 1].time);
    for (const c of r.cars.filter((c) => c.finished)) {
      expect(c.lapsDone).toBe(LAPS);
      expect(c.finishTime).toBeGreaterThan(0); expect(c.finishTime).toBeLessThanOrEqual(r.raceTime);
      expect(c.bestLap).toBeGreaterThan(0);
      expect(c.sgOwed).toBe(0); // nothing left outstanding after the flag
      expect(c.pitStops).toBeGreaterThanOrEqual(1); // a 13-lap race needs fuel
    }
    expect(r.order()[0]).toBe(res[0].car);
  });
});
