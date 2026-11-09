// Database migrations, applied in order by `admin migrate` (never implicitly at service start: the service refuses to start
// on a schema older than it needs, which is the rollout compatibility check). Each migration is immutable once released:
// its checksum is recorded, and a changed migration is refused. PostgreSQL 17 (verified locally on 18; no 18-only syntax).
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface Migration { id: string; sql: string; }

export const MIGRATIONS: Migration[] = [
  {
    id: '001_accounts_sessions_results',
    sql: `
CREATE TABLE accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_username_shape CHECK (username_key ~ '^[a-z0-9_-]{3,20}$' AND lower(username) = username_key)
);
-- no email (or any contact) column, by design: recovery is the owner-run admin reset

CREATE TABLE sessions (
  sid text PRIMARY KEY,
  account_id bigint REFERENCES accounts(id) ON DELETE CASCADE,
  sess jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);
CREATE INDEX sessions_account_id ON sessions (account_id);

CREATE TABLE race_results (
  race_id uuid PRIMARY KEY,
  room_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('multiplayer', 'solo', 'championship', 'practice')),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'aborted', 'ended')),
  track_id text NOT NULL,
  rules_version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- a stored result is immutable
CREATE FUNCTION race_results_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'race_results rows are immutable';
END $$;
CREATE TRIGGER race_results_no_update BEFORE UPDATE ON race_results FOR EACH ROW EXECUTE FUNCTION race_results_immutable();
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].id;
const checksum = (m: Migration): string => createHash('sha256').update(m.sql).digest('hex');
const LOCK = 7_220_221;   // advisory lock id: one migrator at a time

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

/** Apply every pending migration, each in its own transaction, under an advisory lock. Returns the ids applied. */
export async function migrate(pool: Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await c.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations')).rows.map((r) => [r.id, r.checksum]));
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      const had = done.get(m.id);
      if (had) { if (had !== checksum(m)) throw new Error(`migration ${m.id} was changed after it was applied`); continue; }
      await c.query('BEGIN');
      try {
        await c.query(m.sql);
        await c.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, checksum(m)]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      applied.push(m.id);
    }
    return applied;
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    c.release();
  }
}

/** The schema check the service runs at start: every migration it knows must be applied, unchanged. */
export async function schemaStatus(pool: Pool): Promise<{ current: boolean; applied: string[]; missing: string[] }> {
  await ensureTable(pool).catch(() => undefined);
  const rows = (await pool.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id')).rows;
  const map = new Map(rows.map((r) => [r.id, r.checksum]));
  const missing = MIGRATIONS.filter((m) => map.get(m.id) !== checksum(m)).map((m) => m.id);
  return { current: !missing.length, applied: rows.map((r) => r.id), missing };
}
