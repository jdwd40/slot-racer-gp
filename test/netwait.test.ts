// The pending card's safety net (#43) with a fake session and fake clock: 30 s with no state or result shows lost contact
// and asks for a resume (once, never alongside one already under way), a resume puts the card back with a fresh window,
// a refused resume says the room closed, and a result in time shows nothing. Real-session runs are in watchdog.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NETWAIT_TIMEOUT_MS, NetWaitGuard, type NetWaitView } from '../src/net/netwait';
import type { Conn } from '../src/net/session';

function fake(conn: Conn = 'connected') {
  const s = { conn, reconnects: 0, views: [] as NetWaitView[] };
  const g = new NetWaitGuard({ conn: () => s.conn, reconnect: () => { s.reconnects++; }, render: (v) => s.views.push(v) });
  return { s, g };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('netwait lost-contact timeout', () => {
  it('30 s with no news shows lost contact and triggers one reconnect; a resume restores the card and restarts the window', async () => {
    const { s, g } = fake();
    g.start();
    expect(s.views).toEqual(['waiting']);
    await vi.advanceTimersByTimeAsync(NETWAIT_TIMEOUT_MS - 1000);
    expect(s.views).toEqual(['waiting']);
    expect(s.reconnects).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.views).toEqual(['waiting', 'lost']);
    expect(s.reconnects).toBe(1);
    // the session goes reconnecting: still lost contact, and no second reconnect however long it takes
    s.conn = 'reconnecting'; g.conn('reconnecting');
    await vi.advanceTimersByTimeAsync(60000);
    expect(s.reconnects).toBe(1);
    expect(s.views).toEqual(['waiting', 'lost']);
    // resumed: the normal card, and a whole new window
    s.conn = 'connected'; g.conn('connected');
    expect(s.views).toEqual(['waiting', 'lost', 'waiting']);
    await vi.advanceTimersByTimeAsync(NETWAIT_TIMEOUT_MS - 1000);
    expect(s.reconnects).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.reconnects).toBe(2);
    g.stop();
  });

  it('a state message restarts the window: steady news never times out', async () => {
    const { s, g } = fake();
    g.start();
    for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(20000); g.news(); }
    expect(s.views).toEqual(['waiting']);
    expect(s.reconnects).toBe(0);
    g.stop();
  });

  it('a normal result before 30 s: the card is left, no message is shown and no timer remains', async () => {
    const { s, g } = fake();
    g.start();
    await vi.advanceTimersByTimeAsync(10000);
    g.news();
    g.stop();   // the results screen's enter() does this
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(s.views).toEqual(['waiting']);
    expect(s.reconnects).toBe(0);
  });

  it('a refused resume shows that the room closed before results were sent, and stops the timer', async () => {
    const { s, g } = fake();
    g.start();
    await vi.advanceTimersByTimeAsync(NETWAIT_TIMEOUT_MS);
    s.conn = 'reconnecting'; g.conn('reconnecting');
    s.conn = 'offline';
    // the session ends `expired` for a refused resume (expired or not_found)
    expect(g.ended('expired')).toBe(true);
    expect(s.views).toEqual(['waiting', 'lost', 'closed']);
    expect(g.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // nothing further happens on that card
    g.conn('connected');
    expect(s.views.at(-1)).toBe('closed');
  });

  it('other endings (left, closed, ...) leave the card to the usual menu, and an inactive guard handles nothing', () => {
    const a = fake();
    a.g.start();
    expect(a.g.ended('left')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const b = fake();
    expect(b.g.ended('expired')).toBe(false);
    expect(b.s.views).toEqual([]);
  });

  it('a reconnect the watchdog already started is shown as lost contact and never doubled', async () => {
    const { s, g } = fake('reconnecting');
    g.start();
    expect(s.views).toEqual(['lost']);
    await vi.advanceTimersByTimeAsync(120000);
    expect(s.reconnects).toBe(0);
    // the watchdog takes over mid-window: no time counts while it works
    s.conn = 'connected'; g.conn('connected');
    await vi.advanceTimersByTimeAsync(20000);
    s.conn = 'reconnecting'; g.conn('reconnecting');
    await vi.advanceTimersByTimeAsync(60000);
    expect(s.reconnects).toBe(0);
    s.conn = 'connected'; g.conn('connected');
    await vi.advanceTimersByTimeAsync(NETWAIT_TIMEOUT_MS - 1000);
    expect(s.reconnects).toBe(0);
    expect(s.views).toEqual(['lost', 'waiting', 'lost', 'waiting']);
    g.stop();
  });

  it("this page's suspension is not counted: a frozen minute does not time the card out", async () => {
    const { s, g } = fake();
    g.start();
    await vi.advanceTimersByTimeAsync(20000);
    // frozen: the wall clock moves on a minute while no timer runs; the next tick is far late and adds nothing
    vi.setSystemTime(Date.now() + 60000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.reconnects).toBe(0);
    // a return from hidden (visibilitychange) restarts the tick clock the same way
    vi.setSystemTime(Date.now() + 60000);
    g.wake();
    await vi.advanceTimersByTimeAsync(8000);
    expect(s.reconnects).toBe(0);
    expect(g.quietMs).toBeLessThan(NETWAIT_TIMEOUT_MS);
    // the rest of the window still runs out normally
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.reconnects).toBe(1);
    g.stop();
  });
});
