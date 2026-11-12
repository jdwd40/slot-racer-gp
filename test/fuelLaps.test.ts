// Laps of fuel left on the HUD (#87): the pure estimator in src/fuelLaps.ts. docs/fuel-laps.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { LAPS, fuelRate, type Car } from '../src/race';
import {
  FuelLapsEstimator, SteadyFigure, fuelLapsVisible, fuelWarning, lapsToFlag,
  FALLBACK_BURN, SNAP_EPS, MIN_SAMPLE_LAPS, SHOW_EVERY, type FuelLapsReading,
} from '../src/fuelLaps';
import { mirrorRace, applySnapshot } from '../src/net/mirror';
import { wireRounded } from '../src/net/snapwire';
import { fresh, seedRandom, DT } from './helpers';

const L = 120;
const nominal = fuelRate(L);

/**
 * A scripted car driving the race core's burn rule (fuel -= |v| dt fuelRate(L) mult, src/race.ts), one reading every `dt`.
 * `q` rounds what the estimator is fed the way an online snapshot does (fuel and u to 3 decimals, a tank above 0 never 0).
 */
class Drive {
  fuel = 1; u = 23; now = 0;
  constructor(readonly est = new FuelLapsEstimator(), readonly q = false) {}
  feed(): FuelLapsReading {
    const r3 = (x: number): number => Math.round(x * 1000) / 1000;
    const fuel = this.q ? (this.fuel > 0 && r3(this.fuel) === 0 ? SNAP_EPS : r3(this.fuel)) : this.fuel;
    return this.est.update({ fuel, u: this.q ? r3(this.u) : this.u, L, now: this.q ? r3(this.now) : this.now });
  }
  /** drive `laps` of distance at burn multiplier `mult` and speed `v` */
  run(laps: number, mult: number, v = 20, dt = 1 / 60): FuelLapsReading {
    let r = this.feed();
    const steps = Math.round((laps * L) / (v * dt));
    for (let i = 0; i < steps; i++) {
      this.u += v * dt; this.now += dt;
      this.fuel = Math.max(0, this.fuel - v * dt * nominal * mult);
      r = this.feed();
    }
    return r;
  }
  /** stand still for `sec` (a bay), refuelling at `rate` tank/s */
  stand(sec: number, rate = 0, dt = 1 / 60): FuelLapsReading {
    let r = this.feed();
    for (let i = 0; i < Math.round(sec / dt); i++) { this.now += dt; this.fuel = Math.min(1, this.fuel + rate * dt); r = this.feed(); }
    return r;
  }
}
/** what laps-left should read at a known burn multiplier */
const exact = (fuel: number, mult: number): number => fuel / (nominal * mult * L);

describe('laps of fuel left (#87): fallback', () => {
  it('before any measurement a full tank reads 7.4 / 1.1 = 6.73 laps (fuelRate(L) x FALLBACK_BURN)', () => {
    expect(FALLBACK_BURN).toBe(1.1);
    const r = new FuelLapsEstimator().update({ fuel: 1, u: 23, L, now: 0 });
    expect(r.source).toBe('fallback');
    expect(r.laps).toBeCloseTo(7.4 / 1.1, 6);
    expect(r.laps.toFixed(2)).toBe('6.73');
    expect(r.burnPerDistance).toBeCloseTo(nominal * 1.1, 12);
    // and on any lap length: the figure is in laps, so it does not depend on L
    expect(new FuelLapsEstimator().update({ fuel: 1, u: 0, L: 333, now: 0 }).laps).toBeCloseTo(7.4 / 1.1, 6);
  });

  it('stays on the fallback until half a lap has been measured, then switches to the observed rate', () => {
    const d = new Drive();
    expect(d.run(0.45, 0.5).source).toBe('fallback');
    expect(d.run(0.1, 0.5).source).toBe('observed');
    expect(d.est.stintDist).toBeGreaterThanOrEqual(MIN_SAMPLE_LAPS * L);
  });

  it('the grid and countdown (standing, clock still) read the fallback on the current tank', () => {
    const e = new FuelLapsEstimator();
    for (let i = 0; i < 200; i++) expect(e.update({ fuel: 1, u: 21.7, L, now: 0 }).laps).toBeCloseTo(7.4 / 1.1, 6);
  });
});

describe('observed rate', () => {
  it('coasting (x0.5) and full throttle (x1.2) each read fuel / (rate * L), tightly', () => {
    const coast = new Drive(); const rc = coast.run(1, 0.5);
    expect(rc.source).toBe('observed');
    expect(rc.burnPerDistance / nominal).toBeCloseTo(0.5, 3);
    expect(rc.laps).toBeCloseTo(exact(coast.fuel, 0.5), 2);
    const attack = new Drive(); const ra = attack.run(1, 1.2);
    expect(ra.burnPerDistance / nominal).toBeCloseTo(1.2, 3);
    expect(ra.laps).toBeCloseTo(exact(attack.fuel, 1.2), 2);
    // lift-and-coast reads more laps left than an attack from the same tank, even with less fuel left
    expect(rc.laps).toBeGreaterThan(ra.laps * 2);
  });

  it('a change of style shows within about a lap (rolling window, not a stint average)', () => {
    const d = new Drive();
    d.run(3, 1.2);
    const r = d.run(1.25, 0.5);
    expect(r.burnPerDistance / nominal).toBeCloseTo(0.5, 2);
  });

  it('a tiny backward move (the 1.6 m marshal re-slot) adds no distance and does not resync', () => {
    const d = new Drive();
    d.run(0.3, 1);
    d.u -= 1.6; d.now += 1 / 60; d.feed();
    expect(d.est.resyncs).toBe(0);
    const r = d.run(0.3, 1);
    expect(r.source).toBe('observed');
    expect(r.burnPerDistance / nominal).toBeCloseTo(1, 2);
  });

  it('reading the same state again (paused, or a render frame between two snapshots) changes nothing', () => {
    const d = new Drive();
    const a = d.run(0.6, 1);
    for (let i = 0; i < 50; i++) expect(d.feed()).toEqual(a);
  });
});

describe('refill', () => {
  it('a mid-stint refill resets the stint, keeps the previous observed rate and never records negative burn', () => {
    const d = new Drive();
    expect(d.run(1, 1.2).source).toBe('observed');
    // an in-lap at a very different rate, shorter than a chunk, then the stop: not stored as a sample
    const before = d.run(0.2, 0.5);
    expect(before.burnPerDistance / nominal).toBeCloseTo(1.2, 2);
    const rates: number[] = [];
    for (let i = 0; i < 300; i++) { d.now += 1 / 60; d.fuel = Math.min(1, d.fuel + 0.2 / 60); const r = d.feed(); rates.push(r.burnPerDistance); expect(r.laps).toBeGreaterThan(0); }
    const after = d.feed();
    expect(d.est.refills).toBe(1);
    expect(d.est.stintDist).toBe(0);
    expect(after.source).toBe('previous');
    expect(after.burnPerDistance).toBe(before.burnPerDistance);
    expect(rates.every((x) => x === before.burnPerDistance)).toBe(true);
    // based on the new tank and the kept rate: no spike
    expect(after.laps).toBeCloseTo(d.fuel / (before.burnPerDistance * L), 9);
    // the new stint takes over after half a lap of its own
    d.run(0.3, 0.5);
    expect(d.feed().source).toBe('previous');
    const own = d.run(0.3, 0.5);
    expect(own.source).toBe('observed');
    expect(own.burnPerDistance / nominal).toBeCloseTo(0.5, 2);
    expect(own.burnPerDistance).toBeGreaterThan(0);
  });

  it('a refill before any measurement stays on the fallback', () => {
    const d = new Drive();
    d.run(0.3, 1);
    const r = d.stand(2, 0.2);
    expect(d.est.refills).toBe(1);
    expect(r.source).toBe('fallback');
    expect(r.laps).toBeCloseTo(d.fuel / (nominal * FALLBACK_BURN * L), 9);
  });

  it('a slow top-up that rises under 0.001 per reading is still one refill (judged against the lowest reading)', () => {
    const d = new Drive();
    d.run(1, 1.2);
    for (let i = 0; i < 400; i++) { d.now += 1 / 240; d.fuel += 0.0008; d.feed(); }
    expect(d.est.refills).toBe(1);
    expect(d.est.stintDist).toBe(0);
  });
});

describe('visibility and the empty tank', () => {
  const base = { practice: false, finished: false, status: 'running', phase: 'racing' };
  it('shown on the grid, in the countdown and racing; hidden in practice, when finished, out of the race, or after the flag', () => {
    expect(fuelLapsVisible(base)).toBe(true);
    expect(fuelLapsVisible({ ...base, phase: 'countdown' })).toBe(true);
    expect(fuelLapsVisible({ ...base, practice: true })).toBe(false);
    expect(fuelLapsVisible({ ...base, finished: true })).toBe(false);
    expect(fuelLapsVisible({ ...base, status: 'dq' })).toBe(false);
    expect(fuelLapsVisible({ ...base, status: 'dnf' })).toBe(false);
    expect(fuelLapsVisible({ ...base, phase: 'done' })).toBe(false);
  });

  it('an empty tank in a live race reads 0.0, shown at once, and red', () => {
    const d = new Drive();
    d.run(1, 1.2);
    d.fuel = 0; d.now += 1 / 60;
    const r = d.feed();
    expect(r.laps).toBe(0);
    const fig = new SteadyFigure();
    fig.show(2.5, d.now - 0.1);
    expect(fig.show(r.laps, d.now)).toBe('0.0');
    expect(fuelWarning(0, 1.5)).toBe('low');
    // the fallback on an empty tank is 0 too, never negative
    expect(new FuelLapsEstimator().update({ fuel: 0, u: 0, L, now: 0 }).laps).toBe(0);
    expect(new FuelLapsEstimator().update({ fuel: -0.01, u: 0, L, now: 0 }).laps).toBe(0);
  });
});

describe('warning', () => {
  it('none above the laps to the flag; short (orange) below it but >= 1; low (red) under 1.0', () => {
    expect(fuelWarning(4.2, 3.6)).toBe('none');
    expect(fuelWarning(3.6, 3.6)).toBe('none');
    expect(fuelWarning(3.4, 3.6)).toBe('short');
    expect(fuelWarning(1.0, 3.6)).toBe('short');
    expect(fuelWarning(0.9, 3.6)).toBe('low');
    expect(fuelWarning(0.9, 0.5)).toBe('low');
  });
});

describe('online quantisation and reconnects', () => {
  it('a 0.001 fuel flicker is not a refill and does not move the figure', () => {
    const d = new Drive();
    const r0 = d.run(1, 1);
    for (let i = 0; i < 40; i++) {
      d.now += 0.05;
      const up = d.est.update({ fuel: d.fuel + (i % 2 ? SNAP_EPS : 0), u: d.u, L, now: d.now });
      expect(up.source).toBe('observed');
      expect(up.burnPerDistance).toBe(r0.burnPerDistance);
    }
    expect(d.est.refills).toBe(0);
  });

  it('3-decimal readings at 20 Hz (or each repeated over 3 render frames) track the true rate within 1%', () => {
    for (const mult of [0.5, 1, 1.2]) {
      const d = new Drive(new FuelLapsEstimator(), true);
      const r = d.run(1.5, mult, 22, 1 / 20);
      expect(Math.abs(r.burnPerDistance / nominal / mult - 1)).toBeLessThan(0.01);
      expect(d.est.refills).toBe(0);
    }
  });

  it('a big pose and fuel jump (reconnect, missed snapshots) resyncs and does not poison the average', () => {
    const d = new Drive();
    d.run(0.4, 1);
    // 6 s gone: 130 m further on and 0.2 of a tank less, both unseen
    d.u += 130; d.now += 6; d.fuel -= 0.2;
    d.feed();
    expect(d.est.resyncs).toBe(1);
    const r = d.run(0.4, 1);
    expect(r.source).toBe('observed');
    expect(r.burnPerDistance / nominal).toBeCloseTo(1, 2);
    expect(d.est.refills).toBe(0);
  });

  it('a pose jump without a clock gap (tow, stopped-on-track recovery) and an unexplained fuel drop resync too', () => {
    const d = new Drive();
    d.run(0.3, 1);
    d.u += 60; d.now += 1 / 60; d.feed();               // towed forward to the bay
    d.run(0.1, 1);
    d.u -= 45; d.now += 1 / 60; d.feed();               // recovered back to the bay
    d.run(0.1, 1);
    d.fuel -= 0.05; d.now += 1 / 60; d.feed();          // fuel gone with no distance
    expect(d.est.resyncs).toBe(3);
    const r = d.run(0.2, 1);
    expect(r.source).toBe('observed');
    expect(r.burnPerDistance / nominal).toBeCloseTo(1, 2);
  });
});

describe('outliers', () => {
  it('a stretch at an implied 3x or 0.1x of nominal is ignored', () => {
    const d = new Drive();
    expect(d.run(1, 1).burnPerDistance / nominal).toBeCloseTo(1, 3);
    // (the chunk that straddles the change mixes both rates and may be kept: within 2%, where taking the 3x stretch would read ~2x)
    expect(Math.abs(d.run(0.5, 3).burnPerDistance / nominal - 1)).toBeLessThan(0.02);
    expect(Math.abs(d.run(0.5, 0.1).burnPerDistance / nominal - 1)).toBeLessThan(0.02);
  });

  it('a stint made only of outliers keeps the fallback', () => {
    const d = new Drive();
    expect(d.run(1, 3).source).toBe('fallback');
    const d2 = new Drive();
    expect(d2.run(1, 0.1).source).toBe('fallback');
  });
});

describe('laps to the flag', () => {
  beforeEach(() => seedRandom(87));
  afterEach(() => vi.restoreAllMocks());

  it('matches Race.fuelToFinish() distance / L (without PLAN_BURN 1.25) after the first crossing', () => {
    const r = fresh();
    const c = r.cars[0];
    for (const [lapsDone, pos] of [[0, 3], [4, 0.2], [7, 60], [12, T.L - 0.5]] as const) {
      c.lapsDone = lapsDone; c.crossed = lapsDone + 1;
      const s = T.wrapS(T.FINISH_S + pos);
      const dist = r.fuelToFinish(c as Car, s) / (r.fuelRate() * 1.25);
      expect(lapsToFlag(LAPS, lapsDone, T.ahead(T.FINISH_S, s), T.L, c.crossed)).toBeCloseTo(dist / T.L, 9);
    }
  });

  it('includes the rest of the current lap, and on the grid (not yet over the line) the run-up as well', () => {
    expect(lapsToFlag(13, 10, 0.25 * L, L)).toBeCloseTo(2.75, 9);
    expect(lapsToFlag(13, 13, 0, L)).toBe(0);
    // grid slot 1.3 m behind the line: the whole race plus 1.3 m
    expect(lapsToFlag(13, 0, L - 1.3, L, 0)).toBeCloseTo(13 + 1.3 / L, 9);
  });
});

describe('steady figure', () => {
  it('one decimal, and a new value at most every SHOW_EVERY seconds of race clock', () => {
    const f = new SteadyFigure();
    expect(f.show(3.4149, 10)).toBe('3.4');
    expect(f.show(3.38, 10.1)).toBe('3.4');
    expect(f.show(3.26, 10.2)).toBe('3.4');
    expect(f.show(3.26, 10 + SHOW_EVERY)).toBe('3.3');
    // a clock that goes back (a new race) shows at once
    expect(f.show(6.73, 1)).toBe('6.7');
    f.reset();
    expect(f.show(5.04, 1.1)).toBe('5.0');
  });
});

describe('real race core, offline and through the online mirror', () => {
  beforeEach(() => seedRandom(87));
  afterEach(() => vi.restoreAllMocks());

  it('predicts the next lap of burn of a real AI car, and the 20 Hz 3-decimal mirror reads the same', () => {
    const r = fresh();
    for (const c of r.cars) c.pitPlan = false;
    const car = r.cars[0];
    const mirror = mirrorRace(wireRounded(r.snapshot()));
    const off = new FuelLapsEstimator(), on = new FuelLapsEstimator();
    let a: FuelLapsReading | null = null, b: FuelLapsReading | null = null, lapFuel = 0, lapsAt = -1;
    let predicted = 0;
    for (let step = 0; step < 60 * 200 && car.lapsDone < 4; step++) {
      r.update(DT, {});
      // the server broadcasts every third 1/60 s step; the client reads its mirror every render frame
      if (step % 3 === 0) applySnapshot(mirror, wireRounded(r.snapshot()));
      const mc = mirror.car(car.id)!;
      a = off.update({ fuel: car.fuel, u: car.u, L: r.T.L, now: r.raceTime });
      b = on.update({ fuel: mc.fuel, u: mc.u, L: mirror.T.L, now: mirror.raceTime });
      if (car.lapsDone !== lapsAt) {
        // at the line ending lap 3, the burn per lap the estimate implies; one lap later, what was burnt
        if (car.lapsDone === 3) predicted = car.fuel / a.laps;
        if (car.lapsDone === 4) expect(Math.abs((lapFuel - car.fuel) / predicted - 1)).toBeLessThan(0.05);
        lapsAt = car.lapsDone; lapFuel = car.fuel;
      }
    }
    expect(car.lapsDone).toBe(4);
    expect(predicted).toBeGreaterThan(0);
    expect(a!.source).toBe('observed');
    expect(b!.source).toBe('observed');
    expect(Math.abs(b!.laps / a!.laps - 1)).toBeLessThan(0.02);
    expect(on.refills).toBe(0);
  });
});
