// Client message history (#50). The browser client used to keep up to 20,000 complete decoded messages (~70 MB of four-car
// snapshots) purely for tests, held across rematches. Now nothing is recorded unless a test or diagnostic opts in, and an
// opt-in is capped. These feed 20,001+ real four-car snapshots and several rematches through the client's socket path.
import { describe, it, expect } from 'vitest';
import { HISTORY_DEFAULT_CAP, HISTORY_MAX, HISTORY_OFF, OnlineClient, type SocketCtor, type SocketLike } from '../src/net/client';
import { NetSession } from '../src/net/session';
import type { ServerMsg } from '../src/net/protocol';
import { Race } from '../src/race';
import { STEP } from '../src/timing';
import { SnapEncoder } from '../src/net/snapwire';

const SNAPSHOTS = 20_001;
const REMATCHES = 3;

/** A socket that opens at once, answers hello and resume, and lets the test deliver frames. */
function fakeSocket() {
  const box: { s: (SocketLike & { deliver(m: unknown): void }) | null } = { s: null };
  const room = (state: string) => ({ id: 'r1', code: 'ABCDEF', mode: 'multiplayer', state, rev: 1, hostId: 'p0', settings: {}, championship: null,
    participants: [{ id: 'p0', ready: true, connected: true, left: false }], ai: [], raceId: state === 'race' ? 'race1' : null, maxHumans: 4, minHumans: 1, graceS: 20 });
  class Fake implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() { box.s = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0); }
    deliver(m: unknown): void { this.onmessage?.({ data: JSON.stringify(m) }); }
    send(data: string): void {
      const m = JSON.parse(data) as { t: string };
      if (m.t === 'hello') setTimeout(() => this.deliver({ t: 'welcome', v: 1, server: 't', rules: 't', now: 0 }), 0);
      if (m.t === 'resume') setTimeout(() => this.deliver({ t: 'joined', room: room('race'), you: 'p0', token: 'tok', ctlSeq: 0, actSeq: 0, resumed: true }), 0);
    }
    close(): void { this.readyState = 3; }
  }
  return { Ctor: Fake as unknown as SocketCtor, sock: () => box.s!, room };
}

/** A seeded four-human race, stepped three times per snapshot as the server does at 20 Hz. */
function snapshots() {
  const roster = [0, 1, 2, 3].map((k) => ({ id: `p${k}`, control: 'human' as const, slot: k, name: `P${k}`, color: 0x3060c0 + k }));
  const race = new Race({ roster, seed: 50, runOn: 'live' });
  const held = Object.fromEntries(roster.map((r) => [r.id, { up: true, down: false }]));
  let tick = 0;
  // as the room server sends them (protocol v2, #67): a keyframe with the static fields, deltas, a keyframe every second.
  // `fresh()` starts a new race's encoding (a rematch), whose first state carries the static fields again
  let enc = new SnapEncoder('race0');
  const next = () => {
    for (let k = 0; k < 3; k++) race.step(STEP, held);
    tick += 3;
    return { t: 'state', tick, now: 0, lagMs: 0, ev: [], ...enc.next(race.snapshot(), tick, tick * STEP * 1000) };
  };
  return Object.assign(next, { fresh: (id: string) => { enc = new SnapEncoder(id); } });
}

/**
 * Drive one client through SNAPSHOTS race states, then REMATCHES rematch cycles (lobby, race, states, result, awards).
 * `peak` is the most messages `received` held at any moment: retention must not follow total session length.
 */
function feed(c: OnlineClient, sock: () => { deliver(m: unknown): void }, room: (s: string) => unknown) {
  const next = snapshots();
  let peak = 0, lastTick = 0;
  const look = () => { peak = Math.max(peak, c.received.length); };
  for (let i = 0; i < SNAPSHOTS; i++) { const m = next(); lastTick = m.tick; sock().deliver(m); if (i % 1000 === 0) look(); }
  look();
  for (let r = 0; r < REMATCHES; r++) {
    next.fresh(`race${r + 1}`);
    sock().deliver({ t: 'room', room: room('lobby') });
    sock().deliver({ t: 'room', room: room('race') });
    for (let i = 0; i < 2000; i++) { const m = next(); lastTick = m.tick; sock().deliver(m); }
    sock().deliver({ t: 'result', envelope: { raceId: `race${r}` } });
    sock().deliver({ t: 'awards', awards: { raceId: `race${r}`, scoring: 's', sync: 'saved', rows: [] } });
    look();
  }
  return { peak, lastTick, total: 1 + SNAPSHOTS + REMATCHES * 2004 };
}

describe('client message history (#50)', () => {
  it('the policy constants: off by default, a small opt-in cap and a hard ceiling far below the old 20,000', () => {
    expect(HISTORY_OFF).toBe(0);
    expect(HISTORY_DEFAULT_CAP).toBeGreaterThan(0);
    expect(HISTORY_DEFAULT_CAP).toBeLessThanOrEqual(HISTORY_MAX);
    expect(HISTORY_MAX).toBeLessThanOrEqual(8000);
  });

  it('default mode records nothing across 20,001 snapshots and rematches; delivery, waiters, counters and latest still work', async () => {
    const { Ctor, sock, room } = fakeSocket();
    const c = new OnlineClient('ws://x', Ctor);
    expect(c.historyCap).toBe(HISTORY_OFF);
    await c.connect();
    let seen = 0, lastSeen = -1;
    c.onMessage = (m) => { seen++; if (m.t === 'state') lastSeen = m.tick; };
    const { peak, lastTick, total } = feed(c, sock, room);
    expect(peak).toBe(0);
    expect(c.received).toHaveLength(0);
    expect(c.rx.total).toBe(total);
    expect(c.rx.byType.state).toBe(SNAPSHOTS + REMATCHES * 2000);
    expect(c.rx.byType.result).toBe(REMATCHES);
    expect(c.rx.dropped).toBe(0);
    // every message was still handed on, in order; the newest of each type is kept, and only that
    expect(seen).toBe(total - 1);
    expect(lastSeen).toBe(lastTick);
    expect((c.latest.state as Extract<ServerMsg, { t: 'state' }>).tick).toBe(lastTick);
    expect(c.latest.result).toMatchObject({ envelope: { raceId: `race${REMATCHES - 1}` } });
    expect(Object.keys(c.latest).sort()).toEqual(['awards', 'result', 'room', 'state', 'welcome']);
    // request waiters resolve as before after the long session
    const w = c.wait((m) => m.t === 'pong');
    sock().deliver({ t: 'pong', id: 1, now: 0 });
    expect(await w).toMatchObject({ t: 'pong', id: 1 });
    c.close();
  });

  it('the browser session (NetSession) never opts in', async () => {
    const { Ctor, sock } = fakeSocket();
    const s = new NetSession('ws://x', Ctor);
    expect(await s.resume({ room: 'r1', participant: 'p0', token: 'tok', code: 'ABCDEF' })).toEqual({ ok: true });
    const next = snapshots();
    for (let i = 0; i < 500; i++) sock().deliver(next());
    expect(s.client.historyCap).toBe(HISTORY_OFF);
    expect(s.client.received).toHaveLength(0);
    expect(s.client.rx.byType.state).toBe(500);
    s.close();
  });

  it('opt-in keeps the newest messages up to its cap through overflow and rematches, counts what it dropped, and resets on request', async () => {
    const { Ctor, sock, room } = fakeSocket();
    const c = new OnlineClient('ws://x', Ctor).recordHistory();
    expect(c.historyCap).toBe(HISTORY_DEFAULT_CAP);
    await c.connect();
    const { peak, lastTick, total } = feed(c, sock, room);
    expect(peak).toBe(HISTORY_DEFAULT_CAP);
    expect(c.received).toHaveLength(HISTORY_DEFAULT_CAP);
    expect(c.rx.dropped).toBe(total - HISTORY_DEFAULT_CAP);
    // oldest first, newest last: the tail of the last rematch, nothing from the first race
    expect(c.received.at(-1)).toMatchObject({ t: 'awards' });
    const states = c.received.filter((m): m is Extract<ServerMsg, { t: 'state' }> => m.t === 'state');
    expect(states.at(-1)!.tick).toBe(lastTick);
    expect(states[0].tick).toBeGreaterThan(SNAPSHOTS * 3);
    for (let i = 1; i < states.length; i++) expect(states[i].tick).toBeGreaterThan(states[i - 1].tick);
    // reset: clearHistory empties it (counters kept); new messages are recorded again
    c.clearHistory();
    expect(c.received).toHaveLength(0);
    sock().deliver({ t: 'pong', id: 2, now: 0 });
    expect(c.received).toEqual([{ t: 'pong', id: 2, now: 0 }]);
    expect(c.rx.total).toBe(total + 1);
    c.close();
  });

  it('an opt-in cap is clamped to the hard ceiling, and lowering it trims the oldest at once', async () => {
    const { Ctor, sock } = fakeSocket();
    const c = new OnlineClient('ws://x', Ctor).recordHistory(1e9);
    expect(c.historyCap).toBe(HISTORY_MAX);
    await c.connect();
    for (let i = 0; i < HISTORY_MAX + 500; i++) sock().deliver({ t: 'pong', id: i, now: 0 });
    expect(c.received).toHaveLength(HISTORY_MAX);
    c.recordHistory(10);
    expect(c.received.map((m) => (m as { id: number }).id)).toEqual(Array.from({ length: 10 }, (_, k) => HISTORY_MAX + 490 + k));
    c.recordHistory(HISTORY_OFF);
    expect(c.received).toHaveLength(0);
    sock().deliver({ t: 'pong', id: -1, now: 0 });
    expect(c.received).toHaveLength(0);
    c.close();
  });

  it('the opt-in cap boundary: exactly `cap` messages drops nothing, the next drops exactly the oldest (#53)', () => {
    const { Ctor } = fakeSocket();
    const c = new OnlineClient('ws://x', Ctor).recordHistory(HISTORY_DEFAULT_CAP);
    const feed = c as unknown as { receive(raw: string): void };   // the socket path's decoder, without timers
    for (let id = 0; id < HISTORY_DEFAULT_CAP; id++) feed.receive(JSON.stringify({ t: 'pong', id, now: 0 }));
    expect(c.received).toHaveLength(HISTORY_DEFAULT_CAP);
    expect(c.rx.dropped).toBe(0);
    feed.receive(JSON.stringify({ t: 'pong', id: HISTORY_DEFAULT_CAP, now: 0 }));
    expect(c.received).toHaveLength(HISTORY_DEFAULT_CAP);
    expect(c.rx.dropped).toBe(1);
    expect(c.received[0]).toMatchObject({ id: 1 });
    expect(c.received.at(-1)).toMatchObject({ id: HISTORY_DEFAULT_CAP });
  });
});
