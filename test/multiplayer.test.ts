// Multiplayer race core: rosters of stable driver IDs, independent held inputs and sequenced actions for 2-4 humans, every
// human getting the assistance and service rules, per-driver terminal status with a bounded finish, authoritative
// snapshots and events, per-race random sources and track contexts. See docs/multiplayer-core.md.
import { describe, it, expect, afterEach, vi } from 'vitest';
import raceSrc from '../src/race.ts?raw';
import pitSrc from '../src/pit.ts?raw';
import pitConstSrc from '../src/pitConst.ts?raw';
import trafficSrc from '../src/traffic.ts?raw';
import trackSrc from '../src/track.ts?raw';
import * as T from '../src/track';
import {
  Race, Car, Input, Controls, RaceOpts, RosterEntry, DriverAction, LAPS, PEN, SERVICE_READY, CLOSE_DELAY, REV_CAP,
  DRIVERS, SOLO_ID, RaceEvent, SgPhase, wireEvent, soloRoster,
} from '../src/race';
import * as R from '../src/records';
import { carLabel } from '../src/hud';

afterEach(() => vi.restoreAllMocks());

const DT = 1 / 60;
const UP: Input = { up: true, down: false };
const DOWN: Input = { up: false, down: true };
const OFF: Input = { up: false, down: false };
const LAP = 3;

const humans = (n: number): RosterEntry[] => Array.from({ length: n }, (_, k) => ({ id: `h${k}`, control: 'human' as const }));

/** A race of `roster` already under way (no countdown, no start grace), every car on lap LAP. */
function room(roster: RosterEntry[], opts: RaceOpts = {}, track = 'circuit-1'): Race {
  const r = new Race({ roster, seed: 11, track, ...opts });
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; c.sectors = 0; }
  return r;
}
const car = (r: Race, id: string): Car => r.car(id)!;
function place(r: Race, c: Car, u: number, side: number, v: number): void {
  c.u = u; c.hiU = u; c.laneSide = side; c.d = side * r.T.LANE_HALF; c.v = v; c.change = null; c.mode = 'race'; c.throttle = 0; c.revMark = null;
}
/** On the road `before` metres short of lap LAP's pit entrance. */
function approach(r: Race, c: Car, before: number, v = 12): void {
  place(r, c, LAP * r.T.L + r.T.PIT_IN0 - before, -1, v);
  c.crossed = LAP; c.lapsDone = LAP - 1;
}
function step(r: Race, inputs: Controls | ((r: Race) => Controls), sec: number, stop?: () => boolean): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let t = 0; t < sec; t += DT) {
    r.update(DT, typeof inputs === 'function' ? inputs(r) : inputs);
    ev.push(...r.events); r.events.length = 0;
    if (stop?.()) break;
  }
  return ev;
}
const msgsTo = (ev: RaceEvent[]) => ev.filter((e): e is Extract<RaceEvent, { type: 'msg' }> => e.type === 'msg');

// ---------------------------------------------------------------------------------------------------- roster
describe('roster', () => {
  it('the default solo race and practice keep the existing grid: the solo human in slot 0, three AI rivals', () => {
    T.setTrack('circuit-1');
    const r = new Race();
    expect(r.cars.map((c) => [c.id, c.idx, c.human, c.name, c.num, c.bayHome, c.persona.id])).toEqual([
      [SOLO_ID, 0, true, 'YOU', 7, 0, 'player'], ['ai1', 1, false, 'Red Comet', 11, 1, 'aggressive'],
      ['ai2', 2, false, 'Blue Arrow', 3, 2, 'consistent'], ['ai3', 3, false, 'Green Viper', 24, 3, 'tactical'],
    ]);
    expect(r.finishWindow).toBe(Infinity); expect(r.timeLimit).toBe(Infinity);
    const p = new Race({ practice: true, playerColor: 0x123456 });
    expect(p.cars.map((c) => [c.id, c.idx, c.human, c.color])).toEqual([[SOLO_ID, 0, true, 0x123456]]);
    expect(soloRoster(true)).toEqual([{ id: SOLO_ID, control: 'human', slot: 0 }]);
  });

  it.each([1, 2, 3, 4])('builds %i cars from explicit entries, with 2-4 humans getting a bounded finish by default', (n) => {
    const r = new Race({ roster: humans(n), seed: 1 });
    expect(r.cars.map((c) => c.id)).toEqual(humans(n).map((e) => e.id));
    expect(r.cars.every((c) => c.human && c.persona.id === 'player')).toBe(true);
    expect(Number.isFinite(r.finishWindow)).toBe(n > 1);
  });

  it('a human in a nonzero slot takes that slot\'s grid place, number and bay; slots fill in order when omitted', () => {
    const solo = new Race({ seed: 1 });
    const r = new Race({ roster: [{ id: 'ai-x', control: 'ai' }, { id: 'me', control: 'human', slot: 2 }, { id: 'b', control: 'human' }], seed: 1 });
    expect(r.cars.map((c) => [c.id, c.idx])).toEqual([['ai-x', 0], ['b', 1], ['me', 2]]);
    const me = car(r, 'me');
    expect(me.bayHome).toBe(2); expect(me.num).toBe(DRIVERS[2].num);
    expect(me.u).toBe(solo.cars[2].u); expect(me.laneSide).toBe(solo.cars[2].laneSide);
    // an AI in slot 0 races as an AI persona, not the player assistance profile
    expect(car(r, 'ai-x').persona.id).not.toBe('player');
  });

  it('rejects rosters a race cannot be built from', () => {
    expect(() => new Race({ roster: [] })).toThrow();
    expect(() => new Race({ roster: humans(5) })).toThrow();
    expect(() => new Race({ roster: [{ id: 'a', control: 'human' }, { id: 'a', control: 'ai' }] })).toThrow(/duplicate/);
    expect(() => new Race({ roster: [{ id: 'a', control: 'human', slot: 1 }, { id: 'b', control: 'human', slot: 1 }] })).toThrow(/slot/);
    expect(() => new Race({ roster: [{ id: 'a', control: 'human', slot: 4 }] })).toThrow(/slot/);
    expect(() => new Race({ roster: [{ id: '', control: 'human' }] })).toThrow();
  });

  it('assigned bays are unique per driver and stable for the whole race', () => {
    const r = room([{ id: 'w', control: 'human', slot: 3 }, { id: 'x', control: 'human', slot: 1 }, { id: 'y', control: 'ai', slot: 0 }, { id: 'z', control: 'human', slot: 2 }]);
    const bays = r.cars.map((c) => c.bayHome);
    expect(new Set(bays).size).toBe(4);
    for (const c of r.cars) expect(r.bayOwner(c.bayHome)?.id).toBe(c.id);
    step(r, { w: UP, x: UP, z: UP }, 3);
    expect(r.cars.map((c) => c.bayHome)).toEqual(bays);
  });
});

// ---------------------------------------------------------------------------------------------------- independent control
/**
 * Roles: h0 holds Throttle; h1 holds Brake from rest (reverse) and asks to Pit; h2 sends no input at all and asks for a lane
 * change; h3 has a released input and asks for a lane change twice (cancelled again, in sequence order).
 */
function roles(n: number, only?: number): { inputs: Controls; actions: DriverAction[] } {
  const inputs: Record<string, Input> = {};
  const actions: DriverAction[] = [];
  const on = (k: number) => k < n && (only === undefined || only === k);
  if (on(0)) inputs.h0 = UP;
  if (on(1)) { inputs.h1 = DOWN; actions.push({ driver: 'h1', seq: 1, type: 'pit' }); }
  if (on(2)) actions.push({ driver: 'h2', seq: 1, type: 'lane' });
  // h3's actions arrive out of order: they are still applied in sequence order
  if (on(3)) { inputs.h3 = OFF; actions.push({ driver: 'h3', seq: 2, type: 'lane' }, { driver: 'h3', seq: 1, type: 'lane' }); }
  return { inputs, actions };
}
/** n human cars spread round the lap on straights clear of each other, all at rest except h2 rolling slowly. */
function spread(n: number): Race {
  const r = room(humans(n));
  // well apart: before switch k on the inside lane (h1 at rest), so nothing interacts in the few seconds run
  r.cars.forEach((c, k) => place(r, c, LAP * r.T.L + r.T.SWITCHES[k].s0 - 6, 1, k === 2 ? 4 : 0));
  return r;
}
function playRoles(n: number, only?: number): { r: Race; ev: RaceEvent[] } {
  const r = spread(n);
  const { inputs, actions } = roles(n, only);
  for (const a of actions) expect(r.act(a)).toBe('queued');
  const ev = step(r, inputs, 1.5);
  return { r, ev };
}

describe.each([2, 3, 4])('%i humans at once', (n) => {
  it('each car answers only its own held input and actions', () => {
    const { r, ev } = playRoles(n);
    const [h0, h1, h2, h3] = ['h0', 'h1', 'h2', 'h3'].map((id) => r.car(id));
    expect(h0!.v).toBeGreaterThan(8);                           // accelerating
    expect(h0!.revOn || h0!.pitReq || h0!.laneReq || h0!.change).toBeFalsy();
    expect(h1!.revOn).toBe(true); expect(h1!.v).toBeLessThan(0); expect(h1!.v).toBeGreaterThanOrEqual(-REV_CAP - 1e-9);
    expect(h1!.pitReq && h1!.fuelReq).toBe(true);
    if (h2) { expect(h2.throttle).toBe(0); expect(h2.v).toBeLessThan(4); expect(h2.laneReq || h2.change !== null).toBe(true); expect(h2.pitReq || h2.revOn).toBe(false); }
    if (h3) { expect(h3.laneReq).toBe(false); expect(h3.change).toBeNull(); expect(h3.v).toBe(0); expect(r.lastSeq.h3).toBe(2); }
    // every personal message went to the driver whose action caused it
    const m = msgsTo(ev);
    expect(m.filter((x) => x.to === 'h1').map((x) => x.text)).toContain('msg.pitNeedLane');
    if (h2) expect(m.filter((x) => x.to === 'h2').map((x) => x.text)).toContain('msg.laneReady');
    if (h3) expect(m.filter((x) => x.to === 'h3').map((x) => x.text)).toEqual(['msg.laneReady', 'msg.laneCancelled']);
    expect(m.every((x) => x.to !== 'h0')).toBe(true);
  });

  it('a driver ends up exactly as when driving alone: nobody else\'s input or action reached its car', () => {
    const together = playRoles(n).r.snapshot();
    for (let k = 0; k < n; k++) {
      const alone = playRoles(n, k).r.snapshot();
      expect(together.cars[k]).toEqual(alone.cars[k]);
    }
  });
});

describe('sequenced actions', () => {
  it('applies each sequence number once, in order, and refuses stale, duplicate, unknown and AI targets', () => {
    const r = room([...humans(2), { id: 'bot', control: 'ai' }]);
    for (const c of r.cars) place(r, c, LAP * r.T.L + 60 + c.idx * 20, 1, 0);
    expect(r.act({ driver: 'h0', seq: 1, type: 'lane' })).toBe('queued');
    expect(r.act({ driver: 'h0', seq: 1, type: 'lane' })).toBe('stale');
    expect(r.act({ driver: 'h0', seq: 1.5, type: 'lane' })).toBe('stale');
    expect(r.act({ driver: 'nobody', seq: 1, type: 'lane' })).toBe('unknown');
    expect(r.act({ driver: 'bot', seq: 1, type: 'pit' })).toBe('unknown');
    expect(r.act({ driver: 'h0', seq: 1, type: 'boost' as 'lane' })).toBe('unknown');
    r.update(DT, {});
    expect(car(r, 'h0').laneReq).toBe(true);
    expect(car(r, 'h1').laneReq).toBe(false);
    expect(car(r, 'bot').pitReq).toBe(false);
    // already applied: a resend changes nothing
    expect(r.act({ driver: 'h0', seq: 1, type: 'lane' })).toBe('stale');
    expect(r.act({ driver: 'h1', seq: 1, type: 'lane' })).toBe('queued');   // sequences are per driver
    r.update(DT, {});
    expect(car(r, 'h0').laneReq).toBe(true);
    expect(car(r, 'h1').laneReq).toBe(true);
    expect(r.snapshot().lastSeq).toEqual({ h0: 1, h1: 1 });
  });

  it('acknowledges and deduplicates actions for a driver whose ID is an Object.prototype key', () => {
    const r = room([{ id: '__proto__', control: 'human' }, { id: 'constructor', control: 'human' }]);
    for (const c of r.cars) place(r, c, LAP * r.T.L + 60 + c.idx * 20, 1, 0);
    expect(r.lastSeq.constructor).toBeUndefined();
    expect(r.act({ driver: '__proto__', seq: 1, type: 'lane' })).toBe('queued');
    expect(r.act({ driver: 'constructor', seq: 1, type: 'lane' })).toBe('queued');
    r.update(DT, {});
    expect(car(r, '__proto__').laneReq).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(r.lastSeq, '__proto__')).toBe(true);
    expect(r.lastSeq['__proto__']).toBe(1);
    expect(r.lastSeq.constructor).toBe(1);
    // the applied action is not queued or applied again
    expect(r.act({ driver: '__proto__', seq: 1, type: 'lane' })).toBe('stale');
    car(r, '__proto__').laneReq = false;
    r.update(DT, {});
    expect(car(r, '__proto__').laneReq).toBe(false);
    // the snapshot carries the acknowledgement, on the wire too
    const snap = r.snapshot();
    expect(Object.keys(snap.lastSeq).sort()).toEqual(['__proto__', 'constructor']);
    expect(JSON.parse(JSON.stringify(snap)).lastSeq).toEqual(JSON.parse('{"__proto__":1,"constructor":1}'));
  });

  it('direct requests address a driver by ID and ignore AI entries', () => {
    const r = room([{ id: 'a', control: 'human' }, { id: 'bot', control: 'ai' }, { id: 'b', control: 'human' }]);
    for (const c of r.cars) place(r, c, LAP * r.T.L + 60 + c.idx * 20, -1, 0);
    r.requestPit('b'); r.requestPit('bot'); r.requestLane('nobody');
    expect(car(r, 'b').pitReq).toBe(true);
    expect(car(r, 'a').pitReq).toBe(false);
    expect(car(r, 'bot').pitReq).toBe(false);
    expect(r.events.every((e) => e.type !== 'msg' || e.to === 'b')).toBe(true);
  });

  it('a missing or released input is neutral for that driver only', () => {
    const r = room(humans(3));
    r.cars.forEach((c, k) => place(r, c, LAP * r.T.L + r.T.SWITCHES[k].s0 - 6, 1, 6));
    step(r, { h0: UP, h1: OFF }, 0.5);
    expect(car(r, 'h0').throttle).toBeGreaterThan(0.9);
    expect(car(r, 'h1').throttle).toBe(0);
    expect(car(r, 'h2').throttle).toBe(0);
    // a held input object with junk values is read strictly
    step(r, { h1: { up: 'yes', down: 1 } as unknown as Input }, 0.1);
    expect(car(r, 'h1').throttle).toBe(0); expect(car(r, 'h1').brake).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------- service rules for every human
describe('every human gets the assistance and service rules', () => {
  it('two humans owing a stop-and-go are both entered, queued, served and handed back automatically, one box user at a time', () => {
    const r = room(humans(2));
    const [a, b] = r.cars;
    for (const c of r.cars) { c.sgOwed = PEN.stopSeconds; c.sgDue = LAP; }
    approach(r, a, 30); approach(r, b, 37);
    const phases: Record<string, SgPhase[]> = { h0: [], h1: [] };
    let both = 0;
    const ev = step(r, () => {
      for (const c of r.cars) if (c.sgPhase !== phases[c.id].at(-1)) phases[c.id].push(c.sgPhase);
      if (a.sgServing && b.sgServing) both++;
      return { h0: UP, h1: UP };       // pedals held: the controller owns them
    }, 40, () => r.cars.every((c) => c.sgOwed === 0 && c.mode === 'race'));
    expect(ev.filter((e) => e.type === 'served').map((e) => (e as { car: Car }).car.id).sort()).toEqual(['h0', 'h1']);
    for (const c of r.cars) {
      expect(phases[c.id]).toEqual(expect.arrayContaining(['entry', 'serving', 'leaving']));
      expect(c.mode).toBe('race');
    }
    expect(phases.h1).toContain('queued');
    expect(both).toBe(0);
    expect(r.pit.log.filter((e) => e.zone === 'box' && e.op === 'grant').map((e) => e.car)).toEqual([0, 1]);
    expect(msgsTo(ev).filter((m) => m.text === 'msg.sgAuto').map((m) => m.to).sort()).toEqual(['h0', 'h1']);
  });

  it('two humans asking for fuel are each driven to their own bay; departure needs that driver\'s own fresh Throttle press', () => {
    const r = room([{ id: 'p', control: 'human', slot: 1 }, { id: 'q', control: 'human', slot: 3 }]);
    const [p, q] = r.cars;
    approach(r, p, 30); approach(r, q, 38);
    r.requestPit('p'); r.requestPit('q');
    step(r, { p: UP, q: UP }, 30, () => p.mode === 'service' && q.mode === 'service' && p.serviceT > SERVICE_READY + 0.2 && q.serviceT > SERVICE_READY + 0.2);
    expect([p.mode, p.bay, q.mode, q.bay]).toEqual(['service', 1, 'service', 3]);
    expect(r.pit.log.filter((e) => e.zone.startsWith('bay') && e.op === 'grant').every((e) => e.zone === `bay${e.car}`)).toBe(true);
    // both still hold Throttle from the arrival: nobody leaves
    step(r, { p: UP, q: UP }, 0.5);
    expect([p.exitReq, q.exitReq, p.sgPhase, q.sgPhase]).toEqual([false, false, 'release', 'release']);
    // q releases and presses again; p keeps holding: only q leaves
    step(r, { p: UP }, DT);
    const ev = step(r, { p: UP, q: UP }, 8, () => q.mode === 'race');
    expect(q.mode).toBe('race'); expect(q.serviced).toBe(false);
    expect(p.mode).toBe('service'); expect(p.exitReq).toBe(false);
    expect(msgsTo(ev).filter((m) => m.text === 'msg.departReq').map((m) => m.to)).toEqual(['q']);
  });

  it('the inside-lane override and reverse belong to the driver who used them', () => {
    const r = room(humans(3));
    const [a, b, c] = r.cars;
    // a and b both routed to the pit with a switch still ahead; c parked far away
    for (const x of [a, b]) { x.sgOwed = PEN.stopSeconds; x.sgDue = LAP + 1; }
    const sw = r.T.SWITCHES[r.T.SWITCHES.length - 1];
    place(r, a, LAP * r.T.L + sw.s0 - 12, -1, 0); place(r, b, LAP * r.T.L + sw.s0 - 24, -1, 0);
    place(r, c, LAP * r.T.L + 70, 1, 0);
    r.update(DT, {});
    expect(r.act({ driver: 'h0', seq: 1, type: 'lane' })).toBe('queued');
    step(r, { h2: DOWN }, 1.2);
    expect(a.laneOverride).toBe(true);
    expect(b.laneOverride).toBe(false); expect(b.pitReq).toBe(true);
    expect(c.revOn).toBe(true); expect(a.revOn || b.revOn).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------- finishing
/** Bring a car across the line that ends the final lap. */
function flag(r: Race, c: Car, input: Controls = {}): RaceEvent[] {
  c.crossed = LAPS; c.lapsDone = LAPS - 1; c.sectors = 7;
  place(r, c, r.T.FINISH_S + LAPS * r.T.L - 0.3, -1, 10);
  return step(r, input, 4 * DT);
}

describe('finishing', () => {
  it('a first human finish does not stop the others; the race closes once every human is terminal, with one final result', () => {
    const r = room([...humans(2), { id: 'bot', control: 'ai' }], { finishWindow: Infinity, timeLimit: Infinity });
    const [a, b, bot] = r.cars;
    for (const c of r.cars) place(r, c, LAP * r.T.L + 60 + c.idx * 25, 1, 0);
    const ev = flag(r, a);
    expect(a.status).toBe('finished');
    expect(ev.some((e) => e.type === 'finish' && e.car === a)).toBe(true);
    // well past the old 3.2 s cut-off: h1 is still racing and still in control of its car
    const u0 = b.u;
    const more = step(r, { h1: UP }, 10);
    expect(r.phase).toBe('racing'); expect(b.status).toBe('running'); expect(b.u - u0).toBeGreaterThan(40);
    expect(r.standings()).toBeNull(); expect(r.final).toBeNull();
    expect(more.some((e) => e.type === 'final')).toBe(false);
    flag(r, b);
    expect(b.status).toBe('finished');
    const close = step(r, {}, CLOSE_DELAY + 0.2);
    expect(r.phase).toBe('done');
    expect(close.filter((e) => e.type === 'final')).toHaveLength(1);
    // the AI was run on to a real result
    expect(bot.status).not.toBe('running');
    const fin = r.final!;
    expect(fin.map((x) => x.id).slice(0, 2)).toEqual(['h0', 'h1']);
    expect(fin.every((x) => x.status !== ('running' as string))).toBe(true);
    expect(Object.isFrozen(fin)).toBe(true);
    // nothing changes it afterwards
    const later = step(r, {}, 2);
    expect(later.filter((e) => e.type === 'final' || e.type === 'finish' || e.type === 'dq' || e.type === 'dnf')).toHaveLength(0);
    expect(r.final).toBe(fin);
  });

  it('the finish window terminally classifies everyone still running, once and in a fixed order: a latched breach is a DQ', () => {
    // a window under STALL.grace: the humans left standing on the slot are still there when it closes (#69 would move them)
    const r = room([...humans(3), { id: 'bot', control: 'ai' }], { finishWindow: 2.5 });
    const [a, b, c, bot] = r.cars;
    for (const x of r.cars) place(r, x, LAP * r.T.L + 60 + x.idx * 25, 1, 0);
    b.svcBreach = 'stopGo';
    flag(r, a);
    expect(r.firstFlagT).toBeGreaterThan(0);
    const ev = step(r, {}, 2.7);
    expect([a.status, b.status, c.status, bot.status]).toEqual(['finished', 'dq', 'dnf', 'dnf']);
    expect([b.dqReason, c.dnfReason, bot.dnfReason]).toEqual(['deadline', 'window', 'window']);
    const terminal = ev.filter((e) => e.type === 'dq' || e.type === 'dnf').map((e) => `${e.type}:${(e as { car: Car }).car.id}`);
    // furthest first (bot, then h2, then h1), each exactly once
    expect(terminal).toEqual(['dnf:bot', 'dnf:h2', 'dq:h1']);
    expect(msgsTo(ev).filter((m) => m.text === 'msg.dq.deadline').map((m) => m.to)).toEqual(['h1']);
    // the classified cars hold no pit resources and their pedals no longer move anything
    expect(r.pit.held(b).length + r.pit.held(c).length).toBe(0);
    step(r, {}, CLOSE_DELAY + 0.2);
    expect(r.phase).toBe('done');
    expect(r.final!.map((x) => [x.id, x.pos, x.status])).toEqual([['h0', 1, 'finished'], ['bot', null, 'dnf'], ['h2', null, 'dnf'], ['h1', null, 'dq']]);
    expect(r.final!.every((x) => x.status === 'finished' ? x.time !== null : x.time === null)).toBe(true);
  });

  it('the race-time limit ends a race nobody finishes, and a DQ at the flag keeps the final-lap service rules', () => {
    const r = room(humans(2), { timeLimit: 20 });
    const [a, b] = r.cars;
    for (const x of r.cars) place(r, x, LAP * r.T.L + 60 + x.idx * 25, 1, 0);
    // h0 still owes a stop-and-go at the flag: DQ, exactly as solo
    a.sgOwed = PEN.stopSeconds; a.sgDue = LAPS; a.sgDeferred = true;
    flag(r, a);
    expect(a.status).toBe('dq'); expect(a.dqReason).toBe('stopGo');
    step(r, {}, 20);
    expect(b.status).toBe('dnf'); expect(b.dnfReason).toBe('timeout');
    step(r, {}, CLOSE_DELAY + 0.2);
    expect(r.final!.map((x) => [x.id, x.status])).toEqual([['h1', 'dnf'], ['h0', 'dq']]);
  });

  it('only final standings feed awards: a live order with estimated times never becomes a podium', () => {
    const r = room([...humans(2), { id: 'bot', control: 'ai' }]);
    for (const x of r.cars) place(r, x, LAP * r.T.L + 60 + x.idx * 25, 1, 0);
    flag(r, r.cars[0]);
    const live = r.results();
    expect(live.some((x) => x.est)).toBe(true);
    expect(r.standings()).toBeNull();
    // the browser records a championship round only from race.final, which exists only when every car is terminal
    expect(r.final).toBeNull();
    step(r, {}, 120, () => r.phase === 'done');
    const round = R.roundRecord('circuit-1', r.final!.map((x) => ({ car: { idx: x.slot }, status: x.status, time: x.time ?? 0 })));
    expect(round.order.filter((o) => !o.dnf && !o.dq).every((o) => o.time > 0)).toBe(true);
  });

  it('a solo race still ends 3.2 s after the solo driver finishes and runs the field on', () => {
    T.setTrack('circuit-1');
    const r = new Race({ seed: 2 });
    r.phase = 'racing'; r.t = 10; r.raceTime = 5;
    for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.crossed = LAP; c.lapsDone = LAP - 1; }
    const p = car(r, SOLO_ID);
    flag(r, p);
    step(r, {}, CLOSE_DELAY - 0.2);
    expect(r.phase).toBe('racing');
    step(r, {}, 0.4);
    expect(r.phase).toBe('done');
    expect(r.cars.every((c) => c.status !== 'running')).toBe(true);
    expect(r.final).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------- snapshots, determinism, isolation
function busy(seed: number, track = 'circuit-1', sec = 30): { r: Race; snaps: unknown[]; wire: unknown[] } {
  const r = new Race({ roster: [...humans(2), { id: 'ai-a', control: 'ai' }, { id: 'ai-b', control: 'ai' }], seed, track });
  const snaps: unknown[] = [], wire: unknown[] = [];
  let seq = 0;
  for (let i = 0; i * DT < sec; i++) {
    if (i % 90 === 45) r.act({ driver: i % 180 === 45 ? 'h0' : 'h1', seq: ++seq, type: i % 270 === 45 ? 'pit' : 'lane' });
    r.update(DT, { h0: { up: i % 120 < 100, down: false }, h1: { up: i % 150 < 110, down: i % 150 > 140 } });
    wire.push(...r.drainEvents());
    if (i % 120 === 0) snaps.push(r.snapshot());
  }
  snaps.push(r.snapshot());
  return { r, snaps, wire };
}

describe('authoritative state', () => {
  it('snapshots and wire events are plain JSON with driver IDs, no cycles and no local-player assumption', () => {
    const { r, snaps, wire } = busy(3);
    for (const s of snaps) expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(wire.length).toBeGreaterThan(10);
    const ids = new Set(r.cars.map((c) => c.id));
    for (const e of wire as Record<string, unknown>[]) {
      if ('car' in e) expect(ids.has(e.car as string)).toBe(true);
      if ('other' in e) expect(ids.has(e.other as string)).toBe(true);
      if (e.type === 'msg') expect(['h0', 'h1']).toContain(e.to);
    }
    const text = JSON.stringify(snaps.at(-1));
    expect(text).not.toMatch(/"(player|isPlayer|local|me)"/);
    const last = snaps.at(-1) as ReturnType<Race['snapshot']>;
    for (const v of [last.pit.box, last.pit.exit, ...last.pit.bays, ...last.pit.merges, ...last.pit.order]) expect(v === null || ids.has(v)).toBe(true);
    expect(last.cars.map((c) => c.id)).toEqual(['h0', 'h1', 'ai-a', 'ai-b']);
    expect(wireEvent({ type: 'bump', car: r.cars[0], other: r.cars[1], power: 0.5 })).toEqual({ type: 'bump', car: 'h0', other: 'h1', power: 0.5 });
  });

  it('a seeded race is reproducible and never touches the process-wide random source', () => {
    const spy = vi.spyOn(Math, 'random');
    const a = busy(9), b = busy(9), c = busy(10);
    expect(spy).not.toHaveBeenCalled();
    expect(a.snaps).toEqual(b.snaps);
    expect(a.wire).toEqual(b.wire);
    expect(c.snaps.at(-1)).not.toEqual(a.snaps.at(-1));
  });

  it('races on different circuits run side by side unaffected by each other or by the displayed track', () => {
    const alone1 = busy(4, 'circuit-1', 20).snaps, alone5 = busy(4, 'circuit-5', 20).snaps;
    const r1 = new Race({ roster: [...humans(2), { id: 'ai-a', control: 'ai' }, { id: 'ai-b', control: 'ai' }], seed: 4, track: 'circuit-1' });
    const r5 = new Race({ roster: [...humans(2), { id: 'ai-a', control: 'ai' }, { id: 'ai-b', control: 'ai' }], seed: 4, track: 'circuit-5' });
    expect(r1.T.L).not.toBe(r5.T.L);
    const s1: unknown[] = [], s5: unknown[] = [];
    let seq = 0;
    for (let i = 0; i * DT < 20; i++) {
      // the displayed track keeps changing underneath both races
      T.setTrack(T.TRACKS[i % T.TRACKS.length].id);
      if (i % 90 === 45) { ++seq; for (const r of [r1, r5]) r.act({ driver: i % 180 === 45 ? 'h0' : 'h1', seq, type: i % 270 === 45 ? 'pit' : 'lane' }); }
      const inp = { h0: { up: i % 120 < 100, down: false }, h1: { up: i % 150 < 110, down: i % 150 > 140 } };
      r5.update(DT, inp); r1.update(DT, inp);
      r1.drainEvents(); r5.drainEvents();
      if (i % 120 === 0) { s1.push(r1.snapshot()); s5.push(r5.snapshot()); }
    }
    s1.push(r1.snapshot()); s5.push(r5.snapshot());
    expect(s1).toEqual(alone1);
    expect(s5).toEqual(alone5);
    expect((s1.at(-1) as { track: string }).track).toBe('circuit-1');
    expect((s5.at(-1) as { track: string }).track).toBe('circuit-5');
    T.setTrack('circuit-1');
  });

  it('the simulation core imports no browser, rendering, audio or storage code and runs headless', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    // src/traffic.ts (#74 review): the one out-of-traffic predicate the race core and the pit traffic share
    for (const src of [raceSrc, pitSrc, pitConstSrc, trackSrc, trafficSrc]) {
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.every((x) => x === './track' || x === './pit' || x === './pitConst' || x === './race' || x === './traffic')).toBe(true);
      expect(src).not.toMatch(/\b(window|document|localStorage|requestAnimationFrame|AudioContext|performance)\b\./);
    }
    const r = new Race({ roster: [{ id: 'a', control: 'ai' }, { id: 'b', control: 'ai' }], seed: 5 });
    let t = 0;
    while (r.phase !== 'done' && t < 600) { r.update(DT, {}); r.events.length = 0; t += DT; }
    expect(r.phase).toBe('done');
    expect(r.final!.length).toBe(2);
  });
});

describe('local view labels', () => {
  it('"You" follows the local driver ID, whatever the slot; other humans keep their names', () => {
    const r = new Race({ roster: [{ id: 'x', control: 'human', name: 'Xan' }, { id: 'y', control: 'human', slot: 2, name: 'Yu' }], seed: 1 });
    expect(carLabel(car(r, 'y'), 'y')).not.toBe('Yu');
    expect(carLabel(car(r, 'x'), 'y')).toBe('Xan');
    expect(carLabel(car(r, 'x'), 'x')).toBe(carLabel(car(r, 'y'), 'y'));
  });
});
