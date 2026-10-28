// Persistence for initials, car choice, lap-time leaderboards, personal-best
// ghosts and championship progress. Everything lives in localStorage under the
// `srgp.` prefix and degrades silently when storage is unavailable.
import * as T from './track';

export const ANON = 'Annon';
export const MAX_INITIALS = 3;

export interface Livery { id: string; name: string; color: number; }
/** player liveries: identical handling, different paint */
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

// ---------------------------------------------------------------- leaderboards
export type BoardKind = 'practice' | 'race';
export interface LapRecord { id: string; initials: string; car: string; ms: number; at: number; }
const BOARD_SIZE = 10;
const boardKey = (kind: BoardKind, track: string): string => `srgp.lb.${kind}.${track}`;

export function board(kind: BoardKind, track: string): LapRecord[] {
  const rows = get<LapRecord[]>(boardKey(kind, track), []);
  return rows.filter((r) => r && typeof r.ms === 'number' && r.ms > 0).sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
}
/** Insert a valid lap; returns the record if it made the top ten, else null. */
export function submitLap(kind: BoardKind, track: string, initials: string, car: string, ms: number): LapRecord | null {
  const rec: LapRecord = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, initials, car, ms: Math.round(ms), at: Date.now() };
  const rows = [...board(kind, track), rec].sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
  set(boardKey(kind, track), rows);
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
}
const ghostKey = (track: string, car: string, initials: string): string => `srgp.ghost.${track}.${car}.${encodeURIComponent(initials)}`;

export function loadGhost(track: string, car: string, initials: string): GhostData | null {
  const g = get<GhostData | null>(ghostKey(track, car, initials), null);
  if (!g || g.v !== GHOST_VERSION || g.track !== track || g.car !== car || !Array.isArray(g.s) || g.s.length < 8) return null;
  // reject recordings made on a different build of the same circuit
  if (Math.abs(g.L - T.L) > 0.05) return null;
  return g;
}
export function saveGhost(g: GhostData): void { set(ghostKey(g.track, g.car, g.initials), g); }
export function clearGhost(track: string, car: string, initials: string): void { del(ghostKey(track, car, initials)); }

// ---------------------------------------------------------------- championship
export const CHAMP_TRACKS = ['circuit-1', 'circuit-2', 'circuit-4', 'circuit-5'];
export const CHAMP_POINTS = [10, 6, 4, 2];
export interface RoundResult { track: string; /** finishing order: driver indices (0 = player), DNFs flagged */ order: { idx: number; dnf: boolean; time: number }[]; }
export interface Championship { v: number; car: string; initials: string; rounds: RoundResult[]; startedAt: number; }
const CHAMP_KEY = 'srgp.champ';

export function loadChamp(): Championship | null {
  const c = get<Championship | null>(CHAMP_KEY, null);
  if (!c || c.v !== 1 || !Array.isArray(c.rounds)) return null;
  return c;
}
export function newChamp(car: string, initials: string): Championship {
  const c: Championship = { v: 1, car, initials, rounds: [], startedAt: Date.now() };
  set(CHAMP_KEY, c);
  return c;
}
export function saveChamp(c: Championship): void { set(CHAMP_KEY, c); }
export function clearChamp(): void { del(CHAMP_KEY); }
export function champDone(c: Championship): boolean { return c.rounds.length >= CHAMP_TRACKS.length; }

export interface Standing { idx: number; points: number; wins: number; seconds: number; lastPos: number; }
/** Cumulative standings with tie-breaks: points, wins, second places, final-round position. */
export function standings(c: Championship, drivers: number): Standing[] {
  const st: Standing[] = [];
  for (let i = 0; i < drivers; i++) st.push({ idx: i, points: 0, wins: 0, seconds: 0, lastPos: 99 });
  c.rounds.forEach((r, ri) => {
    r.order.forEach((o, pos) => {
      const s = st[o.idx]; if (!s) return;
      if (!o.dnf) { s.points += CHAMP_POINTS[pos] ?? 0; if (pos === 0) s.wins++; if (pos === 1) s.seconds++; }
      if (ri === c.rounds.length - 1) s.lastPos = o.dnf ? 99 : pos + 1;
    });
  });
  return st.sort((a, b) => b.points - a.points || b.wins - a.wins || b.seconds - a.seconds || a.lastPos - b.lastPos);
}
