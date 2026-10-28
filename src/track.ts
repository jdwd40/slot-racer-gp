// Track layout: classic slot-car sections (straights + constant-radius arcs).
// 2D coordinates: x east, y north. Heading h in radians, CCW positive.
// Lateral offset d is measured along the LEFT normal.
//
// Several circuits are defined below; `setTrack(id)` makes one of them the
// active layout. Every exported geometry value is rebuilt on switch, so the
// rest of the game reads them live through `import * as T`.

type SegDef = ['S', number | 'A' | 'B'] | ['A', number, number];

/** Position along a segment: offset ≥ 0 from its start, < 0 from its end. */
export type SegPos = [seg: number, off: number];

export type Theme = 'park' | 'harbour' | 'alpine' | 'workshop' | 'speedway';

export interface TrackDef {
  id: string;
  /** scenery / setting used by the world builder */
  theme: Theme;
  /** i18n ids: track.<id>.name and track.<id>.desc */
  segs: SegDef[];
  /** index of the arc that carries the single-file squeeze */
  squeezeSeg: number;
  /** lane-change sections (each 7 units long) */
  switches: SegPos[];
  /** low blue barriers along straights: [segment, side] */
  barriers: [number, number][];
  /** grandstands: start/end along the track, lateral offset, side, rows, roof colour */
  stands: { s0: SegPos; s1: SegPos; d: number; sd: number; rows: number; roof: number }[];
  /** ad board runs on the outside of straights */
  ads: { s0: SegPos; s1: SegPos; d: number }[];
  /** tyre stacks on the outside of these corners */
  tyreSegs: number[];
  /** marshal posts */
  marshals: { at: SegPos; d: number }[];
  /** elevation keyframes: height of the slot surface at these positions (smooth in between, 0 elsewhere) */
  elev?: { at: SegPos; z: number }[];
  /** banked arcs: extra cornering grip (fraction) and the slope angle of the surface (radians) */
  banked?: { seg: number; grip: number; tilt: number }[];
  /** catch fencing runs: [segment, side] */
  fences?: [number, number][];
  /** distance boards (100/50 markers) before these corners */
  boards?: number[];
}

export const TRACKS: TrackDef[] = [
  {
    id: 'circuit-1',
    theme: 'park',
    segs: [
      ['S', 'A'],          // 0 main straight (east)
      ['A', 11, 90],       // 1 squeeze sweeper
      ['S', 'B'],          // 2 north straight
      ['A', 4.2, 180],     // 3 hairpin
      ['S', 10],           // 4
      ['A', 8, -90],       // 5 right-hander
      ['S', 38],           // 6 back straight
      ['A', 7, 45],        // 7 esses
      ['A', 7, -45],       // 8
      ['S', 6],            // 9
      ['A', 5, 90],        // 10
      ['S', 8],            // 11
      ['A', 4.5, 90],      // 12 tight left
      ['A', 6, -90],       // 13
      ['S', 4],            // 14
      ['A', 10, 90],       // 15 final sweeper onto main straight
    ],
    squeezeSeg: 1,
    switches: [[2, 8], [2, 31], [6, 12], [11, 0.5]],
    barriers: [[2, -1], [6, 1], [4, -1]],
    stands: [
      { s0: [0, 6], s1: [0, 31], d: 3.0, sd: 1, rows: 6, roof: 0xd42a22 },
      { s0: [2, 6], s1: [2, 22], d: -3.4, sd: -1, rows: 5, roof: 0x2a6df0 },
      { s0: [6, 22], s1: [6, 36], d: 3.4, sd: 1, rows: 5, roof: 0x22b04b },
    ],
    ads: [
      { s0: [6, 2], s1: [6, 20], d: -2.7 },
      { s0: [2, 25], s1: [2, 46], d: -2.7 },
      { s0: [0, 33], s1: [0, -2], d: -2.7 },
    ],
    tyreSegs: [3, 5, 10, 12, 13],
    marshals: [{ at: [1, -2], d: 3.2 }, { at: [2, 0.2], d: 3.2 }, { at: [3, 6], d: 6.6 }, { at: [12, 3], d: -3.6 }],
  },
  {
    id: 'circuit-2',
    theme: 'harbour',
    segs: [
      ['S', 'A'],          // 0 main straight (east)
      ['A', 10, 90],       // 1 squeeze sweeper
      ['S', 'B'],          // 2 harbour straight (north)
      ['A', 9, 180],       // 3 wide lighthouse hairpin
      ['S', 12],           // 4 south
      ['A', 6, -90],       // 5 right onto the quay
      ['S', 8],            // 6
      ['A', 5, -40],       // 7 quay kink
      ['A', 5, 40],        // 8
      ['S', 8],            // 9
      ['A', 6, -90],       // 10 right, climbing north
      ['S', 6],            // 11
      ['A', 7, 90],        // 12 left over the bridge
      ['S', 6],            // 13
      ['A', 6, 90],        // 14 left onto the seafront
      ['S', 30],           // 15 seafront straight (south)
      ['A', 6, 90],        // 16 final left onto main straight
    ],
    squeezeSeg: 1,
    switches: [[2, 4], [2, 18], [15, 4], [15, 19]],
    barriers: [[2, -1], [15, 1], [4, 1]],
    stands: [
      { s0: [0, 6], s1: [0, 31], d: 3.0, sd: 1, rows: 6, roof: 0xd42a22 },
      { s0: [15, 6], s1: [15, 26], d: -3.4, sd: -1, rows: 5, roof: 0x2a6df0 },
      { s0: [2, 4], s1: [2, 24], d: 3.4, sd: 1, rows: 4, roof: 0x22b04b },
    ],
    ads: [
      { s0: [15, 1], s1: [15, 29], d: 2.7 },
      { s0: [2, 1], s1: [2, -1], d: -2.7 },
      { s0: [0, 33], s1: [0, -2], d: -2.7 },
    ],
    tyreSegs: [3, 5, 10, 12, 14],
    marshals: [{ at: [1, -2], d: 3.2 }, { at: [3, 10], d: 6.4 }, { at: [10, 4], d: 3.6 }, { at: [16, 2], d: -3.4 }],
  },
  {
    id: 'circuit-3',
    theme: 'alpine',
    segs: [
      ['S', 'A'],          // 0 main straight (east)
      ['A', 8, 90],        // 1 squeeze sweeper
      ['S', 10],           // 2
      ['A', 5, -90],       // 3 right
      ['S', 8],            // 4 ledge
      ['A', 6, 180],       // 5 summit hairpin
      ['S', 22],           // 6 ridge straight (west)
      ['A', 6, 60],        // 7 esses
      ['A', 6, -120],      // 8
      ['A', 6, 60],        // 9
      ['S', 8],            // 10
      ['A', 7, -90],       // 11 right, up the hill
      ['S', 6],            // 12
      ['A', 4.5, 90],      // 13 tight left
      ['S', 6],            // 14
      ['A', 4.5, 90],      // 15 tight left, downhill
      ['S', 'B'],          // 16 valley straight (south)
      ['A', 10, 90],       // 17 final sweeper onto main straight
    ],
    squeezeSeg: 1,
    switches: [[6, 2], [6, 13], [16, 4], [16, 22]],
    barriers: [[6, 1], [16, 1], [4, -1]],
    stands: [
      { s0: [0, 6], s1: [0, 31], d: 3.0, sd: 1, rows: 6, roof: 0xd42a22 },
      { s0: [6, 2], s1: [6, 20], d: -3.4, sd: -1, rows: 5, roof: 0x2a6df0 },
      { s0: [16, 8], s1: [16, 30], d: -3.4, sd: -1, rows: 5, roof: 0x22b04b },
    ],
    ads: [
      { s0: [6, 1], s1: [6, 21], d: 2.7 },
      { s0: [16, 1], s1: [16, -1], d: 2.7 },
      { s0: [0, 33], s1: [0, -2], d: -2.7 },
    ],
    tyreSegs: [3, 5, 8, 11, 13, 15],
    marshals: [{ at: [1, -2], d: 3.2 }, { at: [5, 9], d: 4.6 }, { at: [8, 4], d: -3.6 }, { at: [15, 3], d: -3.6 }],
  },
  {
    id: 'circuit-4',
    theme: 'workshop',
    segs: [
      ['S', 'A'],          // 0 main straight (east)
      ['A', 8, 90],        // 1 squeeze sweeper, left onto the bridge leg
      ['S', 'B'],          // 2 bridge leg (north): climbs the ramp, crosses the return straight, descends
      ['A', 7, -90],       // 3 right onto the top straight
      ['S', 10],           // 4 top straight (east)
      ['A', 7, -90],       // 5 right, down the east side
      ['S', 6],            // 6
      ['A', 8, -90],       // 7 right onto the return straight
      ['S', 22],           // 8 return straight (west): passes beneath the bridge
      ['A', 5, -45],       // 9 chicane: right
      ['A', 5, 90],        // 10 ... left
      ['A', 5, -45],       // 11 ... right
      ['S', 28],           // 12 west straight (west): the overtaking straight
      ['A', 9, 90],        // 13 left, down the west side
      ['S', 6],            // 14
      ['A', 11, 90],       // 15 broad banked bend back onto the main straight
    ],
    squeezeSeg: 1,
    switches: [[2, 0.5], [4, 1.5], [8, 1], [12, 4], [12, 17]],
    barriers: [[12, 1], [8, -1], [4, -1]],
    stands: [
      { s0: [0, 6], s1: [0, 31], d: 3.0, sd: 1, rows: 6, roof: 0xd42a22 },
      { s0: [12, 5], s1: [12, 23], d: -3.4, sd: -1, rows: 5, roof: 0x2a6df0 },
    ],
    ads: [
      { s0: [12, 2], s1: [12, 26], d: 2.7 },
      { s0: [0, 33], s1: [0, -2], d: -2.7 },
      { s0: [8, 1], s1: [8, 9], d: -2.7 },
    ],
    tyreSegs: [3, 5, 7, 9, 11, 13],
    marshals: [{ at: [1, -2], d: 3.2 }, { at: [5, 4], d: -3.6 }, { at: [10, 3], d: 3.6 }, { at: [13, 5], d: -3.6 }],
    elev: [{ at: [2, 8], z: 0 }, { at: [2, 15], z: 2.3 }, { at: [2, 22], z: 2.3 }, { at: [2, 29], z: 0 }],
    banked: [{ seg: 15, grip: 0.3, tilt: 0.22 }],
    fences: [[0, 1], [12, -1]],
    boards: [3, 7, 9, 13],
  },
  {
    id: 'circuit-5',
    theme: 'speedway',
    segs: [
      ['S', 'A'],          // 0 main straight (east): the long acceleration run
      ['A', 11, 180],      // 1 banked east sweeper (left) onto the back straight
      ['S', 22],           // 2 back straight (west) - the underpass is here
      ['A', 6, 90],        // 3 squeeze: left, braking into the infield
      ['S', 'B'],          // 4 infield south leg
      ['A', 5, 90],        // 5 left
      ['S', 10],           // 6 infield east leg
      ['A', 4.5, 90],      // 7 tight left, onto the ramp
      ['S', 24],           // 8 north leg: climbs the flyover and crosses the back straight
      ['A', 7, 90],        // 9 elevated left
      ['S', 27],           // 10 upper straight (west): descends the ramp
      ['A', 20.25, 180],   // 11 highbank: huge banked sweeper back onto the main straight
    ],
    squeezeSeg: 3,
    switches: [[2, 1], [2, 11], [6, 1.5], [8, 14], [10, 12], [10, 19.5]],
    barriers: [[2, -1], [0, 1]],
    stands: [
      { s0: [0, 6], s1: [0, 31], d: -8.8, sd: -1, rows: 7, roof: 0xd42a22 },
      { s0: [10, 14], s1: [10, 27], d: -3.4, sd: -1, rows: 6, roof: 0x2a6df0 },
      { s0: [2, 14], s1: [2, 21.5], d: -3.4, sd: -1, rows: 4, roof: 0x22b04b },
    ],
    ads: [
      { s0: [0, 33], s1: [0, -2], d: -2.7 },
      { s0: [8, 1], s1: [8, 8], d: -2.7 },
      { s0: [11, 4], s1: [11, 24], d: 2.9 },
    ],
    tyreSegs: [3, 5, 7, 9],
    marshals: [{ at: [1, 10], d: -3.6 }, { at: [3, -1], d: 3.2 }, { at: [7, 3], d: 3.6 }, { at: [11, 20], d: -3.6 }],
    elev: [{ at: [8, 1], z: 0 }, { at: [8, 8.5], z: 2.3 }, { at: [10, 3], z: 2.3 }, { at: [10, 11], z: 0 }],
    banked: [{ seg: 1, grip: 0.3, tilt: 0.24 }, { seg: 11, grip: 0.3, tilt: 0.2 }],
    fences: [[0, 1], [10, -1], [8, -1]],
    boards: [3, 7],
  },
];

export interface Seg { kind: 'S' | 'A'; len: number; R: number; sign: number; s0: number; x0: number; y0: number; h0: number; }
export interface CenterPt { x: number; y: number; h: number; k: number; }

function buildSegs(def: SegDef[], a: number, b: number): { segs: Seg[]; end: { x: number; y: number; h: number }; L: number } {
  let x = 0, y = 0, h = 0, s = 0;
  const segs: Seg[] = [];
  for (const d of def) {
    if (d[0] === 'S') {
      const len = d[1] === 'A' ? a : d[1] === 'B' ? b : (d[1] as number);
      segs.push({ kind: 'S', len, R: 0, sign: 0, s0: s, x0: x, y0: y, h0: h });
      x += Math.cos(h) * len; y += Math.sin(h) * len; s += len;
    } else {
      const R = d[1], ang = (d[2] * Math.PI) / 180, sign = Math.sign(ang);
      const len = Math.abs(ang) * R;
      segs.push({ kind: 'A', len, R, sign, s0: s, x0: x, y0: y, h0: h });
      const h1 = h + ang;
      x += sign * R * (Math.sin(h1) - Math.sin(h));
      y -= sign * R * (Math.cos(h1) - Math.cos(h));
      h = h1; s += len;
    }
  }
  return { segs, end: { x, y, h }, L: s };
}

/** Solve the two free straight lengths so the loop closes. */
function solve(def: SegDef[]): { a: number; b: number } {
  const e0 = buildSegs(def, 0, 0).end, ea = buildSegs(def, 1, 0).end, eb = buildSegs(def, 0, 1).end;
  const ax = ea.x - e0.x, ay = ea.y - e0.y, bx = eb.x - e0.x, by = eb.y - e0.y;
  const det = ax * by - ay * bx;
  return { a: (-e0.x * by + e0.y * bx) / det, b: (-ax * e0.y + ay * e0.x) / det };
}

function segCenter(segs: Seg[], s: number): CenterPt {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].s0 <= s) lo = m; else hi = m - 1; }
  const g = segs[lo];
  const t = s - g.s0;
  if (g.kind === 'S') return { x: g.x0 + Math.cos(g.h0) * t, y: g.y0 + Math.sin(g.h0) * t, h: g.h0, k: 0 };
  const h = g.h0 + (g.sign * t) / g.R;
  return {
    x: g.x0 + g.sign * g.R * (Math.sin(h) - Math.sin(g.h0)),
    y: g.y0 - g.sign * g.R * (Math.cos(h) - Math.cos(g.h0)),
    h, k: g.sign / g.R,
  };
}

export interface Bounds { mnx: number; mny: number; mxx: number; mxy: number; cx: number; cy: number; w: number; h: number; }
function boundsOf(segs: Seg[], len: number): Bounds {
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (let s = 0; s < len; s += 0.5) {
    const c = segCenter(segs, s);
    mnx = Math.min(mnx, c.x); mxx = Math.max(mxx, c.x); mny = Math.min(mny, c.y); mxy = Math.max(mxy, c.y);
  }
  return { mnx, mny, mxx, mxy, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2, w: mxx - mnx, h: mxy - mny };
}

/** Centreline preview of any circuit (does not touch the active track). Used for menus. */
export function layout(def: TrackDef, step = 1): { pts: { x: number; y: number; z: number }[]; bounds: Bounds; L: number } {
  const sol = solve(def.segs);
  const b = buildSegs(def.segs, sol.a, sol.b);
  const keys = elevKeys(def, b.segs);
  const pts: { x: number; y: number; z: number }[] = [];
  for (let s = 0; s < b.L; s += step) { const c = segCenter(b.segs, s); pts.push({ x: c.x, y: c.y, z: elevAt(keys, s) }); }
  return { pts, bounds: boundsOf(b.segs, b.L), L: b.L };
}

// ---- elevation & banking ----
interface ElevKey { s: number; z: number; }
function elevKeys(def: TrackDef, segs: Seg[]): ElevKey[] {
  return (def.elev ?? []).map((k) => { const g = segs[k.at[0]]; return { s: g.s0 + (k.at[1] >= 0 ? k.at[1] : g.len + k.at[1]), z: k.z }; });
}
function elevAt(keys: ElevKey[], s: number): number {
  if (keys.length < 2 || s <= keys[0].s || s >= keys[keys.length - 1].s) return 0;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].s <= s) i++;
  const a = keys[i], b = keys[i + 1];
  return a.z + (b.z - a.z) * smooth((s - a.s) / Math.max(1e-6, b.s - a.s));
}

export interface Bank { s0: number; s1: number; grip: number; tilt: number; sign: number; }
/** blend factor 0..1 of a banked section at s (ramps in and out over a few units inside the arc) */
function bankBlend(b: Bank, s: number): number {
  const ramp = Math.min(3, (b.s1 - b.s0) * 0.3);
  return smooth((s - b.s0) / ramp) * smooth((b.s1 - s) / ramp);
}

export interface Crossing { x: number; y: number; sHi: number; sLo: number; zHi: number; zLo: number; }
export interface Range { s0: number; s1: number; }


// ---- geometry constants (track independent) ----
export const CAR_LEN = 1.4;
export const CAR_W = 0.62;
export const LANE_HALF = 0.5;
export const SQUEEZE_HALF = 0.2;
export const TRACK_EDGE = 0.6; // track surface extends this far beyond the lane slot

// Pit lane (on the right / outside of the main straight; every circuit's
// segment 0 is a main straight of at least ~36 units)
export const PIT_IN0 = 3, PIT_IN1 = 8;
export const BAYS = [10.5, 13.5, 16.5, 19.5];
export const BAY_HALF = 1.15;
export const FINISH_S = 23;
export const PIT_OUT0 = 25, PIT_OUT1 = 31;
export const PIT_D = -2.6;
export const BAY_D = -3.85;
export const PIT_SPEED = 8;

export interface Switch { s0: number; s1: number; }
export const SWITCH_LEN = 7;

// ---- active track state (rebuilt by setTrack) ----
export let DEF: TrackDef = TRACKS[0];
export let SEGS: Seg[] = [];
export let L = 1;
export let MAIN_LEN = 1;
export let BOUNDS: Bounds = { mnx: 0, mny: 0, mxx: 0, mxy: 0, cx: 0, cy: 0, w: 1, h: 1 };
export let SQ_SEG = 1;
export let SQ_Q0 = 0, SQ_Q1 = 0, SQ_Q2 = 0, SQ_Q3 = 0, SQ_ENTRY = 0, SQ_EXIT = 0;
export let SWITCHES: Switch[] = [];
export let ELEV: ElevKey[] = [];
export let BANKS: Bank[] = [];
export let CROSSINGS: Crossing[] = [];
/** stretches of track that sit above the ground (bridge decks and ramps) */
export let RAISED: Range[] = [];
export let MAX_Z = 0;

/** absolute track position of a segment-relative position */
export function at(p: SegPos): number {
  const g = SEGS[p[0]];
  return g.s0 + (p[1] >= 0 ? p[1] : g.len + p[1]);
}

export function setTrack(id: string): TrackDef {
  const def = TRACKS.find((d) => d.id === id) ?? TRACKS[0];
  const sol = solve(def.segs);
  const built = buildSegs(def.segs, sol.a, sol.b);
  DEF = def;
  SEGS = built.segs;
  L = built.L;
  MAIN_LEN = sol.a;
  BOUNDS = boundsOf(SEGS, L);
  // squeeze zone over the chosen sweeper
  SQ_SEG = def.squeezeSeg;
  const sq = SEGS[SQ_SEG];
  SQ_Q0 = sq.s0 - 4; SQ_Q1 = sq.s0; SQ_Q2 = sq.s0 + sq.len; SQ_Q3 = SQ_Q2 + 4;
  SQ_ENTRY = SQ_Q0 - 4; // priority is claimed here
  SQ_EXIT = SQ_Q3;
  SWITCHES = def.switches.map((p) => { const s0 = at(p); return { s0, s1: s0 + SWITCH_LEN }; });
  ELEV = elevKeys(def, SEGS);
  BANKS = (def.banked ?? []).map((b) => { const g = SEGS[b.seg]; return { s0: g.s0, s1: g.s0 + g.len, grip: b.grip, tilt: b.tilt, sign: g.sign }; });
  MAX_Z = ELEV.reduce((m, k) => Math.max(m, k.z), 0);
  // raised ranges
  RAISED = [];
  let open: Range | null = null;
  for (let s = 0; s <= L; s += 0.25) {
    const up = elevAt(ELEV, s) > 0.02;
    if (up && !open) open = { s0: s, s1: s };
    if (open) open.s1 = s;
    if (!up && open) { RAISED.push(open); open = null; }
  }
  if (open) RAISED.push(open);
  // crossings: places where the centreline passes over itself
  CROSSINGS = [];
  const pts: { s: number; x: number; y: number }[] = [];
  for (let s = 0; s < L; s += 0.5) { const c = segCenter(SEGS, s); pts.push({ s, x: c.x, y: c.y }); }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = pts[i], b = pts[j];
    if (Math.abs(gapS(a.s, b.s)) < 8) continue;
    const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    if (d2 > 0.7 * 0.7) continue;
    const za = elevAt(ELEV, a.s), zb = elevAt(ELEV, b.s);
    const hi = za >= zb ? a : b, lo = za >= zb ? b : a;
    const ex = CROSSINGS.find((c) => (c.x - a.x) ** 2 + (c.y - a.y) ** 2 < 9);
    if (ex) continue;
    CROSSINGS.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, sHi: hi.s, sLo: lo.s, zHi: Math.max(za, zb), zLo: Math.min(za, zb) });
  }
  return def;
}

/** height of the slot centreline above the mat */
export function elevZ(s: number): number { return elevAt(ELEV, wrapS(s)); }
/** banking at s: slope angle (radians, 0 when flat), grip factor and turn direction */
export function bankAt(sIn: number): { tilt: number; grip: number; sign: number } {
  const s = wrapS(sIn);
  for (const b of BANKS) {
    if (s < b.s0 || s > b.s1) continue;
    const f = bankBlend(b, s);
    return { tilt: b.tilt * f, grip: 1 + b.grip * f, sign: b.sign };
  }
  return { tilt: 0, grip: 1, sign: 0 };
}
/** cornering grip multiplier (1 everywhere except inside banked sections) */
export function gripScale(s: number): number { return bankAt(s).grip; }
/** half width of the tilted plate of a banked section (track plus kerb); outside it the ground is level */
export const BANK_HALF = LANE_HALF + TRACK_EDGE + 0.45;
/** height of the track surface at lateral offset d: banked sections keep the inner edge on the mat and raise the outer edge */
export function surfZ(s: number, d: number): number {
  const b = bankAt(s);
  if (!b.tilt) return elevZ(s);
  const dc = Math.max(-BANK_HALF, Math.min(BANK_HALF, d));
  return elevZ(s) + (BANK_HALF - b.sign * dc) * Math.tan(b.tilt);
}
/** rise per unit of track length (for ramp pitch) */
export function slopeZ(s: number): number { return (elevZ(s + 0.4) - elevZ(s - 0.4)) / 0.8; }
/** roll of the surface: positive when the left side (d > 0) is higher */
export function rollAt(s: number): number { const b = bankAt(s); return b.tilt ? -b.sign * b.tilt : 0; }
export function point3(s: number, d: number): { x: number; y: number; z: number; h: number } {
  const c = center(s);
  return { x: c.x - Math.sin(c.h) * d, y: c.y + Math.cos(c.h) * d, z: surfZ(s, d), h: c.h };
}
export function isRaised(s: number): boolean { const w = wrapS(s); return RAISED.some((r) => w >= r.s0 && w <= r.s1); }
setTrack(TRACKS[0].id);

export function wrapS(s: number): number { return ((s % L) + L) % L; }
/** signed shortest distance from a to b along the loop (b - a) */
export function gapS(a: number, b: number): number {
  let g = (b - a) % L; if (g > L / 2) g -= L; if (g < -L / 2) g += L; return g;
}
export function smooth(t: number): number { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

function segIndex(s: number): number {
  let lo = 0, hi = SEGS.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (SEGS[m].s0 <= s) lo = m; else hi = m - 1; }
  return lo;
}

export function center(sIn: number): CenterPt { return segCenter(SEGS, wrapS(sIn)); }

export function curvature(s: number): number { const g = SEGS[segIndex(wrapS(s))]; return g.kind === 'S' ? 0 : g.sign / g.R; }

export function laneHalf(sIn: number): number {
  const s = wrapS(sIn);
  if (s < SQ_Q0 || s > SQ_Q3) return LANE_HALF;
  if (s < SQ_Q1) return LANE_HALF + (SQUEEZE_HALF - LANE_HALF) * smooth((s - SQ_Q0) / (SQ_Q1 - SQ_Q0));
  if (s <= SQ_Q2) return SQUEEZE_HALF;
  return SQUEEZE_HALF + (LANE_HALF - SQUEEZE_HALF) * smooth((s - SQ_Q2) / (SQ_Q3 - SQ_Q2));
}

export function trackHalf(s: number): number { return laneHalf(s) + TRACK_EDGE; }

export function point(s: number, d: number): { x: number; y: number; h: number } {
  const c = center(s);
  return { x: c.x - Math.sin(c.h) * d, y: c.y + Math.cos(c.h) * d, h: c.h };
}

/** lateral offset of the pit lane path at s (only valid inside the pit zone) */
export function pitD(sIn: number): number {
  const s = wrapS(sIn);
  if (s < PIT_IN0) return -LANE_HALF;
  if (s < PIT_IN1) return -LANE_HALF + (PIT_D + LANE_HALF) * smooth((s - PIT_IN0) / (PIT_IN1 - PIT_IN0));
  if (s < PIT_OUT0) return PIT_D;
  if (s < PIT_OUT1) return PIT_D + (-LANE_HALF - PIT_D) * smooth((s - PIT_OUT0) / (PIT_OUT1 - PIT_OUT0));
  return -LANE_HALF;
}

export function inRange(s: number, a: number, b: number): boolean { const w = wrapS(s); return w >= a && w < b; }

/** distance ahead from s to target position t along the loop (0..L) */
export function ahead(s: number, t: number): number { return wrapS(t - s); }

// Speed profile per lane side for AI: max safe speed with braking lookahead.
export const PROFILE_STEP = 0.25;
export function buildProfile(side: number, grip: number, vmax: number, brake: number): Float32Array {
  const n = Math.ceil(L / PROFILE_STEP);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * PROFILE_STEP;
    // take worst curvature in a small window (sections change abruptly)
    let kl = 0;
    for (const o of [0, 0.4, 0.8]) {
      const k = curvature(s + o), d = side * laneHalf(s + o);
      kl = Math.max(kl, Math.abs(k / (1 - k * d)) / gripScale(s + o));
    }
    v[i] = kl > 1e-6 ? Math.min(vmax, Math.sqrt(grip / kl)) : vmax;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const nx = v[(i + 1) % n];
      const lim = Math.sqrt(nx * nx + 2 * brake * PROFILE_STEP);
      if (v[i] > lim) v[i] = lim;
    }
  }
  return v;
}
