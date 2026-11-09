// Username/password accounts. Passwords are hashed with Argon2id (the maintained `argon2` package) with parameters sized for
// a small shared host; hashing runs one at a time on the libuv pool so it never stalls the race tick loop. No email or other
// contact detail is collected; recovery is the owner's `admin reset-password` (server/admin.ts).
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/** OWASP's minimum Argon2id profile (19 MiB, t=2, p=1): about 20-60 ms and 19 MiB per hash, one hash at a time. */
export const HASH_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const MAX_WAITING = 16;

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
export function checkUsername(u: unknown): string | null { return typeof u === 'string' && USERNAME_RE.test(u) ? null : 'username: 3-20 letters, digits, _ or -'; }
export function checkPassword(p: unknown): string | null {
  if (typeof p !== 'string') return 'password required';
  const n = [...p].length;
  return n < 10 || n > 128 ? 'password: 10-128 characters' : null;
}

export class Busy extends Error {}

/** One hash at a time; a bounded queue, so a login flood is refused instead of exhausting memory. */
class Gate {
  private running = false;
  private q: (() => void)[] = [];
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.q.length >= MAX_WAITING) throw new Busy('busy');
      await new Promise<void>((res) => this.q.push(res));
    }
    this.running = true;
    try { return await f(); } finally { this.running = false; this.q.shift()?.(); }
  }
}

export interface Account { id: string; username: string; }
export interface Profile { accountId: string; displayName: string; updatedAt: string | null; }

export class Accounts {
  private gate = new Gate();
  private dummy: Promise<string>;
  constructor(private pool: Pool) {
    this.dummy = argon2.hash(randomBytes(16).toString('hex'), HASH_OPTS);
  }
  hash(pw: string): Promise<string> { return this.gate.run(() => argon2.hash(pw, HASH_OPTS)); }
  private verifyHash(h: string, pw: string): Promise<boolean> { return this.gate.run(() => argon2.verify(h, pw)); }

  /**
   * Create an account and its driver profile in one statement. Returns null when the username is taken (case-insensitively);
   * a concurrent duplicate is settled by the unique key, never by a check-then-insert race. `displayName` must already be
   * checked (checkDisplayName); it defaults to the username.
   */
  async register(username: string, password: string, displayName?: string): Promise<Account | null> {
    const h = await this.hash(password);
    const key = username.toLowerCase();
    const r = await this.pool.query<{ id: string; username: string }>(
      `WITH a AS (
         INSERT INTO accounts (username, username_key, password_hash) VALUES ($1, $1, $2) ON CONFLICT (username_key) DO NOTHING RETURNING id, username
       ), p AS (
         INSERT INTO profiles (account_id, display_name) SELECT id, $3 FROM a RETURNING account_id
       )
       SELECT a.id::text AS id, a.username FROM a JOIN p ON p.account_id = a.id`,
      [key, h, displayName ?? key.slice(0, 16)],
    );
    return r.rows[0] ?? null;
  }

  /** Check a login. Unknown users cost the same hash work as known ones, so timing does not reveal which names exist. */
  async login(username: string, password: string): Promise<Account | null> {
    const r = await this.pool.query<{ id: string; username: string; password_hash: string }>(
      'SELECT id::text, username, password_hash FROM accounts WHERE username_key = $1', [username.toLowerCase()]);
    const row = r.rows[0];
    const ok = await this.verifyHash(row?.password_hash ?? (await this.dummy), password);
    if (!row || !ok) return null;
    if (argon2.needsRehash(row.password_hash, HASH_OPTS)) {
      const h = await this.hash(password);
      await this.pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [row.id, h]);
    }
    return { id: row.id, username: row.username };
  }

  async byId(id: string): Promise<Account | null> {
    const r = await this.pool.query<Account>('SELECT id::text, username FROM accounts WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }

  /**
   * The driver profile of an account (the caller passes the id from the authenticated session, never from a request). An
   * account without a profile row (made by a release before migration 002) reads as its username.
   */
  async profile(accountId: string): Promise<Profile | null> {
    const r = await this.pool.query<{ id: string; display_name: string; updated_at: Date | null }>(
      `SELECT a.id::text, COALESCE(p.display_name, left(a.username, 16)) AS display_name, p.updated_at
       FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id WHERE a.id = $1`, [accountId]);
    const row = r.rows[0];
    return row ? { accountId: row.id, displayName: row.display_name, updatedAt: row.updated_at?.toISOString() ?? null } : null;
  }

  /** Rename: only the display name changes. The account id, and anything recorded against it, stay as they are. */
  async setDisplayName(accountId: string, displayName: string): Promise<Profile | null> {
    const r = await this.pool.query<{ account_id: string; display_name: string; updated_at: Date }>(
      `INSERT INTO profiles (account_id, display_name) SELECT id, $2 FROM accounts WHERE id = $1
       ON CONFLICT (account_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING account_id::text, display_name, updated_at`, [accountId, displayName]);
    const row = r.rows[0];
    return row ? { accountId: row.account_id, displayName: row.display_name, updatedAt: row.updated_at.toISOString() } : null;
  }

  /** Owner-run recovery: set a new password and revoke every session of the account. False when no such account. */
  async resetPassword(username: string, password: string): Promise<{ ok: boolean; revoked: number }> {
    const h = await this.hash(password);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query<{ id: string }>('UPDATE accounts SET password_hash = $2, password_changed_at = now() WHERE username_key = $1 RETURNING id::text', [username.toLowerCase(), h]);
      if (!u.rows[0]) { await c.query('ROLLBACK'); return { ok: false, revoked: 0 }; }
      const d = await c.query('DELETE FROM sessions WHERE account_id = $1', [u.rows[0].id]);
      await c.query('COMMIT');
      return { ok: true, revoked: d.rowCount ?? 0 };
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
}
