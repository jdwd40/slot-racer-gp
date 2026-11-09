// PostgreSQL pool for the game's own database and role (see docs/online-server.md for the role/database setup).
import pg from 'pg';
import type { Config } from './config';

export type Pool = pg.Pool;

export function createPool(cfg: Pick<Config, 'databaseUrl' | 'dbPoolMax'>): pg.Pool {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    application_name: 'slotrush-server',
  });
}
