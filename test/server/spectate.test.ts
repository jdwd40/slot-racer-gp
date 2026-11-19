// Post-finish spectating on the room server (#135, docs/spectating.md): while a driver whose race is over is still connected
// (watching, or on the standings card), the race keeps wall-clock pace; the accelerated AI run-on is only for a race nobody
// connected can be watching. Switching between them skips no step, never bursts, keeps the snapshot cap of #49, cannot change
// the result, and the finish window, race-time and lifetime limits still bound the race. Leaving after the flag keeps the finish.
import { describe, it, expect } from 'vitest';
import { STEP } from '../../src/timing';
import type { Config } from '../../server/config';
import { RUNON_STEPS, type Room } from '../../server/room';
import { FakePeer, harness } from './harness';
import { drive as botDrive } from './bot';

type H = ReturnType<typeof harness>;

/** A peer that notes the wall time of every state it is sent. */
class TimedPeer extends FakePeer {
  stateAt: number[] = [];
  constructor(private clock: () => number) { super(); }
  send(d: string): void { super.send(d); if (d.startsWith('{"t":"state"')) this.stateAt.push(this.clock()); }
}
const steps = (room: Room): number => (room as unknown as { stepsDone: number }).stepsDone;
function maxInWindow(at: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < at.length; i++) { while (at[i] - at[j] >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}
/** At most one ordinary state per 1000/Hz ms slot (#49), plus the final state flushed with the classification. */
const bound = (windowMs: number, hz: number): number => Math.floor((windowMs * hz) / 1000) + 1 + 1;

/** n humans (multiplayer, AI fill) in a started race. */
function room(h: H, n: number) {
  const peers: TimedPeer[] = [new TimedPeer(() => h.now)];
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1', aiFill: true } });
  if (!c.ok) throw new Error(c.code);
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < n; k++) {
    const p = new TimedPeer(() => h.now);
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: `P${k}`, accountId: null });
    if (!j.ok) throw new Error(j.code);
    peers.push(p); ids.push(j.participant); tokens.push(j.token);
  }
  const r = c.room;
  for (const id of ids.slice(1)) r.handle(id, { t: 'ready', ready: true }, h.now);
  r.handle(ids[0], { t: 'start' }, h.now);
  expect(r.state).toBe('race');
  return { room: r, peers, ids, tokens };
}
/** The browser's heartbeat: neutral controls from every connected seat (a spectating page sends exactly this). */
const beat = (h: H, r: Room, ids: string[]) => () => {
  for (const id of ids) {
    const p = r.participant(id);
    if (p?.peer && !p.left && r.state === 'race') r.handle(id, { t: 'ctl', seq: p.ctlSeq + 1, up: false, down: false }, h.now);
  }
};
/** Every human takes the flag now (as the race does at the line); the AI field is still racing. */
function finishHumans(r: Room, ids: string[]): void {
  const race = r.race!;
  for (const id of ids) race.finishCar(race.car(id)!, race.raceTime, null);
  expect(race.cars.some((c) => c.status === 'running')).toBe(true);
}

describe('run-on pacing follows who can watch (#135)', () => {
  it('connected finishers watch at wall-clock pace; with nobody connected the AI run-on accelerates; back again without a burst', () => {
    const h = harness({}, 2024);
    const { room: r, peers, ids, tokens } = room(h, 2);
    const hb = beat(h, r, ids);
    h.advance(8000, 10, hb);
    finishHumans(r, ids);
    h.advance(50, 10, hb);
    expect(r.race!.humansDoneT).toBeGreaterThanOrEqual(0);
    // watching: about one step per STEP of wall time, the same as racing (never RUNON_STEPS a tick)
    let s0 = steps(r), t0 = h.now, worst = 0;
    h.advance(5000, 10, hb);
    for (let k = 0; k < 100; k++) { const a = steps(r); h.advance(10, 10, hb); worst = Math.max(worst, steps(r) - a); }
    expect(r.pace).toBe('live');
    expect(r.state).toBe('race');
    const wallS = (h.now - t0) / 1000;
    expect((steps(r) - s0) / wallS).toBeGreaterThan(0.95 / STEP);
    expect((steps(r) - s0) / wallS).toBeLessThan(1.05 / STEP);
    expect(worst).toBeLessThanOrEqual(1);
    // one finisher's link drops: the other still watches, so the pace stays
    r.disconnect(ids[1], peers[1], h.now);
    h.advance(1000, 10, hb);
    expect(r.pace).toBe('live');
    // the last connected finisher's link drops too: nobody can watch, so the AI field is run on at RUNON_STEPS a tick
    r.disconnect(ids[0], peers[0], h.now);
    h.advance(10, 10);
    s0 = steps(r);
    h.advance(10, 10);
    expect(r.pace).toBe('runon');
    expect(steps(r) - s0).toBe(RUNON_STEPS);
    h.advance(500, 10);
    expect(r.state).toBe('race');
    // a finisher resumes mid run-on: wall-clock pace again at once, owing only the time since the last run-on tick (no catch-up)
    const back = new TimedPeer(() => h.now);
    expect(h.mgr.resume(back, '10.0.0.1', r.id, ids[1], tokens[1], null)).toMatchObject({ ok: true });
    const atResume = back.stateAt.length;
    worst = 0;
    for (let k = 0; k < 300 && r.state === 'race'; k++) { const a = steps(r); h.advance(10, 10, hb); worst = Math.max(worst, steps(r) - a); }
    expect(r.pace).toBe('live');
    expect(worst).toBeLessThanOrEqual(1);
    expect(r.lagMs).toBe(0);
    // and the resumed page gets the ordinary stream at the configured rate, no more
    const got = back.stateAt.slice(atResume);
    expect(got.length).toBeGreaterThan(40);
    expect(maxInWindow(got, 1000)).toBeLessThanOrEqual(bound(1000, h.cfg.snapshotHz));
  });

  it.each([
    ['20 Hz', {}],
    ['10 Hz', { snapshotHz: 10 }],
    ['60 Hz', { snapshotHz: 60 }],
  ] as const)('the #49 snapshot cap holds through live watching and pacing switches at %s', (_n, over: Partial<Config>) => {
    const h = harness(over, 99);
    const { room: r, peers, ids, tokens } = room(h, 3);
    const hb = beat(h, r, ids);
    h.advance(6000, 10, hb);
    finishHumans(r, ids);
    // watch, drop everyone, resume one, drop again, resume again: the stream to each connected page never beats the cap
    h.advance(3000, 10, hb);
    for (const [k, p] of peers.entries()) r.disconnect(ids[k], p, h.now);
    h.advance(300, 10);
    let p2 = new TimedPeer(() => h.now);
    expect(h.mgr.resume(p2, '10.0.0.2', r.id, ids[2], tokens[2], null)).toMatchObject({ ok: true });
    h.advance(2000, 10, hb);
    r.disconnect(ids[2], p2, h.now);
    h.advance(200, 10);
    const p3 = new TimedPeer(() => h.now);
    expect(h.mgr.resume(p3, '10.0.0.2', r.id, ids[2], tokens[2], null)).toMatchObject({ ok: true });
    p2 = p3;
    h.advance(600_000, 10, hb, () => r.state !== 'race');
    expect(r.state).toBe('results');
    expect(r.result!.outcome).toBe('completed');
    const hz = h.cfg.snapshotHz;
    for (const p of [...peers, p2]) {
      expect(p.closed === null || p.closed.code !== 4008).toBe(true);
      expect(maxInWindow(p.stateAt, 1000)).toBeLessThanOrEqual(bound(1000, hz));
    }
    expect(p2.of('result')).toHaveLength(1);
  });

  it('the finish window still bounds a watched race: connected spectators cannot prolong it', () => {
    const h = harness({}, 7);
    const { room: r, ids } = room(h, 2);
    const hb = beat(h, r, ids);
    h.advance(8000, 10, hb);
    finishHumans(r, ids);
    const flagT = r.race!.firstFlagT, from = h.now;
    h.advance(900_000, 10, hb, () => r.state !== 'race');
    expect(r.state).toBe('results');
    const env = r.result!;
    // at most the finish window of race time after the first flag (plus the close delay), at wall-clock pace
    expect(env.times.raceTimeS - flagT).toBeLessThanOrEqual(r.race!.finishWindow + 4);
    expect((h.now - from) / 1000).toBeLessThanOrEqual(r.race!.finishWindow + 5);
    expect(env.classification!.every((x) => x.status !== ('running' as string))).toBe(true);
  });

  it('leaving after taking the flag keeps the finish (never a retirement); the room gives the seat up and still classifies', () => {
    const h = harness({}, 31);
    const { room: r, peers, ids } = room(h, 2);
    const hb = beat(h, r, ids);
    h.advance(8000, 10, hb);
    const race = r.race!;
    race.finishCar(race.car(ids[0])!, race.raceTime, null);
    h.advance(500, 10, hb);
    r.handle(ids[0], { t: 'leave' }, h.now);
    expect(peers[0].of('bye').at(-1)).toMatchObject({ code: 'left' });
    expect(race.car(ids[0])!.status).toBe('finished');
    expect(race.car(ids[0])!.dnfReason).toBe(null);
    // the other human still racing: wall-clock pace; then they finish and leave too, so nobody is left to watch
    h.advance(1000, 10, hb);
    expect(r.pace).toBe('live');
    race.finishCar(race.car(ids[1])!, race.raceTime, null);
    r.handle(ids[1], { t: 'leave' }, h.now);
    h.advance(50, 10);
    // nobody seated: the room closes when the race ends; the result is still made, with both finishes
    expect(r.pace === 'runon' || r.state !== 'race').toBe(true);
    h.advance(600_000, 10, undefined, () => r.state !== 'race');
    const env = r.results.at(-1)!;
    expect(env.outcome).toBe('completed');
    for (const id of ids) expect(env.classification!.find((x) => x.id === id)).toMatchObject({ status: 'finished' });
    expect(peers[0].of('result')).toHaveLength(0);   // a driver who left is not promised the result screen
  });
});

/**
 * A whole bot-driven race, every seat sending its bot's controls until its car is terminal and then the neutral heartbeat a
 * spectating page sends. `force`: the pacing the room would choose, overridden: 'runon' makes every terminal phase accelerated
 * (the behaviour before #135), 'live' never accelerates.
 */
function botRace(seed: number, force: 'auto' | 'runon') {
  const h = harness({}, seed);
  const { room: r, peers, ids } = room(h, 2);
  if (force === 'runon') (r as unknown as { watched: () => boolean }).watched = () => false;
  let n = 0;
  const acts = [0, 0];
  const paces = new Set<string>();
  h.advance(3_000_000, 50, () => {
    n++;
    paces.add(r.pace);
    ids.forEach((id, k) => {
      const c = r.race?.car(id);
      if (!c || !r.participant(id)?.peer) return;
      const s = peers[k].lastSnap();
      const b = c.status === 'running' && s ? botDrive(s, id, k === 0 ? 1 : 0.93) : { up: false, down: false, pit: false };
      r.handle(id, { t: 'ctl', seq: n, up: b.up, down: b.down }, h.now);
      if (b.pit && n % 10 === 0) r.handle(id, { t: 'act', seq: ++acts[k], type: 'pit' }, h.now);
    });
  }, () => r.state !== 'race');
  const env = r.result!;
  const norm = (x: string): string => ids.reduce((s, id, k) => s.split(id).join(`H${k}`), x);
  return {
    env, paces, wallMs: h.now,
    core: norm(JSON.stringify({ c: env.classification, l: env.laps, d: env.debrief, t: env.times.raceTimeS, ticks: env.times.ticks })),
    states: peers.map((p) => p.of('state').length as number),
  };
}

describe('pacing never changes the result (#135)', () => {
  it.each([4242, 777])('seed %i: watched at wall-clock pace and accelerated give the same classification, laps, debriefs, race time and ticks', (seed) => {
    const live = botRace(seed, 'auto');
    const fast = botRace(seed, 'runon');
    expect(live.env.outcome).toBe('completed');
    expect(live.paces.has('runon')).toBe(false);   // both humans stayed connected: never accelerated
    expect(fast.paces.has('runon')).toBe(true);
    expect(live.core).toBe(fast.core);
    // watching took longer in wall time (the AI field at normal speed), never shorter
    expect(live.wallMs).toBeGreaterThanOrEqual(fast.wallMs);
  });
});
