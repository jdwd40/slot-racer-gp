// Stopped-on-track recovery (#69) on the authoritative room server: the server's race core owns the count, the eligibility
// and the recovery; every client sees the same countdown in its snapshots and one recovery event; a reconnect during the
// countdown or after the recovery restores the server's state without replaying anything or granting time. Real
// RoomManager with a manual clock and in-memory peers (harness.ts), plus one run over real WebSockets with the browser's
// NetSession, which keeps no message history.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { Car, RaceSnapshot, WireEvent } from '../../src/race';
import type { Config } from '../../server/config';
import type { Room } from '../../server/room';
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

type Drop = 'none' | 'countdown' | 'recovery';
/**
 * n humans race bots to the flag; after 12 s, once seat 0 is on the open road, it lifts off and stays stopped (neutral, or
 * disconnected) until the server recovers it, waits 1 s in its bay, then drives on. `drop` disconnects seat 0 mid-countdown
 * (1.5 s into it) or just after the recovery, and resumes it 1 s later with its token on a new socket. The bots read their
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
    if (drop === 'countdown' && dropAt < 0 && phase === 'stop' && c0.stallT > 1.5) { dropAt = h.now; oldPeer = peers[0]; room.disconnect(ids[0], peers[0], h.now); }
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

  it('a reconnect during the countdown: the count carries on (no reset, no extra time), one recovery at the same moment as without the drop', () => {
    const base = scenario(2, 'none', {}, 'server');
    const s = scenario(2, 'countdown', {}, 'server');
    expect(s.dropAt).toBeGreaterThan(0); expect(s.resumedAt).toBeGreaterThan(s.dropAt);
    expect(s.rec).toHaveLength(1);
    expect(s.rec[0].raceTime).toBe(base.rec[0].raceTime);
    // the resumed socket's first state is the server's current one: mid-count, with no events replayed
    const first = s.peers[0].of('state')[0];
    expect(first.ev).toEqual([]);
    const cs = (first.snap as RaceSnapshot).cars.find((x) => x.id === s.ids[0])!;
    expect(cs.mode).toBe('race');
    expect(cs.stallT).toBeGreaterThan(1.5 + 0.9);
    // the old socket saw no recovery; the new one sees it once; the other client once
    expect(recovers(s.oldPeer!)).toEqual([]);
    expect(recovers(s.peers[0])).toHaveLength(1);
    expect(recovers(s.peers[1])).toHaveLength(1);
    // the same race, start to finish
    expect(core(s)).toBe(core(base));
    expect((s.peers[0].of('result')[0].envelope as { digest: string }).digest).toBe(s.room.result!.digest);
  });

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
});
