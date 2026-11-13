// /api/health and the database (#98). Health is public and polled by every page load, the smoke and online checks and the
// deploy script, while the pool has three connections. So its database status is read-only (no CREATE TABLE), cached for
// `healthDbCacheMs`, and probed by at most one query at a time; an outage still shows as `db: down` within the window and
// recovery as `ok`. Runs without PostgreSQL: a fake pool counts every statement. Also the per-address limit on career reads.
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { createApp, DbStatusCache, STATS_PER_MINUTE, type App, type DbState } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MIGRATIONS, readSchemaStatus } from '../../server/migrations';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';

const SECRET = 'test-session-secret-0123456789abcdef';
const applied = MIGRATIONS.map((m) => ({ id: m.id, checksum: createHash('sha256').update(m.sql).digest('hex') }));

/** A pool that answers the schema probe after `delayMs`; `mode` makes it fail like a dead database or a fresh one. */
function fakePool(delayMs = 30) {
  const st = { sql: [] as string[], mode: 'ok' as 'ok' | 'down' | 'fresh' | 'outdated' };
  const query = async (sql: string) => {
    st.sql.push(sql);
    await new Promise((r) => setTimeout(r, delayMs));
    if (st.mode === 'down') throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    if (st.mode === 'fresh') throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
    if (!/^SELECT id, checksum FROM schema_migrations/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
    return { rows: st.mode === 'outdated' ? applied.slice(0, -1) : applied, rowCount: applied.length };
  };
  return { st, pool: { query, connect: () => Promise.reject(new Error('no clients here')), end: () => Promise.resolve() } as unknown as Pool };
}

const apps: App[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
async function serve(pool: Pool, healthDbCacheMs: number) {
  const cfg = testConfig({ port: 0, databaseUrl: 'postgres://unused', sessionSecret: SECRET, cookieSecure: false, healthDbCacheMs });
  const app = createApp({ cfg, log: memoryLogger(), manager: new RoomManager({ cfg, log: memoryLogger(), sink: new MemoryResultSink() }), pool });
  apps.push(app);
  const base = `http://127.0.0.1:${(await app.listen()).port}`;
  const health = async () => { const r = await fetch(`${base}/api/health`); return { ...((await r.json()) as Record<string, unknown>), status: r.status } as Record<string, unknown> & { status: number }; };
  return { base, health };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('health database status (#98)', () => {
  it('the production default caches for a couple of seconds; tests see every change unless they ask for the cache', async () => {
    const { loadConfig } = await import('../../server/config');
    expect(loadConfig({ NODE_ENV: 'production', SLOTRUSH_ALLOWED_ORIGINS: 'https://x.example' }).healthDbCacheMs).toBe(2000);
    expect(loadConfig({ SLOTRUSH_HEALTH_DB_CACHE_MS: '0' }).healthDbCacheMs).toBe(0);
    expect(() => loadConfig({ SLOTRUSH_HEALTH_DB_CACHE_MS: '-1' })).toThrow(/SLOTRUSH_HEALTH_DB_CACHE_MS/);
    expect(testConfig().healthDbCacheMs).toBe(0);
  });

  it('N concurrent health requests cost one schema query per window, and health never issues DDL', async () => {
    const db = fakePool(50);
    const { health } = await serve(db.pool, 60_000);
    const burst = await Promise.all(Array.from({ length: 25 }, () => health()));
    expect(burst.every((h) => h.status === 200 && h.ok === true && h.db === 'ok')).toBe(true);
    expect(db.st.sql).toHaveLength(1);
    // later requests in the same window are answered from the cache, with the live room counts and every field still there
    for (let i = 0; i < 5; i++) expect(await health()).toMatchObject({ status: 200, ok: true, db: 'ok', rooms: 0, racing: 0, humans: 0, pendingResults: 0, schema: MIGRATIONS.at(-1)!.id });
    expect(db.st.sql).toHaveLength(1);
    expect(db.st.sql.some((s) => /CREATE|INSERT|UPDATE|DELETE|ALTER|DROP/i.test(s))).toBe(false);
  });

  it('flips to down within the window when the database fails, and back to ok within the window after it recovers', async () => {
    const TTL = 150;
    const db = fakePool(10);
    const { health } = await serve(db.pool, TTL);
    expect(await health()).toMatchObject({ status: 200, db: 'ok' });
    db.st.mode = 'down';
    await sleep(TTL + 20);
    const down = await Promise.all(Array.from({ length: 10 }, () => health()));
    expect(down.every((h) => h.status === 503 && h.ok === false && h.db === 'down' && h.racing === 0)).toBe(true);
    expect(db.st.sql).toHaveLength(2);   // the ten requests of the outage shared one probe
    db.st.mode = 'ok';
    await sleep(TTL + 20);
    expect(await health()).toMatchObject({ status: 200, ok: true, db: 'ok' });
    expect(db.st.sql).toHaveLength(3);
  });

  it('with no cache every request probes, but concurrent ones still share one probe', async () => {
    const db = fakePool(40);
    const { health } = await serve(db.pool, 0);
    await Promise.all(Array.from({ length: 8 }, () => health()));
    expect(db.st.sql).toHaveLength(1);
    await health(); await health();
    expect(db.st.sql).toHaveLength(3);
  });

  it('an unmigrated or older schema is outdated (503), without creating the bookkeeping table', async () => {
    const db = fakePool(1);
    const { health } = await serve(db.pool, 0);
    db.st.mode = 'fresh';
    expect(await health()).toMatchObject({ status: 503, ok: false, db: 'outdated' });
    db.st.mode = 'outdated';
    expect(await health()).toMatchObject({ status: 503, ok: false, db: 'outdated' });
    db.st.mode = 'ok';
    expect(await health()).toMatchObject({ status: 200, ok: true, db: 'ok' });
    expect(db.st.sql.every((s) => /^SELECT id, checksum FROM schema_migrations/.test(s))).toBe(true);
  });

  it('readSchemaStatus is one SELECT: a missing table is nothing applied, any other error is thrown', async () => {
    const db = fakePool(0);
    expect(await readSchemaStatus(db.pool)).toEqual({ current: true, applied: MIGRATIONS.map((m) => m.id), missing: [] });
    db.st.mode = 'fresh';
    expect(await readSchemaStatus(db.pool)).toEqual({ current: false, applied: [], missing: MIGRATIONS.map((m) => m.id) });
    db.st.mode = 'down';
    await expect(readSchemaStatus(db.pool)).rejects.toThrow(/ECONNREFUSED/);
    expect(db.st.sql).toHaveLength(3);
  });

  it('DbStatusCache: one probe per window on an injected clock, failures cached as down, single flight across a slow probe', async () => {
    let t = 0, n = 0, next: DbState | Error = 'ok';
    let release: () => void = () => undefined;
    const probe = () => { n++; const v = next; return new Promise<DbState>((res, rej) => { release = () => (v instanceof Error ? rej(v) : res(v)); }); };
    const c = new DbStatusCache(probe, 1000, () => t);
    const a = c.get(), b = c.get();
    release();
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    t = 999; expect(await c.get()).toBe('ok'); expect(n).toBe(1);
    next = new Error('gone');
    t = 1000; const d = c.get(); const e = c.get(); release();
    expect(await Promise.all([d, e])).toEqual(['down', 'down']); expect(n).toBe(2);
    t = 1500; expect(await c.get()).toBe('down'); expect(n).toBe(2);
    next = 'ok';
    t = 2000; const f = c.get(); release(); expect(await f).toBe('ok'); expect(n).toBe(3);
  });
});

describe('career reads per address (#98)', () => {
  it(`at most ${STATS_PER_MINUTE} a minute per client address, before any session or database work; other addresses are unaffected`, async () => {
    const db = fakePool(0);
    const { base } = await serve(db.pool, 60_000);
    const stats = (ip: string) => fetch(`${base}/api/profile/stats`, { headers: { 'x-real-ip': ip } });
    for (let i = 0; i < STATS_PER_MINUTE; i++) expect((await stats('10.1.1.1')).status).toBe(401);   // signed out, but counted
    const r = await stats('10.1.1.1');
    expect([r.status, await r.json()]).toEqual([429, { error: 'rate' }]);
    expect((await stats('10.1.1.2')).status).toBe(401);
    expect(db.st.sql).toEqual([]);
  });
});
