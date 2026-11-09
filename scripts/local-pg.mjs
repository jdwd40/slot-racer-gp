// A throwaway local PostgreSQL cluster for development and the database tests, owned by the current user under .local-pg/
// (git-ignored). It never touches a system or production cluster.
//   node scripts/local-pg.mjs start   # initdb on first use, start on port 55471, create role/database slotrush_test
//   node scripts/local-pg.mjs stop
//   node scripts/local-pg.mjs test    # start, then run the database tests against it (npm run test:db)
//   node scripts/local-pg.mjs env     # print the DATABASE_URL to use
//   node scripts/local-pg.mjs backup-check   # the documented backup/restore drill (docs/accounts.md) on a scratch database
// Binaries: PG_BIN, else the newest /usr/lib/postgresql/<n>/bin, else PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve('.local-pg');
const DATA = join(DIR, 'data');
const PORT = Number(process.env.LOCAL_PG_PORT ?? 55471);
const URL = `postgres://slotrush_test:slotrush_test_pw@127.0.0.1:${PORT}/slotrush_test`;

function bin(name) {
  if (process.env.PG_BIN) return join(process.env.PG_BIN, name);
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    const v = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a))[0];
    if (v && existsSync(join(root, v, 'bin', name))) return join(root, v, 'bin', name);
  }
  return name;
}
const run = (cmd, args, opts = {}) => execFileSync(bin(cmd), args, { stdio: 'inherit', ...opts });
const psql = (sql, db = 'postgres') => run('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', process.env.USER ?? 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qc', sql]);

function start() {
  if (!existsSync(DATA)) {
    mkdirSync(DIR, { recursive: true });
    const pw = join(DIR, 'initpw');
    writeFileSync(pw, 'local_superuser_pw\n', { mode: 0o600 });
    try { run('initdb', ['-D', DATA, '-A', 'scram-sha-256', `--pwfile=${pw}`, '-U', process.env.USER ?? 'postgres', '--no-instructions'], { stdio: ['ignore', 'ignore', 'inherit'] }); } finally { rmSync(pw); }
  }
  writeFileSync(join(DIR, '.pgpass'), `127.0.0.1:*:*:${process.env.USER ?? 'postgres'}:local_superuser_pw\n`, { mode: 0o600 });
  process.env.PGPASSFILE = join(DIR, '.pgpass');
  const st = spawnSync(bin('pg_ctl'), ['-D', DATA, 'status'], { stdio: 'ignore' });
  if (st.status !== 0) run('pg_ctl', ['-D', DATA, '-l', join(DIR, 'log'), '-w', '-o', `-p ${PORT} -k ${DIR} -c listen_addresses=127.0.0.1`, 'start']);
  // the same shape as production: a dedicated login role owning a dedicated database (no superuser, no createdb)
  psql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'slotrush_test') THEN CREATE ROLE slotrush_test LOGIN PASSWORD 'slotrush_test_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;`);
  const has = execFileSync(bin('psql'), ['-h', '127.0.0.1', '-p', String(PORT), '-U', process.env.USER ?? 'postgres', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname = 'slotrush_test'"], { encoding: 'utf8' }).trim();
  if (!has) psql('CREATE DATABASE slotrush_test OWNER slotrush_test');
  psql('REVOKE ALL ON DATABASE slotrush_test FROM PUBLIC');
  console.log(`local PostgreSQL on 127.0.0.1:${PORT}; DATABASE_URL=${URL}`);
}

const cmd = process.argv[2] ?? 'start';
if (cmd === 'start') start();
else if (cmd === 'stop') { if (existsSync(DATA)) run('pg_ctl', ['-D', DATA, '-m', 'fast', 'stop']); }
else if (cmd === 'env') console.log(URL);
else if (cmd === 'test') {
  start();
  const r = spawnSync('npx', ['vitest', 'run', 'test/server/db.test.ts', 'test/server/profiles.db.test.ts'], { stdio: 'inherit', env: { ...process.env, SLOTRUSH_TEST_DATABASE_URL: URL } });
  process.exit(r.status ?? 1);
} else if (cmd === 'backup-check') {
  // The owner's backup/restore drill, locally: a database with accounts, profiles and sessions is dumped with pg_dump -Fc as
  // its own role, restored into a fresh database owned by the same role, and compared. Then the restored copy is migrated
  // (a no-op) and its schema check must pass, as the service would require before starting on it.
  start();
  const conn = ['-h', '127.0.0.1', '-p', String(PORT)];
  const env = { ...process.env, PGPASSWORD: 'slotrush_test_pw' };
  const q = (db, sql) => execFileSync(bin('psql'), [...conn, '-U', 'slotrush_test', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { env, encoding: 'utf8' }).trim();
  psql('DROP DATABASE IF EXISTS slotrush_bk_src'); psql('DROP DATABASE IF EXISTS slotrush_bk_dst');
  psql('CREATE DATABASE slotrush_bk_src OWNER slotrush_test'); psql('CREATE DATABASE slotrush_bk_dst OWNER slotrush_test');
  const srcUrl = URL.replace(/\/slotrush_test$/, '/slotrush_bk_src'), dstUrl = URL.replace(/\/slotrush_test$/, '/slotrush_bk_dst');
  const admin = (url, args, input) => spawnSync('node', ['server-dist/admin.mjs', ...args], { env: { ...process.env, DATABASE_URL: url }, input, encoding: 'utf8' });
  execFileSync('npm', ['run', 'build:server'], { stdio: 'ignore' });   // the admin CLI of this checkout
  if (admin(srcUrl, ['migrate']).status !== 0) throw new Error('migrate failed');
  q('slotrush_bk_src', "INSERT INTO accounts (username, username_key, password_hash) VALUES ('bk_driver', 'bk_driver', '$argon2id$v=19$m=19456,t=2,p=1$placeholder')");
  q('slotrush_bk_src', "INSERT INTO profiles (account_id, display_name) SELECT id, '<b>Backup</b>' FROM accounts WHERE username_key = 'bk_driver'");
  q('slotrush_bk_src', "INSERT INTO sessions (sid, account_id, sess, expires_at) SELECT 'bk-sid', id, '{}', now() + interval '1 day' FROM accounts WHERE username_key = 'bk_driver'");
  const file = join(DIR, 'backup-check.dump');
  execFileSync(bin('pg_dump'), [...conn, '-U', 'slotrush_test', '-Fc', '-f', file, 'slotrush_bk_src'], { env, stdio: 'inherit' });
  execFileSync(bin('pg_restore'), [...conn, '-U', 'slotrush_test', '-d', 'slotrush_bk_dst', '--no-owner', '--role=slotrush_test', '--exit-on-error', file], { env, stdio: 'inherit' });
  const facts = (db) => q(db, "SELECT (SELECT count(*) FROM accounts) || '/' || (SELECT count(*) FROM profiles) || '/' || (SELECT count(*) FROM sessions) || '/' || (SELECT string_agg(id, ',' ORDER BY id) FROM schema_migrations) || '/' || (SELECT a.id || ':' || p.display_name FROM accounts a JOIN profiles p ON p.account_id = a.id)");
  const a = facts('slotrush_bk_src'), b = facts('slotrush_bk_dst');
  const mig = admin(dstUrl, ['migrate']), st = admin(dstUrl, ['status']);
  const reset = admin(dstUrl, ['reset-password', 'bk_driver'], '');
  const ok = a === b && mig.status === 0 && /already current/.test(mig.stdout) && st.status === 0 && reset.status === 0 && q('slotrush_bk_dst', 'SELECT count(*) FROM sessions') === '0';
  console.log(`source   ${a}\nrestored ${b}\nmigrate on restored: ${mig.stdout.trim()}\nstatus: ${st.stdout.trim()}\nadmin reset on restored: exit ${reset.status}, sessions revoked`);
  rmSync(file);
  psql('DROP DATABASE slotrush_bk_src'); psql('DROP DATABASE slotrush_bk_dst');
  console.log(ok ? 'PASS backup/restore drill' : 'FAIL backup/restore drill');
  process.exit(ok ? 0 : 1);
} else { console.error('usage: local-pg.mjs start|stop|env|test|backup-check'); process.exit(2); }
