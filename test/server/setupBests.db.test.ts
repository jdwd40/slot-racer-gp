// Personal bests per car setup and tuning (#133) against a real PostgreSQL, in its own schema: migration 004 is additive on
// a database with stored results, awards and bests; Balanced at tuning 0 keeps using personal_bests (so bests from before
// setups stay current), every other setup or tuning has its own row in setup_bests; bests only get faster within one
// setup and tuning, and the career shows each labelled. Local: `npm run test:db`; skipped without SLOTRUSH_TEST_DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Standing } from '../../src/race';
import type { SetupId } from '../../src/carSetup';
import { LAPS } from '../helpers';
import { buildEnvelope, trackVersion, type EnvelopeParticipant, type ResultEnvelope } from '../../server/envelope';
import { makeScoring } from '../../server/career';
import { migrate, MIGRATIONS, schemaStatus } from '../../server/migrations';
import { PgResultSink } from '../../server/results';
import { careerStats } from '../../server/stats';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const SCHEMA = 't_setup_bests';
const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

describe.skipIf(!URL)('PostgreSQL: personal bests per car setup and tuning (#133)', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
  });
  afterAll(async () => { await pool?.end(); });

  let raceN = 0;
  /** One account's race: `setup` omitted (and `legacy`) gives a participant with no setup at all, as every envelope before #133. */
  function envelope(account: string, laps: [number, number, boolean][], o: { setup?: SetupId; tuning?: number; mode?: ResultEnvelope['mode'] } = {}): Readonly<ResultEnvelope> {
    raceN++;
    const raceId = `00000000-0000-4000-9000-${String(raceN).padStart(12, '0')}`;
    const p: EnvelopeParticipant = { id: 'p0', control: 'human', slot: 0, num: 7, bay: 0, name: 'D0', livery: 'blue', accountId: account, ...(o.setup ? { setup: o.setup, tuning: o.tuning ?? (o.setup === 'balanced' ? 0 : 1) } : {}) };
    const ai: EnvelopeParticipant = { id: 'ai_1', control: 'ai', slot: 1, num: 11, bay: 1, name: 'AI', livery: 'red', accountId: null, setup: 'balanced', tuning: 0 };
    const cls: Standing[] = [p, ai].map((x, i) => ({ id: x.id, slot: x.slot, control: x.control, pos: i + 1, status: 'finished', time: 100 + i, laps: LAPS, bestLap: 8, pitStops: 1, timePen: 0, dqReason: null, dnfReason: null }));
    const mode = o.mode ?? 'solo';
    return buildEnvelope({
      raceId, roomId: '66666666-6666-4666-8666-666666666666', mode, championship: null, outcome: mode === 'practice' ? 'ended' : 'completed', abortReason: null,
      trackId: 'circuit-1', settings: { track: 'circuit-1', aiFill: true, length: 'standard' }, participants: [p, ai],
      classification: mode === 'practice' ? null : cls,
      laps: laps.map(([lap, time, valid]) => ({ driver: 'p0', lap, time, valid, raceT: lap * 8 })),
      times: { roomCreatedAt: '2026-11-18T10:00:00.000Z', startedAt: '2026-11-18T10:00:01.000Z', greenAt: null, finishedAt: new Date(Date.UTC(2026, 10, 18, 10, raceN)).toISOString(), raceTimeS: 100, ticks: 1 },
    });
  }
  const rows = async (table: string, account: string) => (await pool.query(`SELECT * FROM ${table} WHERE account_id = $1 ORDER BY mode`, [account])).rows as Record<string, unknown>[];

  let account = '';
  let legacyRace = '';
  it('migration 004 is additive: a 003 database keeps every result, award and best exactly; the new table refuses Balanced at tuning 0', async () => {
    const c = await pool.connect();
    try {
      await c.query('CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const m of MIGRATIONS.slice(0, 3)) { await c.query(m.sql); await c.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, checksum(m.sql)]); }
      account = (await c.query<{ id: string }>("INSERT INTO accounts (username, username_key, password_hash) VALUES ('setup_pb', 'setup_pb', 'x') RETURNING id::text")).rows[0].id;
      await c.query("INSERT INTO profiles (account_id, display_name) VALUES ($1, 'Setup PB')", [account]);
    } finally { c.release(); }
    // a race stored by a server from before setups: its envelope names no setup, its best is in personal_bests
    const old = envelope(account, [[2, 8.2, true]]);
    legacyRace = old.raceId;
    expect(await new PgResultSink(pool).consume(old)).toBe('stored');
    const before = { pb: await rows('personal_bests', account), awards: (await pool.query('SELECT * FROM career_awards')).rows, results: (await pool.query('SELECT race_id, digest, envelope FROM race_results')).rows };
    expect(before.pb.map((r) => r.lap_ms)).toEqual([8200]);
    expect((await schemaStatus(pool)).missing).toEqual(['004_setup_bests']);
    expect(await migrate(pool)).toEqual(['004_setup_bests']);
    expect(await migrate(pool)).toEqual([]);
    expect((await schemaStatus(pool)).current).toBe(true);
    expect(await rows('personal_bests', account)).toEqual(before.pb);
    expect((await pool.query('SELECT * FROM career_awards')).rows).toEqual(before.awards);
    expect((await pool.query('SELECT race_id, digest, envelope FROM race_results')).rows).toEqual(before.results);
    // the new table never holds what personal_bests holds
    await expect(pool.query(`INSERT INTO setup_bests (account_id, track_id, track_version, mode, rules_version, setup, tuning, lap_ms, lap, race_id, livery, set_at)
      VALUES ($1, 'circuit-1', 'v', 'solo', 'r', 'balanced', 0, 1, 1, $2, 'blue', now())`, [account, legacyRace])).rejects.toThrow(/setup_bests_not_legacy/);
    await expect(pool.query(`INSERT INTO setup_bests (account_id, track_id, track_version, mode, rules_version, setup, tuning, lap_ms, lap, race_id, livery, set_at)
      VALUES ($1, 'circuit-1', 'v', 'solo', 'r', 'Speed!', 1, 1, 1, $2, 'blue', now())`, [account, legacyRace])).rejects.toThrow(/check/);
  });

  it('Balanced keeps the legacy best (same physics); Speed and Grip each get their own; nothing crosses between setups or tunings', async () => {
    const sink = new PgResultSink(pool);
    // a slower Balanced lap from a current server cannot replace the legacy best; a faster one does, in the same row
    await sink.consume(envelope(account, [[3, 8.4, true]], { setup: 'balanced' }));
    expect((await rows('personal_bests', account)).map((r) => r.lap_ms)).toEqual([8200]);
    await sink.consume(envelope(account, [[3, 8.1, true]], { setup: 'balanced' }));
    expect((await rows('personal_bests', account)).map((r) => r.lap_ms)).toEqual([8100]);
    // a much faster Speed lap is Speed's best only: Balanced's stays
    await sink.consume(envelope(account, [[4, 7.0, true]], { setup: 'speed' }));
    await sink.consume(envelope(account, [[4, 7.6, true]], { setup: 'grip' }));
    expect((await rows('personal_bests', account)).map((r) => r.lap_ms)).toEqual([8100]);
    expect((await rows('setup_bests', account)).map((r) => [r.setup, r.tuning, r.lap_ms]).sort()).toEqual([['grip', 1, 7600], ['speed', 1, 7000]]);
    // slower, invalid and concurrent laps within one setup: only ever faster
    const sl = envelope(account, [[5, 7.3, true]], { setup: 'speed' }), fa = envelope(account, [[5, 6.9, true]], { setup: 'speed' });
    await Promise.all([sink.consume(sl), sink.consume(fa), sink.consume(sl)]);
    await sink.consume(envelope(account, [[5, 5.0, false]], { setup: 'speed' }));
    expect((await rows('setup_bests', account)).filter((r) => r.setup === 'speed').map((r) => r.lap_ms)).toEqual([6900]);
    // a lap under another tuning of a setup (as after a retune) is its own record, never the current one's
    await sink.consume(envelope(account, [[2, 6.0, true]], { setup: 'speed', tuning: 7 }));
    expect((await rows('setup_bests', account)).filter((r) => r.setup === 'speed').map((r) => [r.tuning, r.lap_ms]).sort()).toEqual([[1, 6900], [7, 6000]]);
  });

  it('the career lists each best with its setup, marks an older tuning not current, and names each recent result\'s setup', async () => {
    const s = await careerStats(pool, account, 'Setup PB', makeScoring());
    const solo = s.bests.filter((b) => b.mode === 'solo').map((b) => [b.setup, b.tuning, b.lapMs, b.current, b.tuningCurrent]);
    expect(solo).toEqual([['balanced', 0, 8100, true, true], ['grip', 1, 7600, true, true], ['speed', 7, 6000, false, false], ['speed', 1, 6900, true, true]]);
    expect(s.bests.every((b) => b.track === 'circuit-1' && b.trackVersion === trackVersion('circuit-1'))).toBe(true);
    // recent results: the driver's own setup from the stored envelope; one stored before setups is Balanced
    const recent = new Map(s.recent.map((r) => [r.raceId, r.setup]));
    expect(recent.get(legacyRace)).toBe('balanced');
    expect([...recent.values()].filter((x) => x === 'speed').length).toBeGreaterThan(0);
    // the stored legacy envelope is untouched: still no setup on its participant
    const env = (await pool.query<{ envelope: ResultEnvelope }>('SELECT envelope FROM race_results WHERE race_id = $1', [legacyRace])).rows[0].envelope;
    expect(env.participants[0]).not.toHaveProperty('setup');
    // reverting the migration is dropping its one table: nothing else depends on it
    const deps = await pool.query("SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'setup_bests'::regclass");
    expect(deps.rows).toEqual([]);
  });
});
