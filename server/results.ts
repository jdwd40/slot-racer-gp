// Result sinks: where finalized envelopes go. Consumption is idempotent by raceId: the same envelope again is a no-op
// ('duplicate'), and a different envelope for a race already stored is refused ('conflict'), so a result can never change
// or be counted twice downstream. Account awards and statistics are a later task and do not read this yet.
import type { Pool } from 'pg';
import type { ResultEnvelope } from './envelope';

export type ConsumeResult = 'stored' | 'duplicate';
export class ResultConflict extends Error {}

export interface ResultSink { consume(e: Readonly<ResultEnvelope>): Promise<ConsumeResult>; }

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
  constructor(private pool: Pool) {}
  async consume(e: Readonly<ResultEnvelope>): Promise<ConsumeResult> {
    const ins = await this.pool.query(
      `INSERT INTO race_results (race_id, room_id, mode, outcome, track_id, rules_version, digest, envelope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (race_id) DO NOTHING RETURNING race_id`,
      [e.raceId, e.roomId, e.mode, e.outcome, e.track.id, e.rules.version, e.digest, JSON.stringify(e)],
    );
    if (ins.rowCount === 1) return 'stored';
    const had = await this.pool.query<{ digest: string }>('SELECT digest FROM race_results WHERE race_id = $1', [e.raceId]);
    if (had.rows[0]?.digest !== e.digest) throw new ResultConflict(`race ${e.raceId} already has a different result`);
    return 'duplicate';
  }
}
