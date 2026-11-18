// Persistence for initials, car choice, lap-time leaderboards, personal-best
// ghosts and championship progress. Everything lives in localStorage under the
// `srgp.` prefix and degrades silently when storage is unavailable.
import * as T from './track';
import { DEFAULT_LENGTH, isRaceLengthId, lengthOr, type RaceLengthId } from './raceLength';
import { DEFAULT_SETUP, currentTag, isSetupId, recordTag, sameTag, setupOr, type SetupId, type SetupTag } from './carSetup';

export const ANON = 'Annon';
export const MAX_INITIALS = 3;

export interface Livery { id: string; name: string; color: number; }
/** player liveries: identical handling, different paint (handling is the car setup's, src/carSetup.ts, chosen separately) */
export const LIVERIES: Livery[] = [
  { id: 'sunburst', name: 'Sunburst', color: 0xffcc1a },
  { id: 'blaze', name: 'Blaze', color: 0xff6a1a },
  { id: 'frost', name: 'Frost', color: 0xf4f4f4 },
  { id: 'violet', name: 'Violet', color: 0x9b5de5 },
];
export function livery(id: string): Livery { return LIVERIES.find((l) => l.id === id) ?? LIVERIES[0]; }

function get<Tv>(key: string, fallback: Tv): Tv {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as Tv); } catch { return fallback; }
}
function set(key: string, v: unknown): void { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }
function del(key: string): void { try { localStorage.removeItem(key); } catch { /* ignore */ } }

// ---------------------------------------------------------------- initials / car
/** Trim and uppercase initials; blank input becomes the anonymous name. */
export function normaliseInitials(raw: string): string {
  const t = raw.trim().toUpperCase().slice(0, MAX_INITIALS);
  return t.length ? t : ANON;
}
export function savedInitialsRaw(): string { return get<string>('srgp.initials', ''); }
export function saveInitialsRaw(raw: string): void { set('srgp.initials', raw.trim().slice(0, MAX_INITIALS)); }
export function currentInitials(): string { return normaliseInitials(savedInitialsRaw()); }
export function savedCar(): string { return livery(get<string>('srgp.car', LIVERIES[0].id)).id; }
export function saveCar(id: string): void { set('srgp.car', id); }

// ---------------------------------------------------------------- record compatibility (#133)
/**
 * Where a record of a setup tag is stored. Balanced at tuning 0 is the handling every lap had before setups, so it keeps the
 * keys records always had: every board row and ghost saved before setups (which names no setup) is a Balanced tuning-0 record
 * and stays current for Balanced, because Balanced's physics did not change. Any other setup, or any setup at another tuning,
 * has keys of its own (`~speed.1`), so a lap driven under one set of physics never competes with, overwrites or loads as a
 * record of another. A retune raises the preset's tuning: its older records stay readable under their own key, never current.
 */
const tagSuffix = (t: SetupTag): string => (t.setup === DEFAULT_SETUP && t.tuning === 0 ? '' : `~${t.setup}.${t.tuning}`);

// ---------------------------------------------------------------- leaderboards
export type BoardKind = 'practice' | 'race';
/** `setup` / `tuning` (#133): what the lap was driven with. A row saved before setups has neither: Balanced at tuning 0. */
export interface LapRecord { id: string; initials: string; car: string; ms: number; at: number; setup?: SetupId; tuning?: number; }
const BOARD_SIZE = 10;
const boardKey = (kind: BoardKind, track: string, tag: SetupTag): string => `srgp.lb.${kind}.${track}${tagSuffix(tag)}`;

/**
 * The ten fastest laps of one setup (at its current tuning unless `tag` names another) on a circuit. A board holds one setup's
 * laps only: a row that names another setup or tuning than its board's (never written by this code) is left out, not shown.
 */
export function board(kind: BoardKind, track: string, setup: SetupId | SetupTag = DEFAULT_SETUP): LapRecord[] {
  const tag = typeof setup === 'string' ? currentTag(setup) : setup;
  const rows = get<LapRecord[]>(boardKey(kind, track, tag), []);
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => {
    if (!r || typeof r.ms !== 'number' || !(r.ms > 0)) return false;
    const rt = recordTag(r.setup, r.tuning);
    return !!rt && sameTag(rt, tag);
  }).sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
}
/** Insert a valid lap driven with `setup` (at its current tuning); returns the record if it made that setup's top ten, else null. */
export function submitLap(kind: BoardKind, track: string, initials: string, car: string, ms: number, setup: SetupId = DEFAULT_SETUP): LapRecord | null {
  const tag = currentTag(setupOr(setup));
  const rec: LapRecord = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, initials, car, ms: Math.round(ms), at: Date.now(), setup: tag.setup, tuning: tag.tuning };
  const rows = [...board(kind, track, tag), rec].sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
  set(boardKey(kind, track, tag), rows);
  return rows.includes(rec) ? rec : null;
}
export function fmtMs(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '–:––.–––';
  const m = Math.floor(ms / 60000), s = (ms - m * 60000) / 1000;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

// ---------------------------------------------------------------- ghosts
export const GHOST_VERSION = 1;
export const GHOST_HZ = 20;
export interface GhostData {
  v: number; track: string; car: string; initials: string; L: number; ms: number;
  /** flat samples: t, u (distance from the timing line), d (lateral), yaw offset */
  s: number[];
  /** #133: the setup and tuning the lap was driven with; a ghost saved before setups has neither (Balanced at tuning 0) */
  setup?: SetupId; tuning?: number;
}
const ghostKey = (track: string, car: string, initials: string, tag: SetupTag): string => `srgp.ghost.${track}.${car}${tagSuffix(tag)}.${encodeURIComponent(initials)}`;

/**
 * The personal-best ghost to challenge with `setup` (#133): only a lap driven with that setup at its current tuning. A ghost
 * of another setup or tuning is never loaded (it was driven under other physics), whatever its key.
 */
export function loadGhost(track: string, car: string, initials: string, setup: SetupId = DEFAULT_SETUP): GhostData | null {
  const want = currentTag(setupOr(setup));
  const g = get<GhostData | null>(ghostKey(track, car, initials, want), null);
  if (!g || g.v !== GHOST_VERSION || g.track !== track || g.car !== car || !Array.isArray(g.s) || g.s.length < 8) return null;
  const tag = recordTag(g.setup, g.tuning);
  if (!tag || !sameTag(tag, want)) return null;
  // reject recordings made on a different build of the same circuit
  if (Math.abs(g.L - T.L) > 0.05) return null;
  return g;
}
/** Save a ghost under its own setup and tuning (a ghost naming none is Balanced at tuning 0). */
export function saveGhost(g: GhostData): void {
  const tag = recordTag(g.setup, g.tuning);
  if (tag) set(ghostKey(g.track, g.car, g.initials, tag), g);
}
export function clearGhost(track: string, car: string, initials: string, setup: SetupId = DEFAULT_SETUP): void { del(ghostKey(track, car, initials, currentTag(setupOr(setup)))); }

// ---------------------------------------------------------------- championship
export const CHAMP_TRACKS = ['circuit-1', 'circuit-2', 'circuit-4', 'circuit-5'];
export const CHAMP_POINTS = [10, 6, 4, 2];
/**
 * Finishing order: driver indices (0 = player). Classified finishers come first; DNF and DQ entries score nothing.
 * `dq` was added later: saves from before it simply have no disqualifications, so they load and score exactly as they did.
 */
export interface RoundResult {
  track: string; order: { idx: number; dnf: boolean; dq?: boolean; time: number }[];
  /** #133: the player's setup in this round (rounds saved before setups have none: Balanced) */
  setup?: SetupId;
}
/**
 * `length` (#132): the race-length preset every round of this championship runs, chosen when it starts and kept through
 * resume. Saves from before presets have none and load as Standard, the length they were raced at (loadChamp fills it in).
 */
export interface Championship {
  v: number; car: string; initials: string; rounds: RoundResult[]; startedAt: number; length: RaceLengthId;
  /**
   * #133: the setup the player races the next round with. Chosen when the championship starts and changeable between rounds
   * (never during one); saves from before setups have none and load as Balanced.
   */
  setup: SetupId;
}
const CHAMP_KEY = 'srgp.champ';

export function loadChamp(): Championship | null {
  const c = get<Championship | null>(CHAMP_KEY, null);
  if (!c || c.v !== 1 || !Array.isArray(c.rounds)) return null;
  return { ...c, length: lengthOr(c.length), setup: setupOr(c.setup) };
}
export function newChamp(car: string, initials: string, length: RaceLengthId = DEFAULT_LENGTH, setup: SetupId = DEFAULT_SETUP): Championship {
  const c: Championship = { v: 1, car, initials, rounds: [], startedAt: Date.now(), length: isRaceLengthId(length) ? length : DEFAULT_LENGTH, setup: isSetupId(setup) ? setup : DEFAULT_SETUP };
  set(CHAMP_KEY, c);
  return c;
}
export function saveChamp(c: Championship): void { set(CHAMP_KEY, c); }
export function clearChamp(): void { del(CHAMP_KEY); }
export function champDone(c: Championship): boolean { return c.rounds.length >= CHAMP_TRACKS.length; }

/**
 * A round's record from the race result rows. Only classified finishers keep a time and a scoring place; a DQ is stored
 * as a DQ, and anything else not classified as a DNF. No estimated time ever reaches a record.
 */
export function roundRecord(track: string, rows: { car: { idx: number }; status: 'running' | 'finished' | 'dq' | 'dnf'; time: number }[], setup?: SetupId): RoundResult {
  const fin = rows.filter((r) => r.status === 'finished');
  const rest = rows.filter((r) => r.status !== 'finished').sort((a, b) => (a.status === 'dq' ? 1 : 0) - (b.status === 'dq' ? 1 : 0));
  return {
    track,
    ...(setup ? { setup } : {}),
    order: [
      ...fin.map((r) => ({ idx: r.car.idx, dnf: false, time: Math.round(r.time * 10) / 10 })),
      ...rest.map((r) => (r.status === 'dq' ? { idx: r.car.idx, dnf: false, dq: true, time: 0 } : { idx: r.car.idx, dnf: true, time: 0 })),
    ],
  };
}

/** Points for the entry at position `pos` of a round: nothing for a DNF or DQ. */
export function roundPoints(r: RoundResult, pos: number): number {
  const o = r.order[pos];
  return !o || o.dnf || o.dq ? 0 : CHAMP_POINTS[pos] ?? 0;
}

export interface Standing { idx: number; points: number; wins: number; seconds: number; lastPos: number; }
/** Cumulative standings with tie-breaks: points, wins, second places, final-round position. */
export function standings(c: Championship, drivers: number): Standing[] {
  const st: Standing[] = [];
  for (let i = 0; i < drivers; i++) st.push({ idx: i, points: 0, wins: 0, seconds: 0, lastPos: 99 });
  c.rounds.forEach((r, ri) => {
    r.order.forEach((o, pos) => {
      const s = st[o.idx]; if (!s) return;
      if (!o.dnf && !o.dq) { s.points += roundPoints(r, pos); if (pos === 0) s.wins++; if (pos === 1) s.seconds++; }
      if (ri === c.rounds.length - 1) s.lastPos = o.dnf || o.dq ? 99 : pos + 1;
    });
  });
  return st.sort((a, b) => b.points - a.points || b.wins - a.wins || b.seconds - a.seconds || a.lastPos - b.lastPos);
}

// ---------------------------------------------------------------- race length (#132)
const LENGTH_KEY = 'srgp.raceLength';
/** The race length last chosen on this device (local and online setup share it); Standard when none or unreadable. */
export function savedLength(): RaceLengthId { return lengthOr(get<unknown>(LENGTH_KEY, DEFAULT_LENGTH)); }
export function saveLength(id: RaceLengthId): void { if (isRaceLengthId(id)) set(LENGTH_KEY, id); }

// ---------------------------------------------------------------- car setup (#133)
const SETUP_KEY = 'srgp.setup';
/** The car setup last chosen on this device (local and online share it); Balanced when none or unreadable (old saves, new drivers). */
export function savedSetup(): SetupId { return setupOr(get<unknown>(SETUP_KEY, DEFAULT_SETUP)); }
export function saveSetup(id: SetupId): void { if (isSetupId(id)) set(SETUP_KEY, id); }
