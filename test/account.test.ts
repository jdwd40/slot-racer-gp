// Accounts in the browser (#24): display-name rules, the account client's sign-in/sign-out/switch flows with a fake
// server, and what account-scoped client state is cleared (and what local game data is kept).
import { describe, it, expect } from 'vitest';
import { checkDisplayName, LIMITS } from '../src/net/protocol';
import { AccountClient, OWNER_KEY, accountKey, clearAccountState, type Store } from '../src/net/account';
import { RateWindow } from '../server/app';

class MemStore implements Store {
  m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

describe('display name rules (shared by browser and server)', () => {
  it('normalizes, refuses blank, long, AI-like and non-string names, keeps HTML-like text verbatim', () => {
    expect(checkDisplayName('  Ada   Lovelace ')).toEqual({ ok: true, name: 'Ada Lovelace' });
    expect(checkDisplayName('é')).toEqual({ ok: true, name: 'é' });   // NFC
    expect(checkDisplayName('a​b‮c\u0000d⁦')).toEqual({ ok: true, name: 'abcd' });
    expect(checkDisplayName('<script>x</script>'.slice(0, 16))).toEqual({ ok: true, name: '<script>x</scrip' });
    expect(checkDisplayName('x'.repeat(LIMITS.nameMax))).toMatchObject({ ok: true });
    expect(checkDisplayName('😀'.repeat(LIMITS.nameMax))).toMatchObject({ ok: true });   // counted in code points
    expect(checkDisplayName('x'.repeat(LIMITS.nameMax + 1))).toEqual({ ok: false, error: 'too_long' });
    for (const b of ['', '   ', '\t\n', '​‍', '﻿']) expect(checkDisplayName(b)).toEqual({ ok: false, error: 'blank' });
    for (const r of ['Gold Flash (AI)', 'me (ai)', 'x ( AI )']) expect(checkDisplayName(r)).toEqual({ ok: false, error: 'reserved' });
    for (const x of [null, undefined, 3, {}, ['a'], 'x'.repeat(300)]) expect(checkDisplayName(x)).toEqual({ ok: false, error: 'type' });
  });
});

describe('RateWindow', () => {
  it('allows max hits per window per key, then blocks until the window passes', () => {
    let now = 0;
    const w = new RateWindow(3, 1000, () => now);
    expect([w.hit('a'), w.hit('a'), w.hit('a'), w.hit('a')]).toEqual([true, true, true, false]);
    expect(w.blocked('a')).toBe(true);
    expect(w.hit('b')).toBe(true);
    now = 1001;
    expect(w.blocked('a')).toBe(false);
    expect(w.hit('a')).toBe(true);
    w.clear('a');
    expect(w.blocked('a')).toBe(false);
  });
});

type Route = (body: Record<string, unknown> | null, cookie: string) => { status: number; body: unknown; cookie?: string };

/** A tiny fake of the account API: a cookie jar, sessions and profiles, so flows run without a server. */
function fakeServer() {
  const users = new Map<string, { id: string; pw: string; name: string }>();
  const sessions = new Map<string, string>();
  let jar = '';
  let n = 0;
  const calls: { path: string; body: unknown }[] = [];
  const signIn = (id: string) => { const sid = `s${++n}`; sessions.set(sid, id); return sid; };
  const who = (c: string) => sessions.get(c) ?? null;
  const view = (id: string) => { const u = [...users.entries()].find(([, v]) => v.id === id)!; return { account: { id, username: u[0] }, profile: { displayName: u[1].name, updatedAt: null }, session: 'active' }; };
  const routes: Record<string, Route> = {
    '/api/auth/me': (_b, c) => (who(c) ? { status: 200, body: view(who(c)!) } : { status: 200, body: { account: null, session: c ? 'expired' : 'none' }, cookie: '' }),
    '/api/auth/register': (b) => {
      const u = String(b!.username).toLowerCase();
      if (users.has(u)) return { status: 409, body: { error: 'username_taken' } };
      users.set(u, { id: String(users.size + 1), pw: String(b!.password), name: String(b!.displayName ?? u) });
      return { status: 201, body: view(users.get(u)!.id), cookie: signIn(users.get(u)!.id) };
    },
    '/api/auth/login': (b, c) => {
      const u = users.get(String(b!.username).toLowerCase());
      if (!u || u.pw !== b!.password) return { status: 401, body: { error: 'invalid_credentials' } };
      sessions.delete(c);
      return { status: 200, body: view(u.id), cookie: signIn(u.id) };
    },
    '/api/auth/logout': (_b, c) => { sessions.delete(c); return { status: 200, body: { ok: true }, cookie: '' }; },
    '/api/profile': (b, c) => {
      const id = who(c);
      if (!id) return { status: 401, body: { error: c ? 'session_expired' : 'signed_out' } };
      if (b!.expectAccount !== undefined && b!.expectAccount !== id) return { status: 409, body: { error: 'identity_changed' } };
      const u = [...users.values()].find((x) => x.id === id)!;
      u.name = String(b!.displayName);
      return { status: 200, body: { profile: { displayName: u.name, updatedAt: 'now' } } };
    },
  };
  let down = false;
  const overrides = new Map<string, Route>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (down) throw new TypeError('network');
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, body });
    expect(init.credentials).toBe('same-origin');
    const r = (overrides.get(path) ?? routes[path])(body, jar);
    if (r.cookie !== undefined) jar = r.cookie;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, users, sessions, calls, get jar() { return jar; }, set jar(v: string) { jar = v; }, setDown(v: boolean) { down = v; }, override(path: string, r: Route | null) { if (r) overrides.set(path, r); else overrides.delete(path); }, expireAll() { sessions.clear(); } };
}

/** Local game data that must survive every sign-in, sign-out and switch. */
const LOCAL_SAVES: Record<string, string> = {
  'srgp.lb.race.circuit-1': '[{"ms":1}]', 'srgp.ghost.circuit-1.sunburst.ABC': '{}', 'srgp.champ': '{"rounds":[]}',
  'srgp.initials': 'ABC', 'srgp.car': 'sunburst', 'srgp.graphics': 'high', 'srgp.netName': 'Guest Gil', 'srgp.track': 'circuit-1',
};

function setup() {
  const srv = fakeServer();
  const local = new MemStore(), session = new MemStore();
  for (const [k, v] of Object.entries(LOCAL_SAVES)) local.setItem(k, v);
  const c = new AccountClient(srv.fetchFn, 'https://slotrush.example', local, session);
  const keepsSaves = () => { for (const [k, v] of Object.entries(LOCAL_SAVES)) expect(local.getItem(k)).toBe(v); };
  return { srv, local, session, c, keepsSaves };
}

describe('AccountClient', () => {
  it('restores a valid session, reports an expired one, and is "unavailable" (not broken) when the server is down', async () => {
    const { srv, c } = setup();
    expect((await c.restore()).state).toBe('guest');
    expect(c.auth).toEqual({ state: 'guest', expired: false });
    expect((await c.register('Ada_1', 'ada password 1', 'Ada')).ok).toBe(true);
    const c2 = new AccountClient(srv.fetchFn, 'https://slotrush.example', new MemStore(), new MemStore());
    expect(await c2.restore()).toEqual({ state: 'signed-in', account: { id: '1', username: 'ada_1', displayName: 'Ada' } });
    srv.expireAll();
    expect(await c2.restore()).toEqual({ state: 'guest', expired: true });
    srv.setDown(true);
    expect(await c2.restore()).toEqual({ state: 'unavailable' });
  });

  it('maps server refusals to plain errors and validates names before sending', async () => {
    const { srv, c } = setup();
    await c.register('bob_1', 'bob password 1');
    await c.logout();
    expect(await c.register('BOB_1', 'other password 1')).toEqual({ ok: false, error: 'username_taken' });
    expect(await c.login('bob_1', 'wrong password')).toEqual({ ok: false, error: 'invalid_credentials' });
    const before = srv.calls.length;
    expect(await c.register('carl_1', 'carl password', '   x'.padEnd(30, 'y'))).toEqual({ ok: false, error: 'invalid_name', detail: 'too_long' });
    expect(srv.calls.length).toBe(before);   // nothing was sent
    srv.setDown(true);
    expect(await c.login('bob_1', 'bob password 1')).toEqual({ ok: false, error: 'unreachable' });
  });

  it('rename keeps the account id; an expired session on rename turns the browser into a guest and clears account state', async () => {
    const { srv, c, local, session, keepsSaves } = setup();
    const r = await c.register('dee_1', 'dee password 1', 'Dee');
    const id = r.ok ? r.account.id : '';
    expect(await c.rename('  Dee   Two ')).toEqual({ ok: true, account: { id, username: 'dee_1', displayName: 'Dee Two' } });
    // the name, and the account the form was opened for (an expectation the server checks, never an identity it uses)
    expect(srv.calls.at(-1)).toEqual({ path: '/api/profile', body: { displayName: 'Dee Two', expectAccount: id } });
    expect(await c.rename('')).toEqual({ ok: false, error: 'invalid_name', detail: 'blank' });
    local.setItem(accountKey(id, 'pending'), '[{"race":"r1"}]');
    session.setItem('srgp.seat', '{"room":"r"}');
    srv.expireAll();
    expect(await c.rename('Dee 3')).toEqual({ ok: false, error: 'session_expired' });
    expect(c.auth).toEqual({ state: 'guest', expired: true });
    expect(local.getItem(accountKey(id, 'pending'))).toBe(null);
    expect(session.getItem('srgp.seat')).toBe(null);
    keepsSaves();
  });

  it('sign-out clears account state and pending submissions, keeps local records, ghosts and championships', async () => {
    const { srv, c, local, session, keepsSaves } = setup();
    const r = await c.register('eve_1', 'eve password 1');
    const id = r.ok ? r.account.id : '';
    local.setItem(accountKey(id, 'pending'), '[1]');
    local.setItem(accountKey(id, 'cache'), '{"private":true}');
    session.setItem('srgp.seat', '{}'); session.setItem('srgp.netResults', '[]');
    expect(await c.logout()).toEqual({ ok: true });
    expect(c.auth).toEqual({ state: 'guest', expired: false });
    expect(srv.sessions.size).toBe(0);
    expect([...local.m.keys()].filter((k) => k.startsWith('srgp.acct.') && k !== OWNER_KEY)).toEqual([]);
    expect(session.length).toBe(0);
    keepsSaves();
  });

  it('a sign-out the server does not confirm is a failure: still signed in, account state forgotten anyway, retry works', async () => {
    const { srv, c, local, session, keepsSaves } = setup();
    const r = await c.register('ian_1', 'ian password 1');
    const id = r.ok ? r.account.id : '';
    const signedIn = c.auth;
    local.setItem(accountKey(id, 'pending'), '[1]');
    session.setItem('srgp.seat', '{}');
    // offline: the server was never told, so the session (and its cookie) is still live
    srv.setDown(true);
    expect(await c.logout()).toEqual({ ok: false, error: 'unreachable' });
    srv.setDown(false);
    expect(c.auth).toEqual(signedIn);
    expect(c.busy).toBe(false);
    expect(local.getItem(accountKey(id, 'pending'))).toBe(null);   // private client state is still forgotten
    expect(session.getItem('srgp.seat')).toBe(null);
    expect(srv.sessions.size).toBe(1);
    expect((await new AccountClient(srv.fetchFn, 'https://slotrush.example', new MemStore(), new MemStore()).restore()).state).toBe('signed-in');   // a reload would sign back in
    // the server answers but could not revoke the session (store error, proxy error page)
    for (const fail of [{ status: 503, body: { error: 'unavailable' } }, { status: 502, body: 'Bad Gateway' }, { status: 200, body: {} }]) {
      srv.override('/api/auth/logout', () => fail);
      expect((await c.logout()).ok).toBe(false);
      expect(c.auth).toEqual(signedIn);
    }
    srv.override('/api/auth/logout', null);
    expect(await c.logout()).toEqual({ ok: true });
    expect(c.auth).toEqual({ state: 'guest', expired: false });
    expect(srv.sessions.size).toBe(0);
    keepsSaves();
  });

  it('switching accounts: the next driver never inherits the previous one\'s pending submissions or seat', async () => {
    const { srv, c, local, session, keepsSaves } = setup();
    const a = await c.register('fay_1', 'fay password 1', 'Fay');
    const aid = a.ok ? a.account.id : '';
    local.setItem(accountKey(aid, 'pending'), '[1]');
    session.setItem('srgp.seat', '{"room":"fay"}');
    await c.register('gus_1', 'gus password 1', 'Gus');   // a second sign-in without signing out first
    expect(c.account).toMatchObject({ username: 'gus_1', displayName: 'Gus' });
    expect(local.getItem(accountKey(aid, 'pending'))).toBe(null);
    expect(session.getItem('srgp.seat')).toBe(null);
    expect(local.getItem(OWNER_KEY)).toBe(c.account!.id);
    // a different account signed in from another tab (detected on restore): the same clean-up
    local.setItem(accountKey(c.account!.id, 'pending'), '[2]');
    srv.jar = '';
    await c.login('fay_1', 'fay password 1');
    expect(local.getItem(accountKey('2', 'pending'))).toBe(null);
    // a guest's seat is not carried into an account either
    await c.logout();
    session.setItem('srgp.seat', '{"room":"guest"}');
    await c.login('fay_1', 'fay password 1');
    expect(session.getItem('srgp.seat')).toBe(null);
    // the same account on reload keeps its own state
    local.setItem(accountKey(aid, 'pending'), '[3]');
    await c.restore();
    expect(local.getItem(accountKey(aid, 'pending'))).toBe('[3]');
    keepsSaves();
    void srv;
  });

  it('two tabs: a profile form opened for one account never renames the next one, and the stale tab follows the switch', async () => {
    const srv = fakeServer();
    const local = new MemStore(), s1 = new MemStore(), s2 = new MemStore();
    const tab1 = new AccountClient(srv.fetchFn, 'https://slotrush.example', local, s1);
    const tab2 = new AccountClient(srv.fetchFn, 'https://slotrush.example', local, s2);   // same browser: same cookie, same localStorage
    await tab1.register('alice_1', 'alice password 1', 'Alice');
    await tab2.restore();
    await tab2.logout();
    await tab2.register('bob_1', 'bob password 1', 'Bob');
    const bob = tab2.account!;
    s1.setItem('srgp.seat', '{"room":"alice"}');   // tab 1's own seat, taken as Alice
    expect(tab1.account).toMatchObject({ username: 'alice_1' });   // tab 1 has not heard yet
    expect(tab1.expected).toBe('1');
    // saving the name on Alice's open form: refused, nothing renamed, and tab 1 now shows who the browser really is
    expect(await tab1.rename('Hacked Name')).toEqual({ ok: false, error: 'identity_changed' });
    expect([...srv.users.values()].map((u) => u.name).sort()).toEqual(['Alice', 'Bob']);
    expect(tab1.account).toEqual(bob);
    expect(tab1.busy).toBe(false);
    expect(s1.getItem('srgp.seat')).toBe(null);   // Alice's seat does not pass to Bob
    // the storage event from another tab: tab 1 asks the server rather than keep showing the old identity
    await tab2.logout();
    expect(await tab1.syncFromOtherTab('srgp.netName')).toBe(null);   // unrelated keys are ignored
    expect(tab1.account).toEqual(bob);
    expect(await tab1.syncFromOtherTab(OWNER_KEY)).toEqual({ state: 'guest', expired: false });   // the sign-out cleared the shared cookie
    expect(tab1.expected).toBe('');
    await tab2.login('alice_1', 'alice password 1');
    s1.setItem('srgp.seat', '{"room":"guest"}');
    expect(await tab1.syncFromOtherTab(null)).toMatchObject({ state: 'signed-in', account: { username: 'alice_1' } });
    expect(s1.getItem('srgp.seat')).toBe(null);   // a guest seat is not carried into an account either
    // the same account renames normally
    expect(await tab1.rename('Alice Two')).toMatchObject({ ok: true, account: { displayName: 'Alice Two' } });
  });

  it('a cross-tab refresh keeps the shown identity until answered, and one that arrives mid-request is not dropped', async () => {
    const srv = fakeServer();
    // tab 1's requests can be held at the network, to look inside the in-flight window
    let hold: Promise<void> | null = null;
    const gated: typeof fetch = async (...a) => { if (hold) await hold; return srv.fetchFn(...a); };
    const local = new MemStore();
    const tab1 = new AccountClient(gated, 'https://slotrush.example', local, new MemStore());
    const tab2 = new AccountClient(srv.fetchFn, 'https://slotrush.example', local, new MemStore());
    await tab1.register('alice_1', 'alice password 1', 'Alice');
    await tab2.restore();
    const aliceId = tab1.account!.id;
    // finding 1: while the refresh is in flight the page still sends Alice's id, so the server can refuse a stale seat
    await tab2.logout();
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    const sync = tab1.syncFromOtherTab(OWNER_KEY);
    await Promise.resolve();
    expect(tab1.auth.state).toBe('signed-in');
    expect(tab1.expected).toBe(aliceId);
    hold = null; release();
    expect(await sync).toEqual({ state: 'guest', expired: false });
    expect(tab1.expected).toBe('');
    // finding 2: Alice signs back in on tab 1 and saves her name; meanwhile tab 2 signs out and in as Bob
    await tab1.login('alice_1', 'alice password 1');
    hold = new Promise((r) => { release = r; });
    const save = tab1.rename('Alice Two');
    expect(tab1.busy).toBe(true);
    const late = tab1.syncFromOtherTab(OWNER_KEY);   // the storage event arrives while the save is in flight
    await tab2.logout();
    await tab2.register('bob_1', 'bob password 1', 'Bob');
    hold = null; release();
    await save;
    expect(await late).toMatchObject({ state: 'signed-in', account: { username: 'bob_1' } });
    expect(tab1.account).toEqual(tab2.account);
  });

  it('a /me answered before a sign-out, sign-in or rename but delivered after it never replaces the newer state', async () => {
    const srv = fakeServer();
    // /me is answered by the server at once, but its response can be held in the network
    let hold: Promise<void> | null = null;
    const late: typeof fetch = async (url, init) => {
      const r = await srv.fetchFn(url, init);
      if (hold && new URL(String(url)).pathname === '/api/auth/me') await hold;
      return r;
    };
    const local = new MemStore(), session = new MemStore();
    const c = new AccountClient(late, 'https://slotrush.example', local, session);
    await c.register('alice_1', 'alice password 1', 'Alice');
    let release!: () => void;
    const gate = () => { hold = new Promise((r) => { release = r; }); };

    // sign-out: the server revoked the session, so the earlier "signed in" answer is stale
    gate();
    const sync = c.syncFromOtherTab(OWNER_KEY);
    await Promise.resolve();
    expect(await c.logout()).toEqual({ ok: true });
    hold = null; release();
    expect(await sync).toEqual({ state: 'guest', expired: false });
    expect(c.auth).toEqual({ state: 'guest', expired: false });
    expect(local.getItem(OWNER_KEY)).toBe('');

    // sign-in: the earlier "guest" answer must not sign the tab out (or clear the new driver's state)
    gate();
    const sync2 = c.restore({ keep: true });
    await Promise.resolve();
    expect((await c.login('alice_1', 'alice password 1')).ok).toBe(true);
    local.setItem(accountKey(c.account!.id, 'pending'), '{}');
    hold = null; release();
    expect(await sync2).toMatchObject({ state: 'signed-in', account: { username: 'alice_1' } });
    expect(local.getItem(accountKey(c.account!.id, 'pending'))).toBe('{}');

    // rename: the earlier answer carries the old name
    gate();
    const sync3 = c.restore({ keep: true });
    await Promise.resolve();
    expect((await c.rename('Alice Two')).ok).toBe(true);
    hold = null; release();
    await sync3;
    expect(c.account?.displayName).toBe('Alice Two');

    // with nothing newer in between, a restore's answer still applies
    expect(await c.restore()).toMatchObject({ state: 'signed-in', account: { displayName: 'Alice Two' } });
  });

  it('clearAccountState removes only account-scoped keys', () => {
    const local = new MemStore(), session = new MemStore();
    for (const [k, v] of Object.entries(LOCAL_SAVES)) local.setItem(k, v);
    local.setItem('srgp.acct.7.pending', 'x'); session.setItem('srgp.seat', 'y'); session.setItem('srgp.netResults', 'z'); session.setItem('other', 'keep');
    expect(clearAccountState(local, session).sort()).toEqual(['srgp.acct.7.pending', 'srgp.netResults', 'srgp.seat']);
    expect(session.getItem('other')).toBe('keep');
    for (const [k, v] of Object.entries(LOCAL_SAVES)) expect(local.getItem(k)).toBe(v);
    expect(clearAccountState(null, null)).toEqual([]);
  });
});
