// HTTP (/api) and WebSocket (/ws) front of the room server. Behind Nginx on the same origin as the static game, so there is
// no CORS: state-changing requests and WebSocket upgrades must carry an allowed Origin. Listens on loopback only.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import session from 'express-session';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Pool } from 'pg';
import { LIMITS, PROTOCOL_NAME, PROTOCOL_VERSION, RULES_VERSION, parseClientMessage, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { Accounts, Busy, checkPassword, checkUsername } from './accounts';
import type { Config } from './config';
import type { Logger } from './log';
import { schemaStatus, SCHEMA_VERSION } from './migrations';
import type { Peer, Room } from './room';
import type { RoomManager } from './rooms';
import { PgSessionStore, type SessionAccount } from './sessionStore';

export interface AppDeps {
  cfg: Config; log: Logger; manager: RoomManager; pool?: Pool | null;
  /** how often signed-in sockets re-check their session (ms); tests shorten it */
  sessionCheckMs?: number;
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

export function createApp({ cfg, log, manager, pool = null, sessionCheckMs = SESSION_CHECK_MS }: AppDeps): App {
  const started = Date.now();
  const accounts = pool ? new Accounts(pool) : null;
  const store = pool ? new PgSessionStore(pool) : null;
  const sessions = pool && store ? session({
    store, secret: cfg.sessionSecret!, name: 'srsid', resave: false, saveUninitialized: false, rolling: false, proxy: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, maxAge: 30 * 86400000, path: '/' },
  }) : null;
  const perIp = new Map<string, number>();
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
  const runSession = (req: Req, res: ServerResponse | object): Promise<void> => new Promise((resolve) => {
    if (!sessions) { resolve(); return; }
    req.originalUrl = req.url;
    sessions(req as never, res as never, () => resolve());
  });

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

  async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
    let db: 'disabled' | 'ok' | 'down' | 'outdated' = 'disabled';
    if (pool) {
      try { db = (await schemaStatus(pool)).current ? 'ok' : 'outdated'; } catch { db = 'down'; }
    }
    const mem = process.memoryUsage();
    const st = manager.stats();
    const ok = db === 'disabled' || db === 'ok';
    return {
      status: ok ? 200 : 503,
      body: {
        ok, service: 'slotrush-server', version: cfg.version, protocol: PROTOCOL_VERSION, rules: RULES_VERSION, schema: SCHEMA_VERSION,
        accounts: !!accounts, db, uptimeS: Math.round((Date.now() - started) / 1000),
        rooms: st.rooms, roomCap: cfg.roomCap, racing: st.racing, humans: st.humans, connections: conns, maxConnections: cfg.maxConnections,
        tickMaxMs: Math.round(manager.tickMaxMs * 10) / 10, rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
      },
    };
  }

  async function onRequest(req: Req, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/api/health') { const h = await health(); json(res, h.status, h.body); return; }
      if (req.method === 'GET' && url === '/api/version') { json(res, 200, { service: 'slotrush-server', version: cfg.version, protocol: PROTOCOL_VERSION, rules: RULES_VERSION, schema: SCHEMA_VERSION }); return; }
      if (url.startsWith('/api/auth/')) { await auth(req, res, url.slice('/api/auth/'.length)); return; }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error('http.error', { url, error: String(e) });
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    }
  }

  async function auth(req: Req, res: ServerResponse, what: string): Promise<void> {
    if (!accounts) { json(res, 503, { error: 'accounts_unavailable' }); return; }
    await runSession(req, res);
    const s = req.session!;
    if (req.method === 'GET' && what === 'me') { json(res, 200, { account: s.account ?? null }); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'method' }); return; }
    // same-origin only: a cross-site form or script cannot sign anybody in or out
    if (!originOk(req)) { json(res, 403, { error: 'origin' }); return; }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 415, { error: 'content_type' }); return; }
    if (what === 'logout') {
      const sid = req.sessionID;
      await new Promise<void>((r) => s.destroy(() => r()));
      endSession(sid);
      json(res, 200, { ok: true });
      return;
    }
    if (what !== 'register' && what !== 'login') { json(res, 404, { error: 'not_found' }); return; }
    let body: Record<string, unknown>;
    try { body = (await readBody(req)) as Record<string, unknown>; } catch (e) { json(res, (e as Error).message === 'too_large' ? 413 : 400, { error: (e as Error).message }); return; }
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'username' && k !== 'password')) { json(res, 400, { error: 'malformed' }); return; }
    const bad = checkUsername(body.username) ?? checkPassword(body.password);
    if (bad) { json(res, 400, { error: 'invalid', detail: bad }); return; }
    const ip = clientIp(req);
    if (manager.limited(`auth:${ip}`)) { json(res, 429, { error: 'rate' }); return; }
    let acct;
    try {
      acct = what === 'register' ? await accounts.register(body.username as string, body.password as string) : await accounts.login(body.username as string, body.password as string);
    } catch (e) {
      if (e instanceof Busy) { json(res, 503, { error: 'busy' }); return; }
      throw e;
    }
    if (!acct) {
      noteAuthFail(ip);
      json(res, what === 'register' ? 409 : 401, { error: what === 'register' ? 'username_taken' : 'invalid_credentials' });
      return;
    }
    // a fresh session ID on every sign-in (no session fixation); the replaced session, and its sockets' sign-in, end
    const oldSid = req.sessionID;
    await new Promise<void>((r) => s.regenerate(() => r()));
    endSession(oldSid);
    req.session!.account = { id: acct.id, username: acct.username };
    await new Promise<void>((r) => req.session!.save(() => r()));
    log.info(what === 'register' ? 'account.register' : 'account.login', { account: acct.id });
    json(res, what === 'register' ? 201 : 200, { account: { id: acct.id, username: acct.username } });
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
    if (conns >= cfg.maxConnections || (perIp.get(ip) ?? 0) >= cfg.maxConnectionsPerIp) { reject(socket, 503, 'Service Unavailable'); return; }
    conns++; perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let counted = true;
    const release = (): void => { if (!counted) return; counted = false; conns--; const n = (perIp.get(ip) ?? 1) - 1; if (n > 0) perIp.set(ip, n); else perIp.delete(ip); };
    socket.once('close', release);
    void runSession(req, {}).then(() => {
      const acct = req.session?.account ?? null;
      const sid = acct ? req.sessionID ?? null : null;
      wss.handleUpgrade(req, socket, head, (ws) => { ws.once('close', release); connection(ws, ip, acct && sid ? { sid, account: acct } : null); });
    }, () => { release(); reject(socket, 500, 'Internal Server Error'); });
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
      if (r.room.state === 'results' && r.room.result) send({ t: 'result', envelope: r.room.result });
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
        if (!auth) { enter(m, null); return; }
        // a signed-in entry binds the seat to the account: the session must still be live right now
        const a = auth;
        return store!.live([{ sid: a.sid, accountId: a.account.id }]).then((live) => {
          if (ws.readyState !== ws.OPEN || auth !== a) return;
          if (!live.has(a.sid)) { send({ t: 'nack', ref: m.t, code: 'expired', detail: 'session' }); a.end(); return; }
          enter(m, a.account.id);
        }, (e: unknown) => {
          log.warn('ws.session_check_failed', { error: String(e) });
          send({ t: 'nack', ref: m.t, code: 'unavailable', detail: 'sign-in check failed, try again' });
        });
      }
      if (!room || !pid) { send({ t: 'nack', ref: m.t, code: 'not_in_room' }); return; }
      const reply = room.handle(pid, m, manager.now());
      if (reply) send(reply);
      if (m.t === 'leave') { room = null; pid = null; }
    }

    function enter(m: Extract<ClientMsg, { t: 'create' | 'join' | 'resume' }>, accountId: string | null): void {
      const r = m.t === 'create'
        ? manager.create(peer, { name: m.name, livery: m.livery, accountId, mode: m.mode, settings: m.settings, championship: m.championship })
        : m.t === 'join'
          ? manager.join(peer, ip, { code: m.code, name: m.name, livery: m.livery, accountId })
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
