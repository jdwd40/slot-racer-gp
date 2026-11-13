// The squeeze priority queue after a car has left it inside the squeeze (#100): a marshal re-slot and a car driving forward
// again after backing up put the car back in the queue at its physical place, so it waits for the cars ahead and holds the
// cars behind again. The away rejoin (#74) is tested in test/stall.test.ts. See docs/reverse.md and docs/online-server.md.
import { describe, it, expect } from 'vitest';
import { Race, Car, REV, type Controls, type Input, type RosterEntry, type WireEvent } from '../src/race';

const DT = 1 / 60;
const LAP = 3;
const NONE: Input = { up: false, down: false };
const UP: Input = { up: true, down: false };
const BRAKE: Input = { up: false, down: true };

/** A race under way on circuit-1 (squeeze from SQ_ENTRY 35.8 to SQ_EXIT 65.1, clear of the pit lane), every car human. */
function race(ids: string[]): Race {
  const roster: RosterEntry[] = ids.map((id, slot) => ({ id, control: 'human', slot }));
  const r = new Race({ roster, seed: 5, track: 'circuit-1' });
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
