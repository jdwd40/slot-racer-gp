// The squeeze priority queue after a car has left it inside the squeeze (#100): a marshal re-slot and a car driving forward
// again after backing up put the car back in the queue at its physical place, so it waits for the cars ahead and holds the
// cars behind again. A car leaving the pit lane inside the squeeze (circuit-4) joins it the same way (#110). The away rejoin (#74) is tested in test/stall.test.ts. See docs/reverse.md and docs/online-server.md.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TRACKS } from '../src/track';
import { Race, Car, REV, type Controls, type Input, type RosterEntry, type WireEvent } from '../src/race';

const DT = 1 / 60;
const LAP = 3;
const NONE: Input = { up: false, down: false };
const UP: Input = { up: true, down: false };
const BRAKE: Input = { up: false, down: true };

/**
 * A race under way, every car human. On circuit-1 (the default) the squeeze runs from SQ_ENTRY 35.8 to SQ_EXIT 65.1, clear of
 * the pit lane; on circuit-4 it runs from 30.1 to 54.7, so the pit exit (PIT_OUT1 = 31) is inside it (#110).
 */
function race(ids: string[], track = 'circuit-1'): Race {
  const roster: RosterEntry[] = ids.map((id, slot) => ({ id, control: 'human', slot }));
  const r = new Race({ roster, seed: 5, track });
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; c.pitPlan = false; }
  // cars stand still on purpose here: the stopped-on-track rule (#69, tested in test/stall.test.ts) is not this test
  r.stallUpdate = () => {};
  return r;
}
/** Distance for track position s on lap LAP (so a scripted placement crosses no line by itself). */
const U = (r: Race, s: number): number => r.T.FINISH_S + (LAP - 1) * r.T.L + r.T.ahead(r.T.FINISH_S, s);
function place(r: Race, c: Car, s: number, side: number): void {
  c.u = U(r, s); c.hiU = Math.max(c.hiU, c.u); c.laneSide = side; c.d = side * r.T.laneHalf(s); c.v = 0; c.change = null;
  c.mode = 'race'; c.throttle = 0; c.revMark = null;
  r.pose(c);
}
/** A car in the pit lane at s (short of the exit), rolling at v. */
function placePit(r: Race, c: Car, s: number, v: number): void {
  c.u = U(r, s); c.hiU = Math.max(c.hiU, c.u); c.laneSide = -1; c.d = r.T.pitD(s); c.v = v; c.change = null;
  c.mode = 'pitlane'; c.throttle = 0; c.revMark = null; c.lapValid = false;
  r.pose(c);
}
/** Step for `sec` seconds; `each` runs after every frame (return true to stop). */
function run(r: Race, inputs: Controls | (() => Controls), sec: number, each?: (ev: WireEvent[]) => boolean | void): WireEvent[] {
  const out: WireEvent[] = [];
  for (let i = 0; i < Math.round(sec / DT); i++) {
    r.update(DT, typeof inputs === 'function' ? inputs() : inputs);
    const ev = r.drainEvents();
    out.push(...ev);
    if (each?.(ev)) break;
  }
  return out;
}
const contacts = (ev: WireEvent[]): WireEvent[] => ev.filter((e) => e.type === 'bump' || e.type === 'offence');
const ids = (r: Race): string[] => r.squeezeQ.map((c) => c.id);
/** The queue's physical order: by progress from the squeeze entry, furthest first. */
const physical = (r: Race, cars: Car[]): string[] =>
  [...cars].sort((a, b) => r.T.gapS(r.T.SQ_ENTRY, r.s(b)) - r.T.gapS(r.T.SQ_ENTRY, r.s(a))).map((c) => c.id);
/** Clear slot from `rear`'s nose to `front`'s tail, along the slot. */
const clear = (r: Race, rear: Car, front: Car): number => r.T.gapS(r.s(rear), r.s(front)) - r.T.CAR_LEN;

describe('marshal re-slot inside the squeeze (#100)', () => {
  /**
   * d leads b and c through the squeeze and de-slots; b drives past d's spot and stops further on, c stays behind. The marshal
   * puts d back 1.6 m behind where it left, inside the squeeze, between b and c.
   */
  function reslot() {
    const r = race(['d', 'b', 'c']);
    const [d, b, c] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, d, E + 12, 1); place(r, b, E + 6, -1); place(r, c, E + 1, -1);
    r.squeezeQ.length = 0; r.squeezeQ.push(d, b, c);
    r.deslot(d);
    expect(ids(r)).toEqual(['b', 'c']);
    // b goes past the empty spot (d is out of traffic) and brakes to a stop well clear of it, still inside the squeeze
    run(r, () => ({ b: r.s(b) < E + 17 ? UP : b.v > 0 ? BRAKE : NONE }), 4, () => d.mode === 'race');
    expect(d.mode).toBe('race');
    const ev: WireEvent[] = [];
    return { r, d, b, c, ev };
  }

  it('the re-slotted car is queued again at its physical place: behind the car that went past, ahead of the one behind', () => {
    const { r, d, b, c } = reslot();
    expect(r.T.inRange(r.s(d), r.T.SQ_ENTRY, r.T.SQ_EXIT)).toBe(true);
    expect(r.T.gapS(r.s(d), r.s(b))).toBeGreaterThan(r.T.CAR_LEN);   // b is ahead of d now
    expect(ids(r)).toEqual(['b', 'd', 'c']);
    expect(ids(r)).toEqual(physical(r, [d, b, c]));
  });

  it('it is capped by the car ahead and caps the car behind: both drive on into standing traffic and nobody touches', () => {
    const { r, d, b, c } = reslot();
    let minDB = Infinity, minCD = Infinity, held = false;
    // b stands; d and c drive at it flat out
    const ev = run(r, { b: NONE, d: UP, c: UP }, 4, () => {
      minDB = Math.min(minDB, clear(r, d, b)); minCD = Math.min(minCD, clear(r, c, d));
      held ||= c.squeezeHold || d.squeezeHold;
    });
    expect(ids(r)).toEqual(['b', 'd', 'c']);
    expect(contacts(ev)).toEqual([]);
    expect(minDB).toBeGreaterThan(0);
    expect(minCD).toBeGreaterThan(0);
    // both really closed up and were held there by the queue
    expect(clear(r, d, b)).toBeLessThan(1);
    expect(clear(r, c, d)).toBeLessThan(1);
    expect(held).toBe(true);
  });

  it('re-slotted short of the squeeze entry it is not queued until it crosses the entry, then last', () => {
    const r = race(['d', 'b']);
    const [d, b] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, d, E + 0.5, 1); place(r, b, E + 8, -1);
    r.squeezeQ.length = 0; r.squeezeQ.push(b, d);
    r.deslot(d);
    run(r, {}, 3, () => d.mode === 'race');
    expect(d.mode).toBe('race');
    expect(r.T.inRange(r.s(d), E, r.T.SQ_EXIT)).toBe(false);
    expect(ids(r)).toEqual(['b']);
    run(r, { d: UP }, 1, () => r.squeezeQ.includes(d));
    expect(ids(r)).toEqual(['b', 'd']);
  });
});

describe('backing up inside the squeeze and driving on (#100)', () => {
  /**
   * p leads b and c into the squeeze, p on the inside lane, b and c on the outside one, where the lanes are still wide enough
   * to pass alongside. p backs up past b, staying inside the squeeze, and ends between b and c.
   */
  function backPast() {
    const r = race(['p', 'b', 'c']);
    const [p, b, c] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, p, E + 4, 1); place(r, b, E + 2.2, -1); place(r, c, E + 0.2, -1);
    r.squeezeQ.length = 0; r.squeezeQ.push(p, b, c);
    run(r, { p: BRAKE }, REV.engage + 0.1, () => p.revOn);
    expect(p.revOn).toBe(true);
    run(r, { p: BRAKE }, 3, () => r.T.gapS(r.T.SQ_ENTRY, r.s(p)) < 1.5);
    expect(ids(r)).toEqual(['b', 'c']);                // backing up left the queue
    run(r, { p: NONE }, 1, () => p.v === 0);            // rolls to rest, still out of the queue
    expect(p.v).toBe(0);
    expect(ids(r)).toEqual(['b', 'c']);
    expect(r.T.inRange(r.s(p), E, r.T.SQ_EXIT)).toBe(true);
    expect(r.T.gapS(r.s(p), r.s(b))).toBeGreaterThan(0.5);   // b is ahead of p now
    expect(r.T.gapS(r.s(c), r.s(p))).toBeGreaterThan(0.5);   // c is still behind p
    return { r, p, b, c };
  }

  it('driving forward again puts it back at its physical place, behind the car it backed past', () => {
    const { r, p, b, c } = backPast();
    run(r, { p: UP }, 1, () => p.v > 0);
    expect(ids(r)).toEqual(['b', 'p', 'c']);
    expect(ids(r)).toEqual(physical(r, [p, b, c]));
  });

  it('it is capped by the car ahead and caps the car behind through the narrow section: the order holds and nobody touches', () => {
    const { r, p, b, c } = backPast();
    let minPB = Infinity, minCP = Infinity, held = false;
    // all three drive on together: b first, then p, then c
    const ev = run(r, { b: UP, p: UP, c: UP }, 3, () => {
      if (r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT)) {
        minPB = Math.min(minPB, r.T.gapS(r.s(p), r.s(b))); minCP = Math.min(minCP, r.T.gapS(r.s(c), r.s(p)));
      }
      held ||= p.squeezeHold || c.squeezeHold;
    });
    expect(contacts(ev)).toEqual([]);
    expect(minPB).toBeGreaterThan(0.5);
    expect(minCP).toBeGreaterThan(0.5);
    expect(held).toBe(true);
    // everyone came through in queue order
    expect(r.T.gapS(r.s(p), r.s(b))).toBeGreaterThan(r.T.CAR_LEN);
    expect(r.T.gapS(r.s(c), r.s(p))).toBeGreaterThan(r.T.CAR_LEN);
  });

  it('backing up without passing anyone, it drives on in its old place and holds the car behind again', () => {
    const r = race(['p', 'b']);
    const [p, b] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, p, E + 14, 1); place(r, b, E + 2, -1);
    r.squeezeQ.length = 0; r.squeezeQ.push(p, b);
    run(r, { p: BRAKE }, REV.engage + 0.1, () => p.revOn);
    run(r, { p: BRAKE }, 0.6);
    expect(ids(r)).toEqual(['b']);
    run(r, { p: NONE }, 1, () => p.v === 0);
    // p creeps forward and stops again (short of where it first backed up from), then b comes up behind it at full Throttle
    run(r, { p: UP }, 0.2);
    expect(ids(r)).toEqual(['p', 'b']);
    run(r, { p: BRAKE }, 1, () => p.v === 0);
    expect(p.revOn).toBe(false);
    let min = Infinity;
    const ev = run(r, { b: UP, p: NONE }, 3, () => { min = Math.min(min, clear(r, b, p)); });
    expect(ids(r)).toEqual(['p', 'b']);
    expect(contacts(ev)).toEqual([]);
    expect(min).toBeGreaterThan(0);
    expect(clear(r, b, p)).toBeLessThan(1);
  });

  it('backing out past the squeeze entry, it is queued only by crossing the entry again, behind the cars inside', () => {
    const r = race(['p', 'b']);
    const [p, b] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, p, E + 1, 1); place(r, b, E + 6, -1);
    r.squeezeQ.length = 0; r.squeezeQ.push(b, p);
    run(r, { p: BRAKE }, REV.engage + 0.1, () => p.revOn);
    run(r, { p: BRAKE }, 3, () => r.T.gapS(r.T.SQ_ENTRY, r.s(p)) < -1.5);
    run(r, { p: NONE }, 1, () => p.v === 0);
    expect(ids(r)).toEqual(['b']);
    run(r, { p: UP }, 0.3);
    expect(r.T.inRange(r.s(p), E, r.T.SQ_EXIT)).toBe(false);
    expect(ids(r)).toEqual(['b']);
    run(r, { p: UP }, 1, () => r.squeezeQ.includes(p));
    expect(ids(r)).toEqual(['b', 'p']);
  });
});

describe('cars that never leave the queue (#100)', () => {
  it('an all-AI race: the queue is always every car between entry and exit in physical order, and no rejoin ever moves anyone', () => {
    const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed: 9, track: 'circuit-1' });
    const rejoin = r.rejoinSqueeze.bind(r);
    let moved = 0;
    r.rejoinSqueeze = (c: Car) => { const before = ids(r).join(); rejoin(c); if (ids(r).join() !== before) moved++; };
    let checked = 0;
    for (let i = 0; i < 60 * 60 && r.phase !== 'done'; i++) {
      r.update(DT, {});
      if (r.phase !== 'racing' || r.cars.some((c) => c.mode !== 'race' && c.mode !== 'pitlane')) continue;
      const inside = r.cars.filter((c) => c.mode === 'race' && r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT) && c.crossed > 0);
      if (inside.length < 2) continue;
      expect(ids(r).slice().sort()).toEqual(inside.map((c) => c.id).sort());
      expect(ids(r)).toEqual(physical(r, inside));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(moved).toBe(0);
  });

  it('a car that is already queued is never moved by a rejoin, and a queue with nobody leaving is unchanged', () => {
    const r = race(['a', 'b', 'c']);
    const [a, b, c] = r.cars;
    const E = r.T.SQ_ENTRY;
    place(r, a, E + 20, 1); place(r, b, E + 12, -1); place(r, c, E + 4, 1);
    r.squeezeQ.length = 0; r.squeezeQ.push(a, b, c);
    for (const x of [a, b, c]) r.rejoinSqueeze(x);
    expect(ids(r)).toEqual(['a', 'b', 'c']);
    // c reached the squeeze first in a queue that predates the rule: a rejoin of a queued car never re-sorts it
    r.squeezeQ.length = 0; r.squeezeQ.push(c, a, b);
    r.rejoinSqueeze(a);
    expect(ids(r)).toEqual(['c', 'a', 'b']);
  });
});

describe('a reverse blocked at once by the car behind (#100 review)', () => {
  it('rejoins the queue when the driver lets go of Brake and drives on, though it never moved back', () => {
    const r = race(['p', 'b']); const [p, b] = r.cars; const E = r.T.SQ_ENTRY;
    place(r, p, E + 14, 1); place(r, b, E + 14 - r.T.CAR_LEN, 1);
    r.squeezeQ.length = 0; r.squeezeQ.push(p, b);
    run(r, { p: BRAKE }, REV.engage + 0.1, () => p.revOn); expect(p.revOn).toBe(true);
    run(r, { p: BRAKE }, 0.5); expect(ids(r)).toEqual(['b']);
    run(r, { p: UP }, 0.5); expect(r.T.inRange(r.s(p), E, r.T.SQ_EXIT)).toBe(true);
    expect(ids(r)).toEqual(['p', 'b']);
  });
});

/** Cars on the racing lane inside the squeeze that have started the race, the ones the queue must hold. */
/** Cars on the racing lane inside the squeeze that have started the race and are not waiting to join after a pit exit. */
const insideZone = (r: Race): Car[] =>
  r.cars.filter((c) => c.mode === 'race' && r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT) && c.crossed > 0 && !c.sqWait);
/** The invariant: the queue is in physical order, furthest into the squeeze first. */
const inOrder = (r: Race): boolean => {
  const q = r.squeezeQ, pr = (c: Car) => r.T.gapS(r.T.SQ_ENTRY, r.s(c));
  for (let k = 1; k < q.length; k++) if (pr(q[k]) > pr(q[k - 1])) return false;
  return true;
};
/** Put back the rule before #110 on this race: a car leaving the pit lane inside the squeeze is never queued. */
const legacy = (r: Race): void => { r.joinSqueezeWaiting = () => { for (const c of r.cars) c.sqWait = false; }; };

describe('a pit exit inside the squeeze, circuit-4 (#110)', () => {
  it('only circuit-4 has any part of the pit lane inside a squeeze, and there only the end of the exit merge', () => {
    for (const d of TRACKS) {
      const r = race(['a'], d.id);
      const { SQ_ENTRY: E, SQ_EXIT: X, PIT_IN0, PIT_OUT1 } = r.T;
      // the pit lane (entry, box, bays, exit merge) runs from PIT_IN0 to PIT_OUT1 on every circuit; no zone wraps s = 0
      expect(E).toBeLessThan(X);
      const overlap = Math.max(0, Math.min(X, PIT_OUT1) - Math.max(E, PIT_IN0));
      if (d.id === 'circuit-4') {
        expect(E).toBeGreaterThan(r.T.PIT_OUT0);
        expect(E).toBeLessThan(PIT_OUT1);
        expect(Math.max(...r.T.BAYS)).toBeLessThan(E);
      } else expect(overlap).toBe(0);
    }
  });

  /**
   * a stands queued well into the squeeze; b is queued on the inside lane, standing. p leaves the pit lane at full pit speed,
   * so it reaches the road with b either just behind it (`bAt` 0.2 m into the squeeze) or ahead of it (`bAt` 4 m in, far enough
   * for p to stop behind it; closer, p would pass it on its own lane first, as on main).
   * Nobody behind it is closing on it, so it joins the queue on the next step.
   */
  function exitPast(bAt: number) {
    const r = race(['a', 'p', 'b'], 'circuit-4');
    const [a, p, b] = r.cars;
    const E = r.T.SQ_ENTRY;
    expect(r.T.PIT_OUT1).toBeGreaterThan(E);
    place(r, a, E + 9, -1); place(r, b, E + bAt, 1); placePit(r, p, 29, r.T.PIT_SPEED);
    r.squeezeQ.length = 0; r.squeezeQ.push(a, b);
    run(r, { p: UP }, 1, () => p.mode === 'race');
    expect(p.mode).toBe('race');
    if (p.sqWait) run(r, { p: UP }, DT);   // (a frame is two steps: it may have joined within the frame already)
    expect(p.sqWait).toBe(false);
    expect(r.squeezeQ.includes(p)).toBe(true);
    expect(r.T.inRange(r.s(p), E, r.T.SQ_EXIT)).toBe(true);
    return { r, a, p, b };
  }

  it('the car leaving the pits is queued at its physical place: ahead of a queued car it is in front of', () => {
    const { r, a, p, b } = exitPast(0.2);
    expect(r.T.gapS(r.s(b), r.s(p))).toBeGreaterThan(0);
    expect(ids(r)).toEqual(['a', 'p', 'b']);
    expect(ids(r)).toEqual(physical(r, [a, p, b]));
  });

  it('and behind a queued car that is in front of it', () => {
    const { r, a, p, b } = exitPast(4);
    expect(r.T.gapS(r.s(p), r.s(b))).toBeGreaterThan(0);
    expect(ids(r)).toEqual(['a', 'b', 'p']);
    expect(ids(r)).toEqual(physical(r, [a, p, b]));
  });

  for (const [bAt, order] of [[0.2, 'apb'], [4, 'abp']] as const) {
    it(`it is held by the car ahead and holds the car behind into standing traffic: nobody touches (${order})`, () => {
      const { r, a, p, b } = exitPast(bAt);
      const [, mid, last] = order.split('').map((id) => r.car(id)!);
      let minMid = Infinity, minLast = Infinity, midHeld = false, lastHeld = false;
      // a stands; the other two drive at it flat out, then it drives on and they follow it through the narrow section
      const ev = run(r, () => ({ a: r.raceTime > 9 ? UP : NONE, p: UP, b: UP }), 6, () => {
        // gaps along the slot, once the lanes have closed up to single file (at the exit the two are still side by side)
        if (r.T.inRange(r.s(last), r.T.SQ_Q1, r.T.SQ_EXIT)) {
          minMid = Math.min(minMid, r.T.gapS(r.s(mid), r.s(a))); minLast = Math.min(minLast, r.T.gapS(r.s(last), r.s(mid)));
        }
        midHeld ||= mid.squeezeHold; lastHeld ||= last.squeezeHold;
        return !r.T.inRange(r.s(last), r.T.SQ_ENTRY, r.T.SQ_EXIT);
      });
      expect(contacts(ev)).toEqual([]);
      expect(midHeld).toBe(true);
      expect(lastHeld).toBe(true);
      expect(minMid).toBeGreaterThan(0.5);
      expect(minLast).toBeGreaterThan(0.5);
      // all three came out of the squeeze in queue order, nobody left in the queue
      expect(ids(r)).toEqual([]);
      expect(r.T.gapS(r.s(mid), r.s(a))).toBeGreaterThan(r.T.CAR_LEN);
      expect(r.T.gapS(r.s(last), r.s(mid))).toBeGreaterThan(r.T.CAR_LEN);
    });
  }

  /**
   * #118 reviews. p leaves the pits at s=25 doing 8 m/s while b comes up on the inside lane, c `gap` m behind b; all hold
   * Throttle, except that b may lift (`act` 'lift': no pedals) or hold Brake for 1 s from `T` steps after p's exit.
   * Round 1: queued behind p purely by place, a fast b could not stop behind it, overran it, and collide() (queue order)
   * shoved b back into c, which took a rear-end offence. Round 2: putting b ahead of p in the queue and handing the place
   * back later left the queue out of physical order (b p c with p > b > c), so c was capped by p, not by b, and ran into b.
   * Now p waits outside the queue, as on main, while any car behind it cannot stop behind it, then joins at its place.
   */
  function closing(sb: number, vb: number, gap: number, act: 'up' | 'lift' | 'brake' = 'up', T = 0, old = false) {
    const r = race(['p', 'b', 'c'], 'circuit-4');
    if (old) legacy(r);
    const [p, b, c] = r.cars;
    placePit(r, p, 25, r.T.PIT_SPEED);
    place(r, b, sb, 1); b.v = vb; place(r, c, sb - gap, 1); c.v = vb;
    p.throttle = b.throttle = c.throttle = 1;   // already on Throttle, as in the reviews' scripts
    r.squeezeQ.length = 0;
    let order = '', exitStep = -1, step = 0, disorder = 0, waitSteps = 0, skipOff = 0;
    const zoneEv: WireEvent[] = [];
    const ev = run(r, () => {
      const bIn = act !== 'up' && exitStep >= 0 && step >= exitStep + T && step < exitStep + T + 60 ? (act === 'brake' ? BRAKE : NONE) : UP;
      return { p: UP, b: bIn, c: UP };
    }, 6, (evs) => {
      step++;
      if (exitStep < 0 && p.mode === 'race') exitStep = step;
      if (p.sqWait) waitSteps++;
      if (!inOrder(r)) disorder++;
      if (!order && r.squeezeQ.includes(p) && r.squeezeQ.includes(b)) order = ids(r).filter((id) => id !== 'c').join('');
      // incidents in the squeeze (b's lift can cause one further on, after the squeeze, the same with or without this rule)
      for (const e of evs) if ('car' in e && r.T.inRange(r.s(r.car(e.car as string)!), r.T.SQ_ENTRY - 2, r.T.SQ_EXIT)) zoneEv.push(e);
      // round 2's mechanism: an offence by a queued car on a queued car that is queued behind it (its cap skipped that car)
      for (const e of evs) if (e.type === 'offence') {
        const q = r.squeezeQ, i = q.findIndex((x) => x.id === e.car), j = q.findIndex((x) => x.id === e.other);
        if (i >= 0 && j > i) skipOff++;
      }
    });
    const through = [p, b, c].every((x) => x.mode === 'race' && r.T.gapS(r.T.SQ_EXIT, r.s(x)) > 0);
    const offC = zoneEv.filter((e) => e.type === 'offence' && e.car === 'c').length;
    return { r, p, b, c, ev: zoneEv, order, through, disorder, waitSteps, offC, skipOff };
  }

  it('round 1 repro: a faster inside-lane car that cannot stop behind the exiting car goes by first: no offence, no new contact', () => {
    const { p, b, c, ev, order, through, disorder, waitSteps } = closing(17.5, 14, 5);
    const main = closing(17.5, 14, 5, 'up', 0, true);
    expect(waitSteps).toBeGreaterThan(0);       // p waited outside the queue while b and c closed on it
    expect(order).toBe('bp');                   // and joined behind them once they had gone by
    expect(p.offences + b.offences + c.offences).toBe(0);
    // c touches p as it goes by, exactly as on main (p's pit-exit grace waives it): no other contact
    expect(contacts(ev)).toEqual(contacts(main.ev));
    expect(contacts(ev).every((e) => e.type === 'bump' && e.car === 'c' && e.other === 'p')).toBe(true);
    expect(disorder).toBe(0);
    expect(through).toBe(true);
  });

  it('round 1 sweep: inside-lane car start and speed against the exit, followers 3 to 12 m behind: no offence, nobody stuck', () => {
    let runs = 0, ahead = 0, behind = 0;
    for (const gap of [3, 5, 8, 12]) for (const vb of [6, 10, 14]) for (let sb = 10; sb <= 30; sb += 1) {
      const { ev, order, through, disorder } = closing(sb, vb, gap);
      const tag = `gap ${gap} vb ${vb} sb ${sb}`;
      expect(ev.filter((e) => e.type === 'offence'), tag).toEqual([]);
      expect(through, tag).toBe(true);
      expect(disorder, tag).toBe(0);
      runs++; if (order === 'bp') ahead++; else if (order === 'pb') behind++;
    }
    expect(runs).toBe(252);
    // both outcomes occur: the slow or distant car stays behind the exiting car, the fast close one goes first
    expect(ahead).toBeGreaterThan(0);
    expect(behind).toBeGreaterThan(0);
  });

  it('round 2 repro: b lifts 3 steps after the exit with c 5 m behind it: no offence, no contact, the queue in physical order', () => {
    const { p, b, c, ev, through, disorder } = closing(13, 8, 5, 'lift', 3);
    const main = closing(13, 8, 5, 'lift', 3, true);
    expect(p.offences + b.offences + c.offences).toBe(0);
    expect(contacts(ev)).toEqual([]);
    expect(contacts(main.ev)).toEqual([]);
    expect(disorder).toBe(0);
    expect(through).toBe(true);
  });

  it('round 2 sweep: b lifts or brakes 0 to 30 steps after the exit, c 3 to 8 m behind: no cap ever skips a car, lifting changes nothing', () => {
    const tot = { runs: 0, offNow: 0, offMain: 0, worse: 0, better: 0, bumpNow: 0, bumpMain: 0, disorder: 0, skipOff: 0 };
    const lift = { offNow: 0, offMain: 0, worse: 0 };
    for (const act of ['lift', 'brake'] as const) for (const T of [0, 3, 10, 30]) for (const gap of [3, 5, 8]) for (const vb of [8, 12, 16]) for (let sb = 10; sb <= 30; sb += 2) {
      const now = closing(sb, vb, gap, act, T), main = closing(sb, vb, gap, act, T, true);
      const tag = `${act} T ${T} gap ${gap} vb ${vb} sb ${sb}`;
      expect(now.through, tag).toBe(true);
      expect(now.skipOff, tag).toBe(0);
      tot.runs++; tot.offNow += now.offC; tot.offMain += main.offC; tot.skipOff += now.skipOff;
      if (now.offC > main.offC) {
        tot.worse++;
        // braking hard in front of c: on main the exiting car, outside the queue, ran into b or c and shoved it on (its
        // contact grace waives that), which spared c here. Now it is queued and held, so c meets b's braking unaided
        expect(act, tag).toBe('brake');
        expect(main.ev.some((e) => e.type === 'bump' && e.car === 'p'), tag).toBe(true);
      } if (now.offC < main.offC) tot.better++;
      if (now.disorder) tot.disorder++;
      tot.bumpNow += now.ev.filter((e) => e.type === 'bump').length; tot.bumpMain += main.ev.filter((e) => e.type === 'bump').length;
      if (act === 'lift') { lift.offNow += now.offC; lift.offMain += main.offC; if (now.offC > main.offC) lift.worse++; }
    }
    // lifting: exactly main's offences on c. Braking hard (a brake test of c): offences on c 319 against 303 on main, all in
    // runs where main's exiting car shoved a car on; contacts in the squeeze 768 against 981
    expect(tot.runs).toBe(792);
    expect(lift.worse).toBe(0);
    expect(lift.offNow).toBe(lift.offMain);
    expect(tot.skipOff).toBe(0);
    expect(tot.worse).toBeLessThanOrEqual(18);
    expect(tot.bumpNow).toBeLessThan(tot.bumpMain);
    // out of physical order only after a collision has moved cars in a brake test (3 runs), never by a join
    expect(tot.disorder).toBeLessThanOrEqual(3);
  });

  it('no deadlock with the pit-exit merge: a queued car standing in the merge waits only for the queue, the pit cars only for it', () => {
    const r = race(['x', 'a', 'p', 'q'], 'circuit-4');
    const [x, a, p, q] = r.cars;
    const E = r.T.SQ_ENTRY;
    // x stands at the head of the queue; a stands behind it in the outside lane inside the merge zone past PIT_OUT1, so the
    // exit is blocked (mergeBlocked) while a waits for x. p and q arrive in the pit lane
    place(r, x, E + 6.4, -1); place(r, a, E + 3.4, -1);
    placePit(r, p, 22, r.T.PIT_SPEED); placePit(r, q, 19, r.T.PIT_SPEED);
    r.squeezeQ.length = 0; r.squeezeQ.push(x, a);
    let pWaited = false, qWaited = false, bad = 0;
    const out: string[] = [];
    const ev = run(r, () => ({ x: r.raceTime > 8 ? UP : NONE, a: UP, p: UP, q: UP }), 12, () => {
      pWaited ||= p.exitHold; qWaited ||= q.exitHold;
      // the queue is always exactly the cars inside the squeeze, in physical order, and never holds a pit-lane car
      const inside = insideZone(r);
      if (ids(r).join() !== physical(r, inside).join()) bad++;
      for (const c of [x, a, p, q]) if (!out.includes(c.id) && r.T.gapS(r.T.SQ_EXIT, r.s(c)) > 0 && c.mode === 'race') out.push(c.id);
      return out.length === 4;
    });
    expect(pWaited).toBe(true);
    expect(qWaited).toBe(true);
    expect(bad).toBe(0);
    expect(contacts(ev)).toEqual([]);
    // everyone got through once the head of the queue moved, the pit cars behind the cars that held them
    expect(out).toEqual(['x', 'a', 'p', 'q']);
  });

  it('all-AI races to the flag: every pit exit joins the queue in physical order, nothing is out of order beyond main, no race stalls', () => {
    // 9: the race the #110 tests started with. 6, 14, 21, 24, 26, 82 and 89 stalled under earlier versions of this rule
    // (a car queued ahead of the exiting car and following it on the slot). 323: round 2's out-of-order queue (a>b offence)
    let exits = 0, joined = 0, checked = 0, joinBad = 0, badNow = 0, badMain = 0;
    const outOfOrder = (r: Race, only?: Set<Car>): boolean => {
      const q = r.squeezeQ, pr = (c: Car) => r.T.gapS(r.T.SQ_ENTRY, r.s(c));
      for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) {
        if (only && !only.has(q[i]) && !only.has(q[j])) continue;
        if (pr(q[j]) > pr(q[i])) return true;
      }
      return false;
    };
    for (const seed of [9, 6, 14, 21, 24, 26, 82, 89, 323]) for (const old of [false, true]) {
      const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed, track: 'circuit-4' });
      if (old) legacy(r);
      const was = new Map<Car, string>(), out = new Set<Car>(), fresh = new Set<Car>();
      for (let n = 0; r.phase !== 'done' && n < 60 * 300; n++) {
        r.update(DT, {});
        for (const c of r.cars) {
          if (was.get(c) === 'pitlane' && c.mode === 'race') { exits++; out.add(c); }
          if (out.has(c) && r.squeezeQ.includes(c)) { joined++; out.delete(c); fresh.add(c); }
          // (an exiting car that left the squeeze unqueued would stay in `out`)
          if (out.has(c) && !c.sqWait && c.mode === 'race' && !r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT)) out.delete(c);
          if (!r.squeezeQ.includes(c)) fresh.delete(c);
          was.set(c, c.mode);
        }
        if (r.phase !== 'racing') continue;
        if (old) { if (outOfOrder(r)) badMain++; continue; }
        if (outOfOrder(r)) badNow++;
        // a car that joined from the pit exit is never out of order with any queued car
        if (outOfOrder(r, fresh)) joinBad++;
        checked++;
      }
      expect(r.phase, `seed ${seed}`).toBe('done');
      expect(r.raceTime, `seed ${seed}`).toBeLessThan(205);
    }
    // (exits counted in both runs of each seed; on main none joins)
    expect(exits).toBeGreaterThan(40);
    expect(joined).toBe(exits / 2);
    expect(checked).toBeGreaterThan(50000);
    expect(joinBad).toBe(0);
    // the rest is main's: two road cars crossing the entry side by side on different lanes, the one a few cm behind first
    // (8 steps, seeds 82 and 323, the same with and without this rule)
    expect(badNow).toBe(badMain);
  });

  /** One all-AI race to the flag on a circuit, digested (every event and a snapshot every 0.5 s), now or with the old rule. */
  function aiDigest(track: string, seed: number, old: boolean): string {
    const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed, track });
    if (old) legacy(r);
    const h = createHash('sha256');
    for (let n = 0; r.phase !== 'done' && n < 60 * 600; n++) {
      r.update(DT, {});
      h.update(JSON.stringify(r.drainEvents()));
      if (n % 30 === 0) h.update(JSON.stringify(r.snapshot()));
    }
    expect(r.phase).toBe('done');
    return h.digest('hex');
  }

  it('an all-AI race digest is unchanged on every circuit but circuit-4, where the pit exit is inside the squeeze', () => {
    // on circuit-4 most seeds are unchanged too (19 of seeds 1 to 20): a car leaving the pits is usually last in the squeeze,
    // or far from the cars around it, so its place in the queue caps nobody. Seed 11 differs
    for (const d of TRACKS) for (const seed of [7, 11]) {
      const now = aiDigest(d.id, seed, false), before = aiDigest(d.id, seed, true);
      if (d.id === 'circuit-4' && seed === 11) expect(now, `${d.id} seed ${seed}`).not.toBe(before);
      else expect(now, `${d.id} seed ${seed}`).toBe(before);
    }
  });
});
