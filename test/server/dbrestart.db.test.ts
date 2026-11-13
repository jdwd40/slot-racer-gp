// #48: the database going away and coming back during an active race, against the real room server process. The built
// server entry point runs as a child process; its DATABASE_URL points at a TCP proxy in front of PostgreSQL that the test
// can cut (every connection dropped, new ones refused) and restore. Before the fix, the cut killed the process with an
// unhandled pool 'error' event and the race was lost. Local: `npm run test:db`; CI: the postgres:17 service container.
// Skipped when SLOTRUSH_TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import pg from 'pg';
import type { RaceSnapshot } from '../../src/race';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import type { CareerStats, ServerMsg } from '../../src/net/protocol';
import { migrate } from '../../server/migrations';
import { drive } from './bot';
import { bundle } from './subprocess';

const URL_ = process.env.SLOTRUSH_TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';
const SCHEMA = 't_dbrestart';

/** A TCP proxy to PostgreSQL. `cut()` drops every open connection and refuses new ones until `restore()`. */
class Proxy {
  private server: net.Server;
  private pairs = new Set<[net.Socket, net.Socket]>();
  down = false;
  accepted = 0;
  constructor(private host: string, private port: number) {
    this.server = net.createServer((client) => {
      client.on('error', () => undefined);
      if (this.down) { client.destroy(); return; }
      this.accepted++;
      const up = net.connect(this.port, this.host);
      up.on('error', () => client.destroy());
      client.on('error', () => up.destroy());
      const pair: [net.Socket, net.Socket] = [client, up];
      this.pairs.add(pair);
      const done = (): void => { this.pairs.delete(pair); client.destroy(); up.destroy(); };
      client.on('close', done); up.on('close', done);
      client.pipe(up); up.pipe(client);
    });
  }
  listen(): Promise<number> { return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r((this.server.address() as net.AddressInfo).port))); }
  cut(): number { this.down = true; const n = this.pairs.size; for (const [a, b] of [...this.pairs]) { a.destroy(); b.destroy(); } return n; }
  restore(): void { this.down = false; }
  close(): Promise<void> { this.cut(); return new Promise((r) => this.server.close(() => r())); }
}

const until = async (pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await pred())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};

describe.skipIf(!URL_)('PostgreSQL interruption during an active race (server process)', () => {
  let admin: pg.Pool;
  let proxy: Proxy;
  let proc: ChildProcess;
  let base = '';
  let exited: number | null | undefined;
  const out: string[] = [];
  const spool = mkdtempSync(join(tmpdir(), 'srgp-dbrestart-spool-'));
  const password = URL_ ? decodeURIComponent(new URL(URL_).password) : '';
  let setExit: (c: number | null) => void = () => undefined;
  const exitCode = new Promise<number | null>((r) => { setExit = r; });

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new pg.Pool({ connectionString: URL_, max: 2, options: `-c search_path=${SCHEMA}` });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await migrate(admin);
    proxy = new Proxy(u.hostname, Number(u.port || 5432));
    const via = new URL(URL_!);
    via.hostname = '127.0.0.1'; via.port = String(await proxy.listen());
    via.searchParams.set('options', `-c search_path=${SCHEMA}`);
    const main = await bundle('server/main.ts');
    proc = spawn(process.execPath, [main], {
      env: {
        PATH: process.env.PATH, NODE_ENV: 'test', SLOTRUSH_PORT: '0', DATABASE_URL: via.toString(),
        SLOTRUSH_SESSION_SECRET: 'dbrestart-session-secret-0123456789abcdef', SLOTRUSH_SPOOL_DIR: spool,
        // a quick race: wall clock x20, with the catch-up budget to match
        SLOTRUSH_TIME_SCALE: '20', SLOTRUSH_MAX_CATCHUP_STEPS: '6', SLOTRUSH_SNAPSHOT_HZ: '10', SLOTRUSH_MSG_RATE: '300', SLOTRUSH_MSG_BURST: '400',
        // health re-probes the database on every request, so a reading right after the cut is not the cached pre-cut one (#98)
        SLOTRUSH_HEALTH_DB_CACHE_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('exit', (code) => { exited = code; setExit(code); });
    for (const s of [proc.stdout!, proc.stderr!]) s.setEncoding('utf8').on('data', (d: string) => out.push(d));
    await until(() => /"ev":"server.listen"/.test(out.join('')) || exited !== undefined, 20_000, 'server.listen');
    const listen = out.join('').split('\n').find((l) => l.includes('"ev":"server.listen"'));
    if (!listen) throw new Error(`server did not start: ${out.join('')}`);
    base = `http://127.0.0.1:${(JSON.parse(listen) as { port: number }).port}`;
  }, 60_000);
  afterAll(async () => {
    if (proc && exited === undefined) proc.kill('SIGKILL');
    await proxy?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end();
  });

  const req = (path: string, init: { body?: unknown; cookie?: string } = {}) => fetch(`${base}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const health = async () => { const r = await req('/api/health'); return { status: r.status, ...((await r.json()) as { ok: boolean; db: string; pendingResults: number; racing: number }) }; };
  const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
  const logs = () => out.join('').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);

  it('the race, its driver and controls carry on through the outage; the result is stored once after recovery; health and logs say so', async () => {
    const reg = await req('/api/auth/register', { body: { username: 'outage_drv', password: 'outage drv password 1' } });
    expect(reg.status).toBe(201);
    const cookie = cookieOf(reg);
    const accountId = ((await reg.json()) as { account: { id: string } }).account.id;
    expect(await health()).toMatchObject({ status: 200, ok: true, db: 'ok', pendingResults: 0 });

    // read back below from the message history, which is opt-in (#50)
    const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, cookie } }).recordHistory();
    await c.connect();
    const j = await c.request({ t: 'create', name: 'x', mode: 'solo', settings: { track: 'circuit-1' }, expectAccount: accountId });
    if (j.t !== 'joined') throw new Error(JSON.stringify(j));
    const roomId = j.room.id, me = c.me!;
    c.send({ t: 'start' });
    let cutAt = -1;
    const after: RaceSnapshot[] = [];
    c.onMessage = (m) => {
      if (m.t !== 'state' || !c.me) return;
      const snap = m.snap as RaceSnapshot;
      if (cutAt >= 0) after.push(snap);
      const o = drive(snap, c.me, 1);
      if (o.up !== c.held.up || o.down !== c.held.down) c.setHeld(o.up, o.down);
      if (o.pit) c.action('pit');
    };
    c.startHeartbeat(100);

    // racing under way (with idle pooled connections from the sign-up and session reads): the database goes away
    await c.wait((m) => m.t === 'state' && (m.snap as RaceSnapshot).phase === 'racing' && (m.snap as RaceSnapshot).cars.find((x) => x.id === me)!.lapsDone >= 1, 60_000);
    const snapAtCut = c.received.filter((m) => m.t === 'state').at(-1)!.snap as RaceSnapshot;
    cutAt = snapAtCut.t;
    expect(proxy.cut()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(exited).toBeUndefined();   // 7163bfc: exit code 1, "Unhandled 'error' event"
    await until(() => logs().some((l) => l.ev === 'db.connection_lost'), 5_000, 'db.connection_lost log');
    const down = await health();
    expect(down).toMatchObject({ status: 503, ok: false, db: 'down', racing: 1 });
    // a request that needs the database fails without detail meanwhile, and the process lives on
    const during = await req('/api/auth/login', { body: { username: 'outage_drv', password: 'outage drv password 1' } });
    expect([during.status, await during.json()]).toEqual([500, { error: 'internal' }]);

    // the same room, driver and car keep racing on held controls: snapshots continue and the car keeps lapping
    await until(() => after.some((s) => s.cars.find((x) => x.id === me)!.lapsDone > snapAtCut.cars.find((x) => x.id === me)!.lapsDone), 30_000, 'a lap after the cut');
    const mine = (s: RaceSnapshot) => s.cars.find((x) => x.id === me)!;
    expect(after.every((s, i) => i === 0 || s.t > after[i - 1].t)).toBe(true);
    expect(after.some((s) => mine(s).throttle > 0)).toBe(true);
    expect(c.closed).toBeNull();
    expect(c.me).toBe(me);
    expect(c.room?.id).toBe(roomId);
    expect(c.received.filter((m) => m.t === 'joined')).toHaveLength(1);
    expect(mine(after.at(-1)!)).toMatchObject({ slot: mine(snapAtCut).slot, num: mine(snapAtCut).num, color: mine(snapAtCut).color });

    // the race finishes while the database is still down: the result is spooled, nothing is fabricated
    const pend = await c.wait((m) => m.t === 'awards' && m.awards.sync === 'pending', 120_000) as Extract<ServerMsg, { t: 'awards' }>;
    const raceId = pend.awards.raceId;
    expect(readdirSync(spool)).toEqual([`${raceId}.json`]);
    expect(await health()).toMatchObject({ status: 503, db: 'down', pendingResults: 1 });

    // the database comes back: health recovers, the queued result is stored exactly once and the client is told
    proxy.restore();
    await until(async () => (await health()).status === 200, 20_000, 'health to recover');
    const saved = await c.wait((m) => m.t === 'awards' && m.awards.sync === 'saved', 90_000) as Extract<ServerMsg, { t: 'awards' }>;
    expect(saved.awards.raceId).toBe(raceId);
    expect(await health()).toMatchObject({ status: 200, ok: true, db: 'ok', pendingResults: 0 });
    expect(readdirSync(spool)).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM race_results WHERE race_id = $1', [raceId])).rows[0].n).toBe(1);
    const ledger = (await admin.query<{ account_id: string; points: number }>('SELECT account_id::text, points FROM career_awards WHERE race_id = $1', [raceId])).rows;
    const credit = pend.awards.rows.find((r) => r.credit)!;
    expect(ledger).toEqual([{ account_id: accountId, points: credit.points }]);
    expect(logs().filter((l) => l.ev === 'result.retry_stored' && l.race === raceId)).toEqual([expect.objectContaining({ result: 'saved' })]);

    // new queries work: the session is still signed in, career stats read, and a fresh sign-in succeeds
    const st = await req('/api/profile/stats', { cookie });
    expect(st.status).toBe(200);
    expect(((await st.json()) as { stats: CareerStats }).stats.career).toMatchObject({ races: 1, points: credit.points });
    expect((await req('/api/auth/login', { body: { username: 'outage_drv', password: 'outage drv password 1' } })).status).toBe(200);
    c.onMessage = null; c.stopHeartbeat(); c.close();

    // a clean stop still closes the pool and exits 0
    proc.kill('SIGTERM');
    expect(await exitCode).toBe(0);
    const text = out.join('');
    expect(text).not.toMatch(/Unhandled|uncaught/i);
    expect(text).not.toContain(password);
    expect(text).not.toContain(new URL(URL_!).username + ':');
    expect(logs().find((l) => l.ev === 'db.connection_lost')).toMatchObject({ lvl: 'warn', state: 'idle' });
  }, 240_000);
});
