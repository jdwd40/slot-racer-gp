// Account career points and personal bests, computed only from a server-finalized result envelope (server/envelope.ts).
// Pure functions: the same envelope always yields the same awards, so every client of a room is shown identical numbers and
// a stored result can be re-derived for audit. Policy and reasons: docs/career.md.
import type { AwardRow, AwardsView } from '../src/net/protocol';
import type { ResultEnvelope } from './envelope';

/** Career points for 1st, 2nd, 3rd. Fourth and lower, DQ and DNF score 0. Distinct from local championship points (10/6/4/2). */
export const DEFAULT_PODIUM: readonly number[] = Object.freeze([10, 6, 4]);

export interface Scoring {
  /** stored with every ledger entry; derived from the points so a tuning change is always a new version */
  version: string;
  podium: readonly number[];
}

export function makeScoring(podium: readonly number[] = DEFAULT_PODIUM): Scoring {
  if (!podium.length || podium.length > 8 || podium.some((p) => !Number.isInteger(p) || p < 0 || p > 1000)) throw new Error('career points: 1-8 integers from 0 to 1000');
  return Object.freeze({ version: `career-1:${podium.join('-')}`, podium: Object.freeze([...podium]) });
}

/** A ledger entry before storage: only participants that are signed-in humans (account credit). */
export interface Award extends AwardRow { accountId: string; }

export interface Awards {
  view: Omit<AwardsView, 'sync'>;
  /** the rows that credit an account (each stored once per race, participant and scoring version) */
  ledger: Award[];
}

/**
 * Awards for one finalized race. Only a `completed` race of a scoring mode is eligible; its classification already contains
 * penalties and disqualifications (the race core classifies once every car is terminal), so a car disqualified on its final
 * lap is `dq` with no position here and the cars behind it move up. AI and guest finishers keep their positions but credit
 * nobody. Practice, aborted and ended sessions award nothing.
 */
export function computeAwards(env: Readonly<ResultEnvelope>, scoring: Scoring): Awards {
  const reason: AwardsView['reason'] = env.mode === 'practice' ? 'practice' : env.outcome !== 'completed' || !env.classification ? 'incomplete' : null;
  const base = { raceId: env.raceId, scoring: scoring.version, eligible: reason === null, reason };
  if (reason) return { view: { ...base, rows: [] }, ledger: [] };
  const byId = new Map(env.participants.map((p) => [p.id, p]));
  const rows: AwardRow[] = [];
  const ledger: Award[] = [];
  for (const s of env.classification!) {
    const p = byId.get(s.id);
    const accountId = p && p.control === 'human' ? p.accountId : null;
    const pos = s.status === 'finished' ? s.pos : null;
    const points = accountId && pos !== null && pos >= 1 && pos <= scoring.podium.length ? scoring.podium[pos - 1] : 0;
    const row: AwardRow = { participant: s.id, pos, status: s.status, credit: !!accountId, points };
    rows.push(row);
    if (accountId) ledger.push({ ...row, accountId });
  }
  return { view: { ...base, rows }, ledger };
}

/** Personal-best candidate: an account's fastest valid authoritative lap in one race. */
export interface LapBest {
  accountId: string; participant: string; trackId: string; trackVersion: string; mode: ResultEnvelope['mode']; rulesVersion: string;
  lapMs: number; lap: number; raceId: string; livery: string;
}

/** Shortest plausible lap: anything faster is not a lap (defence in depth; the simulation never produces one). */
const MIN_LAP_MS = 1000;

/**
 * The fastest valid lap of each signed-in human in a race that ran to its end (completed race or ended practice). Every lap
 * the simulation reported counts, including the final race lap (the room records the lap event before the finish). A lap
 * the race core marked invalid (checkpoints missed, reversing, pit lane, collision, de-slot/tow) never qualifies.
 */
export function lapBests(env: Readonly<ResultEnvelope>): LapBest[] {
  if (env.outcome === 'aborted') return [];
  const out: LapBest[] = [];
  for (const p of env.participants) {
    if (p.control !== 'human' || !p.accountId) continue;
    let best: { ms: number; lap: number } | null = null;
    for (const l of env.laps) {
      if (l.driver !== p.id || !l.valid || !Number.isFinite(l.time)) continue;
      const ms = Math.round(l.time * 1000);
      if (ms < MIN_LAP_MS) continue;
      if (!best || ms < best.ms) best = { ms, lap: l.lap };
    }
    if (best) out.push({
      accountId: p.accountId, participant: p.id, trackId: env.track.id, trackVersion: env.track.version, mode: env.mode,
      rulesVersion: env.rules.version, lapMs: best.ms, lap: best.lap, raceId: env.raceId, livery: p.livery,
    });
  }
  return out;
}

/** `SLOTRUSH_CAREER_POINTS="10,6,4"` (the default) */
export function parsePodium(raw: string | undefined): readonly number[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PODIUM;
  const v = raw.split(',').map((s) => Number(s.trim()));
  makeScoring(v);
  return v;
}
