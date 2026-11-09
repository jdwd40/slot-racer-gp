// The immutable result envelope: one per race, built once by the room that owned the race, from server state only.
// Storage (later account statistics) consumes it idempotently by raceId; see server/results.ts.
import { createHash } from 'node:crypto';
import type { Standing } from '../src/race';
import { TRACKS } from '../src/track';
import { PROTOCOL_VERSION, RULES_VERSION, type ChampionshipTag, type LiveryId, type Mode, type RoomSettings } from '../src/net/protocol';

export const ENVELOPE_SCHEMA = 1;

export interface EnvelopeParticipant {
  id: string; control: 'human' | 'ai'; slot: number; num: number; bay: number; name: string; livery: LiveryId;
  /** a signed-in account, or null for a guest or AI. A display name is never an identity. */
  accountId: string | null;
}
export interface EnvelopeLap { driver: string; lap: number; time: number; valid: boolean; raceT: number; }
export interface ResultEnvelope {
  schema: number;
  raceId: string; roomId: string;
  mode: Mode; championship: ChampionshipTag | null;
  /** 'completed': classifications are authoritative. 'aborted': the race was stopped (overload, shutdown, room lifetime);
   *  it has no classifications and must never be scored. 'ended': a practice session (laps only). */
  outcome: 'completed' | 'aborted' | 'ended';
  abortReason: string | null;
  track: { id: string; version: string };
  rules: { version: string; protocol: number };
  settings: RoomSettings;
  participants: EnvelopeParticipant[];
  classification: Standing[] | null;
  laps: EnvelopeLap[];
  times: { roomCreatedAt: string; startedAt: string; greenAt: string | null; finishedAt: string; raceTimeS: number; ticks: number };
  /** SHA-256 over every other field: two envelopes for one race are the same result exactly when their digests match */
  digest: string;
}

const trackVersions = new Map<string, string>();
/** Content version of a circuit definition: changes whenever its geometry or layout data changes. */
export function trackVersion(id: string): string {
  let v = trackVersions.get(id);
  if (!v) {
    const def = TRACKS.find((d) => d.id === id);
    if (!def) throw new Error(`unknown track ${id}`);
    v = createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
    trackVersions.set(id, v);
  }
  return v;
}

function deepFreeze<V>(v: V): V {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); Object.freeze(v); }
  return v;
}

export function digestOf(e: Omit<ResultEnvelope, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(e)).digest('hex');
}

export function buildEnvelope(e: Omit<ResultEnvelope, 'digest' | 'schema' | 'rules' | 'track'> & { trackId: string }): Readonly<ResultEnvelope> {
  const { trackId, ...rest } = e;
  const body: Omit<ResultEnvelope, 'digest'> = {
    schema: ENVELOPE_SCHEMA,
    raceId: rest.raceId, roomId: rest.roomId, mode: rest.mode, championship: rest.championship ? { ...rest.championship } : null,
    outcome: rest.outcome, abortReason: rest.abortReason,
    track: { id: trackId, version: trackVersion(trackId) },
    rules: { version: RULES_VERSION, protocol: PROTOCOL_VERSION },
    settings: { ...rest.settings },
    participants: rest.participants.map((p) => ({ ...p })),
    classification: rest.classification ? rest.classification.map((s) => ({ ...s })) : null,
    laps: rest.laps.map((l) => ({ ...l })),
    times: { ...rest.times },
  };
  // a round trip makes the envelope plain JSON (no undefined, no Infinity) before it is hashed
  const plain = JSON.parse(JSON.stringify(body)) as Omit<ResultEnvelope, 'digest'>;
  return deepFreeze({ ...plain, digest: digestOf(plain) });
}
