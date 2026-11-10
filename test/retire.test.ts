// A retired car (its driver left the race or did not come back within the reconnect grace) must not keep circulating as an
// unmanned obstacle (#44): it coasts to a stop, then leaves the racing line for its own bay and takes no part in collisions,
// while its classification stays DNF `retired`. See docs/online-server.md (Disconnects, grace and retirement).
import { describe, it, expect } from 'vitest';
import { Race, Car, RosterEntry, WireEvent } from '../src/race';

const DT = 1 / 60;
const LAP = 3;
/** a long straight on circuit-1 (curvature 0 from s 146 to 182), clear of the pit entrance and the squeeze */
const STRAIGHT = 150;

function room(roster: RosterEntry[]): Race {
  const r = new Race({ roster, seed: 11, track: 'circuit-1' });
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; c.pitPlan = false; }
  return r;
}
function place(r: Race, c: Car, u: number, side: number, v: number): void {
  c.u = u; c.hiU = u; c.laneSide = side; c.d = side * r.T.LANE_HALF; c.v = v; c.change = null; c.mode = 'race'; c.throttle = 0; c.revMark = null;
}
const involves = (e: WireEvent, id: string): boolean => ('car' in e && e.car === id) || ('other' in e && e.other === id);

describe('retired car leaves the track (#44)', () => {
  it('retired mid-lap: coasts to v = 0, parks in its bay, a following car drives through the spot with no contact, still DNF retired', () => {
    const r = room([{ id: 'a', control: 'human' }, { id: 'b', control: 'human' }, { id: 'f', control: 'ai' }, { id: 'x', control: 'ai' }]);
    const a = r.car('a')!, b = r.car('b')!, f = r.car('f')!, x = r.car('x')!;
    const base = LAP * r.T.L + STRAIGHT;
    place(r, a, base, 1, 20);
    place(r, f, base - 12, 1, 18);         // close behind in the same lane
    place(r, b, base + 120, -1, 15);       // the other human and AI well away
    place(r, x, base + 60, -1, 15);
    r.drainEvents();
    expect(r.retire('a')).toBe(true);
    expect(r.drainEvents()).toEqual([{ type: 'dnf', car: 'a', reason: 'retired' }]);
    const events: WireEvent[] = [];
    let stopU = -1, stoppedAt = -1, everContact = false;
    for (let i = 0; i < 600; i++) {   // 10 s
      r.update(DT, { b: { up: true, down: false } });
      events.push(...r.drainEvents());
      if (stoppedAt < 0 && a.v === 0) { stoppedAt = (i + 1) * DT; stopU = a.u; }
      if (r.touching.some((t, k) => t && (Math.floor(k / 4) === a.idx || k % 4 === a.idx))) everContact = true;
    }
    // coasts to a stop within a few seconds, then parked off the racing line for the rest of the race
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(4);
    expect(a.v).toBe(0);
    expect(a).toMatchObject({ mode: 'off', retire: 'parked', throttle: 0 });
    expect(r.squeezeQ).not.toContain(a);
    expect(r.pit.held(a)).toEqual([]);
    // drawn in its own bay, not on the slot where it stopped
    const bay = r.T.point3(r.T.BAYS[a.bayHome], r.T.BAY_D);
    expect(a.x).toBeCloseTo(bay.x, 6); expect(a.y).toBeCloseTo(bay.y, 6);
    // the car behind went past the place it stopped; nothing ever touched it, no bump, offence or anything else names it
    expect(f.u).toBeGreaterThan(stopU + 20);
    expect(everContact).toBe(false);
    expect(events.filter((e) => e.type !== 'msg' && involves(e, 'a'))).toEqual([]);
    // the snapshot shows it stationary, classification unchanged
    const snap = r.snapshot().cars.find((c) => c.id === 'a')!;
    expect(snap).toMatchObject({ v: 0, mode: 'off', status: 'dnf', dnfReason: 'retired', throttle: 0 });
    expect(snap.off).toMatchObject({ vx: 0, vy: 0, vz: 0, spin: 0 });
    expect(a).toMatchObject({ status: 'dnf', dnfReason: 'retired', finished: true });
  });

  it('a car close behind that runs into a retired car while it is still rolling is never given an offence for it', () => {
    const r = room([{ id: 'a', control: 'human' }, { id: 'h', control: 'human' }]);
    const a = r.car('a')!, h = r.car('h')!;
    const base = LAP * r.T.L + STRAIGHT;
    place(r, a, base, 1, 12);
    place(r, h, base - r.T.CAR_LEN - 0.6, 1, 20);
    r.drainEvents();
    r.retire('a');
    const events: WireEvent[] = [];
    for (let i = 0; i < 120; i++) { r.update(DT, { h: { up: true, down: false } }); events.push(...r.drainEvents()); }
    expect(events.some((e) => e.type === 'bump')).toBe(true);   // the contact itself is real while it is on the slot
    expect(events.filter((e) => e.type === 'offence')).toEqual([]);
    expect(h.offences).toBe(0);
  });

  it('retired while de-slotted: never marshalled back onto the slot, parked once it has landed', () => {
    const r = room([{ id: 'a', control: 'human' }, { id: 'b', control: 'human' }]);
    const a = r.car('a')!;
    place(r, a, LAP * r.T.L + STRAIGHT, 1, 18);
    place(r, r.car('b')!, LAP * r.T.L + STRAIGHT + 100, -1, 15);
    r.deslot(a);
    r.update(DT, {});
    r.retire('a');
    const modes = new Set<string>();
    for (let i = 0; i < 600; i++) { r.update(DT, {}); modes.add(a.mode); }
    expect([...modes]).toEqual(['off']);
    expect(a).toMatchObject({ retire: 'parked', v: 0, status: 'dnf', dnfReason: 'retired' });
    expect(a.off).toMatchObject({ vx: 0, vy: 0, vz: 0 });
  });

  it('retired in the pits: in its bay it parks at once; rolling down the pit lane it stops, parks and holds up no one', () => {
    const r = room([{ id: 'a', control: 'human' }, { id: 'p', control: 'human' }, { id: 'q', control: 'ai' }]);
    const a = r.car('a')!, p = r.car('p')!, q = r.car('q')!;
    // a: standing in its bay refuelling
    a.u = LAP * r.T.L + r.T.BAYS[a.bayHome]; a.d = r.T.PIT_D; a.v = 0; a.laneSide = -1;
    r.enterBay(a, a.bayHome);
    // p: rolling down the pit lane at the limit, q right behind it
    place(r, p, LAP * r.T.L + r.T.PIT_IN1 + 1, -1, r.T.PIT_SPEED); p.mode = 'pitlane'; p.d = r.T.pitD(r.s(p));
    place(r, q, LAP * r.T.L + 100, 1, 15);
    r.update(DT, {});
    r.retire('a'); r.retire('p');
    r.update(DT, {});
    expect(a).toMatchObject({ mode: 'off', retire: 'parked', v: 0 });
    expect(r.pit.held(a)).toEqual([]);
    for (let i = 0; i < 600; i++) r.update(DT, {});
    expect(p).toMatchObject({ mode: 'off', retire: 'parked', v: 0, status: 'dnf' });
    expect(r.pit.held(p)).toEqual([]);
    expect(r.pit.bays.every((i) => i !== a.idx && i !== p.idx)).toBe(true);
    expect(q.u).toBeGreaterThan(LAP * r.T.L + 200);   // the AI kept racing
  });

  it('retired on the grid during the countdown: parked before the start and left there at the green', () => {
    const r = new Race({ roster: [{ id: 'a', control: 'human' }, { id: 'b', control: 'human' }, { id: 'c', control: 'ai' }], seed: 4, track: 'circuit-1' });
    r.update(DT, {});
    expect(r.phase).toBe('countdown');
    expect(r.retire('a')).toBe(true);
    for (let i = 0; i < 60 * 12; i++) r.update(DT, { b: { up: true, down: false } });
    expect(r.phase).toBe('racing');
    const a = r.car('a')!;
    expect(a).toMatchObject({ mode: 'off', retire: 'parked', v: 0, status: 'dnf', dnfReason: 'retired', crossed: 0 });
    expect(r.car('c')!.u).toBeGreaterThan(r.T.FINISH_S + 50);
  });

  it('retired, then the race ends: parked all through the run-on, classified DNF retired; replays of the same race are identical', () => {
    const run = (): Race => {
      const r = new Race({ roster: [{ id: 'a', control: 'human' }, { id: 'b', control: 'human' }, { id: 'c', control: 'ai' }], seed: 9, track: 'circuit-1' });
      for (let i = 0; i < 60 * 12; i++) r.update(DT, {});
      r.retire('a');
      for (let i = 0; i < 60 * 5; i++) r.update(DT, {});
      r.retire('b');
      for (let i = 0; i < 60 * 6 && r.phase !== 'done'; i++) r.update(DT, {});
      return r;
    };
    const r = run();
    expect(r.phase).toBe('done');
    for (const id of ['a', 'b']) expect(r.car(id)).toMatchObject({ mode: 'off', retire: 'parked', v: 0, status: 'dnf', dnfReason: 'retired' });
    expect(r.final!.filter((s) => s.status === 'dnf').map((s) => [s.id, s.dnfReason, s.pos])).toEqual(
      expect.arrayContaining([['a', 'retired', null], ['b', 'retired', null]]));
    expect(JSON.stringify(run().snapshot())).toBe(JSON.stringify(r.snapshot()));
  });
});
