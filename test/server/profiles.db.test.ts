// Driver profiles and account ownership (#24), against a real PostgreSQL in its own schema (so it runs beside db.test.ts).
// Local: `npm run test:db`; CI: the postgres:17 service container. Skipped when SLOTRUSH_TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import pg from 'pg';
import { createApp, type App } from '../../server/app';
import { testConfig, type Config } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { migrate, MIGRATIONS } from '../../server/migrations';
import { PgResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import type { PublicRoom, ServerMsg } from '../../src/net/protocol';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';
const SCHEMA = 't_profiles';
const SECRET = 'test-session-secret-0123456789abcdef';

type Me = { account: { id: string; username: string } | null; profile?: { displayName: string; updatedAt: string | null } | null; session: string };

describe.skipIf(!URL)('PostgreSQL: driver profiles, ownership, session lifecycle and race identity', () => {
  const pools: pg.Pool[] = [];
  let pool: pg.Pool;
  let app: App;
  let mgr: RoomManager;
  let base = '';
  let cfg: Config;
  const log = memoryLogger();
  let ipN = 0;
  /** each test speaks from its own address unless it is testing address limits */
  let ip = '10.0.0.1';
  const newPool = (): pg.Pool => { const p = new pg.Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` }); pools.push(p); return p; };

  async function boot(): Promise<void> {
    pool = newPool();
    mgr = new RoomManager({ cfg, log, sink: new PgResultSink(pool) });
    app = createApp({ cfg, log, manager: mgr, pool, sessionCheckMs: 300 });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
    mgr.start();
  }
  async function halt(): Promise<void> { mgr.shutdown('shutdown'); await app.close(); }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    cfg = testConfig({ port: 0, databaseUrl: URL!, sessionSecret: SECRET, cookieSecure: false, timeScale: 20, maxCatchUpSteps: 120, graceS: 5, maxConnectionsPerIp: 40 });
    await boot();
  });
  afterAll(async () => { await halt().catch(() => undefined); for (const p of pools) await p.end().catch(() => undefined); });

  const req = (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': ip, ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    });
  const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
  const me = async (cookie: string): Promise<Me> => (await (await req('/api/auth/me', { cookie })).json()) as Me;
  const register = async (username: string, password = `${username} password 1`, displayName?: string): Promise<{ cookie: string; id: string }> => {
    const r = await req('/api/auth/register', { body: { username, password, ...(displayName !== undefined ? { displayName } : {}) } });
    expect(r.status).toBe(201);
    return { cookie: cookieOf(r), id: ((await r.json()) as Me).account!.id };
  };
  const login = async (username: string, password = `${username} password 1`): Promise<string> => {
    const r = await req('/api/auth/login', { body: { username, password } });
    expect(r.status).toBe(200);
    return cookieOf(r);
  };
  const rename = (cookie: string, displayName: unknown, extra: Record<string, unknown> = {}) => req('/api/profile', { cookie, body: { displayName, ...extra } });
  const socket = async (cookie: string): Promise<OnlineClient> => {
    const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
    await c.connect();
    return c;
  };
  const waitFor = async (f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
    for (let t = 0; t < ms; t += 50) { if (await f()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('timed out');
  };
  const nextIp = (): void => { ip = `10.0.${++ipN}.1`; };

  it('migration 002 adds profiles to an existing 001 database and backfills every account from its username', async () => {
    // a database as an earlier release left it: only 001 applied, with accounts and no profiles
    const c = await pool.connect();
    try {
      await c.query('CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      await c.query(MIGRATIONS[0].sql);
      const { createHash } = await import('node:crypto');
      await c.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [MIGRATIONS[0].id, createHash('sha256').update(MIGRATIONS[0].sql).digest('hex')]);
      await c.query("INSERT INTO accounts (username, username_key, password_hash) VALUES ('legacy_driver_name1', 'legacy_driver_name1', 'x')");
    } finally { c.release(); }
    expect((await req('/api/health')).status).toBe(503);   // the running build needs 002
    expect(await migrate(pool)).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
    const row = (await pool.query("SELECT p.display_name FROM profiles p JOIN accounts a ON a.id = p.account_id WHERE a.username_key = 'legacy_driver_name1'")).rows[0];
    expect(row.display_name).toBe('legacy_driver_na');   // 16 characters
    expect(((await (await req('/api/health')).json()) as Record<string, unknown>)).toMatchObject({ ok: true, profiles: true, schema: MIGRATIONS.at(-1)!.id });
    // the database itself refuses blank, padded and over-long names, whatever the application does
    const id = (await pool.query("SELECT id FROM accounts WHERE username_key = 'legacy_driver_name1'")).rows[0].id;
    for (const bad of ['', ' x', 'x ', 'a'.repeat(17), 'a\tb']) await expect(pool.query('UPDATE profiles SET display_name = $2 WHERE account_id = $1', [id, bad])).rejects.toThrow(/profiles_display_name_shape/);
  });

  it('register gives a stable id and a profile; a clean second browser signs in to the same profile', async () => {
    nextIp();
    const a = await register('pia_racer', 'pia password 123', '  Pía   Racer ');
    const m = await me(a.cookie);
    expect(m).toMatchObject({ account: { id: a.id, username: 'pia_racer' }, profile: { displayName: 'Pía Racer' }, session: 'active' });
    // a second browser: no cookie of its own until it signs in
    expect(await me('')).toEqual({ account: null, session: 'none' });
    const b = await login('PIA_RACER', 'pia password 123');
    expect(b).not.toBe(a.cookie);
    expect(await me(b)).toMatchObject({ account: { id: a.id }, profile: { displayName: 'Pía Racer' } });
    // renamed in the second browser: the first sees it too, under the same id
    expect((await rename(b, 'Pia R')).status).toBe(200);
    expect(await me(a.cookie)).toMatchObject({ account: { id: a.id }, profile: { displayName: 'Pia R' } });
    expect(((await (await req('/api/profile', { cookie: a.cookie })).json()) as { profile: unknown }).profile).toMatchObject({ displayName: 'Pia R' });
    // no default name given: the username
    nextIp();
    expect((await me((await register('quinn_x')).cookie)).profile!.displayName).toBe('quinn_x');
  });

  it('duplicate usernames: one account per name, case-insensitively, even for simultaneous registrations', async () => {
    nextIp();
    const tries = await Promise.all([0, 1, 2, 3].map((i) => req('/api/auth/register', { body: { username: i % 2 ? 'Rae_Dup' : 'rae_dup', password: `rae password ${i}xx` } })));
    expect(tries.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts WHERE username_key = 'rae_dup'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM profiles p JOIN accounts a ON a.id = p.account_id WHERE a.username_key = 'rae_dup'")).rows[0].n).toBe(1);
    const dup = tries.find((r) => r.status === 409)!;
    expect(await dup.json()).toEqual({ error: 'username_taken' });
    expect(dup.headers.getSetCookie()).toEqual([]);
  });

  it('display names: normalized, blank/long/AI-like refused, HTML-like text stored verbatim (rendered as text by the client)', async () => {
    nextIp();
    const { cookie } = await register('sam_names');
    for (const [raw, err] of [['', 'blank'], ['   ', 'blank'], ['​‮', 'blank'], ['x'.repeat(17), 'too_long'], ['Gold Flash (AI)', 'reserved'], [42, 'type'], [null, 'type']] as const) {
      const r = await rename(cookie, raw);
      expect(r.status, String(raw)).toBe(400);
      expect(await r.json()).toEqual({ error: 'invalid_name', detail: err });
    }
    expect((await me(cookie)).profile!.displayName).toBe('sam_names');
    const html = '<b>x</b>&amp;"\'';
    expect(((await (await rename(cookie, html)).json()) as Me).profile!.displayName).toBe(html);
    expect((await me(cookie)).profile!.displayName).toBe(html);
    // control and bidi characters are removed, a 16-character emoji name fits
    expect(((await (await rename(cookie, 'a\u0007b‮c⁦')).json()) as Me).profile!.displayName).toBe('abc');
    expect(((await (await rename(cookie, '🏎️'.repeat(8))).json()) as Me).profile!.displayName).toBe('🏎️'.repeat(8));
    // register refuses a bad name before creating anything
    expect((await req('/api/auth/register', { body: { username: 'sam_names2', password: 'long enough pw', displayName: ' ' } })).status).toBe(400);
    expect((await req('/api/auth/register', { body: { username: 'sam_names3', password: 'long enough pw', displayName: 'y'.repeat(30) } })).status).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM accounts WHERE username_key IN ('sam_names2', 'sam_names3')")).rows[0].n).toBe(0);
  });

  it('ownership comes from the session: no cookie, a foreign origin, an accountId field or another account cannot read or write a profile', async () => {
    nextIp();
    const a = await register('tess_own', undefined, 'Tess');
    const b = await register('uma_own', undefined, 'Uma');
    expect((await req('/api/profile')).status).toBe(401);
    expect(await (await req('/api/profile')).json()).toEqual({ error: 'signed_out' });
    expect((await rename('', 'Hacker')).status).toBe(401);
    // spoofing: B names A's account id; refused outright, and neither profile changes
    for (const extra of [{ accountId: a.id }, { account_id: a.id }, { id: a.id }, { username: 'tess_own' }]) {
      const r = await rename(b.cookie, 'Not Tess', extra);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'malformed' });
    }
    expect((await me(a.cookie)).profile!.displayName).toBe('Tess');
    expect((await me(b.cookie)).profile!.displayName).toBe('Uma');
    // a forged session cookie value is just an unknown session
    expect((await req('/api/profile', { cookie: `srsid=s%3A${a.id}.forged` })).status).toBe(401);
    // CSRF: a cross-site page cannot rename (Origin), nor post a simple form (content type)
    expect((await req('/api/profile', { cookie: a.cookie, body: { displayName: 'CSRF' }, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req('/api/profile', { cookie: a.cookie, body: { displayName: 'CSRF' }, headers: { origin: '' } })).status).toBe(403);
    expect((await req('/api/profile', { cookie: a.cookie, body: 'displayName=CSRF', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await req('/api/profile', { cookie: a.cookie, method: 'PUT', body: { displayName: 'x' } })).status).toBe(405);
    // B's own write only ever touches B
    expect((await rename(b.cookie, 'Uma 2')).status).toBe(200);
    expect((await me(a.cookie)).profile!.displayName).toBe('Tess');
    expect((await me(b.cookie)).profile!.displayName).toBe('Uma 2');
  });

  it('session lifecycle: expired and revoked sessions answer "expired" and clear the cookie; logout revokes; switching accounts replaces the session', async () => {
    nextIp();
    const v = await register('vic_sess');
    const w = await register('wes_sess');
    // expiry in the store: the session is gone even though the browser still sends the cookie
    const sid = decodeURIComponent(v.cookie.split('=')[1]).slice(2).split('.')[0];
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE sid = $1", [sid]);
    const r = await req('/api/auth/me', { cookie: v.cookie });
    expect(await r.json()).toEqual({ account: null, session: 'expired' });
    expect(r.headers.getSetCookie()[0]).toMatch(/^srsid=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict/);
    expect(await (await req('/api/profile', { cookie: v.cookie })).json()).toEqual({ error: 'session_expired' });
    // logout: the old cookie is revoked server-side (a replayed copy is dead too)
    const v2 = await login('vic_sess');
    const lo = await req('/api/auth/logout', { cookie: v2, body: {} });
    expect(lo.status).toBe(200);
    expect(lo.headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    expect((await me(v2)).session).toBe('expired');
    expect((await rename(v2, 'Ghost')).status).toBe(401);
    // a sign-out the store could not carry out is not confirmed: no ok, the cookie is kept and the session still works
    const vf = await login('vic_sess');
    await pool.query(`CREATE FUNCTION ${SCHEMA}.no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'store down'; END $$;
      CREATE TRIGGER no_delete BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.no_delete()`);
    try {
      const bad = await req('/api/auth/logout', { cookie: vf, body: {} });
      expect(bad.status).toBe(503);
      expect(await bad.json()).toEqual({ error: 'unavailable' });
      expect(bad.headers.getSetCookie()).toEqual([]);
      expect((await me(vf)).session).toBe('active');
    } finally { await pool.query(`DROP TRIGGER no_delete ON sessions; DROP FUNCTION ${SCHEMA}.no_delete()`); }
    expect((await req('/api/auth/logout', { cookie: vf, body: {} })).status).toBe(200);
    expect((await me(vf)).session).toBe('expired');
    // the page still shows V after the cookie expired: room entry is refused, never taken as a guest seat
    const stale = await socket(v.cookie);
    expect(await stale.request({ t: 'create', name: 'V', mode: 'solo', settings: {}, expectAccount: v.id })).toMatchObject({ t: 'nack', code: 'expired', detail: 'session' });
    expect(await stale.request({ t: 'create', name: 'V', mode: 'solo', settings: {}, expectAccount: '' })).toMatchObject({ t: 'joined', room: { participants: [{ guest: true }] } });
    stale.close();
    // switching account in one browser: signing in as W on V's cookie ends V's session and starts a new one for W
    const v3 = await login('vic_sess');
    const sw = await req('/api/auth/login', { cookie: v3, body: { username: 'wes_sess', password: 'wes_sess password 1' } });
    const w2 = cookieOf(sw);
    expect(w2).not.toBe(v3);
    expect((await me(v3)).account).toBe(null);
    expect((await me(w2)).account!.id).toBe(w.id);
    expect((await me(w.cookie)).account!.id).toBe(w.id);   // W's other browser is unaffected
    // another tab still shows V's profile form: saving it on W's cookie renames nobody; W's own form saves normally
    const before = (await me(w2)).profile!.displayName;
    const stray = await rename(w2, 'Not Wes', { expectAccount: v.id });
    expect(stray.status).toBe(409);
    expect(await stray.json()).toEqual({ error: 'identity_changed' });
    expect((await me(w2)).profile!.displayName).toBe(before);
    expect((await rename(w2, 'Wes 2', { expectAccount: w.id })).status).toBe(200);
    // ...and that tab cannot enter a room under W either
    const other = await socket(w2);
    expect(await other.request({ t: 'join', code: 'ABCDEF', name: 'V', expectAccount: v.id })).toMatchObject({ t: 'nack', code: 'expired', detail: 'session' });
    other.close();
    // the session cookie is never readable by scripts and the API never returns it in a body
    expect(sw.headers.getSetCookie()[0]).toMatch(/HttpOnly/);
    expect(JSON.stringify(await (await req('/api/auth/me', { cookie: w2 })).json())).not.toMatch(/srsid|sid|hash|password/i);
  });

  it('rate limits: registrations per address, failed sign-ins per username across addresses, renames per account', async () => {
    ip = '10.9.9.9';
    for (let i = 0; i < 10; i++) expect((await req('/api/auth/register', { body: { username: `xr_${i}`, password: 'long enough pw' } })).status).toBe(201);
    expect((await req('/api/auth/register', { body: { username: 'xr_10', password: 'long enough pw' } })).status).toBe(429);
    nextIp();
    const { cookie } = await register('yan_rate');
    for (let i = 0; i < 10; i++) { nextIp(); expect((await req('/api/auth/login', { body: { username: 'yan_rate', password: 'wrong password x' } })).status).toBe(401); }
    nextIp();
    // locked for this username (even the right password, from a new address) until the window passes
    expect((await req('/api/auth/login', { body: { username: 'yan_rate', password: 'yan_rate password 1' } })).status).toBe(429);
    expect((await req('/api/auth/login', { body: { username: 'xr_1', password: 'long enough pw' } })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await rename(cookie, `Yan ${i}`)).status).toBe(200);
    expect((await rename(cookie, 'Yan 10')).status).toBe(429);
    expect((await me(cookie)).profile!.displayName).toBe('Yan 9');
  });

  it('an account seat is named from its profile; guest and account share a room; reconnect keeps the seat; nobody else can take it', async () => {
    nextIp();
    const z = await register('zoe_seat', undefined, 'Zoë <i>');
    const other = await register('abe_other', undefined, 'Abe');
    const host = await socket(z.cookie);
    const j = await host.request({ t: 'create', name: 'Spoofed Name', mode: 'multiplayer', settings: { aiFill: false } }) as Extract<ServerMsg, { t: 'joined' }>;
    expect(j.t).toBe('joined');
    const zp = j.room.participants[0];
    expect(zp).toMatchObject({ name: 'Zoë <i>', guest: false });
    const guest = await socket('');
    const gj = await guest.request({ t: 'join', code: j.room.code, name: 'Guest Gil' }) as Extract<ServerMsg, { t: 'joined' }>;
    expect(gj.t).toBe('joined');
    const gp = gj.room.participants.find((p) => p.id === gj.you)!;
    expect(gp).toMatchObject({ name: 'Guest Gil', guest: true });
    // the public room never carries a username, an account id, a session or a token
    const pub = JSON.stringify(gj.room);
    for (const s of ['zoe_seat', z.id, 'srsid', 'token', 'password']) expect(pub).not.toContain(s);
    // the same account cannot take a second seat in the room
    const dupe = await socket(z.cookie);
    expect(await dupe.request({ t: 'join', code: j.room.code, name: 'Zoe again' })).toMatchObject({ t: 'nack', code: 'already_joined' });
    dupe.close();
    // renaming in the lobby changes no identity: the seat keeps its account and participant id
    expect((await rename(z.cookie, 'Zoe Renamed')).status).toBe(200);
    const zCred = host.credential()!, gCred = guest.credential()!;

    // the race starts: the roster (and its account links) is frozen
    guest.send({ t: 'ready', ready: true });
    await guest.wait((m) => m.t === 'room' && m.room.participants.every((p) => p.id === m.room.hostId || p.ready));
    host.send({ t: 'start' });
    await host.wait((m) => m.t === 'state');
    const room = mgr.room(zCred.room)!;
    const seat = (id: string) => room.publicRoom().participants.find((p) => p.id === id)!;
    const zSlot = seat(zCred.participant).slot, zBay = seat(zCred.participant).bay;

    // reconnect by the same account (same browser, after a dropped link): same participant, slot and bay
    host.drop();
    await waitFor(() => !seat(zCred.participant).connected);
    const back = await socket(z.cookie);
    expect(await back.request({ t: 'resume', ...zCred })).toMatchObject({ t: 'joined', you: zCred.participant, resumed: true });
    expect(seat(zCred.participant)).toMatchObject({ slot: zSlot, bay: zBay, guest: false, connected: true });

    // sign out mid-race: the socket is signed out, and the seat cannot pass to anybody else
    expect((await req('/api/auth/logout', { cookie: z.cookie, body: {} })).status).toBe(200);
    await waitFor(() => back.closed?.code === 4003);
    for (const cookie of ['', other.cookie]) {
      const thief = await socket(cookie);
      expect(await thief.request({ t: 'resume', ...zCred })).toMatchObject({ t: 'nack', code: 'forbidden' });
      thief.close();
    }
    // a signed-in socket resuming the guest seat does not attach its account: a guest seat stays guest
    guest.drop();
    await waitFor(() => !seat(gCred.participant).connected);
    const gAsAbe = await socket(other.cookie);
    expect(await gAsAbe.request({ t: 'resume', ...gCred })).toMatchObject({ t: 'joined', you: gCred.participant });
    expect(seat(gCred.participant).guest).toBe(true);
    expect(room.participant(gCred.participant)!.accountId).toBe(null);
    // the owner signs in again (a new session) and takes the seat back
    const z2 = await login('zoe_seat');
    const again = await socket(z2);
    expect(await again.request({ t: 'resume', ...zCred })).toMatchObject({ t: 'joined', you: zCred.participant });
    expect(seat(zCred.participant)).toMatchObject({ slot: zSlot, bay: zBay });
    // ...and signing in as another account at the finish changes nothing either: that browser's socket is signed out
    const sw = await req('/api/auth/login', { cookie: z2, body: { username: 'abe_other', password: 'abe_other password 1' } });
    expect(sw.status).toBe(200);
    await waitFor(() => again.closed?.code === 4003);
    const asAbe = await socket(cookieOf(sw));
    expect(await asAbe.request({ t: 'resume', ...zCred })).toMatchObject({ t: 'nack', code: 'forbidden' });
    asAbe.close();

    // both drivers retire; the stored envelope links Zoe's seat to her account id (under her new name) and the guest to none
    gAsAbe.send({ t: 'leave' });
    let rows: { envelope: { participants: { id: string; accountId: string | null; name: string; control: string }[] } }[] = [];
    await waitFor(async () => { rows = (await pool.query('SELECT envelope FROM race_results WHERE room_id = $1', [zCred.room])).rows; return rows.length > 0; }, 30000);
    const parts = rows[0].envelope.participants;
    expect(parts.find((p) => p.id === zCred.participant)).toMatchObject({ accountId: z.id, name: 'Zoë <i>' });
    expect(parts.find((p) => p.id === gCred.participant)).toMatchObject({ accountId: null, name: 'Guest Gil' });
    expect(parts.filter((p) => p.accountId === other.id)).toEqual([]);
    gAsAbe.close();
    for (const line of log.lines) for (const s of ['password 1', 'srsid=', zCred.token, gCred.token]) expect(line).not.toContain(s);
  }, 60_000);

  it('a restart keeps accounts, profiles and sessions; a new session on the restarted server sees the same profile', async () => {
    nextIp();
    const a = await register('ari_restart', undefined, 'Ari');
    expect((await rename(a.cookie, 'Ari Restarted')).status).toBe(200);
    await halt();
    await boot();
    expect(await me(a.cookie)).toMatchObject({ account: { id: a.id }, profile: { displayName: 'Ari Restarted' } });
    expect(await me(await login('ari_restart'))).toMatchObject({ account: { id: a.id }, profile: { displayName: 'Ari Restarted' } });
    expect(await migrate(pool)).toEqual([]);
  });

  it('a public room message with HTML-like names stays plain data', async () => {
    nextIp();
    const a = await register('bea_html', undefined, '<img src=x>');
    const c = await socket(a.cookie);
    const j = await c.request({ t: 'create', name: 'x', mode: 'solo', settings: {} }) as { room: PublicRoom };
    expect(j.room.participants[0].name).toBe('<img src=x>');
    c.send({ t: 'leave' });
    c.close();
  });
});
