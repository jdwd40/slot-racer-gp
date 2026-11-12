// An outdated page (#67): the game server speaks a newer protocol than this cached bundle. The page must never race on it
// (the server refuses its hello anyway), and must say so with a Reload button instead of silently hiding online play.
// An older server (#80: rolled back after a protocol bump) is not this page's fault: "temporarily unavailable" with Retry,
// never "a new version is available", whichever way the mismatch is found (health probe or a refused hello).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SocketCtor, SocketLike } from '../src/net/client';
import { NetSession, type EndReason } from '../src/net/session';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { RECHECK_MAX, RECHECK_MS, afterProtocolRefusal, afterRetry, behindHtml, outdatedHtml, probeOnline, startRecheck, type OnlineStatus } from '../src/online';

const health = (protocol: unknown) => (() => Promise.resolve(new Response(JSON.stringify({ ok: true, protocol, version: 'v' }), { status: 200 }))) as unknown as typeof fetch;

/** A server endpoint whose hello answer can change between sockets (an upgrade while a session is open). */
function fakeServer() {
  const sockets: Fake[] = [];
  const srv = { upgraded: false, version: PROTOCOL_VERSION };
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
        if (srv.upgraded || m.v !== srv.version) { this.deliver({ t: 'nack', ref: 'hello', code: 'protocol' }); setTimeout(() => this.close(4002, 'protocol'), 5); }
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
    // an older server is never "outdated": reloading would not help (#80)
    expect(await probeOnline(true, health(PROTOCOL_VERSION - 1), 'https://x')).toEqual({ state: 'behind', server: PROTOCOL_VERSION - 1 });
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
    // a refused hello (create/join/resume) and a refused reconnect both ask /api/health which side is newer (#80)
    expect(main).toContain("if (r.code === 'protocol') { onProtocolRefused(); return; }");
    expect(main).toContain("if (why === 'outdated') { onProtocolRefused(); return; }");
    expect(main).toContain('void probeHealth().then((st) => applyOnline(afterProtocolRefusal(st), true));');
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

const NEW_VERSION = 'A new version of Slot Rush is available. Reload to play online.';
const BEHIND = 'Online play is temporarily unavailable — try again shortly.';
/** The title's online notice for a status, as main.ts's onlineEntryHtml picks it. */
const notice = (st: OnlineStatus): string => (st.state === 'outdated' ? outdatedHtml() : st.state === 'behind' ? behindHtml() : st.state === 'available' ? 'ONLINE' : st.state);

describe('an older game server (#80: a server rollback after a protocol bump)', () => {
  it('server newer → the Reload notice as before; server older → temporarily unavailable with Retry; equal → online', async () => {
    const newer = await probeOnline(true, health(PROTOCOL_VERSION + 1), 'https://x');
    expect(notice(newer)).toContain(NEW_VERSION);
    expect(notice(newer)).toContain('id="o-reload"');

    const older = await probeOnline(true, health(PROTOCOL_VERSION - 1), 'https://x');
    expect(older).toEqual({ state: 'behind', server: PROTOCOL_VERSION - 1 });
    expect(notice(older)).toContain(BEHIND);
    expect(notice(older)).toMatch(/<button[^>]*id="o-retry"[^>]*>Retry<\/button>/);
    expect(notice(older)).not.toContain(NEW_VERSION);
    expect(notice(older)).not.toContain('o-reload');

    expect(notice(await probeOnline(true, health(PROTOCOL_VERSION), 'https://x'))).toBe('ONLINE');

    const ids = (JSON.parse(readFileSync(new URL('../assets/ui/strings.json', import.meta.url), 'utf8')) as { strings: { id: string }[] }).strings.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['net.behind', 'net.retry']));
    expect(new Set(ids).size).toBe(ids.length);
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("if (online.state === 'behind') return behindHtml();");
    expect(main).toContain("void probeHealth().then((st) => applyOnline(afterRetry(st), true));");
  });

  it('Retry once the server matches again returns to normal online play, without a reload', async () => {
    let proto = PROTOCOL_VERSION - 1;
    const f = (() => Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: proto, version: 'v' }), { status: 200 }))) as unknown as typeof fetch;
    expect(afterRetry(await probeOnline(true, f, 'https://x'))).toEqual({ state: 'behind', server: PROTOCOL_VERSION - 1 });
    proto = PROTOCOL_VERSION;   // the server is rolled forward again
    expect(afterRetry(await probeOnline(true, f, 'https://x'))).toEqual({ state: 'available', version: 'v', wsUrl: 'wss://x/ws', accounts: false });
    // a server restarting while it is rolled back keeps the Retry notice rather than dropping the button
    expect(afterRetry({ state: 'unavailable', reason: 'unreachable' })).toEqual({ state: 'behind', server: null });
    // a Retry that finds a newer server (rolled forward past this page) is the Reload notice
    expect(afterRetry({ state: 'outdated', server: PROTOCOL_VERSION + 1 })).toEqual({ state: 'outdated', server: PROTOCOL_VERSION + 1 });
  });

  it('a hello refused by an older server shows the unavailable notice, never "new version"', async () => {
    const { Ctor, srv } = fakeServer();
    srv.version = PROTOCOL_VERSION - 1;   // rolled back: this page's hello is refused as `protocol`
    const s = new NetSession('ws://x', Ctor);
    expect(await s.join('ABCDEF', 'Ann')).toEqual({ ok: false, code: 'protocol' });
    // the refusal does not say which side is newer: main.ts re-probes /api/health and decides
    const st = afterProtocolRefusal(await probeOnline(true, health(PROTOCOL_VERSION - 1), 'https://x'));
    expect(st).toEqual({ state: 'behind', server: PROTOCOL_VERSION - 1 });
    expect(notice(st)).toContain(BEHIND);
    expect(notice(st)).not.toContain(NEW_VERSION);
    // only a probe that reports a newer server makes the page outdated
    expect(afterProtocolRefusal(await probeOnline(true, health(PROTOCOL_VERSION + 1), 'https://x'))).toEqual({ state: 'outdated', server: PROTOCOL_VERSION + 1 });
    // a failing probe, or one that now matches (the server changed again meanwhile), is the Retry notice too
    expect(afterProtocolRefusal({ state: 'unavailable', reason: 'unreachable' })).toEqual({ state: 'behind', server: null });
    expect(afterProtocolRefusal(await probeOnline(true, health(PROTOCOL_VERSION), 'https://x'))).toEqual({ state: 'behind', server: null });
  });

  it('a reconnect refused by a rolled-back server ends `outdated` once; the health check then shows the Retry notice', async () => {
    vi.useFakeTimers();
    try {
      const { Ctor, sockets, srv } = fakeServer();
      const ends: EndReason[] = [];
      const s = new NetSession('ws://x', Ctor, { end: (why) => ends.push(why) });
      const p = s.join('ABCDEF', 'Ann');
      await vi.advanceTimersByTimeAsync(50);
      expect(await p).toEqual({ ok: true });
      srv.version = PROTOCOL_VERSION - 1;
      sockets[0].close(1012, 'restart');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ends).toEqual(['outdated']);
      expect(sockets).toHaveLength(2);
      expect(notice(afterProtocolRefusal(await probeOnline(true, health(PROTOCOL_VERSION - 1), 'https://x')))).toContain(BEHIND);
    } finally { vi.useRealTimers(); }
  });

  describe('the title re-checks health while it shows the notice', () => {
    it('re-probes every RECHECK_MS, recovers by itself once the server matches, then stops', async () => {
      vi.useFakeTimers();
      try {
        const answers: OnlineStatus[] = [{ state: 'behind', server: 1 }, { state: 'behind', server: 1 }, { state: 'available', version: 'v', wsUrl: 'ws://x/ws', accounts: false }];
        const probe = vi.fn((): Promise<OnlineStatus> => Promise.resolve(answers.shift() ?? { state: 'behind', server: 1 }));
        let online: OnlineStatus = { state: 'behind', server: 1 };
        let done = 0;
        startRecheck(probe, (st) => { online = st; }, () => online.state === 'behind', () => { done++; });
        expect(RECHECK_MS).toBeGreaterThanOrEqual(30_000);
        expect(RECHECK_MS).toBeLessThanOrEqual(60_000);
        await vi.advanceTimersByTimeAsync(RECHECK_MS - 1);
        expect(probe).toHaveBeenCalledTimes(0);   // nothing at once: the notice was just decided by a probe
        await vi.advanceTimersByTimeAsync(1);
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(online.state).toBe('behind');
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
        expect(probe).toHaveBeenCalledTimes(3);
        expect(online.state).toBe('available');
        expect(done).toBe(1);
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 10);
        expect(probe).toHaveBeenCalledTimes(3);
      } finally { vi.useRealTimers(); }
    });

    it('stops when the title is left, when stopped, and after RECHECK_MAX probes', async () => {
      vi.useFakeTimers();
      try {
        const behind = (): Promise<OnlineStatus> => Promise.resolve({ state: 'behind', server: 1 });
        // the title is left: no probe at all
        let onTitle = true;
        const p1 = vi.fn(behind);
        let done = 0;
        startRecheck(p1, () => {}, () => onTitle, () => { done++; });
        onTitle = false;
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 5);
        expect(p1).toHaveBeenCalledTimes(0);
        expect(done).toBe(1);
        // stopped early
        const p2 = vi.fn(behind);
        const stop = startRecheck(p2, () => {}, () => true);
        await vi.advanceTimersByTimeAsync(RECHECK_MS);
        stop();
        await vi.advanceTimersByTimeAsync(RECHECK_MS * 5);
        expect(p2).toHaveBeenCalledTimes(1);
        // bounded: a server that never comes back is probed RECHECK_MAX times
        const p3 = vi.fn(behind);
        startRecheck(p3, () => {}, () => true);
        await vi.advanceTimersByTimeAsync(RECHECK_MS * (RECHECK_MAX + 10));
        expect(p3).toHaveBeenCalledTimes(RECHECK_MAX);
        // main.ts runs it only on the title with the older-server notice
        const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
        expect(main).toContain("() => screen === 'title' && online.state === 'behind'");
      } finally { vi.useRealTimers(); }
    });
  });
});
