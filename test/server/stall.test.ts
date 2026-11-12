// Stopped-on-track recovery (#69) on the authoritative room server: the server's race core owns the count, the eligibility
// and the recovery; every client sees the same countdown in its snapshots and one recovery event; a reconnect after the
// recovery restores the server's state without replaying anything. A driver whose link is down (#74: disconnected, or no
// controls for LINK_AWAY_MS) is away: the car is held where it stopped, out of traffic, never recovered, until the seat
// resumes or the hold expires (then it retires as before). Real RoomManager with a manual clock and in-memory peers
// (harness.ts), plus runs over real WebSockets with the browser's NetSession, which keeps no message history.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { STALL, type Car, type RaceSnapshot, type WireEvent } from '../../src/race';
import type { Config } from '../../server/config';
import { LINK_AWAY_MS, type Room } from '../../server/room';
import type { ServerMsg } from '../../src/net/protocol';
import type { SocketCtor } from '../../src/net/client';
import { NetSession, type KV } from '../../src/net/session';
import { applySnapshot, mirrorRace } from '../../src/net/mirror';
import { stallLeft } from '../../src/hud';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { FakePeer, harness } from './harness';
import { drive } from './bot';

/** A peer that also records the wall time of every state it is sent. */
class TPeer extends FakePeer {
  stateAt: number[] = [];
  constructor(private clock: () => number) { super(); }
  send(d: string): void { super.send(d); if (this.msgs.at(-1)!.t === 'state') this.stateAt.push(this.clock()); }
}
const states = (p: FakePeer) => p.of('state');
const events = (p: FakePeer): WireEvent[] => states(p).flatMap((m) => m.ev as WireEvent[]);
const recovers = (p: FakePeer): WireEvent[] => events(p).filter((e) => e.type === 'recover');
function maxInWindow(at: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < at.length; i++) { while (at[i] - at[j] >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}

type Drop = 'none' | 'recovery';
/**
 * n humans race bots to the flag; after 12 s, once seat 0 is on the open road, it lifts off and stays stopped (neutral)
 * until the server recovers it, waits 1 s in its bay, then drives on. `drop` disconnects seat 0 just after the recovery,
 * and resumes it 1 s later with its token on a new socket. The bots read their
 * own client's snapshots (`src: 'peer'`, as a remote player does) or, to compare runs whose publication differs, the
 * server's race (`'server'`), so that every run gets exactly the same controls.
 */
function scenario(n: number, drop: Drop = 'none', over: Partial<Config> = {}, src: 'peer' | 'server' = 'peer') {
  const h = harness({ graceS: 20, ...over }, 4242);
  const clock = () => h.now;
  const peers: TPeer[] = [new TPeer(clock)];
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1' } });
  if (!c.ok) throw new Error(c.code);
  const room: Room = c.room;
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < n; k++) {
    const p = new TPeer(clock);
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: room.code, name: `P${k}`, accountId: null });
    if (!j.ok) throw new Error(j.code);
    peers.push(p); ids.push(j.participant); tokens.push(j.token);
  }
  for (const id of ids.slice(1)) expect(room.handle(id, { t: 'ready', ready: true }, h.now)).toBe(null);
  expect(room.handle(ids[0], { t: 'start' }, h.now)).toBe(null);
  const race = room.race!;
  // the server race's own record of when it recovered whom (simulation time), for comparing runs
  const rec: { id: string; raceTime: number }[] = [];
  const orig = race.stallRecover.bind(race);
  race.stallRecover = (car: Car) => { const ok = orig(car); if (ok) rec.push({ id: car.id, raceTime: race.raceTime }); return ok; };
  const seq = ids.map(() => ({ ctl: 0, act: 0 }));
  const me = () => race.car(ids[0])!;
  let phase: 'drive' | 'stop' | 'after' = 'drive';
  let stopTick = -1, dropAt = -1, resumedAt = -1, recWall = -1, oldPeer: TPeer | null = null;
  const seen: { stallT: number; mode: string; tick: number }[] = [];
  h.advance(900_000, 50, () => {
    if (room.state !== 'race') return;
    const c0 = me();
    if (phase === 'drive' && race.raceTime > 12 && c0.mode === 'race' && race.T.inRange(c0.u, 60, 140) && c0.status === 'running') { phase = 'stop'; stopTick = room.race!.t; }
    if (phase === 'stop' && rec.length) { phase = 'after'; recWall = h.now; }
    // the drop and the resume (a new socket, the private token)
    if (drop === 'recovery' && dropAt < 0 && phase === 'after') { dropAt = h.now; oldPeer = peers[0]; room.disconnect(ids[0], peers[0], h.now); }
    if (dropAt >= 0 && resumedAt < 0 && h.now - dropAt >= 1000) {
      const np = new TPeer(clock);
      const r = h.mgr.resume(np, '10.0.0.200', room.id, ids[0], tokens[0], null);
      expect(r).toMatchObject({ ok: true, participant: ids[0] });
      // what the socket layer (server/app.ts) sends a resumed seat at once: the current race state, with no events
      np.send(room.stateMsg(h.now)!);
      peers[0] = np; resumedAt = h.now;
    }
    if (phase === 'stop') { const s = peers[1].lastSnap()!; const cs = s.cars.find((x) => x.id === ids[0])!; seen.push({ stallT: cs.stallT ?? 0, mode: cs.mode, tick: s.t }); }
    ids.forEach((id, k) => {
      if (!room.participant(id)?.peer) return;
      const snap = src === 'server' ? race.snapshot() : peers[k].lastSnap(); if (!snap) return;
      const still = k === 0 && (phase === 'stop' || (phase === 'after' && h.now - recWall < 1000));
      const o = still ? { up: false, down: false, pit: false } : drive(snap, id, 1 - k * 0.03);
      room.handle(id, { t: 'ctl', seq: ++seq[k].ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) room.handle(id, { t: 'act', seq: ++seq[k].act, type: 'pit' }, h.now);
    });
  }, () => room.state !== 'race');
  expect(room.state).toBe('results');
  return { h, room, peers, ids, rec, seen, stopTick, dropAt, resumedAt, oldPeer };
}

const core = (s: ReturnType<typeof scenario>): string => {
  const env = s.room.result!;
  const norm = (x: string): string => s.ids.reduce((y, id, k) => y.split(id).join(`H${k}`), x);
  return norm(JSON.stringify({ c: env.classification, l: env.laps, t: env.times.raceTimeS, rec: s.rec.map((r) => [r.id, r.raceTime]) }));
};

describe('stopped-on-track recovery on the room server (#69)', () => {
  for (const n of [2, 4]) {
    it(`${n} clients: the server counts, every client sees the same countdown, one recovery event and the same classification`, () => {
      const s = scenario(n);
      const { room, peers, ids, rec, seen } = s;
      // the server recovered seat 0 once, after 3 s of its own simulation time, and nobody else
      expect(rec.map((r) => r.id)).toEqual([ids[0]]);
      // the countdown went out in the snapshots: rising, server time, up to the deadline, then the car is in its bay
      const counting = seen.filter((x) => x.mode === 'race' && x.stallT > 0);
      expect(counting.length).toBeGreaterThan(20);
      for (let i = 1; i < counting.length; i++) expect(counting[i].stallT).toBeGreaterThanOrEqual(counting[i - 1].stallT);
      expect(counting.at(-1)!.stallT).toBeGreaterThan(2.8);
      expect(counting.at(-1)!.stallT).toBeLessThan(3);
      expect(new Set(counting.map((x) => stallLeft({ stallT: x.stallT, mode: 'race', finished: false })))).toEqual(new Set([3, 2, 1]));
      // every client: the same bytes from the start of the race, one recovery event naming seat 0, one envelope
      const race = (q: FakePeer): string[] => q.raw.slice(q.msgs.findIndex((m) => m.t === 'state'));
      for (const p of peers) {
        expect(race(p)).toEqual(race(peers[0]));
        expect(recovers(p)).toEqual([{ type: 'recover', car: ids[0] }]);
        expect(p.of('result')).toHaveLength(1);
        expect((p.of('result')[0].envelope as { digest: string }).digest).toBe(room.result!.digest);
        // the state carrying the event already shows the car in its own bay, off the slot
        const st = states(p).find((m) => (m.ev as WireEvent[]).some((e) => e.type === 'recover'))!;
        const cs = (st.snap as RaceSnapshot).cars.find((x) => x.id === ids[0])!;
        expect(cs).toMatchObject({ mode: 'service', bayInUse: cs.bay, stallT: 0, stallHold: false, status: 'running' });
        // the personal message goes to everyone in the bytes, and only seat 0's view shows it (msg.to)
        expect(events(p).filter((e) => e.type === 'msg' && e.text === 'msg.stallRecovered').map((e) => (e as { to: string }).to)).toEqual([ids[0]]);
      }
      expect(room.result!.outcome).toBe('completed');
      expect(room.result!.classification!.map((x) => x.id).sort()).toEqual([...ids].sort());
      // the recovered driver went on to a result of its own (still in the race, not retired)
      expect(room.result!.classification!.find((x) => x.id === ids[0])!.status).not.toBe('dnf');
      // the snapshot-rate cap held throughout
      for (const p of peers) expect(maxInWindow(p.stateAt, 1000)).toBeLessThanOrEqual(s.h.cfg.snapshotHz + 2);
    });
  }

  it('a reconnect after the recovery: the car is still in its bay, nothing is replayed, and the race ends as without the drop', () => {
    const base = scenario(2, 'none', {}, 'server');
    const s = scenario(2, 'recovery', {}, 'server');
    expect(s.dropAt).toBeGreaterThan(0); expect(s.resumedAt).toBeGreaterThan(s.dropAt);
    const first = s.peers[0].of('state')[0];
    expect(first.ev).toEqual([]);
    const cs = (first.snap as RaceSnapshot).cars.find((x) => x.id === s.ids[0])!;
    expect(['service', 'bayOut', 'pitlane']).toContain(cs.mode);
    expect(cs.stallT).toBe(0);
    expect(recovers(s.oldPeer!)).toHaveLength(1);
    expect(recovers(s.peers[0])).toEqual([]);
    expect(s.rec).toHaveLength(1);
    expect(core(s)).toBe(core(base));
  });

  it('the publication rate never changes the recovery: 5 Hz and 60 Hz recover at the same simulation time with the same result, within each cap', () => {
    const slow = scenario(2, 'none', { snapshotHz: 5 }, 'server');
    const fast = scenario(2, 'none', { snapshotHz: 60 }, 'server');
    expect(slow.rec).toHaveLength(1);
    expect(slow.rec[0].raceTime).toBe(fast.rec[0].raceTime);
    expect(core(slow)).toBe(core(fast));
    for (const s of [slow, fast]) for (const p of s.peers) {
      expect(maxInWindow(p.stateAt, 1000)).toBeLessThanOrEqual(s.h.cfg.snapshotHz + 2);
      expect(recovers(p)).toHaveLength(1);
    }
  });
});

type Outage = 'close' | 'silent';
/**
 * Two humans race bots to the flag (#74). After 12 s, once seat 0 is on the open road, it lifts off; while it is still
 * rolling (under 2 m/s, before any stopped count) its link goes: `close` disconnects the socket (the reconnect hold), and
 * `silent` keeps the socket but sends no more controls (a half-open mobile link). `holdMs` later it comes back (a resume on
 * a new socket with its token, or simply controls again) and drives on; Infinity never comes back. Every tick records what
 * the server and the other client see of seat 0.
 */
function awayScenario(outage: Outage, holdMs: number, over: Partial<Config> = {}, src: 'peer' | 'server' = 'server') {
  const h = harness({ graceS: 20, ...over }, 4242);
  const clock = () => h.now;
  const peers: TPeer[] = [new TPeer(clock), new TPeer(clock)];
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1' } });
  if (!c.ok) throw new Error(c.code);
  const room: Room = c.room;
  const j = h.mgr.join(peers[1], '10.0.0.1', { code: room.code, name: 'P1', accountId: null });
  if (!j.ok) throw new Error(j.code);
  const ids = [c.participant, j.participant], tokens = [c.token, j.token];
  expect(room.handle(ids[1], { t: 'ready', ready: true }, h.now)).toBe(null);
  expect(room.handle(ids[0], { t: 'start' }, h.now)).toBe(null);
  const race = room.race!;
  const rec: { id: string; raceTime: number }[] = [];
  const orig = race.stallRecover.bind(race);
  race.stallRecover = (car: Car) => { const ok = orig(car); if (ok) rec.push({ id: car.id, raceTime: race.raceTime }); return ok; };
  const seq = ids.map(() => ({ ctl: 0, act: 0 }));
  const me = () => race.car(ids[0])!;
  type At = { u: number; crossed: number; lapsDone: number; lapValid: boolean; mode: string; raceTime: number };
  const at = (): At => { const x = me(); return { u: x.u, crossed: x.crossed, lapsDone: x.lapsDone, lapValid: x.lapValid, mode: x.mode, raceTime: race.raceTime }; };
  let phase: 'drive' | 'lift' | 'out' | 'back' = 'drive';
  let cut = null as At | null, back = null as At | null, cutAt = -1, backAt = -1;
  const during: { wall: number; away: boolean; snapAway: boolean; mirrorAway: boolean; stallT: number; u: number; v: number }[] = [];
  let maxStallBefore = 0;
  h.advance(900_000, 50, () => {
    if (room.state !== 'race') return;
    const c0 = me();
    if (phase === 'drive' && race.raceTime > 12 && c0.mode === 'race' && race.T.inRange(c0.u, 60, 140) && c0.status === 'running') phase = 'lift';
    if (phase === 'lift' && c0.v < 2 && c0.mode === 'race') {
      phase = 'out'; cut = at(); cutAt = h.now;
      if (outage === 'close') room.disconnect(ids[0], peers[0], h.now);
    }
    if (phase === 'out' && h.now - cutAt >= holdMs) {
      phase = 'back'; backAt = h.now;
      if (outage === 'close') {
        const np = new TPeer(clock);
        const r = h.mgr.resume(np, '10.0.0.200', room.id, ids[0], tokens[0], null);
        expect(r).toMatchObject({ ok: true, participant: ids[0] });
        np.send(room.stateMsg(h.now)!);
        peers[0] = np;
      }
      back = at();
    }
    if (phase === 'out') {
      const s = peers[1].lastSnap()!;
      during.push({
        wall: h.now - cutAt, away: room.isAway(ids[0], h.now), snapAway: s.cars.find((x) => x.id === ids[0])!.away === true,
        mirrorAway: c0.away, stallT: c0.stallT, u: c0.u, v: c0.v,
      });
    }
    if (phase === 'lift') maxStallBefore = Math.max(maxStallBefore, c0.stallT);
    ids.forEach((id, k) => {
      if (!room.participant(id)?.peer) return;
      if (k === 0 && phase === 'out') return;      // silent (or gone): no controls at all from seat 0
      const snap = src === 'server' ? race.snapshot() : peers[k].lastSnap(); if (!snap) return;
      const o = k === 0 && phase === 'lift' ? { up: false, down: false, pit: false } : drive(snap, id, 1 - k * 0.03);
      room.handle(id, { t: 'ctl', seq: ++seq[k].ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) room.handle(id, { t: 'act', seq: ++seq[k].act, type: 'pit' }, h.now);
    });
  }, () => room.state !== 'race');
  expect(room.state).toBe('results');
  expect(cut).not.toBe(null);
  return { h, room, peers, ids, rec, cut: cut!, back, cutAt, backAt, during, maxStallBefore };
}
const awayCore = (s: ReturnType<typeof awayScenario>): string => {
  const env = s.room.result!;
  const norm = (x: string): string => s.ids.reduce((y, id, k) => y.split(id).join(`H${k}`), x);
  return norm(JSON.stringify({ c: env.classification, l: env.laps, t: env.times.raceTimeS, rec: s.rec.map((r) => [r.id, r.raceTime]) }));
};

describe('a driver whose link is down is held, not recovered (#74)', () => {
  it('a clean disconnect for 8 s, then resume: no recovery, the same lap and lap validity, no distance lost, and it drives on', () => {
    const s = awayScenario('close', 8000);
    const { room, peers, ids, cut, back, during } = s;
    expect(s.rec).toEqual([]);
    for (const p of [peers[0], peers[1]]) expect(recovers(p)).toEqual([]);
    expect(events(peers[1]).filter((e) => e.type === 'msg' && e.text === 'msg.stallRecovered')).toEqual([]);
    // held where it stopped for the whole outage: away from the first tick, drawn held for the other client, never counting
    expect(during.length).toBeGreaterThan(150);
    expect(during.every((x) => x.away)).toBe(true);
    // (the race core reads it from the next step on: the first sample is taken before the tick that follows the drop)
    expect(during.slice(1).every((x) => x.stallT === 0)).toBe(true);
    // it stays in traffic while it rolls, and is held out of traffic from the moment it has stopped, for the rest of the outage
    const heldFrom = during.findIndex((x) => x.mirrorAway);
    expect(heldFrom).toBeGreaterThan(0);
    expect(during.slice(0, heldFrom).every((x) => x.v >= STALL.stopV - 0.2)).toBe(true);
    expect(during.slice(heldFrom).every((x) => x.mirrorAway && Math.abs(x.v) < STALL.stopV)).toBe(true);
    expect(during.slice(heldFrom + 2).every((x) => x.snapAway)).toBe(true);
    // the race core did not move it back: it only rolled to a stop, forward, on the same lap
    expect(back!.mode).toBe('race');
    expect(back!.u).toBeGreaterThanOrEqual(cut.u);
    expect(back!.u - cut.u).toBeLessThan(3);
    expect([back!.crossed, back!.lapsDone, back!.lapValid]).toEqual([cut.crossed, cut.lapsDone, cut.lapValid]);
    expect(back!.raceTime - cut.raceTime).toBeGreaterThan(7.9);
    // the resume ends it at once (the seat has a peer and a fresh control clock), and the driver races to a result
    expect(room.isAway(ids[0], s.backAt)).toBe(false);
    expect(room.result!.outcome).toBe('completed');
    expect(room.result!.classification!.find((x) => x.id === ids[0])!.status).not.toBe('dnf');
    for (const p of peers) expect(maxInWindow(p.stateAt, 1000)).toBeLessThanOrEqual(s.h.cfg.snapshotHz + 2);
  });

  it(`a half-open link (socket still there, no controls for more than LINK_AWAY_MS = ${LINK_AWAY_MS} ms) is away; controls again end it`, () => {
    expect(LINK_AWAY_MS).toBe(1500);
    expect(LINK_AWAY_MS).toBeGreaterThan(testConfig().inputTimeoutMs);
    const s = awayScenario('silent', 6000);
    const { room, ids, during, cut, back } = s;
    // the threshold, on the server's own clock: still present at LINK_AWAY_MS, away just after it
    const first = during.findIndex((x) => x.away);
    expect(during[first].wall).toBeGreaterThan(LINK_AWAY_MS - 50);
    expect(during[first].wall).toBeLessThanOrEqual(LINK_AWAY_MS + 50);
    expect(during.slice(0, first).every((x) => !x.away)).toBe(true);
    expect(during.slice(first).every((x) => x.away && x.stallT === 0)).toBe(true);
    // both clients see it held (the socket never closed, so seat 0 itself still gets every state)
    expect(during.slice(first + 2).every((x) => x.snapAway)).toBe(true);
    const snap0 = s.peers[0].of('state').map((m) => (m.snap as RaceSnapshot).cars.find((x) => x.id === ids[0])!.away === true);
    expect(snap0.some(Boolean)).toBe(true);
    // a stopped count that had started before the link was judged lost is reset by it, and nothing is ever recovered
    expect(Math.max(...during.slice(0, first).map((x) => x.stallT))).toBeGreaterThan(0);
    expect(s.rec).toEqual([]);
    expect(recovers(s.peers[1])).toEqual([]);
    expect(back!.mode).toBe('race');
    expect(back!.u).toBeGreaterThanOrEqual(cut.u);
    expect([back!.crossed, back!.lapValid]).toEqual([cut.crossed, cut.lapValid]);
    // the first control after the silence ends it at once
    expect(room.isAway(ids[0], s.backAt)).toBe(false);
    expect(room.result!.classification!.find((x) => x.id === ids[0])!.status).not.toBe('dnf');
  });

  it('a disconnect longer than graceS: held for the grace period, then retired (DNF retired) and parked out of collisions, as before', () => {
    const s = awayScenario('close', Infinity);
    const { room, ids, during } = s;
    const graceMs = s.h.cfg.graceS * 1000;
    expect(s.rec).toEqual([]);
    expect(recovers(s.peers[1])).toEqual([]);
    // held until the grace ran out, then the seat was dropped: retired from that moment on
    const held = during.filter((x) => x.wall <= graceMs);
    expect(held.every((x) => x.away)).toBe(true);
    expect(held.slice(1).every((x) => x.stallT === 0)).toBe(true);
    const heldFrom = held.findIndex((x) => x.mirrorAway);
    expect(heldFrom).toBeGreaterThan(0);
    expect(held.slice(heldFrom).every((x) => x.mirrorAway)).toBe(true);
    const r = room.race!;
    const car = r.car(ids[0])!;
    expect(car).toMatchObject({ status: 'dnf', dnfReason: 'retired', retire: 'parked', mode: 'off', away: false });
    expect(room.result!.classification!.find((x) => x.id === ids[0])).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
    // the retired car went straight to its bay (it was standing): the other driver never touched it
    expect(events(s.peers[1]).filter((e) => (e.type === 'bump' || e.type === 'offence') && ((e as { car?: string }).car === ids[0] || (e as { other?: string }).other === ids[0]))).toEqual([]);
    const after = during.filter((x) => x.wall > graceMs + 100);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => !x.away)).toBe(true);
  });

  it('a half-open link silent for longer than graceS ends like a closed one: the socket is closed, the car retired (DNF) and parked', () => {
    const s = awayScenario('silent', Infinity);
    const { room, ids, during } = s;
    const graceMs = s.h.cfg.graceS * 1000;
    expect(s.rec).toEqual([]);
    expect(s.peers[0].closed).toEqual({ code: 4000, reason: 'no controls' });
    const r = room.race!;
    expect(r.car(ids[0])!).toMatchObject({ status: 'dnf', dnfReason: 'retired', retire: 'parked', mode: 'off', away: false });
    expect(room.result!.classification!.find((x) => x.id === ids[0])).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
    // held as away until the window ran out, then gone; the seat cannot be resumed
    expect(during.filter((x) => x.wall > LINK_AWAY_MS + 100 && x.wall <= graceMs - 100).every((x) => x.away)).toBe(true);
    expect(during.filter((x) => x.wall > graceMs + 100).every((x) => !x.away)).toBe(true);
    expect(s.h.mgr.resume(new FakePeer(), '9', room.id, ids[0], 'x', null)).toMatchObject({ ok: false, code: 'expired' });
    expect(s.h.log.lines.some((l) => l.includes('room.grace_expired') && l.includes('"silent":true'))).toBe(true);
  });

  it('the half-open window boundary, on the server clock: kept at exactly graceS of silence, retired 1 tick later; a latched breach is a DQ', () => {
    for (const breach of [false, true]) {
      const h = harness({ graceS: 20 }, 4242);
      const p0 = new FakePeer(), p1 = new FakePeer();
      const c = h.mgr.create(p0, { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1' } });
      if (!c.ok) throw new Error(c.code);
      const j = h.mgr.join(p1, '10.0.0.1', { code: c.room.code, name: 'P1', accountId: null });
      if (!j.ok) throw new Error(j.code);
      const room = c.room, ids = [c.participant, j.participant];
      room.handle(ids[1], { t: 'ready', ready: true }, h.now); room.handle(ids[0], { t: 'start' }, h.now);
      let n = 0;
      const beat = (who: string[]) => () => { n++; for (const id of who) room.handle(id, { t: 'ctl', seq: n, up: false, down: false }, h.now); };
      h.advance(2000, 50, beat(ids));
      if (breach) room.race!.car(ids[0])!.svcBreach = 'fuel';
      beat(ids)();
      const lastCtl = h.now;
      h.advance(h.cfg.graceS * 1000, 50, beat([ids[1]]));
      expect(h.now - lastCtl).toBe(h.cfg.graceS * 1000);
      expect(room.participant(ids[0])).toMatchObject({ left: false });
      expect(p0.closed).toBe(null);
      expect(room.isAway(ids[0])).toBe(true);
      h.advance(50, 50, beat([ids[1]]));
      expect(room.participant(ids[0])).toMatchObject({ left: true, peer: null });
      expect(p0.closed).toMatchObject({ code: 4000 });
      expect(room.race!.car(ids[0])!).toMatchObject(breach ? { status: 'dq', dqReason: 'deadline' } : { status: 'dnf', dnfReason: 'retired' });
      // the connected seat that keeps sending is untouched
      expect(room.participant(ids[1])).toMatchObject({ left: false });
      expect(room.race!.car(ids[1])!.status).toBe('running');
    }
  });

  it('a server stall is not a client silence: a pump 3 s late marks no live seat away, while one already silent before it still is', () => {
    const h = harness({ graceS: 20 }, 4242);
    const peers = [new FakePeer(), new FakePeer(), new FakePeer()];
    const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1' } });
    if (!c.ok) throw new Error(c.code);
    const ids = [c.participant];
    for (const k of [1, 2]) { const j = h.mgr.join(peers[k], `10.0.0.${k}`, { code: c.room.code, name: `P${k}`, accountId: null }); if (!j.ok) throw new Error(j.code); ids.push(j.participant); }
    const room = c.room;
    for (const id of ids.slice(1)) room.handle(id, { t: 'ready', ready: true }, h.now);
    room.handle(ids[0], { t: 'start' }, h.now);
    let n = 0;
    const beat = (who: string[]) => () => { n++; for (const id of who) room.handle(id, { t: 'ctl', seq: n, up: false, down: false }, h.now); };
    h.advance(6000, 50, beat(ids));
    // seat 2 goes quiet 1.4 s before the stall: late, but not yet away
    h.advance(1400, 50, beat([ids[0], ids[1]]));
    expect(ids.map((id) => room.isAway(id))).toEqual([false, false, false]);
    // the server's event loop stalls for 3 s: the next pump comes late, before any queued controls are read
    h.set(h.now + 3000);
    h.mgr.tick();
    expect(room.isAway(ids[0])).toBe(false);
    expect(room.isAway(ids[1])).toBe(false);
    expect(room.isAway(ids[2])).toBe(true);    // its own 1.4 s of silence plus the allowed pump gap: over LINK_AWAY_MS
    // the same 3 s of real client silence with the server running normally is away
    h.advance(3000, 50, beat([ids[1]]));
    expect(room.isAway(ids[0])).toBe(true);
    expect(room.isAway(ids[1])).toBe(false);
  });

  it('the publication rate never changes it: 5 Hz and 60 Hz hold the same car the same way, with the same race and result', () => {
    const slow = awayScenario('close', 8000, { snapshotHz: 5 });
    const fast = awayScenario('close', 8000, { snapshotHz: 60 });
    for (const s of [slow, fast]) {
      expect(s.rec).toEqual([]);
      for (const p of s.peers) { expect(recovers(p)).toEqual([]); expect(maxInWindow(p.stateAt, 1000)).toBeLessThanOrEqual(s.h.cfg.snapshotHz + 2); }
    }
    expect(slow.back).toEqual(fast.back);
    expect(slow.cut).toEqual(fast.cut);
    expect(awayCore(slow)).toBe(awayCore(fast));
  });
});

// ------------------------------------------------------------------------------------------------ real sockets
const SCALE = 12;
const ORIGIN = 'http://localhost:5173';
const cfg = testConfig({ port: 0, timeScale: SCALE, maxCatchUpSteps: 6 * SCALE, snapshotHz: 10, graceS: 5, msgRate: 200, msgBurst: 300, maxConnectionsPerIp: 40 });
const mgr = new RoomManager({ cfg, log: memoryLogger(), sink: new MemoryResultSink() });
let app: App;
let url = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 30000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } };
class MemKV implements KV { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

beforeAll(async () => {
  app = createApp({ cfg, log: memoryLogger(), manager: mgr });
  const { port } = await app.listen();
  url = `ws://127.0.0.1:${port}/ws`;
  mgr.start();
});
afterAll(async () => { mgr.shutdown(); await app.close(); });

describe('over real WebSockets with the browser session', () => {
  it('two browsers: one stops, both mirrors show the countdown and one recovery, and the session keeps no message history', async () => {
    type P = { s: NetSession; mirror: ReturnType<typeof mirrorRace> | null; rec: WireEvent[]; left: Set<number>; stop: boolean; lastTick: number };
    const mk = (pace: number): P => {
      const p: P = { s: null as unknown as NetSession, mirror: null, rec: [], left: new Set(), stop: false, lastTick: -1 };
      p.s = new NetSession(url, WebSocket as unknown as SocketCtor, {
        state: (m: Extract<ServerMsg, { t: 'state' }>) => {
          const snap = m.snap as RaceSnapshot;
          if (m.tick <= p.lastTick) return;
          p.lastTick = m.tick;
          if (!p.mirror) p.mirror = mirrorRace(snap); else applySnapshot(p.mirror, snap);
          p.rec.push(...(m.ev as WireEvent[]).filter((e) => e.type === 'recover'));
          if (!p.s.me) return;
          const mine = p.mirror.car(p.s.me)!;
          if (p.stop) { p.left.add(stallLeft(mine)); p.s.setHeld(false, false); return; }
          const o = drive(snap, p.s.me, pace);
          p.s.setHeld(o.up, o.down);
          if (o.pit) p.s.action('pit');
        },
        result: () => {}, end: () => {}, conn: () => {},
      }, new MemKV(), { headers: { origin: ORIGIN } });
      return p;
    };
    const a = mk(1), b = mk(0.97);
    expect(await a.s.create('A', 'multiplayer', { track: 'circuit-1', aiFill: false })).toEqual({ ok: true });
    expect(await b.s.join(a.s.room!.code, 'B')).toEqual({ ok: true });
    b.s.ready(true);
    await until(() => a.s.room!.participants.every((x) => x.host || x.ready));
    a.s.start();
    await until(() => a.s.inRace && b.s.inRace);
    await until(() => (a.mirror?.raceTime ?? 0) > 10);
    a.stop = true;
    await until(() => a.rec.length > 0 && b.rec.length > 0);
    // both mirrors read the same recovery once; the stopped driver's mirror counted 3, 2, 1 from the server's snapshots
    expect(a.rec).toEqual([{ type: 'recover', car: a.s.me }]);
    expect(b.rec).toEqual([{ type: 'recover', car: a.s.me }]);
    expect([...a.left].filter((x) => x > 0).sort()).toEqual([1, 2, 3]);
    await until(() => a.mirror!.car(a.s.me!)!.mode === 'service');
    expect(b.mirror!.car(a.s.me!)!.mode).toMatch(/service|bayOut|pitlane/);
    // the browser path never records messages: bounded memory whatever the race length (#50)
    for (const p of [a, b]) { expect(p.s.client.received).toHaveLength(0); expect(p.s.client.rx.dropped).toBe(0); expect(p.s.client.rx.total).toBeGreaterThan(50); }
    a.s.leave(); b.s.leave();
  }, 60000);
  it('two browsers: one loses its network on the road, both mirrors show its car held (away) and nothing is recovered; it resumes where it stopped', async () => {
    // a network cut for one browser: while `cut` is set its session's sockets go to a port nobody listens on, so its
    // reconnect attempts fail (and back off) exactly as with no network; clearing it lets the next attempt through
    let cut = false;
    const dead = 'ws://127.0.0.1:9/ws';
    class CutSocket extends WebSocket { constructor(u: string, p?: string | string[], o?: object) { super(cut ? dead : u, p, o as never); } }
    /** the car both browsers record, every state: what their mirror shows of it */
    let watch: string | null = null;
    type P = { s: NetSession; mirror: ReturnType<typeof mirrorRace> | null; rec: WireEvent[]; aw: { tick: number; away: boolean; mode: string; u: number }[]; lift: boolean; lastTick: number };
    const mk = (pace: number, Ctor: SocketCtor): P => {
      const p: P = { s: null as unknown as NetSession, mirror: null, rec: [], aw: [], lift: false, lastTick: -1 };
      p.s = new NetSession(url, Ctor, {
        state: (m: Extract<ServerMsg, { t: 'state' }>) => {
          const snap = m.snap as RaceSnapshot;
          if (m.tick <= p.lastTick) return;
          p.lastTick = m.tick;
          if (!p.mirror) p.mirror = mirrorRace(snap); else applySnapshot(p.mirror, snap);
          p.rec.push(...(m.ev as WireEvent[]).filter((e) => e.type === 'recover'));
          const w = watch ? p.mirror.car(watch) : null;
          if (w) p.aw.push({ tick: m.tick, away: w.away, mode: w.mode, u: w.u });
          if (!p.s.me) return;
          if (p.lift) { p.s.setHeld(false, false); return; }
          const o = drive(snap, p.s.me, pace);
          p.s.setHeld(o.up, o.down);
          if (o.pit) p.s.action('pit');
        },
        result: () => {}, end: () => {}, conn: () => {},
      }, new MemKV(), { headers: { origin: ORIGIN } });
      return p;
    };
    const a = mk(1, CutSocket as unknown as SocketCtor), b = mk(0.97, WebSocket as unknown as SocketCtor);
    expect(await a.s.create('A', 'multiplayer', { track: 'circuit-1', aiFill: false })).toEqual({ ok: true });
    expect(await b.s.join(a.s.room!.code, 'B')).toEqual({ ok: true });
    b.s.ready(true);
    await until(() => a.s.room!.participants.every((x) => x.host || x.ready));
    a.s.start();
    await until(() => a.s.inRace && b.s.inRace);
    const aid = a.s.me!;
    watch = aid;
    await until(() => (a.mirror?.raceTime ?? 0) > 10 && a.mirror!.car(aid)!.mode === 'race' && a.mirror!.T.inRange(a.mirror!.car(aid)!.u, 60, 140));
    // A lifts, then while it is still rolling its network goes and its socket is torn down (the page's watchdog path)
    a.lift = true;
    await until(() => a.mirror!.car(aid)!.v < 2);
    const cutU = a.mirror!.car(aid)!.u;
    cut = true;
    a.s.reconnectNow();
    expect(a.s.conn).toBe('reconnecting');
    // out for 1.5 s of wall time: 18 s of race time at this server's time scale, six times the 3 s rule
    await sleep(1500);
    const bHeld = b.aw.filter((x) => x.away);
    expect(bHeld.length).toBeGreaterThan(5);
    expect(bHeld.every((x) => x.mode === 'race')).toBe(true);
    expect(Math.max(...bHeld.map((x) => x.u)) - Math.min(...bHeld.map((x) => x.u))).toBeLessThan(3);
    expect(b.rec).toEqual([]);
    // the network comes back: the next attempt resumes the seat, and A's first state shows its car still held where it stopped
    const seen = a.aw.length;
    cut = false;
    await until(() => a.s.conn === 'connected' && a.aw.length > seen);
    const firstBack = a.aw[seen];
    expect(firstBack.away).toBe(true);
    expect(firstBack.mode).toBe('race');
    expect(firstBack.u).toBeGreaterThanOrEqual(cutU);
    // it drives on: the hold ends on both mirrors, and nobody ever saw a recovery
    a.lift = false;
    await until(() => !a.mirror!.car(aid)!.away && !b.mirror!.car(aid)!.away && a.mirror!.car(aid)!.u > firstBack.u + 10);
    expect(a.rec).toEqual([]);
    expect(b.rec).toEqual([]);
    expect(a.mirror!.car(aid)!).toMatchObject({ mode: 'race', status: 'running' });
    a.s.leave(); b.s.leave();
  }, 60000);
});
