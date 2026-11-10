// Sign-in and registration when the session store fails (#51). The account check passes, but the new session cannot be
// stored: either the old session's removal (regeneration) or the new session's INSERT (save) fails. The server must then
// answer with an honest 503, set no cookie for a session that does not exist, leave the previous session coherent, and sign
// in normally once the store is back. Runs without PostgreSQL: an in-memory pool answers the few statements the account
// and session code sends, and each statement kind can be made to fail on its own. The same flows run against a real
// PostgreSQL in authstore.db.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import argon2 from 'argon2';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { createApp, type App } from '../../server/app';
import { HASH_OPTS } from '../../server/accounts';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { OnlineClient, type SocketCtor } from '../../src/net/client';

const ORIGIN = 'http://localhost:5173';
const SECRET = 'test-session-secret-0123456789abcdef';
/** a driver error carrying a credential-looking URL: it must never reach a response or (unmasked) a log line */
const DB_ERROR = 'connect ECONNREFUSED postgres://slotrush:db-pass-hunter2@10.0.0.9:5432/slotrush';

type Kind = 'session.get' | 'session.insert' | 'session.delete' | 'session.touch' | 'session.live' | 'account.login' | 'account.register' | 'account.profile' | 'other';
const kindOf = (sql: string): Kind =>
  /SELECT sess FROM sessions/.test(sql) ? 'session.get'
    : /INSERT INTO sessions/.test(sql) ? 'session.insert'
      : /DELETE FROM sessions WHERE sid/.test(sql) ? 'session.delete'
        : /UPDATE sessions SET expires_at/.test(sql) ? 'session.touch'
          : /FROM sessions s JOIN unnest/.test(sql) ? 'session.live'
            : /FROM accounts WHERE username_key/.test(sql) ? 'account.login'
              : /INSERT INTO accounts/.test(sql) ? 'account.register'
                : /COALESCE\(p\.display_name/.test(sql) ? 'account.profile' : 'other';

/** The statements the account and session code sends, on Maps; `fail` makes chosen statement kinds reject. */
function memoryPool() {
  const accounts = new Map<string, { id: string; username: string; hash: string; name: string }>();
  const sessions = new Map<string, { accountId: string | null; sess: unknown; expires: number }>();
  const fail = new Map<Kind, number>();   // kind -> remaining failures (Infinity: until cleared)
  const attempts: Kind[] = [];
  let n = 0;
  const rows = <T>(r: T[]) => Promise.resolve({ rows: r, rowCount: r.length });
  const query = (sql: string, p: unknown[] = []) => {
    const k = kindOf(sql);
    attempts.push(k);
    const left = fail.get(k) ?? 0;
    if (left > 0) { fail.set(k, left - 1); return Promise.reject(new Error(DB_ERROR)); }
    switch (k) {
      case 'session.get': { const s = sessions.get(p[0] as string); return rows(s && s.expires > Date.now() ? [{ sess: s.sess }] : []); }
      case 'session.insert': sessions.set(p[0] as string, { accountId: (p[1] as string | null), sess: JSON.parse(p[2] as string), expires: (p[3] as Date).getTime() }); return rows([]);
      case 'session.delete': sessions.delete(p[0] as string); return rows([]);
      case 'session.touch': return rows([]);
      case 'session.live': {
        const [sids, ids] = p as [string[], string[]];
        return rows(sids.filter((sid, i) => sessions.get(sid)?.accountId === ids[i] && sessions.get(sid)!.expires > Date.now()).map((sid) => ({ sid })));
      }
      case 'account.login': { const a = accounts.get(p[0] as string); return rows(a ? [{ id: a.id, username: a.username, password_hash: a.hash }] : []); }
      case 'account.register': {
        const key = p[0] as string;
        if (accounts.has(key)) return rows([]);
        const a = { id: String(++n), username: key, hash: p[1] as string, name: p[2] as string };
        accounts.set(key, a);
        return rows([{ id: a.id, username: a.username }]);
      }
      case 'account.profile': { const a = [...accounts.values()].find((x) => x.id === p[0]); return rows(a ? [{ id: a.id, display_name: a.name, updated_at: null }] : []); }
      default: return Promise.reject(new Error(`unexpected statement: ${sql.slice(0, 60)}`));
    }
  };
  const pool = { query, connect: () => Promise.reject(new Error('no transactions here')), end: () => Promise.resolve() } as unknown as Pool;
  return { pool, accounts, sessions, fail, attempts };
}

const db = memoryPool();
const log = memoryLogger();
const cfg = testConfig({ port: 0, databaseUrl: 'postgres://unused', sessionSecret: SECRET, cookieSecure: false });
const mgr = new RoomManager({ cfg, log, sink: new MemoryResultSink() });
let app: App;
let base = '';

beforeAll(async () => {
  app = createApp({ cfg, log, manager: mgr, pool: db.pool, sessionCheckMs: 100 });
  base = `http://127.0.0.1:${(await app.listen()).port}`;
  mgr.start();
  // an existing account to sign in to (hashed like a real one: the password check really runs)
  for (const u of ['alice', 'bob']) db.accounts.set(u, { id: String(900 + db.accounts.size), username: u, hash: await argon2.hash(`${u} password 1`, HASH_OPTS), name: u.toUpperCase() });
});
afterAll(async () => { mgr.shutdown(); await app.close(); });
beforeEach(() => { db.fail.clear(); });

const post = (path: string, body: unknown, cookie = '') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
const me = async (cookie: string) => (await (await fetch(`${base}/api/auth/me`, { headers: cookie ? { cookie } : {} })).json()) as { account: { username: string } | null; session: string };
const login = (u: string, cookie = '') => post('/api/auth/login', { username: u, password: `${u} password 1` }, cookie);
/** a browser's cookie after this response: a new one if set (a clearing cookie leaves it empty), else unchanged */
const jar = (prev: string, r: Response): string => (r.headers.getSetCookie().length ? cookieOf(r).replace(/^srsid=$/, '') : prev);
const sessionsOf = (accountId: string) => [...db.sessions.values()].filter((s) => s.accountId === accountId).length;
const idOf = (u: string) => db.accounts.get(u)!.id;

async function socket(cookie: string) {
  const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } }).recordHistory();
  await c.connect();
  return c;
}
async function seatIsGuest(cookie: string): Promise<boolean> {
  const c = await socket(cookie);
  const j = await c.request({ t: 'create', name: 'X', mode: 'solo', settings: {} });
  expect(j).toMatchObject({ t: 'joined' });
  const guest = c.room!.participants[0].guest;
  c.send({ t: 'leave' });
  c.close();
  return guest;
}
const waitClosed = async (c: OnlineClient) => { for (let i = 0; i < 60 && !c.closed; i++) await new Promise((r) => setTimeout(r, 25)); return c.closed; };

/** the failed response is an honest service error: no identity, no session claim, no database detail, no new cookie */
async function expectUnavailable(r: Response, body: Record<string, unknown> = { error: 'unavailable' }) {
  expect(r.status).toBe(503);
  const text = await r.text();
  expect(JSON.parse(text)).toEqual(body);
  expect(text).not.toMatch(/ECONNREFUSED|hunter2|postgres/);
  for (const c of r.headers.getSetCookie()) expect(c).toMatch(/^srsid=; .*Max-Age=0/);   // at most a clearing cookie
}

describe('sign-in when the session store fails', () => {
  it('signs in and registers normally while the store works: cookie, profile, and the next /me is the same account', async () => {
    const l = await login('alice');
    expect(l.status).toBe(200);
    expect(await l.json()).toMatchObject({ account: { username: 'alice' }, profile: { displayName: 'ALICE' }, session: 'active' });
    expect(await me(cookieOf(l))).toMatchObject({ account: { username: 'alice' }, session: 'active' });
    const r = await post('/api/auth/register', { username: 'carol', password: 'carol password 1' });
    expect(r.status).toBe(201);
    expect(await me(cookieOf(r))).toMatchObject({ account: { username: 'carol' }, session: 'active' });
    expect(await seatIsGuest(cookieOf(r))).toBe(false);
  });

  it('login: the session INSERT fails -> 503, no cookie, no session; the next /me is signed out; it signs in once the store is back', async () => {
    const before = sessionsOf(idOf('bob'));
    db.fail.set('session.insert', Infinity);
    const r = await login('bob');
    await expectUnavailable(r);
    expect(r.headers.getSetCookie()).toEqual([]);   // the browser had no cookie: nothing to clear, nothing new
    expect(sessionsOf(idOf('bob'))).toBe(before);
    // the server tried the write once, not again when the response ended
    expect(db.attempts.filter((k) => k === 'session.insert').length).toBeGreaterThan(0);
    const tries = db.attempts.length;
    expect(await me(jar('', r))).toEqual({ account: null, session: 'none' });
    expect(await seatIsGuest(jar('', r))).toBe(true);
    expect(db.attempts.slice(tries).filter((k) => k === 'session.insert')).toEqual([]);
    // recovery
    db.fail.clear();
    const ok = await login('bob');
    expect(ok.status).toBe(200);
    expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'bob' }, session: 'active' });
    expect(sessionsOf(idOf('bob'))).toBe(before + 1);
  });

  it('login over a live session: regeneration fails -> 503, the old session and its socket carry on untouched; the retry rotates it', async () => {
    const a = cookieOf(await login('alice'));
    const sock = await socket(a);
    db.fail.set('session.delete', Infinity);
    const r = await login('bob', a);
    await expectUnavailable(r);
    expect(r.headers.getSetCookie()).toEqual([]);   // the old session may still exist: its cookie is kept
    expect(await me(a)).toMatchObject({ account: { username: 'alice' }, session: 'active' });
    await new Promise((res) => setTimeout(res, 300));   // several session checks
    expect(sock.closed).toBe(null);
    // the store is back: the retry ends the old session and its socket, and signs in as bob
    db.fail.clear();
    const ok = await login('bob', a);
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).not.toBe(a);
    expect(await waitClosed(sock)).toMatchObject({ code: 4003 });
    expect(await me(a)).toEqual({ account: null, session: 'expired' });
    expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'bob' } });
  });

  it('login over a live session: regeneration succeeds but the new session cannot be saved -> 503, old session ended and cleared, no new one', async () => {
    const a = cookieOf(await login('alice'));
    const sock = await socket(a);
    const bobBefore = sessionsOf(idOf('bob'));
    db.fail.set('session.insert', Infinity);
    const r = await login('bob', a);
    await expectUnavailable(r);
    // the old session row is gone, so its cookie is cleared rather than left naming nothing; its socket is signed out
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(await waitClosed(sock)).toMatchObject({ code: 4003 });
    expect(sock.received.find((m) => m.t === 'bye')).toMatchObject({ code: 'expired', detail: 'session' });
    expect(await me(a)).toEqual({ account: null, session: 'expired' });
    expect(jar(a, r)).toBe('');
    expect(sessionsOf(idOf('bob'))).toBe(bobBefore);
    db.fail.clear();
    const ok = await login('bob');
    expect(ok.status).toBe(200);
    expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'bob' } });
  });

  it('a one-off store failure needs no restart: the very next attempt succeeds', async () => {
    for (const k of ['session.delete', 'session.insert'] as const) {
      const a = cookieOf(await login('alice'));
      db.fail.set(k, 1);
      await expectUnavailable(await login('alice', a));
      const ok = await login('alice', a);
      expect(ok.status, k).toBe(200);
      expect(await me(cookieOf(ok))).toMatchObject({ account: { username: 'alice' } });
    }
  });

  it('registration: the account is kept when its session cannot be stored; the reply says so, and signing in works once the store is back', async () => {
    for (const [k, u] of [['session.insert', 'dora'], ['session.delete', 'evan']] as const) {
      db.fail.set(k, Infinity);
      const r = await post('/api/auth/register', { username: u, password: `${u} password 1`, displayName: `${u} Racer` });
      await expectUnavailable(r, { error: 'unavailable', detail: 'account_created' });
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(db.accounts.has(u)).toBe(true);   // legitimate data is not rolled back
      expect(sessionsOf(idOf(u))).toBe(0);
      expect(await me(jar('', r))).toEqual({ account: null, session: 'none' });
      db.fail.clear();
      // registering again is "taken" (it exists); signing in with the same details works
      expect((await post('/api/auth/register', { username: u, password: `${u} password 1` })).status).toBe(409);
      const ok = await login(u);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ account: { username: u }, profile: { displayName: `${u} Racer` } });
    }
  });

  it('a profile read failing after the session was stored still reports the sign-in that did happen (no 500 with a live cookie)', async () => {
    db.fail.set('account.profile', 1);
    const r = await login('alice');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ account: { username: 'alice' }, profile: null, session: 'active' });
    expect(await me(cookieOf(r))).toMatchObject({ account: { username: 'alice' }, session: 'active' });
  });

  it('a wrong password is still a plain 401 and never touches the session store', async () => {
    db.fail.set('session.insert', Infinity);
    db.fail.set('session.delete', Infinity);
    const r = await post('/api/auth/login', { username: 'alice', password: 'not the password' });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('logs the failure step without passwords, cookies, session IDs or the database credentials', () => {
    const fails = log.lines.filter((l) => l.includes('auth.session_failed'));
    expect(fails.some((l) => l.includes('"step":"regenerate"'))).toBe(true);
    expect(fails.some((l) => l.includes('"step":"save"'))).toBe(true);
    const sids = [...db.sessions.keys()];
    for (const line of log.lines) {
      expect(line).not.toMatch(/password 1|hunter2|srsid=|s%3A/);
      for (const sid of sids) expect(line).not.toContain(sid);
    }
  });
});
