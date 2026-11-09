// The shared protocol parser, the browser's online gate, server configuration bounds, and the race-core additions the
// server relies on: frozen shared tracks, strict track ids, retire() and the live run-on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LIMITS, PROTOCOL_VERSION, cleanName, parseClientMessage } from '../../src/net/protocol';
import { probeOnline } from '../../src/online';
import { loadConfig } from '../../server/config';
import { createLogger, redact } from '../../server/log';
import { Race, PEN, RUN_OUT_MAX } from '../../src/race';
import * as T from '../../src/track';

afterEach(() => vi.restoreAllMocks());

describe('protocol parser', () => {
  it('accepts exactly the known messages and refuses malformed, unknown-field, wrong-type and oversized ones', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, proto: 'slotrush' }))).toMatchObject({ ok: true });
    expect(parseClientMessage(JSON.stringify({ t: 'ctl', seq: 3, up: true, down: false }))).toMatchObject({ ok: true });
    expect(parseClientMessage(JSON.stringify({ t: 'act', seq: 1, type: 'defer' }))).toMatchObject({ ok: true });
    expect(parseClientMessage(JSON.stringify({ t: 'create', name: 'A', mode: 'championship', settings: { track: 'circuit-2' }, championship: { id: 'c', round: 3 } }))).toMatchObject({ ok: true });
    expect(parseClientMessage(JSON.stringify({ t: 'join', code: 'ABCDEF', name: 'A', expectAccount: '' }))).toMatchObject({ ok: true });
    expect(parseClientMessage(JSON.stringify({ t: 'create', name: 'A', mode: 'solo', settings: {}, expectAccount: '42' }))).toMatchObject({ ok: true });
    const bad = [
      'nope', '[]', 'null', '{}', JSON.stringify({ t: 'what' }), JSON.stringify({ t: 'ctl', seq: 0, up: true, down: false }),
      JSON.stringify({ t: 'ctl', seq: 1, up: 1, down: false }), JSON.stringify({ t: 'ctl', seq: 1, up: true }),
      JSON.stringify({ t: 'ctl', seq: 1, up: true, down: false, pos: 3 }), JSON.stringify({ t: 'act', seq: 2, type: 'win' }),
      JSON.stringify({ t: 'act', seq: 1e20, type: 'pit' }), JSON.stringify({ t: 'create', name: 'A', mode: 'ranked', settings: {} }),
      JSON.stringify({ t: 'create', name: 'A', mode: 'solo', settings: { laps: 1 } }), JSON.stringify({ t: 'create', name: 'A', mode: 'solo', settings: { aiFill: 'yes' } }),
      JSON.stringify({ t: 'create', name: 'A', mode: 'championship', settings: {}, championship: { id: 'c', round: 0 } }),
      JSON.stringify({ t: 'join', code: 'ABCDEF', name: 'x'.repeat(65) }), JSON.stringify({ t: 'join', code: 'ABCDEF', name: 'A', livery: 'gold' }),
      JSON.stringify({ t: '__proto__' }), JSON.stringify({ t: 'ping', id: 1.5 }),
      JSON.stringify({ t: 'join', code: 'ABCDEF', name: 'A', expectAccount: 42 }), JSON.stringify({ t: 'resume', room: 'r', participant: 'p', token: 't', expectAccount: '' }),
    ];
    for (const b of bad) expect(parseClientMessage(b), b).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseClientMessage(Buffer.from('{}') as unknown as string)).toMatchObject({ ok: false });
    expect(parseClientMessage(JSON.stringify({ t: 'ping', id: 1, x: 'é'.repeat(300) }))).toMatchObject({ ok: false, code: 'too_large' });
    expect(LIMITS.maxMessageBytes).toBe(512);
  });

  it('display names are cleaned and bounded, never empty', () => {
    expect(cleanName('  Ann\u0000  ‮B  ')).toBe('Ann B');
    expect(cleanName('​​')).toBe(null);
    expect([...cleanName('x'.repeat(40))!].length).toBe(LIMITS.nameMax);
  });
});

describe('online gate (browser)', () => {
  const res = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  it('is off by default and never fetches; is available only on an ok health with this protocol version', async () => {
    const f = vi.fn(() => res(200, { ok: true, protocol: PROTOCOL_VERSION, version: 'abc' }));
    expect(await probeOnline(false, f as unknown as typeof fetch, 'https://slotrush.jdwd40.com')).toEqual({ state: 'off' });
    expect(f).not.toHaveBeenCalled();
    expect(await probeOnline(true, f as unknown as typeof fetch, 'https://slotrush.jdwd40.com')).toEqual({ state: 'available', version: 'abc', wsUrl: 'wss://slotrush.jdwd40.com/ws', accounts: false });
    // sign-in is offered only when the server reports accounts and profiles (a database is attached)
    expect(await probeOnline(true, (() => res(200, { ok: true, protocol: PROTOCOL_VERSION, version: 'abc', accounts: true, profiles: true })) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'available', accounts: true });
    expect(await probeOnline(true, (() => res(200, { ok: true, protocol: PROTOCOL_VERSION, version: 'abc', accounts: true })) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'available', accounts: false });
    expect(f).toHaveBeenCalledWith('https://slotrush.jdwd40.com/api/health', expect.anything());
    expect(await probeOnline(true, (() => res(200, { ok: true, protocol: PROTOCOL_VERSION + 1 })) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('protocol') });
    expect(await probeOnline(true, (() => res(503, { ok: false })) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'unavailable', reason: 'health 503' });
    expect(await probeOnline(true, (() => res(200, { ok: false, protocol: PROTOCOL_VERSION })) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'unavailable' });
    expect(await probeOnline(true, (() => Promise.reject(new TypeError('net'))) as unknown as typeof fetch, 'https://x')).toMatchObject({ state: 'unavailable', reason: 'unreachable' });
    const hang = ((_u: string, o: { signal: AbortSignal }) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    expect(await probeOnline(true, hang, 'https://x', 20)).toMatchObject({ state: 'unavailable', reason: 'timeout' });
  });
});

describe('server configuration and logging', () => {
  it('validates and bounds every setting; production needs origins, a session secret with a database, and real time', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 8787, roomCap: 6, graceS: 20, timeScale: 1, databaseUrl: null });
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ALLOWED_ORIGINS/);
    const prod = { NODE_ENV: 'production', SLOTRUSH_ALLOWED_ORIGINS: 'https://slotrush.jdwd40.com' };
    expect(loadConfig(prod)).toMatchObject({ env: 'production', cookieSecure: true, allowedOrigins: ['https://slotrush.jdwd40.com'] });
    expect(() => loadConfig({ ...prod, SLOTRUSH_TIME_SCALE: '10' })).toThrow(/TIME_SCALE/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://x' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://x', SLOTRUSH_SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://slotrush:CHANGE_ME_DB_PASSWORD@127.0.0.1/slotrush', SLOTRUSH_SESSION_SECRET: 'x'.repeat(40) })).toThrow(/CHANGE_ME/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: 'postgres://x', SLOTRUSH_SESSION_SECRET: 'CHANGE_ME_SESSION_SECRET_padding_padding_padding' })).toThrow(/CHANGE_ME/);
    expect(() => loadConfig({ SLOTRUSH_ROOM_CAP: '0' })).toThrow(/ROOM_CAP/);
    expect(() => loadConfig({ SLOTRUSH_ROOM_CAP: '500' })).toThrow(/ROOM_CAP/);
    expect(() => loadConfig({ SLOTRUSH_RECONNECT_GRACE_S: '1' })).toThrow(/GRACE/);
    expect(() => loadConfig({ SLOTRUSH_ALLOWED_ORIGINS: 'javascript:alert(1)' })).toThrow(/origin/);
  });
  it('redacts secret-looking fields from log lines', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.info('x', { token: 'T0K', password: 'pw', sessionSecret: 's', cookie: 'c', room: 'r1' });
    expect(lines[0]).not.toMatch(/T0K|"pw"|"s"|"c"/);
    expect(JSON.parse(lines[0])).toMatchObject({ ev: 'x', room: 'r1', token: '[redacted]' });
    expect(redact({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('race-core support for the room server', () => {
  it('shared track contexts are deep-frozen, unknown ids are refused strictly, and setTrack never reaches a running race', () => {
    const t = T.trackFor('circuit-3');
    expect(Object.isFrozen(t) && Object.isFrozen(t.SWITCHES) && Object.isFrozen(t.SWITCHES[0]) && Object.isFrozen(t.SEGS) && Object.isFrozen(t.DEF)).toBe(true);
    expect(() => { (t.SWITCHES as { s0: number; s1: number }[]).push({ s0: 1, s1: 2 }); }).toThrow();
    expect(() => { (t as { L: number }).L = 1; }).toThrow();
    expect(() => { (T.BAYS as number[])[0] = 0; }).toThrow();
    expect(() => T.trackById('circuit-9')).toThrow(/unknown track/);
    expect(T.isTrackId('circuit-2')).toBe(true);
    expect(T.isTrackId('__proto__')).toBe(false);
    const r = new Race({ track: T.trackById('circuit-3'), seed: 3 });
    for (const id of T.TRACK_IDS) T.setTrack(id);
    expect(r.T.DEF.id).toBe('circuit-3');
    expect(r.fuelRate()).toBeCloseTo(1 / (t.L * 7.4), 12);
  });

  it('retire(): DNF retired, or DQ when a service breach is latched; once only; pit reservations released', () => {
    const r = new Race({ seed: 1, track: 'circuit-1', roster: [{ id: 'a', control: 'human' }, { id: 'b', control: 'human' }, { id: 'c', control: 'ai' }] });
    r.car('b')!.svcBreach = 'stopGo';
    expect(r.retire('a')).toBe(true);
    expect(r.retire('a')).toBe(false);
    expect(r.retire('b')).toBe(true);
    expect(r.retire('zz')).toBe(false);
    expect(r.car('a')).toMatchObject({ status: 'dnf', dnfReason: 'retired', finished: true });
    expect(r.car('b')).toMatchObject({ status: 'dq', dqReason: 'deadline' });
    expect(r.drainEvents().filter((e) => e.type === 'dnf' || e.type === 'dq').map((e) => [e.type, (e as { car: string }).car])).toEqual([['dnf', 'a'], ['dq', 'b']]);
    expect(r.pit.held(r.car('a')!)).toEqual([]);
    void PEN;
  });

  it('live run-on never finishes the AI field inside one update: the race keeps stepping until every car is terminal', () => {
    const mk = (runOn: 'sync' | 'live') => {
      const r = new Race({ seed: 5, track: 'circuit-1', runOn, roster: [{ id: 'h', control: 'human' }, { id: 'x', control: 'ai' }, { id: 'y', control: 'ai' }] });
      for (let i = 0; i < 600; i++) r.update(1 / 60, {});
      r.retire('h');
      return r;
    };
    const sync = mk('sync'), live = mk('live');
    for (let i = 0; i < 300; i++) { sync.update(1 / 60, {}); live.update(1 / 60, {}); }
    expect(sync.phase).toBe('done');                    // closed with a synchronous run-on of up to RUN_OUT_MAX
    expect(live.phase).toBe('racing');                  // still racing: every step stays one step
    expect(live.cars.filter((c) => c.status === 'running')).toHaveLength(2);
    let n = 0;
    while (live.phase !== 'done' && n < (RUN_OUT_MAX + 200) * 60) { live.update(1 / 60, {}); n++; }
    expect(live.phase).toBe('done');
    expect(live.final!.every((s) => s.status !== 'running' as never)).toBe(true);
    expect(live.final!.find((s) => s.id === 'h')).toMatchObject({ status: 'dnf', dnfReason: 'retired' });
  });
});
