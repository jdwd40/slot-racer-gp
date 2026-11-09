// The fixed-step clock on its own, then driving real races the way main.ts does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import * as R from '../src/records';
import { Race, RaceEvent, PEN } from '../src/race';
import { fmt } from '../src/hud';
import { GhostRecorder, GhostPlayer } from '../src/ghost';
import { FixedStepper, STEP, MAX_GAP, MAX_STEPS, blendPose, Pose } from '../src/timing';
import { seedRandom, memStorage, fresh, park, place, msgs, all, me } from './helpers';

const RATES = [60, 30, 20, 15, 10];
const ROUNDING = 0.05; // the HUD clock shows tenths
const EPS = 1e-9;      // float noise on the exact one-step boundary

type Screen = 'race' | 'results' | 'champ' | 'pause';

/** The per-step bookkeeping of tick() in main.ts around a real Race, without the DOM and renderer. */
class Session {
  stepper = new FixedStepper();
  recorder = new GhostRecorder();
  screen: Screen = 'race';
  keys = { up: false, down: false };
  seen: boolean[] = [];
  events: { t: number; type: string }[] = [];
  raw: RaceEvent[] = [];
  ghosts: R.GhostData[] = [];
  pending: Extract<RaceEvent, { type: 'lap' }> | null = null;
  lastCrossed = 0;
  steps = 0;
  ghosting = false;
  onStep: (() => void) | null = null;
  constructor(public race: Race) {}

  tick = (dt: number): void => {
    const r = this.race;
    this.seen.push(this.keys.up);
    r.update(dt, all(r, { ...this.keys }));
    for (const e of r.events) {
      this.raw.push(e); this.events.push({ t: r.t, type: e.type });
      if (e.type === 'lap' && e.car === me(r)) this.pending = e;
    }
    r.events.length = 0;
    const p = me(r);
    if (p.crossed !== this.lastCrossed) {
      this.lastCrossed = p.crossed;
      if (this.ghosting) {
        if (this.recorder.active && this.pending) this.ghosts.push(this.recorder.finish(p, r.raceTime, T.DEF.id, 'sunburst', 'JD', this.pending.time * 1000));
        this.pending = null;
        this.recorder.start(p);
      }
    }
    this.recorder.sample(p, r.raceTime);
    this.steps++;
    this.onStep?.();
    if (r.phase === 'done' && this.screen === 'race') this.screen = 'champ';
  };
  active = (): boolean => this.screen === 'race' || this.screen === 'results';
  frame(now: number): number { return this.stepper.frame(now, this.active, this.tick); }
  /** blur/visibility handler */
  suspend(): void { this.keys = { up: false, down: false }; if (this.screen === 'race') this.screen = 'pause'; this.stepper.rebase(); }
  resume(): void { this.screen = 'race'; this.stepper.rebase(); }
  count(type: string): number { return this.events.filter((e) => e.type === type).length; }
}

/** Fire callbacks at a steady rate for `seconds` from `start` (ms); returns the time of the last one. */
function play(s: Session, fps: number, seconds: number, start = 0): number {
  const n = Math.round(seconds * fps);
  for (let i = 0; i <= n; i++) s.frame(start + (i * 1000) / fps);
  return start + (n * 1000) / fps;
}

/** A jittery run of frame gaps (ms), many of them over the old 50 ms clamp but all within MAX_GAP. */
function irregular(n: number): number[] {
  const pattern = [16.7, 16.7, 51, 16.7, 33.3, 120, 16.7, 75, 16.7, 16.7, 240, 33.3, 66.7, 16.7, 90];
  return Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);
}

beforeEach(() => { seedRandom(7); vi.stubGlobal('localStorage', memStorage()); T.setTrack('circuit-1'); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('FixedStepper', () => {
  const on = (): boolean => true;
  const noop = (): void => {};

  it('budgets for the whole 10-60 FPS range', () => {
    expect(STEP).toBe(1 / 60);
    expect(MAX_STEPS).toBe(15);
    expect(MAX_GAP).toBeGreaterThan(1 / 10);
    expect(MAX_STEPS).toBeGreaterThan(Math.ceil(0.1 / STEP));
  });

  it('the first callback only sets the baseline', () => {
    expect(new FixedStepper().frame(123456, on, noop)).toBe(0);
  });

  it.each(RATES)('keeps all elapsed time at %i FPS', (fps) => {
    const st = new FixedStepper();
    let steps = 0;
    for (let i = 0; i <= 60 * fps; i++) {
      steps += st.frame((i * 1000) / fps, on, noop);
      expect(Math.abs(steps * STEP - i / fps)).toBeLessThan(STEP + EPS);
    }
    expect(st.dropped).toBe(0);
  });

  it('keeps gaps over the old 50 ms clamp in irregular sequences, without drift', () => {
    const st = new FixedStepper();
    let now = 0, steps = 0;
    st.frame(now, on, noop);
    for (const gap of irregular(3000)) {
      now += gap;
      steps += st.frame(now, on, noop);
      expect(Math.abs(steps * STEP - now / 1000)).toBeLessThan(STEP + EPS);
    }
    expect(st.dropped).toBe(0);
  });

  it('a stall runs at most one budget of steps, drops the excess at once and owes nothing afterwards', () => {
    const st = new FixedStepper();
    st.frame(0, on, noop);
    expect(st.frame(5000, on, noop)).toBe(MAX_STEPS);
    expect(st.dropped).toBeCloseTo(5 - MAX_GAP, 9);
    expect(st.alpha).toBeLessThan(1);
    let burst = 0;
    for (let i = 1; i <= 10; i++) burst = Math.max(burst, st.frame(5000 + (i * 1000) / 60, on, noop));
    expect(burst).toBeLessThanOrEqual(2);
  });

  it('sustained overload degrades to the budget per callback with no backlog', () => {
    const st = new FixedStepper();
    st.frame(0, on, noop);
    for (let i = 1; i <= 200; i++) {
      expect(st.frame(i * 400, on, noop)).toBe(MAX_STEPS);
      expect(st.alpha).toBeLessThan(1);
    }
  });

  it('never exceeds the budget, whatever the gaps', () => {
    const st = new FixedStepper();
    let now = 0;
    st.frame(now, on, noop);
    for (let i = 0; i < 20000; i++) {
      now += Math.random() < 0.05 ? Math.random() * 2000 : Math.random() * 260;
      expect(st.frame(now, on, noop)).toBeLessThanOrEqual(MAX_STEPS);
      expect(st.alpha).toBeGreaterThanOrEqual(0);
      expect(st.alpha).toBeLessThan(1);
    }
  });

  it('rebase replays nothing, however long the absence', () => {
    const st = new FixedStepper();
    st.frame(0, on, noop); st.frame(10, on, noop);
    st.rebase();
    expect(st.frame(3_600_000, on, noop)).toBe(0);
    expect(st.dropped).toBe(0);
    expect(st.frame(3_600_000 + 100, on, noop)).toBe(6);
  });

  it('ignores a timestamp behind the baseline (rAF time can precede the moment of a rebase)', () => {
    const st = new FixedStepper();
    st.frame(1000, on, noop);
    expect(st.frame(990, on, noop)).toBe(0);
    expect(st.alpha).toBe(0);
  });

  it('banks nothing while inactive and keeps its sub-step remainder so a resumed picture does not jump', () => {
    const st = new FixedStepper();
    let active = true;
    const gate = (): boolean => active;
    st.frame(0, gate, noop); st.frame(10, gate, noop);
    const alpha = st.alpha;
    active = false;
    for (let i = 1; i <= 100; i++) { expect(st.frame(10 + i * 1000, gate, noop)).toBe(0); expect(st.alpha).toBe(alpha); }
    active = true;
    expect(st.frame(200_000, gate, noop)).toBe(0);
    expect(st.alpha).toBe(alpha);
  });

  it('stops mid-callback when a step ends the session and drops the steps left over', () => {
    const st = new FixedStepper();
    let left = 2;
    st.frame(0, () => left > 0, noop);
    expect(st.frame(100, () => left > 0, () => { left--; })).toBe(2);
    expect(st.alpha).toBeLessThan(1);
    left = 1;
    expect(st.frame(200, () => left > 0, () => {})).toBe(0); // rebased: the first callback back is a baseline
  });
});

describe('blendPose', () => {
  const a: Pose = { x: 0, y: 0, z: 0, h: 0, roll: 0, pitch: 0 };
  it('interpolates without touching its inputs', () => {
    const b: Pose = { x: 0.4, y: 0.2, z: 0.1, h: 0.2, roll: 0.1, pitch: 0.3 };
    const before = JSON.stringify([a, b]);
    expect(blendPose(a, b, 0.5).x).toBeCloseTo(0.2, 9);
    expect(blendPose(a, b, 0.5).h).toBeCloseTo(0.1, 9);
    expect(JSON.stringify([a, b])).toBe(before);
  });
  it('turns the short way across the heading wrap', () => {
    const h = blendPose({ ...a, h: Math.PI - 0.1 }, { ...a, h: -Math.PI + 0.1 }, 0.5).h;
    expect(Math.abs(Math.cos(h) + 1)).toBeLessThan(1e-9);
  });
  it('snaps across a respawn or tow instead of sliding', () => {
    const b = { ...a, x: 9 };
    expect(blendPose(a, b, 0.5)).toBe(b);
  });
  it('leaves the simulation state unchanged when applied every frame', () => {
    const r = fresh();
    const before = JSON.stringify(r.cars);
    r.cars.forEach((c) => blendPose({ ...c, x: c.x - 0.1 }, c, 0.5));
    expect(JSON.stringify(r.cars)).toBe(before);
  });
});

describe('race clock against wall time', () => {
  it.each(RATES)('race time tracks active racing wall time at %i FPS, excluding the countdown', (fps) => {
    const s = new Session(new Race());
    const r = s.race;
    for (let i = 0; i <= (r.goT + 60) * fps; i++) {
      s.frame((i * 1000) / fps);
      if (r.phase !== 'racing' || r.raceTime < 0.1) continue;
      const active = i / fps - (r.t - r.raceTime); // wall time since the lights went out
      expect(Math.abs(r.raceTime - active)).toBeLessThanOrEqual(STEP + EPS);
      const [m, sec] = fmt(r.raceTime).split(':');
      expect(Math.abs(+m * 60 + +sec - active)).toBeLessThanOrEqual(STEP + ROUNDING + EPS);
    }
    expect(r.phase).toBe('racing');
    expect(s.stepper.dropped).toBe(0);
  });

  it('irregular frame gaps do not accumulate slowdown', () => {
    const s = new Session(fresh());
    const r = s.race, t0 = r.raceTime;
    let now = 0;
    s.frame(now);
    for (const gap of irregular(1500)) {
      now += gap;
      s.frame(now);
      expect(Math.abs(r.raceTime - t0 - now / 1000)).toBeLessThanOrEqual(STEP + EPS);
    }
    expect(now).toBeGreaterThan(80000);
  });

  it('runs the identical race at every frame rate: the same steps give the same result', () => {
    const run = (fps: number): string => {
      vi.restoreAllMocks(); seedRandom(11);
      const s = new Session(fresh());
      let at = '';
      s.onStep = () => { if (s.steps === 3600) at = JSON.stringify({ cars: s.race.cars, t: s.race.raceTime, ev: s.events }); };
      play(s, fps, 61);
      return at;
    };
    const base = run(60);
    expect(base).not.toBe('');
    for (const fps of [30, 20, 15, 10]) expect(run(fps)).toBe(base);
  });

  it('keeps lap times comparable with the old variable sub-steps, so stored records stay fair', () => {
    const lapWith = (dts: number[]): number => {
      vi.restoreAllMocks(); seedRandom(3);
      const r = fresh('circuit-1', { practice: true });
      const c = r.cars[0];
      for (let i = 0; c.lapsDone < 2 && i < 60000; i++) r.update(dts[i % dts.length], all(r, { up: false, down: false }));
      return c.lastLap;
    };
    const fixed = lapWith([STEP]);
    expect(fixed).toBeGreaterThan(0);
    // what a browser at 60 Hz used to feed Race.update: frame times either side of 1/60, two or three sub-steps each
    expect(Math.abs(lapWith([0.0166, 0.0169, 0.0167, 0.0165]) - fixed)).toBeLessThan(0.05);
    expect(Math.abs(lapWith([0.05]) - fixed)).toBeLessThan(0.05);
  });
});

describe('bounded recovery in a live race', () => {
  it('a long stall advances the race by at most one budget and then carries on at normal speed', () => {
    const s = new Session(fresh());
    const r = s.race;
    const end = play(s, 30, 5);
    const before = r.raceTime;
    expect(s.frame(end + 30_000)).toBeLessThanOrEqual(MAX_STEPS);
    expect(r.raceTime - before).toBeLessThanOrEqual(MAX_GAP + STEP);
    const mid = r.raceTime;
    play(s, 30, 3, end + 30_000 + 1000 / 30);
    expect(Math.abs(r.raceTime - mid - (3 + 1 / 30))).toBeLessThanOrEqual(STEP + EPS);
  });

  it('pause and blur freeze the clock for any length of time, and resume costs no burst', () => {
    const s = new Session(fresh());
    const r = s.race;
    const end = play(s, 30, 2);
    s.suspend();
    const frozen = r.raceTime;
    play(s, 30, 20, end + 33);
    expect(r.raceTime).toBe(frozen);
    s.resume();
    const back = end + 33 + 20_000;
    expect(s.frame(back)).toBe(0);
    expect(r.raceTime).toBe(frozen);
    expect(s.frame(back + 1000 / 30)).toBeLessThanOrEqual(3);
  });

  it('a hidden tab that returns replays none of its absence, on the unpaused results screen too', () => {
    const s = new Session(fresh());
    s.screen = 'results';
    const end = play(s, 60, 1);
    const t = s.race.t;
    s.stepper.rebase(); // visibilitychange; no callbacks arrive while hidden
    expect(s.frame(end + 600_000)).toBe(0);
    expect(s.race.t).toBe(t);
    expect(s.stepper.dropped).toBe(0);
  });

  it('a restart starts the new race from a clean baseline', () => {
    const s = new Session(fresh());
    const end = play(s, 10, 3);
    s.race = new Race(); s.lastCrossed = 0; s.stepper.rebase();
    expect(s.frame(end + 40)).toBe(0);
    expect(s.race.t).toBe(0);
    s.frame(end + 140);
    expect(s.race.t).toBeLessThanOrEqual(0.1 + STEP);
  });

  it('stops stepping the moment the race hands over to a screen that does not simulate', () => {
    const s = new Session(fresh());
    const r = s.race;
    s.frame(0);
    for (const c of r.cars) { c.finished = true; c.status = "finished"; } r.humansDoneT = r.t - 3.19;
    expect(s.frame(100)).toBe(1); // six were owed; a championship result must read the race as it ended
    expect(r.phase).toBe('done');
    expect(s.screen).toBe('champ');
    const t = r.t;
    play(s, 10, 2, 200);
    expect(r.t).toBe(t);
  });
});

describe('bookkeeping and input on every step', () => {
  it('a catch-up callback runs the bookkeeping once per step', () => {
    const s = new Session(fresh());
    s.frame(0);
    expect(s.frame(100)).toBe(6);
    expect(s.steps).toBe(6);
    expect(s.race.events.length).toBe(0);
  });

  it('held controls apply to every step of a slow frame and act the same as at 60 FPS', () => {
    const drive = (fps: number): number => {
      vi.restoreAllMocks(); seedRandom(5);
      const r = fresh('circuit-1', { practice: true }); me(r).human = true;
      const s = new Session(r);
      s.keys.up = true;
      let v = -1;
      s.onStep = () => { if (s.steps === 90) v = me(r).v; };
      play(s, fps, 2);
      expect(s.seen.every(Boolean)).toBe(true);
      return v;
    };
    const v60 = drive(60);
    expect(v60).toBeGreaterThan(5);
    expect(drive(10)).toBe(v60);
  });

  it('a key held into a blur does not stick: the throttle drops after resume', () => {
    const r = fresh('circuit-1', { practice: true }); me(r).human = true;
    const s = new Session(r);
    s.keys.up = true;
    const end = play(s, 10, 2);
    expect(me(r).throttle).toBeGreaterThan(0.9);
    s.suspend(); s.resume();
    play(s, 10, 1, end + 1000);
    expect(s.seen.at(-1)).toBe(false);
    expect(me(r).throttle).toBe(0);
  });

  it('a lane request made once is consumed once across multi-step frames', () => {
    const r = fresh(); park(r);
    const c = r.cars[0]; c.human = true;
    const sw = T.SWITCHES[0];
    place(c, sw.s0 - 3, 1, 15);
    const s = new Session(r);
    s.keys.up = true;
    r.requestLane(me(r).id);
    expect(c.laneReq).toBe(true);
    const end = play(s, 10, 1.5);
    expect(s.raw.filter((e) => e.type === 'switch' && e.car === c).length).toBe(1);
    expect(c.laneReq).toBe(false);
    expect(msgs(s.raw).filter((m) => m === 'msg.laneGo').length).toBe(1);
    s.keys.up = false;
    play(s, 10, 3, end + 100);
    expect(s.raw.filter((e) => e.type === 'switch' && e.car === c).length).toBe(1);
  });

  it('a pit request made once is consumed once across multi-step frames', () => {
    const r = fresh(); park(r);
    const c = r.cars[0]; c.human = true;
    place(c, T.PIT_IN0 - 3, -1, 15);
    const s = new Session(r);
    r.requestPit(me(r).id);
    play(s, 10, 0.6);
    expect(c.mode).toBe('pitlane');
    expect(c.pitReq).toBe(false);
    expect(msgs(s.raw).filter((m) => m === 'msg.pitIn').length).toBe(1);
  });

  it('a stop-and-go costs its full seconds of wall time at 10 FPS, not double', () => {
    const r = fresh(); park(r);
    const c = r.cars[0]; c.human = true;
    place(c, T.PEN_S, -1, 0);
    c.mode = 'pitlane'; c.d = T.pitD(T.PEN_S); c.sgOwed = PEN.stopSeconds; c.sgDue = 2;
    const s = new Session(r);
    let wall = 0;
    for (let i = 0; i <= 80 && !s.count('served'); i++) { wall = i / 10; s.frame(i * 100); }
    expect(s.count('served')).toBe(1);
    expect(Math.abs(wall - PEN.stopSeconds)).toBeLessThanOrEqual(0.1 + STEP);
  });
});

describe('practice ghosts and saves', () => {
  /** ghost.ts builds a car mesh, which paints its number on a canvas */
  const stubCanvas = (): void => {
    const paint = new Proxy({}, { get: () => () => undefined, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => paint }) });
  };
  /** a lap recorded through the loop at the given frame rate, and where the car really was during it */
  const record = (fps: number): { g: R.GhostData; path: { t: number; x: number; y: number }[] } => {
    vi.restoreAllMocks(); seedRandom(9);
    const s = new Session(fresh('circuit-1', { practice: true }));
    s.ghosting = true;
    const path: { t: number; x: number; y: number }[] = [];
    s.onStep = () => {
      const p = me(s.race);
      if (s.recorder.active && !s.ghosts.length) path.push({ t: s.race.raceTime - s.recorder.t0, x: p.x, y: p.y });
    };
    for (let i = 0; !s.ghosts.length && i < fps * 120; i++) s.frame((i * 1000) / fps);
    expect(s.ghosts.length).toBe(1);
    return { g: s.ghosts[0], path };
  };

  it('records the same 20 Hz ghost at 10 FPS as at 60 FPS, in the existing format', () => {
    const { g } = record(60);
    expect(record(10).g).toEqual(g);
    expect(Object.keys(g).sort()).toEqual(['L', 'car', 'initials', 'ms', 's', 'track', 'v']);
    expect(g.v).toBe(R.GHOST_VERSION);
    expect(g.s.length % 4).toBe(0);
    const times = g.s.filter((_, i) => i % 4 === 0);
    const gaps = times.slice(1, -2).map((t, i) => t - times[i]);
    expect(Math.max(...gaps)).toBeLessThan(1 / R.GHOST_HZ + STEP);
    expect(Math.min(...gaps)).toBeGreaterThan(1 / R.GHOST_HZ - 0.002);
    expect(times.at(-1)).toBeCloseTo(g.ms / 1000, 2);
  });

  it('a ghost saved and reloaded replays the path the car drove', () => {
    stubCanvas();
    const { g, path } = record(10);
    R.saveGhost(g);
    const loaded = R.loadGhost('circuit-1', 'sunburst', 'JD')!;
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(g));
    const player = new GhostPlayer(new (class { add(): void {} })() as never);
    player.setData(loaded); player.launch(100);
    expect(path.length).toBeGreaterThan(300);
    // from the second sample on: the t=0 sample is taken just past the line, so it reads up to one step ahead
    for (const want of path.filter((p) => p.t >= 1 / R.GHOST_HZ)) {
      player.update(100 + want.t, 0);
      const at = player.visual.group.position;
      expect(Math.hypot(at.x - want.x, -at.z - want.y)).toBeLessThan(0.03);
    }
  });

  it('plays a ghost saved by the previous build, with its uneven frame-paced samples', () => {
    stubCanvas();
    const L = +T.L.toFixed(3);
    const old = { v: 1, track: 'circuit-1', car: 'sunburst', initials: 'JD', L, ms: 4000, s: [0, 0, 1.2, 0, 0.051, 1, 1.2, 0, 0.117, 2.4, 1.2, 0.01, 0.183, 3.7, 1.2, 0, 4, L, 1.2, 0] };
    localStorage.setItem('srgp.ghost.circuit-1.sunburst.JD', JSON.stringify(old));
    const g = R.loadGhost('circuit-1', 'sunburst', 'JD');
    expect(g).toEqual(old);
    const player = new GhostPlayer(new (class { add(): void {} })() as never);
    player.setData(g); player.launch(50);
    player.update(50 + (0.051 + 0.117) / 2, 0);
    const want = T.point3(T.FINISH_S + 1.7, 1.2);
    expect(player.visual.group.visible).toBe(true);
    expect(player.visual.group.position.x).toBeCloseTo(want.x, 3);
    expect(player.visual.group.position.z).toBeCloseTo(-want.y, 3);
  });

  it('ranks a lap from the new loop among board entries saved by the previous build', () => {
    localStorage.setItem('srgp.lb.practice.circuit-1', JSON.stringify([
      { id: 'a', initials: 'OLD', car: 'sunburst', ms: 12000, at: 1 },
      { id: 'b', initials: 'OLD', car: 'blaze', ms: 90000, at: 2 },
    ]));
    const { g } = record(10);
    expect(g.ms).toBeGreaterThan(12000);
    R.submitLap('practice', 'circuit-1', 'JD', 'sunburst', g.ms);
    expect(R.board('practice', 'circuit-1').map((x) => x.initials)).toEqual(['OLD', 'JD', 'OLD']);
  });
});
