// The in-memory result sink (guests-only servers and tests) and the online check's switchable storage gate (#106).
import { describe, it, expect } from 'vitest';
import { MemoryResultSink, MEMORY_RESULTS_MAX, ResultConflict, type ResultSink } from '../../server/results';
import { makeScoring, type Scoring } from '../../server/career';
import type { ResultEnvelope } from '../../server/envelope';
import { gatedSink } from '../../scripts/qa-server';

// the memory sink reads only raceId and digest
const env = (raceId: string, digest = `d-${raceId}`): ResultEnvelope => ({ raceId, digest } as unknown as ResultEnvelope);

describe('MemoryResultSink', () => {
  it('keeps at most `max` results, dropping the oldest first', async () => {
    const sink = new MemoryResultSink(3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(await sink.consume(env(id))).toBe('stored');
    expect([...sink.stored.keys()]).toEqual(['c', 'd', 'e']);
    expect(sink.calls).toBe(5);
  });

  it('defaults to a generous cap and stays bounded past it', async () => {
    const sink = new MemoryResultSink();
    expect(sink.max).toBe(MEMORY_RESULTS_MAX);
    expect(MEMORY_RESULTS_MAX).toBeGreaterThanOrEqual(1000);
    for (let i = 0; i < MEMORY_RESULTS_MAX + 25; i++) await sink.consume(env(`r${i}`));
    expect(sink.stored.size).toBe(MEMORY_RESULTS_MAX);
    expect(sink.stored.has('r24')).toBe(false);
    expect(sink.stored.has('r25')).toBe(true);
    expect(sink.stored.has(`r${MEMORY_RESULTS_MAX + 24}`)).toBe(true);
  });

  it('still reports duplicates and refuses conflicts for retained results; a duplicate does not evict anything', async () => {
    const sink = new MemoryResultSink(2);
    await sink.consume(env('a')); await sink.consume(env('b'));
    expect(await sink.consume(env('a'))).toBe('duplicate');
    await expect(sink.consume(env('b', 'other'))).rejects.toBeInstanceOf(ResultConflict);
    expect([...sink.stored.keys()]).toEqual(['a', 'b']);
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new MemoryResultSink(bad)).toThrow(RangeError);
  });
});

describe('online check storage gate (scripts/qa-server.ts)', () => {
  const recorder = (): ResultSink & { seen: (Scoring | undefined)[] } => {
    const seen: (Scoring | undefined)[] = [];
    return { seen, consume: async (_e, scoring) => { seen.push(scoring); return 'stored'; } };
  };

  it('passes the room\'s scoring policy through to the inner sink', async () => {
    const inner = recorder();
    const scoring = makeScoring([7, 3, 1]);
    const gated = gatedSink(inner, { down: false });
    expect(await gated.consume(env('a'), scoring)).toBe('stored');
    await gated.consume(env('b'));
    expect(inner.seen).toEqual([scoring, undefined]);
  });

  it('fails every store while storage is down, without reaching the inner sink', async () => {
    const inner = recorder();
    const storage = { down: true };
    const gated = gatedSink(inner, storage);
    await expect(gated.consume(env('a'), makeScoring())).rejects.toThrow('qa: storage down');
    expect(inner.seen).toEqual([]);
    storage.down = false;
    await gated.consume(env('a'));
    expect(inner.seen).toHaveLength(1);
  });
});
