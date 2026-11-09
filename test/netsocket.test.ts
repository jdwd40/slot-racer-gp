// NetSession's reconnect loop against a scripted socket: every failed attempt must give its connection up, because the
// server counts open connections per address and a leak would lock this browser out before its seat's grace runs out.
import { describe, it, expect } from 'vitest';
import type { SocketCtor, SocketLike } from '../src/net/client';
import { NetSession, type EndReason } from '../src/net/session';

/** A fake server endpoint: answers hello, and answers each resume from a script ('joined' or a nack code). */
function fakeServer(script: string[]) {
  const sockets: Fake[] = [];
  let peak = 0;
  const open = () => sockets.filter((s) => s.readyState !== 3).length;
  class Fake implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() {
      sockets.push(this); peak = Math.max(peak, open());
      setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.({}); } }, 1);
    }
    private reply(m: unknown): void { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }); }, 1); }
    send(data: string): void {
      const m = JSON.parse(data) as { t: string };
      if (m.t === 'hello') { this.reply({ t: 'welcome', v: 1, server: 't', rules: 't', now: 0 }); return; }
      if (m.t !== 'resume') return;
      const next = script.shift() ?? 'joined';
      if (next !== 'joined') { this.reply({ t: 'nack', ref: 'resume', code: next }); return; }
      const room = { id: 'r1', code: 'ABCD', mode: 'race', state: 'lobby', rev: 1, hostId: 'p1', settings: {}, championship: null, participants: [], ai: [], raceId: null, maxHumans: 4, minHumans: 1, graceS: 0 };
      this.reply({ t: 'joined', room, you: 'p1', token: 'tok', ctlSeq: 0, actSeq: 0, resumed: true });
    }
    close(code = 1000, reason = ''): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code, reason }), 1);
    }
    /** the server side hangs up */
    hangUp(): void { this.close(1006, ''); }
  }
  return { Ctor: Fake as unknown as SocketCtor, sockets, open, peak: () => peak };
}

const seat = { room: 'r1', participant: 'p1', token: 'tok', code: 'ABCD' };
const until = async (f: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

describe('reconnect sockets', () => {
  it('retried resume refusals close each socket, so only one connection is ever open', async () => {
    const srv = fakeServer(['joined', 'unavailable', 'overloaded', 'rate']);
    const s = new NetSession('ws://x', srv.Ctor);
    expect(await s.resume(seat)).toEqual({ ok: true });
    (srv.sockets[0] as unknown as { hangUp(): void }).hangUp();
    await until(() => s.conn === 'reconnecting');
    await until(() => s.conn === 'connected');
    expect(srv.sockets.length).toBe(5);
    expect(srv.open()).toBe(1);
    expect(srv.peak()).toBe(1);
    s.close();
  });

  it('abandoning reconnection when the window passes leaves no socket open', async () => {
    const srv = fakeServer(['joined', ...Array(20).fill('unavailable')]);
    const ends: EndReason[] = [];
    const s = new NetSession('ws://x', srv.Ctor, { end: (why) => ends.push(why) });
    await s.resume(seat);
    (srv.sockets[0] as unknown as { hangUp(): void }).hangUp();
    await until(() => ends.length > 0);
    expect(ends).toEqual(['expired']);
    expect(srv.open()).toBe(0);
    expect(srv.peak()).toBe(1);
  });
});
