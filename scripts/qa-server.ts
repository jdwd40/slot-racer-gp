// Test tooling only (never in server-dist or a release): the real room server (createApp + RoomManager, the same modules
// main.ts runs) started in the check's own process, so scripts/online-check.mjs can read and seed authoritative race state
// (for example award a stop-and-go) while real browsers play through /ws. Bundled on the fly by online-check.mjs.
import { createApp } from '../server/app';
import { testConfig, type Config } from '../server/config';
import { memoryLogger } from '../server/log';
import { MemoryResultSink, PgResultSink } from '../server/results';
import { RoomManager } from '../server/rooms';
import { migrate } from '../server/migrations';
import pg from 'pg';
export { OnlineClient } from '../src/net/client';
export { default as WebSocket } from 'ws';

/** `db`: a local test database and a schema of its own (recreated), for accounts and profiles; omitted, guests only. */
export async function startQaServer(over: Partial<Config>, db?: { url: string; schema: string }) {
  let pool: pg.Pool | null = null;
  if (db) {
    const admin = new pg.Pool({ connectionString: db.url, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${db.schema} CASCADE; CREATE SCHEMA ${db.schema}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: db.url, max: 3, options: `-c search_path=${db.schema}` });
    await migrate(pool);
  }
  const cfg = testConfig({ host: '127.0.0.1', port: 0, ...(db ? { databaseUrl: db.url, sessionSecret: 'qa-only-session-secret-0123456789abcdef', cookieSecure: false } : {}), ...over });
  const log = memoryLogger('info');
  const sink = pool ? new PgResultSink(pool) : new MemoryResultSink();
  const manager = new RoomManager({ cfg, log, sink });
  const app = createApp({ cfg, log, manager, pool });
  const { port } = await app.listen();
  manager.start();
  return {
    cfg, log, sink, manager, port, url: `http://127.0.0.1:${port}`,
    room: (code: string) => manager.byCode(code),
    pool,
    async close() { manager.shutdown('shutdown'); await app.close(); await pool?.end(); },
  };
}
