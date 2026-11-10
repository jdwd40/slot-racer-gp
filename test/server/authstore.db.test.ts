// Sign-in and registration when PostgreSQL refuses the session write (#51), against a real PostgreSQL in its own schema.
// The failure is a real database error: a trigger that raises on INSERT into (save) or DELETE from (regeneration) the
// sessions table, so account lookup and the password check still work. Dropping the trigger is the store coming back.
// Local: `npm run test:db`; CI: the postgres:17 service container. Skipped when SLOTRUSH_TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import pg from 'pg';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { migrate } from '../../server/migrations';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { OnlineClient, type SocketCtor } from '../../src/net/client';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';
const SCHEMA = 't_authstore';
const SECRET = 'test-session-secret-0123456789abcdef';

type Me = { account: { id: string; username: string } | null; profile?: { displayName: string } | null; session: string };

describe.skipIf(!URL)('PostgreSQL: sign-in and registration when the session write fails', () => {
  let pool: pg.Pool;
  let app: App;
  let mgr: RoomManager;
  let base = '';
  const log = memoryLogger();

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` });
    await migrate(pool);
    await pool.query(`CREATE FUNCTION refuse_session_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected session store failure (%)', TG_OP; END $$`);
    const cfg = testConfig({ port: 0, databaseUrl: URL!, sessionSecret: SECRET, cookieSecure: false });
    mgr = new RoomManager({ cfg, log, sink: new MemoryResultSink() });
    app = createApp({ cfg, log, manager: mgr, pool, sessionCheckMs: 200 });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
    mgr.start();
  });
  afterAll(async () => { mgr?.shutdown(); await app?.close(); await pool?.end(); });
  afterEach(async () => { await heal(); });

  /**
   * Make the session table refuse INSERTs ('save') or DELETEs ('regenerate': the old session's removal). Per statement, so a
   * DELETE of a session ID that has no row (a browser with no cookie yet) fails too, as it would with the database down.
   */
  const breakStore = (op: 'INSERT' | 'DELETE') => pool.query(`CREATE TRIGGER refuse_${op.toLowerCase()} BEFORE ${op} ON sessions FOR EACH STATEMENT EXECUTE FUNCTION refuse_session_write()`);
  const heal = () => pool.query('DROP TRIGGER IF EXISTS refuse_insert ON sessions; DROP TRIGGER IF EXISTS refuse_delete ON sessions');

  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
  const me = async (cookie: string): Promise<Me> => (await (await fetch(`${base}/api/auth/me`, { headers: cookie ? { cookie } : {} })).json()) as Me;
  const sessionRows = async (username: string) => Number((await pool.query(
    'SELECT count(*) FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.username_key = $1', [username])).rows[0].count);
  const login = (u: string, cookie = '') => post('/api/auth/login', { username: u, password: `${u} password 1` }, cookie);
  const register = (u: string, extra: Record<string, unknown> = {}) => post('/api/auth/register', { username: u, password: `${u} password 1`, ...extra });
  async function socket(cookie: string) {
    const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, cookie } }).recordHistory();
    await c.connect();
    return c;
  }
  const closed = async (c: OnlineClient) => { for (let i = 0; i < 80 && !c.closed; i++) await new Promise((r) => setTimeout(r, 25)); return c.closed; };
  async function expect503(r: Response, body: Record<string, unknown>) {
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual(body);
    expect(text).not.toMatch(/injected|session store failure|postgres/i);
  }

  it('signs up, signs in and the next /me is that account while the store works', async () => {
    const r = await register('anna');
    expect(r.status).toBe(201);
    expect(await me(cookieOf(r))).toMatchObject({ account: { username: 'anna' }, session: 'active' });
    expect((await register('ben')).status).toBe(201);
    const l = await login('anna');
    expect(l.status).toBe(200);
    expect(await me(cookieOf(l))).toMatchObject({ account: { username: 'anna' }, profile: { displayName: 'anna' }, session: 'active' });
  });

  it('save fails: 503, the old session and its socket end, the cookie is cleared, no new row; signs in once the store is back', async () => {
    const a = cookieOf(await login('anna'));
    const sock = await socket(a);
    const annaRows = await sessionRows('anna'), benRows = await sessionRows('ben');
    await breakStore('INSERT');
    const r = await login('ben', a);
    await expect503(r, { error: 'unavailable' });
    expect(r.headers.getSetCookie()).toEqual([expect.stringMatching(/^srsid=; .*Max-Age=0/)]);
    expect(await sessionRows('ben')).toBe(benRows);
    expect(await sessionRows('anna')).toBe(annaRows - 1);   // rotation went ahead: the old session is gone
    expect(await closed(sock)).toMatchObject({ code: 4003 });
    expect(await me(a)).toEqual({ account: null, session: 'expired' });
    await heal();
    const ok = await login('ben');
    expect(ok.status).toBe(200);
    expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'ben' }, session: 'active' });
    expect(await sessionRows('ben')).toBe(benRows + 1);
  });

  it('regeneration fails: 503, no cookie, the old session and its socket stay signed in; the retry rotates it', async () => {
    const a = cookieOf(await login('anna'));
    const sock = await socket(a);
    const benRows = await sessionRows('ben');
    await breakStore('DELETE');
    const r = await login('ben', a);
    await expect503(r, { error: 'unavailable' });
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(await me(a)).toMatchObject({ account: { username: 'anna' }, session: 'active' });
    expect(await sessionRows('ben')).toBe(benRows);
    await new Promise((res) => setTimeout(res, 500));   // a couple of socket session checks
    expect(sock.closed).toBe(null);
    await heal();
    const ok = await login('ben', a);
    expect(ok.status).toBe(200);
    expect(await closed(sock)).toMatchObject({ code: 4003 });
    expect(await me(a)).toEqual({ account: null, session: 'expired' });
    expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'ben' } });
  });

  it('registration: the account and profile are kept when the session cannot be stored; sign-in works once the store is back', async () => {
    for (const [op, u] of [['INSERT', 'cara'], ['DELETE', 'dev']] as const) {
      await breakStore(op);
      const r = await register(u, { displayName: `${u} GP` });
      await expect503(r, { error: 'unavailable', detail: 'account_created' });
      expect(r.headers.getSetCookie()).toEqual([]);
      const row = (await pool.query<{ display_name: string }>('SELECT p.display_name FROM accounts a JOIN profiles p ON p.account_id = a.id WHERE a.username_key = $1', [u])).rows;
      expect(row).toEqual([{ display_name: `${u} GP` }]);
      expect(await sessionRows(u)).toBe(0);
      await heal();
      expect((await register(u)).status).toBe(409);
      const ok = await login(u);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ account: { username: u }, profile: { displayName: `${u} GP` }, session: 'active' });
      expect(await me(cookieOf(ok))).toMatchObject({ account: { username: u }, session: 'active' });
    }
  });

  it('logs each failure by step with the database error, never a password, cookie or session ID', async () => {
    const fails = log.lines.filter((l) => l.includes('auth.session_failed'));
    expect(fails.some((l) => l.includes('"step":"save"') && l.includes('injected session store failure (INSERT)'))).toBe(true);
    expect(fails.some((l) => l.includes('"step":"regenerate"') && l.includes('injected session store failure (DELETE)'))).toBe(true);
    const sids = (await pool.query<{ sid: string }>('SELECT sid FROM sessions')).rows.map((r) => r.sid);
    for (const line of log.lines) {
      expect(line).not.toMatch(/password 1|srsid=|s%3A/);
      for (const sid of sids) expect(line).not.toContain(sid);
    }
  });
});
