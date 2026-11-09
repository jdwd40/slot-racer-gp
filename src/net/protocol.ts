// Online room protocol, shared by the room server (server/) and any client (browser or headless). Plain data only: no
// secrets, no Node or DOM APIs, so the browser bundle can import it. See docs/online-server.md for the message reference.
import type { ActionType, Input } from '../race';

/** Wire protocol version. Bump on any incompatible message change; a client and server must agree exactly. */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_NAME = 'slotrush';
/**
 * Race rules version recorded in every result envelope. Bump whenever a change to the simulation (physics, timing, service,
 * penalties, classification) could change a result, so stored results from different rules are never compared as equal.
 */
export const RULES_VERSION = 'race-core-2026.11.1';

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
  | { t: 'state'; tick: number; now: number; lagMs: number; snap: unknown; ev: unknown[] }
  | { t: 'ack'; seq: number; result: 'queued' }
  | { t: 'nack'; ref: ClientMsgType | 'unknown'; seq?: number; code: ErrorCode; detail?: string }
  | { t: 'result'; envelope: unknown }
  | { t: 'pong'; id: number; now: number }
  | { t: 'bye'; code: ErrorCode | 'left' | 'closed' | 'shutdown'; detail?: string };

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

/** A display name as shown to others: control characters stripped, whitespace collapsed, 1-16 characters. Never an identity. */
export function cleanName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  if (!chars.length) return null;
  return chars.slice(0, LIMITS.nameMax).join('');
}

export type DisplayNameCheck = { ok: true; name: string } | { ok: false; error: 'blank' | 'too_long' | 'reserved' | 'type' };

/**
 * A signed-in driver's saved display name (the profile), checked the same way in the browser and on the server. It is
 * public race information and never an identity (the account ID is). Rules (docs/accounts.md): Unicode NFC; control, zero-
 * width and bidirectional-override characters removed; runs of whitespace collapsed to one space; trimmed; then 1 to
 * LIMITS.nameMax (16) characters, counted as code points. Unlike cleanName, an over-long name is refused, not cut.
 * Names that pose as the AI field ("... (AI)") are refused. Any other text, including HTML-like text, is allowed and is
 * always rendered as text.
 */
export function checkDisplayName(raw: unknown): DisplayNameCheck {
  if (typeof raw !== 'string' || raw.length > 256) return { ok: false, error: 'type' };
  // eslint-disable-next-line no-control-regex
  const s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const n = [...s].length;
  if (!n) return { ok: false, error: 'blank' };
  if (n > LIMITS.nameMax) return { ok: false, error: 'too_long' };
  if (/\(\s*ai\s*\)\s*$/i.test(s)) return { ok: false, error: 'reserved' };
  return { ok: true, name: s };
}

export const neutral = (): Input => ({ up: false, down: false });
