// slotrush-server entry point: `node server-dist/main.mjs` (production, under systemd) or `npm run server:dev`.
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db';
import { createLogger } from './log';
import { schemaStatus } from './migrations';
import { MemoryResultSink, PgResultSink, type ResultSink } from './results';
import { RoomManager } from './rooms';

declare const __SLOTRUSH_BUILD__: string | undefined;

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.version === 'dev' && typeof __SLOTRUSH_BUILD__ === 'string') cfg.version = __SLOTRUSH_BUILD__;
  const log = createLogger(cfg.logLevel);
  const pool = cfg.databaseUrl ? createPool(cfg) : null;
  if (pool) {
    // rollout compatibility: never serve against a schema this build does not match (run `admin migrate` first)
    const s = await schemaStatus(pool);
    if (!s.current) { log.error('db.schema_outdated', { missing: s.missing }); process.exit(78); }
  } else {
    log.warn('db.disabled', { note: 'no DATABASE_URL: guests only, results kept in memory' });
  }
  const store: ResultSink = pool ? new PgResultSink(pool) : new MemoryResultSink();
  // results still being written when a stop begins are awaited (within the 5 s stop budget) before the pool closes
  const pending = new Set<Promise<unknown>>();
  const sink: ResultSink = { consume: (e) => { const p = store.consume(e); pending.add(p); void p.finally(() => pending.delete(p)).catch(() => undefined); return p; } };
  const manager = new RoomManager({ cfg, log, sink });
  const app = createApp({ cfg, log, manager, pool });
  const { port } = await app.listen();
  manager.start();
  log.info('server.listen', { host: cfg.host, port, version: cfg.version, roomCap: cfg.roomCap, env: cfg.env, db: !!pool });

  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('server.stop', { signal: sig });
    // races in progress end without a result (never a fabricated one); clients are told the service is restarting
    manager.shutdown('shutdown');
    const hard = setTimeout(() => process.exit(1), 5000); hard.unref();
    void Promise.allSettled([...pending]).then(() => app.close()).then(() => pool?.end()).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e: unknown) => {
  process.stderr.write(`slotrush-server failed to start: ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
});
