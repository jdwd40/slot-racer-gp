// express-session store on the game's PostgreSQL database. The account id is kept in its own column so the owner's password
// reset can revoke every session of that account in one statement.
import session from 'express-session';
import type { Pool } from 'pg';

export interface SessionAccount { id: string; username: string; }
declare module 'express-session' {
  interface SessionData { account?: SessionAccount; }
}

const DAY = 86400000;

export class PgSessionStore extends session.Store {
  private pruneTimer: NodeJS.Timeout | null = null;
  constructor(private pool: Pool, pruneEveryMs = 15 * 60000) {
    super();
    if (pruneEveryMs > 0) { this.pruneTimer = setInterval(() => { void this.prune(); }, pruneEveryMs); this.pruneTimer.unref(); }
  }
  private expiry(s: session.SessionData): Date {
    const e = s.cookie?.expires;
    return e ? new Date(e) : new Date(Date.now() + DAY);
  }
  override get(sid: string, cb: (err: unknown, s?: session.SessionData | null) => void): void {
    this.pool.query<{ sess: session.SessionData }>('SELECT sess FROM sessions WHERE sid = $1 AND expires_at > now()', [sid])
      .then((r) => cb(null, r.rows[0]?.sess ?? null), (e) => cb(e));
  }
  override set(sid: string, s: session.SessionData, cb?: (err?: unknown) => void): void {
    this.pool.query(
      `INSERT INTO sessions (sid, account_id, sess, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sid) DO UPDATE SET account_id = EXCLUDED.account_id, sess = EXCLUDED.sess, expires_at = EXCLUDED.expires_at`,
      [sid, s.account?.id ?? null, JSON.stringify(s), this.expiry(s)],
    ).then(() => cb?.(), (e) => cb?.(e));
  }
  override destroy(sid: string, cb?: (err?: unknown) => void): void {
    this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => cb?.(), (e) => cb?.(e));
  }
  override touch(sid: string, s: session.SessionData, cb?: (err?: unknown) => void): void {
    this.pool.query('UPDATE sessions SET expires_at = $2 WHERE sid = $1', [sid, this.expiry(s)]).then(() => cb?.(), (e) => cb?.(e));
  }
  /**
   * Of these (session, account) bindings, the session IDs that still exist, have not expired and still belong to that
   * account. Logout, a new sign-in (which replaces the session ID), expiry and the owner's password reset all drop a
   * session from this set; WebSockets bound to it lose their sign-in.
   */
  async live(bindings: readonly { sid: string; accountId: string }[]): Promise<Set<string>> {
    if (!bindings.length) return new Set();
    const r = await this.pool.query<{ sid: string }>(
      `SELECT s.sid FROM sessions s JOIN unnest($1::text[], $2::bigint[]) AS b(sid, account_id) ON s.sid = b.sid AND s.account_id = b.account_id
       WHERE s.expires_at > now()`,
      [bindings.map((b) => b.sid), bindings.map((b) => b.accountId)],
    );
    return new Set(r.rows.map((x) => x.sid));
  }
  async prune(): Promise<number> {
    const r = await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()').catch(() => null);
    return r?.rowCount ?? 0;
  }
  close(): void { if (this.pruneTimer) clearInterval(this.pruneTimer); }
}
