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
  async prune(): Promise<number> {
    const r = await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()').catch(() => null);
    return r?.rowCount ?? 0;
  }
  close(): void { if (this.pruneTimer) clearInterval(this.pruneTimer); }
}
