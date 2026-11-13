// Per-address limits key an IPv6 client by its /64 (#97): one host normally holds a whole /64 and could otherwise rotate
// its source address past every limit. The key function, the room-layer limits that use it, then the real app with
// addresses forwarded by the (trusted, loopback) proxy in X-Real-IP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { limitKey } from '../../server/netkey';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { CreateQuota } from '../../server/quota';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';

describe('limitKey', () => {
  it('two addresses in one /64 share a key, whatever the spelling', () => {
    const k = limitKey('2001:db8:1:2::1');
    expect(k).toBe('2001:db8:1:2::/64');
    for (const a of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:1:2:a:b:c:d', '2001:0db8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:0:0:0:1', '[2001:db8:1:2::9]', '2001:db8:1:2::77%eth0', ' 2001:db8:1:2::5 ']) {
      expect(limitKey(a), a).toBe(k);
    }
    expect(limitKey('2001:db8::1')).toBe(limitKey('2001:0db8:0:0:ffff::2'));
    expect(limitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('different /64s do not share a key', () => {
    const keys = ['2001:db8:1:2::1', '2001:db8:1:3::1', '2001:db8:2:2::1', '2001:db9:1:2::1', '::1', '1:2:3:4::'].map(limitKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('IPv4 is per address, and an IPv4-mapped IPv6 address is that IPv4 address', () => {
    expect(limitKey('1.2.3.4')).toBe('1.2.3.4');
    expect(limitKey('1.2.3.5')).toBe('1.2.3.5');
    expect(limitKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(limitKey('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(limitKey('::ffff:102:304')).toBe('1.2.3.4');
    expect(limitKey('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(limitKey('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(limitKey('::ffff:1.2.3.5')).not.toBe(limitKey('::ffff:1.2.3.4'));
  });

  it('bad or empty input falls back to itself and never throws; the key is stable under re-keying', () => {
    for (const a of ['', 'unknown', 'not an ip', '1.2.3', '256.1.1.1', '01.2.3.4', '2001:db8::1::2', '12345::', 'g::1', ':::', '[::1', 'auth:1.2.3.4']) {
      expect(limitKey(a), a).toBe(a);
    }
    expect(limitKey(undefined as unknown as string)).toBe('undefined');
    for (const a of ['2001:db8:1:2::1', '::ffff:1.2.3.4', '9.9.9.9', 'junk', '']) expect(limitKey(limitKey(a))).toBe(limitKey(a));
  });
});

describe('room-layer limits key by /64', () => {
  it('room creates are charged to the /64', () => {
    const now = 1_000_000;
    const q = new CreateQuota({ perIp: 3, perAccount: 2, creates: 20, windowMs: 600_000 }, () => now);
    for (let i = 0; i < 3; i++) { const k = CreateQuota.keys(`2001:db8:5:6::${i + 1}`, null); expect(q.check(k)).toBe(null); q.charge(`r${i}`, k); }
    expect(q.check(CreateQuota.keys('2001:db8:5:6:dead:beef:0:1', null))?.code).toBe('unavailable');
    expect(q.openFor('ip:2001:db8:5:6::/64')).toBe(3);
    expect(q.check(CreateQuota.keys('2001:db8:5:7::1', null))).toBe(null);
    expect(CreateQuota.keys('::ffff:1.2.3.4', '7')).toEqual(['ip:1.2.3.4', 'acct:7']);
  });

  it('failed joins from one /64 are limited together', () => {
    const mgr = new RoomManager({ cfg: testConfig({}), log: memoryLogger(), sink: new MemoryResultSink() });
    for (let i = 0; i < 20; i++) mgr.noteFailure(`2001:db8:9:9::${(i + 1).toString(16)}`);
    expect(mgr.limited('2001:db8:9:9:1234::1')).toBe(true);
    expect(mgr.limited('2001:db8:9:a::1')).toBe(false);
    mgr.shutdown();
  });
});

describe('over real WebSockets: rotating addresses within one /64 still hits the per-address connection limit', () => {
  const ORIGIN = 'http://localhost:5173';
  const cfg = testConfig({ port: 0, maxConnectionsPerIp: 3 });
  const log = memoryLogger();
  const mgr = new RoomManager({ cfg, log, sink: new MemoryResultSink() });
  let app: App; let base = '';
  const open: WebSocket[] = [];
  beforeAll(async () => { app = createApp({ cfg, log, manager: mgr }); base = `ws://127.0.0.1:${(await app.listen()).port}/ws`; });
  afterAll(async () => { for (const w of open) w.close(); mgr.shutdown(); await app.close(); });
  /** open a socket as the local Nginx forwarding `addr`: 'open', or the HTTP status of the refused upgrade */
  const connect = (addr: string): Promise<'open' | number> => new Promise((resolve, reject) => {
    const w = new WebSocket(base, { headers: { origin: ORIGIN, 'x-real-ip': addr } });
    w.once('open', () => { open.push(w); resolve('open'); });
    w.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); w.terminate(); });
    w.once('error', (e) => reject(e));
  });

  it('a host rotating its IPv6 source address is refused once its /64 has the limit; another /64 and IPv4 are not', async () => {
    const got: Array<'open' | number> = [];
    for (let i = 0; i < 5; i++) got.push(await connect(`2001:db8:aa:bb:${(i * 0x1111 + 1).toString(16)}::${i + 1}`));
    expect(got).toEqual(['open', 'open', 'open', 503, 503]);
    expect(await connect('2001:db8:aa:bc::1')).toBe('open');
    expect(await connect('2001:DB8:AA:BB:0:0:0:FFFF')).toBe(503);
    // IPv4 stays per address; an IPv4-mapped spelling is the same address
    for (let i = 0; i < 3; i++) expect(await connect(i === 2 ? '::ffff:198.51.100.4' : '198.51.100.4')).toBe('open');
    expect(await connect('198.51.100.4')).toBe(503);
    expect(await connect('198.51.100.5')).toBe('open');
  });
});
