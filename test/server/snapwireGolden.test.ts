// #168 golden test: the snapshot wire's encoder and decoder were rewritten without JSON text (compare, copy) for speed. The
// wire must not change at all: a recorded multi-lap race (pits, offs, tows, lane changes, a stopped-car recovery, the final
// results) is run through the encoder and decoder as of a680f7f (vendored, test-only: ./snapwire.main.ts) and through the
// current ones. Every message must be the same string, every resume keyframe too, and every decoded state the same,
// key order included. Then the guarantees the deep copies gave: a caller that changes a decoded state cannot corrupt the
// decoder's base, and a race snapshot changed after encoding cannot corrupt the encoder's.
import { describe, it, expect } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { Race, type RaceSnapshot } from '../../src/race';
import { STEP } from '../../src/timing';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { SnapDecoder, SnapEncoder, type StateFrame, type WireStateMsg } from '../../src/net/snapwire';
import * as Main from './snapwire.main';
import { drive } from './bot';

/** A whole race as the room server publishes it (one snapshot every 3 steps), with human pit stops, lane changes, offs and a stall. */
function recordRace(seed: number, track: string): { tick: number; snap: RaceSnapshot }[] {
  const roster = [
    { id: 'h_a', control: 'human' as const, slot: 0, name: 'Ann' }, { id: 'h_b', control: 'human' as const, slot: 2, name: 'Bob' },
    { id: 'ai_1', control: 'ai' as const, slot: 1 }, { id: 'ai_3', control: 'ai' as const, slot: 3 },
  ];
  const race = new Race({ roster, track, seed, runOn: 'live' });
  const frames: { tick: number; snap: RaceSnapshot }[] = [];
  let seq = 0, parkFrom = -1;
  for (let tick = 1; tick < 60 * 600 && !race.final; tick++) {
    const s = race.snapshot();
    const a = drive(s, 'h_a', 1), b = drive(s, 'h_b', 0.93);
    if (a.pit) race.act({ driver: 'h_a', seq: ++seq, type: 'pit' });
    if (tick % 1500 === 0) race.act({ driver: 'h_b', seq: ++seq, type: 'lane' });
    const fast = tick % 4000 > 3700;   // too fast on a slow lap: offs and tows
    if (parkFrom < 0 && tick >= 8000 && s.cars.find((c) => c.id === 'h_b')!.mode === 'race') parkFrom = tick;
    const parked = parkFrom > 0 && tick < parkFrom + 600;   // stopped on the racing lane: a #69 recovery
    race.update(STEP, { h_a: a, h_b: parked ? { up: false, down: false } : fast ? { up: true, down: false } : b });
    if (tick % 3 === 0 || race.final) frames.push({ tick, snap: race.snapshot() });
  }
  expect(race.final).not.toBe(null);
  return frames;
}

const msgOf = (tick: number, f: StateFrame): string => JSON.stringify({ t: 'state', tick, now: 0, lagMs: 0, ev: [], ...f });
/** Decoded output with its key order: toEqual ignores order, the text does not. */
const text = (s: unknown): string => JSON.stringify(s);

describe('snapshot wire #168: same bytes and same states as before the rewrite', () => {
  const races = [recordRace(11, 'circuit-3'), recordRace(5, 'circuit-1')];

  it('protocol is still v2', () => expect(PROTOCOL_VERSION).toBe(2));

  it('recorded races: every message, every resume keyframe and every decoded state match the a680f7f encoder and decoder', () => {
    const seen = { off: 0, change: 0, service: 0, tow: 0, final: 0, deltas: 0, keyframes: 0 };
    for (const frames of races) {
      const encNew = new SnapEncoder('race-1'), encOld = new Main.SnapEncoder('race-1');
      const decNew = new SnapDecoder(), decOld = new Main.SnapDecoder();
      frames.forEach((f, i) => {
        const at = f.tick * STEP * 1000;
        const a = msgOf(f.tick, encNew.next(f.snap, f.tick, at)), b = msgOf(f.tick, encOld.next(f.snap, f.tick, at));
        expect(a).toBe(b);
        const m = JSON.parse(a) as WireStateMsg;
        if (m.key) seen.keyframes++; else seen.deltas++;
        const got = decNew.decode(m), want = decOld.decode(JSON.parse(a) as Main.WireStateMsg);
        expect(got).not.toBe(null);
        expect(text(got)).toBe(text(want));
        expect(got).toStrictEqual(want);
        expect(isDeepStrictEqual(got, want)).toBe(true);
        if (i % 97 === 0) {
          const rn = encNew.resume()!, ro = encOld.resume()!;
          expect(rn.tick).toBe(ro.tick);
          expect(msgOf(rn.tick, rn.frame)).toBe(msgOf(ro.tick, ro.frame));
        }
        for (const c of f.snap.cars) {
          if (c.off) seen.off++;
          if (c.change) seen.change++;
          if (c.mode === 'service') seen.service++;
          if (c.towT > 0) seen.tow++;
        }
        if (f.snap.final) seen.final++;
      });
      expect(decNew.stats).toEqual(decOld.stats);
      expect(encNew.stats).toEqual(encOld.stats);
    }
    // the races exercised what the wire carries
    expect(seen.off).toBeGreaterThan(0); expect(seen.change).toBeGreaterThan(0); expect(seen.service).toBeGreaterThan(0);
    expect(seen.tow).toBeGreaterThan(0); expect(seen.final).toBe(2);
    expect(seen.deltas).toBeGreaterThan(seen.keyframes * 15);
  });

  it('odd inputs JSON treats specially (-0, NaN, undefined, null-prototype tables, key order, optional fields) give the same bytes and states', () => {
    const base = races[0][300].snap;
    const off = { x: 1, y: -0.00001, vx: 0.25, vy: 2, yaw: 0, spin: 0, t: 0, z: 0, vz: 0, u0: 0, lane: 1 };
    const offReordered = { lane: 1, x: 1, y: -0.00001, vx: 0.25, vy: 2, yaw: 0, spin: 0, t: 0, z: 0, vz: 0, u0: 0 };
    // in sequence, each from the same base: repeats matter (a value JSON writes the same way as the last one is not resent)
    const variants: ((s: RaceSnapshot) => void)[] = [
      () => {},
      (s) => { s.cars[0].off = { ...off }; },
      (s) => { s.cars[0].off = { ...offReordered }; },   // same values, other key order: JSON differs, so it is resent
      (s) => { s.cars[0].off = { ...offReordered }; },
      (s) => { s.cars[0].off = { ...off, vx: NaN }; },
      (s) => { s.cars[0].off = { ...off, vx: NaN }; },   // NaN === NaN in JSON (null)
      (s) => { s.cars[0].off = { ...off, vx: null as unknown as number }; },   // and null too
      (s) => { s.cars[0].off = { ...off, vx: Infinity }; },
      (s) => { (s.cars[0] as unknown as Record<string, unknown>).lastLap = -0; s.cars[1].u = -0.0001; },
      (s) => { s.cars[0].lastLap = NaN; s.cars[2].bestLap = Infinity; s.cars[1].u = -0.0001; },
      (s) => { s.cars[0].lastLap = NaN; s.cars[2].bestLap = -0; },
      (s) => { s.pit.bays = [undefined as unknown as null, 'h_a', null, null]; },
      (s) => { s.pit.bays = [null, 'h_a', null, null]; },
      (s) => { s.lastSeq = Object.assign(Object.create(null) as Record<string, number>, { h_b: 2, h_a: 9 }); },
      (s) => { s.lastSeq = { h_b: 2, h_a: 9 }; },
      (s) => { s.lastSeq = { h_a: 9, h_b: 2 }; },
      (s) => { s.lastSeq = { h_a: 9 }; },
      (s) => { s.cars[2].away = true; s.cars[3].stallT = undefined; },
      (s) => { s.cars[0].change = { from: -1, to: 1, s0: 0.5, s1: NaN }; s.finishWindow = NaN as unknown as null; },
      (s) => { s.cars[0].change = { from: -1, to: 1, s0: 0.5, s1: NaN }; s.finishWindow = NaN as unknown as null; },
      (s) => { s.cars[1].h = NaN; s.t = -0; },
      (s) => { s.cars[1].h = NaN; s.t = -0; },
      () => {},
    ];
    const encNew = new SnapEncoder('r'), encOld = new Main.SnapEncoder('r');
    const decNew = new SnapDecoder(), decOld = new Main.SnapDecoder();
    let deleted = 0;
    variants.forEach((v, i) => {
      const s = structuredClone(base); v(s);
      const fn = encNew.next(s, i + 1, i * 50), fo = encOld.next(s, i + 1, i * 50);
      expect(msgOf(i + 1, fn)).toBe(msgOf(i + 1, fo));
      if (msgOf(i + 1, fn).includes('"-":')) deleted++;
      // fed as frames, not text (as a test or a headless tool may): the decoders must still agree
      const got = decNew.decode({ ...fn, tick: i + 1 }), want = decOld.decode({ ...fo, tick: i + 1 } as Main.WireStateMsg);
      expect(text(got)).toBe(text(want));
      expect(got).toStrictEqual(want);
      expect(isDeepStrictEqual(got, want), `variant ${i}: -0, NaN and prototypes too`).toBe(true);
      expect(msgOf(i + 1, encNew.resume()!.frame)).toBe(msgOf(i + 1, encOld.resume()!.frame));
    });
    expect(deleted).toBeGreaterThan(0);   // an optional field that went away travelled as DELETED
  });

  it('a caller that changes a decoded state (deeply) never corrupts the decoder: later deltas still decode right', () => {
    const frames = races[0];
    const enc = new SnapEncoder('r'), dec = new SnapDecoder(), ref = new SnapDecoder();
    let mutated = 0;
    frames.slice(0, 2500).forEach((f, i) => {
      const s = msgOf(f.tick, enc.next(f.snap, f.tick, f.tick * STEP * 1000));
      const got = dec.decode(JSON.parse(s) as WireStateMsg)!, want = ref.decode(JSON.parse(s) as WireStateMsg)!;
      expect(got).toStrictEqual(want);
      // scribble over everything a consumer could touch: race fields, nested tables, car fields and their objects
      got.t = -1; got.phase = 'grid' as RaceSnapshot['phase']; got.pit.bays.fill('x'); got.pit.order.push('x'); got.pit.box = 'x';
      (got.lastSeq as Record<string, number>).h_a = -5;
      if (got.final) got.final[0].id = 'x';
      for (const c of got.cars) {
        c.u = -1; c.status = 'dq'; c.name = 'x'; delete (c as Partial<typeof c>).stallT;
        if (c.off) { c.off.x = 1e9; mutated++; }
        if (c.change) { c.change.to = 99; mutated++; }
      }
      got.cars.pop();
      if (i % 50 === 0) mutated++;
    });
    expect(mutated).toBeGreaterThan(50);
    expect(dec.stats).toEqual(ref.stats);
    expect(dec.stats.gaps).toBe(0);
  });

  it('a race snapshot changed after it was encoded never changes the encoder\'s next delta', () => {
    const frames = races[0];
    const enc = new SnapEncoder('r'), ref = new Main.SnapEncoder('r');
    for (const f of frames.slice(0, 1500)) {
      const live = structuredClone(f.snap);
      const a = msgOf(f.tick, enc.next(live, f.tick, f.tick * STEP * 1000));
      expect(a).toBe(msgOf(f.tick, ref.next(f.snap, f.tick, f.tick * STEP * 1000)));
      // the room drops its snapshot after encoding; if anything reused it, the baseline must not follow
      live.t = 0; live.pit.bays.fill(null); live.pit.order.length = 0; live.cars[0].u = 0; (live.cars[0] as unknown as Record<string, unknown>).setup = 'x';
      for (const c of live.cars) { if (c.off) c.off.x = 0; if (c.change) c.change.s1 = 0; }
      if (live.final) live.final.length = 0;
    }
  });
});
