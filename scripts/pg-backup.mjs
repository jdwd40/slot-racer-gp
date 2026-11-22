// Dump and restore the game's PostgreSQL database with the PostgreSQL client tools (pg_dump -Fc / pg_restore), for the restore
// drill in docs/restore.md (#144). No npm dependencies, so it runs from a checkout or from a release directory.
//   node scripts/pg-backup.mjs dump    --url-env DATABASE_URL --out /var/backups/slotrush/slotrush-<ts>.dump [--schema <s>]
//   node scripts/pg-backup.mjs restore --url-env DRILL_URL    --in  /var/backups/slotrush/slotrush-<ts>.dump [--force]
//   node scripts/pg-backup.mjs check   --url-env DRILL_URL    [--schema <s>] [--json]
// The connection is `--url <postgres://...>` or, better on a shared host (argv is visible in `ps`), `--url-env <VAR>`. There
// is no default: nothing here ever reads DATABASE_URL unless told to. The password is passed to the tools in PGPASSWORD, never
// on their command line, and never printed.
//
// Safety (restore): the target database's name must look throwaway (a `restore`, `drill`, `scratch`, `throwaway` or `test`
// word, e.g. slotrush_restore_drill), unless --force is given; and the schemas the dump holds must not already contain any
// table, view or sequence in the target (always, --force or not). The restore is one transaction (--single-transaction,
// --exit-on-error): it applies completely or not at all. A dump file is created 0600 and never overwritten.
//
// Exit codes: 0 done, 1 failed (tool error, version mismatch), 2 usage, 3 refused by a safety check.
// Binaries: PG_BIN, else the newest /usr/lib/postgresql/<n>/bin, else PATH (as scripts/local-pg.mjs). pg_dump/pg_restore must be
// at least the server's major version; a mismatch is reported before anything runs.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const THROWAWAY = /(^|[_-])(restore|drill|scratch|throwaway|test)([_-]|$)/i;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const VALUE_FLAGS = { '--url': 'url', '--url-env': 'urlEnv', '--out': 'out', '--in': 'in', '--schema': 'schema' };

class Refused extends Error {}
class Usage extends Error {}

function bin(name) {
  if (process.env.PG_BIN) return join(process.env.PG_BIN, name);
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    const v = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a))[0];
    if (v && existsSync(join(root, v, 'bin', name))) return join(root, v, 'bin', name);
  }
  return name;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, force: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a in VALUE_FLAGS) {
      const v = rest[++i];
      if (v === undefined) throw new Usage(`${a} needs a value`);
      opts[VALUE_FLAGS[a]] = v;
    } else throw new Usage(`unknown argument ${a}`);
  }
  if (!['dump', 'restore', 'check'].includes(cmd)) throw new Usage('command must be dump, restore or check');
  return opts;
}

/** The connection: a URL without its password (safe to pass and to print), the password for PGPASSWORD, and the database. */
function connection(opts) {
  let raw = opts.url;
  if (opts.urlEnv !== undefined) {
    if (raw !== undefined) throw new Usage('give --url or --url-env, not both');
    raw = process.env[opts.urlEnv];
    if (!raw) throw new Usage(`environment variable ${opts.urlEnv} is empty`);
  }
  if (!raw) throw new Usage('--url or --url-env is required (there is no default database)');
  let u;
  try { u = new URL(raw); } catch { throw new Usage('the connection is not a URL'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Usage('the connection must be a postgres:// URL');
  const password = decodeURIComponent(u.password);
  u.password = '';
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Usage('the URL must name a database');
  return { url: u.toString(), shown: `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.host}/${database}`, password, database };
}

const env = (c) => ({ ...process.env, PGPASSWORD: c.password, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? '10' });

function tool(name, args, c, extra = {}) {
  const r = spawnSync(bin(name), args, { env: env(c), encoding: 'utf8', ...extra });
  if (r.error) throw new Error(`${name} could not run (${r.error.code ?? r.error.message}); install the PostgreSQL client tools or set PG_BIN`);
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  return r.stdout;
}

const sql = (c, query) => tool('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-tA', '-d', c.url, '-c', query], c).trim();

/** pg_dump / pg_restore older than the server cannot read it (pg_dump refuses); say so plainly, before any work starts. */
function checkVersions(c, name) {
  const out = tool(name, ['--version'], c);
  const client = Number(/\(PostgreSQL\)\s+(\d+)/.exec(out)?.[1]);
  const server = Math.floor(Number(sql(c, 'SHOW server_version_num')) / 10000);
  if (!client || !server) throw new Error(`cannot read the ${name} or server version`);
  if (client < server) throw new Error(`${name} is PostgreSQL ${client} but the server is ${server}: install postgresql-client-${server} or point PG_BIN at its bin directory`);
  return { client, server };
}

/** Row counts of every base table in a schema, plus the applied migration ids (when the schema has schema_migrations). */
function summary(c, schema) {
  if (!IDENT.test(schema)) throw new Usage(`bad schema name ${schema}`);
  const rows = sql(c, `SELECT table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const tables = Object.fromEntries(rows ? rows.split('\n').map((l) => { const [t, n] = l.split('='); return [t, Number(n)]; }) : []);
  const migrations = 'schema_migrations' in tables ? sql(c, `SELECT string_agg(id, ',' ORDER BY id) FROM ${schema}.schema_migrations`).split(',').filter(Boolean) : [];
  return { schema, tables, migrations, schemaVersion: migrations.at(-1) ?? null };
}

function printSummary(s, json) {
  if (json) { console.log(JSON.stringify(s)); return; }
  console.log(`schema ${s.schema}: ${Object.keys(s.tables).length} tables; schema version ${s.schemaVersion ?? '(no schema_migrations)'}`);
  for (const [t, n] of Object.entries(s.tables)) console.log(`  ${t.padEnd(20)} ${n}`);
}

/** The schemas a dump's table of contents creates objects in (from `pg_restore --list`). */
function dumpSchemas(c, file) {
  const toc = tool('pg_restore', ['--list', file], c);
  const schemas = new Set();
  for (const line of toc.split('\n')) {
    const m = /^\d+; \d+ \d+ (SCHEMA|TABLE(?! DATA )|SEQUENCE(?! SET | OWNED BY )|VIEW|MATERIALIZED VIEW(?! DATA )|FUNCTION) (\S+) (\S+)/.exec(line);
    if (!m) continue;
    schemas.add(m[1] === 'SCHEMA' ? m[3] : m[2]);
  }
  schemas.delete('-');
  for (const s of schemas) if (!IDENT.test(s)) throw new Error(`unexpected schema name in the dump: ${s}`);
  return [...schemas].sort();
}

function dump(opts) {
  const c = connection(opts);
  if (!opts.out) throw new Usage('dump needs --out <file>');
  if (opts.schema !== undefined && !IDENT.test(opts.schema)) throw new Usage(`bad schema name ${opts.schema}`);
  if (existsSync(opts.out)) throw new Refused(`refusing to overwrite ${opts.out}: pick a new file name`);
  const v = checkVersions(c, 'pg_dump');
  // created private and exclusively: an existing file is never overwritten, and pg_dump writes into this 0600 file
  closeSync(openSync(opts.out, 'wx', 0o600));
  try {
    tool('pg_dump', ['--format=custom', `--file=${opts.out}`, ...(opts.schema ? [`--schema=${opts.schema}`] : []), `--dbname=${c.url}`], c, { stdio: ['ignore', 'inherit', 'pipe'] });
  } catch (e) { rmSync(opts.out, { force: true }); throw e; }
  console.log(`dumped ${c.shown}${opts.schema ? ` schema ${opts.schema}` : ''} -> ${opts.out} (${statSync(opts.out).size} bytes, mode 0600, pg_dump ${v.client}, server ${v.server})`);
}

function restore(opts) {
  const c = connection(opts);
  if (!opts.in) throw new Usage('restore needs --in <file>');
  // the name check comes first and needs no connection: a production URL is refused before anything connects to it
  if (!THROWAWAY.test(c.database) && !opts.force) {
    throw new Refused(`refusing to restore into "${c.database}": the name does not look throwaway (restore, drill, scratch, throwaway or test). Create a fresh database such as slotrush_restore_drill, or pass --force for a deliberate real restore`);
  }
  if (!existsSync(opts.in)) throw new Usage(`no dump file ${opts.in}`);
  const v = checkVersions(c, 'pg_restore');
  const schemas = dumpSchemas(c, opts.in);
  const list = schemas.map((s) => `'${s}'`).join(',') || "''";
  const busy = sql(c, `SELECT string_agg(DISTINCT n.nspname, ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN (${list}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`);
  if (busy) throw new Refused(`refusing to restore into "${c.database}": schema ${busy} already holds tables. Restore only into a fresh, empty database (or drop the schema first)`);
  tool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${c.url}`, opts.in], c, { stdio: ['ignore', 'inherit', 'pipe'] });
  console.log(`restored ${opts.in} -> ${c.shown} (pg_restore ${v.client}, server ${v.server})`);
  for (const s of schemas) printSummary(summary(c, s), opts.json);
}

function check(opts) {
  const c = connection(opts);
  printSummary(summary(c, opts.schema ?? 'public'), opts.json);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  ({ dump, restore, check })[opts.cmd](opts);
} catch (e) {
  console.error(`pg-backup: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Usage) console.error('usage: pg-backup.mjs dump|restore|check (--url <postgres-url> | --url-env <VAR>) [--out <file>] [--in <file>] [--schema <name>] [--force] [--json]');
  process.exit(e instanceof Usage ? 2 : e instanceof Refused ? 3 : 1);
}
