// Online room protocol, shared by the room server (server/) and any client (browser or headless). Plain data only: no
// secrets, no Node or DOM APIs, so the browser bundle can import it. See docs/online-server.md for the message reference.
import type { ActionType, Input } from '../race';
import type { StateFrame } from './snapwire';

/**
 * Wire protocol version. Bump on any incompatible message change; a client and server must agree exactly. History: 1 first
 * online protocol; 2 `state` snapshots as keyframes and deltas with static car fields once per race (#67, src/net/snapwire.ts).
 */
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_NAME = 'slotrush';
/**
 * Race rules version recorded in every result envelope. Bump whenever a change to the simulation (physics, timing, service,
 * penalties, classification) could change a result, so stored results from different rules are never compared as equal.
 */
export const RULES_VERSION = 'race-core-2026.11.6';

/** Hard limits a client must respect. The server enforces every one of them. */
export const LIMITS = Object.freeze({
  /** largest client message the protocol parser accepts (bytes, UTF-8); the socket closes at twice this */
  maxMessageBytes: 512,
  /** a client must send `hello` within this long of connecting */
  helloTimeoutMs: 5000,
  /** held controls not refreshed for this long are neutralized (heartbeat at least every 250 ms) */
  inputTimeoutMs: 1000,
  /** an action or control sequence number may jump at most this far ahead of the last accepted one */
  maxSeqJump: 1024,
  nameMax: 16,
  codeLength: 6,
  maxHumans: 4,
});

/** Room-code alphabet: no 0/O, 1/I/L, so a code read aloud or from a screen is unambiguous. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type Mode = 'multiplayer' | 'solo' | 'championship' | 'practice';
export const MODES: readonly Mode[] = ['multiplayer', 'solo', 'championship', 'practice'];

/** Livery palette. Every colour in a room is distinct; a request for a taken livery is resolved visibly to a free one. */
export const LIVERIES = Object.freeze([
  { id: 'yellow', color: 0xffcc1a }, { id: 'red', color: 0xe8322a }, { id: 'blue', color: 0x2a6df0 }, { id: 'green', color: 0x22b04b },
  { id: 'orange', color: 0xff7a1a }, { id: 'purple', color: 0x9b4dff }, { id: 'cyan', color: 0x1ad1d9 }, { id: 'white', color: 0xf2f2f2 },
] as const);
export type LiveryId = (typeof LIVERIES)[number]['id'];
export const isLivery = (x: unknown): x is LiveryId => typeof x === 'string' && LIVERIES.some((l) => l.id === x);

export interface RoomSettings {
  track: string;
  /** fill the seats no human takes with AI cars (always on for solo and championship, never for practice) */
  aiFill: boolean;
}

export interface ChampionshipTag { id: string; round: number; }

// ------------------------------------------------------------------------------------------------ client -> server
/**
 * `expectAccount` on create/join: the account id the browser believes it is signed in as ('' = a guest). It is never an
 * identity (that only ever comes from the socket's session); a socket whose sign-in differs is refused, `expired`/`session`,
 * instead of entering under an identity the page does not show (a session that expired before the socket opened).
 */
export type ClientMsg =
  | { t: 'hello'; v: number; proto: string }
  | { t: 'create'; name: string; livery?: LiveryId; mode: Mode; settings: Partial<RoomSettings>; championship?: ChampionshipTag; expectAccount?: string }
  | { t: 'join'; code: string; name: string; livery?: LiveryId; expectAccount?: string }
  | { t: 'resume'; room: string; participant: string; token: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'livery'; livery: LiveryId }
  | { t: 'start' }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ctl'; seq: number; up: boolean; down: boolean; driver?: string }
  | { t: 'act'; seq: number; type: ActionType; driver?: string }
  | { t: 'ping'; id: number };

export type ClientMsgType = ClientMsg['t'];

// ------------------------------------------------------------------------------------------------ server -> client
export type RoomState = 'lobby' | 'race' | 'results' | 'closed';

export interface PublicParticipant {
  id: string; name: string; slot: number; num: number; bay: number;
  livery: LiveryId; color: number;
  /** the livery asked for when it differs from the one given (it was taken): shown, so nobody is silently recoloured */
  liveryRequested: LiveryId | null;
  ready: boolean; connected: boolean; host: boolean; guest: boolean; joinOrder: number;
  /** left the room or retired from the race; the seat stays out of reach until the race ends */
  left: boolean;
}
export interface PublicAi { id: string; name: string; slot: number; num: number; bay: number; livery: LiveryId; color: number; ai: true; }
export interface PublicRoom {
  id: string; code: string; mode: Mode; state: RoomState; rev: number;
  hostId: string | null; settings: RoomSettings; championship: ChampionshipTag | null;
  participants: PublicParticipant[];
  /** AI cars that will start (lobby, with aiFill) or that are racing */
  ai: PublicAi[];
  raceId: string | null; maxHumans: number; minHumans: number;
  /** a reconnect grace in seconds, so clients can show how long a dropped seat is held */
  graceS: number;
}

export type ErrorCode =
  | 'malformed' | 'too_large' | 'protocol' | 'hello_required' | 'rate' | 'not_found' | 'full' | 'started' | 'not_in_room'
  | 'already_in_room' | 'forbidden' | 'stale' | 'duplicate' | 'out_of_order' | 'bad_state' | 'bad_settings' | 'not_ready'
  | 'unavailable' | 'superseded' | 'expired' | 'overloaded' | 'origin' | 'already_joined';

export type ServerMsg =
  | { t: 'welcome'; v: number; server: string; rules: string; now: number }
  | { t: 'joined'; room: PublicRoom; you: string; token: string; ctlSeq: number; actSeq: number; resumed: boolean }
  | { t: 'room'; room: PublicRoom }
  /**
   * On the wire (v2), `snap` is a WireSnap with `key`/`base`/`static` as in StateFrame (src/net/snapwire.ts). OnlineClient
   * decodes it before anyone sees it: what it delivers has `snap` as the full RaceSnapshot and none of the three.
   */
  | ({ t: 'state'; tick: number; now: number; lagMs: number; snap: unknown; ev: unknown[] } & Partial<Omit<StateFrame, 'snap'>>)
  | { t: 'ack'; seq: number; result: 'queued' }
  | { t: 'nack'; ref: ClientMsgType | 'unknown'; seq?: number; code: ErrorCode; detail?: string }
  | { t: 'result'; envelope: unknown }
  | { t: 'awards'; awards: AwardsView }
  | { t: 'pong'; id: number; now: number }
  | { t: 'bye'; code: ErrorCode | 'left' | 'closed' | 'shutdown'; detail?: string };

// ------------------------------------------------------------------------------------------------ career (docs/career.md)
/**
 * One classified row of a finalized race, as scored by the server. `credit`: a signed-in driver whose account receives the
 * points; AI and guest rows keep their position with `credit: false`. Account ids are never sent to the room.
 */
export interface AwardRow { participant: string; pos: number | null; status: 'finished' | 'dq' | 'dnf'; credit: boolean; points: number; }
/**
 * Where a race's account updates stand: `saving` (being written), `saved` (stored with its award ledger), `pending` (storage
 * failed; the result is written to disk on the server and retried, never counted twice), `unsaved` (storage failed and no
 * durable copy could be written either: retried from memory, lost if the server restarts first; becomes `pending` once the
 * spool takes it), `failed` (refused: a conflicting result for the same race exists; nothing was awarded from this one).
 */
export type AwardSync = 'saving' | 'saved' | 'pending' | 'unsaved' | 'failed';
export interface AwardsView {
  raceId: string; scoring: string;
  /** false for practice ('practice') and for aborted or unclassified races ('incomplete'): no points for anyone */
  eligible: boolean; reason: 'practice' | 'incomplete' | null;
  sync: AwardSync;
  rows: AwardRow[];
}

/** GET /api/profile/stats: the signed-in account's own career. Every number is computed by the server from its ledger. */
export interface CareerStats {
  displayName: string;
  scoring: { version: string; podium: number[] };
  career: { points: number; races: number; wins: number; seconds: number; thirds: number; dq: number; dnf: number };
  bests: { track: string; trackVersion: string; current: boolean; mode: Mode; rules: string; lapMs: number; lap: number; livery: string; raceId: string; setAt: string }[];
  recent: { raceId: string; mode: Mode; championship: ChampionshipTag | null; track: string; pos: number | null; status: 'finished' | 'dq' | 'dnf'; points: number; field: number; humans: number; scoring: string; rules: string; finishedAt: string }[];
}

// ------------------------------------------------------------------------------------------------ validation
export type Parsed = { ok: true; msg: ClientMsg } | { ok: false; code: 'malformed' | 'too_large'; ref: ClientMsgType | 'unknown' };

const SHAPES: Record<ClientMsgType, Record<string, 'string' | 'number' | 'boolean' | 'object' | '?string' | '?object'>> = {
  hello: { v: 'number', proto: 'string' },
  create: { name: 'string', livery: '?string', mode: 'string', settings: 'object', championship: '?object', expectAccount: '?string' },
  join: { code: 'string', name: 'string', livery: '?string', expectAccount: '?string' },
  resume: { room: 'string', participant: 'string', token: 'string' },
  ready: { ready: 'boolean' },
  settings: { settings: 'object' },
  livery: { livery: 'string' },
  start: {}, rematch: {}, leave: {},
  ctl: { seq: 'number', up: 'boolean', down: 'boolean', driver: '?string' },
  act: { seq: 'number', type: 'string', driver: '?string' },
  ping: { id: 'number' },
};

const utf8Len = (s: string): number => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse one client message. Rejects anything that is not a JSON object of a known type with exactly the known fields of the
 * right types (unknown fields are malformed too), any string over 64 characters, and anything over maxMessageBytes.
 * Semantic checks (sequence order, ownership, room state) are the server's.
 */
export function parseClientMessage(raw: unknown): Parsed {
  if (typeof raw !== 'string') return { ok: false, code: 'malformed', ref: 'unknown' };
  if (raw.length > LIMITS.maxMessageBytes || utf8Len(raw) > LIMITS.maxMessageBytes) return { ok: false, code: 'too_large', ref: 'unknown' };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ok: false, code: 'malformed', ref: 'unknown' }; }
  if (!isObj(v) || typeof v.t !== 'string' || !Object.prototype.hasOwnProperty.call(SHAPES, v.t)) return { ok: false, code: 'malformed', ref: 'unknown' };
  const t = v.t as ClientMsgType;
  const shape = SHAPES[t];
  const bad: Parsed = { ok: false, code: 'malformed', ref: t };
  for (const k of Object.keys(v)) if (k !== 't' && !Object.prototype.hasOwnProperty.call(shape, k)) return bad;
  for (const [k, want] of Object.entries(shape)) {
    const x = v[k];
    const opt = want.startsWith('?');
    if (x === undefined) { if (opt) continue; return bad; }
    const type = opt ? want.slice(1) : want;
    if (type === 'object' ? !isObj(x) : typeof x !== type) return bad;
    if (typeof x === 'string' && x.length > 64) return bad;
    if (typeof x === 'number' && !Number.isFinite(x)) return bad;
  }
  if ((t === 'ctl' || t === 'act') && (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1)) return bad;
  if (t === 'act' && v.type !== 'lane' && v.type !== 'pit' && v.type !== 'defer') return bad;
  if (t === 'ping' && !Number.isSafeInteger(v.id)) return bad;
  if (t === 'create') {
    if (!MODES.includes(v.mode as Mode)) return bad;
    const s = v.settings as Record<string, unknown>;
    for (const k of Object.keys(s)) if (k !== 'track' && k !== 'aiFill') return bad;
    if (s.track !== undefined && typeof s.track !== 'string') return bad;
    if (s.aiFill !== undefined && typeof s.aiFill !== 'boolean') return bad;
    if (v.championship !== undefined) {
      const c = v.championship as Record<string, unknown>;
      if (Object.keys(c).some((k) => k !== 'id' && k !== 'round') || typeof c.id !== 'string' || c.id.length > 64 || !Number.isSafeInteger(c.round) || (c.round as number) < 1 || (c.round as number) > 99) return bad;
    }
  }
  if (t === 'settings') {
    const s = v.settings as Record<string, unknown>;
    for (const k of Object.keys(s)) if (k !== 'track' && k !== 'aiFill') return bad;
    if (s.track !== undefined && typeof s.track !== 'string') return bad;
    if (s.aiFill !== undefined && typeof s.aiFill !== 'boolean') return bad;
  }
  if ((t === 'create' || t === 'join' || t === 'livery') && v.livery !== undefined && !isLivery(v.livery)) return bad;
  return { ok: true, msg: v as ClientMsg };
}

/**
 * The character clean-up shared by guest names (cleanName) and account driver names (checkDisplayName): Unicode NFC;
 * control, zero-width, word-joiner/invisible-operator (U+2060-2065), bidirectional and BOM (U+FEFF) characters removed;
 * runs of whitespace collapsed to one space; trimmed. No length rule: each caller applies its own.
 */
export function tidyName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/** A name ending in "(AI)" (any case, any spaces) poses as an AI car; only the server's AI fill may carry it. */
const AI_SUFFIX = /\(\s*ai\s*\)$/i;
export const isReservedName = (tidy: string): boolean => AI_SUFFIX.test(tidy);

/**
 * A guest's name as shown to others: tidied as tidyName, cut to LIMITS.nameMax (16) code points, and any "(AI)" suffix
 * removed (repeatedly, so "X (AI) (AI)" and a cut that lands on "(AI)" are covered) so a guest never shows as an AI car.
 * The rest of the name is kept rather than replaced, the least surprising outcome. null when nothing is left (blank,
 * invisible-only or "(AI)" alone): callers refuse that exactly as a blank name. Never an identity.
 */
export function cleanName(raw: string): string | null {
  let s = [...tidyName(raw)].slice(0, LIMITS.nameMax).join('').trim();
  while (isReservedName(s)) s = s.replace(AI_SUFFIX, '').trim();
  return s || null;
}

export type DisplayNameCheck = { ok: true; name: string } | { ok: false; error: 'blank' | 'too_long' | 'reserved' | 'type' };

/**
 * A signed-in driver's saved display name (the profile), checked the same way in the browser and on the server. It is
 * public race information and never an identity (the account ID is). Rules (docs/accounts.md): tidyName (shared with guest
 * names: NFC; control, zero-width, invisible, BOM and bidirectional characters removed; whitespace collapsed; trimmed), then 1 to
 * LIMITS.nameMax (16) characters, counted as code points. Unlike cleanName, an over-long name is refused, not cut.
 * Names that pose as the AI field ("... (AI)") are refused. Any other text, including HTML-like text, is allowed and is
 * always rendered as text.
 */
export function checkDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string' || raw.length > 256) return { ok: false, error: 'type' };
  const s = tidyName(raw);
  const n = [...s].length;
  if (!n) return { ok: false, error: 'blank' };
  if (n > LIMITS.nameMax) return { ok: false, error: 'too_long' };
  if (isReservedName(s)) return { ok: false, error: 'reserved' };
  return { ok: true, name: s };
}

export const neutral = (): Input => ({ up: false, down: false });
