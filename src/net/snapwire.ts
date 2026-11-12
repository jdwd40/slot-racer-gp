// Wire encoding of the room server's race snapshots (protocol v2, #67). `Race.snapshot()` is ~70 fields per car; sent whole
// as JSON 20 times a second that was ~5 KB a message (~97 KB/s per player) with WebSocket compression off on purpose. So:
// - The per-car fields that never change during a race (CAR_STATIC) go once per race: in the first state of the race and in
//   every resume state, never per tick.
// - Every other field is listed in RACE_FIELDS / CAR_DYNAMIC with its wire precision. A keyframe carries all of them; a
//   delta carries only the keys whose encoded value changed since the previous broadcast, which it names by tick (`base`).
// - Continuously changing floats are rounded on the wire (see the tables); everything else travels exactly. Rounding is
//   applied to a copy made for the wire, after the step: the simulation never reads it, so results cannot change. `fuel`
//   keeps a non-empty tank non-empty (#79): a value above 0 that would round to 0 goes as the smallest step (0.001), so
//   only a truly empty tank decodes as 0. That is a choice of number, not of format: any v2 decoder reads it unchanged.
// - A keyframe goes out at least every KEYFRAME_MS, so a client that lost a delta recovers within a second.
// The decoder rebuilds the full RaceSnapshot (rounded as declared), so mirror.ts and every consumer see the same shape as
// before. Plain data only: the browser bundle, the server and headless tools all import this. docs/online-server.md.
import type { CarSnapshot, RaceSnapshot } from '../race';

/**
 * How a field travels. 'exact': as the snapshot has it (strings, enums, booleans, integers, and floats that change only now
 * and then, such as lap times, so the HUD shows exactly the server's value). A number: decimals kept on the wire for that
 * float, or for every number inside that object. Rounded values are within half a unit of the last kept decimal.
 * `{ dp, keepPositive: true }` (#79): the same rounding, except that a value above 0 that would round to 0 is sent as the
 * smallest step (10^-dp), so "above 0" survives the wire (a non-empty tank is never read as empty); exactly 0 stays 0 and
 * every value of at least half a step rounds as plain `dp`. Within one step of the full value, never half a step off in
 * the other direction. Only the number chosen differs: the wire form is a plain number either way.
 */
export type Precision = 'exact' | number | { readonly dp: number; readonly keepPositive: true };
/** Decimals a rounded precision keeps (null for 'exact'). */
export const decimalsOf = (p: Precision): number | null => (p === 'exact' ? null : typeof p === 'number' ? p : p.dp);

/** Per-car fields fixed for the whole race: sent once per race (first state, resume state). */
export const CAR_STATIC = ['id', 'slot', 'control', 'name', 'color', 'num', 'bay'] as const satisfies readonly (keyof CarSnapshot)[];
export type StaticKey = (typeof CAR_STATIC)[number];
export type StaticCar = Pick<CarSnapshot, StaticKey>;

/**
 * Every other per-car field, in snapshot order, with its wire precision. `satisfies` makes a field added to CarSnapshot a
 * type error here until it is listed: adding a dynamic field (optional or not) is this one line plus mirror.ts's CAR_FIELDS.
 * 3 decimals: 1 mm of position, distance and lateral offset (track units are metres), 1 mm/s of speed, 1 mrad of angle,
 * 0.1% of pedal and of the fuel tank. These change nearly every step; the rest change a few times a lap. `fuel` keeps a
 * non-empty tank above 0 (#79): a tank under 0.05% goes as 0.1%, not as an empty 0.
 */
export const CAR_DYNAMIC = {
  status: 'exact', dqReason: 'exact', dnfReason: 'exact', finished: 'exact',
  mode: 'exact', u: 3, v: 3, d: 3, laneSide: 3, change: 'exact',
  x: 3, y: 3, z: 3, h: 3, roll: 3, pitch: 3, yawOff: 3, wobble: 3, off: 3,
  throttle: 3, brake: 3, fuel: { dp: 3, keepPositive: true },
  crossed: 'exact', lapsDone: 'exact', lastLap: 'exact', bestLap: 'exact', lapStartT: 'exact', lapValid: 'exact', finishTime: 'exact', pitStops: 'exact',
  offences: 'exact', sgOwed: 'exact', sgServed: 'exact', sgServing: 'exact', timePen: 'exact', svcBreach: 'exact',
  laneReq: 'exact', pitReq: 'exact', fuelReq: 'exact', fuelDue: 'exact', sgDue: 'exact', sgDeferred: 'exact', routeHold: 'exact', laneOverride: 'exact',
  revOn: 'exact', sgPhase: 'exact', sgCtl: 'exact', pitWait: 'exact', exitReq: 'exact', bayInUse: 'exact',
  serviceT: 'exact', penalty: 'exact', towT: 'exact', recoverT: 'exact', bumpT: 'exact',
  hiU: 3, squeezeHold: 'exact', pitHold: 'exact', towSvc: 'exact', pitFuel: 'exact', serviced: 'exact', upPrev: 'exact',
  // #69 stopped-on-track recovery: a countdown that runs only while a car is stopped on the racing lane (exact, like the
  // other timers: it costs nothing the rest of the time and the HUD counts down the server's own value), and two flags
  stallT: 'exact', stallHold: 'exact', stallSvc: 'exact',
  // #74 held for an away driver: optional and additive (absent while false, so an older server's frames simply lack it and
  // a delta names it under DELETED when the hold ends), which keeps PROTOCOL_VERSION 2
  away: 'exact',
} as const satisfies Record<Exclude<keyof CarSnapshot, StaticKey>, Precision>;

/** Race-level fields (everything but `cars`). Only the clocks change every step; they keep 1 ms. */
export const RACE_FIELDS = {
  v: 'exact', track: 'exact', laps: 'exact', practice: 'exact',
  phase: 'exact', t: 3, raceTime: 3, goT: 'exact', lights: 'exact', firstFlagT: 'exact',
  finishWindow: 'exact', timeLimit: 'exact', pit: 'exact', lastSeq: 'exact', final: 'exact',
} as const satisfies Record<Exclude<keyof RaceSnapshot, 'cars'>, Precision>;

/** A keyframe at least this often (ms of race wall time), so a client that missed a delta is whole again within a second. */
export const KEYFRAME_MS = 1000;
/** Key a delta car uses to list fields that were present and are now absent (optional fields); never a field name. */
export const DELETED = '-';

/** Wire form of the race: race-level fields plus one entry per car, in the static list's order. */
export interface WireSnap { cars: Record<string, unknown>[]; [field: string]: unknown; }
/**
 * The snapshot part of a v2 `state` message. Exactly one of `key` (a keyframe: every field) or `base` (a delta from the
 * state broadcast at tick `base`: only changed fields, `{}` for an unchanged car). `static` (the race id and every car's
 * fixed fields, in wire order) comes with the first state of a race and with every resume state, both keyframes.
 */
export interface StateFrame {
  key?: 1;
  base?: number;
  static?: { race: string; cars: StaticCar[] };
  snap: WireSnap;
}

type Fields = Record<string, unknown>;
interface Encoded { race: Fields; cars: Fields[]; }

const roundTo = (x: number, dp: number): number => {
  const f = 10 ** dp;
  // `|| 0` turns -0 into 0: JSON writes both as 0, so the encoder's baseline must not keep a sign the client never sees
  return Math.round(x * f) / f || 0;
};
/**
 * keepPositive (#79): a value above 0 that rounds to 0 goes as the smallest step instead. A monotone function of the value,
 * like roundTo, so a steadily falling value never flaps on the wire, and exactly 0 (or anything not above 0) is untouched,
 * so a tank that really runs dry is sent as 0 in the next state.
 */
const roundKeepPositive = (x: number, dp: number): number => {
  const r = roundTo(x, dp);
  return r === 0 && x > 0 ? 10 ** -dp : r;
};
/** A value as it goes on the wire: numbers rounded per the precision, objects copied (never shared with the race). */
function wireValue(v: unknown, p: Precision): unknown {
  if (typeof v === 'number') return p === 'exact' ? v : typeof p === 'number' ? roundTo(v, p) : p.keepPositive ? roundKeepPositive(v, p.dp) : roundTo(v, p.dp);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => wireValue(x, p));
  const out: Fields = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = wireValue(x, p);
  return out;
}
const same = (a: unknown, b: unknown): boolean =>
  a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
/** Deep copy of plain JSON data (decoded output never shares objects with the decoder's state). */
const copy = <V>(v: V): V => (v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as V));

function encodeFields(src: Fields, table: Readonly<Record<string, Precision>>): Fields {
  const out: Fields = {};
  for (const k of Object.keys(table)) if (src[k] !== undefined) out[k] = wireValue(src[k], table[k]);
  return out;
}
function encode(s: RaceSnapshot): Encoded {
  return {
    race: encodeFields(s as unknown as Fields, RACE_FIELDS),
    cars: s.cars.map((c) => encodeFields(c as unknown as Fields, CAR_DYNAMIC)),
  };
}
const staticOf = (s: RaceSnapshot): StaticCar[] => s.cars.map((c) => {
  const o: Fields = {};
  for (const k of CAR_STATIC) o[k] = c[k];
  return o as StaticCar;
});
/** Keys of `next` that differ from `prev`, plus a DELETED list for keys `prev` had and `next` does not. */
function diff(prev: Fields, next: Fields): Fields {
  const out: Fields = {};
  for (const k of Object.keys(next)) if (!(k in prev) || !same(prev[k], next[k])) out[k] = next[k];
  const gone = Object.keys(prev).filter((k) => !(k in next));
  if (gone.length) out[DELETED] = gone;
  return out;
}

/**
 * The snapshot exactly as a v2 client reconstructs it: the full snapshot with the wire rounding applied. Tests compare the
 * decoded stream with this; the server never feeds it back into the race.
 */
export function wireRounded(s: RaceSnapshot): RaceSnapshot {
  const e = encode(s);
  const st = staticOf(s);
  return { ...e.race, cars: st.map((c, i) => ({ ...c, ...e.cars[i] })) } as unknown as RaceSnapshot;
}

/**
 * Server side: one per race. Keeps the last broadcast (encoded) state, which is what every client of the room holds, so
 * every member gets the same bytes and a delta is always relative to the state they all have.
 */
export class SnapEncoder {
  private prev: Encoded | null = null;
  private prevTick = -1;
  private statics: StaticCar[] | null = null;
  private keyAt = -Infinity;
  /** counts for diagnostics and tests */
  readonly stats = { keyframes: 0, deltas: 0 };

  constructor(readonly raceId: string, private keyMs = KEYFRAME_MS) {}

  /**
   * Encode the next broadcast. `atMs` is the race wall clock the keyframe interval is measured on. The first state of the
   * race (and any change in the car list, which the race core never makes mid-race) is a keyframe with the static fields.
   */
  next(snap: RaceSnapshot, tick: number, atMs: number): StateFrame {
    const enc = encode(snap);
    const st = staticOf(snap);
    const roster = !this.prev || !this.statics || !same(st, this.statics);
    let frame: StateFrame;
    if (roster || atMs - this.keyAt >= this.keyMs - 1e-6) {
      frame = { key: 1, ...(roster ? { static: { race: this.raceId, cars: st } } : {}), snap: { ...enc.race, cars: enc.cars } };
      this.keyAt = atMs; this.statics = st; this.stats.keyframes++;
    } else {
      const prev = this.prev!;
      const race = diff(prev.race, enc.race);
      delete race[DELETED];   // race-level fields are never optional
      frame = { base: this.prevTick, snap: { ...race, cars: enc.cars.map((c, i) => diff(prev.cars[i], c)) } };
      this.stats.deltas++;
    }
    this.prev = enc; this.prevTick = tick;
    return frame;
  }

  /**
   * What a resuming socket gets: a keyframe with the static fields of the last broadcast state (at `tick`), so the
   * broadcasts that follow, deltas from that same state, apply to it directly. Null before the first broadcast.
   */
  resume(): { tick: number; frame: StateFrame } | null {
    if (!this.prev || !this.statics) return null;
    return { tick: this.prevTick, frame: { key: 1, static: { race: this.raceId, cars: copy(this.statics) }, snap: { ...copy(this.prev.race), cars: copy(this.prev.cars) } } };
  }
}

/** What arrives in a v2 `state` message (the fields this module reads). */
export interface WireStateMsg extends StateFrame { tick: number; }

export interface DecodeStats {
  keyframes: number; deltas: number;
  /** deltas dropped because their base was not the state held (a missed message): recovered at the next keyframe */
  gaps: number;
  /** keyframes dropped because this race's static fields were never received (a resume state brings them) */
  noStatic: number;
}

/**
 * Client side: one per connection (a new socket starts from the resume state). Turns each v2 state back into the full
 * RaceSnapshot, or null when it cannot: a delta whose base is not the last decoded state, or anything before the static
 * fields. After a null, nothing is decoded until the next keyframe, so a client never shows a half-applied state.
 */
export class SnapDecoder {
  private statics: StaticCar[] | null = null;
  private race: string | null = null;
  private cur: Encoded | null = null;
  private tick = -1;
  readonly stats: DecodeStats = { keyframes: 0, deltas: 0, gaps: 0, noStatic: 0 };

  /** Forget everything (a new connection). */
  reset(): void { this.statics = null; this.race = null; this.cur = null; this.tick = -1; }

  /** The race the static fields belong to (null before the first). */
  get raceId(): string | null { return this.race; }

  decode(m: WireStateMsg): RaceSnapshot | null {
    const snap = m.snap;
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.cars)) { this.cur = null; this.stats.gaps++; return null; }
    if (m.static) { this.statics = copy(m.static.cars); this.race = m.static.race; }
    if (m.key) {
      if (!this.statics || this.statics.length !== snap.cars.length) { this.cur = null; this.stats.noStatic++; return null; }
      const { cars, ...race } = snap;
      this.cur = { race: copy(race), cars: copy(cars) };
      this.stats.keyframes++;
    } else {
      const cur = this.cur;
      if (!cur || m.base !== this.tick || snap.cars.length !== cur.cars.length) { this.cur = null; this.stats.gaps++; return null; }
      const { cars, ...race } = snap;
      Object.assign(cur.race, copy(race));
      cars.forEach((d, i) => {
        const c = cur.cars[i];
        for (const [k, v] of Object.entries(d)) if (k !== DELETED) c[k] = copy(v);
        if (Array.isArray(d[DELETED])) for (const k of d[DELETED] as string[]) delete c[k];
      });
      this.stats.deltas++;
    }
    this.tick = m.tick;
    const cur = this.cur!;
    return { ...copy(cur.race), cars: this.statics!.map((s, i) => ({ ...s, ...copy(cur.cars[i]) })) } as unknown as RaceSnapshot;
  }
}
