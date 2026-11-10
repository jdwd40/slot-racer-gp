// Room service rules, on the real RoomManager/Room with a manual clock and in-memory peers (docs/online-server.md).
import { describe, it, expect } from 'vitest';
import { PEN, type RaceSnapshot } from '../../src/race';
import { LIVERIES, type PublicRoom } from '../../src/net/protocol';
import type { Room } from '../../server/room';
import { BotClient, FakePeer, harness } from './harness';

type H = ReturnType<typeof harness>;

/** A multiplayer lobby with n humans: peers[0] is the creator (host). */
function lobby(h: H, n: number, settings: { track?: string; aiFill?: boolean } = {}, names?: string[]) {
  const peers = [new FakePeer()];
  const c = h.mgr.create(peers[0], { name: names?.[0] ?? 'P0', accountId: null, mode: 'multiplayer', settings });
  if (!c.ok) throw new Error(c.code);
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < n; k++) {
    const p = new FakePeer();
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: names?.[k] ?? `P${k}`, accountId: null });
    if (!j.ok) throw new Error(j.code);
    peers.push(p); ids.push(j.participant); tokens.push(j.token);
  }
  return { room: c.room, peers, ids, tokens };
}
function start(h: H, room: Room, ids: string[]): void {
  for (const id of ids.slice(1)) expect(room.handle(id, { t: 'ready', ready: true }, h.now)).toBe(null);
  expect(room.handle(ids[0], { t: 'start' }, h.now)).toBe(null);
  expect(room.state).toBe('race');
}
/** Drive every seat with a headless bot that reads only its own peer's snapshots, until the room leaves the race. */
function drive(h: H, room: Room, peers: FakePeer[], ids: string[], maxMs = 900_000, skip: Set<string> = new Set()): BotClient[] {
  const bots = ids.map((id, k) => new BotClient(peers[k], id, 1 - k * 0.03));
  h.advance(maxMs, 50, () => {
    if (room.state !== 'race') return;
    for (const b of bots) {
      if (skip.has(b.id) || !room.participant(b.id)?.peer) continue;
      const o = b.controls(); if (!o) continue;
      room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now);
    }
  }, () => room.state !== 'race');
  return bots;
}
const pub = (p: FakePeer): PublicRoom => p.lastRoom();
const carOf = (room: Room, id: string) => room.race!.car(id)!;

describe('private rooms and seats', () => {
  it('2-4 humans get distinct slots, numbers, bays and colours; a fifth is refused and the roster does not change', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 4);
    const r = pub(peers[0]);
    expect(r.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(r.participants.map((p) => p.slot)).toEqual([0, 1, 2, 3]);
    expect(new Set(r.participants.map((p) => p.num)).size).toBe(4);
    expect(new Set(r.participants.map((p) => p.bay)).size).toBe(4);
    expect(new Set(r.participants.map((p) => p.color)).size).toBe(4);
    expect(new Set(ids).size).toBe(4);
    const before = JSON.stringify(room.publicRoom().participants);
    const fifth = new FakePeer();
    expect(h.mgr.join(fifth, '10.0.0.9', { code: room.code, name: 'Late', accountId: null })).toEqual({ ok: false, code: 'full' });
    expect(JSON.stringify(room.publicRoom().participants)).toBe(before);
    expect(fifth.msgs).toEqual([]);
    // codes are case-insensitive to type, unknown codes are not found
    expect(h.mgr.byCode(room.code.toLowerCase())).toBe(room);
    expect(h.mgr.join(new FakePeer(), '10.0.0.9', { code: 'ZZZZZZ', name: 'x', accountId: null })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a duplicate livery request is resolved to a free colour and shown as such; changing livery keeps colours unique', () => {
    const h = harness();
    const a = new FakePeer(), b = new FakePeer(), c = new FakePeer();
    const cr = h.mgr.create(a, { name: 'Ann', livery: 'red', accountId: null, mode: 'multiplayer', settings: {} });
    if (!cr.ok) throw new Error();
    const jb = h.mgr.join(b, '1', { code: cr.room.code, name: 'Bob', livery: 'red', accountId: null });
    const jc = h.mgr.join(c, '2', { code: cr.room.code, name: 'Cy', livery: 'blue', accountId: null });
    if (!jb.ok || !jc.ok) throw new Error();
    let r = cr.room.publicRoom();
    const bob = r.participants.find((p) => p.id === jb.participant)!;
    expect(r.participants[0]).toMatchObject({ livery: 'red', liveryRequested: null });
    expect(bob.livery).not.toBe('red');
    expect(bob.liveryRequested).toBe('red');
    cr.room.handle(jc.participant, { t: 'livery', livery: 'red' }, h.now);
    r = cr.room.publicRoom();
    expect(r.participants.find((p) => p.id === jc.participant)).toMatchObject({ liveryRequested: 'red' });
    expect(new Set(r.participants.map((p) => p.livery)).size).toBe(3);
    // AI fill is explicit: shown in the lobby as AI with their own free colours
    cr.room.handle(cr.participant, { t: 'settings', settings: { aiFill: true } }, h.now);
    r = cr.room.publicRoom();
    expect(r.ai).toHaveLength(1);
    expect(r.ai[0]).toMatchObject({ ai: true, slot: 3 });
    expect(r.ai[0].name).toMatch(/\(AI\)$/);
    expect(new Set([...r.participants.map((p) => p.livery), ...r.ai.map((x) => x.livery)]).size).toBe(4);
    expect(LIVERIES.map((l) => l.id)).toEqual(expect.arrayContaining(r.participants.map((p) => p.livery)));
  });

  it('readiness is visible; only the host starts, only when everyone else is ready and connected; the roster locks at the countdown', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 3);
    expect(room.handle(ids[1], { t: 'start' }, h.now)).toMatchObject({ t: 'nack', code: 'forbidden' });
    expect(room.handle(ids[1], { t: 'settings', settings: { track: 'circuit-3' } }, h.now)).toMatchObject({ code: 'forbidden' });
    expect(room.handle(ids[0], { t: 'start' }, h.now)).toMatchObject({ code: 'not_ready' });
    room.handle(ids[1], { t: 'ready', ready: true }, h.now);
    expect(pub(peers[2]).participants.map((p) => p.ready)).toEqual([false, true, false]);
    expect(room.handle(ids[0], { t: 'start' }, h.now)).toMatchObject({ code: 'not_ready' });
    room.handle(ids[2], { t: 'ready', ready: true }, h.now);
    // the host's settings change asks everyone to confirm again
    expect(room.handle(ids[0], { t: 'settings', settings: { track: 'circuit-3' } }, h.now)).toBe(null);
    expect(room.handle(ids[0], { t: 'settings', settings: { track: 'nowhere' } }, h.now)).toMatchObject({ code: 'bad_settings' });
    expect(pub(peers[1]).participants.map((p) => p.ready)).toEqual([false, false, false]);
    start(h, room, ids);
    expect(room.race!.T.DEF.id).toBe('circuit-3');
    expect(room.race!.phase).toBe('countdown');
    expect(room.race!.cars.map((c) => c.id).sort()).toEqual([...ids].sort());   // no AI unless asked for
    expect(h.mgr.join(new FakePeer(), '9', { code: room.code, name: 'Late', accountId: null })).toMatchObject({ ok: false, code: 'started' });
    expect(room.handle(ids[1], { t: 'ready', ready: false }, h.now)).toMatchObject({ code: 'bad_state' });
    expect(room.handle(ids[0], { t: 'settings', settings: { track: 'circuit-1' } }, h.now)).toMatchObject({ code: 'bad_state' });
  });

  it('a multiplayer room needs two humans; a display name grants nothing: same names are separate seats and resume needs the token', () => {
    const h = harness();
    const { room, ids, tokens } = lobby(h, 1);
    expect(room.handle(ids[0], { t: 'start' }, h.now)).toMatchObject({ code: 'not_ready' });
    const twin = new FakePeer();
    const j = h.mgr.join(twin, '7', { code: room.code, name: 'P0', accountId: null });
    if (!j.ok) throw new Error();
    expect(j.participant).not.toBe(ids[0]);
    expect(room.publicRoom().participants.map((p) => p.name)).toEqual(['P0', 'P0']);
    // the twin cannot take the first seat with its own token
    expect(h.mgr.resume(new FakePeer(), '7', room.id, ids[0], j.token, null)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(h.mgr.resume(new FakePeer(), '7', room.id, ids[0], 'x'.repeat(43), null)).toMatchObject({ ok: false, code: 'forbidden' });
    // tokens never appear in anything public
    const pubJson = JSON.stringify(room.publicRoom());
    for (const t of [...tokens, j.token]) expect(pubJson).not.toContain(t);
  });

  it('an account holds one seat per room, and an account-bound seat can only be resumed by that account', () => {
    const h = harness();
    const a = new FakePeer();
    const c = h.mgr.create(a, { name: 'Acct', accountId: '42', mode: 'multiplayer', settings: {} });
    if (!c.ok) throw new Error();
    expect(h.mgr.join(new FakePeer(), '1', { code: c.room.code, name: 'Again', accountId: '42' })).toMatchObject({ ok: false, code: 'already_joined' });
    c.room.disconnect(c.participant, a, h.now);
    expect(h.mgr.resume(new FakePeer(), '1', c.room.id, c.participant, c.token, null)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(h.mgr.resume(new FakePeer(), '1', c.room.id, c.participant, c.token, '43')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(h.mgr.resume(new FakePeer(), '1', c.room.id, c.participant, c.token, '42')).toMatchObject({ ok: true });
    expect(c.room.publicRoom().participants[0].guest).toBe(false);
  });
});

describe('leaving, host control and cleanup', () => {
  it('host leaving the lobby passes control to the earliest-joined connected driver; the last one out closes and frees the room', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 4);
    room.disconnect(ids[1], peers[1], h.now);            // earliest non-host joiner is offline
    room.handle(ids[0], { t: 'leave' }, h.now);
    expect(peers[0].of('bye').at(-1)).toMatchObject({ code: 'left' });
    expect(room.hostId).toBe(ids[2]);
    expect(pub(peers[3]).participants.find((p) => p.host)!.id).toBe(ids[2]);
    expect(pub(peers[3]).participants.map((p) => p.slot)).toEqual([1, 2, 3]);
    // the freed slot is reused by the next joiner
    const late = h.mgr.join(new FakePeer(), '5', { code: room.code, name: 'New', accountId: null });
    expect(late.ok && room.publicRoom().participants.find((p) => p.id === late.participant)!.slot).toBe(0);
    if (!late.ok) throw new Error();
    // host disconnect in the lobby moves control at once, deterministically
    room.disconnect(ids[2], peers[2], h.now);
    expect(room.hostId).toBe(ids[3]);
    for (const id of [ids[3], late.participant]) room.handle(id, { t: 'leave' }, h.now);
    expect(room.state).toBe('lobby');
    h.advance(h.cfg.graceS * 1000 + 100);                  // the offline seats run out of grace: room empty, closed and forgotten
    expect(room.state).toBe('closed');
    expect(h.mgr.size).toBe(0);
    expect(h.mgr.byCode(room.code)).toBeUndefined();
  });

  it('a creator disconnect during the race does not halt it; grace expiry retires that car (DNF retired) and no one can take the seat', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 3);
    start(h, room, ids);
    h.advance(8000);
    const t0 = room.race!.raceTime;
    room.disconnect(ids[0], peers[0], h.now);
    expect(room.hostId).toBe(ids[0]);                      // nothing in a race waits on the host
    h.advance(3000);
    expect(room.race!.raceTime).toBeGreaterThan(t0 + 2.9);
    expect(h.mgr.join(new FakePeer(), '9', { code: room.code, name: 'Swap', accountId: null })).toMatchObject({ ok: false, code: 'started' });
    h.advance(h.cfg.graceS * 1000);
    expect(carOf(room, ids[0])).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
    expect(room.publicRoom().participants.find((p) => p.id === ids[0])).toMatchObject({ left: true, connected: false });
    expect(h.mgr.resume(new FakePeer(), '9', room.id, ids[0], 'whatever', null)).toMatchObject({ ok: false, code: 'expired' });
    // the others still race; at the end the retired seat is freed and host passes on
    drive(h, room, peers, ids, 900_000, new Set([ids[0]]));
    expect(room.state).toBe('results');
    expect(room.result!.classification!.find((s) => s.id === ids[0])).toMatchObject({ status: 'dnf', dnfReason: 'retired', pos: null });
    expect(room.result!.participants.map((p) => p.id)).toContain(ids[0]);
    expect(room.publicRoom().participants.map((p) => p.id)).toEqual([ids[1], ids[2]]);
    expect(room.hostId).toBe(ids[1]);
  });

  it('leaving mid-race retires the car at once, and a car with a latched service breach is disqualified rather than retired', () => {
    const h = harness();
    const { room, ids } = lobby(h, 3);
    start(h, room, ids);
    h.advance(8000);
    carOf(room, ids[2]).svcBreach = 'stopGo';
    room.handle(ids[1], { t: 'leave' }, h.now);
    room.handle(ids[2], { t: 'leave' }, h.now);
    expect(carOf(room, ids[1])).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
    expect(carOf(room, ids[2])).toMatchObject({ status: 'dq', dqReason: 'deadline' });
  });

  it('room lifetimes are bounded: idle lobbies and results close, the room cap holds, and a closed room is forgotten', () => {
    const h = harness({ roomCap: 2, lobbyIdleS: 60, resultsIdleS: 30 });
    const a = lobby(h, 1), b = lobby(h, 2, { track: 'circuit-5' });
    expect(h.mgr.create(new FakePeer(), { name: 'x', accountId: null, mode: 'multiplayer', settings: {} })).toMatchObject({ ok: false, code: 'unavailable' });
    start(h, b.room, b.ids);
    h.advance(61_000);
    expect(a.room.state).toBe('closed');
    expect(a.peers[0].of('bye').at(-1)).toMatchObject({ code: 'closed', detail: 'idle' });
    expect(b.room.state).toBe('race');                     // a racing room is not idle
    expect(h.mgr.size).toBe(1);
    expect(h.mgr.create(new FakePeer(), { name: 'x', accountId: null, mode: 'solo', settings: {} }).ok).toBe(true);
  });

  it('the room lifetime cap aborts a race without a result and server shutdown does the same', () => {
    const h = harness({ roomMaxS: 120 });
    const { room, peers, ids } = lobby(h, 2);
    start(h, room, ids);
    h.advance(121_000);
    expect(room.state).toBe('closed');
    expect(room.results).toHaveLength(1);
    expect(room.results[0]).toMatchObject({ outcome: 'aborted', abortReason: 'lifetime', classification: null });
    expect(peers[1].of('result')).toHaveLength(1);
    const g = lobby(h, 2); start(h, g.room, g.ids); h.advance(5000);
    h.mgr.shutdown();
    expect(g.room.results[0]).toMatchObject({ outcome: 'aborted', abortReason: 'shutdown', classification: null });
    expect(g.peers[0].closed).toMatchObject({ code: 1012 });
    expect(h.mgr.size).toBe(0);
  });
});

describe('controls, actions and reconnection', () => {
  it('held controls are bound to the sender: duplicate and out-of-order controls are refused, another driver is forbidden', () => {
    const h = harness();
    const { room, ids } = lobby(h, 2);
    start(h, room, ids);
    expect(room.handle(ids[0], { t: 'ctl', seq: 5, up: true, down: false }, h.now)).toBe(null);
    expect(room.handle(ids[0], { t: 'ctl', seq: 5, up: false, down: false }, h.now)).toMatchObject({ code: 'duplicate' });
    expect(room.handle(ids[0], { t: 'ctl', seq: 4, up: false, down: false }, h.now)).toMatchObject({ code: 'out_of_order' });
    expect(room.handle(ids[0], { t: 'ctl', seq: 6, up: true, down: false, driver: ids[1] }, h.now)).toMatchObject({ code: 'forbidden' });
    expect(room.handle(ids[0], { t: 'ctl', seq: 99_999, up: true, down: false }, h.now)).toMatchObject({ code: 'malformed' });
    h.advance(6000, 50, () => { room.handle(ids[0], { t: 'ctl', seq: room.participant(ids[0])!.ctlSeq + 1, up: true, down: false }, h.now); });
    expect(carOf(room, ids[0]).v).toBeGreaterThan(3);
    expect(carOf(room, ids[1]).v).toBe(0);                  // nobody else's input moved it
  });

  it('actions are numbered per driver: applied once, duplicates/out-of-order/foreign refused, refused outside a race', () => {
    const h = harness();
    const { room, ids } = lobby(h, 2);
    expect(room.handle(ids[0], { t: 'act', seq: 1, type: 'pit' }, h.now)).toMatchObject({ code: 'bad_state' });
    start(h, room, ids);
    h.advance(6000);
    expect(room.handle(ids[0], { t: 'act', seq: 1, type: 'pit' }, h.now)).toEqual({ t: 'ack', seq: 1, result: 'queued' });
    expect(room.handle(ids[0], { t: 'act', seq: 1, type: 'pit' }, h.now)).toMatchObject({ code: 'duplicate', seq: 1 });
    expect(room.handle(ids[0], { t: 'act', seq: 3, type: 'lane' }, h.now)).toMatchObject({ t: 'ack' });
    expect(room.handle(ids[0], { t: 'act', seq: 2, type: 'lane' }, h.now)).toMatchObject({ code: 'out_of_order' });
    expect(room.handle(ids[0], { t: 'act', seq: 4, type: 'lane', driver: ids[1] }, h.now)).toMatchObject({ code: 'forbidden' });
    expect(room.handle(ids[1], { t: 'act', seq: 1, type: 'pit' }, h.now)).toMatchObject({ t: 'ack' });   // per-driver numbering
    h.advance(100);
    expect(carOf(room, ids[0]).pitReq).toBe(true);
    expect(room.race!.lastSeq[ids[0]]).toBe(3);
    expect((room.race!.snapshot() as RaceSnapshot).lastSeq[ids[1]]).toBe(1);
  });

  it('a disconnect with Throttle held neutralizes that car at once; a silent client is neutralized after the input timeout', () => {
    const h = harness({ inputTimeoutMs: 500 });
    const { room, peers, ids } = lobby(h, 3);
    start(h, room, ids);
    const held = (id: string) => () => room.handle(id, { t: 'ctl', seq: room.participant(id)!.ctlSeq + 1, up: true, down: false }, h.now);
    const hold = (...xs: string[]) => () => xs.forEach((id) => held(id)());
    h.advance(10_000, 50, hold(...ids), () => room.race!.phase === 'racing');
    h.advance(500, 50, hold(...ids));
    expect(ids.map((id) => carOf(room, id).throttle).every((t) => t > 0.9)).toBe(true);
    room.disconnect(ids[0], peers[0], h.now);               // Throttle was held when the link dropped
    // ids[1] keeps its last held Throttle but stops refreshing it; ids[2] keeps refreshing
    h.advance(300, 50, hold(ids[2]));
    expect(carOf(room, ids[0]).throttle).toBeLessThan(0.1);
    expect(carOf(room, ids[1]).throttle).toBeGreaterThan(0.9);   // still within the input timeout
    h.advance(300, 50, hold(ids[2]));
    expect(room.participant(ids[1])!.held).toEqual({ up: false, down: false });
    h.advance(200, 50, hold(ids[2]));
    expect(carOf(room, ids[1]).throttle).toBeLessThan(0.1);
    expect(room.participant(ids[2])!.held.up).toBe(true);
    expect(carOf(room, ids[2]).throttle).toBeGreaterThan(0.9);
    for (const id of ids) expect(carOf(room, id).mode).toBe('race');
  });

  it('a reconnect within the grace returns to the same car without resetting progress, service debt, penalties or eligibility', () => {
    const h = harness();
    const { room, peers, ids, tokens } = lobby(h, 2);
    start(h, room, ids);
    drive(h, room, peers, ids, 40_000);
    const c = carOf(room, ids[1]);
    c.sgOwed = PEN.stopSeconds; c.sgDue = c.crossed + 1; c.offences = 2; c.timePen = 5;   // debts as the rules would leave them
    const keep = { lapsDone: c.lapsDone, crossed: c.crossed, sgOwed: c.sgOwed, sgDue: c.sgDue, offences: c.offences, timePen: c.timePen, bestLap: c.bestLap, status: c.status };
    expect(keep.lapsDone).toBeGreaterThan(0);
    room.disconnect(ids[1], peers[1], h.now);
    h.advance(5000);
    const back = new FakePeer();
    const r = h.mgr.resume(back, '10.0.0.1', room.id, ids[1], tokens[1], null);
    expect(r).toMatchObject({ ok: true, participant: ids[1] });
    expect(c).toMatchObject({ ...keep, lapsDone: expect.any(Number) });
    expect(c.lapsDone).toBeGreaterThanOrEqual(keep.lapsDone);
    expect(c.status).toBe('running');
    // the old connection is superseded if it were still open; the new one gets a state message at once
    expect(room.stateMsg(h.now)).toContain('"t":"state"');
    expect(room.participant(ids[1])!.peer).toBe(back);
  });

  it('a reconnect after the grace is refused and the car stays retired; a superseded connection is closed', () => {
    const h = harness({ graceS: 10 });
    const { room, peers, ids, tokens } = lobby(h, 2);
    start(h, room, ids);
    h.advance(6000);
    const second = new FakePeer();
    expect(h.mgr.resume(second, '1', room.id, ids[0], tokens[0], null)).toMatchObject({ ok: true });
    expect(peers[0].closed).toMatchObject({ code: 4001 });
    room.disconnect(ids[1], peers[1], h.now);
    h.advance(10_100);
    expect(carOf(room, ids[1])).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
    expect(h.mgr.resume(new FakePeer(), '1', room.id, ids[1], tokens[1], null)).toMatchObject({ ok: false, code: 'expired' });
  });

  it('a slow client is dropped instead of buffering without bound, and keeps its seat for the grace period', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 2);
    start(h, room, ids);
    peers[1].bufferedAmount = h.cfg.sendBufferMax + 1;
    h.advance(500);
    expect(peers[1].closed).toMatchObject({ code: 4008 });
    expect(room.participant(ids[1])).toMatchObject({ peer: null, left: false });
  });
});

describe('races, results and timing', () => {
  it('a two-human race finishes with one immutable envelope; a rematch keeps room and seat IDs and gets a new race ID', async () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 2, { track: 'circuit-2' });
    start(h, room, ids);
    const raceId = room.raceId;
    drive(h, room, peers, ids);
    expect(room.state).toBe('results');
    const env = room.result!;
    expect(Object.isFrozen(env) && Object.isFrozen(env.classification) && Object.isFrozen(env.participants[0])).toBe(true);
    expect(env).toMatchObject({ schema: 1, raceId, roomId: room.id, mode: 'multiplayer', outcome: 'completed', track: { id: 'circuit-2' }, settings: { track: 'circuit-2', aiFill: false } });
    expect(env.track.version).toMatch(/^[0-9a-f]{16}$/);
    expect(env.rules.version).toBe('race-core-2026.11.2');
    expect(env.classification!.map((s) => s.status)).toEqual(['finished', 'finished']);
    expect(env.classification!.map((s) => s.pos)).toEqual([1, 2]);
    expect(env.participants.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(env.laps.filter((l) => l.driver === ids[0]).length).toBe(13);
    expect(env.times.ticks).toBeGreaterThan(0);
    expect(new Date(env.times.finishedAt).getTime()).toBeGreaterThan(new Date(env.times.startedAt).getTime());
    for (const p of peers) expect(p.of('result').map((m) => (m.envelope as { digest: string }).digest)).toEqual([env.digest]);
    // nothing in the envelope or the stream came from a client: tampering with it is impossible, it is frozen
    expect(() => { (env.classification![0] as { pos: number }).pos = 2; }).toThrow();
    await Promise.resolve();
    expect(h.sink.stored.get(env.raceId!)!.digest).toBe(env.digest);
    expect(await h.sink.consume(env)).toBe('duplicate');
    expect(h.sink.stored.size).toBe(1);
    // rematch
    expect(room.handle(ids[1], { t: 'rematch' }, h.now)).toMatchObject({ code: 'forbidden' });
    expect(room.handle(ids[0], { t: 'rematch' }, h.now)).toBe(null);
    expect(room.state).toBe('lobby');
    expect(room.publicRoom().participants.map((p) => p.id)).toEqual(ids);
    start(h, room, ids);
    expect(room.raceId).not.toBe(raceId);
    expect(room.results).toHaveLength(1);
  });

  it('a small timing backlog is caught up without losing race time; a backlog over the limit aborts with no result', () => {
    const h = harness({ overloadAbortMs: 3000, maxCatchUpSteps: 6 });
    const { room, peers, ids } = lobby(h, 2);
    start(h, room, ids);
    h.advance(1000, 10);
    h.set(h.now + 1500);                                   // the process stalled for 1.5 s
    h.mgr.tick();
    expect(room.lagMs).toBeGreaterThan(1000);
    h.advance(1000, 10);                                   // caught up: race time matches wall time again
    expect(room.lagMs).toBe(0);
    expect(room.race!.t).toBeCloseTo(3.5, 1);
    h.set(h.now + 4000);                                   // a stall beyond the limit
    h.mgr.tick();
    expect(room.state).toBe('results');
    expect(room.result).toMatchObject({ outcome: 'aborted', abortReason: 'overload', classification: null });
    expect(peers[0].of('result')).toHaveLength(1);
  });

  it('solo and championship rooms are one human plus explicit AI and not joinable; practice keeps laps and ends with laps only', () => {
    const h = harness();
    const p = new FakePeer();
    const s = h.mgr.create(p, { name: 'Solo', accountId: null, mode: 'solo', settings: { track: 'circuit-4' } });
    if (!s.ok) throw new Error();
    expect(h.mgr.join(new FakePeer(), '1', { code: s.room.code, name: 'x', accountId: null })).toMatchObject({ ok: false, code: 'not_found' });
    expect(s.room.publicRoom().ai.map((a) => a.slot)).toEqual([1, 2, 3]);
    expect(s.room.handle(s.participant, { t: 'settings', settings: { aiFill: false } }, h.now)).toMatchObject({ code: 'bad_settings' });
    s.room.handle(s.participant, { t: 'start' }, h.now);
    expect(s.room.race!.cars.map((c) => [c.idx, c.human])).toEqual(expect.arrayContaining([[0, true], [1, false], [2, false], [3, false]]));
    drive(h, s.room, [p], [s.participant]);
    expect(s.room.result).toMatchObject({ mode: 'solo', outcome: 'completed', championship: null });
    expect(s.room.result!.participants.filter((x) => x.control === 'ai')).toHaveLength(3);
    expect(s.room.result!.classification).toHaveLength(4);

    const cp = new FakePeer();
    const c = h.mgr.create(cp, { name: 'Champ', accountId: null, mode: 'championship', settings: { track: 'circuit-2' }, championship: { id: 'cup-1', round: 2 } });
    if (!c.ok) throw new Error();
    expect(c.room.publicRoom()).toMatchObject({ mode: 'championship', championship: { id: 'cup-1', round: 2 } });

    const pp = new FakePeer();
    const pr = h.mgr.create(pp, { name: 'Prac', accountId: null, mode: 'practice', settings: { track: 'circuit-1' } });
    if (!pr.ok) throw new Error();
    expect(pr.room.publicRoom().ai).toEqual([]);
    pr.room.handle(pr.participant, { t: 'start' }, h.now);
    expect(pr.room.race!.practice).toBe(true);
    drive(h, pr.room, [pp], [pr.participant], 70_000);
    pr.room.handle(pr.participant, { t: 'leave' }, h.now);
    const env = pr.room.results[0];
    expect(env).toMatchObject({ mode: 'practice', outcome: 'ended', classification: null });
    expect(env.laps.length).toBeGreaterThan(0);
    expect(env.laps.every((l) => typeof l.valid === 'boolean' && l.time > 0)).toBe(true);
    expect(pr.room.state).toBe('closed');
  });

  it('a practice session that runs into the race-time limit still ends laps-only, never as a completed DNF timeout', () => {
    const h = harness();
    const pp = new FakePeer();
    const pr = h.mgr.create(pp, { name: 'Prac', accountId: null, mode: 'practice', settings: { track: 'circuit-1' } });
    if (!pr.ok) throw new Error();
    pr.room.handle(pr.participant, { t: 'start' }, h.now);
    drive(h, pr.room, [pp], [pr.participant], 1_300_000);
    expect(pr.room.state).toBe('results');
    expect(pr.room.results).toHaveLength(1);
    const env = pr.room.result!;
    expect(env).toMatchObject({ mode: 'practice', outcome: 'ended', abortReason: null, classification: null });
    expect(env.times.raceTimeS).toBeGreaterThan(1200);
    expect(env.laps.length).toBeGreaterThan(0);
    expect(pp.of('result')).toHaveLength(1);
  }, 60_000);

  it('rooms on different circuits run side by side exactly as they run alone: track, RNG, controls and results stay separate', () => {
    const run = (tracks: string[]) => {
      const h = harness({}, 99);
      const rooms = tracks.map((t) => { const l = lobby(h, 2, { track: t, aiFill: true }); start(h, l.room, l.ids); return l; });
      const bots = rooms.map((l) => l.ids.map((id, k) => new BotClient(l.peers[k], id, 1 - k * 0.04)));
      h.advance(900_000, 50, () => rooms.forEach((l, i) => {
        if (l.room.state !== 'race') return;
        for (const b of bots[i]) { const o = b.controls(); if (!o) continue; l.room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now); if (o.pit) l.room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now); }
      }));
      return rooms.map((l) => { const e = l.room.result!; return JSON.stringify({ c: e.classification!.map((s) => [s.slot, s.status, s.time, s.laps]), l: e.laps.map((x) => [x.lap, x.time]), t: e.track }); });
    };
    const [a] = run(['circuit-2']);
    const [b] = run(['circuit-4']);
    const [a2, b2] = run(['circuit-2', 'circuit-4']);
    expect(a2).toBe(a);
    expect(b2).toBe(b);
    expect(a).not.toBe(b);
  });
});
