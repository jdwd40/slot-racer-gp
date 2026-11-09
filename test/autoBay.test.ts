// Automatic fuel visits to the car's own bay: race-long bay ownership, the outside route and automatic stop at the bay, refuelling,
// the fresh-Throttle departure latch, waiting for a clear merge and exit, combined stop-and-go visits, deadlines and overrides.
// See docs/auto-bay.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { AUTO, Car, DRIVERS, Input, LAPS, PEN, REFUEL_RATE, Race, SERVICE_READY, SgPhase } from '../src/race';
import { DrivingInput } from '../src/input';
import * as R from '../src/records';
import type { RaceEvent } from '../src/race';
import { DT, NONE, UP, fresh, msgs, place, seedRandom, all, me } from './helpers';

beforeEach(() => seedRandom(23));
afterEach(() => vi.restoreAllMocks());

const BRAKE: Input = { up: false, down: true };
const LAP = 3;
const ids = T.TRACKS.map((d) => d.id);

function setup(track = 'circuit-1', n = 1): { r: Race; P: Car; rival: Car } {
  const r = fresh(track);
  const rival = r.cars[r.cars.length - 1];
  r.cars.splice(n);
  r.cars[0].human = true;
  for (const c of r.cars) { c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; }
  return { r, P: r.cars[0], rival };
}
function approach(r: Race, c: Car, before: number, side = -1, v = 15, lap = LAP): void {
  place(c, lap * T.L + T.PIT_IN0 - before, side, v);
  c.crossed = lap; c.lapsDone = lap - 1; c.revMark = null;
  r.squeezeQ.length = 0;
}
function inPit(c: Car, s: number, v = 0, lap = LAP): void {
  place(c, lap * T.L + s, -1, v);
  c.mode = 'pitlane'; c.d = T.pitD(s); c.crossed = s >= T.FINISH_S ? lap + 1 : lap; c.lapsDone = c.crossed - 1;
}
/** A car already standing in bay j, serviced for `t` seconds. */
function inBay(r: Race, c: Car, j: number, t = SERVICE_READY + 0.1): void {
  inPit(c, T.BAYS[j]); r.enterBay(c, j); c.mode = 'service'; c.d = T.BAY_D; c.bayT = 1; c.serviceT = t;
}
/** Throttle only, below the cornering profile, until automatic control has the car; then `held`. */
function driver(held: Input): (r: Race) => Input {
  return (r) => {
    const P = me(r);
    if (P.sgCtl || P.sgLeave) return held;
    const prof = r.profiles['-1'];
    return { up: P.v < prof[Math.floor(r.s(P) / T.PROFILE_STEP) % prof.length] * 0.97, down: false };
  };
}
interface Trace {
  events: RaceEvent[]; msgs: string[]; phases: SgPhase[]; brakeAfterTakeover: boolean;
  vIn: number; maxS: number; overlaps: number; offences: number; maxFuel: number; minV: number; handoverS: number;
}
function overlaps(r: Race): number {
  let n = 0;
  const on = r.cars.filter((c) => c.mode === 'pitlane' || c.mode === 'race' || c.mode === 'bayIn' || c.mode === 'bayOut');
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    const a = on[i], b = on[j];
    if (Math.abs(a.d - b.d) < T.CAR_W && Math.abs(T.gapS(r.s(a), r.s(b))) < T.CAR_LEN - 0.02) n++;
  }
  return n;
}
function run(r: Race, input: Input | ((r: Race) => Input), sec: number, stop?: (r: Race) => boolean, dt = DT): Trace {
  const P = me(r);
  const tr: Trace = { events: [], msgs: [], phases: [], brakeAfterTakeover: false, vIn: -1, maxS: -1e9, overlaps: 0, offences: 0, maxFuel: 0, minV: 0, handoverS: -1 };
  let took = false;
  for (let t = 0; t < sec; t += dt) {
    const inp = typeof input === 'function' ? input(r) : input;
    if (P.sgCtl) took = true;
    if (took && inp.down) tr.brakeAfterTakeover = true;
    const m = P.mode;
    r.update(dt, all(r, inp));
    for (const e of r.events) { tr.events.push(e); if (e.type === 'offence') tr.offences++; }
    tr.msgs.push(...msgs(r.events));
    r.events.length = 0;
    if (P.sgPhase !== tr.phases[tr.phases.length - 1]) tr.phases.push(P.sgPhase);
    if (m === 'race' && P.mode === 'pitlane') tr.vIn = P.v;
    if (m === 'pitlane' && P.mode === 'race') tr.handoverS = r.s(P);
    if (P.mode === 'pitlane' && !P.serviced) tr.maxS = Math.max(tr.maxS, T.gapS(T.BAYS[P.bayHome], r.s(P)));
    tr.maxFuel = Math.max(tr.maxFuel, P.fuel);
    tr.minV = Math.min(tr.minV, P.v);
    tr.overlaps += overlaps(r);
    if (stop?.(r)) break;
  }
  return tr;
}
const inService = (r: Race) => me(r).mode === 'service';
const backOut = (r: Race) => me(r).mode === 'race' && me(r).serviced === false && me(r).pitStops > 0;
/** Release Throttle for a step, then hold it: one fresh press. */
function press(r: Race, sec = 0.1): Trace { run(r, NONE, DT); return run(r, UP, sec); }
const bayGrants = (r: Race) => r.pit.log.filter((e) => e.zone.startsWith('bay') && e.op === 'grant');
function paired(r: Race): void {
  const open = new Map<string, boolean>();
  for (const e of r.pit.log) {
    const k = `${e.car}:${e.zone}`;
    if (e.op === 'grant') { expect(open.get(k), `double grant ${k}`).not.toBe(true); open.set(k, true); }
    else { expect(open.get(k), `release without grant ${k}`).toBe(true); open.set(k, false); }
  }
}

describe('bay ownership', () => {
  it('every car owns its participant slot\'s bay for the whole race, separate from the bay it currently uses', () => {
    T.setTrack('circuit-1');
    const r = new Race();
    expect(r.cars.map((c) => c.bayHome)).toEqual([0, 1, 2, 3]);
    expect(r.cars.map((c) => c.num)).toEqual(DRIVERS.map((d) => d.num));
    for (let j = 0; j < T.BAYS.length; j++) expect(r.bayOwner(j)?.idx).toBe(j);
    // a mutable target never moves ownership
    r.cars[2].bay = 0;
    expect(r.bayOwner(0)?.idx).toBe(0); expect(r.cars[2].bayHome).toBe(2);
    // practice: only the player, so the rivals' bays have no owner
    const p = new Race({ practice: true });
    expect(p.bayOwner(0)?.human).toBe(true);
    expect([1, 2, 3].map((j) => p.bayOwner(j))).toEqual([null, null, null]);
  });

  it('the player\'s bay takes every selectable livery; the rivals keep theirs', () => {
    T.setTrack('circuit-1');
    for (const l of R.LIVERIES) {
      const r = new Race({ playerColor: l.color });
      expect(r.bayOwner(0)!.color).toBe(l.color);
      expect([1, 2, 3].map((j) => r.bayOwner(j)!.color)).toEqual(DRIVERS.slice(1).map((d) => d.color));
    }
  });

  it('a reservation, a tow and an AI stop only ever use the car\'s own bay', () => {
    const { r } = setup('circuit-1', 4);
    const [, A, B] = r.cars;
    approach(r, A, 10); A.pitPlan = true; A.pitReq = true; A.bay = 3;
    approach(r, B, 25); B.pitPlan = true; B.pitReq = true; B.bay = 0;
    r.pit.update();
    expect(r.pit.bays).toEqual([-1, A.idx, B.idx, -1]);
    // a tow from the road, ahead of every bay, still goes to the car's own
    const { r: r2, P } = setup();
    place(P, LAP * T.L + 40, -1, 0); P.fuel = 0;
    run(r2, NONE, 3, inService);
    expect([P.mode, P.bay, P.towSvc]).toEqual(['service', P.bayHome, true]);
  });
});

describe('automatic fuel visit: every circuit, both lanes, no Brake', () => {
  for (const id of ids) for (const side of [-1, 1]) for (const held of [UP, NONE]) {
    it(`${id}, ${side < 0 ? 'outside' : 'inside'} lane, ${held.up ? 'Throttle held' : 'no pedal'}`, () => {
      const { r, P } = setup(id);
      const liv = R.LIVERIES[(ids.indexOf(id) + (side < 0 ? 0 : 2)) % R.LIVERIES.length];
      P.color = liv.color;
      approach(r, P, 120, side, 15);
      P.fuel = 0.35;
      r.requestPit(me(r).id);
      const tr = run(r, driver(held), 40, inService);
      expect(P.mode).toBe('service');
      expect(P.bay).toBe(P.bayHome); expect(r.bayOwner(P.bay)!.color).toBe(liv.color);
      expect(tr.brakeAfterTakeover).toBe(false);
      expect(tr.vIn).toBeGreaterThan(0); expect(tr.vIn).toBeLessThanOrEqual(T.PIT_SPEED + 0.05);
      // never past its bay before turning in, never backwards
      expect(tr.maxS).toBeLessThanOrEqual(AUTO.bayTol);
      expect(tr.minV).toBeGreaterThanOrEqual(0);
      expect(tr.phases.filter(Boolean)).toEqual(['entry', 'bay', 'refuel']);
      expect(P.pitStops).toBe(1);
      expect(bayGrants(r).every((e) => e.zone === `bay${P.bayHome}`)).toBe(true);
      // refuels at the usual rate; a held Throttle never departs, even with a full tank
      const f0 = P.fuel;
      const t2 = run(r, held, 1.5);
      expect(P.fuel - f0).toBeGreaterThan(REFUEL_RATE * 0.9 * 1.0);
      expect(P.fuel - f0).toBeLessThanOrEqual(REFUEL_RATE * 1.5 + 1e-6);
      expect(P.mode).toBe('service'); expect(P.exitReq).toBe(false);
      expect(t2.phases.filter(Boolean)).toContain(held.up ? 'release' : 'ready');
      // one fresh press leaves: refuelling stops there, the car is driven out, and control returns past the pit exit
      const t3 = press(r);
      const fAt = P.fuel;
      expect(P.exitReq || P.mode !== 'service').toBe(true);
      expect(t3.msgs).toContain('msg.departReq');
      const t4 = run(r, NONE, 15, backOut);
      expect(P.mode).toBe('race'); expect(P.sgCtl).toBe(false);
      expect(t4.maxFuel).toBeLessThanOrEqual(fAt + 1e-9);
      expect(t4.phases).toContain('leaving');
      expect(t4.msgs).toContain('msg.sgHandover');
      expect(t4.handoverS).toBeGreaterThan(T.PIT_OUT1 - 0.01); expect(t4.handoverS).toBeLessThan(T.PIT_OUT1 + 0.3);
      expect(P.laneSide).toBe(-1);
      expect(tr.overlaps + t4.overlaps).toBe(0); expect(tr.offences + t4.offences).toBe(0);
      // the visit is over: nothing owed, nothing re-armed for the next lap, every grant released
      expect([P.fuelReq, P.fuelDue, P.pitReq]).toEqual([false, 0, false]);
      paired(r); expect(r.pit.held(P)).toEqual([]);
    });
  }
});

describe('the departure press', () => {
  /** The player turned in at its own bay and standing in service with Throttle `held` since arrival. */
  function arrived(held: Input, fuel = 0.3) {
    const { r, P } = setup();
    inPit(P, T.PIT_IN1, 6); P.pitFuel = true; P.fuel = fuel;
    run(r, held, 6, inService);
    expect(P.mode).toBe('service');
    run(r, held, SERVICE_READY + 0.1);                         // departure is ready
    return { r, P };
  }

  it('a Throttle held on arrival must be released; then one press is accepted once and stays latched', () => {
    const { r, P } = arrived(UP);
    let tr = run(r, UP, 4);
    expect(P.exitReq).toBe(false); expect(P.sgPhase).toBe('release');
    expect(tr.msgs).not.toContain('msg.departReq');
    tr = run(r, NONE, 0.2);
    expect(P.sgPhase).toBe('ready');
    let outs = 0, prev = P.mode;
    const count = (r2: Race) => { if (P.mode === 'bayOut' && prev !== 'bayOut') outs++; prev = P.mode; return me(r2).mode === 'race'; };
    tr = run(r, UP, DT, count);
    expect(P.exitReq || P.mode !== 'service').toBe(true);
    // repeated presses add nothing; the car leaves once
    for (let i = 0; i < 6; i++) { run(r, NONE, 0.05, count); run(r, UP, 0.05, count); }
    run(r, NONE, 8, count);
    expect(outs).toBe(1);
    expect(r.pit.log.filter((e) => e.zone === 'merge0' && e.op === 'grant')).toHaveLength(1);
  });

  it('a press before departure is ready is refused with the reason, and only a fresh press after counts', () => {
    const { r, P } = setup();
    inPit(P, T.PIT_IN1, 6); P.pitFuel = true; P.fuel = 0.3; P.fuelDue = LAP;
    run(r, NONE, 6, () => P.mode === 'bayIn');
    run(r, NONE, 6, inService);
    expect(P.serviceT).toBeLessThan(SERVICE_READY);
    const tr = run(r, UP, SERVICE_READY + 0.3);              // pressed early and held through the ready time
    expect(tr.msgs).toContain('msg.departSettle');
    expect(P.exitReq).toBe(false); expect(P.fuelDue).toBe(0);
    expect(P.sgPhase).toBe('release');
    press(r);
    expect(P.exitReq || P.mode !== 'service').toBe(true);
  });

  it('a tow penalty blocks departure and says so; pressing does not clear it early', () => {
    const { r, P } = setup();
    place(P, LAP * T.L + 40, -1, 0); P.fuel = 0;
    run(r, NONE, 3, inService);
    expect(P.towSvc).toBe(true);
    const pen = P.penalty;
    expect(pen).toBeGreaterThan(1);
    const tr = press(r);
    expect(tr.msgs).toContain('msg.departPenalty');
    expect(P.exitReq).toBe(false); expect(P.sgPhase).toBe('refuel');
    expect(P.penalty).toBeGreaterThan(pen - 0.5);
    run(r, NONE, P.penalty + 0.1);
    expect(P.sgPhase).toBe('ready');
    press(r);
    expect(P.exitReq || P.mode !== 'service').toBe(true);
  });

  it('a full tank never leaves by itself, and the tank never passes full', () => {
    const { r, P } = arrived(NONE, 0.9);
    const tr = run(r, NONE, 8);
    expect(P.mode).toBe('service'); expect(P.fuel).toBe(1); expect(tr.maxFuel).toBeLessThanOrEqual(1);
    expect(P.sgPhase).toBe('ready');
  });

  it('refuelling stops at the request, and the request survives release while it waits for a clear merge', () => {
    const { r, P } = arrived(NONE, 0.2);
    // a committed car in the through lane keeps the merge blocked for a while
    const L = r.cars.length;
    const A = fresh('circuit-1').cars[1];
    r.cars.push(A); A.human = false; A.idx = 1; A.crossed = LAP; A.lapsDone = LAP - 1;
    inPit(A, T.BAYS[0] - 1.2, 0); A.pitFuel = false;
    r.ai = () => ({ t: 0, b: 1 });                             // A stands in the lane behind the bay, in the merge zone
    run(r, NONE, 1);
    press(r, DT);
    const fAt = P.fuel;
    const tr = run(r, NONE, 2);                                // released while it waits
    expect(P.mode).toBe('service'); expect(P.exitReq).toBe(true); expect(P.waitingClear).toBe(true);
    expect(P.sgPhase).toBe('exit'); expect(P.pitWait).toBe('exit');
    expect(tr.maxFuel).toBe(fAt);
    // the lane car moves on: the car leaves without another press
    delete (r as { ai?: unknown }).ai;
    const t2 = run(r, NONE, 10, backOut);
    expect(P.mode).toBe('race'); expect(t2.overlaps).toBe(0); expect(P.fuel).toBeLessThanOrEqual(fAt);
    expect(r.cars.length).toBe(L + 1);
  });

  it('keyboard and touch are one Throttle; a pause clearing held input needs a fresh press after it', () => {
    const { r, P } = arrived(NONE, 0.5);
    const input = new DrivingInput({ lane: () => {}, pit: () => {}, defer: () => {}, view: () => {}, pause: () => {} });
    const step = (sec: number) => run(r, () => ({ up: input.held('throttle'), down: input.held('brake') }), sec);
    // a finger lands while a key is held: neither is a new press on its own
    input.press('key:KeyW', 'throttle');
    step(0.2);
    expect(P.exitReq).toBe(true);
    // a fresh race: the key is held across a pause (cleared), and a finger is needed afterwards
    const b = arrived(UP, 0.5);
    input.clear(); input.press('key:KeyW', 'throttle');
    run(b.r, () => ({ up: input.held('throttle'), down: false }), 0.5);
    expect(b.P.exitReq).toBe(false);                            // held since arrival
    input.clear();                                              // pause/blur: the key is forgotten, the simulation sees a release
    run(b.r, () => ({ up: input.held('throttle'), down: false }), DT);
    input.press('pointer:3', 'throttle');                       // a finger presses afresh
    run(b.r, () => ({ up: input.held('throttle'), down: false }), DT);
    expect(b.P.exitReq || b.P.mode !== 'service').toBe(true);
  });

  it('Brake held through the service, the wait and the automatic exit never arms reverse; a fresh press after the handover does', () => {
    const { r, P } = arrived(BRAKE, 0.5);
    run(r, BRAKE, 1, () => { expect(P.revOn).toBe(false); return false; });
    // the departure press with Brake still held: Throttle is the request, Brake changes nothing
    run(r, BRAKE, DT);
    const tr = run(r, { up: true, down: true }, 0.1);
    expect(P.exitReq || P.mode !== 'service').toBe(true);
    const t2 = run(r, BRAKE, 12, () => { expect(P.revOn).toBe(false); return P.mode === 'race' && P.v === 0; });
    expect(P.mode).toBe('race'); expect(t2.minV).toBeGreaterThanOrEqual(0); expect(tr.minV).toBeGreaterThanOrEqual(0);
    run(r, BRAKE, 1);
    expect(P.revOn).toBe(false);
    run(r, NONE, DT);
    run(r, BRAKE, REV_WAIT);
    expect(P.revOn).toBe(true);
  });
});
const REV_WAIT = 0.8;

describe('conflicts', () => {
  it('the player\'s own bay occupied: it waits short of it, never takes another bay, and turns in once it is free', () => {
    const { r, P } = setup('circuit-1', 2);
    const A = r.cars[1];
    inBay(r, A, P.bayHome); A.fuel = 0.2; A.refuelTarget = 0.6;  // an intruder in the player's bay, leaving in about 2 s
    inPit(P, T.PIT_IN1, 6); P.pitFuel = true; P.fuel = 0.3;
    const waits: number[] = [];   // how far short of its bay the player stands while waiting
    const tr = run(r, UP, 12, (r2) => { if (P.sgPhase === 'bayWait' && P.v === 0) waits.push(T.gapS(r2.s(P), T.BAYS[0])); return inService(r2); });
    expect(tr.phases).toContain('bayWait');
    expect(waits.length).toBeGreaterThan(10);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(AUTO.bayWait - AUTO.stopTol - 0.02);
    expect([P.mode, P.bay]).toEqual(['service', P.bayHome]);
    expect(bayGrants(r).filter((e) => e.car === P.idx).map((e) => e.zone)).toEqual(['bay0']);
    expect(tr.overlaps).toBe(0);
  });

  it('an AI car whose bay is occupied waits for it and never takes another team\'s', () => {
    const { r } = setup('circuit-1', 3);
    const [P, A, B] = r.cars;
    P.human = false; place(P, 100, 1, 0);
    inBay(r, B, A.bayHome); B.fuel = 0.3; B.refuelTarget = 0.6;
    inPit(A, T.PIT_IN1, 6); A.pitPlan = true; A.pitFuel = true; A.fuel = 0.3; A.refuelTarget = 0.5;
    const tr = run(r, NONE, 12, () => A.mode === 'service');
    expect([A.mode, A.bay]).toEqual(['service', A.bayHome]);
    expect(bayGrants(r).filter((e) => e.car === A.idx).every((e) => e.zone === `bay${A.bayHome}`)).toBe(true);
    expect(tr.overlaps).toBe(0);
  });

  it('simultaneous arrivals: the player and two AI cars each reach their own bay in order, without overlap or a wrong bay', () => {
    for (const rev of [false, true]) for (const dt of [DT, 1 / 30, 1 / 144]) {
      const { r } = setup('circuit-1', 4);
      const [P, A, B, D] = r.cars;
      place(D, 200, 1, 0);
      approach(r, B, 4, -1, 8); B.pitPlan = true; B.pitReq = true; B.fuel = 0.3; B.refuelTarget = 0.5;
      approach(r, A, 7, -1, 8); A.pitPlan = true; A.pitReq = true; A.fuel = 0.3; A.refuelTarget = 0.5;
      approach(r, P, 10.5, -1, 8); P.fuel = 0.3; r.requestPit(me(r).id);
      if (rev) r.cars.reverse();
      const tr = run(r, UP, 20, () => [P, A, B].every((c) => c.mode === 'service' || c.serviced), dt);
      for (const c of [P, A, B]) expect(c.pitStops, `car ${c.idx}`).toBe(1);
      expect(P.bay).toBe(P.bayHome);
      for (const e of bayGrants(r)) expect(e.zone).toBe(`bay${e.car}`);
      expect(tr.overlaps).toBe(0); expect(tr.offences).toBe(0);
      paired(r);
    }
  });

  it('adjacent departures at once: the merges never overlap, downstream goes first, both leave and nobody deadlocks', () => {
    const { r } = setup('circuit-1', 2);
    const [P, A] = r.cars;
    inBay(r, P, 0); P.fuel = 0.6;
    inBay(r, A, 1); A.fuel = 0.6; A.refuelTarget = 0.6;          // asks to leave on the next step
    run(r, NONE, DT);
    const tr = run(r, UP, 10, () => P.mode === 'race' && A.mode === 'race');
    const merges = r.pit.log.filter((e) => e.zone.startsWith('merge'));
    expect(merges.map((e) => `${e.car}:${e.zone}:${e.op}`)).toEqual([`${A.idx}:merge1:grant`, `${A.idx}:merge1:release`, `${P.idx}:merge0:grant`, `${P.idx}:merge0:release`]);
    expect([P.mode, A.mode]).toEqual(['race', 'race']);
    expect(tr.overlaps).toBe(0); expect(tr.offences).toBe(0);
    paired(r);
  });

  it('a blocked pit exit: the car leaves its bay, waits at the exit line, then merges and is handed back once clear', () => {
    const { r } = setup('circuit-1', 2);
    const [P, A] = r.cars;
    inBay(r, P, 0); P.fuel = 0.6;
    place(A, LAP * T.L + T.PIT_OUT1 + 1.5, -1, 0); A.crossed = LAP + 1; A.lapsDone = LAP;
    const ai = r.ai.bind(r);
    let hold = true;
    r.ai = (c, t) => (c === A && hold ? { t: 0, b: 1 } : ai(c, t));
    run(r, NONE, DT); press(r, DT);
    const tr = run(r, NONE, 8);
    expect(P.mode).toBe('pitlane'); expect(P.pitWait).toBe('exit'); expect(P.sgPhase).toBe('leaving');
    expect(T.gapS(r.s(P), T.PIT_OUT0)).toBeGreaterThan(0);
    hold = false;
    const t2 = run(r, NONE, 10, (r2) => me(r2).mode === 'race');
    expect(P.mode).toBe('race'); expect(t2.msgs).toContain('msg.sgHandover');
    expect(tr.overlaps + t2.overlaps).toBe(0); expect(tr.offences + t2.offences).toBe(0);
  });
});

describe('combined visits and obligations', () => {
  function award(r: Race, P: Car, rival: Car) { P.offences = 2; r.offence(P, rival, 'rear'); r.events.length = 0; }

  it('stop-and-go first in the box, then on to the bay: refuelling never pays the stop, and each debt clears only itself', () => {
    const { r, P, rival } = setup();
    approach(r, P, 80, -1, 14);
    P.fuel = 0.4;
    r.requestPit(me(r).id); r.requestDefer(me(r).id);                          // the fuel stop is now committed for next lap
    approach(r, P, 60, -1, 14, LAP + 1);
    award(r, P, rival);
    const tr = run(r, driver(UP), 30, inService);
    const iServed = tr.events.findIndex((e) => e.type === 'served');
    expect(iServed).toBeGreaterThanOrEqual(0);
    expect(tr.phases.filter(Boolean)).toEqual(['armed', 'entry', 'serving', 'bay', 'refuel']);
    expect([P.sgOwed, P.bay]).toEqual([0, P.bayHome]);
    expect(P.fuelDue).toBe(LAP + 1);                           // not yet: the fuel stop counts after standing in the bay
    run(r, NONE, 1);
    expect(P.fuelDue).toBe(0);
    expect(tr.brakeAfterTakeover).toBe(false);
  });

  it('a stop-and-go still owed in the bay is not paid by refuelling', () => {
    const { r, P } = setup();
    inBay(r, P, P.bayHome, 0); P.sgOwed = PEN.stopSeconds; P.sgDue = LAP + 1; P.fuel = 0.3;
    run(r, NONE, 3);
    expect(P.fuel).toBeGreaterThan(0.3); expect(P.sgOwed).toBe(PEN.stopSeconds);
  });

  it('a penalty-only visit never stops in the bay', () => {
    const { r, P, rival } = setup();
    approach(r, P, 60, -1, 14); P.fuel = 0.4;
    award(r, P, rival);
    const tr = run(r, driver(UP), 30, (r2) => me(r2).sgOwed === 0 && me(r2).mode === 'race');
    expect(P.pitStops).toBe(0); expect(bayGrants(r)).toHaveLength(0);
    expect(tr.phases).not.toContain('bay');
  });

  it('on the final lap a fuel stop is served and the car is classified at the flag', () => {
    const { r, P } = setup();
    approach(r, P, 120, -1, 15, LAPS);
    P.fuel = 0.1; P.fuelDue = LAPS;
    r.syncRoute(P);
    run(r, driver(NONE), 40, inService);
    run(r, NONE, 1);
    expect(P.fuelDue).toBe(0);
    press(r);
    run(r, NONE, 10, (r2) => me(r2).finished);
    expect(P.status).toBe('finished'); expect(P.svcBreach).toBe(null);
  });

  it('due next lap after an override: driven past on the override, then served automatically next lap, and not re-armed after', () => {
    const { r, P } = setup('circuit-2');
    const sw = [...T.SWITCHES].sort((a, b) => T.ahead(a.s0, T.PIT_IN0) - T.ahead(b.s0, T.PIT_IN0))[0];
    const before = T.ahead(sw.s0, T.PIT_IN0) + 6;
    approach(r, P, before, -1, 10);
    P.fuel = 0.5; r.requestPit(me(r).id);
    r.requestLane(me(r).id);                                            // override: the inside lane at the next switch
    expect(P.laneOverride).toBe(true);
    const tr = run(r, driver(NONE), 12, (r2) => T.gapS(T.PIT_IN0, r2.s(P)) > 3 && me(r2).mode === 'race');
    expect(tr.msgs).toContain('msg.fuelOverride');
    expect(P.fuelDue).toBe(LAP + 1); expect(P.mode).toBe('race');
    approach(r, P, 120, -1, 15, LAP + 1);
    run(r, driver(NONE), 40, inService);
    run(r, NONE, 1);
    expect(P.fuelDue).toBe(0);
    press(r);
    run(r, NONE, 10, backOut);
    // the next approach goes by with no takeover
    approach(r, P, 60, -1, 14, LAP + 2);
    const t3 = run(r, driver(NONE), 6);
    expect(t3.phases.filter(Boolean)).toEqual([]);
    expect(P.pitReq).toBe(false); expect(P.pitStops).toBe(1);
  });

  it('Space with no switch left during a fuel takeover is refused and the car still stops in its bay', () => {
    const { r, P } = setup();
    approach(r, P, 20, -1, 12); P.fuel = 0.4; r.requestPit(me(r).id);
    run(r, NONE, DT);
    expect(P.sgCtl).toBe(true);
    const ev: RaceEvent[] = []; r.requestLane(me(r).id); ev.push(...r.events); r.events.length = 0;
    expect(msgs(ev)).toEqual(['msg.fuelNoSwitch']); expect(P.laneOverride).toBe(false);
    run(r, NONE, 10, inService);
    expect([P.mode, P.bay]).toEqual(['service', P.bayHome]);
  });

  it('cancelling an optional stop with Pit during the takeover hands the car back on the road', () => {
    const { r, P } = setup();
    approach(r, P, 30, -1, 12); P.fuel = 0.4; r.requestPit(me(r).id);
    run(r, NONE, DT);
    expect(P.sgCtl).toBe(true);
    r.requestPit(me(r).id);
    run(r, UP, DT);
    expect(P.sgCtl).toBe(false); expect(P.pitReq).toBe(false);
    run(r, UP, 3);
    expect(P.mode).toBe('race'); expect(P.pitStops).toBe(0);
  });

  it('a manual stop beside another team\'s bay is never captured; reversing back to its own bay is', () => {
    const { r, P } = setup();
    inPit(P, T.BAYS[2], 0);                                    // manual (no fuel visit): stopped at Blue's bay
    run(r, BRAKE, 0.3);
    expect(P.mode).toBe('pitlane');
    while (!P.revOn) run(r, BRAKE, DT);
    run(r, BRAKE, 8, (r2) => T.gapS(T.BAYS[0], r2.s(P)) < 0.3);
    run(r, NONE, 1.5, (r2) => me(r2).mode === 'bayIn');
    expect([P.mode, P.bay]).toEqual(['bayIn', P.bayHome]);
  });
});

describe('past the bay by hand', () => {
  it('a fuel visit past its bay centre is the driver\'s: Brake-hold reverse works, and releasing at the bay captures it', () => {
    const { r, P } = setup();
    inPit(P, T.BAYS[P.bayHome] + T.BAY_HALF + 0.5); P.pitFuel = true; P.fuel = 0.3;
    run(r, NONE, DT);
    expect(P.sgCtl).toBe(false); expect(P.mode).toBe('pitlane');
    while (!P.revOn) run(r, BRAKE, DT);
    run(r, BRAKE, 5, (r2) => T.gapS(T.BAYS[0], r2.s(P)) < 0.3);
    const tr = run(r, NONE, 1.5, inService);
    expect([P.mode, P.bay]).toEqual(['service', P.bayHome]);
    expect(tr.minV).toBeLessThan(0);                            // it really reversed there
  });

  it('just short of or at the bay centre, the controller still brings it in', () => {
    for (const d of [-0.6, 0.1]) {
      const { r, P } = setup();
      inPit(P, T.BAYS[P.bayHome] + d); P.pitFuel = true; P.fuel = 0.3;
      run(r, NONE, 3, inService);
      expect([P.mode, P.bay]).toEqual(['service', P.bayHome]);
    }
  });
});

describe('frame rate', () => {
  it('stops at the same point at 1/24 to 1/144 s frames', () => {
    const at: number[] = [];
    for (const dt of [1 / 24, 1 / 60, 1 / 144]) {
      const { r, P } = setup();
      approach(r, P, 60, -1, 14); P.fuel = 0.4; r.requestPit(me(r).id);
      let s = -1;
      run(r, UP, 20, (r2) => { if (P.mode === 'bayIn' && s < 0) s = T.gapS(T.BAYS[0], r2.s(P)); return s >= 0; }, dt);
      at.push(s);
    }
    for (const s of at) expect(Math.abs(s)).toBeLessThan(AUTO.bayTol);
  });
});
