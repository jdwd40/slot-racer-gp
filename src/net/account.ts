// Player accounts in the browser: sign-in state, the driver profile and the account-scoped client state that must not
// outlive a sign-out or pass to the next person on the same browser. No DOM: main.ts renders it; tests drive it with a fake
// fetch. The session itself is the server's HttpOnly cookie, which no script here can read, so nothing secret is ever
// stored by this module. See docs/accounts.md.
import { checkDisplayName } from './protocol';

export interface SignedIn { id: string; username: string; displayName: string; }
export type AuthState =
  | { state: 'off' }
  | { state: 'loading' }
  /** `expired`: the browser had a session the server no longer accepts (expiry, sign-out elsewhere, owner reset) */
  | { state: 'guest'; expired: boolean }
  | { state: 'signed-in'; account: SignedIn }
  /** the account service could not be reached; local and guest play carry on */
  | { state: 'unavailable' };

export type AuthError =
  | 'invalid_credentials' | 'username_taken' | 'invalid_username' | 'invalid_password' | 'invalid_name' | 'rate' | 'busy'
  | 'signed_out' | 'session_expired' | 'unavailable' | 'unreachable' | 'other'
  /** the browser's sign-in is no longer the one this page showed (signed out and in again in another tab): nothing was changed */
  | 'identity_changed';
export type AuthResult = { ok: true; account: SignedIn } | { ok: false; error: AuthError; detail?: string };

/** Minimal storage (localStorage/sessionStorage in the browser, a Map in tests). */
export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; readonly length: number; key(i: number): string | null; }

/** Prefix of every client key that belongs to one account (pending submissions, cached private data). Cleared on any identity change. */
export const ACCOUNT_PREFIX = 'srgp.acct.';
/** Which account the account-scoped client state belongs to ('' for guest). */
export const OWNER_KEY = 'srgp.acct.owner';
/** Per-tab online seat and seen-results keys (src/net/session.ts): a seat belongs to the identity that took it. */
export const SEAT_KEYS = ['srgp.seat', 'srgp.netResults'] as const;
/** A key for data owned by one account, e.g. a pending statistics submission: `accountKey(id, 'pending')`. */
export const accountKey = (accountId: string, name: string): string => `${ACCOUNT_PREFIX}${accountId}.${name}`;

const TIMEOUT_MS = 10000;

/**
 * Remove account-scoped client state: every `srgp.acct.*` key and the per-tab seat, in both stores. Everything else (local
 * records, ghosts, championships, settings, the guest online name) is left exactly as it was.
 */
export function clearAccountState(local: Store | null, session: Store | null): string[] {
  const removed: string[] = [];
  for (const kv of [local, session]) {
    if (!kv) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < kv.length; i++) { const k = kv.key(i); if (k && (k.startsWith(ACCOUNT_PREFIX) || (SEAT_KEYS as readonly string[]).includes(k))) keys.push(k); }
      for (const k of keys) { kv.removeItem(k); removed.push(k); }
    } catch { /* storage unavailable */ }
  }
  return removed;
}

type Json = Record<string, unknown>;

export class AccountClient {
  auth: AuthState = { state: 'off' };
  /** a request in flight (the UI disables its buttons and shows progress) */
  busy = false;
  onChange: ((a: AuthState) => void) | null = null;
  /** the identity this tab last held ('' guest, an account id), kept through `loading`: this tab's seat belongs to it */
  private owner: string | null = null;
  /** callers waiting for the request in flight to finish (a cross-tab change that arrived meanwhile) */
  private idleWaiters: (() => void)[] = [];
  /** bumped by every restore: only the newest answer from the server is applied */
  private restoreSeq = 0;

  constructor(private fetchFn: typeof fetch, private origin: string, private local: Store | null, private session: Store | null) {}

  get account(): SignedIn | null { return this.auth.state === 'signed-in' ? this.auth.account : null; }

  /**
   * Who the page shows, for a server that refuses work done under another identity: an account id, '' for a guest, or
   * undefined when this page does not know (accounts off, unavailable, still loading).
   */
  get expected(): string | undefined { return this.auth.state === 'signed-in' ? this.auth.account.id : this.auth.state === 'guest' ? '' : undefined; }

  /**
   * Another tab of this browser signed in, out or switched (it rewrote OWNER_KEY in the shared localStorage; pass the
   * `storage` event's key, null when the whole store was cleared). The cookie is shared, so ask the server who this tab is now.
   */
  async syncFromOtherTab(key: string | null): Promise<AuthState | null> {
    if (key !== null && key !== OWNER_KEY) return null;
    if (this.auth.state === 'off') return null;
    // a request in flight: refresh once it is done rather than drop the change (its result may already be stale)
    if (this.busy) await new Promise<void>((res) => this.idleWaiters.push(res));
    if ((this.auth as AuthState).state === 'off') return null;   // accounts may have been switched off meanwhile
    // keep showing (and sending, via `expected`) the identity on screen until the server answers: the server then refuses
    // work done under it if it is stale, instead of the page entering a room with no identity at all
    return this.restore({ keep: true });
  }

  /** The request in flight finished: wake any cross-tab refresh that was waiting for it. */
  private idle(): void {
    this.busy = false;
    const w = this.idleWaiters.splice(0);
    for (const f of w) f();
  }

  private set(a: AuthState): void {
    // a different identity from the one the account-scoped state belongs to: that state is not this driver's
    const owner = a.state === 'signed-in' ? a.account.id : a.state === 'guest' ? '' : null;
    if (owner !== null) {
      let prev: string | null = null;
      try { prev = this.local?.getItem(OWNER_KEY) ?? null; } catch { /* ignore */ }
      if (prev !== null && prev !== owner) clearAccountState(this.local, this.session);
      // another tab already recorded the new owner, but this tab's own seat (sessionStorage) still belongs to the old one
      else if (this.owner !== null && this.owner !== owner) clearAccountState(null, this.session);
      try { this.local?.setItem(OWNER_KEY, owner); } catch { /* ignore */ }
      this.owner = owner;
    }
    this.auth = a;
    this.onChange?.(a);
  }

  private async call(path: string, body?: Json): Promise<{ status: number; data: Json } | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await this.fetchFn(`${this.origin}${path}`, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: ctl.signal,
        headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let data: Json = {};
      try { data = (await r.json()) as Json; } catch { /* not JSON (a proxy error page) */ }
      return { status: r.status, data };
    } catch { return null; } finally { clearTimeout(timer); }
  }

  private static view(d: Json): SignedIn | null {
    const a = d.account as Json | null | undefined, p = d.profile as Json | null | undefined;
    if (!a || typeof a.id !== 'string' || typeof a.username !== 'string') return null;
    return { id: a.id, username: a.username, displayName: typeof p?.displayName === 'string' ? p.displayName : a.username };
  }

  private static error(status: number, d: Json): { error: AuthError; detail?: string } {
    const e = typeof d.error === 'string' ? d.error : '';
    const detail = typeof d.detail === 'string' ? d.detail : undefined;
    if (status === 400 && e === 'invalid') return { error: detail?.startsWith('username') ? 'invalid_username' : 'invalid_password', detail };
    if (status === 400 && e === 'invalid_name') return { error: 'invalid_name', detail };
    if (status === 401) return { error: e === 'session_expired' ? 'session_expired' : e === 'signed_out' ? 'signed_out' : 'invalid_credentials' };
    if (status === 409) return { error: e === 'identity_changed' ? 'identity_changed' : 'username_taken' };
    if (status === 429) return { error: 'rate' };
    if (status === 503) return { error: e === 'busy' ? 'busy' : 'unavailable' };
    return { error: 'other' };
  }

  /** Session restoration on page load (or on return): who the server says this browser is. */
  async restore(opts: { keep?: boolean } = {}): Promise<AuthState> {
    const seq = ++this.restoreSeq;
    // `keep`: a refresh of a known identity (another tab changed the shared sign-in) keeps the current state until answered
    if (!opts.keep || (this.auth.state !== 'signed-in' && this.auth.state !== 'guest')) this.set({ state: 'loading' });
    const r = await this.call('/api/auth/me');
    if (seq !== this.restoreSeq) return this.auth; // a newer refresh started: its answer wins
    if (!r || r.status !== 200) { this.set({ state: 'unavailable' }); return this.auth; }
    const v = AccountClient.view(r.data);
    this.set(v ? { state: 'signed-in', account: v } : { state: 'guest', expired: r.data.session === 'expired' });
    return this.auth;
  }

  private async begin(path: string, body: Json): Promise<AuthResult> {
    if (this.busy) return { ok: false, error: 'other' };
    this.busy = true;
    this.onChange?.(this.auth);
    try {
      const r = await this.call(path, body);
      if (!r) return { ok: false, error: 'unreachable' };
      const v = r.status === 200 || r.status === 201 ? AccountClient.view(r.data) : null;
      if (!v) return { ok: false, ...AccountClient.error(r.status, r.data) };
      this.set({ state: 'signed-in', account: v });
      return { ok: true, account: v };
    } finally { this.idle(); this.onChange?.(this.auth); }
  }

  /** Create an account (the driver name is optional and defaults to the username) and sign in to it. */
  register(username: string, password: string, displayName = ''): Promise<AuthResult> {
    if (displayName.trim()) { const d = checkDisplayName(displayName); if (!d.ok) return Promise.resolve({ ok: false, error: 'invalid_name', detail: d.error }); }
    return this.begin('/api/auth/register', { username: username.trim(), password, ...(displayName.trim() ? { displayName } : {}) });
  }
  login(username: string, password: string): Promise<AuthResult> { return this.begin('/api/auth/login', { username: username.trim(), password }); }

  /**
   * Sign out here. Only the server can revoke the session (the cookie is HttpOnly), so this browser becomes a guest only
   * once the server confirms it did; otherwise the session would still be live and a reload would sign straight back in.
   * Account-scoped client state is forgotten either way, even if the server is unreachable.
   */
  async logout(): Promise<{ ok: true } | { ok: false; error: AuthError }> {
    this.busy = true;
    this.onChange?.(this.auth);
    let r: { status: number; data: Json } | null = null;
    try { r = await this.call('/api/auth/logout', {}); } finally {
      clearAccountState(this.local, this.session);
    }
    if (r && r.status === 200 && r.data.ok === true) { this.set({ state: 'guest', expired: false }); this.idle(); return { ok: true }; }
    // still signed in as far as the server is concerned: say so, and let the driver try again
    this.idle();
    this.onChange?.(this.auth);
    return { ok: false, error: r ? AccountClient.error(r.status, r.data).error : 'unreachable' };
  }

  /** Change the saved driver name. The account (and everything recorded for it) stays the same. */
  async rename(displayName: string): Promise<AuthResult> {
    const d = checkDisplayName(displayName);
    if (!d.ok) return { ok: false, error: 'invalid_name', detail: d.error };
    const cur = this.account;
    if (!cur) return { ok: false, error: 'signed_out' };
    if (this.busy) return { ok: false, error: 'other' };
    this.busy = true;
    this.onChange?.(this.auth);
    try {
      // the server renames only the account this form was opened for, never whoever the cookie names by now
      const r = await this.call('/api/profile', { displayName: d.name, expectAccount: cur.id });
      if (!r) return { ok: false, error: 'unreachable' };
      if (r.status !== 200) {
        const e = AccountClient.error(r.status, r.data);
        // the session ended (elsewhere, by expiry or an owner reset): this browser is a guest again
        if (e.error === 'session_expired' || e.error === 'signed_out') { clearAccountState(this.local, this.session); this.set({ state: 'guest', expired: true }); }
        // another identity holds the cookie now: find out which, so this tab stops showing the old one
        if (e.error === 'identity_changed') { this.idle(); await this.restore({ keep: true }); }
        return { ok: false, ...e };
      }
      const p = r.data.profile as Json | undefined;
      const acct = { ...cur, displayName: typeof p?.displayName === 'string' ? p.displayName : d.name };
      // a sign-out or switch while this was in flight wins
      if (this.account?.id === cur.id) this.set({ state: 'signed-in', account: acct });
      return { ok: true, account: acct };
    } finally { this.idle(); this.onChange?.(this.auth); }
  }
}
