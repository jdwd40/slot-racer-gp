// Career points, award ledger and personal bests against a real PostgreSQL, in its own schema (docs/career.md). Local:
// `npm run test:db`; CI: the postgres:17 service container. Skipped when SLOTRUSH_TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import pg from 'pg';
import { LAPS, PEN, type RaceSnapshot, type Standing } from '../../src/race';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import type { AwardsView, CareerStats, ServerMsg } from '../../src/net/protocol';
import { createApp, type App } from '../../server/app';
import { testConfig, type Config } from '../../server/config';
import { buildEnvelope, trackVersion, type EnvelopeParticipant, type ResultEnvelope } from '../../server/envelope';
import { memoryLogger } from '../../server/log';
import { migrate, MIGRATIONS } from '../../server/migrations';
import { PgResultSink, type ResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { DurableSink } from '../../server/spool';
import { drive } from './bot';

const URL = process.env.SLOTRUSH_TEST_DATABASE_URL;
const ORIGIN = 'http://localhost:5173';
const SCHEMA = 't_career';
const SECRET = 'test-session-secret-0123456789abcdef';
const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** The database path with a switch: `down` makes every store fail as an unreachable database would. */
class Switch implements ResultSink {
  down = false;
  constructor(public inner: ResultSink) {}
  async consume(e: Readonly<ResultEnvelope>) { if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); return this.inner.consume(e); }
}

describe.skipIf(!URL)('PostgreSQL: career points, award ledger, personal bests', () => {
  const pools: pg.Pool[] = [];
  let pool: pg.Pool;
  let app: App;
  let mgr: RoomManager;
  let durable: DurableSink;
  let sw: Switch;
  let base = '';
  let cfg: Config;
  const spool = mkdtempSync(join(tmpdir(), 'srgp-career-spool-'));
  const log = memoryLogger();
  let ipN = 0;
  let ip = '10.9.0.1';
  const newPool = (): pg.Pool => { const p = new pg.Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` }); pools.push(p); return p; };

  async function boot(): Promise<void> {
    sw = new Switch(new PgResultSink(pool));
    durable = new DurableSink(sw, { dir: spool, log, retryMs: 60_000 });
    mgr = new RoomManager({ cfg, log, sink: durable });
    durable.onSettled = (id, r) => mgr.settled(id, r);
    await durable.start();
    app = createApp({ cfg, log, manager: mgr, pool, sessionCheckMs: 300, pendingResults: () => durable.pending });
    base = `http://127.0.0.1:${(await app.listen()).port}`;
    mgr.start();
  }
  async function halt(): Promise<void> { mgr.shutdown('shutdown'); durable.stop(); await app.close(); }

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    cfg = testConfig({ port: 0, databaseUrl: URL!, sessionSecret: SECRET, cookieSecure: false, timeScale: 20, maxCatchUpSteps: 120, graceS: 5, maxConnectionsPerIp: 40, msgRate: 300, msgBurst: 400, snapshotHz: 10 });
    pool = newPool();
    await boot();
  });
  afterAll(async () => { await halt().catch(() => undefined); for (const p of pools) await p.end().catch(() => undefined); });

  const req = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': ip, ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const cookieOf = (r: Response): string => (r.headers.getSetCookie()[0] ?? '').split(';')[0];
  const register = async (username: string, displayName?: string): Promise<{ cookie: string; id: string }> => {
    const r = await req('/api/auth/register', { body: { username, password: `${username} password 1`, ...(displayName ? { displayName } : {}) } });
    expect(r.status).toBe(201);
    return { cookie: cookieOf(r), id: ((await r.json()) as { account: { id: string } }).account.id };
  };
  const login = async (username: string): Promise<string> => cookieOf(await req('/api/auth/login', { body: { username, password: `${username} password 1` } }));
  const stats = async (cookie: string): Promise<CareerStats> => {
    const r = await req('/api/profile/stats', { cookie });
    expect(r.status).toBe(200);
    return ((await r.json()) as { stats: CareerStats }).stats;
  };
  const socket = async (cookie: string): Promise<OnlineClient> => {
    const c = new OnlineClient(base.replace('http', 'ws') + '/ws', WebSocket as unknown as SocketCtor, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
    await c.connect();
    return c;
  };
  const nextIp = (): void => { ip = `10.9.${++ipN}.1`; };
  const ledger = async (raceId: string) => (await pool.query<{ account_id: string; position: number | null; status: string; points: number }>('SELECT account_id::text, position, status, points FROM career_awards WHERE race_id = $1 ORDER BY position NULLS LAST, account_id', [raceId])).rows;

  let raceN = 0;
  function envelope(o: { accounts: (string | null)[]; status?: Standing['status'][]; laps?: [number, number, boolean][]; mode?: ResultEnvelope['mode']; outcome?: ResultEnvelope['outcome']; track?: string; lapDriver?: number }): Readonly<ResultEnvelope> {
    raceN++;
    const raceId = `00000000-0000-4000-8000-${String(raceN).padStart(12, '0')}`;
    const track = o.track ?? 'circuit-1';
    const participants: EnvelopeParticipant[] = o.accounts.map((a, slot) => ({ id: `p${slot}`, control: a === 'ai' ? 'ai' : 'human', slot, num: slot + 1, bay: slot, name: `D${slot}`, livery: 'blue', accountId: a === 'ai' ? null : a }));
    let pos = 0;
    const classification: Standing[] = o.accounts.map((a, slot) => {
      const status = o.status?.[slot] ?? 'finished';
      return { id: `p${slot}`, slot, control: a === 'ai' ? 'ai' : 'human', pos: status === 'finished' ? ++pos : null, status, time: status === 'finished' ? 90 + slot : null, laps: LAPS, bestLap: 7, pitStops: 1, timePen: 0, dqReason: status === 'dq' ? 'stopGo' : null, dnfReason: status === 'dnf' ? 'retired' : null };
    });
    const outcome = o.outcome ?? (o.mode === 'practice' ? 'ended' : 'completed');
    return buildEnvelope({
      raceId, roomId: '55555555-5555-4555-8555-555555555555', mode: o.mode ?? 'multiplayer', championship: null, outcome, abortReason: null,
      trackId: track, settings: { track, aiFill: false }, participants,
      classification: outcome === 'completed' ? classification : null,
      laps: (o.laps ?? []).map(([lap, time, valid]) => ({ driver: `p${o.lapDriver ?? 0}`, lap, time, valid, raceT: lap * 8 })),
      times: { roomCreatedAt: '2026-11-09T10:00:00.000Z', startedAt: '2026-11-09T10:00:01.000Z', greenAt: null, finishedAt: new Date(Date.UTC(2026, 10, 9, 10, raceN)).toISOString(), raceTimeS: 100, ticks: 1 },
    });
  }

  it('migration 003 adds the ledger and bests to a 002 database without touching accounts, profiles, sessions or stored results', async () => {
    const c = await pool.connect();
    try {
      await c.query('CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const m of MIGRATIONS.slice(0, 2)) { await c.query(m.sql); await c.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [m.id, checksum(m.sql)]); }
      await c.query("INSERT INTO accounts (username, username_key, password_hash) VALUES ('legacy_car', 'legacy_car', 'x')");
      await c.query("INSERT INTO profiles (account_id, display_name) SELECT id, 'Legacy' FROM accounts WHERE username_key = 'legacy_car'");
      await c.query("INSERT INTO sessions (sid, account_id, sess, expires_at) SELECT 'legacy-sid', id, '{}', now() + interval '1 day' FROM accounts WHERE username_key = 'legacy_car'");
      const old = envelope({ accounts: ['1'] });
      await c.query(`INSERT INTO race_results (race_id, room_id, mode, outcome, track_id, rules_version, digest, envelope) VALUES ($1, $2, 'multiplayer', 'completed', 'circuit-1', 'race-core-2026.11.1', $3, $4)`, [old.raceId, old.roomId, old.digest, JSON.stringify(old)]);
    } finally { c.release(); }
    expect((await req('/api/health')).status).toBe(503);
    expect(await migrate(pool)).toEqual(['003_career_awards_bests']);
    const h = (await (await req('/api/health')).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ ok: true, career: true, schema: '003_career_awards_bests', scoring: 'career-1:10-6-4', pendingResults: 0 });
    expect((await pool.query("SELECT a.username, p.display_name, (SELECT count(*)::int FROM sessions) AS s FROM accounts a JOIN profiles p ON p.account_id = a.id")).rows).toEqual([{ username: 'legacy_car', display_name: 'Legacy', s: 1 }]);
    // a result stored before career scoring existed is kept as it was and never scored retroactively
    expect((await pool.query('SELECT scoring_version FROM race_results')).rows).toEqual([{ scoring_version: null }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM career_awards')).rows[0].n).toBe(0);
  });

  it('a stored race awards 10/6/4/0 once: re-delivery, concurrent retries and a restarted sink never add to it; the ledger is immutable', async () => {
    nextIp();
    const a = await Promise.all(['led_a', 'led_b', 'led_c', 'led_d'].map((u) => register(u)));
    const e = envelope({ accounts: a.map((x) => x.id) });
    const sink = new PgResultSink(pool);
    const all = await Promise.all(Array.from({ length: 8 }, () => sink.consume(e)));
    expect(all.filter((r) => r === 'stored')).toHaveLength(1);
    expect(all.filter((r) => r === 'duplicate')).toHaveLength(7);
    expect(await new PgResultSink(pool).consume(e)).toBe('duplicate');   // a restarted process
    expect((await ledger(e.raceId)).map((r) => [r.account_id, r.position, r.points])).toEqual(a.map((x, i) => [x.id, i + 1, [10, 6, 4, 0][i]]));
    expect((await pool.query('SELECT scoring_version FROM race_results WHERE race_id = $1', [e.raceId])).rows[0].scoring_version).toBe('career-1:10-6-4');
    const s = await stats(a[0].cookie);
    expect(s.career).toEqual({ points: 10, races: 1, wins: 1, seconds: 0, thirds: 0, dq: 0, dnf: 0 });
    expect((await stats(a[3].cookie)).career).toMatchObject({ points: 0, races: 1, wins: 0 });
    expect(s.recent[0]).toMatchObject({ raceId: e.raceId, mode: 'multiplayer', track: 'circuit-1', pos: 1, status: 'finished', points: 10, field: 4, humans: 4, scoring: 'career-1:10-6-4', rules: 'race-core-2026.11.1' });
    await expect(pool.query('UPDATE career_awards SET points = 100')).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE race_results SET outcome = $1', ['completed'])).rejects.toThrow(/immutable/);
    // DQ/DNF and AI/guest rows: positions kept, no credit for AI or guests, zero for DQ and DNF
    const w = envelope({ accounts: ['ai', null, a[0].id, a[1].id, a[2].id], status: ['finished', 'finished', 'finished', 'dq', 'dnf'] });
    await sink.consume(w);
    expect((await ledger(w.raceId)).map((r) => [r.account_id, r.position, r.status, r.points])).toEqual([[a[0].id, 3, 'finished', 4], [a[1].id, null, 'dq', 0], [a[2].id, null, 'dnf', 0]]);
    // practice and aborted races award nothing
    for (const x of [envelope({ accounts: [a[0].id], mode: 'practice' }), envelope({ accounts: [a[0].id], outcome: 'aborted' })]) { expect(await sink.consume(x)).toBe('stored'); expect(await ledger(x.raceId)).toEqual([]); }
    expect((await stats(a[0].cookie)).career).toEqual({ points: 14, races: 2, wins: 1, seconds: 0, thirds: 1, dq: 0, dnf: 0 });
    // totals are always the sum of the ledger
    const sum = (await pool.query('SELECT COALESCE(sum(points), 0)::int AS p FROM career_awards WHERE account_id = $1', [a[0].id])).rows[0].p;
    expect(sum).toBe(14);
  });

  it('personal bests only ever get faster, per circuit layout version, mode and rules; invalid, slower, duplicate and concurrent laps cannot replace one', async () => {
    nextIp();
    const { id, cookie } = await register('pb_driver');
    const sink = new PgResultSink(pool);
    const best = async (mode = 'multiplayer') => (await pool.query<{ lap_ms: number }>('SELECT lap_ms FROM personal_bests WHERE account_id = $1 AND mode = $2 AND track_id = $3', [id, mode, 'circuit-1'])).rows.map((r) => r.lap_ms);
    await sink.consume(envelope({ accounts: [id], laps: [[1, 9.2, true], [2, 8.0, true], [13, 7.9, true]] }));
    expect(await best()).toEqual([7900]);   // the final lap counts
    await sink.consume(envelope({ accounts: [id], laps: [[2, 8.5, true]] }));            // slower
    await sink.consume(envelope({ accounts: [id], laps: [[2, 6.0, false]] }));           // faster but invalid
    expect(await best()).toEqual([7900]);
    // concurrent races commit in any order: the faster always wins
    const fast = envelope({ accounts: [id], laps: [[3, 7.1, true]] }), slow = envelope({ accounts: [id], laps: [[3, 7.6, true]] });
    await Promise.all([sink.consume(slow), sink.consume(fast), sink.consume(slow), sink.consume(fast)]);
    expect(await best()).toEqual([7100]);
    await sink.consume(fast);   // duplicate delivery
    expect(await best()).toEqual([7100]);
    // a practice lap and a solo lap are other contexts; a guest's or another driver's lap is nobody's PB here
    await sink.consume(envelope({ accounts: [id], mode: 'practice', laps: [[2, 6.5, true]] }));
    await sink.consume(envelope({ accounts: [id], mode: 'solo', laps: [[2, 7.4, true]] }));
    await sink.consume(envelope({ accounts: [id, null], laps: [[2, 5.0, true]], lapDriver: 1 }));
    expect(await best()).toEqual([7100]);
    expect(await best('practice')).toEqual([6500]);
    // a lap from an older layout of the circuit is kept apart and marked not current
    await pool.query("UPDATE personal_bests SET track_version = 'oldlayout0000000', lap_ms = 5000 WHERE account_id = $1 AND mode = 'solo'", [id]);
    await sink.consume(envelope({ accounts: [id], mode: 'solo', laps: [[2, 7.7, true]] }));
    const s = await stats(cookie);
    const solo = s.bests.filter((b) => b.mode === 'solo').map((b) => [b.lapMs, b.current]).sort();
    expect(solo).toEqual([[5000, false], [7700, true]]);
    expect(s.bests.find((b) => b.mode === 'multiplayer')).toMatchObject({ track: 'circuit-1', trackVersion: trackVersion('circuit-1'), current: true, lapMs: 7100, lap: 3, rules: 'race-core-2026.11.1', livery: 'blue' });
  });

  it('clients cannot set totals, positions or bests, nor read another account: the career API is the session\'s own and read-only', async () => {
    nextIp();
    const a = await register('auth_a'), b = await register('auth_b');
    await new PgResultSink(pool).consume(envelope({ accounts: [a.id, b.id], laps: [[2, 7.3, true]] }));
    expect((await req('/api/profile/stats')).status).toBe(401);
    expect(await (await req('/api/profile/stats', { cookie: `srsid=s%3A${a.id}.forged` })).json()).toEqual({ error: 'session_expired' });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await req('/api/profile/stats', { cookie: b.cookie, method, body: { points: 999, accountId: a.id } })).status).toBe(405);
    for (const body of [{ displayName: 'B', points: 999 }, { displayName: 'B', accountId: a.id }, { displayName: 'B', position: 1 }, { displayName: 'B', bests: [] }]) {
      expect((await req('/api/profile', { cookie: b.cookie, body })).status).toBe(400);
    }
    for (const path of ['/api/results', '/api/awards', '/api/profile/bests', '/api/stats']) expect((await req(path, { cookie: b.cookie, body: { points: 1 } })).status).toBe(404);
    const sa = await stats(a.cookie), sb = await stats(b.cookie);
    expect(sa.career.points).toBe(10); expect(sb.career.points).toBe(6);
    expect(sa.bests).toHaveLength(1); expect(sb.bests).toHaveLength(0);
    // a forged result over the socket is not a message the server accepts
    const c = await socket(b.cookie);
    c.ws!.send(JSON.stringify({ t: 'result', envelope: { classification: [{ id: 'x', pos: 1 }] } }));
    expect(await c.wait((m) => m.t === 'nack')).toMatchObject({ code: 'malformed' });
    c.close();
    expect((await stats(b.cookie)).career.points).toBe(6);
  });

  it('a four-account race with service queues, pit and stop-and-go service and a final-lap DQ: identical saved awards on every client, the same totals on a second browser, renames keep history', async () => {
    nextIp();
    const accts = await Promise.all(['four_a', 'four_b', 'four_c', 'four_d'].map((u, i) => register(u, `Four ${'ABCD'[i]}`)));
    const cs = await Promise.all(accts.map((a) => socket(a.cookie)));
    const j = await cs[0].request({ t: 'create', name: 'x', mode: 'multiplayer', settings: { track: 'circuit-1', aiFill: false }, expectAccount: accts[0].id });
    if (j.t !== 'joined') throw new Error(JSON.stringify(j));
    for (const [k, c] of cs.entries()) if (k) expect(await c.request({ t: 'join', code: j.room.code, name: 'x', expectAccount: accts[k].id })).toMatchObject({ t: 'joined' });
    for (const c of cs.slice(1)) c.send({ t: 'ready', ready: true });
    await cs[0].wait((m) => m.t === 'room' && m.room.participants.length === 4 && m.room.participants.every((p) => p.host || p.ready));
    cs[0].send({ t: 'start' });
    await Promise.all(cs.map((c) => c.wait((m) => m.t === 'room' && m.room.state === 'race')));
    const rm = mgr.room(j.room.id)!;
    const ids = cs.map((c) => c.me!);
    // the same scenario as the #22 WebSocket test: two cars given a stop-and-go on one approach (they queue for the box),
    // then the first car on the road past the last pit entrance of its final lap is given one it can no longer serve
    let contention = false, dqId = '';
    const r = rm.race!;
    const update = r.update.bind(r);
    r.update = (dt, inputs) => {
      update(dt, inputs);
      if (r.phase !== 'racing') return;
      const [a, b] = [r.car(ids[0])!, r.car(ids[1])!];
      if (!contention && a.crossed >= 3 && b.crossed >= 3 && a.mode === 'race' && b.mode === 'race' && !a.pitReq && !b.pitReq && !a.fuelReq && !b.fuelReq) {
        for (const [car, before] of [[a, 30], [b, 37]] as const) {
          car.u = car.crossed * r.T.L + r.T.PIT_IN0 - before; car.hiU = car.u; car.laneSide = -1; car.d = -r.T.LANE_HALF; car.change = null;
          car.v = 12; car.sectors = 7; car.lapValid = false; car.sgOwed = PEN.stopSeconds; car.sgDue = car.crossed;
        }
        contention = true;
      }
      const late = ids.map((id) => r.car(id)!).find((x) => { const s = r.T.wrapS(x.u); return x.crossed === LAPS && x.mode === 'race' && x.status === 'running' && x.sgOwed === 0 && s > r.T.PIT_IN1 + 1 && s < r.T.FINISH_S - 4; });
      if (contention && !dqId && late) { late.sgOwed = PEN.stopSeconds; late.sgDue = LAPS; late.sgDeferred = true; dqId = late.id; }
    };
    for (const [k, c] of cs.entries()) {
      c.onMessage = (m) => {
        if (m.t !== 'state' || !c.me) return;
        const o = drive(m.snap as RaceSnapshot, c.me, 1 - k * 0.03);
        if (o.up !== c.held.up || o.down !== c.held.down) c.setHeld(o.up, o.down);
        if (o.pit) c.action('pit');
      };
      c.startHeartbeat(100);
    }
    const awardsOf = (c: OnlineClient) => c.received.filter((m): m is Extract<ServerMsg, { t: 'awards' }> => m.t === 'awards').map((m) => m.awards);
    await Promise.all(cs.map((c) => c.wait((m) => m.t === 'awards' && m.awards.sync === 'saved', 120_000)));
    cs.forEach((c) => { c.onMessage = null; c.stopHeartbeat(); });
    expect(contention && !!dqId).toBe(true);
    const env = rm.result!;
    expect(env.classification!.find((s) => s.id === dqId)).toMatchObject({ status: 'dq', dqReason: 'stopGo', pos: null });
    const states = cs[1].received.filter((m): m is Extract<ServerMsg, { t: 'state' }> => m.t === 'state');
    expect(states.some((s) => (s.snap as RaceSnapshot).cars.find((x) => x.id === ids[1])!.sgPhase === 'queued')).toBe(true);
    expect(env.classification!.some((s) => s.pitStops > 0)).toBe(true);
    const final = awardsOf(cs[0]).at(-1)! as AwardsView;
    for (const c of cs) expect(JSON.stringify(awardsOf(c).at(-1))).toBe(JSON.stringify(final));
    expect(final.rows.find((x) => x.participant === dqId)).toMatchObject({ status: 'dq', points: 0, credit: true });
    // what every client was shown is exactly the stored ledger, and each account's totals
    const byPart = new Map(final.rows.map((x) => [x.participant, x]));
    const led = await ledger(env.raceId);
    expect(led).toHaveLength(4);
    for (const [k, a] of accts.entries()) {
      const row = byPart.get(ids[k])!;
      expect(led.find((l) => l.account_id === a.id)).toMatchObject({ position: row.pos, points: row.points, status: row.status });
      expect((await stats(a.cookie)).career.points).toBe(row.points);
    }
    expect(final.rows.filter((x) => x.pos).map((x) => x.points).sort((p, q) => q - p)).toEqual([10, 6, 4]);
    // a reconnect after the race replays the same saved awards; nothing is stored again
    cs[2].ws!.close(4000, 'drop');
    const back = await socket(accts[2].cookie);
    const cred = cs[2].credential()!;
    expect(await back.request({ t: 'resume', room: cred.room, participant: cred.participant, token: cred.token })).toMatchObject({ t: 'joined' });
    // the replay follows the private reply in the same burst, so it may already have been received
    for (let i = 0; i < 100 && !awardsOf(back).length; i++) await new Promise((res) => setTimeout(res, 20));
    expect(JSON.stringify(awardsOf(back).at(-1))).toBe(JSON.stringify(final));
    expect(back.received.filter((m) => m.t === 'result')).toHaveLength(1);
    expect(await ledger(env.raceId)).toEqual(led);
    // a second browser signs in to the same name, points, history and bests; a rename keeps all of it
    const winner = accts[ids.findIndex((id) => byPart.get(id)!.pos === 1)];
    const second = await login(['four_a', 'four_b', 'four_c', 'four_d'][accts.indexOf(winner)]);
    const s1 = await stats(winner.cookie), s2 = await stats(second);
    expect(s2).toEqual(s1);
    expect(s1.career).toMatchObject({ points: 10, wins: 1, races: 1 });
    expect(s1.bests.length).toBeGreaterThan(0);
    expect((await req('/api/profile', { cookie: second, body: { displayName: 'Renamed Winner' } })).status).toBe(200);
    const s3 = await stats(winner.cookie);
    expect(s3.displayName).toBe('Renamed Winner');
    expect({ ...s3, displayName: s1.displayName }).toEqual(s1);
    // another account sees only its own
    const other = accts.find((a) => a !== winner)!;
    expect((await stats(other.cookie)).recent.every((x) => x.raceId === env.raceId)).toBe(true);
    expect((await stats(other.cookie)).career.wins).toBe(0);
    [...cs, back].forEach((c) => c.close());
  }, 180_000);

  it('a storage failure shows pending on the client, is spooled durably and stored exactly once after a restart', async () => {
    nextIp();
    const { id, cookie } = await register('spool_drv');
    const before = (await stats(cookie)).career;
    sw.down = true;
    const c = await socket(cookie);
    const j = await c.request({ t: 'create', name: 'x', mode: 'solo', settings: { track: 'circuit-2' }, expectAccount: id });
    if (j.t !== 'joined') throw new Error(JSON.stringify(j));
    c.send({ t: 'start' });
    c.onMessage = (m) => {
      if (m.t !== 'state' || !c.me) return;
      const o = drive(m.snap as RaceSnapshot, c.me, 1);
      if (o.up !== c.held.up || o.down !== c.held.down) c.setHeld(o.up, o.down);
      if (o.pit) c.action('pit');
    };
    c.startHeartbeat(100);
    const pend = await c.wait((m) => m.t === 'awards' && m.awards.sync === 'pending', 120_000) as Extract<ServerMsg, { t: 'awards' }>;
    c.onMessage = null; c.stopHeartbeat();
    const raceId = pend.awards.raceId;
    expect(readdirSync(spool)).toEqual([`${raceId}.json`]);
    expect(((await (await req('/api/health')).json()) as { pendingResults: number }).pendingResults).toBe(1);
    expect((await stats(cookie)).career).toEqual(before);   // nothing counted yet, nothing lost
    // the server stops with the database still down, and starts again once it is back
    c.close();
    await halt();
    await boot();
    expect(readdirSync(spool)).toEqual([]);
    const mine = pend.awards.rows.find((x) => x.credit)!;
    const after = (await stats(cookie)).career;
    expect(after.points).toBe(before.points + mine.points);
    expect(after.races).toBe(before.races + 1);
    // restart again and re-deliver: still once
    await halt();
    await boot();
    expect(await durable.consume((await pool.query<{ envelope: ResultEnvelope }>('SELECT envelope FROM race_results WHERE race_id = $1', [raceId])).rows[0].envelope)).toBe('duplicate');
    expect((await stats(cookie)).career).toEqual(after);
    expect((await ledger(raceId))).toHaveLength(1);
  }, 180_000);
});
