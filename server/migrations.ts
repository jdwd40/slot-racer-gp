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
  {
    // #24: driver profiles. One row per account, keyed by the stable account id, so a rename never makes a new identity and
    // never detaches anything recorded against that id. Additive: a release that predates it ignores the table, and an
    // account without a row (made by such a release) reads as its username until it saves a name.
    id: '002_driver_profiles',
    sql: `
CREATE TABLE profiles (
  account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- the application normalizes (src/net/protocol.ts checkDisplayName); the database still refuses blank, padded or long names
  CONSTRAINT profiles_display_name_shape CHECK (char_length(display_name) BETWEEN 1 AND 16 AND display_name = btrim(display_name) AND display_name !~ '[[:cntrl:]]')
);
INSERT INTO profiles (account_id, display_name) SELECT id, left(username, 16) FROM accounts;
`,
  },
  {
    // #25: career points and personal bests. Additive only: existing accounts, profiles, sessions and stored results are kept
    // as they are, and results stored before this migration are not scored retroactively (scoring_version stays NULL). The
    // award ledger is the only source of career totals (they are summed from it), so totals can never disagree with it.
    id: '003_career_awards_bests',
    sql: `
ALTER TABLE race_results ADD COLUMN scoring_version text;

CREATE TABLE career_awards (
  race_id uuid NOT NULL REFERENCES race_results(race_id),
  participant_id text NOT NULL,
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scoring_version text NOT NULL,
  rules_version text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('multiplayer', 'solo', 'championship')),
  championship_id text,
  championship_round int,
  track_id text NOT NULL,
  track_version text NOT NULL,
  position int CHECK (position IS NULL OR position >= 1),
  status text NOT NULL CHECK (status IN ('finished', 'dq', 'dnf')),
  points int NOT NULL CHECK (points >= 0),
  field_size int NOT NULL,
  humans int NOT NULL,
  driver_name text NOT NULL,
  livery text NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (race_id, participant_id, scoring_version),
  -- one account holds one seat per race: it can never be credited twice for the same race under any participant id
  UNIQUE (race_id, account_id, scoring_version),
  CONSTRAINT career_awards_points_shape CHECK ((status = 'finished' AND position IS NOT NULL) OR (status <> 'finished' AND position IS NULL AND points = 0))
);
CREATE INDEX career_awards_account ON career_awards (account_id, finished_at DESC);

-- the ledger is append-only: an award, once written, never changes
CREATE FUNCTION career_awards_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'career_awards rows are immutable';
END $$;
CREATE TRIGGER career_awards_no_update BEFORE UPDATE ON career_awards FOR EACH ROW EXECUTE FUNCTION career_awards_immutable();

-- fastest valid authoritative lap per account, circuit layout version, mode and rules version; only ever lowered
CREATE TABLE personal_bests (
  account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  track_id text NOT NULL,
  track_version text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('multiplayer', 'solo', 'championship', 'practice')),
  rules_version text NOT NULL,
  source text NOT NULL DEFAULT 'verified' CHECK (source = 'verified'),
  lap_ms int NOT NULL CHECK (lap_ms > 0),
  lap int NOT NULL,
  race_id uuid NOT NULL REFERENCES race_results(race_id),
  livery text NOT NULL,
  set_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, track_id, track_version, mode, rules_version)
);
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

type SchemaStatus = { current: boolean; applied: string[]; missing: string[] };
function statusOf(rows: { id: string; checksum: string }[]): SchemaStatus {
  const map = new Map(rows.map((r) => [r.id, r.checksum]));
  const missing = MIGRATIONS.filter((m) => map.get(m.id) !== checksum(m)).map((m) => m.id);
  return { current: !missing.length, applied: rows.map((r) => r.id), missing };
}
const STATUS_SQL = 'SELECT id, checksum FROM schema_migrations ORDER BY id';

/**
 * The schema check the service runs at start (and `admin status`): every migration it knows must be applied, unchanged.
 * It first creates the empty bookkeeping table if it is missing, as it always has; /api/health uses `readSchemaStatus`.
 */
export async function schemaStatus(pool: Pool): Promise<SchemaStatus> {
  await ensureTable(pool).catch(() => undefined);
  return statusOf((await pool.query<{ id: string; checksum: string }>(STATUS_SQL)).rows);
}

/**
 * The same check, read-only: one SELECT and no DDL, for the public health endpoint (#98). A database where no migration
 * has ever run (no `schema_migrations` table, SQLSTATE 42P01) reads as nothing applied, not as a failure.
 */
export async function readSchemaStatus(pool: Pick<Pool, 'query'>): Promise<SchemaStatus> {
  try {
    return statusOf((await pool.query<{ id: string; checksum: string }>(STATUS_SQL)).rows);
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== '42P01') throw e;
    return statusOf([]);
  }
}
