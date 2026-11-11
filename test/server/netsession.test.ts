// The browser's online modules against the real server: NetSession (connection, seat, reconnect, results) and the snapshot
// mirror/interpolation the race screen draws from. Race time runs SCALE x faster (SLOTRUSH_TIME_SCALE, refused in production).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { Race, type RaceSnapshot } from '../../src/race';
import type { SocketCtor } from '../../src/net/client';
import { NetSession, loadSeat, type KV, type ResultView, type EndReason } from '../../src/net/session';
import { SnapBuffer, applySnapshot, localEvent, mirrorRace } from '../../src/net/mirror';
import { SnapDecoder, SnapEncoder, type WireStateMsg } from '../../src/net/snapwire';
import { STEP } from '../../src/timing';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { drive } from './bot';

const SCALE = 12;
const ORIGIN = 'http://localhost:5173';
const cfg = testConfig({ port: 0, timeScale: SCALE, maxCatchUpSteps: 6 * SCALE, snapshotHz: 10, graceS: 5, msgRate: 200, msgBurst: 300, maxConnectionsPerIp: 40 });
const log = memoryLogger();
const sink = new MemoryResultSink();
const mgr = new RoomManager({ cfg, log, sink });
let app: App;
let url = '';
const Ctor = WebSocket as unknown as SocketCtor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = createApp({ cfg, log, manager: mgr });
  const { port } = await app.listen();
  url = `ws://127.0.0.1:${port}/ws`;
  mgr.start();
});
afterAll(async () => { mgr.shutdown(); await app.close(); });

class MemKV implements KV { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

/** A headless "browser": a NetSession, its mirror race and a bot that drives from the mirror through setHeld/action only. */
function player(kv = new MemKV(), pace = 1) {
  const p = {
    kv, race: null as Race | null, results: [] as { r: ResultView; fresh: boolean }[], ends: [] as EndReason[], conns: [] as string[],
    snaps: 0, lastTick: -1, driving: true,
    s: null as unknown as NetSession,
  };
  p.s = new NetSession(url, Ctor, {
    state: (m) => {
      const snap = m.snap as RaceSnapshot;
      if (m.tick <= p.lastTick) return;
      p.lastTick = m.tick; p.snaps++;
      if (!p.race || p.race.cars.length !== snap.cars.length || snap.raceTime < p.race.raceTime) p.race = mirrorRace(snap); else applySnapshot(p.race, snap);
      for (const e of m.ev as never[]) expect(localEvent(p.race, e)).not.toBeNull();
      if (!p.driving || !p.s.me) return;
      const o = drive(snap, p.s.me, pace);
      p.s.setHeld(o.up, o.down);
      if (o.pit) p.s.action('pit');
    },
    result: (r, fresh) => p.results.push({ r, fresh }),
    end: (why) => p.ends.push(why),
    conn: (c) => p.conns.push(c),
  }, kv, { headers: { origin: ORIGIN } });
  return p;
}
const until = async (f: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } };

describe('snapshot mirror', () => {
  it('a mirror fed only snapshots answers the HUD questions exactly as the server race does', () => {
    const roster = [{ id: 'a', control: 'human' as const, slot: 2 }, { id: 'b', control: 'human' as const, slot: 0 }, { id: 'ai_1', control: 'ai' as const, slot: 1 }];
    const srv = new Race({ roster, track: 'circuit-2', seed: 5, runOn: 'live' });
    let mirror: Race | null = null;
    let checked = 0;
    // over the v2 wire (#67): keyframes and deltas, rounded as declared, decoded as the browser does
    const enc = new SnapEncoder('race'), dec = new SnapDecoder();
    for (let i = 0; i < 60 * 120; i++) {
      const s = srv.snapshot();
      const ia = drive(s, 'a', 1), ib = drive(s, 'b', 0.95);
      if (ia.pit) srv.act({ driver: 'a', seq: i + 1, type: 'pit' });
      if (i === 60 * 30) srv.act({ driver: 'b', seq: 1, type: 'lane' });
      srv.update(STEP, { a: ia, b: ib });
      srv.events.length = 0;
      if (i % 3) continue;
      const wire = JSON.parse(JSON.stringify({ tick: i, ...enc.next(srv.snapshot(), i, i * STEP * 1000) })) as WireStateMsg;   // exactly what goes over the wire
      const snap = dec.decode(wire)!;
      if (!mirror) mirror = mirrorRace(snap); else applySnapshot(mirror, snap);
      for (const c of srv.cars) {
        const m = mirror.car(c.id)!;
        expect([m.idx, m.num, m.bayHome, m.human]).toEqual([c.idx, c.num, c.bayHome, c.human]);
        expect(mirror.apprLap(m)).toBe(srv.apprLap(c));
        expect(mirror.deferBlock(m)).toBe(srv.deferBlock(c));
        expect(mirror.nextRoute(m)).toEqual(srv.nextRoute(c));
        expect(mirror.dueState(m, m.sgDue)).toBe(srv.dueState(c, c.sgDue));
        expect(mirror.departBlock(m)).toBe(srv.departBlock(c));
        expect(mirror.boxBusy(m)).toBe(srv.boxBusy(c));
        expect(mirror.bayNo(m)).toBe(srv.bayNo(c));
        checked++;
      }
      expect(mirror.order().map((c) => c.id)).toEqual(srv.order().map((c) => c.id));
      expect([mirror.phase, mirror.lights]).toEqual([srv.phase, srv.lights]);
      expect(Math.abs(mirror.raceTime - srv.raceTime)).toBeLessThanOrEqual(0.0005 + 1e-9);   // 1 ms on the wire
    }
    expect(checked).toBeGreaterThan(5000);
    // applying the same snapshot again changes nothing (a correction never replays a lap or a stop)
    const snap = srv.snapshot();
    applySnapshot(mirror!, snap);
    const before = JSON.stringify(mirror!.cars.map((c) => [c.lapsDone, c.pitStops, c.sgServed, c.offences, c.crossed]));
    applySnapshot(mirror!, snap);
    expect(JSON.stringify(mirror!.cars.map((c) => [c.lapsDone, c.pitStops, c.sgServed, c.offences, c.crossed]))).toBe(before);
  });

  it('interpolates between bracketing snapshots, refuses stale ones, holds (never extrapolates) when starved and stays bounded', () => {
    const r = new Race({ track: 'circuit-1', seed: 1 });
    const snapAt = (x: number): RaceSnapshot => { const s = r.snapshot(); s.cars[0].x = x / 10; return s; };
    const b = new SnapBuffer(100, 8);
    const ms = STEP * 1000;
    // snapshots every 3 ticks (20 Hz), arriving 30 ms after their server time
    for (let k = 0; k < 6; k++) b.push(k * 3, k * 3 * ms + 30, snapAt(k * 3));
    expect(b.push(9, 999, snapAt(0))).toBe(false);   // same tick again
    expect(b.stats.stale).toBe(1);
    // render 100 ms behind: at local 230 ms the server time drawn is 100 ms = tick 6
    const mid = b.sample(230)!.get('solo')!;
    expect(mid.x).toBeCloseTo(0.6, 5);
    const between = b.sample(230 + ms * 1.5)!.get('solo')!;
    expect(between.x).toBeCloseTo(0.75, 5);
    const starved = b.sample(5000)!.get('solo')!;
    expect(starved.x).toBeCloseTo(1.5, 5);
    expect(b.stats.starved).toBe(1);
    for (let k = 6; k < 200; k++) b.push(k * 3, k * 3 * ms + 30, snapAt(k * 3));
    expect(b.stats.depth).toBeLessThanOrEqual(8);
    // a 2 s stall followed by a burst: the clock re-anchors instead of drawing seconds behind
    b.push(200 * 3, 200 * 3 * ms + 2030, snapAt(600));
    expect(b.stats.reanchors).toBe(1);
    expect(b.stats.maxGapMs).toBeGreaterThan(1900);
  });

  it('at the run-on cadence (20 states/s, 40 steps apart) cars are drawn at the newest state: never starved, held or re-anchored (#49)', () => {
    const r = new Race({ track: 'circuit-1', seed: 1 });
    const snapAt = (x: number): RaceSnapshot => { const s = r.snapshot(); s.cars[0].x = x; return s; };
    const b = new SnapBuffer(100, 24);
    // the server steps 8x wall time but publishes on wall time: each state is 667 ms of race (about 16 track units at 0.4
    // per step, beyond the 2-unit snap distance) after the last, 50 ms of local time later
    for (let k = 0; k < 40; k++) {
      const at = k * 50 + 30;
      b.push(k * 40, at, snapAt(k * 40 * 0.4));
      for (const d of [0, 16, 33, 49]) expect(b.sample(at + d)!.get('solo')!.x).toBeCloseTo(k * 40 * 0.4, 5);
    }
    expect(b.stats).toMatchObject({ received: 40, stale: 0, starved: 0, reanchors: 0 });
    expect(b.stats.maxGapMs).toBe(50);
  });
});

describe('NetSession against the real server', () => {
  it('four browsers race in one room; a fifth is refused; every client gets the same standings once', async () => {
    const ps = [player(), player(new MemKV(), 0.97), player(new MemKV(), 0.94), player(new MemKV(), 0.91)];
    expect(await ps[0].s.create('Host <b>', 'multiplayer', { track: 'circuit-1', aiFill: false }, 'red')).toEqual({ ok: true });
    const code = ps[0].s.room!.code;
    for (const p of ps.slice(1)) expect(await p.s.join(code.toLowerCase(), 'Guest', 'red')).toEqual({ ok: true });
    const fifth = player();
    expect(await fifth.s.join(code, 'Five')).toMatchObject({ ok: false, code: 'full' });
    expect(fifth.s.conn).toBe('offline');
    await until(() => ps[0].s.room!.participants.length === 4);
    // the requested livery was taken: shown as given + requested, never silently changed
    const parts = ps[0].s.room!.participants;
    expect(new Set(parts.map((x) => x.livery)).size).toBe(4);
    expect(parts.filter((x) => x.liveryRequested === 'red')).toHaveLength(3);
    // only the host starts; it needs everyone ready
    ps[1].s.start();
    await until(() => ps[1].s.room !== null);
    ps[0].s.start();
    await sleep(100);
    expect(ps[0].s.room!.state).toBe('lobby');
    for (const p of ps.slice(1)) p.s.ready(true);
    await until(() => ps[0].s.room!.participants.every((x) => x.host || x.ready));
    ps[0].s.start();
    await until(() => ps.every((p) => p.s.inRace));
    // nonzero local driver slots, each its own distinct car
    const mine = ps.map((p) => ps[0].s.room!.participants.find((x) => x.id === p.s.me)!.slot);
    expect(new Set(mine).size).toBe(4);
    expect(mine.some((x) => x > 0)).toBe(true);
    // the roster is locked: a late join is refused as started
    const late = player();
    expect(await late.s.join(code, 'Late')).toMatchObject({ ok: false, code: 'started' });
    await until(() => ps.every((p) => p.results.length > 0), 60000);
    const digests = new Set(ps.map((p) => p.results[0].r.digest));
    expect(digests.size).toBe(1);
    const r0 = ps[0].results[0].r;
    expect(r0.outcome).toBe('completed');
    expect(r0.classification!.map((x) => x.id).sort()).toEqual(ps.map((p) => p.s.me).sort());
    expect(ps.every((p) => p.results[0].fresh)).toBe(true);
    // the mirror's final standings are the envelope's, for every client
    for (const p of ps) expect(p.race!.final!.map((x) => [x.id, x.pos, x.status])).toEqual(r0.classification!.map((x) => [x.id, x.pos, x.status]));
    for (const p of ps) p.s.leave();
  }, 90000);

  it('2- and 3-browser rooms race at the same time; each room\'s clients agree on their own standings', async () => {
    const rooms = [[player(), player(new MemKV(), 0.95)], [player(), player(new MemKV(), 0.96), player(new MemKV(), 0.92)]];
    for (const [k, ps] of rooms.entries()) {
      await ps[0].s.create(`Host${k}`, 'multiplayer', { track: k ? 'circuit-3' : 'circuit-5' });
      for (const p of ps.slice(1)) { await p.s.join(ps[0].s.room!.code, 'G'); p.s.ready(true); }
      await until(() => ps[0].s.room!.participants.every((x) => x.host || x.ready));
      ps[0].s.start();
    }
    await until(() => rooms.flat().every((p) => p.results.length > 0), 60000);
    for (const ps of rooms) {
      expect(new Set(ps.map((p) => p.results[0].r.digest)).size).toBe(1);
      expect(ps[0].results[0].r.classification).toHaveLength(ps.length);
      expect(ps.map((p) => p.s.me).every((id) => ps[0].results[0].r.classification!.some((x) => x.id === id))).toBe(true);
    }
    expect(rooms[0][0].results[0].r.raceId).not.toBe(rooms[1][0].results[0].r.raceId);
    for (const p of rooms.flat()) p.s.leave();
  }, 90000);

  it('reconnect before expiry restores the same car and progress; after expiry the seat is gone and cannot be re-joined', async () => {
    const a = player(), b = player();
    await a.s.create('A', 'multiplayer', { track: 'circuit-1' });
    await b.s.join(a.s.room!.code, 'B');
    b.s.ready(true);
    await until(() => a.s.room!.participants.every((x) => x.host || x.ready));
    a.s.start();
    await until(() => !!b.race && b.race.car(b.s.me!)!.lapsDone >= 1, 30000);
    const id = b.s.me!;
    const seat = loadSeat(b.kv)!;
    expect(seat.participant).toBe(id);
    // drop the socket without a goodbye (a network loss): the session resumes the same seat by itself
    const lapsBefore = b.race!.car(id)!.lapsDone;
    b.s.client.ws!.close(4000, 'test drop');
    await until(() => b.conns.includes('reconnecting'));
    await until(() => b.s.conn === 'connected');
    expect(b.s.me).toBe(id);
    expect(b.s.reconnects).toBeGreaterThan(0);
    await until(() => b.lastTick > 0 && b.race!.car(id)!.lapsDone >= lapsBefore);
    expect(b.race!.car(id)!.status).toBe('running');
    // a page reload in the same tab: a new session resumes from the stored seat
    b.s.close();
    const b2 = player(b.kv);
    expect(await b2.s.resume(loadSeat(b.kv)!)).toEqual({ ok: true });
    expect(b2.s.me).toBe(id);
    // now lose it for longer than the grace period: the car retires and the seat expires
    b2.driving = false;
    b2.s.close();
    await sleep(cfg.graceS * 1000 + 600);
    const b3 = player(b.kv);
    expect(await b3.s.resume(seat)).toMatchObject({ ok: false, code: 'expired' });
    expect(loadSeat(b.kv)).toBeNull();
    // and it can never come back as a new driver in that race
    expect(await b3.s.join(seat.code, 'B again')).toMatchObject({ ok: false, code: 'started' });
    await until(() => a.results.length > 0, 60000);
    const row = a.results[0].r.classification!.find((x) => x.id === id)!;
    expect(row.status === 'dnf' || row.status === 'dq').toBe(true);
    // a duplicate result (resent on resume into results) is not fresh: nothing is recorded or celebrated twice
    const a2 = player(a.kv);
    a.s.close();
    await a2.s.resume(loadSeat(a.kv)!);
    await until(() => a2.results.length > 0);
    expect(a2.results[0].fresh).toBe(false);
    expect(a2.results[0].r.digest).toBe(a.results[0].r.digest);
    // rematch keeps the same room and participant
    a2.s.rematch();
    await until(() => a2.s.room!.state === 'lobby');
    expect(a2.s.room!.raceId).toBeNull();
    a2.s.leave();
    await until(() => a2.ends.includes('left'));
  }, 90000);

  it('a stop-and-go awarded on the final lap after the last pit entrance is a DQ in every client\'s standings', async () => {
    const a = player(), b = player(new MemKV(), 0.95);
    await a.s.create('A', 'multiplayer', { track: 'circuit-1' });
    await b.s.join(a.s.room!.code, 'B'); b.s.ready(true);
    await until(() => a.s.room!.participants.every((x) => x.host || x.ready));
    a.s.start();
    await until(() => a.s.inRace);
    const room = mgr.room(a.s.room!.id)!;
    const A = room.race!.car(a.s.me!)!, B = room.race!.car(b.s.me!)!;
    // the server's race: wait until A is on its last lap with the last entrance behind it, then three offences
    await until(() => !room.race || (A.lapsDone === 12 && A.mode === 'race' && room.race.apprLap(A) > 13), 60000);
    for (let k = 0; k < 3; k++) room.race!.offence(A, B, 'rear');
    expect(A.sgDue).toBeGreaterThan(13);
    await until(() => a.results.length > 0 && b.results.length > 0, 60000);
    for (const p of [a, b]) {
      const row = p.results[0].r.classification!.find((x) => x.id === a.s.me)!;
      expect(row.status).toBe('dq');
      expect(row.pos).toBeNull();
      expect(p.race!.final!.find((x) => x.id === a.s.me)!.status).toBe('dq');
    }
    expect(a.results[0].r.digest).toBe(b.results[0].r.digest);
    a.s.leave(); b.s.leave();
  }, 90000);

  it('connected solo with AI is its own mode; releasing controls reaches the server at once', async () => {
    const p = player();
    p.driving = false;
    await p.s.create('Solo', 'solo', { track: 'circuit-1' });
    expect(p.s.room!.mode).toBe('solo');
    expect(p.s.room!.ai).toHaveLength(3);
    p.s.start();
    await until(() => p.s.inRace && !!p.race && p.race.phase === 'racing', 20000);
    p.s.setHeld(true, false);
    await until(() => p.race!.car(p.s.me!)!.v > 2);
    p.s.release();   // a menu, blur or background
    const room = mgr.room(p.s.room!.id)!;
    await until(() => { const c = room.race!.car(p.s.me!)!; return c.throttle === 0; }, 2000);
    expect(room.race!.phase).toBe('racing');   // the race is never paused
    p.s.leave();
  }, 60000);

  it('a missing room and an incompatible protocol are refused with a reason', async () => {
    const p = player();
    expect(await p.s.join('ZZZZZZ', 'X')).toMatchObject({ ok: false, code: 'not_found' });
    const bad = new NetSession(url.replace('/ws', '/nope'), Ctor, {}, null, { headers: { origin: ORIGIN } });
    expect(await bad.create('X', 'solo', {})).toMatchObject({ ok: false, code: 'unreachable' });
  });
});
