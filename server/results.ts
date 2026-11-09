// Result sinks: where finalized envelopes go. Consumption is idempotent by raceId: the same envelope again is a no-op
// ('duplicate'), and a different envelope for a race already stored is refused (ResultConflict), so a result can never change
// or be counted twice downstream. The PostgreSQL sink stores the result, its career award ledger and any personal bests in
// one transaction (docs/career.md): either all of it is stored, or none of it is.
import type { Pool, PoolClient } from 'pg';
import { computeAwards, lapBests, makeScoring, type Scoring } from './career';
import type { ResultEnvelope } from './envelope';

/**
 * 'queued': storage failed for now; the result is written to the spool on disk and retried (server/spool.ts).
 * 'unsaved': storage failed and no durable copy could be written either (spool unwritable or full, or no spool configured):
 * it is retried from memory only and a restart before it is stored loses it, so it must never be reported as safe.
 */
export type ConsumeResult = 'stored' | 'duplicate' | 'queued' | 'unsaved';
export class ResultConflict extends Error { override name = 'ResultConflict'; }

/**
 * `scoring` is the career policy the awards were computed with when the race finished (what the room showed); a sink that
 * awards points stores exactly that policy, even when the result is only stored later. Omitted: the sink's own default.
 */
export interface ResultSink { consume(e: Readonly<ResultEnvelope>, scoring?: Scoring): Promise<ConsumeResult>; }

export class MemoryResultSink implements ResultSink {
  readonly stored = new Map<string, Readonly<ResultEnvelope>>();
  calls = 0;
  async consume(e: Readonly<ResultEnvelope>): Promise<ConsumeResult> {
    this.calls++;
    const had = this.stored.get(e.raceId);
    if (had) { if (had.digest !== e.digest) throw new ResultConflict(`race ${e.raceId} already has a different result`); return 'duplicate'; }
    this.stored.set(e.raceId, e);
    return 'stored';
  }
}

export class PgResultSink implements ResultSink {
  constructor(private pool: Pool, readonly scoring: Scoring = makeScoring()) {}

  async consume(e: Readonly<ResultEnvelope>, scoring: Scoring = this.scoring): Promise<ConsumeResult> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // a concurrent consumer of the same race waits here on the primary key and then sees the stored row: one inserts
      const ins = await c.query(
        `INSERT INTO race_results (race_id, room_id, mode, outcome, track_id, rules_version, digest, envelope, scoring_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (race_id) DO NOTHING RETURNING race_id`,
        [e.raceId, e.roomId, e.mode, e.outcome, e.track.id, e.rules.version, e.digest, JSON.stringify(e), scoring.version],
      );
      if (ins.rowCount !== 1) {
        await c.query('ROLLBACK');
        // on the same connection: asking the pool for another while holding this one could exhaust it under concurrent retries
        const had = await c.query<{ digest: string }>('SELECT digest FROM race_results WHERE race_id = $1', [e.raceId]);
        if (had.rows[0]?.digest !== e.digest) throw new ResultConflict(`race ${e.raceId} already has a different result`);
        return 'duplicate';
      }
      await this.award(c, e, scoring);
      await c.query('COMMIT');
      return 'stored';
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { c.release(); }
  }

  /** Ledger rows and personal bests for a result inserted in this transaction (never for a duplicate). */
  private async award(c: PoolClient, e: Readonly<ResultEnvelope>, scoring: Scoring): Promise<void> {
    const { ledger } = computeAwards(e, scoring);
    const byId = new Map(e.participants.map((p) => [p.id, p]));
    const field = e.classification?.length ?? 0;
    const humans = e.participants.filter((p) => p.control === 'human').length;
    for (const a of ledger) {
      const p = byId.get(a.participant)!;
      await c.query(
        `INSERT INTO career_awards (race_id, participant_id, account_id, scoring_version, rules_version, mode, championship_id, championship_round,
           track_id, track_version, position, status, points, field_size, humans, driver_name, livery, finished_at)
         SELECT $1, $2, a.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17 FROM accounts a WHERE a.id = $18
         ON CONFLICT DO NOTHING`,
        [e.raceId, a.participant, scoring.version, e.rules.version, e.mode, e.championship?.id ?? null, e.championship?.round ?? null,
          e.track.id, e.track.version, a.pos, a.status, a.points, field, humans, p.name, p.livery, e.times.finishedAt, a.accountId],
      );
    }
    for (const b of lapBests(e)) {
      // monotonic: a slower (or equal) lap never replaces a stored one, whatever order concurrent transactions commit in
      await c.query(
        `INSERT INTO personal_bests (account_id, track_id, track_version, mode, rules_version, lap_ms, lap, race_id, livery, set_at)
         SELECT a.id, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM accounts a WHERE a.id = $1
         ON CONFLICT (account_id, track_id, track_version, mode, rules_version) DO UPDATE
           SET lap_ms = EXCLUDED.lap_ms, lap = EXCLUDED.lap, race_id = EXCLUDED.race_id, livery = EXCLUDED.livery, set_at = EXCLUDED.set_at
           WHERE EXCLUDED.lap_ms < personal_bests.lap_ms`,
        [b.accountId, b.trackId, b.trackVersion, b.mode, b.rulesVersion, b.lapMs, b.lap, b.raceId, b.livery, e.times.finishedAt],
      );
    }
  }
}
