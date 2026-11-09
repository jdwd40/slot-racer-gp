// A session store that cannot be read (the database is down or timing out) is not an expired session: the server says it
// is unavailable and keeps the cookie, so neither it nor the browser signs anybody out. Runs without PostgreSQL: the pool's
// every query fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import type { Pool } from 'pg';
import { createApp, type App } from '../../server/app';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';

const ORIGIN = 'http://localhost:5173';
const SECRET = 'test-session-secret-0123456789abcdef';
const down = new Error('connection terminated unexpectedly');
const pool = { query: () => Promise.reject(down), connect: () => Promise.reject(down), end: () => Promise.resolve() } as unknown as Pool;
const log = memoryLogger();
const cfg = testConfig({ port: 0, databaseUrl: 'postgres://unused', sessionSecret: SECRET, cookieSecure: false });
const mgr = new RoomManager({ cfg, log, sink: new MemoryResultSink() });
let app: App;
let base = '';

// a validly signed cookie, so the session middleware does look the session up in the store
const sid = 'abcdefghijklmnopqrstuvwxyz012345';
const cookie = `srsid=${encodeURIComponent(`s:${sid}.${createHmac('sha256', SECRET).update(sid).digest('base64').replace(/=+$/, '')}`)}`;

beforeAll(async () => { app = createApp({ cfg, log, manager: mgr, pool }); base = `http://127.0.0.1:${(await app.listen()).port}`; });
afterAll(async () => { mgr.shutdown(); await app.close(); });

const req = (path: string, body?: unknown) => fetch(`${base}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', cookie },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('session store read failure', () => {
  it('answers 503 "unavailable" and never clears the cookie or reports the session as expired', async () => {
    for (const [path, body] of [['/api/profile', { displayName: 'New Name' }], ['/api/profile', undefined], ['/api/auth/me', undefined], ['/api/auth/logout', {}]] as const) {
      const r = await req(path, body);
      expect(r.status, path).toBe(503);
      expect(await r.json()).toEqual({ error: 'unavailable' });
      expect(r.headers.getSetCookie(), path).toEqual([]);
    }
    expect(log.lines.some((l) => l.includes('session.read_failed'))).toBe(true);
  });

  it('refuses a WebSocket that carries the cookie with 503 rather than seating it as a guest', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { origin: ORIGIN, cookie } });
    const status = await new Promise<number>((res) => {
      ws.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0));
      ws.on('open', () => res(101));
      ws.on('error', () => undefined);
    });
    ws.terminate();
    expect(status).toBe(503);
  });
});
