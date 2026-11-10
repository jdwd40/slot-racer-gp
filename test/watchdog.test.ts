// The keepalive and receive watchdog (#42): a socket that stops delivering without ever closing (half-open TCP behind a
// proxy, a sleeping phone) must be noticed and resumed, in the lobby as well as in a race, while a quiet but live socket
// and this page's own suspension never tear a connection down.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SocketCtor, SocketLike } from '../src/net/client';
import { NetSession, type Conn, type EndReason, type KV } from '../src/net/session';

type Msg = { t: string; [k: string]: unknown };

/** A scripted server endpoint. `silent` stops all delivery to that socket without closing it (a half-open connection). */
function fakeServer(script: string[] = [], roomState = 'lobby') {
  const sockets: Fake[] = [];
  class Fake implements SocketLike {
    readyState = 0;
    silent = false;
    sent: Msg[] = [];
    private pump: ReturnType<typeof setInterval> | null = null;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() {
      sockets.push(this);
      setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } }, 1);
    }
    deliver(m: unknown): void { setTimeout(() => { if (this.readyState === 1 && !this.silent) this.onmessage?.({ data: JSON.stringify(m) }); }, 1); }
    send(data: string): void {
      const m = JSON.parse(data) as Msg;
      this.sent.push(m);
      if (m.t === 'hello') { this.deliver({ t: 'welcome', v: 1, server: 't', rules: 't', now: 0 }); return; }
      if (m.t === 'ping') { this.deliver({ t: 'pong', id: m.id, now: 0 }); return; }
      if (m.t !== 'resume') return;
      const next = script.shift() ?? 'joined';
      if (next !== 'joined') { this.deliver({ t: 'nack', ref: 'resume', code: next }); return; }
      const room = { id: 'r1', code: 'ABCDEF', mode: 'multiplayer', state: roomState, rev: 1, hostId: 'p0', settings: {}, championship: null,
        participants: [{ id: 'p1', ready: true, connected: true, left: false }], ai: [], raceId: roomState === 'race' ? 'race1' : null, maxHumans: 4, minHumans: 1, graceS: 20 };
      this.deliver({ t: 'joined', room, you: 'p1', token: 'tok', ctlSeq: 0, actSeq: 0, resumed: true });
      // a racing room streams snapshots at 20 Hz
      if (roomState === 'race') this.pump = setInterval(() => this.deliver({ t: 'state', tick: 0, now: 0, lagMs: 0, snap: {}, ev: [] }), 50);
    }
    close(code = 1000, reason = ''): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.pump) clearInterval(this.pump);
      // a half-open socket's close is never reported promptly: the late event comes long after the watchdog gave up on it
      setTimeout(() => this.onclose?.({ code, reason }), this.silent ? 30000 : 1);
    }
    count(t: string): number { return this.sent.filter((m) => m.t === t).length; }
  }
  return { Ctor: Fake as unknown as SocketCtor, sockets };
}

const seat = { room: 'r1', participant: 'p1', token: 'tok', code: 'ABCDEF' };
const memKV = (): KV & { map: Map<string, string> } => { const map = new Map<string, string>(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }; };

async function joined(state = 'lobby', script: string[] = []) {
  const srv = fakeServer(['joined', ...script], state);
  const conns: Conn[] = [];
  const ends: EndReason[] = [];
  const kv = memKV();
  const s = new NetSession('ws://x', srv.Ctor, { conn: (c) => conns.push(c), end: (why) => ends.push(why) }, kv);
  const p = s.resume(seat);
  await vi.advanceTimersByTimeAsync(10);
  expect(await p).toEqual({ ok: true });
  conns.length = 0;
  return { srv, s, conns, ends, kv, first: srv.sockets[0] };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('receive watchdog', () => {
  it('lobby: a socket that goes silent without closing is resumed after 12 s', async () => {
    const { srv, s, conns, first } = await joined('lobby');
    first.silent = true;
    await vi.advanceTimersByTimeAsync(11500);
    expect(s.conn).toBe('connected');
    expect(srv.sockets.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(conns[0]).toBe('reconnecting');
    expect(srv.sockets.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(srv.sockets[1].count('resume')).toBe(1);
    expect(conns).toEqual(['reconnecting', 'connected']);
    expect(s.conn).toBe('connected');
    // the dead socket's late close comes much later and starts no second reconnect loop
    await vi.advanceTimersByTimeAsync(31000);
    expect(srv.sockets.length).toBe(2);
    expect(conns).toEqual(['reconnecting', 'connected']);
    s.close();
  });

  it('race: the same with the 4 s threshold', async () => {
    const { srv, s, conns, first } = await joined('race');
    first.silent = true;
    await vi.advanceTimersByTimeAsync(3500);
    expect(s.conn).toBe('connected');
    await vi.advanceTimersByTimeAsync(1500);
    expect(conns[0]).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(srv.sockets[1].count('resume')).toBe(1);
    expect(conns).toEqual(['reconnecting', 'connected']);
    s.close();
  });

  it('never fires while messages keep arriving (pongs in the lobby, snapshots in a race)', async () => {
    const lobby = await joined('lobby');
    await vi.advanceTimersByTimeAsync(120000);
    expect(lobby.s.conn).toBe('connected');
    expect(lobby.srv.sockets.length).toBe(1);
    expect(lobby.conns).toEqual([]);
    lobby.s.close();

    const race = await joined('race');
    await vi.advanceTimersByTimeAsync(60000);
    expect(race.s.conn).toBe('connected');
    expect(race.srv.sockets.length).toBe(1);
    expect(race.conns).toEqual([]);
    race.s.close();
  });

  it('pings every 5 s in the lobby; the 250 ms ctl heartbeat runs only while racing', async () => {
    const lobby = await joined('lobby');
    await vi.advanceTimersByTimeAsync(20000);
    expect(lobby.first.count('ping')).toBe(4);
    expect(lobby.first.count('ctl')).toBe(0);
    lobby.s.close();

    const race = await joined('race');
    await vi.advanceTimersByTimeAsync(10000);
    expect(race.first.count('ping')).toBe(2);
    expect(race.first.count('ctl')).toBeGreaterThanOrEqual(39);
    race.s.close();
  });

  it('a resume refused expired ends the session, forgets the seat and leaves no timer running', async () => {
    const { s, conns, ends, kv, first } = await joined('lobby', ['expired']);
    expect(kv.map.size).toBeGreaterThan(0);
    first.silent = true;
    await vi.advanceTimersByTimeAsync(13000);
    await vi.advanceTimersByTimeAsync(100);
    expect(ends).toEqual(['expired']);
    expect(conns).toEqual(['reconnecting', 'offline']);
    expect(kv.getItem('srgp.seat')).toBeNull();
    s.close();
    // the dead socket's pending (late) close event is the only thing left; once it is through, nothing remains
    await vi.advanceTimersByTimeAsync(31000);
    expect(vi.getTimerCount()).toBe(0);
    expect(conns).toEqual(['reconnecting', 'offline']);
  });

  it('after leave() or close() no ping or watchdog timer remains', async () => {
    const a = await joined('lobby');
    a.s.leave();
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.getTimerCount()).toBe(0);
    const pings = a.first.count('ping');
    await vi.advanceTimersByTimeAsync(30000);
    expect(a.first.count('ping')).toBe(pings);

    const b = await joined('race');
    b.s.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
    expect(b.srv.sockets.length).toBe(1);
  });

  it("this page's own suspension (a big clock jump, a return from hidden) does not tear a live socket down", async () => {
    // a lobby: the next keepalive tick runs before any message, as on a page that was frozen and is thawed
    const { srv, s, conns, first } = await joined('lobby');
    await vi.advanceTimersByTimeAsync(2000);
    const pings = first.count('ping');
    // frozen for a minute: the wall clock moves on but no timer or message ran meanwhile
    vi.setSystemTime(Date.now() + 60000);
    await vi.advanceTimersByTimeAsync(1000);
    // the late tick saw the gap: no teardown, just a fresh window and a ping to prove the socket
    expect(s.conn).toBe('connected');
    expect(first.count('ping')).toBe(pings + 1);
    s.client.wake();   // the visibilitychange hook may also run; it only restarts the window
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.conn).toBe('connected');
    expect(srv.sockets.length).toBe(1);
    expect(conns).toEqual([]);
    s.close();
  });

  it('a socket that really died during the suspension is resumed once after the fresh window', async () => {
    const { srv, s, conns, first } = await joined('race');
    first.silent = true;
    vi.setSystemTime(Date.now() + 60000);
    s.client.wake();
    await vi.advanceTimersByTimeAsync(3500);
    expect(s.conn).toBe('connected');
    await vi.advanceTimersByTimeAsync(1600);
    await vi.advanceTimersByTimeAsync(10);
    expect(conns).toEqual(['reconnecting', 'connected']);
    expect(srv.sockets.length).toBe(2);
    await vi.advanceTimersByTimeAsync(31000);
    expect(srv.sockets.length).toBe(2);
    s.close();
  });

  it('while reconnecting, the lobby shows this seat as not connected and not ready, and sends no Ready', async () => {
    const srv = fakeServer(['joined'], 'lobby');
    const seen: { conn: Conn; ready: boolean; connected: boolean }[] = [];
    const s: NetSession = new NetSession('ws://x', srv.Ctor, { room: (r) => {
      const p = r.participants.find((x) => x.id === 'p1')!;
      seen.push({ conn: s.conn, ready: p.ready, connected: p.connected });
      if (s.conn === 'reconnecting') s.ready(true);
    } });
    const p = s.resume(seat);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    srv.sockets[0].silent = true;
    await vi.advanceTimersByTimeAsync(13100);
    expect(seen).toEqual([
      { conn: 'connected', ready: true, connected: true },
      { conn: 'reconnecting', ready: false, connected: false },
      { conn: 'connected', ready: true, connected: true },
    ]);
    // the Ready pressed while reconnecting went nowhere: the new socket was not in the room yet
    expect(srv.sockets.some((x) => x.count('ready') > 0)).toBe(false);
    s.close();
  });
});
