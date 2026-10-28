// Shared helpers for the regression suite: deterministic randomness, a
// localStorage double, and scripted race setups that bypass the countdown.
import { vi } from 'vitest';
import * as T from '../src/track';
import { Race, Car, RaceEvent, Input } from '../src/race';

export const NONE: Input = { up: false, down: false };
export const UP: Input = { up: true, down: false };
export const DT = 1 / 60;

/** Replace Math.random with a seeded generator (mulberry32). Restore with vi.restoreAllMocks(). */
export function seedRandom(seed = 1): void {
  let a = seed >>> 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/** In-memory Storage implementation; install with vi.stubGlobal('localStorage', memStorage()). */
export function memStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

/** A race already under way on the given circuit, every car AI-driven and out of its start grace. */
export function fresh(track = 'circuit-1', opts: { practice?: boolean } = {}): Race {
  T.setTrack(track);
  const r = new Race(opts);
  r.phase = 'racing'; r.t = 10; r.raceTime = 5;
  for (const c of r.cars) { c.mode = 'race'; c.graceT = 0; c.isPlayer = false; c.pitPlan = false; }
  return r;
}

export function place(c: Car, u: number, side: number, v: number): void {
  c.u = u; c.laneSide = side; c.d = side * T.LANE_HALF; c.v = v; c.change = null; c.mode = 'race'; c.throttle = 0;
}

/** Park every car far apart, step twice so per-pair contact state clears, drop the events. */
export function park(r: Race): void {
  for (const c of r.cars) place(c, 100 + c.idx * 8, 1, 0);
  r.update(DT, NONE); r.update(DT, NONE);
  r.events.length = 0;
  for (const c of r.cars) c.v = 0;
}

export function stepEvents(r: Race, n = 1, input: Input = NONE): RaceEvent[] {
  const ev: RaceEvent[] = [];
  for (let i = 0; i < n; i++) { r.update(DT, input); ev.push(...r.events); r.events.length = 0; }
  return ev;
}

export const offences = (ev: RaceEvent[]): Extract<RaceEvent, { type: 'offence' }>[] =>
  ev.filter((e): e is Extract<RaceEvent, { type: 'offence' }> => e.type === 'offence');

export const msgs = (ev: RaceEvent[]): string[] =>
  ev.filter((e): e is Extract<RaceEvent, { type: 'msg' }> => e.type === 'msg').map((e) => e.text);
