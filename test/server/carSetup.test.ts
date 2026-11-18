// Car setups online (#133): the wire, ownership and timing of a seat's choice, frozen rosters, rematch/reconnect/championship,
// a mixed four-player room (deterministic, the same on every client), result envelopes and personal-best candidates, and
// compatibility with pages and servers older than setups. In-process rooms plus real sockets. docs/car-setup.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { RaceSnapshot } from '../../src/race';
import { SETUP_IDS, SETUP_SET, carSetup, type SetupId } from '../../src/carSetup';
import { LENGTH_SET } from '../../src/raceLength';
import { parseClientMessage, type PublicRoom } from '../../src/net/protocol';
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
const cur = { setups: SETUP_SET, lengths: LENGTH_SET };

/** A multiplayer lobby: host plus joiners with the given setups; `old` seats are pages older than setups (no `setups`). */
function lobby(h: H, setups: (SetupId | undefined)[], settings: { track?: string; aiFill?: boolean } = {}, old: number[] = []) {
  const peers = [new FakePeer()];
  const opt = (k: number) => (old.includes(k) ? { lengths: LENGTH_SET } : { ...cur, ...(setups[k] ? { setup: setups[k] } : {}) });
  const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings, ...opt(0) });
  if (!c.ok) throw new Error(`${c.code} ${c.detail}`);
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < setups.length; k++) {
    const p = new FakePeer();
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: `P${k}`, accountId: null, ...opt(k) });
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
function race(h: H, l: { room: Room; peers: FakePeer[]; ids: string[] }, maxMs = 1_500_000): void {
  const bots = l.ids.map((id, k) => new BotClient(l.peers[k], id, 1 - k * 0.03));
  for (const b of bots) b.ctl = l.room.participant(b.id)?.ctlSeq ?? 0;
  h.advance(maxMs, 50, () => {
    if (l.room.state !== 'race') return;
    for (const b of bots) {
      const o = b.controls(); if (!o) continue;
      l.room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) l.room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now);
    }
  }, () => l.room.state !== 'race');
}
const pub = (p: FakePeer): PublicRoom => p.lastRoom();
const seat = (r: PublicRoom, id: string) => r.participants.find((p) => p.id === id)!;

describe('the wire: an allowlisted setup id, never physics numbers', () => {
  const msg = (m: object) => parseClientMessage(JSON.stringify(m));
  it('create, join and `setup` may name a setup by id; numbers, objects, extra keys or a driver field are malformed', () => {
    expect(msg({ t: 'setup', setup: 'speed' })).toMatchObject({ ok: true });
    expect(msg({ t: 'create', name: 'a', mode: 'solo', settings: {}, setup: 'grip', setups: 1 })).toMatchObject({ ok: true });
    expect(msg({ t: 'join', code: 'ABCDEF', name: 'a', setup: 'balanced', setups: 1 })).toMatchObject({ ok: true });
    for (const bad of [
      { t: 'setup', setup: 3 },
      { t: 'setup', setup: { acc: 40, vmax: 40 } },
      { t: 'setup' },
      { t: 'setup', setup: 'speed', driver: 'p_other' },
      { t: 'setup', setup: 'speed', acc: 40 },
      { t: 'setup', setup: 'x'.repeat(65) },
      { t: 'create', name: 'a', mode: 'solo', settings: { setup: 'speed' } },
      { t: 'create', name: 'a', mode: 'solo', settings: { grip: 99 } },
      { t: 'create', name: 'a', mode: 'solo', settings: {}, setup: { grip: 99 } },
      { t: 'create', name: 'a', mode: 'solo', settings: {}, vmax: 40 },
      { t: 'join', code: 'ABCDEF', name: 'a', setups: 'all' },
      { t: 'join', code: 'ABCDEF', name: 'a', setups: -1 },
      { t: 'join', code: 'ABCDEF', name: 'a', setups: 1.5 },
    ]) expect(msg(bad)).toMatchObject({ ok: false, code: 'malformed' });
    // whether the id is a preset is the room's to say (bad_settings)
    expect(msg({ t: 'setup', setup: 'turbo' })).toMatchObject({ ok: true });
  });
});

describe('each seat owns its setup', () => {
  it('Balanced unless asked; an unknown id is refused at create, join and change; every driver sees every choice and the AI\'s', () => {
    const h = harness();
    const l = lobby(h, [undefined, 'speed', 'grip'], { aiFill: true });
    const r = pub(l.peers[0]);
    expect(l.ids.map((id) => [seat(r, id).setup, seat(r, id).tuning])).toEqual([['balanced', 0], ['speed', 1], ['grip', 1]]);
    expect(r.ai.map((a) => a.setup)).toEqual(['balanced']);
    expect(r.setups).toEqual(['balanced', 'speed', 'grip']);
    // the joiner's private reply shows the same
    expect(l.room.joinedMsg(l.ids[2], l.tokens[2], false)).toMatchObject({ room: { participants: [{ setup: 'balanced' }, { setup: 'speed' }, { setup: 'grip' }] } });
    expect(h.mgr.create(new FakePeer(), { name: 'x', accountId: null, mode: 'solo', settings: {}, ...cur, setup: 'turbo' })).toMatchObject({ ok: false, code: 'bad_settings', detail: 'unknown car setup' });
    expect(h.mgr.join(new FakePeer(), '10.0.0.9', { code: l.room.code, name: 'x', accountId: null, ...cur, setup: 'turbo' })).toMatchObject({ ok: false, code: 'bad_settings' });
    expect(l.room.handle(l.ids[1], { t: 'setup', setup: 'turbo' as SetupId }, h.now)).toMatchObject({ t: 'nack', ref: 'setup', code: 'bad_settings' });
    expect(seat(l.room.publicRoom(), l.ids[1]).setup).toBe('speed');
  });

  it('a change is the sender\'s own: it clears that driver\'s Ready only, never the host\'s or anyone else\'s', () => {
    const h = harness();
    const l = lobby(h, [undefined, undefined, undefined]);
    l.room.handle(l.ids[1], { t: 'ready', ready: true }, h.now);
    l.room.handle(l.ids[2], { t: 'ready', ready: true }, h.now);
    expect(l.room.handle(l.ids[2], { t: 'setup', setup: 'grip' }, h.now)).toBe(null);
    const r = pub(l.peers[0]);
    expect(l.ids.map((id) => seat(r, id).setup)).toEqual(['balanced', 'balanced', 'grip']);
    expect([seat(r, l.ids[1]).ready, seat(r, l.ids[2]).ready]).toEqual([true, false]);
    // the host's choice changes only the host's car; no message can name another driver's car
    expect(l.room.handle(l.ids[0], { t: 'setup', setup: 'speed' }, h.now)).toBe(null);
    expect(l.ids.map((id) => seat(pub(l.peers[1]), id).setup)).toEqual(['speed', 'balanced', 'grip']);
    expect(seat(pub(l.peers[1]), l.ids[1]).ready).toBe(true);
    // choosing the setup already held changes nothing (Ready kept)
    l.room.handle(l.ids[1], { t: 'setup', setup: 'balanced' }, h.now);
    expect(seat(pub(l.peers[0]), l.ids[1]).ready).toBe(true);
  });

  it('frozen at the start: a mid-race change (or one on the results screen) is refused and the race is untouched', () => {
    const h = harness();
    const l = lobby(h, ['grip', 'speed'], { aiFill: true });
    start(h, l.room, l.ids);
    expect(l.room.race!.cars.map((c) => c.setup.id)).toEqual(['grip', 'speed', 'balanced', 'balanced']);
    h.advance(3000, 50);
    for (const id of l.ids) expect(l.room.handle(id, { t: 'setup', setup: 'balanced' }, h.now)).toMatchObject({ t: 'nack', code: 'bad_state' });
    expect(l.room.race!.cars.map((c) => c.setup.id)).toEqual(['grip', 'speed', 'balanced', 'balanced']);
    // the snapshot every client mirrors names them, and its mirror shows the same
    const snap = l.peers[1].lastSnap()!;
    expect(snap.cars.map((c) => c.setup)).toEqual(['grip', 'speed', 'balanced', 'balanced']);
    expect(mirrorRace(snap).cars.map((c) => c.setup.id)).toEqual(['grip', 'speed', 'balanced', 'balanced']);
    race(h, l);
    expect(l.room.state).toBe('results');
    expect(l.room.handle(l.ids[0], { t: 'setup', setup: 'balanced' }, h.now)).toMatchObject({ code: 'bad_state' });
    // a rematch keeps every seat's choice; the next lobby is where it can change
    expect(l.room.handle(l.ids[0], { t: 'rematch' }, h.now)).toBe(null);
    expect(l.ids.map((id) => seat(pub(l.peers[0]), id).setup)).toEqual(['grip', 'speed']);
    expect(l.room.handle(l.ids[1], { t: 'setup', setup: 'grip' }, h.now)).toBe(null);
    start(h, l.room, l.ids);
    expect(l.room.race!.cars.map((c) => c.setup.id)).toEqual(['grip', 'grip', 'balanced', 'balanced']);
  });

  it('a reconnect keeps the seat\'s setup, in the lobby and mid-race', () => {
    const h = harness();
    const l = lobby(h, ['speed', 'grip']);
    l.room.disconnect(l.ids[1], l.peers[1], h.now);
    const back = new FakePeer();
    expect(h.mgr.resume(back, '10.0.0.1', l.room.id, l.ids[1], l.tokens[1], null)).toMatchObject({ ok: true });
    expect(seat(l.room.publicRoom(), l.ids[1]).setup).toBe('grip');
    l.peers[1] = back;
    start(h, l.room, l.ids);
    h.advance(5000, 50);
    l.room.disconnect(l.ids[0], l.peers[0], h.now);
    const back0 = new FakePeer();
    expect(h.mgr.resume(back0, '10.0.0.7', l.room.id, l.ids[0], l.tokens[0], null)).toMatchObject({ ok: true });
    const st = JSON.parse(l.room.stateMsg(h.now)!) as { static: { cars: { id: string; setup: string; tuning: number }[] } };
    expect(st.static.cars.map((c) => [c.setup, c.tuning])).toEqual([['speed', 1], ['grip', 1]]);
    expect(l.room.race!.car(l.ids[0])!.setup.id).toBe('speed');
  });

  it('connected solo, championship and practice rooms take the driver\'s setup; each championship round is its own choice', () => {
    const h = harness();
    const solo = h.mgr.create(new FakePeer(), { name: 'S', accountId: null, mode: 'solo', settings: {}, ...cur, setup: 'grip' });
    if (!solo.ok) throw new Error(solo.code);
    solo.room.handle(solo.participant, { t: 'start' }, h.now);
    expect(solo.room.race!.cars.map((c) => c.setup.id)).toEqual(['grip', 'balanced', 'balanced', 'balanced']);
    const r1 = h.mgr.create(new FakePeer(), { name: 'C', accountId: null, mode: 'championship', settings: { track: 'circuit-1' }, championship: { id: 'cc-1', round: 1 }, ...cur, setup: 'speed' });
    const r2 = h.mgr.create(new FakePeer(), { name: 'C', accountId: null, mode: 'championship', settings: { track: 'circuit-2' }, championship: { id: 'cc-1', round: 2 }, ...cur, setup: 'grip' });
    if (!r1.ok || !r2.ok) throw new Error('champ');
    expect([seat(r1.room.publicRoom(), r1.participant).setup, seat(r2.room.publicRoom(), r2.participant).setup]).toEqual(['speed', 'grip']);
    const pr = h.mgr.create(new FakePeer(), { name: 'P', accountId: null, mode: 'practice', settings: {}, ...cur, setup: 'speed' });
    if (!pr.ok) throw new Error(pr.code);
    pr.room.handle(pr.participant, { t: 'start' }, h.now);
    expect(pr.room.race!.cars.map((c) => c.setup.id)).toEqual(['speed']);
  });
});

describe('a mixed four-player room', () => {
  const run = () => {
    const h = harness({}, 133);
    const l = lobby(h, ['speed', 'grip', 'balanced', 'speed'], { track: 'circuit-5' });
    start(h, l.room, l.ids);
    // every client gets the same roster with the same setups
    for (const p of l.peers) expect(p.lastSnap()!.cars.map((c) => c.setup)).toEqual(['speed', 'grip', 'balanced', 'speed']);
    race(h, l);
    const env = l.room.result!;
    const mirrors = l.peers.map((p) => mirrorRace(p.lastSnap() as RaceSnapshot).cars.map((c) => `${c.id}:${c.setup.id}`));
    const norm = l.ids.reduce((s, id, k) => s.split(id).join(`H${k}`), JSON.stringify({ ...env, digest: '', raceId: '', roomId: '', times: { ...env.times, roomCreatedAt: '', startedAt: '', greenAt: '', finishedAt: '' } }));
    return { env, norm, mirrors, ids: l.ids };
  };
  it('runs to its result; the envelope, every client\'s mirror and the server agree on each car\'s setup; a rerun is identical', () => {
    const a = run(), b = run();
    expect(a.env.outcome).toBe('completed');
    expect(a.env.participants.map((p) => [p.setup, p.tuning])).toEqual([['speed', 1], ['grip', 1], ['balanced', 0], ['speed', 1]]);
    for (const m of a.mirrors) expect(m).toEqual(a.ids.map((id, k) => `${id}:${['speed', 'grip', 'balanced', 'speed'][k]}`));
    expect(a.env.classification!.every((x) => x.status === 'finished' || x.status === 'dq')).toBe(true);
    // deterministic: same seed, setups and inputs give the same race and the same result, field for field
    expect(b.norm).toBe(a.norm);
  });
});

describe('result envelopes and personal-best candidates', () => {
  it('each best names its setup and tuning; an envelope from before setups gives Balanced at tuning 0', () => {
    const h = harness();
    const l = lobby(h, ['speed', 'balanced']);
    start(h, l.room, l.ids);
    race(h, l);
    const env = l.room.result! as ResultEnvelope;
    const withAcc = { ...env, participants: env.participants.map((p) => ({ ...p, accountId: `acc-${p.id}` })) };
    const bests = lapBests(withAcc);
    expect(bests.map((b) => [b.participant === l.ids[0] ? 'P0' : 'P1', b.setup, b.tuning]).sort()).toEqual([['P0', 'speed', 1], ['P1', 'balanced', 0]]);
    const legacy = { ...withAcc, participants: withAcc.participants.map(({ setup: _s, tuning: _t, ...p }) => p) };
    expect(lapBests(legacy).every((b) => b.setup === 'balanced' && b.tuning === 0)).toBe(true);
    // a participant naming something no record can be kept under sets no best rather than one under the wrong physics
    const odd = { ...withAcc, participants: withAcc.participants.map((p) => ({ ...p, setup: 'turbo' as SetupId })) };
    expect(lapBests(odd)).toEqual([]);
  });
});

describe('pages older than setups (no `setups`)', () => {
  it('join an all-Balanced room and race as before, keep the room Balanced while seated, and are refused once setups are chosen', () => {
    const h = harness();
    const l = lobby(h, [undefined, undefined], {}, [1]);
    expect(pub(l.peers[0]).setups).toEqual(['balanced']);
    // nobody may choose another setup while that page is seated: it could not show it
    expect(l.room.handle(l.ids[0], { t: 'setup', setup: 'speed' }, h.now)).toMatchObject({ code: 'bad_settings' });
    // a current page joining asks for Grip and is seated Balanced, which the room's list explains
    const p2 = new FakePeer();
    const j = h.mgr.join(p2, '10.0.0.5', { code: l.room.code, name: 'New', accountId: null, ...cur, setup: 'grip' });
    if (!j.ok) throw new Error(j.code);
    expect(seat(l.room.publicRoom(), j.participant).setup).toBe('balanced');
    start(h, l.room, [...l.ids, j.participant]);
    expect(l.room.race!.cars.every((c) => c.setup.id === 'balanced')).toBe(true);
    // once it leaves, setups are open again
    l.room.leave(l.ids[1], h.now);
    race(h, { room: l.room, peers: [l.peers[0], p2], ids: [l.ids[0], j.participant] });
    l.room.handle(l.ids[0], { t: 'rematch' }, h.now);
    expect(pub(l.peers[0]).setups).toEqual(['balanced', 'speed', 'grip']);
    expect(l.room.handle(j.participant, { t: 'setup', setup: 'grip' }, h.now)).toBe(null);
    // and now an older page is refused, told to reload
    expect(h.mgr.join(new FakePeer(), '10.0.0.6', { code: l.room.code, name: 'Old', accountId: null, lengths: LENGTH_SET })).toMatchObject({ ok: false, code: 'bad_settings', detail: expect.stringContaining('reload') });
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

  it('health and welcome list the setups; the session sends the driver\'s own, and a changed one reaches every page', async () => {
    const health = await (await fetch(`http://${base}/api/health`)).json() as { setups: string[] };
    expect(health.setups).toEqual(['balanced', 'speed', 'grip']);
    const host = new NetSession(`ws://${base}/ws`, Ctor, {}, null, { headers: { origin: ORIGIN } });
    expect(await host.create('Host', 'multiplayer', { track: 'circuit-1' }, undefined, undefined, undefined, 'speed')).toEqual({ ok: true });
    expect(host.client.welcome?.setups).toEqual(['balanced', 'speed', 'grip']);
    expect(host.setups).toEqual(SETUP_IDS);
    const guest = new NetSession(`ws://${base}/ws`, Ctor, {}, null, { headers: { origin: ORIGIN } });
    expect(await guest.join(host.room!.code, 'Guest', undefined, undefined, 'grip')).toEqual({ ok: true });
    await until(() => host.room!.participants.length === 2);
    expect(host.room!.participants.map((p) => p.setup)).toEqual(['speed', 'grip']);
    guest.ready(true);
    await until(() => host.room!.participants[1].ready);
    guest.setup('balanced');
    await until(() => host.room!.participants[1].setup === 'balanced');
    expect(host.room!.participants[1].ready).toBe(false);
    // an older page (the raw client: no `setups`) cannot join a room with a Speed car
    const old = new OnlineClient(`ws://${base}/ws`, Ctor, { headers: { origin: ORIGIN } });
    await old.connect();
    expect(await old.request({ t: 'join', code: host.room!.code, name: 'Old' })).toMatchObject({ t: 'nack', ref: 'join', code: 'bad_settings' });
    old.close(); guest.leave(); host.leave();
  }, 30_000);

  it('a connected solo race with Grip runs to its result with the setup in the envelope', async () => {
    let snap: RaceSnapshot | null = null;
    const result: unknown[] = [];
    let s: NetSession;
    s = new NetSession(`ws://${base}/ws`, Ctor, {
      state: (m) => { snap = m.snap as RaceSnapshot; if (!s.me) return; const o = botDrive(snap, s.me, 1); s.setHeld(o.up, o.down); if (o.pit) s.action('pit'); },
      result: (r) => result.push(r),
    }, null, { headers: { origin: ORIGIN } });
    expect(await s.create('Solo', 'solo', { track: 'circuit-4', length: 'sprint' }, undefined, undefined, undefined, 'grip')).toEqual({ ok: true });
    s.start();
    await until(() => result.length > 0, 60000);
    const env = result[0] as ResultEnvelope;
    expect(env.participants.find((p) => p.id === s.me)).toMatchObject({ setup: 'grip', tuning: carSetup('grip').tuning });
    expect(snap!.cars.find((c) => c.id === s.me)!.setup).toBe('grip');
    s.leave();
  }, 90_000);
});

describe('a current page and a server older than setups', () => {
  /** A fake pre-#133 server: its welcome lists no setups and, like the real parser then, it refuses any unknown field or message. */
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
        if (m.t === 'hello') { this.deliver({ t: 'welcome', v: 2, server: 'old', rules: 'r', now: 0, lengths: ['sprint', 'standard', 'endurance'] }); return; }
        if (m.t === 'setup' || 'setup' in m || 'setups' in m) { this.deliver({ t: 'nack', ref: m.t, code: 'malformed' }); return; }
        if (m.t === 'create' || m.t === 'join') this.deliver({ t: 'joined', you: 'p0', token: 't', ctlSeq: 0, actSeq: 0, resumed: false,
          room: { id: 'r', code: 'ABCDEF', mode: 'solo', state: 'lobby', rev: 1, hostId: 'p0', settings: { track: 'circuit-1', aiFill: true, length: 'standard' }, championship: null, participants: [{ id: 'p0', name: 'Me', slot: 0, num: 7, bay: 0, livery: 'yellow', color: 0, liveryRequested: null, ready: false, connected: true, host: true, guest: true, joinOrder: 0, left: false }], ai: [], raceId: null, maxHumans: 1, minHumans: 1, graceS: 20 } });
      }
      close(): void { this.readyState = 3; }
    }
    return { Ctor: Fake as unknown as SocketCtor, sent };
  }

  it('creates and joins without the setup fields, never sends a `setup` message, and reads every car as Balanced', async () => {
    const srv = oldServer();
    const s = new NetSession('ws://old', srv.Ctor, {}, null);
    expect(await s.create('Me', 'solo', { track: 'circuit-1' }, undefined, undefined, undefined, 'speed')).toEqual({ ok: true });
    const create = srv.sent.find((m) => m.t === 'create')!;
    expect(create).not.toHaveProperty('setup');
    expect(create).not.toHaveProperty('setups');
    expect(create).toHaveProperty('lengths');
    expect(s.setups).toEqual([]);
    s.setup('grip');
    expect(srv.sent.some((m) => m.t === 'setup')).toBe(false);
    expect(s.room!.participants[0].setup).toBeUndefined();
    expect(s.room!.setups).toBeUndefined();
    const j = new NetSession('ws://old', oldServer().Ctor, {}, null);
    expect(await j.join('ABCDEF', 'Me', undefined, undefined, 'grip')).toEqual({ ok: true });
  });
});
