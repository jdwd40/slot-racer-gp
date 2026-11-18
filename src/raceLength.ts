// Race-length presets (#132): the one allowlist of race lengths, shared by the race core, the browser and the room server.
// A race's lap target is fixed when the Race is built, from one of these presets: there is no process-wide lap count and no
// arbitrary count can be asked for. Standard is the length every race had before presets existed, so anything that names
// no preset (an older client, an older save or stored result) is Standard. Tuning a value here is a deliberate rules
// change; adding a preset also raises LENGTH_SET (see below). Plain data only: every bundle imports it. docs/race-length.md.

export type RaceLengthId = 'sprint' | 'standard' | 'endurance';

export interface RaceLength {
  readonly id: RaceLengthId;
  /** laps to the chequered flag */
  readonly laps: number;
  /**
   * The preset-list version that introduced it. A client tells the room server which list it knows (`lengths` on create and
   * join); the server never puts that client in a race with a preset from a later list, which its page could not show.
   * 0 is the list every client has always known: Standard alone.
   */
  readonly since: number;
  /**
   * Bounded end of a race with more than one human (local default and the room server's multiplayer rooms): seconds after
   * the first car takes the flag before every car still running is classified DNF.
   */
  readonly finishWindowS: number;
  /** the room server's finish window for a race with one human (connected solo and championship rounds) */
  readonly soloFinishWindowS: number;
  /** race-time cap (seconds of racing) of a race with more than one human and of every room-server race */
  readonly timeLimitS: number;
  /** simulated seconds the browser runs the AI field on for once every human is done (Race.runOut) */
  readonly runOutS: number;
}

/**
 * The presets. Fuel capacity, burn, refill rate and the pit rules are the same for every length: only the lap target and
 * the bounded-end limits differ. Standard's limits are the values every race used before presets (90/120/1200/240 s), so a
 * Standard race is the race it always was. Endurance is twice Standard's distance, so its limits are twice Standard's:
 * seeded Endurance races on the five circuits took 385-537 s of race time, and slow scripted humans finished 79-124 s
 * behind the leader, where Standard's 90 s window would have cut them off (measurements: docs/race-length.md). Sprint keeps
 * Standard's limits rather than shortening them, so no driver is ever cut off sooner than before.
 */
export const RACE_LENGTHS: readonly RaceLength[] = Object.freeze([
  Object.freeze({ id: 'sprint', laps: 5, since: 1, finishWindowS: 90, soloFinishWindowS: 120, timeLimitS: 1200, runOutS: 240 }),
  Object.freeze({ id: 'standard', laps: 13, since: 0, finishWindowS: 90, soloFinishWindowS: 120, timeLimitS: 1200, runOutS: 240 }),
  Object.freeze({ id: 'endurance', laps: 26, since: 1, finishWindowS: 180, soloFinishWindowS: 240, timeLimitS: 2400, runOutS: 480 }),
] as const satisfies readonly RaceLength[]);

export const DEFAULT_LENGTH: RaceLengthId = 'standard';
/** The newest preset list (the highest `since`). A client that knows this list sends it as `lengths` on create and join. */
export const LENGTH_SET = Math.max(...RACE_LENGTHS.map((l) => l.since));
export const LENGTH_IDS: readonly RaceLengthId[] = Object.freeze(RACE_LENGTHS.map((l) => l.id));

export const isRaceLengthId = (x: unknown): x is RaceLengthId => typeof x === 'string' && RACE_LENGTHS.some((l) => l.id === x);

/** The preset of an id; throws on anything that is not one (a race is never built from an unknown length). */
export function raceLength(id: RaceLengthId = DEFAULT_LENGTH): RaceLength {
  const l = RACE_LENGTHS.find((x) => x.id === id);
  if (!l) throw new Error(`unknown race length ${String(id)}`);
  return l;
}

/** A stored or received length read leniently: anything missing or unknown (an older save, result or room) is Standard. */
export const lengthOr = (x: unknown): RaceLengthId => (isRaceLengthId(x) ? x : DEFAULT_LENGTH);

/** The preset racing `laps` laps, or null: a mirror reading a server snapshot, which carries the count. */
export const lengthForLaps = (laps: unknown): RaceLength | null => RACE_LENGTHS.find((l) => l.laps === laps) ?? null;

/** Whether a client that knows preset list `set` (0: an older client, Standard only) can show a race of this length. */
export const knowsLength = (set: number, id: RaceLengthId): boolean => raceLength(id).since <= set;
