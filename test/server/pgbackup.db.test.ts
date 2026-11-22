// The restore drill's dump/restore wrapper (scripts/pg-backup.mjs, docs/restore.md, #144) against a real PostgreSQL: a
// migrated schema with an account, a profile, a stored race and a career award is dumped with pg_dump -Fc, restored into a
// fresh schema of the throwaway test database (and, where the role may create databases, as CI's may, into a fresh database
// from a whole-database dump, the drill's own shape), and the restored copy must hold the same tables, row counts, migration
// ids and the known career row. The safety refusals run without a database. Local: `npm run test:db`; the database part is
// skipped without SLOTRUSH_TEST_DATABASE_URL. The client tools must be at least the server's major (CI installs 17).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate, schemaStatus, SCHEMA_VERSION } from '../../server/migrations';

const URL_ = process.env.SLOTRUSH_TEST_DATABASE_URL;
const SRC = 't_pgbackup_src';
const KEEP = 't_pgbackup_orig';

function backup(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['scripts/pg-backup.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const withDb = (url: string, db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

describe('pg-backup safety (no database needed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgbackup-'));
  const file = join(dir, 'any.dump');
  writeFileSync(file, 'not a dump');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses to restore into a database whose name does not look throwaway, before connecting (port 1 is never reached)', () => {
    for (const db of ['slotrush', 'production', 'slotrush_live', 'contest']) {
      const r = backup(['restore', '--url', `postgres://slotrush:secret-pw@127.0.0.1:1/${db}`, '--in', file]);
      expect(r.status, db).toBe(3);
      expect(r.err).toContain(`refusing to restore into "${db}"`);
      expect(r.err + r.out).not.toContain('secret-pw');
    }
  });

  it('has no default database: without --url or --url-env it is a usage error, and DATABASE_URL is never read implicitly', () => {
    const r = backup(['restore', '--in', file], { DATABASE_URL: 'postgres://slotrush:pw@127.0.0.1:1/slotrush_restore' });
    expect(r.status).toBe(2);
    expect(r.err).toContain('no default database');
    expect(backup(['restore', '--url-env', 'PGBACKUP_UNSET_VAR', '--in', file]).status).toBe(2);
    expect(backup(['dump', '--url', 'mysql://x@h/db', '--out', join(dir, 'x.dump')]).status).toBe(2);
    expect(backup(['drop']).status).toBe(2);
  });

  it('never overwrites an existing dump file', () => {
    const r = backup(['dump', '--url', 'postgres://x:y@127.0.0.1:1/slotrush_test', '--out', file]);
    expect(r.status).toBe(3);
    expect(r.err).toContain('refusing to overwrite');
    expect(existsSync(file) && statSync(file).size).toBe('not a dump'.length);
  });
});

describe.skipIf(!URL_)('PostgreSQL: dump and restore drill (#144)', () => {
  let admin: pg.Pool;
  const dir = mkdtempSync(join(tmpdir(), 'pgbackup-db-'));
  const pools: pg.Pool[] = [];
  const poolFor = (url: string, schema = 'public'): pg.Pool => { const p = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` }); pools.push(p); return p; };

  /** a migrated schema with one known account, profile, stored race and career award */
  async function seed(pool: pg.Pool): Promise<void> {
    expect(await migrate(pool)).toHaveLength((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n);
    const id = (await pool.query<{ id: string }>("INSERT INTO accounts (username, username_key, password_hash) VALUES ('drill_driver', 'drill_driver', '$argon2id$v=19$m=19456,t=2,p=1$placeholder') RETURNING id::text")).rows[0].id;
    await pool.query("INSERT INTO profiles (account_id, display_name) VALUES ($1, 'Drill Driver')", [id]);
    await pool.query("INSERT INTO race_results (race_id, room_id, mode, outcome, track_id, rules_version, digest, envelope, scoring_version) VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'solo', 'completed', 'circuit-1', 'race-core-test', repeat('a', 64), '{}', 'career-1:10-6-4')");
    await pool.query("INSERT INTO career_awards (race_id, participant_id, account_id, scoring_version, rules_version, mode, track_id, track_version, position, status, points, field_size, humans, driver_name, livery, finished_at) VALUES ('11111111-1111-4111-8111-111111111111', 'p0', $1, 'career-1:10-6-4', 'race-core-test', 'solo', 'circuit-1', 'v1', 1, 'finished', 10, 4, 1, 'Drill Driver', 'blue', now())", [id]);
  }
  const knownRow = async (pool: pg.Pool) => (await pool.query("SELECT a.username, p.display_name, c.points, c.position FROM accounts a JOIN profiles p ON p.account_id = a.id JOIN career_awards c ON c.account_id = a.id WHERE a.username_key = 'drill_driver'")).rows;
  const counts = async (pool: pg.Pool, schema: string) => {
    const tables = (await pool.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1", [schema])).rows.map((r) => r.t);
    return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${t}`)).rows[0].n as number])));
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SRC} CASCADE; DROP SCHEMA IF EXISTS ${KEEP} CASCADE; CREATE SCHEMA ${SRC}`);
  });
  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS ${SRC} CASCADE; DROP SCHEMA IF EXISTS ${KEEP} CASCADE`).catch(() => undefined);
    await admin?.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dumps a migrated schema, restores it into a fresh schema, and the copy has the same counts, migrations and career row', async () => {
    const src = poolFor(URL_!, SRC);
    await seed(src);
    const before = await counts(admin, SRC);
    const row = await knownRow(src);
    expect(row).toEqual([{ username: 'drill_driver', display_name: 'Drill Driver', points: 10, position: 1 }]);

    const file = join(dir, 'schema.dump');
    const d = backup(['dump', '--url-env', 'PGBACKUP_TEST_URL', '--schema', SRC, '--out', file], { PGBACKUP_TEST_URL: URL_! });
    expect(d.status, d.err).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(d.out + d.err).not.toContain(new URL(URL_!).password || '\u0000');

    // the original moves aside, so the restore lands in a schema that does not exist yet
    await admin.query(`ALTER SCHEMA ${SRC} RENAME TO ${KEEP}`);
    const r = backup(['restore', '--url-env', 'PGBACKUP_TEST_URL', '--in', file, '--json'], { PGBACKUP_TEST_URL: URL_! });
    expect(r.status, r.err).toBe(0);
    const reported = JSON.parse(r.out.trim().split('\n').at(-1)!) as { schema: string; tables: Record<string, number>; schemaVersion: string };

    const after = await counts(admin, SRC);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(8);
    expect(after).toEqual(before);
    expect(await counts(admin, KEEP)).toEqual(before);
    expect(reported).toMatchObject({ schema: SRC, tables: before, schemaVersion: SCHEMA_VERSION });
    const restored = poolFor(URL_!, SRC);
    expect(await knownRow(restored)).toEqual(row);
    expect(await schemaStatus(restored)).toMatchObject({ current: true, missing: [] });

    // `check` reports the same, read-only
    const c = backup(['check', '--url-env', 'PGBACKUP_TEST_URL', '--schema', SRC, '--json'], { PGBACKUP_TEST_URL: URL_! });
    expect(c.status, c.err).toBe(0);
    expect(JSON.parse(c.out)).toMatchObject({ tables: before, schemaVersion: SCHEMA_VERSION });

    // restoring again over the now-populated schema is refused, even with --force, and changes nothing
    for (const extra of [[], ['--force']]) {
      const again = backup(['restore', '--url-env', 'PGBACKUP_TEST_URL', '--in', file, ...extra], { PGBACKUP_TEST_URL: URL_! });
      expect(again.status, again.err).toBe(3);
      expect(again.err).toContain(`schema ${SRC} already holds tables`);
    }
    expect(await counts(admin, SRC)).toEqual(before);
  });

  it('whole database: dumps a migrated database and restores it into a fresh database, as the drill does (needs CREATEDB)', async (ctx) => {
    const can = (await admin.query<{ ok: boolean }>('SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user')).rows[0].ok;
    if (!can) { ctx.skip(); return; }   // the local role is NOCREATEDB, like production's; CI's role may create databases
    const srcDb = `slotrush_test_drill_src_${process.pid}`, dstDb = `slotrush_test_restore_${process.pid}`;
    for (const db of [srcDb, dstDb]) { await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.query(`CREATE DATABASE ${db} TEMPLATE template0`); }
    try {
      const src = poolFor(withDb(URL_!, srcDb));
      await seed(src);
      const before = await counts(src, 'public');
      const file = join(dir, 'whole.dump');
      const d = backup(['dump', '--url', withDb(URL_!, srcDb), '--out', file]);
      expect(d.status, d.err).toBe(0);
      const r = backup(['restore', '--url', withDb(URL_!, dstDb), '--in', file, '--json']);
      expect(r.status, r.err).toBe(0);
      const dst = poolFor(withDb(URL_!, dstDb));
      expect(await counts(dst, 'public')).toEqual(before);
      expect(await knownRow(dst)).toEqual(await knownRow(src));
      expect(await schemaStatus(dst)).toMatchObject({ current: true, missing: [] });
      expect(JSON.parse(r.out.trim().split('\n').at(-1)!)).toMatchObject({ schema: 'public', schemaVersion: SCHEMA_VERSION });
    } finally {
      for (const p of pools.splice(0)) await p.end().catch(() => undefined);
      for (const db of [srcDb, dstDb]) await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => undefined);
    }
  });
});
