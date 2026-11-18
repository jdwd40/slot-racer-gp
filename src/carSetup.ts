// Car setup presets (#133): the one allowlist of handling choices, shared by the race core, the browser and the room server.
// A car's physical limits are resolved from its own preset when the Race is built (Car.setup, frozen): there is no mutable
// global a car or a room could change for another, and a client only ever names a preset id, never a number. Balanced is
// the handling every car had before setups existed (exactly the old ACC/VMAX/DRAG/GRIP/AI_GRIP values), so anything that
// names no setup (an older client, an older save, stored result or ghost) is Balanced. Plain data only: every bundle imports
// it. Tuning a preset's numbers is a deliberate change that raises that preset's `tuning` (records compare only within one
// setup and tuning: src/records.ts, server/results.ts). Adding a preset also raises SETUP_SET. docs/car-setup.md.

export type SetupId = 'balanced' | 'speed' | 'grip';

export interface CarSetup {
  readonly id: SetupId;
  /**
   * The tuning revision of this preset's numbers. Records (local boards and ghosts, server personal bests) are kept per setup
   * and tuning, so a retune never lets a lap driven under other physics stand as a current record. Balanced is 0: the
   * handling every race had before setups, so legacy records (no setup named) are Balanced at tuning 0 and stay current.
   */
  readonly tuning: number;
  /**
   * The preset-list version that introduced it (like RaceLength.since). A client tells the room server which list it knows
   * (`setups` on create and join); a seat whose page knows only list 0 (Balanced alone: a page older than setups) is never
   * put in a race with a setup it could not show.
   */
  readonly since: number;
  /** drive (m/s² at a standstill, falling linearly to 0 at `vmax`) */
  readonly acc: number;
  /** the drive's speed asymptote (m/s). The attainable straight-line speed is where drive meets `drag` (below this) */
  readonly vmax: number;
  /** aerodynamic drag coefficient (m/s² per (m/s)²) */
  readonly drag: number;
  /** lateral grip of the slot: a car de-slots once v² × curvature exceeds this (× the banking bonus) for long enough */
  readonly grip: number;
  /** cornering grip the AI (and the automatic pit controller's corner limit) plans with: the same margin below `grip` for every setup */
  readonly aiGrip: number;
}

/**
 * The presets. Braking, coasting, fuel, pit limits, reverse caps, recovery and every penalty are the same for all of them:
 * only drive, top speed and grip differ. The numbers are modest and were tuned on measured laps and races (docs/car-setup.md):
 * - Speed: 19% less drive from a standstill, weaker than Balanced at every speed below about 19.25 m/s (off the line, out of
 *   the pits and out of the slower corners), in exchange for a higher drive asymptote and less drag: about 1.1 m/s (4.7%) more
 *   attainable straight-line speed (24.3 against 23.2 m/s). The same grip as Balanced.
 * - Grip: 7.7% more grip, so about 3.8% more cornering speed before a de-slot (the AI plans its corners with the same extra),
 *   but a lower drive asymptote: about 2.0 m/s (8.6%) less attainable straight-line speed (21.2 m/s).
 * Every AI's planned cornering keeps Balanced's margin under the real limit (aiGrip / grip = 36 / 52).
 */
export const CAR_SETUPS: readonly CarSetup[] = Object.freeze([
  Object.freeze({ id: 'balanced', tuning: 0, since: 0, acc: 30, vmax: 26, drag: 0.006, grip: 52, aiGrip: 36 }),
  Object.freeze({ id: 'speed', tuning: 1, since: 1, acc: 24.35, vmax: 27.81, drag: 0.0052, grip: 52, aiGrip: 36 }),
  Object.freeze({ id: 'grip', tuning: 1, since: 1, acc: 30, vmax: 23.3, drag: 0.006, grip: 56, aiGrip: 38.769 }),
] as const satisfies readonly CarSetup[]);

export const DEFAULT_SETUP: SetupId = 'balanced';
/** The newest preset list (the highest `since`). A client that knows this list sends it as `setups` on create and join. */
export const SETUP_SET = Math.max(...CAR_SETUPS.map((s) => s.since));
export const SETUP_IDS: readonly SetupId[] = Object.freeze(CAR_SETUPS.map((s) => s.id));

export const isSetupId = (x: unknown): x is SetupId => typeof x === 'string' && CAR_SETUPS.some((s) => s.id === x);

/** The preset of an id; throws on anything that is not one (a car is never built from an unknown setup). */
export function carSetup(id: SetupId = DEFAULT_SETUP): CarSetup {
  const s = CAR_SETUPS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown car setup ${String(id)}`);
  return s;
}

/** A stored or received setup read leniently: anything missing or unknown (an older save, result, ghost or room) is Balanced. */
export const setupOr = (x: unknown): SetupId => (isSetupId(x) ? x : DEFAULT_SETUP);

/** Whether a client that knows preset list `set` (0: an older client, Balanced only) can show a car with this setup. */
export const knowsSetup = (set: number, id: SetupId): boolean => carSetup(id).since <= set;

/**
 * The record-compatibility key of a setup at a tuning: personal bests, boards and ghosts compare only under the same key.
 * A record that names no setup is legacy Balanced at tuning 0; one that names no tuning is tuning 0 (the only tuning any
 * setup had when records began naming it).
 */
export interface SetupTag { setup: SetupId; tuning: number; }
export function recordTag(setup: unknown, tuning: unknown): SetupTag | null {
  if (setup !== undefined && !isSetupId(setup)) return null;
  const t = tuning === undefined ? 0 : tuning;
  if (!Number.isSafeInteger(t) || (t as number) < 0) return null;
  return { setup: setupOr(setup), tuning: t as number };
}
/** The current tag of a setup (its own tuning now). */
export const currentTag = (id: SetupId): SetupTag => ({ setup: id, tuning: carSetup(id).tuning });
/** A record's tag is the one in force now for its setup: it is a current record, comparable with laps driven today. */
export const isCurrentTag = (t: SetupTag): boolean => isSetupId(t.setup) && carSetup(t.setup).tuning === t.tuning;
export const sameTag = (a: SetupTag, b: SetupTag): boolean => a.setup === b.setup && a.tuning === b.tuning;
