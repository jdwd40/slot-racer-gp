// Post-race debrief online (#134): the room server's result envelope carries each human's summary, collected by the same race
// core as a local race, frozen at that driver's own terminal result. The same seeded race with the same inputs, replayed as
// the browser runs a local race, gives the same summaries; a reconnect, the accelerated AI run-on, duplicate consumption and
// resends cannot change them; an envelope from before debriefs reads as unavailable.
import { describe, it, expect } from 'vitest';
import { Race, type Controls, type DriverAction } from '../../src/race';
import { DEBRIEF_VERSION, readDebrief, type DriverDebrief } from '../../src/debrief';
import type { ResultEnvelope } from '../../server/envelope';
import { FakePeer, harness } from './harness';
import { drive as botDrive } from './bot';

type Call = { act: DriverAction } | { dt: number; inputs: Controls };

/** A two-human Standard room with AI fill, driven by the bot (with pit stops), one seat dropped and resumed mid-race. */
function roomRace(seed: number, track = 'circuit-3') {
  const h = harness({}, seed);
  const peers = [new FakePeer(), new FakePeer()];
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track, aiFill: true }, lengths: 1, setups: 1, setup: 'grip' });
  if (!c.ok) throw new Error(c.code);
  const j = h.mgr.join(peers[1], '10.0.0.1', { code: c.room.code, name: 'P1', accountId: null, lengths: 1, setups: 1 });
  if (!j.ok) throw new Error(j.code);
  const ids = [c.participant, j.participant], tokens = [c.token, j.token], room = c.room;
  room.handle(ids[1], { t: 'ready', ready: true }, h.now); room.handle(ids[0], { t: 'start' }, h.now);
  const race = room.race!;
  // every call the room makes into its race, in order, as plain data: the replay's whole input
  const calls: Call[] = [];
  const terminalAt = new Map<string, DriverDebrief>();
  const update = race.update.bind(race), act = race.act.bind(race);
  race.update = (dt, inputs = {}) => {
    calls.push({ dt, inputs: JSON.parse(JSON.stringify(inputs)) as Controls });
    update(dt, inputs);
    // the summary at the moment each human became terminal: the AI run-on after it must not change it
    for (const id of ids) if (!terminalAt.has(id) && race.car(id)!.status !== 'running') terminalAt.set(id, race.debrief(id)!);
  };
  race.act = (a) => { calls.push({ act: { ...a } }); return act(a); };
  let n = 0, dropped = false, peer1 = peers[1];
  const acts = [0, 0];
  h.advance(3_000_000, 50, () => {
    n++;
    ids.forEach((id, k) => {
      if (!room.participant(id)?.peer) return;
      const s = (k === 0 ? peers[0] : peer1).lastSnap();
      const b = s ? botDrive(s, id, k === 0 ? 1 : 0.95) : { up: false, down: false, pit: false };
      room.handle(id, { t: 'ctl', seq: n, up: b.up, down: b.down }, h.now);
      if (b.pit && n % 10 === 0) room.handle(id, { t: 'act', seq: ++acts[k], type: 'pit' }, h.now);
    });
    // the second seat drops for two seconds mid-race and comes back (its car is held, then rejoins)
    if (n === 600 && !dropped) { dropped = true; room.disconnect(ids[1], peer1, h.now); }
    if (n === 640) { peer1 = new FakePeer(); expect(h.mgr.resume(peer1, '10.0.0.1', room.id, ids[1], tokens[1], null)).toMatchObject({ ok: true }); }
  }, () => room.state !== 'race');
  const env = room.result!;
  return { h, room, race, env, ids, calls, terminalAt, opts: { track, seed, roster: race.cars.map((x) => ({ id: x.id, control: x.human ? 'human' as const : 'ai' as const, slot: x.idx, name: x.name, color: x.color, setup: x.setup.id })), length: race.length.id, finishWindow: race.finishWindow, timeLimit: race.timeLimit } };
}

describe('the result envelope carries each human\'s debrief (#134)', () => {
  const R = roomRace(4242);

  it('a completed race: one summary per human (none for the AI), model version 1, frozen with the envelope', () => {
    expect(R.env.outcome).toBe('completed');
    expect(R.env.debrief?.v).toBe(DEBRIEF_VERSION);
    expect(R.env.debrief!.drivers.map((d) => d.driver)).toEqual(R.ids);
    for (const id of R.ids) {
      const d = readDebrief(R.env, id)!;
      expect(d).toEqual(R.race.debrief(id));
      expect(d.laps).toBe(R.env.classification!.find((x) => x.id === id)!.laps);
      expect(d.laps).toBeLessThanOrEqual(13);
    }
    expect(Object.isFrozen(R.env.debrief!.drivers[0])).toBe(true);
    // the race had something to report: pit visits from the bot's stops
    expect(R.env.debrief!.drivers.some((d) => d.pit.visits > 0)).toBe(true);
    // bounded: a few hundred bytes per human
    expect(JSON.stringify(R.env.debrief).length).toBeLessThan(1400);
  });

  it('frozen at each human\'s own finish: the accelerated AI run-on and watching after finishing add nothing', () => {
    for (const id of R.ids) expect(readDebrief(R.env, id)).toEqual(R.terminalAt.get(id));
  });

  it('the same seed and inputs run as a local race (runOn sync, as the browser) give the same personal summaries', () => {
    const local = new Race({ ...R.opts, runOn: 'sync' });
    for (const c of R.calls) { if ('act' in c) local.act(c.act); else local.update(c.dt, c.inputs); if (R.ids.every((id) => local.car(id)!.status !== 'running') && local.debriefs.frozen(R.ids[0]) && local.debriefs.frozen(R.ids[1])) break; }
    for (const id of R.ids) expect(local.debrief(id)).toEqual(readDebrief(R.env, id));
    // the reconnecting seat really was held away and came back
    expect(R.calls.some((c) => 'inputs' in c && c.inputs[R.ids[1]]?.away === true)).toBe(true);
  });

  it('duplicate consumption and resends never change or recount it', async () => {
    expect(await R.h.sink.consume(R.env)).toBe('duplicate');
    expect(R.h.sink.stored.get(R.env.raceId)!.debrief).toEqual(R.env.debrief);
    const copy = JSON.parse(JSON.stringify(R.env)) as ResultEnvelope;
    expect(await R.h.sink.consume(copy)).toBe('duplicate');
    // the result message is the same envelope for every member, every time it is sent
    const sent = R.room.results.filter((e) => e.raceId === R.env.raceId);
    expect(sent).toHaveLength(1);
  });

  it('an envelope from before debriefs (an older server) reads as unavailable for every driver', () => {
    const { debrief: _d, ...old } = R.env;
    for (const id of R.ids) expect(readDebrief(old, id)).toBeNull();
  });

  it('an aborted race has no debrief (no result to explain)', () => {
    const h = harness({}, 5);
    const c = h.mgr.create(new FakePeer(), { name: 'S', accountId: null, mode: 'solo', settings: { track: 'circuit-1' } });
    if (!c.ok) throw new Error(c.code);
    c.room.handle(c.participant, { t: 'start' }, h.now);
    h.advance(10_000, 50);
    c.room.abortAndClose('shutdown', h.now);
    const env = c.room.results.at(-1)!;
    expect(env.outcome).toBe('aborted');
    expect(env.debrief).toBeUndefined();
  });
});
