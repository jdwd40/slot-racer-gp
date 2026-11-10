// Room creation allowance (#52): one client address (or account) cannot fill the room cap, joining is never limited, and
// the allowance is held by a room until it closes. Limiter logic on a fake clock, the RoomManager on the manual-clock
// harness, then the real HTTP/WebSocket app with stock limits.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import type { ServerMsg } from '../../src/net/protocol';
import { createApp, type App } from '../../server/app';
import { loadConfig, testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { CreateQuota } from '../../server/quota';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { FakePeer, harness } from './harness';

const STOCK = loadConfig({ NODE_ENV: 'production', SLOTRUSH_ALLOWED_ORIGINS: 'https://slotrush.jdwd40.com' });

describe('stock defaults', () => {
  it('leave room for other addresses under the 6-room cap and are bounded env settings', () => {
    expect(STOCK).toMatchObject({ roomCap: 6, roomsPerIp: 3, roomsPerAccount: 2, roomCreates: 20, roomCreateWindowS: 600 });
    expect(STOCK.roomsPerIp).toBeLessThan(STOCK.roomCap);
    expect(loadConfig({ SLOTRUSH_ROOMS_PER_IP: '6', SLOTRUSH_ROOMS_PER_ACCOUNT: '1', SLOTRUSH_ROOM_CREATES: '5', SLOTRUSH_ROOM_CREATE_WINDOW_S: '60' }))
      .toMatchObject({ roomsPerIp: 6, roomsPerAccount: 1, roomCreates: 5, roomCreateWindowS: 60 });
    expect(() => loadConfig({ SLOTRUSH_ROOMS_PER_IP: '0' })).toThrow(/SLOTRUSH_ROOMS_PER_IP/);
    expect(() => loadConfig({ SLOTRUSH_ROOM_CREATES: 'lots' })).toThrow(/SLOTRUSH_ROOM_CREATES/);
  });
});

describe('CreateQuota (fake clock)', () => {
  const make = (over: Partial<ConstructorParameters<typeof CreateQuota>[0]> = {}) => {
    let now = 1_000_000;
    const q = new CreateQuota({ perIp: 3, perAccount: 2, creates: 5, windowMs: 600_000, ...over }, () => now);
    return { q, tick: (ms: number) => { now += ms; } };
  };
  const ip = (a: string) => CreateQuota.keys(a, null);

  it('caps open rooms per address and per account; release gives the allowance back, once', () => {
    const { q } = make();
    for (let i = 0; i < 3; i++) { expect(q.check(ip('a'))).toBe(null); q.charge(`r${i}`, ip('a')); }
    expect(q.check(ip('a'))).toMatchObject({ code: 'unavailable', detail: expect.stringMatching(/3 open rooms per address/) });
    expect(q.check(ip('b'))).toBe(null);
    q.release('r1'); q.release('r1'); q.release('never');
    expect(q.openFor('ip:a')).toBe(2);
    expect(q.check(ip('a'))).toBe(null);
    // an account is bounded on every address it uses
    q.charge('x1', CreateQuota.keys('c', '42')); q.charge('x2', CreateQuota.keys('d', '42'));
    expect(q.check(CreateQuota.keys('e', '42'))).toMatchObject({ code: 'unavailable', detail: expect.stringMatching(/per account/) });
    expect(q.check(CreateQuota.keys('e', '43'))).toBe(null);
  });

  it('a rapid burst and slow repeated creates both stop at the sliding-window rate, with no boundary double-burst', () => {
    const { q, tick } = make({ perIp: 50 });
    let n = 0;
    // burst: five at once, then refused even though no room is open any more
    for (let i = 0; i < 5; i++) { expect(q.check(ip('a'))).toBe(null); q.charge(`b${n}`, ip('a')); q.release(`b${n++}`); }
    expect(q.check(ip('a'))).toMatchObject({ code: 'rate', detail: 'too many new rooms: try again in 600 s' });
    tick(599_999); expect(q.check(ip('a'))?.code).toBe('rate');
    tick(1); expect(q.check(ip('a'))).toBe(null);
    // slow: one every 2 minutes; in every 10-minute span there are never more than 5
    const times: number[] = []; let t = 0;
    for (let k = 0; k < 40; k++) {
      if (!q.check(ip('a'))) { q.charge(`s${n}`, ip('a')); q.release(`s${n++}`); times.push(t); }
      tick(60_000); t += 60_000;
    }
    for (const s of times) expect(times.filter((x) => x >= s && x < s + 600_000).length).toBeLessThanOrEqual(5);
    expect(times.length).toBeGreaterThan(15);   // but it keeps working at a slow pace
  });

  it('bookkeeping is bounded and expires', () => {
    const { q, tick } = make();
    for (let i = 0; i < 10_050; i++) { q.charge(`r${i}`, ip(`10.${i}`)); q.release(`r${i}`); }
    expect(q.trackedKeys).toBeLessThanOrEqual(10_000);
    tick(600_001);
    q.charge('z', ip('z')); q.release('z');
    expect(q.check(ip('10.10049'))).toBe(null);
  });
});

describe('RoomManager creation allowance (manual clock)', () => {
  const guest = (h: ReturnType<typeof harness>, ip: string, mode: 'multiplayer' | 'solo' | 'practice' = 'multiplayer', accountId: string | null = null, settings = {}) =>
    h.mgr.create(new FakePeer(), { name: 'P', accountId, mode, settings, ip });

  it('one address cannot take every room; another address, joiners and in-process callers still can', () => {
    const h = harness();
    expect(h.cfg.roomCap).toBe(6);
    const rooms = [guest(h, '1.1.1.1'), guest(h, '1.1.1.1', 'solo'), guest(h, '1.1.1.1', 'practice')];
    expect(rooms.every((r) => r.ok)).toBe(true);
    expect(guest(h, '1.1.1.1')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(h.mgr.size).toBe(3);
    // the same address joins freely: four people behind one NAT share one room
    const r0 = rooms[0]; if (!r0.ok) throw new Error();
    for (let k = 0; k < 3; k++) expect(h.mgr.join(new FakePeer(), '1.1.1.1', { code: r0.room.code, name: `H${k}`, accountId: null }).ok).toBe(true);
    expect(guest(h, '2.2.2.2').ok).toBe(true);
  });

  it('switching accounts on one address, or one account on many addresses, does not reset the allowance', () => {
    const h = harness();
    expect(guest(h, '1.1.1.1', 'solo', '1').ok).toBe(true);
    expect(guest(h, '1.1.1.1', 'solo', '2').ok).toBe(true);
    expect(guest(h, '1.1.1.1', 'solo', null).ok).toBe(true);
    expect(guest(h, '1.1.1.1', 'solo', '3')).toMatchObject({ code: 'unavailable', detail: expect.stringMatching(/address/) });
    expect(guest(h, '5.5.5.5', 'solo', '1').ok).toBe(true);
    expect(guest(h, '6.6.6.6', 'solo', '1')).toMatchObject({ code: 'unavailable', detail: expect.stringMatching(/account/) });
  });

  it('host transfer and the creator dropping out keep the room charged until it closes; closing or expiring releases it', () => {
    const h = harness({ lobbyIdleS: 60 });
    const a = guest(h, '1.1.1.1'); if (!a.ok) throw new Error();
    const p = new FakePeer();
    const j = h.mgr.join(p, '9.9.9.9', { code: a.room.code, name: 'Friend', accountId: null }); if (!j.ok) throw new Error();
    a.room.handle(a.participant, { t: 'leave' }, h.now);
    expect(a.room.hostId).toBe(j.participant);
    expect(h.mgr.quota.openFor('ip:1.1.1.1')).toBe(1);   // the creator still pays for the room it left to others
    expect(h.mgr.quota.openFor('ip:9.9.9.9')).toBe(0);   // and the new host was not charged
    guest(h, '1.1.1.1'); guest(h, '1.1.1.1');
    expect(guest(h, '1.1.1.1').ok).toBe(false);
    a.room.handle(j.participant, { t: 'leave' }, h.now);   // the room empties and closes
    expect(a.room.state).toBe('closed');
    expect(h.mgr.quota.openFor('ip:1.1.1.1')).toBe(2);
    expect(guest(h, '1.1.1.1').ok).toBe(true);
    h.advance(61_000);                                    // idle lobbies expire: everything is released
    expect(h.mgr.size).toBe(0);
    expect(h.mgr.quota.openFor('ip:1.1.1.1')).toBe(0);
    expect(guest(h, '1.1.1.1').ok).toBe(true);
  });

  it('failed creates cost nothing: bad settings, a bad name, the global cap', () => {
    const h = harness({ roomCap: 4 });
    expect(guest(h, '1.1.1.1', 'multiplayer', null, { track: 'nope' })).toMatchObject({ code: 'bad_settings' });
    expect(h.mgr.create(new FakePeer(), { name: '\u0000', accountId: null, mode: 'solo', settings: {}, ip: '1.1.1.1' })).toMatchObject({ code: 'malformed' });
    expect(h.mgr.size).toBe(0);
    expect(h.mgr.quota.openFor('ip:1.1.1.1')).toBe(0);
    guest(h, '2.2.2.2'); guest(h, '3.3.3.3'); guest(h, '4.4.4.4'); guest(h, '5.5.5.5');
    expect(guest(h, '1.1.1.1')).toMatchObject({ code: 'unavailable', detail: 'room limit reached, try again later' });
    expect(h.mgr.quota.openFor('ip:1.1.1.1')).toBe(0);
    h.mgr.shutdown();
    for (const k of ['2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5']) expect(h.mgr.quota.openFor(`ip:${k}`)).toBe(0);
  });
});

describe('over real WebSockets with stock limits', () => {
  const ORIGIN = 'http://localhost:5173';
  // stock creation limits: only test speed-ups and a connection allowance big enough for the many sockets of one test host
  const cfg = testConfig({ port: 0, timeScale: 12, maxCatchUpSteps: 72, maxConnectionsPerIp: 40 });
  const log = memoryLogger();
  const mgr = new RoomManager({ cfg, log, sink: new MemoryResultSink() });
  let app: App; let base = '';
  const open: OnlineClient[] = [];
  beforeAll(async () => { app = createApp({ cfg, log, manager: mgr }); base = `ws://127.0.0.1:${(await app.listen()).port}/ws`; mgr.start(); });
  afterAll(async () => { mgr.shutdown(); await app.close(); });
  const Ctor = WebSocket as unknown as SocketCtor;
  /** a client behind the local Nginx naming the client address (X-Real-IP from a loopback peer), or a direct peer */
  async function client(addr: string | null, extra: Record<string, unknown> = {}): Promise<OnlineClient> {
    const c = new OnlineClient(base, Ctor, { headers: { origin: ORIGIN, ...(addr ? { 'x-real-ip': addr } : {}) }, ...extra });
    await c.connect(); open.push(c);
    return c;
  }
  const create = (c: OnlineClient, mode: 'multiplayer' | 'solo' | 'practice' = 'multiplayer') => c.request({ t: 'create', name: 'Driver', mode, settings: {} });
  const closeAll = async () => { for (const c of open.splice(0)) c.close(); mgr.shutdown('test'); mgr.start(); await new Promise((r) => setTimeout(r, 50)); };

  it('one address fills only its share of the cap on new sockets; another address still creates; refusals are stable', async () => {
    const got: ServerMsg[] = [];
    for (let i = 0; i < 6; i++) got.push(await create(await client('203.0.113.7')));
    expect(got.map((m) => m.t)).toEqual(['joined', 'joined', 'joined', 'nack', 'nack', 'nack']);
    for (const m of got.slice(3)) expect(m).toEqual({ t: 'nack', ref: 'create', code: 'unavailable', detail: '3 open rooms per address at most: leave one or try again later' });
    expect(mgr.size).toBe(3);
    expect(await create(await client('198.51.100.9'))).toMatchObject({ t: 'joined' });
    expect(await create(await client('192.0.2.1'), 'solo')).toMatchObject({ t: 'joined' });
    expect(await create(await client('192.0.2.2'), 'practice')).toMatchObject({ t: 'joined' });
    await closeAll();
  });

  it('four players behind one shared address create, join and race in the same room', async () => {
    const cs = [await client('203.0.113.50')];
    for (let k = 0; k < 2; k++) expect(await create(await client('203.0.113.50'), 'solo')).toMatchObject({ t: 'joined' });   // the household's other sessions
    const j = await create(cs[0]);
    if (j.t !== 'joined') throw new Error(JSON.stringify(j));
    for (let k = 1; k < 4; k++) {
      const c = await client('203.0.113.50');
      expect(await c.request({ t: 'join', code: j.room.code, name: `Sib${k}` })).toMatchObject({ t: 'joined' });
      cs.push(c);
    }
    for (const c of cs.slice(1)) c.send({ t: 'ready', ready: true });
    await cs[0].wait((m) => m.t === 'room' && m.room.participants.length === 4 && m.room.participants.every((p) => p.host || p.ready));
    cs[0].send({ t: 'start' });
    await Promise.all(cs.map((c) => c.wait((m) => m.t === 'state')));
    expect(mgr.byCode(j.room.code)?.state).toBe('race');
    await closeAll();
  });

  it('disconnect and resume keep the room charged; leaving closes it and gives the allowance back', async () => {
    const addr = '203.0.113.80';
    const a = await client(addr);
    const j = await create(a);
    if (j.t !== 'joined') throw new Error();
    const cred = a.credential()!;
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(mgr.quota.openFor(`ip:${addr}`)).toBe(1);   // the seat waits out its grace; the room is still this address's
    const b = await client(addr);
    expect(await b.request({ t: 'resume', room: cred.room, participant: cred.participant, token: cred.token })).toMatchObject({ t: 'joined', resumed: true });
    expect(mgr.quota.openFor(`ip:${addr}`)).toBe(1);
    expect(await create(await client(addr))).toMatchObject({ t: 'joined' });
    expect(await create(await client(addr))).toMatchObject({ t: 'joined' });
    expect(await create(await client(addr))).toMatchObject({ t: 'nack', code: 'unavailable' });
    b.send({ t: 'leave' });
    await b.wait((m) => m.t === 'bye');
    expect(mgr.quota.openFor(`ip:${addr}`)).toBe(2);
    expect(await create(await client(addr))).toMatchObject({ t: 'joined' });
    await closeAll();
  });

  it('a forwarded address from a peer that is not the local proxy is ignored: rotating it does not escape the limit', async () => {
    const got: string[] = [];
    // 127.0.0.2 is a loopback address but not the trusted Nginx peer (127.0.0.1 / ::1), so its X-Real-IP is not believed
    for (let i = 0; i < 4; i++) got.push((await create(await client(`10.9.9.${i}`, { localAddress: '127.0.0.2' }))).t);
    expect(got).toEqual(['joined', 'joined', 'joined', 'nack']);
    expect(mgr.quota.openFor('ip:127.0.0.2')).toBe(3);
    expect(mgr.quota.openFor('ip:10.9.9.0')).toBe(0);
    await closeAll();
  });
});
