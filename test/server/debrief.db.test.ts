// Post-race debrief (#134) against a real PostgreSQL, in its own schema: no migration (the summary lives inside the stored
// envelope JSON). A room's envelope with debriefs survives the spool (database down, written to disk, replayed by a fresh
// process) and is stored byte for byte; a duplicate never awards again; an envelope from before debriefs stores and reads
// as before. Local: `npm run test:db`; skipped without SLOTRUSH_TEST_DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { readDebrief } from '../../src/debrief';
import type { ResultEnvelope } from '../../server/envelope';
import type { Scoring } from '../../server/career';
import { memoryLogger } from '../../server/log';
import { migrate } from '../../server/migrations';
import { PgResultSink, type ResultSink } from '../../server/results';
import { DurableSink } from '../../server/spool';
import { careerStats } from '../../server/stats';
import { makeScoring } from '../../server/career';
import { FakePeer, harness } from './harness';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const SCHEMA = 't_debrief';

class Switch implements ResultSink {
  down = false;
  constructor(public inner: ResultSink) {}
  async consume(e: Readonly<ResultEnvelope>, s?: Scoring) { if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); return this.inner.consume(e, s); }
}

/** A connected solo race of a signed-in driver, run to its result in-process. */
function soloRace(accountId: string, seed: number): Readonly<ResultEnvelope> {
  const h = harness({}, seed);
  const c = h.mgr.create(new FakePeer(), { name: 'Deb', accountId, mode: 'solo', settings: { track: 'circuit-2', length: 'sprint' }, lengths: 1, setups: 1 });
  if (!c.ok) throw new Error(c.code);
  c.room.handle(c.participant, { t: 'start' }, h.now);
  let n = 0;
  h.advance(3_000_000, 50, () => { n++; c.room.handle(c.participant, { t: 'ctl', seq: n, up: n % 40 < 33, down: false }, h.now); }, () => c.room.state !== 'race');
  return c.room.result!;
}

describe.skipIf(!URL)('PostgreSQL: result envelopes with debriefs (#134)', () => {
  let pool: pg.Pool;
  let account = '';
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    await migrate(pool);
    account = (await pool.query<{ id: string }>("INSERT INTO accounts (username, username_key, password_hash) VALUES ('debrief', 'debrief', 'x') RETURNING id::text")).rows[0].id;
    await pool.query("INSERT INTO profiles (account_id, display_name) VALUES ($1, 'Deb')", [account]);
  });
  afterAll(async () => { await pool?.end(); });

  it('spooled while the database is down, replayed by a fresh process: stored once, debrief intact, awards once', async () => {
    const env = soloRace(account, 77);
    expect(env.debrief?.drivers).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), 'srgp-debrief-spool-'));
    const sw = new Switch(new PgResultSink(pool));
    sw.down = true;
    const first = new DurableSink(sw, { dir, log: memoryLogger(), retryMs: 60_000 });
    expect(await first.consume(env)).toBe('queued');
    expect(readdirSync(dir)).toEqual([`${env.raceId}.json`]);
    // a new process with the database back drains the spool: the file's digest check covers the debrief too
    const second = new DurableSink(new PgResultSink(pool), { dir, log: memoryLogger() });
    await second.start();
    expect(second.pending).toBe(0);
    const row = (await pool.query<{ envelope: ResultEnvelope; digest: string }>('SELECT envelope, digest FROM race_results WHERE race_id = $1', [env.raceId])).rows[0];
    expect(row.digest).toBe(env.digest);
    expect(row.envelope.debrief).toEqual(JSON.parse(JSON.stringify(env.debrief)));
    const pid = env.participants.find((p) => p.control === 'human')!.id;
    expect(readDebrief(row.envelope, pid)).toEqual(readDebrief(env, pid));
    // a duplicate (a retry, a resend) is a no-op: one result, one award row
    expect(await new PgResultSink(pool).consume(env)).toBe('duplicate');
    const awards = await pool.query('SELECT 1 FROM career_awards WHERE race_id = $1', [env.raceId]);
    expect(awards.rowCount).toBe(1);
  });

  it('an envelope from before debriefs (an older server) stores and reads as before; the career lists both races', async () => {
    const env = soloRace(account, 78);
    // as an older server would have built it: the same envelope without the debrief, under its own digest
    const { debrief: _d, digest: _g, ...body } = env;
    const { digestOf } = await import('../../server/envelope');
    const old = { ...body, raceId: '00000000-0000-4000-9000-000000000134', digest: '' } as ResultEnvelope;
    old.digest = digestOf((({ digest: _x, ...b }) => b)(old));
    expect(await new PgResultSink(pool).consume(old)).toBe('stored');
    const row = (await pool.query<{ envelope: ResultEnvelope }>('SELECT envelope FROM race_results WHERE race_id = $1', [old.raceId])).rows[0];
    expect(row.envelope.debrief).toBeUndefined();
    expect(readDebrief(row.envelope, env.participants[0].id)).toBeNull();
    const stats = await careerStats(pool, account, 'Deb', makeScoring());
    expect(stats.career.races).toBe(2);
    expect(stats.recent.map((x) => x.raceId)).toContain(old.raceId);
  });
});
