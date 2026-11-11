// An outdated page (#67): the game server speaks a newer protocol than this cached bundle. The page must never race on it
// (the server refuses its hello anyway), and must say so with a Reload button instead of silently hiding online play.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SocketCtor, SocketLike } from '../src/net/client';
import { NetSession, type EndReason } from '../src/net/session';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { outdatedHtml, probeOnline } from '../src/online';

const health = (protocol: unknown) => (() => Promise.resolve(new Response(JSON.stringify({ ok: true, protocol, version: 'v' }), { status: 200 }))) as unknown as typeof fetch;

/** A server endpoint whose hello answer can change between sockets (an upgrade while a session is open). */
function fakeServer() {
  const sockets: Fake[] = [];
  const srv = { upgraded: false };
  class Fake implements SocketLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 1); }
    deliver(m: unknown): void { setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) }); }, 1); }
    send(data: string): void {
      const m = JSON.parse(data) as { t: string; v?: number };
      if (m.t === 'hello') {
        // as server/app.ts: a hello of another version is refused and closed with 4002
        if (srv.upgraded || m.v !== PROTOCOL_VERSION) { this.deliver({ t: 'nack', ref: 'hello', code: 'protocol' }); setTimeout(() => this.close(4002, 'protocol'), 5); }
        else this.deliver({ t: 'welcome', v: PROTOCOL_VERSION, server: 't', rules: 't', now: 0 });
      }
      if (m.t === 'resume' || m.t === 'join') {
        const room = { id: 'r1', code: 'ABCDEF', mode: 'multiplayer', state: 'race', rev: 1, hostId: 'p0', settings: {}, championship: null,
          participants: [{ id: 'p0', ready: true, connected: true, left: false }], ai: [], raceId: 'race1', maxHumans: 4, minHumans: 1, graceS: 20 };
        this.deliver({ t: 'joined', room, you: 'p0', token: 'tok', ctlSeq: 0, actSeq: 0, resumed: m.t === 'resume' });
      }
    }
    close(code = 1000, reason = ''): void { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code, reason }), 1); }
  }
  return { Ctor: Fake as unknown as SocketCtor, sockets, srv };
}

describe('an outdated page (#67)', () => {
  it('the health check reports a newer server protocol as outdated, never as available', async () => {
    expect(await probeOnline(true, health(PROTOCOL_VERSION + 1), 'https://x')).toEqual({ state: 'outdated', server: PROTOCOL_VERSION + 1 });
    expect(await probeOnline(true, health(PROTOCOL_VERSION), 'https://x')).toMatchObject({ state: 'available' });
    // an older server (the static client released first) is the ordinary "unavailable": reloading would not help
    expect(await probeOnline(true, health(PROTOCOL_VERSION - 1), 'https://x')).toMatchObject({ state: 'unavailable' });
  });

  it('the title notice says a new version is available and offers a Reload button', () => {
    const html = outdatedHtml();
    expect(html).toContain('A new version of Slot Rush is available. Reload to play online.');
    expect(html).toMatch(/<button[^>]*id="o-reload"[^>]*>Reload<\/button>/);
    const ids = (JSON.parse(readFileSync(new URL('../assets/ui/strings.json', import.meta.url), 'utf8')) as { strings: { id: string }[] }).strings.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['net.outdated', 'net.reload']));
    expect(new Set(ids).size).toBe(ids.length);
    // main.ts shows it for the outdated state and wires the button to a reload
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("if (online.state === 'outdated') return outdatedHtml();");
    expect(main).toContain("overlay.querySelector('#o-reload')?.addEventListener('click', () => location.reload());");
    expect(main).toContain("if (r.code === 'protocol') { online = { state: 'outdated', server: null };");
    expect(main).toContain("if (why === 'outdated') { online = { state: 'outdated', server: null };");
  });

  it('a hello refused for its protocol is reported as `protocol` (the page then shows the reload notice)', async () => {
    const { Ctor, srv } = fakeServer();
    srv.upgraded = true;
    const s = new NetSession('ws://x', Ctor);
    expect(await s.join('ABCDEF', 'Ann')).toEqual({ ok: false, code: 'protocol' });
    expect(s.conn).toBe('offline');
  });

  it('a server upgraded mid-session: the reconnect is refused once and the session ends `outdated`, no retry loop', async () => {
    vi.useFakeTimers();
    try {
      const { Ctor, sockets, srv } = fakeServer();
      const ends: EndReason[] = [];
      const s = new NetSession('ws://x', Ctor, { end: (why) => ends.push(why) });
      const p = s.join('ABCDEF', 'Ann');
      await vi.advanceTimersByTimeAsync(50);
      expect(await p).toEqual({ ok: true });
      srv.upgraded = true;
      sockets[0].close(1012, 'restart');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ends).toEqual(['outdated']);
      expect(sockets).toHaveLength(2);   // one attempt: retrying cannot succeed
      expect(s.conn).toBe('offline');
    } finally { vi.useRealTimers(); }
  });
});
