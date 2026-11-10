// Tick statistics (#54): reports keep the true tick peaks and percentiles. The decayed tickMaxMs forgot a 20 ms tick within
// 2 s of normal ticks (20.2 -> 0.36 ms), so a load check polling health every 2 s reported a misleadingly small worst tick.
// Every duration here comes from an injected clock: deterministic, no wall-time assertions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testConfig } from '../../server/config';
import { createApp } from '../../server/app';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { DurationStats, Histogram } from '../../server/tickstats';
import { workloadDurations, diffBuckets, bucketPercentile } from '../../scripts/tick-report.mjs';
import { FakePeer } from './harness';

/** A manager on fake clocks: `wall` (rooms, rolling window) and `mono` (tick timing), advanced by hand. */
function rig() {
  const c = { wall: Date.UTC(2026, 10, 10, 12, 0, 0), mono: 1000 };
  const mgr = new RoomManager({ cfg: testConfig(), log: memoryLogger(), sink: new MemoryResultSink(), seed: () => 7, now: () => c.wall, clock: () => c.mono });
  const r = mgr.create(new FakePeer(), { name: 'Host', accountId: null, mode: 'solo', settings: {} });
  if (!r.ok) throw new Error(r.code);
  // every pump "costs" `cost` ms of monotonic time; one can be made slow
  let cost = 0.3, slowOnce = 0;
  const pump = r.room.pump.bind(r.room);
  r.room.pump = (n: number) => { c.mono += slowOnce || cost; slowOnce = 0; pump(n); };
  /** one 10 ms tick, as the timer would run it */
  const tick = () => { c.wall += 10; mgr.tick(); };
  return { c, mgr, room: r.room, tick, spike: (ms: number) => { slowOnce = ms; }, setCost: (ms: number) => { cost = ms; } };
}

type Health = Record<string, unknown> & { tickMaxMs: number; tickLoadMs: number; cpuUserMs: number; cpuSystemMs: number; ticks: Report; tickLag: Report };
interface Summary { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; meanMs: number; sumMs: number }
interface Report { unit: string; windowS: number; recent: Summary; total: Summary; totalBuckets: [number, number][] }

async function readHealth(mgr: RoomManager): Promise<Health> {
  const app = createApp({ cfg: testConfig({ port: 0 }), log: memoryLogger(), manager: mgr });
  const { port } = await app.listen();
  try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as Health; } finally { await app.close(); }
}

describe('tick peaks and percentiles in health (#54)', () => {
  it('a 20 ms tick followed by 200 normal ticks (one 2 s poll gap) is still reported with its exact maximum', async () => {
    const { mgr, tick, spike } = rig();
    spike(20); tick();
    for (let i = 0; i < 200; i++) tick();
    const h = await readHealth(mgr);
    // the defect: the only tick figure was a decayed load signal; it keeps its name and meaning, and is no peak
    expect(h.tickMaxMs).toBeLessThan(1);
    expect(h.tickLoadMs).toBeLessThan(1);
    expect(h.ticks.unit).toBe('ms');
    expect(h.ticks.recent).toMatchObject({ count: 201, maxMs: 20 });
    expect(h.ticks.total).toMatchObject({ count: 201, maxMs: 20 });
    // 200 of 201 ticks took 0.3 ms: p50/p95 are that bucket's upper bound (never below, at most ~9% above), p99 likewise
    for (const p of [h.ticks.recent.p50Ms, h.ticks.recent.p95Ms, h.ticks.recent.p99Ms]) { expect(p).toBeGreaterThanOrEqual(0.3); expect(p).toBeLessThan(0.3 * 1.1); }
    expect(h.ticks.total.meanMs).toBeCloseTo((20 + 200 * 0.3) / 201, 3);
  });

  it('a spike between two polls appears in the next poll and in the workload report, never as a decayed value', async () => {
    const { mgr, tick, spike } = rig();
    for (let i = 0; i < 50; i++) tick();
    const h0 = await readHealth(mgr);
    const polls: Health[] = [];
    for (let poll = 0; poll < 5; poll++) {
      for (let i = 0; i < 200; i++) { if (poll === 2 && i === 37) spike(42.5); tick(); }
      polls.push(await readHealth(mgr));
    }
    expect(polls[1].ticks.recent.maxMs).toBe(0.3);
    expect(polls[2].ticks.recent.maxMs).toBe(42.5);   // the poll right after the spike
    expect(polls[4].ticks.recent.maxMs).toBe(42.5);   // still in the 50-60 s window 4 s later
    const w = workloadDurations('ticks', h0, polls.slice(0, -1), polls.at(-1))!;
    expect(w).toMatchObject({ count: 1000, maxMs: 42.5 });
    expect(w.p99Ms).toBeLessThan(0.33);   // one slow tick in 1000 is above p99
    expect(w.meanMs).toBeCloseTo((999 * 0.3 + 42.5) / 1000, 3);
    // what the old report did, the max of the decayed tickMaxMs over the polls, had lost 96% of it
    expect(Math.max(...polls.map((h) => h.tickMaxMs))).toBeLessThan(2);
  });

  it('p95/p99 follow the slow tail exactly enough to report it (2% of ticks at 8 ms)', () => {
    const { mgr, tick, spike } = rig();
    for (let i = 0; i < 1000; i++) { if (i % 50 === 0) spike(8); tick(); }
    const s = mgr.ticks.recent().summary();
    expect(s.count).toBe(1000);
    expect(s.p95Ms).toBeLessThan(0.33);
    expect(s.p99Ms).toBe(8);   // the bucket bound is capped at the exact max
    expect(s.maxMs).toBe(8);
  });

  it('the recent window ages out by wall time (no rooms, no ticks); totals and admission behave as before', () => {
    const { c, mgr, room, tick, spike } = rig();
    spike(60); tick();
    expect(mgr.tickLoadMs).toBe(60);
    // the admission signal is unchanged: a 60 ms tick still refuses new rooms
    expect(mgr.create(new FakePeer(), { name: 'B', accountId: null, mode: 'solo', settings: {} })).toMatchObject({ ok: false, code: 'overloaded' });
    room.close('test');
    tick();   // no rooms: nothing is pumped and nothing recorded
    expect(mgr.ticks.total.count).toBe(1);
    c.wall += 49_000;
    expect(mgr.ticks.recent().maxMs).toBe(60);   // at least 50 s in the window
    c.wall += 11_000;
    expect(mgr.ticks.recent().count).toBe(0);    // at most 60 s
    expect(mgr.ticks.total.maxMs).toBe(60);      // the process total keeps it
  });
});

describe('tick timer lateness (event-loop delay) (#54)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('records how late each timer tick starts, and never counts an idle gap with the timer stopped', () => {
    const mgr = new RoomManager({ cfg: testConfig(), log: memoryLogger(), sink: new MemoryResultSink(), seed: () => 7, clock: () => Date.now() });
    mgr.start();
    const a = mgr.create(new FakePeer(), { name: 'A', accountId: null, mode: 'multiplayer', settings: {} }); if (!a.ok) throw new Error(a.code);
    vi.advanceTimersByTime(100);
    expect(mgr.tickLag.total).toMatchObject({ count: 9, maxMs: 0 });   // the first timer tick has no predecessor
    vi.setSystemTime(Date.now() + 250);   // the process stalled: the next tick starts 250 ms late
    vi.advanceTimersByTime(10);
    expect(mgr.tickLag.recent().maxMs).toBe(250);
    a.room.close('test');
    expect(mgr.running).toBe(false);
    vi.setSystemTime(Date.now() + 30_000);
    const b = mgr.create(new FakePeer(), { name: 'B', accountId: null, mode: 'multiplayer', settings: {} }); if (!b.ok) throw new Error(b.code);
    vi.advanceTimersByTime(20);
    expect(mgr.tickLag.total.maxMs).toBe(250);   // the 30 s with no timer is not lag
    expect(mgr.tickLag.total.count).toBe(11);
    mgr.shutdown();
  });
});

describe('bounded collectors (#54)', () => {
  it('memory is fixed whatever the sample count, and the recent ring never grows', () => {
    let wall = 0;
    const d = new DurationStats(() => wall);
    const len = d.total.counts.length;
    for (let i = 0; i < 200_000; i++) { wall += 10; d.record((i % 997) * 0.01); }
    expect(d.total.counts.length).toBe(len);
    expect(len).toBeLessThanOrEqual(256);
    expect(d.total.count).toBe(200_000);
    expect(d.recent().count).toBeLessThanOrEqual(6000);   // 60 s of 10 ms samples at most
    expect(d.recent().count).toBeGreaterThanOrEqual(5000);
    expect(d.total.buckets().length).toBeLessThanOrEqual(len);
  });

  it('percentiles are never below the true value and at most ~9% above it; the max is exact', () => {
    const h = new Histogram();
    const xs = Array.from({ length: 10_000 }, (_, i) => 0.05 + ((i * 7919) % 10_000) / 1000);
    for (const x of xs) h.record(x);
    const sorted = [...xs].sort((a, b) => a - b);
    for (const p of [0.5, 0.95, 0.99]) {
      const exact = sorted[Math.ceil(p * xs.length) - 1];
      expect(h.percentile(p)).toBeGreaterThanOrEqual(exact);
      expect(h.percentile(p)).toBeLessThanOrEqual(exact * 1.0906);
    }
    expect(h.maxMs).toBe(sorted.at(-1));
    h.record(NaN); h.record(-1);
    expect(h.count).toBe(10_000);
  });

  it('bucket differences give an interval its exact sample counts', () => {
    const h = new Histogram();
    for (let i = 0; i < 100; i++) h.record(0.2);
    const a = h.buckets();
    for (let i = 0; i < 10; i++) h.record(5);
    const d = diffBuckets(a, h.buckets());
    expect(d.reduce((s: number, [, n]: [number, number]) => s + n, 0)).toBe(10);
    expect(bucketPercentile(d, 0.5, 5)).toBe(5);
    expect(bucketPercentile([], 0.5)).toBe(0);
  });
});
