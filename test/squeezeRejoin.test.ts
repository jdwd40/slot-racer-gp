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
const insideZone = (r: Race): Car[] =>
  r.cars.filter((c) => c.mode === 'race' && r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT) && c.crossed > 0);

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
   * a stands queued well into the squeeze; b is queued on the inside lane. p leaves the pit lane at full pit speed, so it
   * reaches the road with b either just behind it (`bAt` 0.2 m into the squeeze) or just ahead of it (`bAt` 2 m in).
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
    const { r, a, p, b } = exitPast(2);
    expect(r.T.gapS(r.s(p), r.s(b))).toBeGreaterThan(0);
    expect(ids(r)).toEqual(['a', 'b', 'p']);
    expect(ids(r)).toEqual(physical(r, [a, p, b]));
  });

  for (const [bAt, order] of [[0.2, 'apb'], [2, 'abp']] as const) {
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
   * #118 review: p leaves the pits while b closes on the inside lane at racing speed, c following b; everyone holds
   * Throttle. Queued behind p purely by place, b could not stop behind it before the lanes close, overran it, and queue
   * order in collide() shoved b back into c, which took a rear-end offence. A road car that cannot stop behind the exiting
   * car goes ahead of it instead.
   */
  function closing(sb: number, vb: number, gap: number) {
    const r = race(['p', 'b', 'c'], 'circuit-4');
    const [p, b, c] = r.cars;
    placePit(r, p, 25, r.T.PIT_SPEED);
    place(r, b, sb, 1); b.v = vb; place(r, c, sb - gap, 1); c.v = vb;
    r.squeezeQ.length = 0;
    let order = '';
    const ev = run(r, { p: UP, b: UP, c: UP }, 6, () => {
      if (!order && r.squeezeQ.includes(p) && r.squeezeQ.includes(b)) order = ids(r).filter((id) => id !== 'c').join('');
      return [p, b, c].every((x) => x.mode === 'race' && r.T.gapS(r.T.SQ_EXIT, r.s(x)) > 0 && r.T.gapS(r.T.SQ_EXIT, r.s(x)) < 30);
    });
    const through = [p, b, c].every((x) => x.mode === 'race' && r.T.gapS(r.T.SQ_EXIT, r.s(x)) > 0);
    return { r, p, b, c, ev, order, through };
  }

  it('a faster inside-lane car that cannot stop behind the exiting car goes ahead of it: no offence, no contact (#118 repro)', () => {
    const { b, c, ev, order, through } = closing(17.5, 14, 5);
    expect(order).toBe('bp');
    expect(ev.filter((e) => e.type === 'offence')).toEqual([]);
    expect(contacts(ev)).toEqual([]);
    expect(b.offences + c.offences).toBe(0);
    expect(through).toBe(true);
  });

  it('sweep: inside-lane car start and speed against the exit, followers 3 to 12 m behind: never an offence, nobody stuck', () => {
    let runs = 0, ahead = 0, behind = 0;
    for (const gap of [3, 5, 8, 12]) for (const vb of [6, 10, 14]) for (let sb = 10; sb <= 30; sb += 1) {
      const { ev, order, through } = closing(sb, vb, gap);
      const tag = `gap ${gap} vb ${vb} sb ${sb}`;
      expect(ev.filter((e) => e.type === 'offence'), tag).toEqual([]);
      expect(through, tag).toBe(true);
      runs++; if (order === 'bp') ahead++; else if (order === 'pb') behind++;
    }
    expect(runs).toBe(252);
    // both outcomes occur: the slow or distant car stays behind the exiting car, the fast close one goes first
    expect(ahead).toBeGreaterThan(0);
    expect(behind).toBeGreaterThan(0);
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
    expect(bad).toBe(0);
    expect(contacts(ev)).toEqual([]);
    // everyone got through once the head of the queue moved, the pit cars behind the cars that held them
    expect(out).toEqual(['x', 'a', 'p', 'q']);
    expect(qWaited).toBe(true);
  });

  it('an all-AI race to the flag: every pit exit joins the queue at its physical place, which always holds every car inside', () => {
    const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed: 9, track: 'circuit-4' });
    const was = new Map<Car, string>();
    let exits = 0, checked = 0, bad = 0, n = 0;
    while (r.phase !== 'done' && n++ < 60 * 600) {
      r.update(DT, {});
      for (const c of r.cars) {
        if (was.get(c) === 'pitlane' && c.mode === 'race') { exits++; expect(r.squeezeQ.includes(c)).toBe(true); }
        was.set(c, c.mode);
      }
      if (r.phase !== 'racing') continue;
      const inside = insideZone(r);
      if (ids(r).join() !== physical(r, inside).join()) bad++;
      checked++;
    }
    expect(r.phase).toBe('done');
    expect(exits).toBeGreaterThan(2);
    expect(checked).toBeGreaterThan(5000);
    expect(bad).toBe(0);
  });

  it('all-AI races where a fast car goes ahead of a fresh exit and then slows behind it: the place is given back, no deadlock', () => {
    // without settleExitSqueeze seeds 6, 14, 21, 24 and 26 stall: the exiting car is held for a car queued ahead of it that
    // follows it on the slot, so neither moves until the race times out. Without SQUEEZE.creep, 82 and 89 stall for a minute
    // and more: the follower crawls (0.1 m/s) close behind the stopped exiting car, so it never counts as able to stop.
    // Every one of 400 seeds finishes by 197 s, as on main
    for (const seed of [6, 14, 21, 24, 26, 82, 89]) {
      const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed, track: 'circuit-4' });
      for (let n = 0; r.phase !== 'done' && n < 60 * 300; n++) r.update(DT, {});
      expect(r.phase, `seed ${seed}`).toBe('done');
      expect(r.raceTime, `seed ${seed}`).toBeLessThan(205);
    }
  });

  /**
   * One all-AI race to the flag on a circuit, digested (every event and a snapshot every 0.5 s). `legacy` puts back the rule
   * before #110: a car leaving the pit lane is not queued (and so no car crossing the entry is put ahead of one).
   */
  function aiDigest(track: string, seed: number, legacy: boolean): string {
    const r = new Race({ roster: ['a', 'b', 'c', 'd'].map((id, slot) => ({ id, control: 'ai' as const, slot })), seed, track });
    if (legacy) r.exitSqueeze = () => {};
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
    // on circuit-4 most seeds are unchanged too: a car leaving the pits is usually last in the squeeze, or far behind the car
    // ahead, so its place in the queue caps nobody. With seeds 7 and 11 a faster car reaches the squeeze just behind a car
    // fresh out of the pits; it cannot stop behind it, so it is queued ahead and (seed 7) the exiting car eases off for it
    for (const d of TRACKS) for (const seed of [7, 11]) {
      const now = aiDigest(d.id, seed, false), before = aiDigest(d.id, seed, true);
      if (d.id === 'circuit-4') expect(now, `${d.id} seed ${seed}`).not.toBe(before);
      else expect(now, `${d.id} seed ${seed}`).toBe(before);
    }
  });
});
