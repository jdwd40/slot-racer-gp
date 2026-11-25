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

/**
 * Per-car fields fixed for the whole race: sent once per race (first state, resume state). `setup` and `tuning` (#133) are
 * additive: an older decoder copies the static list whole and an older mirror reads only the fields it knows, and an older
 * server's static list lacks them (its cars are all Balanced), so PROTOCOL_VERSION stays 2.
 */
export const CAR_STATIC = ['id', 'slot', 'control', 'name', 'color', 'num', 'bay', 'setup', 'tuning'] as const satisfies readonly (keyof CarSnapshot)[];
export type StaticKey = (typeof CAR_STATIC)[number];
export type StaticCar = Pick<CarSnapshot, StaticKey>;

/**
 * Every other per-car field, in snapshot order, with its wire precision. `satisfies` makes a field added to CarSnapshot a
 * type error here until it is listed: adding a dynamic field is this one line, as mirror.ts copies every field listed here
 * (an optional one also needs its absent value in mirror.ts's ABSENT, which the types enforce).
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
  // #119 whether the race core paused the running count on this step (backing up): its own decision from the full-precision
  // speed, exact, so the HUD never re-derives it from the 3-decimal `v` (-0.9998 m/s would read as -1.000). Additive: always
  // sent by a current server (false nearly always, so deltas rarely carry it); an older server's frames lack it, older
  // decoders copy it through untouched and older mirrors copy only the fields they list, so PROTOCOL_VERSION stays 2
  stallPaused: 'exact',
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

/**
 * A table entry compiled once (#168): the key, and how its numbers are rounded. `f` is 10^dp and `min` 10^-dp, the very
 * expressions the per-call rounding used, so every rounded value is bit for bit what it always was.
 */
interface Rule { readonly k: string; readonly kind: 0 | 1 | 2; readonly f: number; readonly min: number; }
const EXACT = 0, ROUND = 1, KEEP_POSITIVE = 2;
function compile(table: Readonly<Record<string, Precision>>): readonly Rule[] {
  return Object.keys(table).map((k) => {
    const p = table[k], dp = decimalsOf(p);
    if (dp === null) return { k, kind: EXACT, f: 1, min: 0 };
    return { k, kind: typeof p === 'object' && p.keepPositive ? KEEP_POSITIVE : ROUND, f: 10 ** dp, min: 10 ** -dp };
  });
}
const RACE_RULES = compile(RACE_FIELDS);
const CAR_RULES = compile(CAR_DYNAMIC);

/**
 * A number as it goes on the wire. ROUND: `|| 0` turns -0 into 0 (JSON writes both as 0, so the encoder's baseline must not
 * keep a sign the client never sees). KEEP_POSITIVE (#79): a value above 0 that rounds to 0 goes as the smallest step
 * instead. A monotone function of the value, like plain rounding, so a steadily falling value never flaps on the wire, and
 * exactly 0 (or anything not above 0) is untouched, so a tank that really runs dry is sent as 0 in the next state.
 */
function wireNumber(x: number, r: Rule): number {
  if (r.kind === EXACT) return x;
  const v = Math.round(x * r.f) / r.f || 0;
  return r.kind === KEEP_POSITIVE && v === 0 && x > 0 ? r.min : v;
}
/** A value as it goes on the wire: numbers rounded per the rule, objects copied (never shared with the race). */
function wireValue(v: unknown, r: Rule): unknown {
  if (typeof v === 'number') return wireNumber(v, r);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => wireValue(x, r));
  const out: Fields = {};
  const o = v as Fields;
  for (const k of Object.keys(o)) { const x = o[k]; if (x !== undefined) out[k] = wireValue(x, r); }
  return out;
}

/**
 * JSON-text equality without writing the text (#168): the same answer as comparing `JSON.stringify` of both, which the
 * encoder used to do for every object field of every car on every broadcast. Plain data compares structurally, keys in
 * order; anything JSON would write in a way this does not model (undefined, NaN or Infinity, functions, a toJSON, a class
 * instance, a key-set or key-order mismatch) sets `odd`, and `same` then asks JSON itself. Wire values are plain data, so
 * that fallback is for completeness, not for the hot path.
 */
let odd = false;
function plain(o: object): boolean {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null || p === Array.prototype;
}
function leafEq(x: unknown, y: unknown): boolean {
  if (x === undefined || y === undefined) { odd = true; return false; }
  if (x === y) return true;
  const tx = typeof x, ty = typeof y;
  if (tx === 'object' && ty === 'object' && x !== null && y !== null) return objEq(x as object, y as object);
  if ((tx === 'number' && !Number.isFinite(x)) || (ty === 'number' && !Number.isFinite(y))
    || (tx !== 'number' && tx !== 'string' && tx !== 'boolean' && tx !== 'object')
    || (ty !== 'number' && ty !== 'string' && ty !== 'boolean' && ty !== 'object')
    || (tx === 'object' && x !== null && !plain(x as object)) || (ty === 'object' && y !== null && !plain(y as object))) odd = true;
  return false;
}
function objEq(a: object, b: object): boolean {
  if (!plain(a) || !plain(b)) { odd = true; return false; }
  const aa = Array.isArray(a);
  if (aa !== Array.isArray(b)) return false;
  if (aa) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!leafEq(x[i], y[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) { odd = true; return false; }
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k !== kb[i]) { odd = true; return false; }
    if (!leafEq((a as Fields)[k], (b as Fields)[k])) return false;
  }
  return true;
}
/** Whether two wire values encode to the same JSON text (strictly equal, or objects with the same JSON). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  odd = false;
  const eq = objEq(a, b);
  return odd ? JSON.stringify(a) === JSON.stringify(b) : eq;
}

/**
 * Deep copy of plain JSON data with JSON's own result (#168): exactly `JSON.parse(JSON.stringify(v))` for a top-level
 * object, without the text, so decoded output never shares objects with the decoder's state. Inside an object JSON drops
 * undefined (and functions) from objects, writes them as null in arrays, writes NaN and Infinity as null and -0 as 0; this
 * does the same. A non-plain object (a toJSON, a class instance) or a bigint goes through JSON itself. A primitive is
 * returned as it is, as before.
 */
class NotPlain extends Error {}
function cloneLeaf(v: unknown): unknown {
  switch (typeof v) {
    case 'number': return Number.isFinite(v) ? (v === 0 ? 0 : v) : null;
    case 'string': case 'boolean': return v;
    case 'object': return v === null ? null : cloneObj(v);
    case 'undefined': case 'function': case 'symbol': return undefined;
    default: throw new NotPlain();
  }
}
function cloneObj(v: object): unknown {
  if (!plain(v)) throw new NotPlain();
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) { const x = cloneLeaf(v[i]); out[i] = x === undefined ? null : x; }
    return out;
  }
  return cloneFields(v as Fields);
}
// JSON.parse makes an own "__proto__" key; an assignment would set the prototype instead
const setOwn = (out: Fields, k: string, v: unknown): void => {
  if (k === '__proto__') Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
  else out[k] = v;
};
/**
 * A plain object's fields as JSON would carry them (see cloneLeaf). Made by a spread and then fixed up in place, never by
 * adding keys one at a time: V8 keeps a spread's result a fast object, where an object built key by key with computed
 * names soon falls back to a slow dictionary, and every later read and copy of it pays.
 */
function cloneFields(src: Fields): Fields {
  if (Object.getOwnPropertySymbols(src).length) {   // JSON skips symbol keys, a spread would not
    const out: Fields = {};
    for (const k of Object.keys(src)) { const x = cloneLeaf(src[k]); if (x !== undefined) setOwn(out, k, x); }
    return out;
  }
  const out: Fields = { ...src };
  let drop: string[] | null = null;
  for (const k of Object.keys(src)) {
    const x = src[k];
    switch (typeof x) {
      case 'number': if (!Number.isFinite(x)) setOwn(out, k, null); else if (x === 0 && 1 / x < 0) setOwn(out, k, 0); break;
      case 'string': case 'boolean': break;
      case 'object': if (x !== null) setOwn(out, k, cloneObj(x)); break;
      case 'undefined': case 'function': case 'symbol': (drop ??= []).push(k); break;
      default: throw new NotPlain();
    }
  }
  if (!drop) return out;
  for (const k of drop) delete out[k];
  return { ...out };   // a delete makes a dictionary; a spread of it is fast again
}
const copy = <V>(v: V): V => {
  if (v === null || typeof v !== 'object') return v;
  try { return cloneObj(v) as V; } catch (e) { if (e instanceof NotPlain) return JSON.parse(JSON.stringify(v)) as V; throw e; }
};

/** A decoded car: the static fields, then a copy of the held dynamic ones (as `{ ...s, ...copy(c) }`). */
const carOut = (s: StaticCar, c: Fields): Fields => {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return { ...s, ...(copy(c) as Fields) };   // malformed: as before
  try { return { ...s, ...cloneFields(c) }; } catch (e) { if (e instanceof NotPlain) return { ...s, ...(JSON.parse(JSON.stringify(c)) as Fields) }; throw e; }
};

/**
 * A table's wire values in table order, `undefined` for an absent field (#168: the encoder's baseline is these arrays,
 * compared index by index, so a broadcast builds no object per car; only a keyframe turns them into objects).
 */
type Vals = unknown[];
function encodeVals(src: Fields, rules: readonly Rule[]): Vals {
  const out: Vals = new Array<unknown>(rules.length);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i], v = src[r.k];
    out[i] = v === undefined ? undefined : typeof v === 'number' ? wireNumber(v, r) : wireValue(v, r);
  }
  return out;
}
/** The wire object for a table's values: present fields only, in table order (the order the wire has always had). */
function fieldsOf(vals: Vals, rules: readonly Rule[]): Fields {
  const out: Fields = {};
  for (let i = 0; i < rules.length; i++) if (vals[i] !== undefined) out[rules[i].k] = vals[i];
  return out;
}
function encode(s: RaceSnapshot): Encoded {
  return {
    race: fieldsOf(encodeVals(s as unknown as Fields, RACE_RULES), RACE_RULES),
    cars: s.cars.map((c) => fieldsOf(encodeVals(c as unknown as Fields, CAR_RULES), CAR_RULES)),
  };
}
const staticOf = (s: RaceSnapshot): StaticCar[] => s.cars.map((c) => {
  const o: Fields = {};
  for (const k of CAR_STATIC) if (c[k] !== undefined) o[k] = c[k];
  return o as StaticCar;
});
/**
 * Whether the snapshot's static fields encode as `held` does (the JSON of staticOf(s) equals the JSON of `held`). The
 * common answer, every field strictly equal and present alike, needs no copy; anything else asks the full comparison.
 */
function sameStatics(s: RaceSnapshot, held: StaticCar[]): boolean {
  if (s.cars.length !== held.length) return false;
  for (let i = 0; i < held.length; i++) {
    const c = s.cars[i] as unknown as Fields, h = held[i] as unknown as Fields;
    for (const k of CAR_STATIC) {
      const v = c[k];
      if (v === undefined ? k in h : v !== h[k]) return same(staticOf(s), held);
    }
  }
  return true;
}
/**
 * The fields of `next` whose wire value differs from `prev` (or that `prev` lacked), in table order, plus a DELETED list
 * (also in table order) for fields `prev` had and `next` does not, unless `noDeleted`.
 */
function diff(prev: Vals, next: Vals, rules: readonly Rule[], noDeleted = false): Fields {
  const out: Fields = {};
  let gone: string[] | null = null;
  for (let i = 0; i < rules.length; i++) {
    const a = prev[i], b = next[i];
    if (b === undefined) { if (a !== undefined && !noDeleted) (gone ??= []).push(rules[i].k); continue; }
    if (a === undefined || (a !== b && !same(a, b))) out[rules[i].k] = b;
  }
  if (gone) out[DELETED] = gone;
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
  /** the last broadcast state's wire values (race fields, then each car's dynamic fields) */
  private prev: { race: Vals; cars: Vals[] } | null = null;
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
    const race = encodeVals(snap as unknown as Fields, RACE_RULES);
    const cars = snap.cars.map((c) => encodeVals(c as unknown as Fields, CAR_RULES));
    const roster = !this.prev || !this.statics || !sameStatics(snap, this.statics);
    let frame: StateFrame;
    if (roster || atMs - this.keyAt >= this.keyMs - 1e-6) {
      const st = roster ? staticOf(snap) : null;
      frame = { key: 1, ...(st ? { static: { race: this.raceId, cars: st } } : {}), snap: { ...fieldsOf(race, RACE_RULES), cars: cars.map((c) => fieldsOf(c, CAR_RULES)) } };
      this.keyAt = atMs; if (st) this.statics = st; this.stats.keyframes++;
    } else {
      const prev = this.prev!;
      // race-level fields are never optional: no DELETED list
      frame = { base: this.prevTick, snap: { ...diff(prev.race, race, RACE_RULES, true), cars: cars.map((c, i) => diff(prev.cars[i], c, CAR_RULES)) } };
      this.stats.deltas++;
    }
    this.prev = { race, cars }; this.prevTick = tick;
    return frame;
  }

  /**
   * What a resuming socket gets: a keyframe with the static fields of the last broadcast state (at `tick`), so the
   * broadcasts that follow, deltas from that same state, apply to it directly. Null before the first broadcast.
   */
  resume(): { tick: number; frame: StateFrame } | null {
    if (!this.prev || !this.statics) return null;
    const p = this.prev;
    return { tick: this.prevTick, frame: { key: 1, static: { race: this.raceId, cars: copy(this.statics) }, snap: { ...copy(fieldsOf(p.race, RACE_RULES)), cars: p.cars.map((c) => copy(fieldsOf(c, CAR_RULES))) } } };
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
 * What the decoder knows about one held object (#168), so a decoded state is a shallow copy plus a deep copy of only the
 * few object-valued fields: which keys hold objects, and whether anything is held that JSON would write differently from
 * what a shallow copy keeps (undefined, NaN, -0, a `__proto__` key, a held value that is not an object at all). Values
 * that came through JSON never are; when one is, the output is made the general way, exactly as before.
 */
interface Meta { objs: string[]; odd: boolean; }
const isObj = (v: unknown): v is object => v !== null && typeof v === 'object';
/** A primitive a shallow copy keeps exactly as JSON would rebuild it. */
const plainLeaf = (v: unknown): boolean =>
  typeof v === 'string' || typeof v === 'boolean' || v === null || (typeof v === 'number' && Number.isFinite(v) && !(v === 0 && 1 / v < 0));
function metaOf(f: unknown): Meta {
  const m: Meta = { objs: [], odd: !isObj(f) || Array.isArray(f) };
  if (!m.odd) for (const k of Object.keys(f as Fields)) note(m, k, (f as Fields)[k]);
  return m;
}
/** Record that `k` now holds `v`. */
function note(m: Meta, k: string, v: unknown): void {
  if (k === '__proto__') { m.odd = true; return; }
  const at = m.objs.indexOf(k);
  if (isObj(v)) { if (at < 0) m.objs.push(k); }
  else { if (at >= 0) m.objs.splice(at, 1); if (!plainLeaf(v)) m.odd = true; }
}
/** A copy of the held `f` as JSON would make it: shallow, then each object field deep. */
function heldOut(s: object | null, f: Fields, m: Meta): Fields {
  const out: Fields = s ? { ...s, ...f } : { ...f };
  for (const k of m.objs) out[k] = cloneObj(f[k] as object);
  return out;
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
  private meta: { race: Meta; cars: Meta[] } | null = null;
  private tick = -1;
  readonly stats: DecodeStats = { keyframes: 0, deltas: 0, gaps: 0, noStatic: 0 };

  /** Forget everything (a new connection). */
  reset(): void { this.statics = null; this.race = null; this.cur = null; this.meta = null; this.tick = -1; }

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
      this.meta = { race: metaOf(this.cur.race), cars: this.cur.cars.map(metaOf) };
      this.stats.keyframes++;
    } else {
      const cur = this.cur, meta = this.meta!;
      if (!cur || m.base !== this.tick || snap.cars.length !== cur.cars.length) { this.cur = null; this.stats.gaps++; return null; }
      const { cars, ...race } = snap;
      const rc = copy(race);
      Object.assign(cur.race, rc);
      for (const k of Object.keys(rc)) note(meta.race, k, rc[k]);
      cars.forEach((d, i) => {
        const c = cur.cars[i], cm = meta.cars[i];
        let reshaped = false;
        for (const k of Object.keys(d)) if (k !== DELETED) { const v = copy(d[k]); if (!(k in c)) reshaped = true; c[k] = v; note(cm, k, v); }
        if (Array.isArray(d[DELETED])) for (const k of d[DELETED] as string[]) { reshaped = true; delete c[k]; const at = cm.objs.indexOf(k); if (at >= 0) cm.objs.splice(at, 1); }
        // a field that came or went (an optional one, a few times a race): respread, so the held car stays a fast object
        if (reshaped && !cm.odd) cur.cars[i] = { ...c };
      });
      this.stats.deltas++;
    }
    this.tick = m.tick;
    const cur = this.cur!, meta = this.meta!;
    // a fresh copy of the held state, as JSON would make it (#168: without the text, and deep only where a field holds an
    // object): the caller may change it freely, the next delta still applies to the state the server diffed against
    const out = meta.race.odd ? copy(cur.race) : heldOut(null, cur.race, meta.race);
    out.cars = this.statics!.map((s, i) => (meta.cars[i].odd ? carOut(s, cur.cars[i]) : heldOut(s, cur.cars[i], meta.cars[i])));
    return out as unknown as RaceSnapshot;
  }
}
