// The signed-in account's own career: totals summed from the award ledger (never a stored counter that could drift from
// it), verified personal bests and recent results. The account id always comes from the authenticated session.
import type { Pool } from 'pg';
import type { CareerStats, Mode } from '../src/net/protocol';
import type { Scoring } from './career';
import { trackVersion } from './envelope';

const RECENT = 10;

export async function careerStats(pool: Pool, accountId: string, displayName: string, scoring: Scoring): Promise<CareerStats> {
  const [tot, bests, recent] = await Promise.all([
    pool.query<{ points: string; races: string; wins: string; seconds: string; thirds: string; dq: string; dnf: string }>(
      `SELECT COALESCE(sum(points), 0) AS points, count(*) AS races,
              count(*) FILTER (WHERE position = 1) AS wins, count(*) FILTER (WHERE position = 2) AS seconds,
              count(*) FILTER (WHERE position = 3) AS thirds, count(*) FILTER (WHERE status = 'dq') AS dq,
              count(*) FILTER (WHERE status = 'dnf') AS dnf
       FROM career_awards WHERE account_id = $1`, [accountId]),
    pool.query<{ track_id: string; track_version: string; mode: Mode; rules_version: string; lap_ms: number; lap: number; livery: string; race_id: string; set_at: Date }>(
      `SELECT track_id, track_version, mode, rules_version, lap_ms, lap, livery, race_id::text, set_at
       FROM personal_bests WHERE account_id = $1 ORDER BY track_id, mode, set_at DESC`, [accountId]),
    pool.query<{ race_id: string; mode: Mode; championship_id: string | null; championship_round: number | null; track_id: string; position: number | null; status: 'finished' | 'dq' | 'dnf'; points: number; field_size: number; humans: number; scoring_version: string; rules_version: string; finished_at: Date }>(
      `SELECT race_id::text, mode, championship_id, championship_round, track_id, position, status, points, field_size, humans, scoring_version, rules_version, finished_at
       FROM career_awards WHERE account_id = $1 ORDER BY finished_at DESC, race_id LIMIT ${RECENT}`, [accountId]),
  ]);
  const t = tot.rows[0];
  const cur = (id: string): string | null => { try { return trackVersion(id); } catch { return null; } };
  return {
    displayName,
    scoring: { version: scoring.version, podium: [...scoring.podium] },
    career: { points: Number(t.points), races: Number(t.races), wins: Number(t.wins), seconds: Number(t.seconds), thirds: Number(t.thirds), dq: Number(t.dq), dnf: Number(t.dnf) },
    bests: bests.rows.map((r) => ({
      track: r.track_id, trackVersion: r.track_version, current: cur(r.track_id) === r.track_version, mode: r.mode, rules: r.rules_version,
      lapMs: r.lap_ms, lap: r.lap, livery: r.livery, raceId: r.race_id, setAt: r.set_at.toISOString(),
    })),
    recent: recent.rows.map((r) => ({
      raceId: r.race_id, mode: r.mode, championship: r.championship_id ? { id: r.championship_id, round: r.championship_round ?? 0 } : null,
      track: r.track_id, pos: r.position, status: r.status, points: r.points, field: r.field_size, humans: r.humans,
      scoring: r.scoring_version, rules: r.rules_version, finishedAt: r.finished_at.toISOString(),
    })),
  };
}
