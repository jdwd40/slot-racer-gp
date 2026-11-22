// Race-length presets online (#132): room settings, who may change them and when, the target frozen per race, rematch and
// reconnect, championship rounds, independent rooms, result envelopes, and compatibility with pages and servers that
// predate presets. In-process rooms (the harness) plus real sockets for the browser's session. docs/race-length.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { RaceSnapshot } from '../../src/race';
import { LENGTH_IDS, LENGTH_SET, raceLength, type RaceLengthId } from '../../src/raceLength';
import { RULES_VERSION, parseClientMessage, type PublicRoom } from '../../src/net/protocol';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import { NetSession } from '../../src/net/session';
import { mirrorRace } from '../../src/net/mirror';
import { lapBests } from '../../server/career';
import type { ResultEnvelope } from '../../server/envelope';
import type { Room } from '../../server/room';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { BotClient, FakePeer, harness } from './harness';
import { drive as botDrive } from './bot';

type H = ReturnType<typeof harness>;

/** A multiplayer lobby: the creator (host) and `n - 1` joiners, every page knowing the current preset list unless `old`. */
function lobby(h: H, n: number, settings: { track?: string; aiFill?: boolean; length?: RaceLengthId } = {}, old: number[] = []) {
  const peers = [new FakePeer()];
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings, ...(old.includes(0) ? {} : { lengths: LENGTH_SET }) });
  if (!c.ok) throw new Error(`${c.code} ${c.detail}`);
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < n; k++) {
    const p = new FakePeer();
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: `P${k}`, accountId: null, ...(old.includes(k) ? {} : { lengths: LENGTH_SET }) });
    if (!j.ok) throw new Error(`${j.code} ${j.detail}`);
    peers.push(p); ids.push(j.participant); tokens.push(j.token);
  }
  return { room: c.room, peers, ids, tokens };
}
function start(h: H, room: Room, ids: string[]): void {
  for (const id of ids.slice(1)) expect(room.handle(id, { t: 'ready', ready: true }, h.now)).toBe(null);
  expect(room.handle(ids[0], { t: 'start' }, h.now)).toBe(null);
  expect(room.state).toBe('race');
}
/** Bots drive every seat from their own peer's snapshots until the race has its result. */
function race(h: H, rooms: { room: Room; peers: FakePeer[]; ids: string[] }[], maxMs = 1_500_000): void {
  const bots = rooms.map((l) => l.ids.map((id, k) => new BotClient(l.peers[k], id, 1 - k * 0.03)));
  for (const [i, l] of rooms.entries()) for (const b of bots[i]) b.ctl = l.room.participant(b.id)?.ctlSeq ?? 0;
  h.advance(maxMs, 50, () => rooms.forEach((l, i) => {
    if (l.room.state !== 'race') return;
    for (const b of bots[i]) {
      const o = b.controls(); if (!o) continue;
      l.room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) l.room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now);
    }
  }), () => rooms.every((l) => l.room.state !== 'race'));
}
const pub = (p: FakePeer): PublicRoom => p.lastRoom();

describe('the wire: an allowlisted preset id, never a lap count', () => {
  const msg = (m: object) => parseClientMessage(JSON.stringify(m));
  it('settings may name a length; a count, an unknown key or a wrong type is malformed; `lengths` is a small integer', () => {
    expect(msg({ t: 'settings', settings: { length: 'endurance' } })).toMatchObject({ ok: true });
    expect(msg({ t: 'create', name: 'a', mode: 'solo', settings: { track: 'circuit-1', length: 'sprint' }, lengths: 1 })).toMatchObject({ ok: true });
    expect(msg({ t: 'join', code: 'ABCDEF', name: 'a', lengths: 1 })).toMatchObject({ ok: true });
    for (const bad of [
      { t: 'settings', settings: { length: 26 } },
      { t: 'settings', settings: { laps: 26 } },
      { t: 'settings', settings: { length: null } },
      { t: 'create', name: 'a', mode: 'solo', settings: { laps: 5 } },
      { t: 'create', name: 'a', mode: 'solo', settings: {}, lengths: 'all' },
      { t: 'create', name: 'a', mode: 'solo', settings: {}, lengths: 1.5 },
      { t: 'join', code: 'ABCDEF', name: 'a', lengths: -1 },
      { t: 'join', code: 'ABCDEF', name: 'a', lengths: 1000 },
    ]) expect(msg(bad)).toMatchObject({ ok: false, code: 'malformed' });
    // the shape is the parser's; whether the id is a preset is the room's (bad_settings, below)
    expect(msg({ t: 'settings', settings: { length: 'marathon' } })).toMatchObject({ ok: true });
  });
});

describe('room settings', () => {
  it('a room is Standard unless asked otherwise; an unknown preset is refused; every driver sees the name and count', () => {
    const h = harness();
    const std = lobby(h, 2);
    expect(std.room.publicRoom().settings).toEqual({ track: 'circuit-1', aiFill: false, length: 'standard' });
    const end = lobby(h, 2, { length: 'endurance' });
    // the host's page hears it with the joiner's arrival; the joiner gets it in its own `joined` reply
    expect(pub(end.peers[0]).settings.length).toBe('endurance');
    expect(end.room.joinedMsg(end.ids[1], end.tokens[1], false)).toMatchObject({ t: 'joined', room: { settings: { length: 'endurance' } } });
    expect(h.mgr.create(new FakePeer(), { name: 'x', accountId: null, mode: 'multiplayer', settings: { length: 'marathon' as RaceLengthId }, lengths: LENGTH_SET }))
      .toMatchObject({ ok: false, code: 'bad_settings', detail: 'unknown race length' });
    expect(end.room.handle(end.ids[0], { t: 'settings', settings: { length: 'x' as RaceLengthId } }, h.now)).toMatchObject({ t: 'nack', code: 'bad_settings' });
    expect(end.room.length).toBe('endurance');
  });

  it('only the host changes it, a change clears stale Ready, and it is frozen once the race starts', () => {
    const h = harness();
    const { room, peers, ids } = lobby(h, 3, { aiFill: true });
    expect(room.handle(ids[1], { t: 'settings', settings: { length: 'sprint' } }, h.now)).toMatchObject({ code: 'forbidden' });
    room.handle(ids[1], { t: 'ready', ready: true }, h.now);
    room.handle(ids[2], { t: 'ready', ready: true }, h.now);
    expect(room.handle(ids[0], { t: 'settings', settings: { length: 'sprint' } }, h.now)).toBe(null);
    // everyone sees the new length before Ready/Start, and has to confirm again
    for (const p of peers) expect(pub(p).settings.length).toBe('sprint');
    expect(pub(peers[0]).participants.filter((p) => p.id !== ids[0]).map((p) => p.ready)).toEqual([false, false]);
    expect(room.handle(ids[0], { t: 'start' }, h.now)).toMatchObject({ code: 'not_ready' });
    start(h, room, ids);
    expect(room.race!.targetLaps).toBe(5);
    expect(peers[1].lastSnap()!.laps).toBe(5);
    // a mid-race edit is refused and changes nothing, for the host as much as anyone
    expect(room.handle(ids[0], { t: 'settings', settings: { length: 'endurance' } }, h.now)).toMatchObject({ code: 'bad_state' });
    expect([room.length, room.race!.targetLaps]).toEqual(['sprint', 5]);
  });

  it('a reconnect gets the length back with the room, and the race state counts to the same flag', () => {
    const h = harness();
    const { room, peers, ids, tokens } = lobby(h, 2, { length: 'endurance' });
    start(h, room, ids);
    h.advance(6000, 50);
    room.disconnect(ids[1], peers[1], h.now);
    const back = new FakePeer();
    const r = h.mgr.resume(back, '10.0.0.1', room.id, ids[1], tokens[1], null);
    expect(r.ok).toBe(true);
    back.send(JSON.stringify(room.joinedMsg(ids[1], tokens[1], true)));
    back.send(room.stateMsg(h.now)!);
    expect(back.of('joined')[0].room.settings.length).toBe('endurance');
    const snap = back.lastSnap()!;
    expect(snap.laps).toBe(26);
    expect(mirrorRace(snap).targetLaps).toBe(26);
  });

  it('practice has no race length: only Standard (the server default) is accepted for a practice room', () => {
    const h = harness();
    expect(h.mgr.create(new FakePeer(), { name: 'p', accountId: null, mode: 'practice', settings: { length: 'endurance' }, lengths: LENGTH_SET }))
      .toMatchObject({ ok: false, code: 'bad_settings' });
    const p = h.mgr.create(new FakePeer(), { name: 'p', accountId: null, mode: 'practice', settings: {}, lengths: LENGTH_SET });
    expect(p.ok && p.room.length).toBe('standard');
  });
});

describe('pages older than presets (no `lengths`)', () => {
  it('join and race a Standard room as before, but are kept out of a Sprint or Endurance race they could not show', () => {
    const h = harness();
    // an older page creates and joins exactly as it always did: Standard
    const old = lobby(h, 2, {}, [0, 1]);
    expect(old.room.length).toBe('standard');
    // it cannot join a room racing another length: refused with a reason (an older page shows it as a refusal)
    const end = lobby(h, 1, { length: 'endurance' });
    const p = new FakePeer();
    expect(h.mgr.join(p, '10.0.0.9', { code: end.room.code, name: 'Old', accountId: null }))
      .toMatchObject({ ok: false, code: 'bad_settings', detail: expect.stringContaining('reload') });
    expect(end.room.humans).toBe(1);
    // a host cannot switch the room to a length an older page in it could not show; once it leaves, the host can
    const mixed = lobby(h, 2, {}, [1]);
    expect(mixed.room.handle(mixed.ids[0], { t: 'settings', settings: { length: 'sprint' } }, h.now)).toMatchObject({ code: 'bad_settings' });
    expect(mixed.room.length).toBe('standard');
    expect(mixed.room.handle(mixed.ids[0], { t: 'settings', settings: { length: 'standard', track: 'circuit-3' } }, h.now)).toBe(null);
    mixed.room.leave(mixed.ids[1], h.now);
    expect(mixed.room.handle(mixed.ids[0], { t: 'settings', settings: { length: 'sprint' } }, h.now)).toBe(null);
    // and a creator that does not say it knows presets cannot ask for one
    expect(h.mgr.create(new FakePeer(), { name: 'x', accountId: null, mode: 'solo', settings: { length: 'sprint' } })).toMatchObject({ ok: false, code: 'bad_settings' });
  });
});

describe('races at every length', () => {
  it.each([['sprint', 'circuit-5'], ['standard', 'circuit-3'], ['endurance', 'circuit-2']] as [RaceLengthId, string][])(
    '%s multiplayer on %s: two humans and AI finish on the flag inside the limits; the envelope names the length; a rematch keeps it',
    (length, track) => {
      const n = raceLength(length).laps;
      const h = harness({ timeScale: 2, maxCatchUpSteps: 12 }, 1320);
      const l = lobby(h, 2, { track, aiFill: true, length });
      start(h, l.room, l.ids);
      expect([l.room.race!.finishWindow, l.room.race!.timeLimit]).toEqual([raceLength(length).finishWindowS, raceLength(length).timeLimitS]);
      race(h, [l]);
      const env = l.room.result!;
      expect(env).toMatchObject({ outcome: 'completed', settings: { track, length } });
      // no timeout, window or fuel deadlock: everyone reached the flag on lap n (a bot may collect a stop-and-go and be DQ'd there)
      for (const s of env.classification!) {
        expect(s.laps).toBe(n);
        expect(s.status === 'finished' || (s.status === 'dq' && s.control === 'human')).toBe(true);
      }
      expect(env.times.raceTimeS).toBeLessThan(raceLength(length).timeLimitS / 2);
      for (const id of l.ids) {
        const laps = env.laps.filter((x) => x.driver === id).map((x) => x.lap);
        expect(laps).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }
      // a rematch keeps the length; it is still the host's to change before the start
      expect(l.room.handle(l.ids[0], { t: 'rematch' }, h.now)).toBe(null);
      expect(pub(l.peers[1]).settings.length).toBe(length);
      start(h, l.room, l.ids);
      expect(l.room.race!.targetLaps).toBe(n);
    }, 120_000);

  it('the final lap counts for a personal best at every length (the room records it before the finish)', () => {
    for (const length of LENGTH_IDS) {
      const n = raceLength(length).laps;
      const laps = Array.from({ length: n }, (_, i) => ({ driver: 'p1', lap: i + 1, time: 20 - (i === n - 1 ? 1 : 0), valid: true, raceT: 20 * (i + 1) }));
      const env = { outcome: 'completed', mode: 'multiplayer', raceId: 'r', track: { id: 'circuit-1', version: 'v' }, rules: { version: 'x', protocol: 2 },
        participants: [{ id: 'p1', control: 'human', accountId: '7', livery: 'red' }], laps } as unknown as ResultEnvelope;
      expect(lapBests(env)).toMatchObject([{ lap: n, lapMs: 19000 }]);
    }
  });

  it('rooms racing different lengths side by side run exactly as each runs alone', () => {
    const run = (lengths: RaceLengthId[]) => {
      const h = harness({ timeScale: 2, maxCatchUpSteps: 12 }, 77);
      const rooms = lengths.map((length) => { const l = lobby(h, 2, { track: 'circuit-4', aiFill: true, length }); start(h, l.room, l.ids); return l; });
      race(h, rooms);
      return rooms.map((l) => {
        const e = l.room.result!;
        return JSON.stringify({ len: e.settings.length, c: e.classification!.map((s) => [s.slot, s.status, s.time, s.laps]), l: e.laps.map((x) => [x.lap, x.time]) });
      });
    };
    const [sprint] = run(['sprint']);
    const [endurance] = run(['endurance']);
    const [s2, e2] = run(['sprint', 'endurance']);
    expect(s2).toBe(sprint);
    expect(e2).toBe(endurance);
    expect(JSON.parse(sprint).c.every((x: unknown[]) => x[3] === 5)).toBe(true);
    expect(JSON.parse(endurance).c.every((x: unknown[]) => x[3] === 26)).toBe(true);
  }, 180_000);

  it('a connected solo and a championship round get the one-human limits of their length; a round keeps its length', () => {
    const h = harness();
    const s = h.mgr.create(new FakePeer(), { name: 'S', accountId: null, mode: 'solo', settings: { length: 'endurance' }, lengths: LENGTH_SET });
    if (!s.ok) throw new Error(s.code);
    s.room.handle(s.participant, { t: 'start' }, h.now);
    expect([s.room.race!.targetLaps, s.room.race!.finishWindow, s.room.race!.timeLimit]).toEqual([26, 240, 2400]);
    const c = h.mgr.create(new FakePeer(), { name: 'C', accountId: null, mode: 'championship', settings: { track: 'circuit-2', length: 'sprint' }, championship: { id: 'cc-1', round: 2 }, lengths: LENGTH_SET });
    if (!c.ok) throw new Error(c.code);
    expect(c.room.publicRoom().settings).toEqual({ track: 'circuit-2', aiFill: true, length: 'sprint' });
    expect(c.room.handle(c.participant, { t: 'settings', settings: { length: 'endurance' } }, h.now)).toMatchObject({ code: 'bad_settings' });
    expect(c.room.handle(c.participant, { t: 'settings', settings: { length: 'sprint' } }, h.now)).toBe(null);
    c.room.handle(c.participant, { t: 'start' }, h.now);
    expect([c.room.race!.targetLaps, c.room.race!.finishWindow, c.room.race!.timeLimit]).toEqual([5, 120, 1200]);
  });
});

describe('over real sockets', () => {
  const ORIGIN = 'http://localhost:5173';
  const SCALE = 12;
  const cfg = testConfig({ port: 0, timeScale: SCALE, maxCatchUpSteps: 6 * SCALE, snapshotHz: 10, graceS: 5, msgRate: 200, msgBurst: 300, maxConnectionsPerIp: 40, roomsPerIp: 50, roomCreates: 1000 });
  const mgr = new RoomManager({ cfg, log: memoryLogger(), sink: new MemoryResultSink() });
  let app: App;
  let base = '';
  const Ctor = WebSocket as unknown as SocketCtor;
  beforeAll(async () => { app = createApp({ cfg, log: memoryLogger(), manager: mgr }); base = `127.0.0.1:${(await app.listen()).port}`; mgr.start(); });
  afterAll(async () => { mgr.shutdown(); await app.close(); });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean, ms = 30000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } };

  it('health and welcome list the presets; the browser session asks for one and a Sprint race runs to lap 5', async () => {
    const health = await (await fetch(`http://${base}/api/health`)).json() as { lengths: string[] };
    expect(health.lengths).toEqual(['sprint', 'standard', 'endurance']);
    let snap: RaceSnapshot | null = null;
    const result: { r: unknown }[] = [];
    let s: NetSession;
    s = new NetSession(`ws://${base}/ws`, Ctor, {
      state: (m) => {
        snap = m.snap as RaceSnapshot;
        if (!s.me) return;
        const o = botDrive(snap, s.me, 1);
        s.setHeld(o.up, o.down);
        if (o.pit) s.action('pit');
      },
      result: (r) => result.push({ r }),
    }, null, { headers: { origin: ORIGIN } });
    expect(await s.create('Solo', 'solo', { track: 'circuit-1', length: 'sprint' })).toEqual({ ok: true });
    expect(s.client.welcome?.lengths).toEqual(['sprint', 'standard', 'endurance']);
    expect(s.room!.settings.length).toBe('sprint');
    s.start();
    await until(() => result.length > 0, 60000);
    const env = result[0].r as ResultEnvelope;
    expect(env.settings.length).toBe('sprint');
    expect(env.classification!.every((x) => x.laps === 5)).toBe(true);
    expect(snap!.laps).toBe(5);
    s.leave();
  }, 90_000);

  it('a page older than presets (no `lengths`) is refused from an Endurance room, and races Standard rooms as before', async () => {
    const host = new NetSession(`ws://${base}/ws`, Ctor, {}, null, { headers: { origin: ORIGIN } });
    expect(await host.create('Host', 'multiplayer', { track: 'circuit-2', length: 'endurance' })).toEqual({ ok: true });
    // the raw protocol client sends what a pre-#132 page sends: no `lengths`
    const old = new OnlineClient(`ws://${base}/ws`, Ctor, { headers: { origin: ORIGIN } });
    await old.connect();
    const r = await old.request({ t: 'join', code: host.room!.code, name: 'Old' });
    expect(r).toMatchObject({ t: 'nack', ref: 'join', code: 'bad_settings' });
    old.close();
    host.settings({ length: 'standard' });
    await until(() => host.room?.settings.length === 'standard');
    const old2 = new OnlineClient(`ws://${base}/ws`, Ctor, { headers: { origin: ORIGIN } });
    await old2.connect();
    expect(await old2.request({ t: 'join', code: host.room!.code, name: 'Old' })).toMatchObject({ t: 'joined' });
    // now the host cannot move the room off Standard while that page is in it
    host.settings({ length: 'sprint' });
    await sleep(200);
    expect(host.room!.settings.length).toBe('standard');
    old2.close(); host.leave();
  }, 30_000);
});

describe('a current page and a server older than presets', () => {
  /** A fake pre-#132 server: its welcome lists no presets and, like the real parser then, it refuses any unknown field. */
  function oldServer() {
    const sent: Record<string, unknown>[] = [];
    class Fake {
      readyState = 0;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code: number; reason: string }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 1); }
      deliver(m: unknown): void { setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 1); }
      send(data: string): void {
        const m = JSON.parse(data) as Record<string, unknown>;
        sent.push(m);
        if (m.t === 'hello') { this.deliver({ t: 'welcome', v: 2, server: 'old', rules: RULES_VERSION, now: 0 }); return; }
        const s = (m.settings ?? {}) as Record<string, unknown>;
        if ('lengths' in m || Object.keys(s).some((k) => k !== 'track' && k !== 'aiFill')) { this.deliver({ t: 'nack', ref: m.t, code: 'malformed' }); return; }
        if (m.t === 'create' || m.t === 'join') this.deliver({ t: 'joined', you: 'p0', token: 't', ctlSeq: 0, actSeq: 0, resumed: false,
          room: { id: 'r', code: 'ABCDEF', mode: 'solo', state: 'lobby', rev: 1, hostId: 'p0', settings: { track: 'circuit-1', aiFill: true }, championship: null, participants: [], ai: [], raceId: null, maxHumans: 1, minHumans: 1, graceS: 20 } });
      }
      close(): void { this.readyState = 3; }
    }
    return { Ctor: Fake as unknown as SocketCtor, sent };
  }

  it('creates and joins without the length fields (a Standard room), and never sends a length setting to it', async () => {
    const srv = oldServer();
    const s = new NetSession('ws://old', srv.Ctor, {}, null);
    expect(await s.create('Me', 'solo', { track: 'circuit-1', length: 'endurance' })).toEqual({ ok: true });
    const create = srv.sent.find((m) => m.t === 'create')!;
    expect(create).not.toHaveProperty('lengths');
    expect(create.settings).toEqual({ track: 'circuit-1' });
    expect(s.room!.settings.length).toBeUndefined();
    expect(s.lengths).toEqual([]);
    s.settings({ length: 'sprint' });
    s.settings({ length: 'sprint', track: 'circuit-2' });
    expect(srv.sent.filter((m) => m.t === 'settings')).toEqual([{ t: 'settings', settings: { track: 'circuit-2' } }]);
    const j = new NetSession('ws://old', oldServer().Ctor, {}, null);
    expect(await j.join('ABCDEF', 'Me')).toEqual({ ok: true });
  });
});
