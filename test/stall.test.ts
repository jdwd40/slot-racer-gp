// Stopped-on-track recovery (#69): a human car stopped on the racing lane, not held by the game and not trapped behind a
// car ahead, gets a three-second warning and is then moved to its own bay. These tests drive the shared race core (the same
// code the room server runs) under continuous simulation. See docs/auto-bay.md#stopped-on-track-recovery.
import { describe, it, expect } from 'vitest';
import { Race, Car, LAPS, PEN, REFUEL_RATE, REV, STALL, type Controls, type Input, type RosterEntry, type WireEvent, type RaceSnapshot } from '../src/race';
import { stallLeft } from '../src/hud';
import { applySnapshot, localEvent, mirrorRace } from '../src/net/mirror';
import { FINISH_S } from '../src/track';
import { drive } from './server/bot';

const DT = 1 / 60;
const LAP = 3;
/** a straight on circuit-1 (curvature 0 from s 146 to 182), clear of the pit lane, the squeeze and the switches before it */
const STRAIGHT = 150;
const NONE: Input = { up: false, down: false };
const UP: Input = { up: true, down: false };
const BRAKE: Input = { up: false, down: true };
const BOTH: Input = { up: true, down: true };

/** A race already under way: no countdown, no start grace, every car on lap LAP. */
function race(roster: RosterEntry[], track = 'circuit-1', opts: { practice?: boolean } = {}): Race {
  const r = new Race({ roster, seed: 3, track, ...opts });
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; c.pitPlan = false; }
  return r;
}
const human = (id: string, slot?: number): RosterEntry => ({ id, control: 'human', slot });
const ai = (id: string, slot?: number): RosterEntry => ({ id, control: 'ai', slot });
function place(r: Race, c: Car, u: number, side: number, v: number): void {
  c.u = u; c.hiU = Math.max(c.hiU, u); c.laneSide = side; c.d = side * r.T.LANE_HALF; c.v = v; c.change = null; c.mode = 'race'; c.throttle = 0; c.revMark = null;
  r.pose(c);
}
/** AI cars hold their brakes where they are put. */
function parkAI(r: Race): void { r.ai = () => ({ t: 0, b: 1 }); }
type In = Controls | ((r: Race) => Controls);
/** Step for `sec` seconds at frame `dt`, collecting wire events; `each` runs after every frame (return true to stop). */
function run(r: Race, inputs: In, sec: number, each?: (ev: WireEvent[]) => boolean | void, dt = DT): WireEvent[] {
  const out: WireEvent[] = [];
  const n = Math.round(sec / dt);
  for (let i = 0; i < n; i++) {
    r.update(dt, typeof inputs === 'function' ? inputs(r) : inputs);
    const ev = r.drainEvents();
    out.push(...ev);
    if (each?.(ev)) break;
  }
  return out;
}
const recov = (ev: WireEvent[], id?: string): WireEvent[] => ev.filter((e) => e.type === 'recover' && (id === undefined || e.car === id));
const msgsOf = (ev: WireEvent[], id: string): string[] => ev.filter((e): e is Extract<WireEvent, { type: 'msg' }> => e.type === 'msg' && e.to === id).map((e) => e.text);
/** Race seconds from now until `id` is recovered (stepping at dt), or -1 within `max`. */
function timeToRecover(r: Race, id: string, inputs: In = {}, max = 12, dt = DT): number {
  const t0 = r.raceTime;
  let at = -1;
  run(r, inputs, max, (ev) => { if (recov(ev, id).length) { at = r.raceTime - t0; return true; } }, dt);
  return at;
}
/** Distance for track position s on lap `lap`, consistent with `crossed` = lap (so a scripted placement crosses no line by itself). */
const U = (r: Race, s: number, lap = LAP): number => r.T.FINISH_S + (lap - 1) * r.T.L + r.T.ahead(r.T.FINISH_S, s);
const touches = (r: Race, c: Car): boolean => r.cars.some((o) => o !== c && r.touching[Math.min(o.idx, c.idx) * 4 + Math.max(o.idx, c.idx)]);

describe('the three-second rule', () => {
  for (const side of [-1, 1]) for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    it(`alone on the ${side < 0 ? 'outside' : 'inside'} lane at ${Math.round(1 / dt)} fps: warning from the stop, none before 3.0 s, one recovery at the first step at or after it`, () => {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), side, 0);
      const t0 = r.raceTime;
      const ev: WireEvent[] = [];
      let lastRace = { t: 0, stallT: 0 }, at = -1;
      const left: number[] = [];
      for (let i = 0; i < Math.round(8 / dt); i++) {
        r.update(dt, {});
        const e = r.drainEvents(); ev.push(...e);
        if (at < 0 && recov(e, 'p').length) at = r.raceTime - t0;
        if (at < 0) { lastRace = { t: r.raceTime - t0, stallT: p.stallT }; left.push(stallLeft(p)); }
      }
      expect(recov(ev)).toHaveLength(1);
      // simulation time, sub-stepped at no more than 1/120 s: the deadline is met at 3.0 s to the sub-step, never earlier
      expect(at).toBeGreaterThanOrEqual(STALL.grace - 1e-9);
      expect(at).toBeLessThan(STALL.grace + 1 / 120 + 1e-9);
      // the frame before: still on the slot, counting, under 3 s
      expect(lastRace.stallT).toBeLessThan(STALL.grace);
      expect(lastRace.stallT).toBeGreaterThan(STALL.grace - dt - 1e-9);
      // the countdown reads 3, then 2, then 1, from the first frame of the stop
      expect(left[0]).toBe(3);
      expect([...new Set(left)]).toEqual([3, 2, 1]);
      expect(p).toMatchObject({ mode: 'service', bay: p.bayHome, status: 'running', stallT: 0, stallHold: false });
      expect(stallLeft(p)).toBe(0);
      expect(msgsOf(ev, 'p').filter((m) => m === 'msg.stallRecovered')).toHaveLength(1);
    });
  }

  it('the count is simulation time: pausing (no steps) holds it, and frame size never changes the recovery step', () => {
    const at: number[] = [];
    for (const dt of [1 / 24, 1 / 30, 1 / 60, 1 / 120, 1 / 144, 1 / 240]) {
      const r = race([human('p')]);
      place(r, r.car('p')!, U(r, STRAIGHT), 1, 0);
      at.push(timeToRecover(r, 'p', {}, 8, dt));
    }
    for (const x of at) expect(Math.abs(x - 3)).toBeLessThanOrEqual(1 / 120 + 1e-9);
    // a paused race (what the browser's pause does: no update at all) keeps the count where it was
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    run(r, {}, 2);
    const held = p.stallT;
    // ...a long pause...
    expect(p.stallT).toBe(held);
    const rest = timeToRecover(r, 'p');
    expect(held + rest).toBeGreaterThanOrEqual(3 - 1e-9);
    expect(held + rest).toBeLessThan(3 + DT);
  });

  it('a genuine drive-off cancels the warning at once; the episode boundary is STALL.goDist under Throttle at STALL.goV', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    run(r, {}, 2);
    expect(stallLeft(p)).toBe(1);
    let cleared = -1;
    const t0 = r.raceTime;
    const ev = run(r, { p: UP }, 1.2, () => { if (cleared < 0 && p.stallT === 0) cleared = r.raceTime - t0; });
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(0.8);       // about 0.6 s of driving: 4 m once over 3 m/s
    expect(stallLeft(p)).toBe(0);
    // stops again (both pedals: Brake wins, and reverse never arms): a fresh episode, the full 3 s again
    let stopT = -1;
    ev.push(...run(r, { p: BOTH }, 1.5, () => { if (stopT < 0 && p.stallT > 0) stopT = r.raceTime; }));
    expect(p.v).toBe(0);
    ev.push(...run(r, { p: BOTH }, stopT + 2.8 - r.raceTime));
    expect(recov(ev)).toHaveLength(0);
    const rest = timeToRecover(r, 'p', { p: BOTH });
    expect(Math.abs(r.raceTime - stopT - 3)).toBeLessThanOrEqual(DT + 1e-9);
    expect(rest).toBeGreaterThan(0);
  });

  it('a pull-away under way at 3 s is let finish (and ends the episode); lifting during it recovers the car on that step', () => {
    for (const lift of [false, true]) {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), 1, 0);
      run(r, {}, 2.9);
      let liftT = -1, at = -1;
      const t0 = r.raceTime;
      // Throttle from 2.9 s: the run to STALL.goDist takes about 0.6 s, so the count reaches 3 s during it
      run(r, () => ({ p: lift && r.raceTime - t0 > 0.3 ? NONE : UP }), 2, (ev) => {
        if (lift && liftT < 0 && r.raceTime - t0 > 0.3) liftT = r.raceTime - t0;
        if (at < 0 && recov(ev).length) at = r.raceTime - t0;
      });
      if (lift) { expect(Math.abs(at - liftT)).toBeLessThanOrEqual(DT + 1e-9); expect(p.mode).toBe('service'); }
      else { expect(at).toBe(-1); expect(p.mode).toBe('race'); expect(p.stallT).toBe(0); expect(p.v).toBeGreaterThan(STALL.goV); }
    }
  });

  it('exact thresholds: stopped below STALL.stopV; resumed after STALL.goDist without a break at STALL.goV or more under own Throttle', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    const h = 1 / 120;
    // judged directly (no movement): the start needs |v| < stopV with Throttle not pressed alone
    p.v = STALL.stopV; r.stallUpdate(h, {}); expect(p.stallT).toBe(0);
    p.v = -STALL.stopV; r.stallUpdate(h, {}); expect(p.stallT).toBe(0);
    p.v = STALL.stopV - 1e-6; r.stallUpdate(h, { p: UP }); expect(p.stallT).toBe(0);       // pulling away
    r.stallUpdate(h, { p: BOTH }); expect(p.stallT).toBe(h);                              // Brake wins: not driving
    // under goV, Throttle held: still stopped (the count runs)
    p.v = STALL.goV - 1e-6;
    for (let i = 0; i < 100; i++) r.stallUpdate(h, { p: UP });
    expect(p.stallT).toBeCloseTo(101 * h, 9);
    expect(p.stallRun).toBe(0);
    // at goV: the run counts, and ends the episode on the step it reaches goDist, not before
    p.v = STALL.goV;
    const steps = Math.ceil(STALL.goDist / (STALL.goV * h) - 1e-9);
    for (let i = 0; i < steps - 1; i++) r.stallUpdate(h, { p: UP });
    expect(p.stallT).toBeGreaterThan(0);
    expect(p.stallRun).toBeLessThan(STALL.goDist);
    r.stallUpdate(h, { p: UP });
    expect(p.stallT).toBe(0);
    // a break in the run (a coast, a brake or a slower step) starts the distance over
    r.stallUpdate(h, { p: BRAKE }); p.v = 0; r.stallUpdate(h, {}); expect(p.stallT).toBeGreaterThan(0);
    p.v = STALL.goV;
    for (let i = 0; i < steps - 1; i++) r.stallUpdate(h, { p: UP });
    r.stallUpdate(h, {});
    expect(p.stallRun).toBe(0);
    for (let i = 0; i < steps - 1; i++) r.stallUpdate(h, { p: UP });
    expect(p.stallT).toBeGreaterThan(0);
    // backing up pauses the count, never resets it
    p.v = -STALL.stopV; const t = p.stallT;
    r.stallUpdate(h, { p: BRAKE }); expect(p.stallT).toBe(t);
    p.v = -STALL.stopV + 1e-6; r.stallUpdate(h, { p: BRAKE }); expect(p.stallT).toBe(t + h);
  });

  for (const pulse of [1, 2, 6]) {
    it(`one-frame Throttle flickers (${pulse} frame${pulse > 1 ? 's' : ''} every 10) never reset the episode`, () => {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), 1, 0);
      let i = 0, reset = false;
      const at = timeToRecover(r, 'p', () => { if (i > pulse && p.stallT === 0) reset = true; return { p: i++ % 10 < pulse ? UP : NONE }; });
      // the episode starts on the first frame without Throttle, and from there runs straight through to 3 s
      const start = pulse * DT;
      expect(reset).toBe(false);
      expect(at - start).toBeGreaterThanOrEqual(3 - 1e-9);
      // a deadline inside a Throttle frame waits only for that pull-away to end: the first frame without Throttle recovers it
      expect(at - start).toBeLessThan(3 + pulse * DT + DT);
    });
  }

  for (const [up, brake] of [[0.1, 0.25], [0.2, 0.3], [0.25, 0.4]] as const) {
    it(`micro-nudges (Throttle ${up} s, Brake ${brake} s, repeated) cannot keep the car out of the pits`, () => {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), 1, 0);
      let t = 0, maxV = 0, start = -1, reset = false;
      const t0 = r.raceTime;
      const at = timeToRecover(r, 'p', () => {
        if (start < 0 && p.stallT > 0) start = r.raceTime - t0;
        if (start >= 0 && p.stallT === 0) reset = true;
        t += DT; maxV = Math.max(maxV, p.v);
        return { p: t % (up + brake) < up ? UP : BRAKE };
      });
      expect(maxV).toBeGreaterThan(0.3);        // the nudges really moved it
      expect(start).toBeGreaterThanOrEqual(0);
      expect(reset).toBe(false);                // no nudge ever ended the episode...
      expect(at - start).toBeLessThan(3 + up + 2 * DT);   // ...or stopped the count: at most the nudge in progress at 3 s
    });
  }

  it('back-and-forth with reverse: backing up pauses the count, the standstills still count, and the car is recovered', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    let t = 0, minV = 0, maxV = 0;
    // Brake 1.1 s (reverse engages after 0.6 s and backs up), then Throttle 0.35 s forward, repeated
    const at = timeToRecover(r, 'p', () => { t += DT; minV = Math.min(minV, p.v); maxV = Math.max(maxV, p.v); return { p: t % 1.45 < 1.1 ? BRAKE : UP }; }, 20);
    expect(minV).toBeLessThan(-1); expect(maxV).toBeGreaterThan(1);
    expect(at).toBeGreaterThan(3);
    expect(at).toBeLessThan(9);
  });
});

describe('who is recovered: blockers, not victims', () => {
  it('pushed from behind on full Throttle: the blocker is still recovered at 3 s; the pusher is trapped, not recovered, and drives on', () => {
    const r = race([human('b'), human('f')]);
    const b = r.car('b')!, f = r.car('f')!;
    place(r, b, U(r, STRAIGHT), 1, 0);
    place(r, f, U(r, STRAIGHT - r.T.CAR_LEN - 0.05), 1, 0);
    let pushedMax = 0, fEpisode = 0;
    const t0 = r.raceTime;
    // full Throttle into the stopped car, then (once it is gone) the bot's pace
    const ev = run(r, (rr) => ({ f: b.mode === 'race' ? UP : drive(rr.snapshot(), 'f') }), 8, () => { if (b.mode === 'race') pushedMax = Math.max(pushedMax, b.v); fEpisode = Math.max(fEpisode, f.stallT); });
    expect(pushedMax).toBeGreaterThan(0.2);   // it really was shoved
    const rec = recov(ev);
    expect(rec).toEqual([{ type: 'recover', car: 'b' }]);
    expect(b.mode).toBe('service');
    expect(fEpisode).toBe(0);                 // the follower never counted: it was behind a stopped car the whole time
    expect(f.u).toBeGreaterThan(U(r, STRAIGHT + 20));
    expect(f.offences + b.offences).toBe(0);
    expect(ev.filter((e) => e.type === 'offence')).toEqual([]);
    expect(r.raceTime - t0).toBeGreaterThan(3);
  });

  it('repeated rear bumps neither keep the blocker immune nor count against the bumping car', () => {
    const r = race([human('b'), human('f')]);
    const b = r.car('b')!, f = r.car('f')!;
    place(r, b, U(r, STRAIGHT), 1, 0);
    place(r, f, U(r, STRAIGHT - 2.4), 1, 0);
    let t = 0, bumps = 0, fEpisode = 0;
    const t0 = r.raceTime;
    let at = -1;
    run(r, () => { t += DT; return { f: t % 0.8 < 0.4 ? UP : BRAKE }; }, 8, (ev) => {
      bumps += ev.filter((e) => e.type === 'bump').length;
      if (b.mode === 'race') fEpisode = Math.max(fEpisode, f.stallT);
      if (recov(ev, 'b').length) { at = r.raceTime - t0; return true; }
    });
    expect(bumps).toBeGreaterThan(1);
    expect(Math.abs(at - 3)).toBeLessThanOrEqual(DT + 1e-9);
    expect(b.mode).toBe('service');
    // the bumping car is behind a stopped car nearly all the time: at most a moment's count while the blocker is shoved along
    expect(fEpisode).toBeLessThan(0.5);
    expect(f).toMatchObject({ mode: 'race', status: 'running' });
  });

  it('a two-car queue: only the front car is recovered; the follower then gets a fresh three seconds of its own', () => {
    const r = race([human('a'), human('b')]);
    const a = r.car('a')!, b = r.car('b')!;
    const u0 = U(r, STRAIGHT);
    place(r, a, u0, 1, 0);
    place(r, b, u0 - r.T.CAR_LEN - 1, 1, 0);
    const t0 = r.raceTime;
    const at: Record<string, number> = {};
    run(r, {}, 10, (ev) => { for (const e of recov(ev)) at[(e as { car: string }).car] = r.raceTime - t0; });
    expect(Object.keys(at).sort()).toEqual(['a', 'b']);
    expect(Math.abs(at.a - 3)).toBeLessThanOrEqual(1 / 120 + 1e-9);
    expect(Math.abs(at.b - 6)).toBeLessThanOrEqual(2 / 120 + 1e-9);
  });

  it('a three-car queue: the front obstruction is recovered, the two victims drive on and are never recovered', () => {
    const r = race([human('a'), human('b'), human('c')]);
    const [a, b, c] = ['a', 'b', 'c'].map((id) => r.car(id)!);
    const u0 = U(r, STRAIGHT);
    place(r, a, u0, -1, 0);
    place(r, b, u0 - r.T.CAR_LEN - 0.8, -1, 0);
    place(r, c, u0 - 2 * (r.T.CAR_LEN + 0.8), -1, 0);
    // b and c hold Throttle into the queue the whole time (pushing gently): only the stopped front car is a blocker
    const ev = run(r, { b: UP, c: UP }, 3 + 2 * DT);
    expect(recov(ev)).toEqual([{ type: 'recover', car: 'a' }]);
    expect([b.stallT, c.stallT]).toEqual([0, 0]);
    // then they drive on (a bot's pace, so they stay in the slot) and nobody else is ever recovered
    const more = run(r, (rr) => { const s = rr.snapshot(); return { b: drive(s, 'b'), c: drive(s, 'c') }; }, 10);
    expect(recov(more)).toEqual([]);
    expect(b.u).toBeGreaterThan(u0 + 50); expect(c.u).toBeGreaterThan(u0 + 40);
  });

  it('a three-car queue where nobody moves: front first, then each follower in turn, three seconds after it is uncovered', () => {
    const r = race([human('a'), human('b'), human('c')]);
    const u0 = U(r, STRAIGHT);
    for (const [id, k] of [['a', 0], ['b', 1], ['c', 2]] as const) place(r, r.car(id)!, u0 - k * (r.T.CAR_LEN + 1.5), 1, 0);
    const t0 = r.raceTime;
    const order: [string, number][] = [];
    run(r, {}, 12, (ev) => { for (const e of recov(ev)) order.push([(e as { car: string }).car, Math.round((r.raceTime - t0) * 120) / 120]); });
    expect(order.map((x) => x[0])).toEqual(['a', 'b', 'c']);
    order.forEach(([, t], k) => expect(Math.abs(t - 3 * (k + 1))).toBeLessThanOrEqual(2 / 120 + 1e-9));
  });

  it('the trapped gap boundary: a slow car just inside STALL.blockGap ahead exempts, just outside it does not', () => {
    for (const [gap, trapped] of [[STALL.blockGap - 0.05, true], [STALL.blockGap + 0.05, false]] as const) {
      const r = race([human('a'), human('b')]);
      const a = r.car('a')!, b = r.car('b')!;
      const u0 = U(r, STRAIGHT);
      place(r, a, u0, 1, 0);
      place(r, b, u0 - r.T.CAR_LEN - gap, 1, 0);
      const ev = run(r, {}, 3 + 2 * DT);
      expect(recov(ev).map((e) => (e as { car: string }).car).sort()).toEqual(trapped ? ['a'] : ['a', 'b']);
    }
    // a car ahead moving off at STALL.goV or more traps no one
    const r = race([human('a'), human('b')]);
    const a = r.car('a')!, b = r.car('b')!;
    place(r, a, U(r, STRAIGHT), 1, STALL.goV); place(r, b, a.u - r.T.CAR_LEN - 1, 1, 0);
    expect(r.stallBlock(b)).toBe(null);
    a.v = STALL.goV - 0.01;
    expect(r.stallBlock(b)).toBe('held');
  });

  it('a stopped car on the other lane beside or ahead is no exemption: both blockers are recovered, independently, in the same step', () => {
    for (const roster of [[human('a', 0), human('b', 1)], [human('a', 3), human('b', 1)], [human('b', 0), human('a', 2)]]) {
      const r = race(roster);
      const a = r.car('a')!, b = r.car('b')!;
      const u0 = U(r, STRAIGHT);
      place(r, a, u0, 1, 0);
      place(r, b, u0 - 2, -1, 0);          // just behind on the other lane: its own lane ahead is clear
      expect(r.stallBlock(b)).toBe(null); expect(r.stallBlock(a)).toBe(null);
      const t0 = r.raceTime;
      const seen: [string, number][] = [];
      run(r, {}, 4, (ev) => { for (const e of recov(ev)) seen.push([(e as { car: string }).car, r.raceTime - t0]); });
      expect(seen.map((x) => x[0]).sort()).toEqual(['a', 'b']);
      expect(seen[0][1]).toBe(seen[1][1]);
      expect(Math.abs(seen[0][1] - 3)).toBeLessThanOrEqual(1 / 120 + 1e-9);
    }
  });

  it('a car stopped on the bridge above (or below) is no exemption for the car on the other level', () => {
    const r = race([human('up'), human('lo')], 'circuit-4');
    const x = r.T.CROSSINGS[0];
    const hi = r.car('up')!, lo = r.car('lo')!;
    place(r, hi, U(r, x.sHi), 1, 0);
    place(r, lo, U(r, x.sLo - 0.6), 1, 0);
    expect(Math.hypot(hi.x - lo.x, hi.y - lo.y)).toBeLessThan(2);   // one above the other
    expect(hi.z - lo.z).toBeGreaterThan(1);
    expect(r.stallBlock(hi)).toBe(null); expect(r.stallBlock(lo)).toBe(null);
    const ev = run(r, {}, 3 + 2 * DT);
    expect(recov(ev).map((e) => (e as { car: string }).car).sort()).toEqual(['lo', 'up']);
  });

  it('one blocker in each lane with a victim behind each: both blockers recovered, both victims spared', () => {
    const r = race([human('a'), human('b'), human('va'), human('vb')]);
    const u0 = U(r, STRAIGHT);
    place(r, r.car('a')!, u0, 1, 0); place(r, r.car('va')!, u0 - r.T.CAR_LEN - 1, 1, 0);
    place(r, r.car('b')!, u0 + 3, -1, 0); place(r, r.car('vb')!, u0 + 3 - r.T.CAR_LEN - 2, -1, 0);
    const ev = run(r, {}, 3 + 2 * DT);
    expect(recov(ev).map((e) => (e as { car: string }).car).sort()).toEqual(['a', 'b']);
  });
});

describe('legitimate waits and other recoveries', () => {
  it('the grid and the lights never count; a car still stopped after the green is recovered 3 s after it; one moving off never warns', () => {
    for (const held of [false, true]) {
      const r = new Race({ roster: [human('p'), ai('x')], seed: 2, track: 'circuit-1' });
      const p = r.car('p')!;
      let countdownMax = 0, everWarned = false, goT = -1, at = -1;
      for (let i = 0; i < 60 * 12; i++) {
        r.update(DT, { p: held ? UP : NONE });
        const ev = r.drainEvents();
        if (ev.some((e) => e.type === 'go')) goT = r.t;
        if (r.phase === 'countdown') countdownMax = Math.max(countdownMax, p.stallT);
        if (p.stallT > 0) everWarned = true;
        if (at < 0 && recov(ev, 'p').length) at = r.t;
        if (held && p.u > r.T.FINISH_S + 30) break;
      }
      expect(countdownMax).toBe(0);
      if (held) { expect(everWarned).toBe(false); expect(at).toBe(-1); }
      else { expect(Math.abs(at - goT - 3)).toBeLessThanOrEqual(2 / 120 + 1e-9); }
    }
  });

  it('the shared pit queue holding a car on the road approach is a legitimate wait, however long', () => {
    const r = race([human('p'), ai('x'), ai('y')]);
    parkAI(r);
    const p = r.car('p')!, x = r.car('x')!, y = r.car('y')!;
    const L = r.T.L;
    // x stands in the box serving a long stop; y queues at the pit entrance behind it; p routed to the pits behind y
    x.mode = 'pitlane'; x.u = U(r, r.T.PEN_S); x.d = r.T.pitD(r.s(x)); x.v = 0; x.laneSide = -1; x.sgOwed = 30; x.sgDue = LAP + 1;
    place(r, y, U(r, r.T.PIT_IN0 - 0.5), -1, 0); y.pitReq = true; y.sgOwed = 3; y.sgDue = LAP + 1;
    place(r, p, U(r, r.T.PIT_IN0 - 12), -1, 6);
    p.sgOwed = 3; p.sgDue = LAP + 1; r.syncRoute(p);
    let held = false, maxT = 0;
    const ev = run(r, {}, 8, () => { if (p.mode === 'race' && p.v === 0 && p.pitHold) held = true; maxT = Math.max(maxT, p.stallT); });
    expect(held).toBe(true);
    expect(p.mode).toBe('race');
    expect(maxT).toBe(0);
    expect(recov(ev)).toEqual([]);
  });

  it('a road car stuck behind the held pit queue without a pit request is held too (approach hold)', () => {
    const r = race([human('p'), ai('x'), ai('y')]);
    parkAI(r);
    const p = r.car('p')!, x = r.car('x')!, y = r.car('y')!;
    const L = r.T.L;
    // x stands just inside the entrance, y is queued on the road right behind it (held), p comes up behind y with no request
    x.mode = 'pitlane'; x.u = U(r, r.T.PIT_IN0 + 1.8); x.d = r.T.pitD(r.s(x)); x.v = 0; x.laneSide = -1;
    place(r, y, U(r, r.T.PIT_IN0 - 0.3), -1, 0); y.pitReq = true; y.pitPlan = true;
    place(r, p, U(r, r.T.PIT_IN0 - 14), -1, 4);
    let held = -1, maxT = 0;
    // Throttle up to the queue, then nothing at all: the hold, not the pedal, keeps it there
    const ev = run(r, () => ({ p: held < 0 ? UP : NONE }), 9, () => {
      if (held < 0 && p.pitHold && Math.abs(p.v) < 0.05) held = r.raceTime;
      if (held >= 0) maxT = Math.max(maxT, p.stallT);
    });
    expect(held).toBeGreaterThan(0);
    expect(p.pitHold).toBe(true); expect(p.pitReq).toBe(false); expect(p.mode).toBe('race');
    expect(r.raceTime - held).toBeGreaterThan(5);
    expect(maxT).toBe(0);
    expect(recov(ev)).toEqual([]);
  });

  it('the squeeze priority hold is a legitimate wait', () => {
    const r = race([human('p'), ai('a')]);
    parkAI(r);
    const p = r.car('p')!, a = r.car('a')!;
    const L = r.T.L;
    place(r, a, U(r, r.T.SQ_Q1 + 2), -1, 0);
    place(r, p, U(r, r.T.SQ_Q1 - 0.2), 1, 0);
    r.squeezeQ.length = 0; r.squeezeQ.push(a, p);
    let held = -1;
    const ev = run(r, () => ({ p: held < 0 ? UP : NONE }), 8, () => { if (held < 0 && p.squeezeHold && Math.abs(p.v) < 0.05) held = r.raceTime; });
    expect(held).toBeGreaterThan(0);
    expect(r.raceTime - held).toBeGreaterThan(5);
    expect(p.mode).toBe('race');
    expect(recov(ev)).toEqual([]);
  });

  it('service and waits inside the pit lane and bays never count: the box, refuelling, a blocked merge and the pit exit line', () => {
    // serving a long stop-and-go in the box
    {
      const r = race([human('p')]);
      const p = r.car('p')!;
      p.sgOwed = 9; p.sgDue = LAP + 1; p.pitReq = true;
      p.mode = 'pitlane'; p.u = U(r, r.T.PEN_S); p.d = r.T.pitD(r.s(p)); p.v = 0; p.laneSide = -1;
      const ev = run(r, {}, 8);
      expect(p.mode).toBe('pitlane'); expect(p.sgServing).toBe(true); expect(p.sgServed).toBeGreaterThan(7);
      expect(recov(ev)).toEqual([]);
    }
    // refuelling, then a departure waiting on a blocked merge
    {
      const r = race([human('p'), ai('x')]);
      parkAI(r);
      const p = r.car('p')!, x = r.car('x')!;
      p.u = U(r, r.T.BAYS[p.bayHome]); p.d = r.T.PIT_D; p.v = 0; p.laneSide = -1; p.mode = 'pitlane';
      r.enterBay(p, p.bayHome);
      run(r, {}, 1.5);
      x.mode = 'pitlane'; x.u = U(r, r.T.BAYS[p.bayHome] + 0.5); x.d = r.T.PIT_D; x.v = 0; x.laneSide = -1;
      const ev = run(r, { p: UP }, 6);
      expect(p.mode).toBe('service'); expect(p.exitReq).toBe(true);
      expect(recov(ev)).toEqual([]);
    }
    // waiting at the pit exit line while the outside lane is blocked
    {
      const r = race([human('p'), ai('x')]);
      parkAI(r);
      const p = r.car('p')!, x = r.car('x')!;
      p.mode = 'pitlane'; p.u = U(r, r.T.PIT_OUT0 - 1); p.d = r.T.pitD(r.s(p)); p.v = 0; p.laneSide = -1; p.serviced = true; p.sgLeave = true;
      place(r, x, U(r, r.T.PIT_OUT1 + 1), -1, 0);
      const ev = run(r, {}, 6);
      expect(p.mode).toBe('pitlane'); expect(p.exitHold).toBe(true);
      expect(recov(ev)).toEqual([]);
    }
  });

  it('a de-slot is the marshal\'s recovery: no count while off or re-slotting, then a fresh three seconds', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 12);
    r.deslot(p);
    let backAt = -1, at = -1, maxOff = 0;
    const t0 = r.raceTime;
    run(r, {}, 10, (ev) => {
      if (backAt < 0 && p.mode === 'race') backAt = r.raceTime - t0;
      if (p.mode !== 'race' || p.recoverT > 0) maxOff = Math.max(maxOff, p.stallT);
      if (recov(ev, 'p').length) { at = r.raceTime - t0; return true; }
    });
    expect(backAt).toBeGreaterThan(1.5);
    expect(maxOff).toBe(0);
    // the re-slot grace (recoverT, 1 s) then 3 s of its own
    expect(at - backAt).toBeGreaterThan(3.9);
    expect(at - backAt).toBeLessThan(4.1);
  });

  it('out of fuel: the existing tow recovers the car, once; the stopped rule never adds a second recovery', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 6);
    p.fuel = 0;
    const ev = run(r, {}, 20);
    expect(ev.filter((e) => e.type === 'tow')).toHaveLength(1);
    expect(recov(ev)).toEqual([]);
    expect(msgsOf(ev, 'p')).toContain('msg.towPenalty');
  });

  it('a car towed on the very step its count would expire is towed only', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    run(r, {}, 3 - 2 / 120, undefined, 1 / 120);
    expect(p.stallT).toBeGreaterThan(2.98);
    p.fuel = 0;                               // the tow check in this step's car step wins
    const ev = run(r, {}, 1, undefined, 1 / 120);
    expect(ev.filter((e) => e.type === 'tow')).toHaveLength(1);
    expect(recov(ev)).toEqual([]);
  });

  it('terminal cars, retired cars, practice and the AI are never recovered', () => {
    for (const status of ['finished', 'dq', 'dnf'] as const) {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), 1, 0);
      p.status = status; p.finished = true;
      r.ai = () => ({ t: 0, b: 1 });        // a finished car is driven by the AI rule: keep it standing
      expect(recov(run(r, {}, 6))).toEqual([]);
    }
    // retired during the warning: parked by #44, never recovered as well
    {
      const r = race([human('p'), human('q')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), 1, 0); place(r, r.car('q')!, U(r, 40), -1, 10);
      const q = (rr: Race): Controls => ({ q: drive(rr.snapshot(), 'q') });
      run(r, q, 2);
      expect(p.stallT).toBeGreaterThan(1.9);
      r.retire('p');
      const ev = run(r, q, 6);
      expect(recov(ev)).toEqual([]);
      expect(p).toMatchObject({ retire: 'parked', status: 'dnf', dnfReason: 'retired', stallT: 0 });
    }
    // practice
    {
      const r = race([human('p')], 'circuit-1', { practice: true });
      place(r, r.car('p')!, U(r, STRAIGHT), 1, 0);
      expect(recov(run(r, {}, 6))).toEqual([]);
    }
    // an AI car standing still
    {
      const r = race([human('p'), ai('x')]);
      parkAI(r);
      place(r, r.car('x')!, U(r, STRAIGHT), 1, 0);
      place(r, r.car('p')!, U(r, 60), -1, 10);
      const ev = run(r, (rr) => ({ p: drive(rr.snapshot(), 'p') }), 6);
      expect(recov(ev)).toEqual([]);
    }
  });

  it('a terminal result on the same step wins: a car pushed over the final line as its count expires finishes and is not recovered', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    p.crossed = LAPS; p.lapsDone = LAPS - 1; p.sectors = 7;
    place(r, p, r.T.FINISH_S + LAPS * r.T.L - 0.002, -1, 0.5);   // crawling: under stopV, so it counts
    p.stallT = STALL.grace - 1 / 240;
    const ev = run(r, {}, 1 / 120, undefined, 1 / 120);
    expect(p.status).toBe('finished');
    expect(recov(ev)).toEqual([]);
    expect(p.stallT).toBe(0);
  });

  it('selecting Pit, holding Brake (or both pedals) or asking for lane changes is not a wait', () => {
    // (Brake alone held at a standstill engages reverse, which is driving: see the reverse tests)
    const cases: [string, (r: Race) => Controls][] = [
      ['nothing', () => ({})],
      ['both', () => ({ p: BOTH })],
    ];
    for (const [, inp] of cases) {
      const r = race([human('p')]);
      const p = r.car('p')!;
      place(r, p, U(r, STRAIGHT), -1, 0);
      r.requestPit('p');
      expect(p.pitReq).toBe(true);
      const at = timeToRecover(r, 'p', inp);
      expect(Math.abs(at - 3)).toBeLessThanOrEqual(DT);
    }
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    let seq = 0;
    const at = timeToRecover(r, 'p', (rr) => { if (Math.round(rr.raceTime * 60) % 24 === 0) rr.act({ driver: 'p', seq: ++seq, type: 'lane' }); return {}; });
    expect(seq).toBeGreaterThan(4);
    expect(Math.abs(at - 3)).toBeLessThanOrEqual(DT);
  });

  it('reverse to an overshot pit entrance is still a legitimate recovery: it backs up, is taken in and never recovered', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, r.T.PIT_IN0 + 2), -1, 0);
    r.requestPit('p');
    let minV = 0;
    const ev = run(r, { p: BRAKE }, 4, () => { minV = Math.min(minV, p.v); return p.sgCtl; });
    expect(minV).toBeLessThan(-0.5);
    expect(p.sgCtl).toBe(true);
    ev.push(...run(r, {}, 8, () => p.mode === 'service'));
    expect(p.mode).toBe('service');
    expect(p.towSvc).toBe(false);              // a real visit, not a recovery
    expect(recov(ev)).toEqual([]);
  });
});

describe('the recovery itself', () => {
  it('keeps identity, laps, fuel, every debt, deadline and breach; gains nothing; voids the lap; no tow penalty', () => {
    const r = race([human('p', 2), ai('x')]);
    parkAI(r);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    place(r, r.car('x')!, U(r, 60), -1, 0);
    Object.assign(p, { sgOwed: PEN.stopSeconds, sgDue: LAP + 1, sgDeferred: true, fuelDue: LAP, svcBreach: 'fuel', offences: 2, fuel: 0.37, bestLap: 20.5, lastLap: 21.25, pitStops: 1, lapValid: true, sectors: 3 });
    r.syncRoute(p);
    const keep = (c: Car) => ({ id: c.id, name: c.name, color: c.color, num: c.num, idx: c.idx, bayHome: c.bayHome, status: c.status, crossed: c.crossed, lapsDone: c.lapsDone, bestLap: c.bestLap, lastLap: c.lastLap, pitStops: c.pitStops, offences: c.offences, timePen: c.timePen, sgOwed: c.sgOwed, sgDue: c.sgDue, sgDeferred: c.sgDeferred, fuelDue: c.fuelDue, svcBreach: c.svcBreach, hiU: c.hiU, sectors: c.sectors });
    const before = keep(p), u = p.u, fuel = p.fuel;
    const ev = run(r, {}, 3 + DT, (e) => recov(e).length > 0);
    expect(recov(ev)).toHaveLength(1);
    expect(keep(p)).toEqual(before);
    expect(p.fuel).toBe(fuel);
    expect(p.u).toBeLessThan(u);
    expect(p.u).toBeCloseTo(u - r.T.ahead(r.T.BAYS[p.bayHome], r.T.wrapS(u)), 9);
    expect(r.T.gapS(r.s(p), r.T.BAYS[p.bayHome])).toBeCloseTo(0, 9);
    expect(p).toMatchObject({ mode: 'service', bay: 2, lapValid: false, towSvc: true, penalty: 0, upPrev: true, exitReq: false, v: 0, d: r.T.BAY_D });
    expect(r.pit.bays.filter((x) => x === p.idx)).toHaveLength(1);
    expect(r.pit.held(p)).toEqual(['bay2']);
    expect(msgsOf(ev, 'p')).not.toContain('msg.towPenalty');
    expect(ev.filter((e) => e.type === 'tow' || e.type === 'lap' || e.type === 'served')).toEqual([]);
    // standing in the bay is not the committed fuel stop and not the stop-and-go; it refuels only at the usual rate
    const t0 = r.raceTime;
    run(r, {}, 2);
    expect(p.fuelDue).toBe(LAP); expect(p.sgOwed).toBe(PEN.stopSeconds); expect(p.svcBreach).toBe('fuel');
    expect(p.fuel).toBeLessThanOrEqual(fuel + REFUEL_RATE * (r.raceTime - t0) + 1e-9);
    expect(p.fuel).toBeLessThan(1);
    expect(r.departBlock(p)).toBe(null);       // no tow penalty: only the usual settle time
  });

  it('the lane is clear the moment it happens: the car behind drives through the spot, with no contact, ghost or bump', () => {
    const r = race([human('p'), ai('f')]);
    const p = r.car('p')!, f = r.car('f')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    place(r, f, U(r, STRAIGHT - 12), 1, 0);
    const spot = p.u;
    // f waits behind, then drives (a steady part throttle on the straight) through where p stood
    r.ai = () => (p.mode === 'race' ? { t: 0, b: 1 } : { t: 0.6, b: 0 });
    run(r, {}, 3 + DT, (e) => recov(e).length > 0);
    expect(p.mode).toBe('service');
    const ev = run(r, {}, 3);
    expect(f.u).toBeGreaterThan(spot + 10);
    expect(ev.filter((e) => (e.type === 'bump' || e.type === 'offence') && ('car' in e && (e.car === 'p' || (e as { other?: string }).other === 'p')))).toEqual([]);
    expect(touches(r, p)).toBe(false);
  });

  it('its own bay taken: it waits out of traffic and out of sight, never on the slot, and is placed once the bay is free', () => {
    const r = race([human('p'), ai('o'), ai('f')]);
    const p = r.car('p')!, o = r.car('o')!, f = r.car('f')!;
    const j = p.bayHome;
    // scripted: another car standing in p's bay (no car ever takes another team's bay in a real race)
    o.u = U(r, r.T.BAYS[j]); o.d = r.T.PIT_D; o.v = 0; o.laneSide = -1; o.mode = 'pitlane';
    r.enterBay(o, j);
    o.penalty = 999;        // it stays until released below
    place(r, p, U(r, STRAIGHT), 1, 0);
    place(r, f, U(r, STRAIGHT - 25), 1, 14);
    const ev = run(r, {}, 3 + DT, (e) => recov(e).length > 0);
    expect(recov(ev)).toHaveLength(1);
    expect(p).toMatchObject({ mode: 'tow', stallHold: true, v: 0 });
    expect(p.towT).toBeGreaterThanOrEqual(0.9);     // the browser draws a tow this far along as gone
    expect(r.pit.held(p)).toEqual([]);
    // the traffic behind passes the spot: nothing on the slot
    const later = run(r, {}, 2);
    expect(f.u).toBeGreaterThan(U(r, STRAIGHT + 5));
    expect(touches(r, p)).toBe(false);
    expect(p.mode).toBe('tow');
    // the occupant leaves: p is placed in its own bay, without a second recovery
    o.penalty = 0; o.refuelTarget = 0;
    later.push(...run(r, {}, 10, () => p.mode === 'service'));
    expect(p).toMatchObject({ mode: 'service', bay: j, stallHold: false, towSvc: true });
    expect(recov(later)).toEqual([]);
    expect(r.pit.bays.filter((x) => x === p.idx)).toHaveLength(1);
    expect(r.pit.bays.filter((x) => x === o.idx)).toHaveLength(0);
  });

  it('recovering is once: a second call, a car in its bay or one no longer racing changes nothing', () => {
    const r = race([human('p')]);
    const p = r.car('p')!;
    place(r, p, U(r, STRAIGHT), 1, 0);
    expect(r.stallRecover(p)).toBe(true);
    const u = p.u, snap = JSON.stringify(r.snapshot());
    expect(r.stallRecover(p)).toBe(false);
    expect(p.u).toBe(u);
    expect(JSON.stringify(r.snapshot())).toBe(snap);
    expect(recov(r.drainEvents())).toHaveLength(1);
    // and after 10 s in the bay with nothing pressed, still exactly one
    expect(recov(run(r, {}, 10))).toEqual([]);
    for (const set of [(c: Car) => { c.status = 'dnf'; }, (c: Car) => { c.finished = true; }, (c: Car) => { c.mode = 'off'; }, (c: Car) => { c.retire = 'coast'; }]) {
      const q = race([human('p')]);
      const c = q.car('p')!;
      place(q, c, U(q, STRAIGHT), 1, 0);
      set(c);
      expect(q.stallRecover(c)).toBe(false);
      expect(recov(q.drainEvents())).toEqual([]);
    }
  });

  it('leaving needs a released Throttle and then a fresh press, and waits for a clear merge; it then rejoins under the usual rules', () => {
    const r = race([human('p'), ai('x')]);
    const p = r.car('p')!, x = r.car('x')!;
    parkAI(r);
    place(r, x, U(r, 80), -1, 0);
    place(r, p, U(r, STRAIGHT), 1, 0);
    // stopped with Brake and Throttle both held (Brake wins), then still holding Throttle through the recovery
    run(r, { p: BOTH }, 3 + DT, (e) => recov(e).length > 0);
    expect(p.mode).toBe('service');
    const held = run(r, { p: UP }, 3);
    expect(p.mode).toBe('service'); expect(p.exitReq).toBe(false); expect(p.sgPhase).toBe('release');
    expect(msgsOf(held, 'p')).not.toContain('msg.departReq');
    run(r, { p: NONE }, 0.2);
    expect(p.sgPhase).toBe('ready');
    // a pit-lane car right at the bay blocks the merge: the request latches and waits
    x.mode = 'pitlane'; x.u = U(r, r.T.BAYS[p.bayHome] - 1); x.d = r.T.PIT_D; x.v = 0; x.laneSide = -1;
    const press = run(r, { p: UP }, 1.5);
    expect(msgsOf(press, 'p')).toContain('msg.departReq');
    expect(p.mode).toBe('service'); expect(p.exitReq).toBe(true); expect(p.sgPhase).toBe('exit');
    // the lane clears: it goes, once, without another press, and is driven to the exit and handed back
    place(r, x, U(r, 120), 1, 0);
    const out = run(r, {}, 15, () => p.mode === 'race');
    expect(p.mode).toBe('race');
    expect(p.graceT).toBeGreaterThan(0);
    expect(msgsOf(out, 'p')).toContain('msg.sgHandover');
    expect(out.filter((e) => e.type === 'offence' || e.type === 'tow')).toEqual([]);
    expect(p.timePen).toBe(0);
    expect(recov(out)).toEqual([]);
  });
});

describe('no shortcut: progress, laps, timing and position', () => {
  /** p alone, stopped at track position s on lap `lap`, then recovered. */
  function scenario(s: number, lap: number, side = 1) {
    const r = race([human('p')]);
    const p = r.car('p')!;
    p.crossed = lap; p.lapsDone = lap - 1; p.sectors = 0; p.lapValid = true; p.bestLap = 20.5;
    const u = r.T.FINISH_S + (lap - 1) * r.T.L + r.T.ahead(r.T.FINISH_S, s);
    place(r, p, u, side, 0); p.lapStartT = r.raceTime - 4;
    const pre = run(r, {}, 3 + DT, (e) => recov(e).length > 0);
    expect(recov(pre)).toHaveLength(1);
    expect(pre.filter((e) => e.type === 'lap' || e.type === 'finish')).toEqual([]);
    return { r, p, u };
  }
  /** Drive p by the test bot from the bay until `stop` (it waits for Ready, then presses Throttle afresh), collecting events. */
  function driveOn(r: Race, stop: () => boolean, max = 60): WireEvent[] {
    return run(r, (rr) => { const c = rr.car('p')!; return { p: c.mode === 'service' ? { up: c.sgPhase === 'ready', down: false } : drive(rr.snapshot(), 'p', 0.9) }; }, max, () => stop());
  }

  for (const [where, s] of [['just past the timing line', 25], ['just before its bay', 10.5], ['between its bay and the line', 20], ['mid-lap', STRAIGHT]] as const) {
    it(`stopped ${where}: moved back to its bay, never forward; the line is not counted twice; the next lap is void`, () => {
      const { r, p, u } = scenario(s, LAP);
      const bay = r.T.BAYS[p.bayHome];
      expect(p.u).toBeLessThan(u);
      expect(u - p.u).toBeCloseTo(r.T.ahead(bay, s), 6);
      expect([p.crossed, p.lapsDone]).toEqual([LAP, LAP - 1]);
      // drive on until one lap event: it comes only when the car really completes lap LAP, never on a re-crossing
      const lapU = r.T.FINISH_S + LAP * r.T.L;
      let firstLapAtU = -1;
      const ev = driveOn(r, () => { if (firstLapAtU < 0 && p.lapsDone === LAP) firstLapAtU = p.u; return p.lapsDone >= LAP; });
      const laps = ev.filter((e): e is Extract<WireEvent, { type: 'lap' }> => e.type === 'lap');
      expect(laps).toHaveLength(1);
      expect(laps[0]).toMatchObject({ valid: false, best: false, lapsDone: LAP });
      expect(firstLapAtU).toBeGreaterThanOrEqual(lapU);
      expect(firstLapAtU).toBeLessThan(lapU + 1);
      expect(p.bestLap).toBe(20.5);
      expect(recov(ev)).toEqual([]);
    });
  }

  it('the start-line wrap on lap 1: moved back over the line it started from, no lap is counted until the real end of lap 1', () => {
    const { r, p } = scenario(FINISH_S + 3, 1);
    expect(p.u).toBeLessThan(r.T.FINISH_S);
    expect([p.crossed, p.lapsDone]).toEqual([1, 0]);
    const ev = driveOn(r, () => p.lapsDone >= 1);
    expect(ev.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect(p.u).toBeGreaterThan(r.T.FINISH_S + r.T.L);
  });

  it('the final lap, stopped mid-lap: moved back over the line, it must drive the whole lap again; it finishes once, at the real flag', () => {
    const { r, p } = scenario(STRAIGHT, LAPS);
    const flagU = r.T.FINISH_S + LAPS * r.T.L;
    let finishU = -1;
    const ev = driveOn(r, () => { if (finishU < 0 && p.finished) finishU = p.u; return p.finished; }, 80);
    expect(ev.filter((e) => e.type === 'finish')).toHaveLength(1);
    expect(finishU).toBeGreaterThanOrEqual(flagU);
    expect(p.status).toBe('finished'); expect(p.bestLap).toBe(20.5);
    expect(ev.filter((e) => e.type === 'lap')).toHaveLength(1);
    expect(ev.find((e) => e.type === 'lap')).toMatchObject({ valid: false, best: false });
  });

  it('the final lap, stopped between its bay and the line: it leaves the pits over the line and finishes there, lap void', () => {
    const { r, p } = scenario(20, LAPS);
    const ev = driveOn(r, () => p.finished, 30);
    expect(p.status).toBe('finished');
    expect(ev.filter((e) => e.type === 'finish')).toHaveLength(1);
    expect(ev.find((e) => e.type === 'lap')).toMatchObject({ valid: false, best: false, lapsDone: LAPS });
  });

  it('never a better position: a rival just behind is ahead once the stopped car is recovered', () => {
    const r = race([human('p'), ai('x')]);
    parkAI(r);
    const p = r.car('p')!, x = r.car('x')!;
    for (const s of [25, 10.5, 20, STRAIGHT]) {
      const u = r.T.FINISH_S + (LAP - 1) * r.T.L + r.T.ahead(r.T.FINISH_S, s);
      place(r, p, u, 1, 0); p.mode = 'race';
      place(r, x, u - 0.5, -1, 0);
      expect(r.order()[0]).toBe(p);
      expect(r.stallRecover(p)).toBe(true);
      expect(r.order()[0]).toBe(x);
      expect(p.u).toBeLessThan(x.u);
      r.drainEvents();
    }
  });
});

describe('state on the wire and determinism', () => {
  it('the mirror shows the server\'s countdown and the recovery; the recovery event crosses the wire intact', () => {
    const srv = race([human('a', 1), human('b', 0)]);
    const a = srv.car('a')!;
    place(srv, a, U(srv, STRAIGHT), 1, 0);
    place(srv, srv.car('b')!, U(srv, 40), -1, 12);
    const snap = (): RaceSnapshot => JSON.parse(JSON.stringify(srv.snapshot())) as RaceSnapshot;
    const m = mirrorRace(snap());
    const wire: WireEvent[] = [];
    for (let i = 0; i < 60 * 5; i++) {
      srv.update(DT, { b: drive(srv.snapshot(), 'b') });
      const ev = JSON.parse(JSON.stringify(srv.drainEvents())) as WireEvent[];
      wire.push(...ev);
      applySnapshot(m, snap());
      const ma = m.car('a')!;
      expect(stallLeft(ma)).toBe(stallLeft(a));
      expect([ma.stallT, ma.stallHold, ma.mode]).toEqual([a.stallT, a.stallHold, a.mode]);
      for (const e of ev) expect(localEvent(m, e)).not.toBeNull();
    }
    expect(recov(wire)).toEqual([{ type: 'recover', car: 'a' }]);
    expect(localEvent(m, recov(wire)[0])).toMatchObject({ type: 'recover', car: m.car('a') });
    // an older snapshot without the fields leaves the mirror's view at no warning
    const old = snap();
    for (const c of old.cars) { delete c.stallT; delete c.stallHold; }
    const m2 = mirrorRace(old);
    expect(stallLeft(m2.car('a')!)).toBe(0);
  });

  it('a replay of the same race is identical, recoveries included', () => {
    const go = (): string => {
      const r = race([human('a'), human('b'), human('c'), ai('x')]);
      const u0 = U(r, STRAIGHT);
      place(r, r.car('a')!, u0, 1, 0); place(r, r.car('b')!, u0 - 2.5, 1, 0); place(r, r.car('c')!, u0 + 1, -1, 0);
      place(r, r.car('x')!, u0 - 40, 1, 15);
      const ev = run(r, (rr) => ({ b: rr.raceTime > 9 ? drive(rr.snapshot(), 'b') : NONE }), 14);
      return JSON.stringify({ ev, s: r.snapshot() });
    };
    const one = go();
    expect(one).toBe(go());
    expect(one).toContain('"type":"recover"');
  });

  it('AI driving and a human who never stops are unchanged by the rule (the same race with the rule switched off)', () => {
    const go = (rule: boolean, roster: RosterEntry[]): string => {
      const r = new Race({ roster, seed: 21, track: 'circuit-2' });
      if (!rule) r.stallUpdate = () => {};
      const human = roster.some((e) => e.control === 'human');
      const ev: WireEvent[] = [];
      for (let i = 0; i < 60 * 70; i++) {
        r.update(DT, human ? { p: drive(r.snapshot(), 'p') } : {});
        ev.push(...r.drainEvents());
      }
      return JSON.stringify({ ev, s: r.snapshot() });
    };
    for (const roster of [[ai('a', 0), ai('b', 1), ai('c', 2), ai('d', 3)], [human('p', 0), ai('b', 1), ai('c', 2), ai('d', 3)]]) {
      const on = go(true, roster);
      expect(on).toBe(go(false, roster));
      expect(on).not.toContain('"type":"recover"');
    }
  });
});
