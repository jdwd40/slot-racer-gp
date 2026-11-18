// Car setups (#133) in the race core and local records: the preset table, Balanced unchanged, per-car physics with no
// shared globals, the AI and automatic pit service planning with each car's own limits, the limits every setup shares,
// a mixed field's determinism, the online mirror, and setup-aware boards, ghosts and championship saves. docs/car-setup.md.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as T from '../src/track';
import { ACC, AI_GRIP, BRAKE, DRAG, GRIP, Race, REV_CAP, VMAX, holdThrottle, profKey, wireEvent, type Car, type Controls, type RosterEntry } from '../src/race';
import { CAR_SETUPS, DEFAULT_SETUP, SETUP_IDS, SETUP_SET, carSetup, currentTag, isCurrentTag, knowsSetup, recordTag, setupOr, type SetupId } from '../src/carSetup';
import { applySnapshot, mirrorRace } from '../src/net/mirror';
import { SnapDecoder, SnapEncoder } from '../src/net/snapwire';
import * as R from '../src/records';
import { DT, NONE, memStorage, place } from './helpers';

const ai4 = (setups: SetupId[]): RosterEntry[] => [0, 1, 2, 3].map((slot) => ({ id: `ai${slot}`, control: 'ai' as const, slot, setup: setups[slot] }));

/** The longitudinal model of a car at full throttle on a straight, integrated exactly as stepCar does. */
function straight(r: Race, c: Car, sec: number): { v: number; t15: number } {
  let t15 = 0;
  for (let t = 0; t < sec; t += DT) {
    r.update(DT, { [c.id]: { up: true, down: false } });
    c.u = r.T.FINISH_S + 1; c.mode = 'race'; c.laneSide = -1; c.d = -r.T.LANE_HALF; c.slip = 0; c.fuel = 1;   // no corner, ever
    if (!t15 && c.v >= 15) t15 = t;
  }
  return { v: c.v, t15 };
}

describe('the presets', () => {
  it('three frozen presets; Balanced is exactly the handling every car had (the old constants), at tuning 0', () => {
    expect(SETUP_IDS).toEqual(['balanced', 'speed', 'grip']);
    expect(DEFAULT_SETUP).toBe('balanced');
    expect(Object.isFrozen(CAR_SETUPS)).toBe(true);
    for (const s of CAR_SETUPS) expect(Object.isFrozen(s)).toBe(true);
    expect(carSetup('balanced')).toEqual({ id: 'balanced', tuning: 0, since: 0, acc: 30, vmax: 26, drag: 0.006, grip: 52, aiGrip: 36 });
    // the exported constants are Balanced's, and unchanged
    expect([ACC, VMAX, DRAG, GRIP, AI_GRIP, BRAKE]).toEqual([30, 26, 0.006, 52, 36, 30]);
    // every AI keeps Balanced's planning margin under the real grip
    for (const s of CAR_SETUPS) expect(s.aiGrip / s.grip).toBeCloseTo(36 / 52, 4);
    expect(SETUP_SET).toBe(1);
    expect(() => carSetup('turbo' as SetupId)).toThrow(/unknown car setup/);
    expect([setupOr('speed'), setupOr('turbo'), setupOr(undefined), setupOr(3)]).toEqual(['speed', 'balanced', 'balanced', 'balanced']);
    expect([knowsSetup(0, 'balanced'), knowsSetup(0, 'speed'), knowsSetup(1, 'grip')]).toEqual([true, false, true]);
  });

  it('a car can only be given an allowlisted id: an unknown one is refused, and a car\'s setup cannot be swapped', () => {
    expect(() => new Race({ roster: [{ id: 'a', control: 'human', setup: 'turbo' as SetupId }] })).toThrow(/unknown setup/);
    expect(() => new Race({ roster: [{ id: 'a', control: 'human', setup: { acc: 99 } as unknown as SetupId }] })).toThrow(/unknown setup/);
    const r = new Race({ roster: [{ id: 'a', control: 'human', setup: 'speed' }] });
    const c = r.car('a')!;
    expect(() => { (c as { setup: unknown }).setup = carSetup('grip'); }).toThrow();
    expect(() => { (c.setup as { acc: number }).acc = 99; }).toThrow();
    expect(c.setup).toBe(carSetup('speed'));
  });
});

describe('Balanced is the race it always was', () => {
  /** The scripted driver of the before/after harness: the Balanced player profile at 92%, a fuel stop when low. */
  function scripted(r: Race, step: number): Controls {
    const out: Record<string, { up: boolean; down: boolean }> = {};
    for (const c of r.cars) if (c.human) {
      const prof = r.profiles[c.laneSide > 0 ? '1' : '-1'];
      const want = prof[Math.floor(((r.T.wrapS(c.u) + 6) % r.T.L) / r.T.PROFILE_STEP) % prof.length] * 0.92;
      out[c.id] = c.mode === 'race' ? { up: c.v < want, down: c.v > want + 2 } : { up: step % 40 < 20, down: false };
      if (c.fuel < 0.25 && !c.pitReq && c.mode === 'race' && step % 30 === 0) r.requestPit(c.id);
    }
    return out;
  }
  /** Every event and a snapshot every 30 steps, hashed; the snapshot's two new static keys (#133) are left out. */
  function digest(r: Race): string {
    const h = createHash('sha256');
    let step = 0;
    while (r.phase !== 'done' && step * DT < 2000) {
      r.update(DT, scripted(r, step));
      for (const e of r.events) h.update(JSON.stringify(wireEvent(e)));
      r.events.length = 0;
      if (step % 30 === 0) { const sn = r.snapshot(); for (const c of sn.cars) { delete c.setup; delete c.tuning; } h.update(JSON.stringify(sn)); }
      step++;
    }
    h.update(JSON.stringify(r.final));
    return h.digest('hex').slice(0, 16);
  }
  const solo = (setup?: SetupId): RosterEntry[] => [{ id: 'me', control: 'human', slot: 0, ...(setup ? { setup } : {}) }, ...[1, 2, 3].map((slot) => ({ id: `ai${slot}`, control: 'ai' as const, slot, ...(setup ? { setup: 'balanced' as const } : {}) }))];
  // pinned on the code before setups (3b00cb9) with the same harness: a Balanced race is the same race, event for event
  it.each([
    ['circuit-1', 'ai', ai4([] as SetupId[]).map(({ setup: _s, ...e }) => e), {}, '85c62e058c161846'],
    ['circuit-3', 'solo', solo(), {}, '138a8703b64d2cce'],
    ['circuit-4', 'two', [{ id: 'h0', control: 'human' as const, slot: 0 }, { id: 'h1', control: 'human' as const, slot: 1 }, { id: 'ai2', control: 'ai' as const, slot: 2 }, { id: 'ai3', control: 'ai' as const, slot: 3 }], { runOn: 'live' as const }, 'b2f29d2f46df5d3e'],
    ['circuit-5', 'sprint', ai4([] as SetupId[]).map(({ setup: _s, ...e }) => e), { length: 'sprint' as const }, '32b0833435a64c9c'],
  ])('%s %s: the seeded digest from before setups', (track, _n, roster, extra, want) => {
    expect(digest(new Race({ track, seed: 4242, roster, ...extra }))).toBe(want);
  });
  it('naming Balanced explicitly (every car, AI too) is the same race as naming nothing', () => {
    expect(digest(new Race({ track: 'circuit-2', seed: 5, roster: solo('balanced') }))).toBe(digest(new Race({ track: 'circuit-2', seed: 5, roster: solo() })));
  });
});

describe('physics come from each car\'s own setup', () => {
  it('Speed: weaker acceleration, higher top speed; Grip: lower top speed; braking is the same for all', () => {
    const r = new Race({ track: 'circuit-1', practice: true, roster: SETUP_IDS.map((id, slot) => ({ id, control: 'human' as const, slot, setup: id })) });
    r.phase = 'racing';
    const res: Record<string, { v: number; t15: number }> = {};
    for (const id of SETUP_IDS) {
      const c = r.car(id)!;
      for (const o of r.cars) if (o !== c) { o.mode = 'off'; o.off = { x: 0, y: 0, vx: 0, vy: 0, yaw: 0, spin: 0, t: 0, z: 0, vz: 0, u0: 0, lane: 1 }; }
      c.v = 0; c.throttle = 0;
      res[id] = straight(r, c, 20);
    }
    expect(res.balanced.v).toBeCloseTo(23.20, 1);
    expect(res.speed.v).toBeGreaterThan(res.balanced.v + 1);
    expect(res.grip.v).toBeLessThan(res.balanced.v - 1);
    expect(res.speed.t15).toBeGreaterThan(res.balanced.t15 + 0.1);
    // drive at 10 m/s: weaker for Speed
    const a = (id: SetupId, v: number) => { const S = carSetup(id); return S.acc * (1 - v / S.vmax) - S.drag * v * v; };
    expect(a('speed', 10)).toBeLessThan(a('balanced', 10) - 2);
    // the hold throttle the AI and the pit controller use is the car's own: it holds the car's speed exactly
    for (const id of SETUP_IDS) {
      const S = carSetup(id), v = 18, thr = holdThrottle(S, v);
      expect(thr * S.acc * (1 - v / S.vmax) - ((1 - thr) * 9 + S.drag * v * v)).toBeCloseTo(0, 9);
    }
  });

  it('Grip carries more speed through a corner before it de-slots; the same speed de-slots Balanced', () => {
    // the tightest point of circuit-2's inside lane: a steady speed between the two setups' limits
    const t = new T.Track('circuit-2');
    let s0 = 0, kl = 0;
    for (let s = 0; s < t.L; s += 0.5) { const k = Math.abs(t.curvature(s) / (1 - t.curvature(s) * t.LANE_HALF)) / t.gripScale(s); if (k > kl) { kl = k; s0 = s; } }
    const vB = Math.sqrt(52 / kl), vG = Math.sqrt(carSetup('grip').grip / kl);
    expect(vG / vB).toBeCloseTo(Math.sqrt(56 / 52), 6);
    const hold = (id: SetupId, v: number) => {
      const r = new Race({ track: 'circuit-2', practice: true, roster: [{ id: 'a', control: 'human', setup: id }] });
      r.phase = 'racing';
      const c = r.car('a')!;
      let off = false;
      // held at that speed at that point for 3 s: the slip builds only while the lateral load is over the car's grip
      for (let i = 0; i < 360; i++) { const slip = c.slip; place(c, s0, 1, v); c.slip = slip; r.update(1 / 120, {}); if (c.mode === 'off') { off = true; break; } }
      return off;
    };
    const mid = (vB + vG) / 2 * 1.02;
    expect(hold('balanced', mid)).toBe(true);
    expect(hold('grip', mid)).toBe(false);
    expect(hold('grip', vG * 1.2)).toBe(true);
  });

  it('two rooms (races) with different setups in one process never affect each other', () => {
    const run = (setups: SetupId[]) => { const r = new Race({ track: 'circuit-3', seed: 9, roster: ai4(setups) }); for (let i = 0; i < 4000; i++) { r.update(DT, {}); r.events.length = 0; } return JSON.stringify(r.snapshot()); };
    const alone = run(['speed', 'grip', 'balanced', 'speed']);
    const a = new Race({ track: 'circuit-3', seed: 9, roster: ai4(['speed', 'grip', 'balanced', 'speed']) });
    const b = new Race({ track: 'circuit-3', seed: 9, roster: ai4(['grip', 'grip', 'grip', 'grip']) });
    for (let i = 0; i < 4000; i++) { a.update(DT, {}); b.update(DT, {}); a.events.length = 0; b.events.length = 0; }
    expect(JSON.stringify(a.snapshot())).toBe(alone);
  });

  it('a mixed field is deterministic: same seed, setups and inputs give the same race', () => {
    const roster: RosterEntry[] = [{ id: 'h0', control: 'human', slot: 0, setup: 'grip' }, { id: 'h1', control: 'human', slot: 1, setup: 'speed' }, { id: 'ai2', control: 'ai', slot: 2, setup: 'speed' }, { id: 'ai3', control: 'ai', slot: 3, setup: 'grip' }];
    const run = () => {
      const r = new Race({ track: 'circuit-5', seed: 33, roster, runOn: 'live' });
      const ev: string[] = [];
      for (let i = 0; i < 9000; i++) { r.update(DT, { h0: { up: i % 50 < 38, down: false }, h1: { up: i % 60 < 45, down: false } }); ev.push(...r.events.map((e) => JSON.stringify(wireEvent(e)))); r.events.length = 0; }
      return createHash('sha256').update(ev.join('|') + JSON.stringify(r.snapshot())).digest('hex');
    };
    expect(run()).toBe(run());
  });
});

describe('the AI and automatic pit service plan with each car\'s own limits', () => {
  it('each AI\'s speed profiles are its setup\'s: Speed\'s straights reach its own top end, Grip\'s corners its own grip', () => {
    const r = new Race({ track: 'circuit-1', seed: 1, roster: ai4(['balanced', 'speed', 'grip', 'balanced']) });
    for (const id of SETUP_IDS) for (const side of [-1, 1]) {
      const S = carSetup(id);
      const p = r.profiles[profKey(id, 'consistent', side, false)];
      expect(Math.max(...p)).toBeCloseTo(S.vmax, 4);
      expect(p).toEqual(r.T.buildProfile(side, S.aiGrip * 1.0, S.vmax, 18));
    }
    // Balanced keeps the keys it always had
    expect(r.profiles['consistent:1']).toBe(r.profiles[profKey('balanced', 'consistent', 1, false)]);
    expect(r.profiles['-1']).toBe(r.profiles['player:-1']);
    // the corner minima scale with the setup's planned grip
    const minOf = (id: SetupId) => Math.min(...r.profiles[profKey(id, 'consistent', 1, false)]);
    expect(minOf('grip') / minOf('balanced')).toBeCloseTo(Math.sqrt(38.769 / 36), 3);
    expect(minOf('speed')).toBeCloseTo(minOf('balanced'), 5);
  });

  it('a field of consistent AI drivers on any setup never de-slots: no AI overdrives its car (no stale global limits)', () => {
    for (const track of ['circuit-1', 'circuit-3', 'circuit-5']) for (const id of SETUP_IDS) {
      const roster = [0, 1, 2, 3].map((slot) => ({ id: `ai${slot}`, control: 'ai' as const, slot, setup: id, persona: 'consistent' as const }));
      const r = new Race({ track, seed: 3, roster, length: 'sprint' });
      let deslots = 0, maxV = 0;
      for (let i = 0; i < 9000 && r.phase !== 'done'; i++) { r.update(DT, {}); for (const e of r.events) if (e.type === 'deslot') deslots++; r.events.length = 0; for (const c of r.cars) if (c.mode === 'race') maxV = Math.max(maxV, c.v); }
      expect([track, id, deslots]).toEqual([track, id, 0]);
      expect(maxV).toBeLessThanOrEqual(carSetup(id).vmax);
    }
  });

  it('the automatic pit controller\'s corner limit is the car\'s own setup\'s, never Balanced\'s for everyone', () => {
    const r = new Race({ track: 'circuit-2', practice: true, roster: SETUP_IDS.map((id, slot) => ({ id, control: 'human' as const, slot, setup: id })) });
    const g = r.car('grip')!, b = r.car('balanced')!, s = r.car('speed')!;
    let more = 0;
    for (let u = 0; u < r.T.L; u += 1) {
      for (const c of [g, b, s]) { c.u = u; c.v = 15; c.laneSide = -1; c.change = null; }
      const [cg, cb, cs] = [g, b, s].map((c) => r.sgCorner(c, r.T.wrapS(u)));
      // in a corner (where grip, not top speed, sets the limit) Grip's controller may carry more than Balanced's
      if (cb < 20) expect(cg).toBeGreaterThanOrEqual(cb - 1e-6);
      // never more than the car's own planned profile here (Speed is held to its own, not to Grip's)
      const own = r.playerProfile(s, -1);
      expect(cs).toBeLessThanOrEqual(own[Math.floor(r.T.wrapS(u) / r.T.PROFILE_STEP) % own.length] + 1e-6);
      expect(cg).toBeLessThanOrEqual(carSetup('grip').vmax + 1e-5);
      if (cb < 20 && cg > cb + 0.05) more++;
    }
    expect(more).toBeGreaterThan(10);
  });

  it('pit limit, reverse cap and braking are the same for every setup', () => {
    for (const id of SETUP_IDS) {
      const r = new Race({ track: 'circuit-1', practice: true, roster: [{ id: 'a', control: 'human', setup: id }] });
      r.phase = 'racing';
      const c = r.car('a')!;
      // full throttle down the pit lane: held at the pit limit whatever the setup
      place(c, r.T.PIT_IN1 + 1, -1, 0); c.mode = 'pitlane'; c.d = r.T.pitD(r.T.wrapS(c.u));
      let top = 0;
      for (let i = 0; i < 120 && c.mode === 'pitlane'; i++) { r.update(DT, { a: { up: true, down: false } }); top = Math.max(top, c.v); }
      expect(top).toBeLessThanOrEqual(r.T.PIT_SPEED + 1e-9);
      // braking from 20 m/s: the shared BRAKE (plus drag) for everyone
      place(c, r.T.FINISH_S + 2, -1, 20);
      r.update(DT, { a: { up: false, down: true } });
      expect(20 - c.v).toBeGreaterThanOrEqual(BRAKE * DT - 1e-9);
      expect(20 - c.v).toBeLessThan((BRAKE + 9 + 0.006 * 400) * DT + 1e-6);
      // reverse: the shared cap
      place(c, r.T.FINISH_S + 10, -1, 0);
      for (let i = 0; i < 240; i++) r.update(DT, { a: { up: false, down: true } });
      expect(c.v).toBeCloseTo(-REV_CAP, 6);
    }
  });
});

describe('the online mirror shows the server\'s setups', () => {
  it('every car\'s setup and tuning travel as static fields; a snapshot from an older server reads as Balanced', () => {
    const r = new Race({ track: 'circuit-4', seed: 2, roster: ai4(['speed', 'grip', 'balanced', 'speed']), runOn: 'live' });
    for (let i = 0; i < 400; i++) r.update(DT, {});
    const enc = new SnapEncoder('race-1'), dec = new SnapDecoder();
    const frame = enc.next(r.snapshot(), 1, 0);
    expect(frame.static!.cars.map((c) => [c.setup, c.tuning])).toEqual([['speed', 1], ['grip', 1], ['balanced', 0], ['speed', 1]]);
    const snap = dec.decode({ tick: 1, ...frame })!;
    const m = mirrorRace(snap);
    expect(m.cars.map((c) => c.setup.id)).toEqual(['speed', 'grip', 'balanced', 'speed']);
    // the dynamic fields applied later never touch it
    applySnapshot(m, snap);
    expect(m.cars.map((c) => c.setup.id)).toEqual(['speed', 'grip', 'balanced', 'speed']);
    // an older server's static list has neither key
    const old = { ...snap, cars: snap.cars.map(({ setup: _s, tuning: _t, ...c }) => c) };
    expect(mirrorRace(old).cars.every((c) => c.setup.id === 'balanced')).toBe(true);
  });
});

describe('local records compare only within one setup and tuning', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memStorage()); T.setTrack('circuit-1'); });

  it('record tags: a record naming nothing is Balanced at tuning 0 (today\'s Balanced); anything unreadable is no record', () => {
    expect(recordTag(undefined, undefined)).toEqual({ setup: 'balanced', tuning: 0 });
    expect(recordTag('speed', 1)).toEqual({ setup: 'speed', tuning: 1 });
    expect(recordTag('speed', undefined)).toEqual({ setup: 'speed', tuning: 0 });
    expect([recordTag('turbo', 0), recordTag('grip', -1), recordTag('grip', 1.5), recordTag('grip', '1')]).toEqual([null, null, null, null]);
    expect([isCurrentTag({ setup: 'balanced', tuning: 0 }), isCurrentTag({ setup: 'speed', tuning: 1 }), isCurrentTag({ setup: 'speed', tuning: 0 })]).toEqual([true, true, false]);
    expect(currentTag('grip')).toEqual({ setup: 'grip', tuning: carSetup('grip').tuning });
  });

  it('boards: legacy rows stay on Balanced\'s board; each setup has its own board; a lap never lands on another setup\'s', () => {
    // a board saved before setups: rows name no setup
    localStorage.setItem('srgp.lb.practice.circuit-1', JSON.stringify([{ id: 'old', initials: 'OLD', car: 'sunburst', ms: 12000, at: 1 }]));
    expect(R.board('practice', 'circuit-1').map((r) => r.id)).toEqual(['old']);
    expect(R.board('practice', 'circuit-1', 'balanced').map((r) => r.id)).toEqual(['old']);
    expect(R.board('practice', 'circuit-1', 'speed')).toEqual([]);
    const s = R.submitLap('practice', 'circuit-1', 'JD', 'blaze', 11000, 'speed')!;
    expect(s).toMatchObject({ setup: 'speed', tuning: carSetup('speed').tuning });
    // a faster Speed lap does not push the Balanced record off Balanced's board, and is not shown there
    expect(R.board('practice', 'circuit-1', 'balanced').map((r) => r.id)).toEqual(['old']);
    expect(R.board('practice', 'circuit-1', 'speed').map((r) => r.id)).toEqual([s.id]);
    const b = R.submitLap('practice', 'circuit-1', 'JD', 'blaze', 12500)!;
    expect(b).toMatchObject({ setup: 'balanced', tuning: 0 });
    expect(R.board('practice', 'circuit-1').map((r) => r.id)).toEqual(['old', b.id]);
    // legacy Balanced keeps its storage key, so a page from before setups still reads the same board
    expect(JSON.parse(localStorage.getItem('srgp.lb.practice.circuit-1')!).map((r: { id: string }) => r.id)).toEqual(['old', b.id]);
    expect(localStorage.getItem(`srgp.lb.practice.circuit-1~speed.${carSetup('speed').tuning}`)).not.toBeNull();
    // a row of an older Speed tuning (as if Speed were retuned), even under today's key, is not shown as a current record
    localStorage.setItem(`srgp.lb.practice.circuit-1~speed.${carSetup('speed').tuning}`, JSON.stringify([{ id: 'stale', initials: 'X', car: 'sunburst', ms: 9000, at: 1, setup: 'speed', tuning: 0 }]));
    expect(R.board('practice', 'circuit-1', 'speed')).toEqual([]);
    // ...but an older tuning's board itself is still readable, by its own tag
    localStorage.setItem('srgp.lb.practice.circuit-1~speed.0', JSON.stringify([{ id: 'old-speed', initials: 'X', car: 'sunburst', ms: 9000, at: 1, setup: 'speed', tuning: 0 }]));
    expect(R.board('practice', 'circuit-1', { setup: 'speed', tuning: 0 }).map((r) => r.id)).toEqual(['old-speed']);
  });

  it('ghosts: only a lap driven with the same setup at its current tuning is ever loaded to challenge', () => {
    const lap = (setup?: SetupId, tuning?: number): R.GhostData => ({ v: R.GHOST_VERSION, track: 'circuit-1', car: 'sunburst', initials: 'JD', L: +T.L.toFixed(3), ms: 12345, s: [0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0], ...(setup ? { setup } : {}), ...(tuning !== undefined ? { tuning } : {}) });
    // a ghost from before setups (names none) is a Balanced lap: it is Balanced's challenge, never Speed's or Grip's
    localStorage.setItem('srgp.ghost.circuit-1.sunburst.JD', JSON.stringify(lap()));
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')?.ms).toBe(12345);
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD', 'speed')).toBeNull();
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD', 'grip')).toBeNull();
    R.saveGhost({ ...lap('grip', carSetup('grip').tuning), ms: 11111 });
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD', 'grip')?.ms).toBe(11111);
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')?.ms).toBe(12345);
    // a ghost whose data names another setup or an older tuning is refused even under the current key
    localStorage.setItem(`srgp.ghost.circuit-1.sunburst~grip.${carSetup('grip').tuning}.JD`, JSON.stringify(lap('grip', 0)));
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD', 'grip')).toBeNull();
    localStorage.setItem('srgp.ghost.circuit-1.sunburst.JD', JSON.stringify(lap('speed', 1)));
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')).toBeNull();
  });

  it('the recorder stamps a ghost with its car\'s setup and tuning', async () => {
    const { GhostRecorder } = await import('../src/ghost').catch(() => ({ GhostRecorder: null }));
    if (!GhostRecorder) return;   // three.js is not loadable in every test environment
    const r = new Race({ track: 'circuit-1', practice: true, roster: [{ id: 'a', control: 'human', setup: 'speed' }] });
    const rec = new GhostRecorder();
    const c = r.car('a')!;
    c.crossed = 1; rec.start(c);
    const g = rec.finish(c, 12, 'circuit-1', 'sunburst', 'JD', 12000);
    expect([g.setup, g.tuning]).toEqual(['speed', carSetup('speed').tuning]);
  });

  it('the setup preference and championship saves: Balanced by default, a save from before setups loads as Balanced', () => {
    expect(R.savedSetup()).toBe('balanced');
    R.saveSetup('grip');
    expect(R.savedSetup()).toBe('grip');
    R.saveSetup('turbo' as SetupId);
    expect(R.savedSetup()).toBe('grip');
    localStorage.setItem('srgp.setup', JSON.stringify({ acc: 99 }));
    expect(R.savedSetup()).toBe('balanced');
    localStorage.setItem('srgp.champ', JSON.stringify({ v: 1, car: 'sunburst', initials: 'JD', rounds: [{ track: 'circuit-1', order: [{ idx: 0, dnf: false, time: 200 }] }], startedAt: 1 }));
    expect(R.loadChamp()).toMatchObject({ setup: 'balanced', length: 'standard' });
    const c = R.newChamp('sunburst', 'JD', 'sprint', 'speed');
    expect(R.loadChamp()!.setup).toBe('speed');
    // a new choice between rounds is kept with the save; each round records the setup it was raced with
    c.rounds.push(R.roundRecord('circuit-1', [{ car: { idx: 0 }, status: 'finished', time: 80 }], 'speed'));
    c.setup = 'grip'; R.saveChamp(c);
    expect(R.loadChamp()).toMatchObject({ setup: 'grip', rounds: [{ setup: 'speed' }] });
    // the round's points do not depend on the setup
    expect(R.roundPoints(R.loadChamp()!.rounds[0], 0)).toBe(10);
  });
});

void NONE;
