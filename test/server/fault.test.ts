// Process-level fault handlers (#166): log, take the graceful stop with a non-zero code, never re-enter.
import { describe, it, expect } from 'vitest';
import { FAULT_EXIT, installFaultHandlers } from '../../server/fault';
import { memoryLogger } from '../../server/log';

type Ev = 'uncaughtException' | 'unhandledRejection';
function harness(stop: (reason: string, code: number) => void = () => {}) {
  const log = memoryLogger();
  const stops: [string, number][] = [];
  const exits: number[] = [];
  const handlers = new Map<Ev, (e: unknown) => void>();
  installFaultHandlers({ log, stop: (r, c) => { stops.push([r, c]); stop(r, c); }, exit: (c) => exits.push(c), on: (ev, fn) => handlers.set(ev, fn) });
  return { log, stops, exits, handlers };
}

describe('process fault handlers (#166)', () => {
  it('registers both events; an uncaught exception is logged and runs the graceful stop with a non-zero code', () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    h.handlers.get('uncaughtException')!(new Error('boom'));
    expect(FAULT_EXIT).not.toBe(0);
    expect(h.stops).toEqual([['uncaughtException', FAULT_EXIT]]);
    expect(h.exits).toEqual([]);
    expect(JSON.parse(h.log.lines[0])).toMatchObject({ lvl: 'error', ev: 'process.fault', kind: 'uncaughtException', error: 'Error: boom' });
  });

  it('an unhandled rejection does the same, and a second fault is logged but never starts another stop', () => {
    const h = harness();
    h.handlers.get('unhandledRejection')!('nope');
    h.handlers.get('uncaughtException')!(new Error('again'));
    expect(h.stops).toEqual([['unhandledRejection', FAULT_EXIT]]);
    expect(h.log.lines.filter((l) => l.includes('"process.fault"'))).toHaveLength(2);
  });

  it('a stop that throws exits non-zero at once', () => {
    const h = harness(() => { throw new Error('stop broke'); });
    h.handlers.get('uncaughtException')!(new Error('boom'));
    expect(h.exits).toEqual([FAULT_EXIT]);
    expect(h.log.lines.some((l) => l.includes('"process.fault_stop_failed"'))).toBe(true);
  });
});
