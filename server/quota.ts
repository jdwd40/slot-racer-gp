// Room creation allowance (#52). The room cap is small (6 by default) and an idle lobby lives for 30 minutes, so without
// this one client address could fill every room with a handful of create messages and lock everyone else out.
//
// A room is charged, when it is created, to its creator's address and (if signed in) account, and stays charged to them
// until it closes, whoever hosts it by then and whatever the creator does meanwhile: signing in or out, opening new
// sockets, disconnecting, resuming or leaving changes nothing, so none of them resets the allowance, and closing is the only
// release (every way a room ends goes through Room.close). Joining is never charged, so any number of people behind one
// address (a household, a school) can share one room.
//
// Guests have no identity of their own (a new socket is a new guest), so the address is what bounds them; the account
// limit bounds a signed-in player who also has several addresses (phone and Wi-Fi). The address is the one the WebSocket
// layer established (X-Real-IP only from the loopback Nginx: server/app.ts), never anything the client sends.
import type { ErrorCode } from '../src/net/protocol';

export interface QuotaLimits {
  /** rooms open at once per address / per account */
  perIp: number; perAccount: number;
  /** rooms created per address and per account in any `windowMs` (a sliding window, so no boundary allows a double burst) */
  creates: number; windowMs: number;
}
export type QuotaRefusal = { ok: false; code: ErrorCode; detail: string };

/** Bookkeeping kept for keys that are not charged with an open room: at most this many, oldest dropped first. */
const MAX_KEYS = 10000;

export class CreateQuota {
  /** open rooms charged per key */
  private open = new Map<string, number>();
  /** the keys each open room is charged to (by room id), so releasing it needs nothing from the room */
  private held = new Map<string, readonly string[]>();
  /** creation times within the window, oldest first, per key; never longer than `creates` */
  private recent = new Map<string, number[]>();

  constructor(private lim: QuotaLimits, private now: () => number) {}

  /** The keys a create from this address and account is charged to. */
  static keys(ip: string, accountId: string | null): string[] { return accountId ? [`ip:${ip}`, `acct:${accountId}`] : [`ip:${ip}`]; }

  /** Why a create with these keys may not happen now, or null. Nothing is counted: only rooms actually created are. */
  check(keys: readonly string[]): QuotaRefusal | null {
    for (const k of keys) {
      const max = k.startsWith('acct:') ? this.lim.perAccount : this.lim.perIp;
      if ((this.open.get(k) ?? 0) >= max) {
        // `unavailable`, the room-cap code: to this client the server has no room free until one of its own closes, and the
        // browser already explains that as "no room free right now, try again in a minute"
        return { ok: false, code: 'unavailable', detail: `${max} open room${max === 1 ? '' : 's'} per ${k.startsWith('acct:') ? 'account' : 'address'} at most: leave one or try again later` };
      }
    }
    for (const k of keys) {
      const ts = this.window(k);
      if (ts && ts.length >= this.lim.creates) {
        const waitS = Math.max(1, Math.ceil((ts[0] + this.lim.windowMs - this.now()) / 1000));
        return { ok: false, code: 'rate', detail: `too many new rooms: try again in ${waitS} s` };
      }
    }
    return null;
  }

  /** Charge a room that was created (and entered by its creator) to these keys. */
  charge(roomId: string, keys: readonly string[]): void {
    const now = this.now();
    this.held.set(roomId, keys);
    for (const k of keys) {
      this.open.set(k, (this.open.get(k) ?? 0) + 1);
      const ts = this.window(k) ?? [];
      ts.push(now);
      // re-inserted, so the Map's order is least recently used first for pruning
      this.recent.delete(k); this.recent.set(k, ts);
    }
    this.prune();
  }

  /** The room closed: its keys get their allowance back. Idempotent; a room never charged is a no-op. */
  release(roomId: string): void {
    const keys = this.held.get(roomId);
    if (!keys) return;
    this.held.delete(roomId);
    for (const k of keys) { const n = (this.open.get(k) ?? 1) - 1; if (n > 0) this.open.set(k, n); else this.open.delete(k); }
  }

  /** Open rooms charged to a key (tests, diagnostics). */
  openFor(key: string): number { return this.open.get(key) ?? 0; }
  /** Keys with any bookkeeping (tests: memory stays bounded). */
  get trackedKeys(): number { return new Set([...this.open.keys(), ...this.recent.keys()]).size; }

  /** This key's creation times still inside the window (expired ones dropped), or undefined. */
  private window(k: string): number[] | undefined {
    const ts = this.recent.get(k);
    if (!ts) return undefined;
    const from = this.now() - this.lim.windowMs;
    let i = 0; while (i < ts.length && ts[i] <= from) i++;
    if (i) ts.splice(0, i);
    if (!ts.length) { this.recent.delete(k); return undefined; }
    return ts;
  }

  /** Bound the rate bookkeeping: drop expired windows, then the least recently used, never more than MAX_KEYS. */
  private prune(): void {
    if (this.recent.size <= MAX_KEYS) return;
    for (const k of [...this.recent.keys()]) this.window(k);
    for (const k of this.recent.keys()) { if (this.recent.size <= MAX_KEYS) break; this.recent.delete(k); }
  }
}
