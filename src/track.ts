// Track layout: classic slot-car sections (straights + constant-radius arcs).
// 2D coordinates: x east, y north. Heading h in radians, CCW positive.
// Lateral offset d is measured along the LEFT normal.

type SegDef = ['S', number | 'A' | 'B'] | ['A', number, number];

const DEF: SegDef[] = [
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
];

export interface Seg { kind: 'S' | 'A'; len: number; R: number; sign: number; s0: number; x0: number; y0: number; h0: number; }
export interface CenterPt { x: number; y: number; h: number; k: number; }

function buildSegs(a: number, b: number): { segs: Seg[]; end: { x: number; y: number; h: number }; L: number } {
  let x = 0, y = 0, h = 0, s = 0;
  const segs: Seg[] = [];
  for (const d of DEF) {
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

function solve(): { a: number; b: number } {
  const e0 = buildSegs(0, 0).end, ea = buildSegs(1, 0).end, eb = buildSegs(0, 1).end;
  const ax = ea.x - e0.x, ay = ea.y - e0.y, bx = eb.x - e0.x, by = eb.y - e0.y;
  const det = ax * by - ay * bx;
  return { a: (-e0.x * by + e0.y * bx) / det, b: (-ax * e0.y + ay * e0.x) / det };
}

const SOL = solve();
const BUILT = buildSegs(SOL.a, SOL.b);
export const SEGS = BUILT.segs;
export const L = BUILT.L;
export const MAIN_LEN = SOL.a;

// ---- geometry constants ----
export const CAR_LEN = 1.4;
export const CAR_W = 0.62;
export const LANE_HALF = 0.5;
export const SQUEEZE_HALF = 0.2;
export const TRACK_EDGE = 0.6; // track surface extends this far beyond the lane slot

// Squeeze zone over the first sweeper (segment 1)
export const SQ_Q0 = SEGS[1].s0 - 4;
export const SQ_Q1 = SEGS[1].s0;
export const SQ_Q2 = SEGS[1].s0 + SEGS[1].len;
export const SQ_Q3 = SQ_Q2 + 4;
export const SQ_ENTRY = SQ_Q0 - 4; // priority is claimed here
export const SQ_EXIT = SQ_Q3;

// Lane switching sections
export interface Switch { s0: number; s1: number; }
export const SWITCHES: Switch[] = [
  { s0: SEGS[2].s0 + 8, s1: SEGS[2].s0 + 15 },
  { s0: SEGS[2].s0 + 31, s1: SEGS[2].s0 + 38 },
  { s0: SEGS[6].s0 + 12, s1: SEGS[6].s0 + 19 },
  { s0: SEGS[11].s0 + 0.5, s1: SEGS[11].s0 + 7.5 },
];

// Pit lane (on the right / outside of the main straight)
export const PIT_IN0 = 3, PIT_IN1 = 8;
export const BAYS = [10.5, 13.5, 16.5, 19.5];
export const BAY_HALF = 1.15;
export const FINISH_S = 23;
export const PIT_OUT0 = 25, PIT_OUT1 = 31;
export const PIT_D = -2.6;
export const BAY_D = -3.85;
export const PIT_SPEED = 8;

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

export function center(sIn: number): CenterPt {
  const s = wrapS(sIn);
  const g = SEGS[segIndex(s)];
  const t = s - g.s0;
  if (g.kind === 'S') return { x: g.x0 + Math.cos(g.h0) * t, y: g.y0 + Math.sin(g.h0) * t, h: g.h0, k: 0 };
  const h = g.h0 + (g.sign * t) / g.R;
  return {
    x: g.x0 + g.sign * g.R * (Math.sin(h) - Math.sin(g.h0)),
    y: g.y0 - g.sign * g.R * (Math.cos(h) - Math.cos(g.h0)),
    h, k: g.sign / g.R,
  };
}

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

export const BOUNDS = (() => {
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (let s = 0; s < L; s += 0.5) {
    const c = center(s);
    mnx = Math.min(mnx, c.x); mxx = Math.max(mxx, c.x); mny = Math.min(mny, c.y); mxy = Math.max(mxy, c.y);
  }
  return { mnx, mny, mxx, mxy, cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2, w: mxx - mnx, h: mxy - mny };
})();

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
      kl = Math.max(kl, Math.abs(k / (1 - k * d)));
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
