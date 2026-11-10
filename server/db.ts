// PostgreSQL pool for the game's own database and role (see docs/online-server.md for the role/database setup).
import pg from 'pg';
import type { Config } from './config';
import { createLogger, type Logger } from './log';

export type Pool = pg.Pool;

export function createPool(cfg: Pick<Config, 'databaseUrl' | 'dbPoolMax'>, log: Logger = createLogger('warn')): pg.Pool {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  const databaseUrl = cfg.databaseUrl;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    application_name: 'slotrush-server',
  });
  // A connection that dies while idle in the pool (database restart, failover, a dropped socket) is re-emitted by pg-pool
  // as an 'error' event on the pool, outside any query. With no listener that event is an uncaught exception: the process
  // exits and every room and race in memory is lost. pg-pool has already discarded the client, and the next query opens a
  // new connection, so logging is all that is left to do. Queries that fail meanwhile reject to their callers, which keep
  // their own fallbacks (results are spooled and retried, see server/spool.ts).
  pool.on('error', (err) => { log.warn('db.connection_lost', { state: 'idle', ...dbErrorFields(err, databaseUrl) }); });
  // pg-pool listens for errors only while a client is idle. A checked-out client (a transaction in server/results.ts,
  // accounts.ts, migrations.ts) whose socket dies emits 'error' on the client itself, which would be just as uncaught.
  // Its in-flight query rejects too and the caller handles that; on release the pool sees it is no longer queryable and
  // drops it. So this listener only keeps the event from becoming an exception (the idle case above is logged once).
  pool.on('connect', (client) => { client.on('error', () => undefined); });
  return pool;
}

/**
 * Loggable fields for a database error: the SQLSTATE/errno code and the message, never the connection string. pg's own
 * messages do not quote DATABASE_URL, but anything resembling URL credentials or the configured password is masked anyway.
 */
export function dbErrorFields(err: unknown, databaseUrl: string | null): { code?: string; error: string } {
  const e = err as { code?: unknown; message?: unknown } | null;
  let msg = typeof e?.message === 'string' ? e.message : String(err);
  let pw = '';
  try { pw = databaseUrl ? decodeURIComponent(new URL(databaseUrl).password) : ''; } catch { /* unparsable: nothing to mask */ }
  if (pw) msg = msg.split(pw).join('[redacted]');
  msg = msg.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[redacted]@');
  return typeof e?.code === 'string' ? { code: e.code, error: msg } : { error: msg };
}
