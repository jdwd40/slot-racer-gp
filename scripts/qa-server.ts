// Test tooling only (never in server-dist or a release): the real room server (createApp + RoomManager, the same modules
// main.ts runs) started in the check's own process, so scripts/online-check.mjs can read and seed authoritative race state
// (for example award a stop-and-go) while real browsers play through /ws. Bundled on the fly by online-check.mjs.
import { createApp } from '../server/app';
import { testConfig, type Config } from '../server/config';
import { memoryLogger } from '../server/log';
import { MemoryResultSink, PgResultSink, type ResultSink } from '../server/results';
import { DurableSink } from '../server/spool';
import type { ResultEnvelope } from '../server/envelope';
import type { Scoring } from '../server/career';
import { RoomManager } from '../server/rooms';
import { migrate } from '../server/migrations';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export { OnlineClient } from '../src/net/client';
export { default as WebSocket } from 'ws';

/**
 * The check's switchable storage: while `storage.down` every store fails (so results wait in the durable queue); otherwise each
 * envelope goes to `inner` with the scoring policy the room finished with (#106: it used to be dropped, so a database-backed
 * check stored awards under the sink's default policy instead of the room's).
 */
export function gatedSink(inner: ResultSink, storage: { down: boolean }): ResultSink {
  return { consume: async (e: Readonly<ResultEnvelope>, scoring?: Scoring) => { if (storage.down) throw new Error('qa: storage down'); return inner.consume(e, scoring); } };
}

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
  // storage can be switched off by the check (`storage.down = true`) to show the pending-sync path; results then wait in the
  // durable queue (a throwaway spool directory, so they are on disk and reported 'pending' as in production) and are stored
  // when `durable.drain()` runs with storage back
  const storage = { down: false };
  const inner: ResultSink = pool ? new PgResultSink(pool) : new MemoryResultSink();
  const gated = gatedSink(inner, storage);
  const spoolDir = mkdtempSync(join(tmpdir(), 'slotrush-qa-spool-'));
  const durable = new DurableSink(gated, { dir: spoolDir, log, retryMs: 500, maxRetryMs: 1000 });
  const sink = durable;
  const manager = new RoomManager({ cfg, log, sink });
  durable.onSettled = (id, r) => manager.settled(id, r);
  const app = createApp({ cfg, log, manager, pool, pendingResults: () => durable.pending, unsavedResults: () => durable.unsaved });
  const { port } = await app.listen();
  manager.start();
  return {
    cfg, log, sink, manager, port, storage, durable, url: `http://127.0.0.1:${port}`,
    room: (code: string) => manager.byCode(code),
    pool,
    async close() { manager.shutdown('shutdown'); durable.stop(); await app.close(); await pool?.end(); rmSync(spoolDir, { recursive: true, force: true }); },
  };
}
