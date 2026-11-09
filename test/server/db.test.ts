// Database-backed parts of the server, against a real PostgreSQL (local: `npm run test:db`, which starts a private
// cluster; CI: a postgres:17 service container). Skipped when SLOTRUSH_TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import pg from 'pg';
import { createApp, type App } from '../../server/app';
import { run } from '../../server/admin';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { migrate, schemaStatus, MIGRATIONS } from '../../server/migrations';
import { PgResultSink, ResultConflict } from '../../server/results';
import { buildEnvelope } from '../../server/envelope';
import { RoomManager } from '../../server/rooms';
import { OnlineClient, type SocketCtor } from '../../src/net/client';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';

describe.skipIf(!URL)('PostgreSQL: migrations, accounts, sessions, admin reset and results', () => {
  let pool: pg.Pool;
  let app: App;
  let base = '';
  const log = memoryLogger();
  const sink = { stored: [] as string[] };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 3 });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const cfg = testConfig({ port: 0, databaseUrl: URL!, sessionSecret: 'test-session-secret-0123456789abcdef', cookieSecure: false });
    const mgr = new RoomManager({ cfg, log, sink: new PgResultSink(pool) });
    void sink;
    app = createApp({ cfg, log, manager: mgr, pool });
    // the service refuses an unmigrated schema: health reports it before migration
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    mgr.start();
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
  const me = async (cookie: string) => ((await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as { account: { username: string } | null }).account;

  it('health is 503 until migrated; migrations apply once, are recorded with checksums and a changed one is refused', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(503);
    expect(await migrate(pool)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(pool)).toEqual([]);
    expect(await schemaStatus(pool)).toMatchObject({ current: true, missing: [] });
    const h = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ ok: true, db: 'ok', accounts: true });
    await pool.query("UPDATE schema_migrations SET checksum = 'x' WHERE id = $1", [MIGRATIONS[0].id]);
    await expect(migrate(pool)).rejects.toThrow(/changed/);
    expect((await schemaStatus(pool)).current).toBe(false);
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool);
    // no email or other contact column exists anywhere
    const cols = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'");
    expect(cols.rows.map((r) => r.column_name).filter((c) => /mail|phone|contact/i.test(c))).toEqual([]);
  });

  it('register and log in with username/password: Argon2id hashes, HttpOnly SameSite=Strict session cookie, a new session per sign-in', async () => {
    const r = await post('/api/auth/register', { username: 'Alice_1', password: 'correct horse battery' });
    expect(r.status).toBe(201);
    const set = r.headers.getSetCookie()[0];
    expect(set).toMatch(/^srsid=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    const c1 = cookieOf(r);
    expect(await me(c1)).toMatchObject({ username: 'alice_1' });
    expect((await post('/api/auth/register', { username: 'ALICE_1', password: 'another password' })).status).toBe(409);
    expect((await post('/api/auth/login', { username: 'alice_1', password: 'wrong password!!' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'nobody_here', password: 'wrong password!!' })).status).toBe(401);
    const l = await post('/api/auth/login', { username: 'Alice_1', password: 'correct horse battery' });
    expect(l.status).toBe(200);
    expect(cookieOf(l)).not.toBe(c1);
    const row = (await pool.query<{ password_hash: string }>("SELECT password_hash FROM accounts WHERE username_key = 'alice_1'")).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    for (const line of log.lines) expect(line).not.toContain('correct horse battery');
    // logout ends that session
    const c2 = cookieOf(l);
    expect((await post('/api/auth/logout', {}, { cookie: c2 })).status).toBe(200);
    expect(await me(c2)).toBe(null);
  });

  it('refuses cross-origin, non-JSON, oversized, malformed and weak requests', async () => {
    expect((await post('/api/auth/register', { username: 'bob_1', password: 'long enough pw' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await post('/api/auth/register', JSON.stringify({ username: 'bob_1', password: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await post('/api/auth/register', { username: 'bob_1', password: 'long enough pw', email: 'a@b.c' })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'b', password: 'long enough pw' })).status).toBe(400);
    expect((await post('/api/auth/register', { username: 'bob_1', password: 'short' })).status).toBe(400);
  });

  it('a signed-in player joins as an account seat, and the result envelope records the account id', async () => {
    const r = await post('/api/auth/register', { username: 'carol', password: 'carol password 1' });
    const cookie = cookieOf(r);
    const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, cookie } });
    await c.connect();
    const j = await c.request({ t: 'create', name: 'Carol', mode: 'solo', settings: {} });
    expect(j).toMatchObject({ t: 'joined' });
    expect(c.room!.participants[0].guest).toBe(false);
    c.send({ t: 'start' });
    await c.wait((m) => m.t === 'state');
    c.send({ t: 'leave' });
    await c.wait((m) => m.t === 'bye');
    c.close();
    const id = (await pool.query<{ id: string }>("SELECT id::text FROM accounts WHERE username_key = 'carol'")).rows[0].id;
    // the race runs on to its end without the driver; then its one envelope is stored
    let rows: { envelope: { participants: { accountId: string | null; control: string }[]; outcome: string } }[] = [];
    for (let i = 0; i < 400 && !rows.length; i++) { await new Promise((res) => setTimeout(res, 100)); rows = (await pool.query('SELECT envelope FROM race_results WHERE mode = $1', ['solo'])).rows; }
    expect(rows).toHaveLength(1);
    expect(rows[0].envelope.participants.find((p) => p.control === 'human')!.accountId).toBe(id);
  }, 60_000);

  it('the owner reset sets a new password, signs every session of that account out, and can generate the password', async () => {
    const r = await post('/api/auth/register', { username: 'dave', password: 'dave password 1' });
    const old = cookieOf(r);
    const l2 = cookieOf(await post('/api/auth/login', { username: 'dave', password: 'dave password 1' }));
    expect(await me(old)).toMatchObject({ username: 'dave' });
    const out: string[] = [], err: string[] = [];
    const io = (stdin: string) => ({ stdin: async () => stdin, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
    expect(await run(['reset-password', 'Dave'], pool, io('brand new password 9\n'))).toBe(0);
    expect(out.at(-1)).toMatch(/2 session\(s\) signed out/);
    expect(await me(old)).toBe(null);
    expect(await me(l2)).toBe(null);
    expect((await post('/api/auth/login', { username: 'dave', password: 'dave password 1' })).status).toBe(401);
    expect((await post('/api/auth/login', { username: 'dave', password: 'brand new password 9' })).status).toBe(200);
    // generated password, shown once
    expect(await run(['reset-password', 'dave'], pool, io(''))).toBe(0);
    const gen = /: ([A-Za-z0-9]{20})$/.exec(out.at(-1)!)![1];
    expect((await post('/api/auth/login', { username: 'dave', password: gen })).status).toBe(200);
    expect(await run(['reset-password', 'nobody_x'], pool, io('whatever password'))).toBe(1);
    expect(await run(['reset-password', 'dave'], pool, io('short'))).toBe(2);
    expect(await run(['status'], pool, io(''))).toBe(0);
    expect(await run(['bogus'], pool, io(''))).toBe(2);
    for (const line of log.lines) expect(line).not.toContain(gen);
  });

  it('result storage is idempotent by race id and immutable: the same envelope is a duplicate, a different one a conflict', async () => {
    const s = new PgResultSink(pool);
    const e = buildEnvelope({
      raceId: '11111111-1111-4111-8111-111111111111', roomId: '22222222-2222-4222-8222-222222222222', mode: 'multiplayer', championship: null,
      outcome: 'completed', abortReason: null, trackId: 'circuit-1', settings: { track: 'circuit-1', aiFill: false },
      participants: [], classification: [], laps: [],
      times: { roomCreatedAt: 'a', startedAt: 'b', greenAt: null, finishedAt: 'c', raceTimeS: 1, ticks: 1 },
    });
    expect(await s.consume(e)).toBe('stored');
    expect(await s.consume(e)).toBe('duplicate');
    const other = buildEnvelope({ ...e, trackId: 'circuit-1', outcome: 'aborted', abortReason: 'x' } as never);
    await expect(s.consume(other)).rejects.toBeInstanceOf(ResultConflict);
    await expect(pool.query("UPDATE race_results SET outcome = 'aborted' WHERE race_id = $1", [e.raceId])).rejects.toThrow(/immutable/);
    expect((await pool.query('SELECT count(*)::int AS n FROM race_results WHERE race_id = $1', [e.raceId])).rows[0].n).toBe(1);
  });
});
