// HTTP (/api) and WebSocket (/ws) front of the room server. Behind Nginx on the same origin as the static game, so there is
// no CORS: state-changing requests and WebSocket upgrades must carry an allowed Origin. Listens on loopback only.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import session from 'express-session';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Pool } from 'pg';
import { LIMITS, PROTOCOL_NAME, PROTOCOL_VERSION, RULES_VERSION, checkDisplayName, parseClientMessage, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { Accounts, Busy, checkPassword, checkUsername } from './accounts';
import type { Config } from './config';
import { dbErrorFields } from './db';
import type { Logger } from './log';
import { schemaStatus, SCHEMA_VERSION } from './migrations';
import type { Peer, Room } from './room';
import type { RoomManager } from './rooms';
import { PgSessionStore, type SessionAccount } from './sessionStore';
import { makeScoring, type Scoring } from './career';
import { careerStats } from './stats';
import { limitKey } from './netkey';
import type { DurationStats } from './tickstats';

export interface AppDeps {
  cfg: Config; log: Logger; manager: RoomManager; pool?: Pool | null;
  /** how often signed-in sockets re-check their session (ms); tests shorten it */
  sessionCheckMs?: number;
  /** career points policy shown with the stats (server/career.ts) */
  scoring?: Scoring;
  /** results waiting in the durable queue (server/spool.ts), for health */
  pendingResults?: () => number;
  /** of those, results held in memory only (the spool could not take them): lost on a restart, so worth an alert */
  unsavedResults?: () => number;
}
export interface App {
  server: http.Server;
  wss: WebSocketServer;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  connections(): number;
}

type Req = IncomingMessage & { session?: session.Session & Partial<session.SessionData>; sessionID?: string; originalUrl?: string };

/** A WebSocket's sign-in: the session it was opened with. It lasts only as long as that session does. */
interface SocketAuth { readonly sid: string; readonly account: SessionAccount; end(): void; }

const BODY_MAX = 4096;
const MAX_RATE_STRIKES = 3;
const SESSION_CHECK_MS = 10000;
const COOKIE = 'srsid';

/** A fixed-window counter per key (an address, a username, an account): at most `max` hits per `ms`. Memory is bounded. */
export class RateWindow {
  private m = new Map<string, { n: number; until: number }>();
  constructor(private max: number, private ms: number, private now: () => number = () => Date.now()) {}
  /** true when this key is already at its limit (nothing is counted) */
  blocked(key: string): boolean { const f = this.m.get(key); return !!f && f.until > this.now() && f.n >= this.max; }
  /** count one hit; false when the key was already at its limit */
  hit(key: string): boolean {
    const now = this.now();
    if (this.m.size > 10000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k);
    const f = this.m.get(key);
    if (!f || f.until <= now) { this.m.set(key, { n: 1, until: now + this.ms }); return true; }
    if (f.n >= this.max) return false;
    f.n++;
    return true;
  }
  clear(key: string): void { this.m.delete(key); }
}

export function createApp({ cfg, log, manager, pool = null, sessionCheckMs = SESSION_CHECK_MS, scoring = makeScoring(cfg.careerPoints), pendingResults = () => 0, unsavedResults = () => 0 }: AppDeps): App {
  const started = Date.now();
  const accounts = pool ? new Accounts(pool) : null;
  const store = pool ? new PgSessionStore(pool) : null;
  const sessions = pool && store ? session({
    store, secret: cfg.sessionSecret!, name: COOKIE, resave: false, saveUninitialized: false, rolling: false, proxy: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, maxAge: 30 * 86400000, path: '/' },
  }) : null;
  const perIp = new Map<string, number>();
  // registration per address, failed sign-ins per username (on top of the per-address failure limit), renames per account
  const registrations = new RateWindow(10, 3600000, manager.now);
  const userFails = new RateWindow(10, 15 * 60000, manager.now);
  const renames = new RateWindow(10, 60000, manager.now);
  let conns = 0;
  /** every open signed-in socket, so a session that ends also ends the sign-in of the sockets opened with it */
  const signedIn = new Set<SocketAuth>();
  const endSession = (sid: string | undefined): void => { if (sid) for (const a of [...signedIn]) if (a.sid === sid) a.end(); };

  const clientIp = (req: IncomingMessage): string => {
    const remote = req.socket.remoteAddress ?? '';
    // only the local Nginx is trusted to name the client
    const fwd = req.headers['x-real-ip'];
    if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && typeof fwd === 'string' && fwd.length < 64) return fwd;
    return remote;
  };
  const originOk = (req: IncomingMessage): boolean => typeof req.headers.origin === 'string' && cfg.allowedOrigins.includes(req.headers.origin);
  /** Load the request's session. Rejects when the store cannot be read: that is not an expired session. */
  const runSession = (req: Req, res: ServerResponse | object): Promise<void> => new Promise((resolve, reject) => {
    if (!sessions) { resolve(); return; }
    req.originalUrl = req.url;
    sessions(req as never, res as never, (err?: unknown) => { if (err) reject(err); else resolve(); });
  });
  /**
   * runSession for an HTTP request. If the store cannot be read, answer 503 and keep the cookie: nobody knows the session
   * ended, so neither this response nor the client may treat it as a sign-out.
   */
  const loadSession = async (req: Req, res: ServerResponse): Promise<boolean> => {
    try { await runSession(req, res); return true; } catch (e) {
      log.error('session.read_failed', { error: String(e) });
      json(res, 503, { error: 'unavailable' });
      return false;
    }
  };

  // ---------------------------------------------------------------------------------------------- HTTP
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s), 'x-content-type-options': 'nosniff' });
    res.end(s);
  };
  const readBody = (req: IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    let over = false;
    req.on('data', (c: Buffer) => { if (over) return; n += c.length; if (n > BODY_MAX) { over = true; reject(new Error('too_large')); } else chunks.push(c); });
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('malformed')); } });
    req.on('error', reject);
  });

  /** One tick statistic for health: the rolling window and process totals, plus the totals' buckets (for interval diffs). */
  const durationReport = (d: DurationStats) => ({
    unit: 'ms', windowS: d.windowMs / 1000, recent: d.recent().summary(), total: d.total.summary(), totalBuckets: d.total.buckets(),
  });

  async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
    let db: 'disabled' | 'ok' | 'down' | 'outdated' = 'disabled';
    if (pool) {
      try { db = (await schemaStatus(pool)).current ? 'ok' : 'outdated'; } catch { db = 'down'; }
    }
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const st = manager.stats();
    const ok = db === 'disabled' || db === 'ok';
    return {
      status: ok ? 200 : 503,
      body: {
        ok, service: 'slotrush-server', version: cfg.version, protocol: PROTOCOL_VERSION, rules: RULES_VERSION, schema: SCHEMA_VERSION,
        accounts: !!accounts, profiles: !!accounts, career: !!accounts, db, scoring: scoring.version, pendingResults: pendingResults(), unsavedResults: unsavedResults(), uptimeS: Math.round((Date.now() - started) / 1000),
        rooms: st.rooms, roomCap: cfg.roomCap, racing: st.racing, humans: st.humans, connections: conns, maxConnections: cfg.maxConnections,
        // tickMaxMs keeps its historical name and meaning: the decayed recent-load signal admission uses (also tickLoadMs).
        // It is not a peak; true peaks and percentiles are in `ticks` and `tickLag` (#54, docs/online-server.md)
        tickMaxMs: Math.round(manager.tickLoadMs * 10) / 10, tickLoadMs: Math.round(manager.tickLoadMs * 1000) / 1000,
        rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
        cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000),
        ticks: durationReport(manager.ticks), tickLag: durationReport(manager.tickLag),
      },
    };
  }

  async function onRequest(req: Req, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/api/health') { const h = await health(); json(res, h.status, h.body); return; }
      if (req.method === 'GET' && url === '/api/version') { json(res, 200, { service: 'slotrush-server', version: cfg.version, protocol: PROTOCOL_VERSION, rules: RULES_VERSION, schema: SCHEMA_VERSION }); return; }
      if (url.startsWith('/api/auth/')) { await auth(req, res, url.slice('/api/auth/'.length)); return; }
      if (url === '/api/profile') { await profile(req, res); return; }
      if (url === '/api/profile/stats') { await stats(req, res); return; }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error('http.error', { url, error: String(e) });
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  }

  /** The session cookie came with the request but names no live session: it expired, was revoked or was signed out. */
  const sentCookie = (req: Req): boolean => new RegExp(`(?:^|;\\s*)${COOKIE}=`).test(String(req.headers.cookie ?? ''));
  const staleCookie = (req: Req): boolean => !req.session?.account && sentCookie(req);
  const clearCookie = (res: ServerResponse): void => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${cfg.cookieSecure ? '; Secure' : ''}`);
  };
  /** A state-changing request: same origin and JSON only, so a cross-site form or script can do nothing with the cookie. */
  const writeGuard = (req: Req, res: ServerResponse): boolean => {
    if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return false; }
    if (!originOk(req)) { json(res, 403, { error: 'origin' }); return false; }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: 'content_type' }); return false; }
    return true;
  };
  const body = async (req: Req, res: ServerResponse, allowed: readonly string[]): Promise<Record<string, unknown> | null> => {
    let b: unknown;
    try { b = await readBody(req); } catch (e) { json(res, (e as Error).message === 'too_large' ? 413 : 400, { error: (e as Error).message }); return null; }
    // unknown fields (an accountId, an email...) are refused, never ignored: identity only ever comes from the session
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !allowed.includes(k))) { json(res, 400, { error: 'malformed' }); return null; }
    return b as Record<string, unknown>;
  };
  const publicProfile = (p: { displayName: string; updatedAt: string | null }) => ({ displayName: p.displayName, updatedAt: p.updatedAt });

  async function auth(req: Req, res: ServerResponse, what: string): Promise<void> {
    if (!accounts) { json(res, 503, { error: 'accounts_unavailable' }); return; }
    if (!await loadSession(req, res)) return;
    const s = req.session!;
    if (req.method === 'GET' && what === 'me') {
      if (!s.account) {
        const expired = staleCookie(req);
        if (expired) clearCookie(res);
        json(res, 200, { account: null, session: expired ? 'expired' : 'none' });
        return;
      }
      const p = await accounts.profile(s.account.id);
      if (!p) {
        // the account was deleted under a live session: end it
        const sid = req.sessionID;
        await new Promise<void>((r) => s.destroy(() => r()));
        endSession(sid); clearCookie(res);
        json(res, 200, { account: null, session: 'expired' });
        return;
      }
      json(res, 200, { account: { id: s.account.id, username: s.account.username }, profile: publicProfile(p), session: 'active' });
      return;
    }
    if (!writeGuard(req, res)) return;
    if (what === 'logout') {
      const sid = req.sessionID;
      // only confirm a sign-out the store actually carried out: the client stays signed in until it hears ok
      const err = await new Promise<unknown>((r) => s.destroy((e) => r(e)));
      if (err) { log.error('auth.logout_failed', { error: String(err) }); json(res, 503, { error: 'unavailable' }); return; }
      endSession(sid);
      clearCookie(res);
      json(res, 200, { ok: true });
      return;
    }
    if (what !== 'register' && what !== 'login') { json(res, 404, { error: 'not_found' }); return; }
    const b = await body(req, res, what === 'register' ? ['username', 'password', 'displayName'] : ['username', 'password']);
    if (!b) return;
    const bad = checkUsername(b.username) ?? checkPassword(b.password);
    if (bad) { json(res, 400, { error: 'invalid', detail: bad }); return; }
    let displayName: string | undefined;
    if (what === 'register' && b.displayName !== undefined && b.displayName !== '') {
      const d = checkDisplayName(b.displayName);
      if (!d.ok) { json(res, 400, { error: 'invalid_name', detail: d.error }); return; }
      displayName = d.name;
    }
    const ip = limitKey(clientIp(req));   // the address's limit key: its /64 for IPv6 (server/netkey.ts)
    const ukey = (b.username as string).toLowerCase();
    if (manager.limited(`auth:${ip}`) || (what === 'login' && userFails.blocked(ukey))) { json(res, 429, { error: 'rate' }); return; }
    if (what === 'register' && !registrations.hit(ip)) { json(res, 429, { error: 'rate' }); return; }
    let acct;
    try {
      acct = what === 'register' ? await accounts.register(b.username as string, b.password as string, displayName) : await accounts.login(b.username as string, b.password as string);
    } catch (e) {
      if (e instanceof Busy) { json(res, 503, { error: 'busy' }); return; }
      throw e;
    }
    if (!acct) {
      noteAuthFail(ip);
      if (what === 'login') userFails.hit(ukey);
      json(res, what === 'register' ? 409 : 401, { error: what === 'register' ? 'username_taken' : 'invalid_credentials' });
      return;
    }
    if (what === 'login') userFails.clear(ukey);
    // a fresh session ID on every sign-in (no session fixation); the replaced session, and its sockets' sign-in, end.
    // The browser is told it is signed in only once the new session is stored: a reply that claimed it without the row
    // would hand out a cookie that names nothing, and the next /me would already say "expired" (#51).
    const oldSid = req.sessionID;
    const failed = (step: 'regenerate' | 'save', err: unknown, oldEnded: boolean): void => {
      log.error('auth.session_failed', { step, flow: what, account: acct.id, ...dbErrorFields(err, cfg.databaseUrl) });
      // drop the unsaved session from this request, so express-session neither retries the write when the response ends
      // nor sets a cookie for it
      req.session = undefined;
      // once the old row was deleted, the browser's cookie (if it sent one) names nothing: clear it, not leave it stale
      if (oldEnded && sentCookie(req)) clearCookie(res);
      // the account itself exists (a registration was committed): say so, so the player signs in rather than registers again
      json(res, 503, what === 'register' ? { error: 'unavailable', detail: 'account_created' } : { error: 'unavailable' });
    };
    // regeneration deletes the old session row first. If that fails nobody knows whether it went, so the old session is
    // left as it was (its cookie kept, its sockets signed in: the periodic check ends them if the row did go)
    const regenErr = await new Promise<unknown>((r) => s.regenerate((e) => r(e)));
    if (regenErr) { failed('regenerate', regenErr, false); return; }
    endSession(oldSid);
    req.session!.account = { id: acct.id, username: acct.username };
    // a failed save leaves no usable session (the old one is already gone). An INSERT that did commit despite the error
    // left a row whose ID was never sent to anyone; it expires and is pruned like any other.
    const saveErr = await new Promise<unknown>((r) => req.session!.save((e) => r(e)));
    if (saveErr) { failed('save', saveErr, true); return; }
    log.info(what === 'register' ? 'account.register' : 'account.login', { account: acct.id });
    // the session is stored, so this sign-in did happen: a profile that cannot be read now must not turn it into an error
    // (a 500 that still sets the live cookie); the browser falls back to the username and reads the profile again later
    const p = await accounts.profile(acct.id).catch((e: unknown) => { log.warn('auth.profile_read_failed', { account: acct.id, ...dbErrorFields(e, cfg.databaseUrl) }); return null; });
    json(res, what === 'register' ? 201 : 200, { account: { id: acct.id, username: acct.username }, profile: p ? publicProfile(p) : null, session: 'active' });
  }

  /**
   * The signed-in driver's own profile. The account is always the session's: a request cannot name another account (an
   * `accountId` field is refused as malformed), so nobody can read or change somebody else's profile.
   */
  async function profile(req: Req, res: ServerResponse): Promise<void> {
    if (!accounts) { json(res, 503, { error: 'accounts_unavailable' }); return; }
    if (req.method !== 'GET' && !writeGuard(req, res)) return;
    if (!await loadSession(req, res)) return;
    const acct = req.session?.account;
    if (!acct) {
      const expired = staleCookie(req);
      if (expired) clearCookie(res);
      json(res, 401, { error: expired ? 'session_expired' : 'signed_out' });
      return;
    }
    if (req.method === 'GET') {
      const p = await accounts.profile(acct.id);
      if (!p) { json(res, 401, { error: 'session_expired' }); return; }
      json(res, 200, { profile: publicProfile(p) });
      return;
    }
    const b = await body(req, res, ['displayName', 'expectAccount']);
    if (!b) return;
    // the form was opened for another identity (signed out and in again in another tab): never rename this one from it
    if (b.expectAccount !== undefined && b.expectAccount !== acct.id) { json(res, 409, { error: 'identity_changed' }); return; }
    const d = checkDisplayName(b.displayName);
    if (!d.ok) { json(res, 400, { error: 'invalid_name', detail: d.error }); return; }
    if (!renames.hit(acct.id)) { json(res, 429, { error: 'rate' }); return; }
    const p = await accounts.setDisplayName(acct.id, d.name);
    if (!p) { json(res, 401, { error: 'session_expired' }); return; }
    log.info('profile.rename', { account: acct.id });
    json(res, 200, { profile: publicProfile(p) });
  }
  /**
   * The signed-in driver's career, read-only. There is no write endpoint for points, positions or bests: they are only ever
   * written by the result sink from a server-finalized race (server/results.ts). Any other method is refused.
   */
  async function stats(req: Req, res: ServerResponse): Promise<void> {
    if (!accounts || !pool) { json(res, 503, { error: 'accounts_unavailable' }); return; }
    if (req.method !== 'GET') { json(res, 405, { error: 'method' }); return; }
    if (!await loadSession(req, res)) return;
    const acct = req.session?.account;
    if (!acct) {
      const expired = staleCookie(req);
      if (expired) clearCookie(res);
      json(res, 401, { error: expired ? 'session_expired' : 'signed_out' });
      return;
    }
    let body;
    try {
      const p = await accounts.profile(acct.id);
      if (!p) { json(res, 401, { error: 'session_expired' }); return; }
      body = { account: acct.id, stats: await careerStats(pool, acct.id, p.displayName, scoring) };
    } catch (e) { log.error('stats.read_failed', { error: String(e) }); json(res, 503, { error: 'unavailable' }); return; }
    json(res, 200, body);
  }
  const noteAuthFail = (ip: string): void => manager.noteFailure(`auth:${ip}`);

  const server = http.createServer((req, res) => { void onRequest(req as Req, res); });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;

  // ---------------------------------------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes * 2, perMessageDeflate: false, clientTracking: true });

  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req: Req, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const url = (req.url ?? '/').split('?')[0];
    if (url !== '/ws') { reject(socket, 404, 'Not Found'); return; }
    if (!originOk(req)) { log.warn('ws.origin_rejected', { origin: String(req.headers.origin ?? '').slice(0, 100) }); reject(socket, 403, 'Forbidden'); return; }
    const ip = clientIp(req);
    // connections are counted per limit key (an IPv6 /64, an IPv4 address: server/netkey.ts); the room layer keys `ip` itself
    const key = limitKey(ip);
    if (conns >= cfg.maxConnections || (perIp.get(key) ?? 0) >= cfg.maxConnectionsPerIp) { reject(socket, 503, 'Service Unavailable'); return; }
    conns++; perIp.set(key, (perIp.get(key) ?? 0) + 1);
    let counted = true;
    const release = (): void => { if (!counted) return; counted = false; conns--; const n = (perIp.get(key) ?? 1) - 1; if (n > 0) perIp.set(key, n); else perIp.delete(key); };
    socket.once('close', release);
    void runSession(req, {}).then(() => {
      const acct = req.session?.account ?? null;
      const sid = acct ? req.sessionID ?? null : null;
      wss.handleUpgrade(req, socket, head, (ws) => { ws.once('close', release); connection(ws, ip, acct && sid ? { sid, account: acct } : null); });
    }, (e: unknown) => { log.error('session.read_failed', { error: String(e) }); release(); reject(socket, 503, 'Service Unavailable'); });
  });

  // keepalive: a ping every 25 s keeps idle lobby sockets inside Nginx's proxy_read_timeout, and a peer that misses a pong
  // (dead TCP, sleeping phone) is terminated, which starts its seat's reconnect grace
  const alive = new WeakMap<WebSocket, boolean>();
  const keepalive = setInterval(() => {
    for (const c of wss.clients) {
      if (alive.get(c) === false) { c.terminate(); continue; }
      alive.set(c, false);
      try { c.ping(); } catch { c.terminate(); }
    }
  }, 25000);
  keepalive.unref();

  // Sessions end outside this process too (the owner's password reset, expiry), so signed-in sockets re-check theirs. A
  // database error ends nobody's sign-in; room entry checks again on its own.
  let checking = false;
  const sessionCheck = store ? setInterval(() => {
    if (checking || !signedIn.size) return;
    checking = true;
    const list = [...signedIn];
    store.live(list.map((a) => ({ sid: a.sid, accountId: a.account.id })))
      .then((live) => { for (const a of list) if (!live.has(a.sid)) a.end(); }, (e: unknown) => log.warn('ws.session_check_failed', { error: String(e) }))
      .finally(() => { checking = false; });
  }, sessionCheckMs) : null;
  sessionCheck?.unref();

  function connection(ws: WebSocket, ip: string, signIn: { sid: string; account: SessionAccount } | null): void {
    alive.set(ws, true);
    // the socket's sign-in: dropped (and the socket closed) as soon as its session ends, so a revoked or expired session
    // never creates, joins or resumes an account seat, and never keeps driving one
    let auth: SocketAuth | null = null;
    if (signIn) {
      const a: SocketAuth = {
        ...signIn,
        end: () => {
          if (auth !== a) return;
          auth = null; signedIn.delete(a);
          log.info('ws.session_ended', { account: a.account.id });
          send({ t: 'bye', code: 'expired', detail: 'session' });
          ws.close(4003, 'session');
        },
      };
      auth = a; signedIn.add(a);
    }
    /** messages that arrived while a room entry waits on its session check: handled after it, in order */
    let backlog: ClientMsg[] | null = null;
    ws.on('pong', () => alive.set(ws, true));
    let hello = false;
    let room: Room | null = null;
    let pid: string | null = null;
    let tokens = cfg.msgBurst, refill = performance.now(), strikes = 0, lastRateNack = 0;
    const peer: Peer = {
      send: (d) => ws.send(d),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    const send = (m: ServerMsg): void => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const helloTimer = setTimeout(() => { if (!hello) { send({ t: 'bye', code: 'hello_required' }); ws.close(4000, 'hello_required'); } }, LIMITS.helloTimeoutMs);
    helloTimer.unref();

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const t = performance.now();
      tokens = Math.min(cfg.msgBurst, tokens + ((t - refill) / 1000) * cfg.msgRate); refill = t;
      if (tokens < 1) {
        if (t - lastRateNack > 1000) { lastRateNack = t; strikes++; send({ t: 'nack', ref: 'unknown', code: 'rate' }); }
        if (strikes > MAX_RATE_STRIKES) { send({ t: 'bye', code: 'rate' }); ws.close(1008, 'rate'); }
        return;
      }
      tokens--;
      const p = parseClientMessage(isBinary ? null : data.toString('utf8'));
      if (!p.ok) { send({ t: 'nack', ref: p.ref, code: p.code }); return; }
      handle(p.msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (auth) { signedIn.delete(auth); auth = null; }
      if (room && pid) room.disconnect(pid, peer, manager.now());
      room = null; pid = null;
    });
    ws.on('error', () => ws.terminate());

    function bind(r: { ok: true; participant: string; token: string; room: Room }, resumed: boolean): void {
      room = r.room; pid = r.participant;
      send(r.room.joinedMsg(r.participant, r.token, resumed));
      const st = r.room.stateMsg(manager.now());
      if (st && ws.readyState === ws.OPEN) ws.send(st);
      // a driver who lost the link while the race closed missed the one `result` broadcast: replay the same frozen envelope
      if (r.room.state === 'results' && r.room.result) {
        send({ t: 'result', envelope: r.room.result });
        if (r.room.awards) send({ t: 'awards', awards: r.room.awards });
      }
    }

    function handle(m: ClientMsg): void {
      if (backlog) { backlog.push(m); return; }
      const waiting = dispatch(m);
      if (!waiting) return;
      backlog = [];
      void waiting.catch((e: unknown) => { log.error('ws.dispatch_error', { error: String(e) }); ws.terminate(); }).finally(() => {
        const q = backlog ?? [];
        backlog = null;
        for (const x of q) handle(x);
      });
    }

    function dispatch(m: ClientMsg): Promise<void> | void {
      // a message queued behind a session check (the backlog) may replay after the socket closed: a closed socket never
      // creates, joins or resumes a seat (its close already ran, so that seat would never be released)
      if (ws.readyState !== ws.OPEN) return;
      if (!hello) {
        if (m.t !== 'hello') { send({ t: 'nack', ref: m.t, code: 'hello_required' }); return; }
        if (m.v !== PROTOCOL_VERSION || m.proto !== PROTOCOL_NAME) {
          send({ t: 'nack', ref: 'hello', code: 'protocol', detail: `server speaks ${PROTOCOL_NAME} v${PROTOCOL_VERSION}` });
          ws.close(4002, 'protocol');
          return;
        }
        hello = true; clearTimeout(helloTimer);
        send({ t: 'welcome', v: PROTOCOL_VERSION, server: cfg.version, rules: RULES_VERSION, now: manager.now() });
        return;
      }
      if (m.t === 'hello') { send({ t: 'nack', ref: 'hello', code: 'bad_state' }); return; }
      if (m.t === 'ping') { send({ t: 'pong', id: m.id, now: manager.now() }); return; }
      if (room && room.state === 'closed') { room = null; pid = null; }
      if (m.t === 'create' || m.t === 'join' || m.t === 'resume') {
        if (room) { send({ t: 'nack', ref: m.t, code: 'already_in_room' }); return; }
        // the page shows one identity and this socket holds another (its session expired, was reset or replaced before the
        // socket opened): refuse, so a driver the page shows signed in never silently races as a guest, or the reverse
        if (m.t !== 'resume' && m.expectAccount !== undefined && m.expectAccount !== (auth?.account.id ?? '')) {
          send({ t: 'nack', ref: m.t, code: 'expired', detail: 'session' }); return;
        }
        if (!auth) { enter(m, null); return; }
        // a signed-in entry binds the seat to the account: the session must still be live right now
        const a = auth;
        // and an account seat is named from the saved profile, never from the name the client sent
        return store!.live([{ sid: a.sid, accountId: a.account.id }]).then(async (live) => {
          if (ws.readyState !== ws.OPEN || auth !== a) return;
          if (!live.has(a.sid)) { send({ t: 'nack', ref: m.t, code: 'expired', detail: 'session' }); a.end(); return; }
          const prof = m.t === 'resume' ? null : await accounts!.profile(a.account.id);
          if (ws.readyState !== ws.OPEN || auth !== a) return;
          if (m.t !== 'resume' && !prof) { send({ t: 'nack', ref: m.t, code: 'expired', detail: 'session' }); a.end(); return; }
          enter(m, a.account.id, prof?.displayName);
        }).then(undefined, (e: unknown) => {
          log.warn('ws.session_check_failed', { error: String(e) });
          send({ t: 'nack', ref: m.t, code: 'unavailable', detail: 'sign-in check failed, try again' });
        });
      }
      if (!room || !pid) { send({ t: 'nack', ref: m.t, code: 'not_in_room' }); return; }
      const reply = room.handle(pid, m, manager.now());
      if (reply) send(reply);
      if (m.t === 'leave') { room = null; pid = null; }
    }

    function enter(m: Extract<ClientMsg, { t: 'create' | 'join' | 'resume' }>, accountId: string | null, accountName?: string): void {
      const name = m.t === 'resume' ? '' : accountName ?? m.name;
      const r = m.t === 'create'
        ? manager.create(peer, { name, livery: m.livery, accountId, mode: m.mode, settings: m.settings, championship: m.championship, ip })
        : m.t === 'join'
          ? manager.join(peer, ip, { code: m.code, name, livery: m.livery, accountId })
          : manager.resume(peer, ip, m.room, m.participant, m.token, accountId);
      if (!r.ok) { send({ t: 'nack', ref: m.t, code: r.code, ...(r.detail ? { detail: r.detail } : {}) }); return; }
      bind(r, m.t === 'resume');
    }
  }

  return {
    server, wss,
    connections: () => conns,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { const a = server.address(); resolve({ port: typeof a === 'object' && a ? a.port : cfg.port }); });
    }),
    close: async () => {
      clearInterval(keepalive);
      if (sessionCheck) clearInterval(sessionCheck);
      store?.close();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
    },
  };
}
