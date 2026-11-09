// The room tick timer runs only while rooms exist (no idle wakeups), and restarting it never changes race timing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STEP } from '../../src/timing';
import { testConfig, type Config } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { FakePeer } from './harness';

function manager(over: Partial<Config> = {}) {
  const sink = new MemoryResultSink();
  // the default clock (Date.now), which the fake timers drive: ticks come only from the real interval
  return { mgr: new RoomManager({ cfg: testConfig(over), log: memoryLogger(), sink, seed: () => 7 }), sink };
}
function create(mgr: RoomManager, mode: 'multiplayer' | 'solo' = 'multiplayer', name = 'P0') {
  return mgr.create(new FakePeer(), { name, accountId: null, mode, settings: { track: 'circuit-4' } });
}

describe('room tick timer lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 9, 12, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('is idle with no rooms, starts once with the first room and stops with the last', () => {
    const { mgr } = manager();
    mgr.start(); mgr.start();
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const a = create(mgr); if (!a.ok) throw new Error(a.code);
    expect(mgr.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    mgr.start();
    const b = create(mgr); if (!b.ok) throw new Error(b.code);
    expect(vi.getTimerCount()).toBe(1);
    const tick = vi.spyOn(mgr, 'tick');
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(10);   // one 10 ms interval
    a.room.close('test');
    expect(mgr.running).toBe(true);
    b.room.close('test');
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('a manager that was never started creates rooms without a timer (manual-tick tests)', () => {
    const { mgr } = manager();
    expect(create(mgr).ok).toBe(true);
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('failed creation or a failed creator join leaves no timer running', () => {
    const { mgr } = manager();
    mgr.start();
    expect(mgr.create(new FakePeer(), { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'nope' } })).toMatchObject({ ok: false, code: 'bad_settings' });
    expect(mgr.running).toBe(false);
    expect(create(mgr, 'multiplayer', '   ')).toMatchObject({ ok: false, code: 'malformed' });
    expect(mgr.size).toBe(0);
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when the last room closes during a tick, or after a fault', () => {
    const { mgr } = manager({ lobbyIdleS: 10 });
    mgr.start();
    const a = create(mgr); if (!a.ok) throw new Error(a.code);
    vi.advanceTimersByTime(11_000);   // the lobby idles out inside a tick
    expect(a.room.state).toBe('closed');
    expect(mgr.running).toBe(false);

    const b = create(mgr); if (!b.ok) throw new Error(b.code);
    expect(mgr.running).toBe(true);
    vi.spyOn(b.room, 'pump').mockImplementation(() => { throw new Error('boom'); });
    vi.advanceTimersByTime(10);
    expect(b.room.state).toBe('closed');
    expect(mgr.size).toBe(0);
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a race created after a long idle period has no catch-up burst; a delayed tick still catches up exactly', () => {
    const { mgr } = manager({ maxCatchUpSteps: 6, overloadAbortMs: 3000 });
    mgr.start();
    const first = create(mgr); if (!first.ok) throw new Error(first.code);
    vi.advanceTimersByTime(500);
    first.room.close('test');
    expect(mgr.running).toBe(false);
    vi.advanceTimersByTime(3_600_000);   // an hour with no rooms

    const s = create(mgr, 'solo'); if (!s.ok) throw new Error(s.code);
    vi.advanceTimersByTime(200);   // lobby time before the start is not race time either
    s.room.handle(s.participant, { t: 'start' }, Date.now());
    const t0 = Date.now();
    const race = s.room.race!;
    const owed = () => Math.floor((Date.now() - t0) / 1000 / STEP + 1e-9);
    vi.advanceTimersByTime(10);
    expect(race.t).toBeCloseTo(owed() * STEP, 9);
    expect(race.t).toBeLessThan(0.02);
    expect(s.room.lagMs).toBe(0);
    vi.advanceTimersByTime(990);
    expect(race.t).toBeCloseTo(owed() * STEP, 9);
    expect(race.t).toBeCloseTo(1, 9);

    vi.setSystemTime(Date.now() + 1500);   // the process stalled: the next tick is 1.5 s late
    vi.advanceTimersByTime(10);
    expect(s.room.lagMs).toBeGreaterThan(1000);
    expect(race.t).toBeCloseTo(1.01 + 6 * STEP, 1);   // at most maxCatchUpSteps in that tick
    vi.advanceTimersByTime(1000);
    expect(s.room.lagMs).toBe(0);
    expect(race.t).toBeCloseTo(owed() * STEP, 9);   // no step lost, none invented
    expect(race.t).toBeCloseTo(3.5, 1);
  });

  it('a stale overload reading is cleared when the last room closes and never blocks the next room', () => {
    const { mgr } = manager();
    mgr.start();
    const a = create(mgr); if (!a.ok) throw new Error(a.code);
    vi.advanceTimersByTime(50);
    mgr.tickMaxMs = 80;
    expect(create(mgr)).toMatchObject({ ok: false, code: 'overloaded' });
    expect(mgr.running).toBe(true);
    a.room.close('test');
    expect(mgr.running).toBe(false);
    expect(mgr.tickMaxMs).toBe(0);
    expect(create(mgr).ok).toBe(true);
  });

  it('shutdown stops the timer, aborts races without results and closes every room; repeating it is safe', () => {
    const { mgr } = manager();
    mgr.start();
    const s = create(mgr, 'solo'); if (!s.ok) throw new Error(s.code);
    const m = create(mgr); if (!m.ok) throw new Error(m.code);
    s.room.handle(s.participant, { t: 'start' }, Date.now());
    vi.advanceTimersByTime(500);
    mgr.shutdown();
    expect(mgr.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mgr.size).toBe(0);
    expect(s.room.state).toBe('closed');
    expect(m.room.state).toBe('closed');
    expect(s.room.results.at(-1)).toMatchObject({ outcome: 'aborted', abortReason: 'shutdown', classification: null });
    expect(() => mgr.shutdown()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
