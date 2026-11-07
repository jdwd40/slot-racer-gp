// The numbers the browser validation reports, and the rule that a software renderer can never pass the goal.
import { describe, it, expect } from 'vitest';
import { accelerationOf, assessGoal, comparisonGaps, percentile, summarise, CLOCK_TOLERANCE_SEC, GOAL } from '../scripts/frame-stats.mjs';

type Screen = 'title' | 'race' | 'pause' | 'results';
type Phase = 'countdown' | 'racing' | 'done';
interface Row { ts: number; screen: Screen; phase: Phase; raceTime: number; dropped: number | null; }

/** Append `n` frames `gap` ms apart; the race clock runs only when `racing`. */
function run(rows: Row[], n: number, gap: number, screen: Screen, phase: Phase, racing = false): void {
  for (let i = 0; i < n; i++) {
    const p = rows[rows.length - 1] ?? { ts: 0, raceTime: 0, dropped: 0 };
    rows.push({ ts: p.ts + gap, screen, phase, raceTime: p.raceTime + (racing ? gap / 1000 : 0), dropped: p.dropped });
  }
}

/** A clean hardware-style sample: `sec` seconds of 60 FPS racing. */
function smooth(sec: number): Row[] {
  const rows: Row[] = [];
  run(rows, 60 * sec, 1000 / 60, 'race', 'racing', true);
  return rows;
}

describe('summarise', () => {
  it('counts only racing gaps as active and reports countdowns and pauses separately', () => {
    const rows: Row[] = [];
    run(rows, 10, 100, 'title', 'countdown');
    run(rows, 50, 100, 'race', 'countdown');
    run(rows, 100, 20, 'race', 'racing', true);
    run(rows, 30, 100, 'pause', 'racing');
    run(rows, 101, 20, 'race', 'racing', true);
    run(rows, 5, 100, 'results', 'done');
    const s = summarise(rows);
    expect(s.active.frames).toBe(199);
    expect(s.active.wallSec).toBeCloseTo(3.98, 3);
    expect(s.active.raceSec).toBeCloseTo(3.98, 3);
    expect(s.active.frameMs.median).toBe(20);
    // the gap from the last countdown frame to the first racing frame is not active time
    expect(s.countdownSec).toBeCloseTo(5.02, 3);
    expect(s.pauses.count).toBe(1);
    expect(s.pauses.wallSec).toBeCloseTo(3.02, 2);
    expect(s.measurementSec).toBeCloseTo((rows[rows.length - 1].ts - rows[0].ts) / 1000, 3);
  });

  it('reports stutter from the gaps, not the average', () => {
    const rows = smooth(10);
    for (const i of [100, 200, 300]) for (let j = i; j < rows.length; j++) rows[j].ts += 80;
    const a = summarise(rows).active;
    expect(a.frameMs.median).toBeCloseTo(16.7, 1);
    expect(a.gapsOver50).toBe(3);
    expect(a.frameMs.max).toBeGreaterThan(90);
  });

  it('explains a stall by the dropped time, and exposes a clock that lost time without dropping it', () => {
    const rows: Row[] = [];
    run(rows, 10, 100, 'race', 'racing', true);
    // the 250 ms rule on a 1 s gap: 0.25 s raced, 0.75 s dropped
    const p = rows[rows.length - 1];
    rows.push({ ...p, ts: p.ts + 1000, raceTime: p.raceTime + 0.25, dropped: 0.75 });
    const a = summarise(rows).active;
    expect(a.droppedSec).toBeCloseTo(0.75, 3);
    expect(Math.abs(a.clockErrorSec!)).toBeLessThan(CLOCK_TOLERANCE_SEC);
    expect(a.gapsOver250).toBe(1);

    const slow = rows.map((r) => ({ ...r, raceTime: r.raceTime * 0.5, dropped: 0 }));
    expect(summarise(slow).active.clockErrorSec!).toBeLessThan(-CLOCK_TOLERANCE_SEC);
  });

  it('leaves the clock check empty for a build without the stepper', () => {
    const rows = smooth(1).map((r) => ({ ...r, dropped: null }));
    const a = summarise(rows).active;
    expect(a.droppedSec).toBeNull();
    expect(a.clockErrorSec).toBeNull();
    expect(a.raceSec).toBeGreaterThan(0.9);
  });

  it('survives an empty trace', () => {
    expect(summarise([]).active.frames).toBe(0);
    expect(summarise([]).active.frameMs.median).toBeNull();
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('acceleration and the goal', () => {
  it('recognises software renderers', () => {
    expect(accelerationOf('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('software');
    expect(accelerationOf('llvmpipe (LLVM 15.0.6, 256 bits)')).toBe('software');
    expect(accelerationOf('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)')).toBe('software');
    expect(accelerationOf('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)')).toBe('hardware');
    expect(accelerationOf('')).toBe('unavailable');
  });

  it('never lets a software run meet the goal, however good its numbers', () => {
    const s = summarise(smooth(GOAL.minActiveSec + 5));
    expect(assessGoal(s, 'software').status).toBe('unavailable');
    expect(assessGoal(s, 'unavailable').status).toBe('unavailable');
    expect(assessGoal(s, 'hardware').status).toBe('met');
  });

  it('needs a long enough sample', () => {
    expect(assessGoal(summarise(smooth(10)), 'hardware').status).toBe('unavailable');
  });

  it('fails each limit on its own', () => {
    const withHitches = (n: number, ms: number): Row[] => {
      const rows = smooth(GOAL.minActiveSec + 5);
      for (let k = 1; k <= n; k++) { const at = Math.floor((k * rows.length) / (n + 1)); for (let j = at; j < rows.length; j++) rows[j].ts += ms; }
      return rows;
    };
    const hitchy = assessGoal(summarise(withHitches(4, 60)), 'hardware');
    expect(hitchy.status).toBe('not met');
    expect(hitchy.reasons.join()).toContain('gaps over 50 ms');
    const missedVsync = assessGoal(summarise(withHitches(600, 16.7)), 'hardware');
    expect(missedVsync.status).toBe('not met');
    expect(missedVsync.reasons.join()).toContain('p95');
  });
});

describe('comparisonGaps', () => {
  const env = { machine: 'A', os: 'L', browser: 'C', renderer: 'R', viewport: { width: 1, height: 2 }, dpr: 1, drawingBuffer: { width: 1, height: 2 }, track: 'circuit-1', car: 'sunburst', camera: 'follow', workload: 'w', preset: 'balanced' };
  it('accepts a matching pair even though the baseline has no preset', () => {
    expect(comparisonGaps({ environment: env }, { environment: { ...env, preset: 'none' } })).toEqual([]);
  });
  it('names what differs', () => {
    expect(comparisonGaps({ environment: env }, { environment: { ...env, machine: 'B', drawingBuffer: { width: 2, height: 2 } } })).toEqual(['machine', 'drawingBuffer']);
  });
});
