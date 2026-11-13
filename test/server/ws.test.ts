// End-to-end over real WebSockets: the HTTP/WS app on an ephemeral loopback port, headless OnlineClients (the same client
// module the browser will use) driving through the protocol only. Race time runs SCALE x faster than wall time
// (SLOTRUSH_TIME_SCALE, refused in production) so whole 13-lap races take seconds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { LAPS, PEN, type RaceSnapshot } from '../../src/race';
import { OnlineClient, type SocketCtor } from '../../src/net/client';
import { PROTOCOL_VERSION, type ServerMsg } from '../../src/net/protocol';
import { createApp, type App } from '../../server/app';
import type { Peer } from '../../server/room';
import { testConfig } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import { drive } from './bot';

const SCALE = 12;
const ORIGIN = 'http://localhost:5173';
const cfg = testConfig({ port: 0, timeScale: SCALE, maxCatchUpSteps: 6 * SCALE, snapshotHz: 10, graceS: 5, msgRate: 200, msgBurst: 300, maxConnectionsPerIp: 40,
  // every client here is one test host, so the per-address room allowance (#52, tested in roomquota.test.ts) is lifted
  roomsPerIp: 50, roomCreates: 1000 });
const log = memoryLogger();
const sink = new MemoryResultSink();
const mgr = new RoomManager({ cfg, log, sink });
let app: App;
let base = '';

beforeAll(async () => {
  app = createApp({ cfg, log, manager: mgr });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  mgr.start();
});
afterAll(async () => { mgr.shutdown(); await app.close(); });

const Ctor = WebSocket as unknown as SocketCtor;
async function client(origin = ORIGIN): Promise<OnlineClient> {
  // these checks read every message a client got, so history is opted in (#50: the browser records none)
  const c = new OnlineClient(base.replace('http', 'ws') + '/ws', Ctor, { headers: { origin } }).recordHistory();
  await c.connect();
  return c;
}
/** The complete message history: fails if the opt-in cap ever dropped anything an assertion would read. */
const history = (c: OnlineClient) => { expect(c.rx.dropped).toBe(0); return c.received; };
const states = (c: OnlineClient) => history(c).filter((m): m is Extract<ServerMsg, { t: 'state' }> => m.t === 'state');
const lastSnap = (c: OnlineClient): RaceSnapshot | null => (states(c).at(-1)?.snap as RaceSnapshot) ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bot every client from its own snapshots: held controls when they change, plus a heartbeat, and Pit actions. */
function autodrive(cs: OnlineClient[]): () => void {
  for (const [k, c] of cs.entries()) {
    c.onMessage = (m) => {
      if (m.t !== 'state' || !c.me) return;
      const o = drive(m.snap as RaceSnapshot, c.me, 1 - k * 0.03);
      if (o.up !== c.held.up || o.down !== c.held.down) c.setHeld(o.up, o.down);
      if (o.pit) c.action('pit');
    };
    c.startHeartbeat(100);
  }
  return () => cs.forEach((c) => { c.onMessage = null; c.stopHeartbeat(); });
}
async function room(n: number, settings: { track?: string; aiFill?: boolean } = {}) {
  const cs = [await client()];
  const j = await cs[0].request({ t: 'create', name: 'Host', mode: 'multiplayer', settings });
  if (j.t !== 'joined') throw new Error(JSON.stringify(j));
  for (let k = 1; k < n; k++) {
    const c = await client();
    const r = await c.request({ t: 'join', code: j.room.code, name: `Guest${k}`});
    if (r.t !== 'joined') throw new Error(JSON.stringify(r));
    cs.push(c);
  }
  return { cs, code: j.room.code, id: j.room.id };
}
async function startRace(cs: OnlineClient[]): Promise<void> {
  for (const c of cs.slice(1)) c.send({ t: 'ready', ready: true });
  await cs[0].wait((m) => m.t === 'room' && m.room.participants.every((p) => p.host || p.ready));
  cs[0].send({ t: 'start' });
  await Promise.all(cs.map((c) => c.wait((m) => m.t === 'room' && m.room.state === 'race')));
}
const results = (c: OnlineClient) => history(c).filter((m): m is Extract<ServerMsg, { t: 'result' }> => m.t === 'result');
const decisive = (c: OnlineClient) => states(c).flatMap((s) => s.ev as { type: string }[]).filter((e) => ['finish', 'dq', 'dnf', 'final', 'served', 'offence', 'breach', 'lap'].includes(e.type));

describe('headless clients race over WebSockets', () => {
  it('2-, 3- and 4-human races complete side by side with matching decisions and one envelope each; a fifth is refused', async () => {
    const rooms = [await room(2, { track: 'circuit-1' }), await room(3, { track: 'circuit-3' }), await room(4, { track: 'circuit-5' })];
    const four = rooms[2];
    const fifth = await client();
    const before = four.cs[0].room!.participants.map((p) => p.id);
    expect(await fifth.request({ t: 'join', code: four.code, name: 'Fifth' })).toMatchObject({ t: 'nack', code: 'full' });
    expect(mgr.room(four.id)!.publicRoom().participants.map((p) => p.id)).toEqual(before);
    fifth.close();
    for (const r of rooms) await startRace(r.cs);
    const stops = rooms.map((r) => autodrive(r.cs));
    await Promise.all(rooms.flatMap((r) => r.cs.map((c) => c.wait((m) => m.t === 'result', 90_000))));
    stops.forEach((s) => s());
    for (const r of rooms) {
      const envs = r.cs.map((c) => results(c));
      for (const e of envs) expect(e).toHaveLength(1);
      const env = envs[0][0].envelope as { digest: string; raceId: string; classification: { id: string; status: string; pos: number | null }[]; participants: { id: string; control: string }[]; mode: string; outcome: string };
      expect(new Set(envs.map((e) => (e[0].envelope as { digest: string }).digest)).size).toBe(1);
      expect(env).toMatchObject({ mode: 'multiplayer', outcome: 'completed' });
      expect(env.participants.filter((p) => p.control === 'human')).toHaveLength(r.cs.length);
      expect(env.classification).toHaveLength(r.cs.length);
      expect(env.classification.filter((s) => s.status === 'finished').length).toBeGreaterThanOrEqual(r.cs.length - 1);
      // every client saw exactly the same decisive events, in the same order, and the final snapshot agrees with the envelope
      const ref = JSON.stringify(decisive(r.cs[0]));
      for (const c of r.cs) expect(JSON.stringify(decisive(c))).toBe(ref);
      const fin = r.cs.map((c) => JSON.stringify(states(c).at(-1)!.snap && (states(c).at(-1)!.snap as RaceSnapshot).final));
      expect(new Set(fin).size).toBe(1);
      expect((lastSnap(r.cs[0])!.final ?? []).map((s) => [s.id, s.status, s.pos])).toEqual(env.classification.map((s) => [s.id, s.status, s.pos]));
      expect(sink.stored.get(env.raceId)!.digest).toBe(env.digest);
    }
    // three rooms, three tracks, never mixed
    expect(rooms.map((r) => lastSnap(r.cs[0])!.track)).toEqual(['circuit-1', 'circuit-3', 'circuit-5']);
    for (const r of rooms) r.cs.forEach((c) => c.close());
  }, 120_000);

  it('a race with automatic stop-and-go and pit service, box contention and a final-lap DQ is decided identically for every client', async () => {
    const { cs, id } = await room(3, { track: 'circuit-1', aiFill: true });
    await startRace(cs);
    const rm = mgr.room(id)!;
    const [A, B, C] = cs.map((c) => c.me!);
    // Scenario setup on the server (as the race-core tests do): two drivers are given a stop-and-go due on the same pit
    // approach, placed 30 m and 37 m short of the entrance; the first human past the last pit entrance on the final lap is
    // given a stop-and-go it can no longer serve. Everything after that (routing, takeover, queueing, service, release, DQ) is the server's.
    // Each car is placed on its own lap from lap 3 on, not on one shared lap: the bots' early laps vary with timing, and a
    // driver who loses a lap early would never share a lap count with the other again, so the setup could never fire.
    let contention = false, finalDq = false, dqId = '';
    // checked after every simulation step (not every tick: under load one tick may run many steps)
    const r = rm.race!;
    const update = r.update.bind(r);
    r.update = (dt, inputs) => {
      update(dt, inputs);
      if (r.phase !== 'racing') return;
      const a = r.car(A)!, b = r.car(B)!, c = r.car(C)!;
      if (!contention && a.crossed >= 3 && b.crossed >= 3 && a.mode === 'race' && b.mode === 'race' && !a.pitReq && !b.pitReq && !a.fuelReq && !b.fuelReq) {
        for (const [car, before] of [[a, 30], [b, 37]] as const) {
          car.u = car.crossed * r.T.L + r.T.PIT_IN0 - before; car.hiU = car.u; car.laneSide = -1; car.d = -r.T.LANE_HALF; car.change = null;
          car.v = 12; car.sectors = 7; car.lapValid = false;
          car.sgOwed = PEN.stopSeconds; car.sgDue = car.crossed;
        }
        contention = true;
      }
      // the first human on the road past the last pit entrance of the final lap
      const late = [c, a, b].find((x) => { const s = r.T.wrapS(x.u); return x.crossed === LAPS && x.mode === 'race' && x.status === 'running' && x.sgOwed === 0 && s > r.T.PIT_IN1 + 1 && s < r.T.FINISH_S - 4; });
      if (contention && !finalDq && late) {
        late.sgOwed = PEN.stopSeconds; late.sgDue = LAPS; late.sgDeferred = true;
        finalDq = true; dqId = late.id;
      }
    };
    const stop = autodrive(cs);
    await Promise.all(cs.map((c) => c.wait((m) => m.t === 'result', 90_000)));
    stop();
    expect(contention && finalDq).toBe(true);
    const env = results(cs[0])[0].envelope as { digest: string; classification: { id: string; status: string; dqReason: string | null; pitStops: number }[] };
    for (const c of cs) { expect(results(c)).toHaveLength(1); expect((results(c)[0].envelope as { digest: string }).digest).toBe(env.digest); }
    const ev = decisive(cs[0]) as { type: string; car?: string }[];
    for (const c of cs) expect(JSON.stringify(decisive(c))).toBe(JSON.stringify(ev));
    // both stop-and-gos served automatically, one at a time through the shared box, B queued behind A
    expect(ev.filter((e) => e.type === 'served').map((e) => e.car)).toEqual(expect.arrayContaining([A, B]));
    const phasesB = new Set(states(cs[1]).map((s) => (s.snap as RaceSnapshot).cars.find((x) => x.id === B)!.sgPhase));
    expect(phasesB.has('queued')).toBe(true);
    expect(states(cs[0]).some((s) => { const sn = s.snap as RaceSnapshot; const a = sn.cars.find((x) => x.id === A)!, b = sn.cars.find((x) => x.id === B)!; return a.sgServing && b.sgServing; })).toBe(false);
    // pits: fuel stops were made in the drivers' own bays
    expect(env.classification.filter((s) => s.pitStops > 0).length).toBeGreaterThan(0);
    // final-lap DQ for the unserved stop-and-go at the flag
    expect(env.classification.find((s) => s.id === dqId)).toMatchObject({ status: 'dq', dqReason: 'stopGo' });
    expect(env.classification.filter((s) => s.status === 'dq')).toHaveLength(1);
    expect(ev.filter((e) => e.type === 'final')).toHaveLength(1);
    expect([...sink.stored.values()].filter((e) => e.roomId === id)).toHaveLength(1);
    cs.forEach((c) => c.close());
  }, 120_000);
});

describe('protocol and access checks', () => {
  it('protocol mismatch is refused and closed; hello is required first and only once', async () => {
    // a cached v1 page (#67: v2 changed the state format) and a client newer than this server are both refused cleanly
    for (const v of [1, PROTOCOL_VERSION + 1]) {
      const c = new OnlineClient(base.replace('http', 'ws') + '/ws', Ctor, { headers: { origin: ORIGIN } });
      const got: ServerMsg[] = [];
      c.onMessage = (m) => got.push(m);
      await expect(c.connect(v)).rejects.toThrow(/hello refused: protocol/);
      await sleep(50);
      expect(c.closed?.code).toBe(4002);
      // nothing of a room or a race ever reaches it
      expect(got.map((m) => m.t)).toEqual(['nack']);
    }
    const raw = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { origin: ORIGIN } });
    const got: ServerMsg[] = [];
    raw.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMsg));
    await new Promise((r) => raw.on('open', r));
    raw.send(JSON.stringify({ t: 'create', name: 'x', mode: 'solo', settings: {} }));
    await sleep(50);
    expect(got[0]).toMatchObject({ t: 'nack', code: 'hello_required' });
    raw.close();
    const ok = await client();
    ok.send({ t: 'hello', v: 1, proto: 'slotrush' });
    expect(await ok.wait((m) => m.t === 'nack')).toMatchObject({ ref: 'hello', code: 'bad_state' });
    ok.close();
  });

  it('origin, path and connection checks happen before the upgrade', async () => {
    const tryOpen = (headers: Record<string, string>, path = '/ws') => new Promise<string>((res) => {
      const ws = new WebSocket(base.replace('http', 'ws') + path, { headers });
      ws.on('open', () => { res('open'); ws.close(); });
      ws.on('unexpected-response', (_q, r) => res(String(r.statusCode)));
      ws.on('error', () => res('error'));
    });
    expect(await tryOpen({ origin: 'https://evil.example' })).toBe('403');
    expect(await tryOpen({})).toBe('403');
    expect(await tryOpen({ origin: ORIGIN }, '/other')).toBe('404');
    expect(await tryOpen({ origin: ORIGIN })).toBe('open');
    expect(log.lines.some((l) => l.includes('ws.origin_rejected'))).toBe(true);
  });

  it('malformed, unknown, binary and oversized messages are refused; a frame over the hard limit closes the socket', async () => {
    const c = await client();
    const nack = () => c.wait((m) => m.t === 'nack');
    c.sendRaw('{not json'); expect(await nack()).toMatchObject({ code: 'malformed' });
    c.sendRaw(JSON.stringify({ t: 'teleport', u: 5 })); expect(await nack()).toMatchObject({ code: 'malformed' });
    c.sendRaw(JSON.stringify({ t: 'ctl', seq: 1, up: true, down: false, x: 1 })); expect(await nack()).toMatchObject({ code: 'malformed', ref: 'ctl' });
    c.sendRaw(JSON.stringify({ t: 'act', seq: 1.5, type: 'pit' })); expect(await nack()).toMatchObject({ code: 'malformed' });
    c.sendRaw(JSON.stringify({ t: 'act', seq: 1, type: 'teleport' })); expect(await nack()).toMatchObject({ code: 'malformed' });
    // client-supplied outcomes have no message at all
    c.sendRaw(JSON.stringify({ t: 'result', winner: 'me' })); expect(await nack()).toMatchObject({ code: 'malformed' });
    c.sendRaw(JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(600) })); expect(await nack()).toMatchObject({ code: 'too_large' });
    (c.ws as unknown as WebSocket).send(Buffer.from([1, 2, 3])); expect(await nack()).toMatchObject({ code: 'malformed' });
    c.sendRaw(JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(2000) }));
    await sleep(100);
    expect(c.closed?.code).toBe(1009);
  });

  it('a page that shows a sign-in this socket does not have is refused, never entered as a guest', async () => {
    const c = await client();
    // no session on this socket (the cookie expired before it opened), but the page still shows account 42
    expect(await c.request({ t: 'create', name: 'Ada', mode: 'solo', settings: {}, expectAccount: '42' })).toMatchObject({ t: 'nack', code: 'expired', detail: 'session' });
    expect(await c.request({ t: 'join', code: 'ABCDEF', name: 'Ada', expectAccount: '42' })).toMatchObject({ t: 'nack', code: 'expired', detail: 'session' });
    // once the page knows it is a guest, guest entry works on the same socket
    expect(await c.request({ t: 'create', name: 'Ada', mode: 'solo', settings: {}, expectAccount: '' })).toMatchObject({ t: 'joined' });
    c.close();
  });

  it('commands need room membership; a flood of messages is refused and then disconnected', async () => {
    const c = await client();
    c.send({ t: 'ctl', seq: 1, up: true, down: false });
    expect(await c.wait((m) => m.t === 'nack')).toMatchObject({ code: 'not_in_room' });
    c.send({ t: 'start' });
    expect(await c.wait((m) => m.t === 'nack' && m.ref === 'start')).toMatchObject({ code: 'not_in_room' });
    expect(await c.request({ t: 'resume', room: '00000000-0000-0000-0000-000000000000', participant: 'p_x', token: 'nope' })).toMatchObject({ code: 'expired' });
    // flood: well past the burst, for long enough to collect several strikes
    for (let i = 0; i < 6; i++) { for (let k = 0; k < 400; k++) c.send({ t: 'ping', id: k }); await sleep(1050); if (c.closed) break; }
    expect(history(c).some((m) => m.t === 'nack' && m.code === 'rate')).toBe(true);
    expect(c.closed?.code).toBe(1008);
  }, 20_000);

  it('the reconnect token goes only to its owner: never in room broadcasts, race state or logs; forged resumes are refused', async () => {
    const { cs, id } = await room(2);
    const cred = cs[1].credential()!;
    const joined = history(cs[1]).find((m) => m.t === 'joined')!;
    expect(JSON.stringify(joined)).toContain(cred.token);
    await startRace(cs);
    await sleep(300);
    for (const c of cs) for (const m of history(c)) if (m.t !== 'joined') expect(JSON.stringify(m)).not.toContain(cred.token);
    expect(JSON.stringify(history(cs[0]))).not.toContain(cred.token);
    for (const l of log.lines) { expect(l).not.toContain(cred.token); expect(l).not.toContain(cs[0].credential()!.token); }
    const thief = await client();
    expect(await thief.request({ t: 'resume', room: id, participant: cred.participant, token: cs[0].credential()!.token })).toMatchObject({ code: 'forbidden' });
    // a car can only be driven through its own seat
    cs[0].send({ t: 'ctl', seq: 500, up: true, down: false, driver: cred.participant });
    expect(await cs[0].wait((m) => m.t === 'nack' && m.ref === 'ctl')).toMatchObject({ code: 'forbidden' });
    cs[0].send({ t: 'act', seq: 1, type: 'pit', driver: cred.participant });
    expect(await cs[0].wait((m) => m.t === 'nack' && m.ref === 'act')).toMatchObject({ code: 'forbidden' });
    thief.close(); cs.forEach((c) => c.close());
  });

  it('dropping the link with Throttle held neutralizes the car; resuming within the grace continues the same car and numbering', async () => {
    const { cs, id } = await room(2);
    await startRace(cs);
    const rm = mgr.room(id)!;
    await cs[1].wait((m) => m.t === 'state' && (m.snap as RaceSnapshot).phase === 'racing', 10_000);
    cs[1].setHeld(true, false); cs[1].startHeartbeat(100);
    await sleep(120);
    const me = cs[1].me!;
    expect(rm.participant(me)!.held.up).toBe(true);
    const cred = cs[1].credential()!;
    const seq = cs[1].ctlSeq;
    (cs[1].ws as unknown as WebSocket).terminate();          // abrupt loss, no close frame from the client
    await sleep(100);
    expect(rm.participant(me)).toMatchObject({ peer: null, held: { up: false, down: false } });
    const back = await client();
    const r = await back.request({ t: 'resume', ...cred });
    expect(r).toMatchObject({ t: 'joined', resumed: true, you: me });
    expect((r as { ctlSeq: number }).ctlSeq).toBe(seq);
    expect(history(back).some((m) => m.t === 'state')).toBe(true);   // current at once
    back.send({ t: 'ctl', seq, up: true, down: false });              // the old numbering continues: a replay is refused
    expect(await back.wait((m) => m.t === 'nack' && m.ref === 'ctl')).toMatchObject({ code: 'duplicate' });
    back.setHeld(true, false);
    await sleep(50);
    expect(rm.participant(me)!.held.up).toBe(true);
    expect(rm.race!.car(me)!.status).toBe('running');
    back.close(); cs.forEach((c) => c.close());
  });

  it('a driver whose link drops while the race closes gets the same result envelope on resume', async () => {
    const { cs, id } = await room(2, { track: 'circuit-1' });
    await startRace(cs);
    const stop = autodrive(cs);
    const host = cs[0];
    const hostId = host.me!;
    await host.wait((m) => m.t === 'state' && (m.snap as RaceSnapshot).cars.find((c) => c.id === hostId)!.status !== 'running', 90_000);
    const cred = host.credential()!;
    // the host's link drops after its own finish; the guest drives on and the race closes within the host's grace
    host.onMessage = null; host.stopHeartbeat();
    (host.ws as unknown as WebSocket).terminate();
    const missed = (await cs[1].wait((m) => m.t === 'result', 30_000)) as Extract<ServerMsg, { t: 'result' }>;
    stop();
    expect(results(host)).toHaveLength(0);
    expect(mgr.room(id)!.state).toBe('results');
    const back = await client();
    const r = await back.request({ t: 'resume', ...cred });
    expect(r).toMatchObject({ t: 'joined', resumed: true, you: hostId });
    // joined, state and result go out back to back, so the result may be in before a wait could be set up
    const replay = (results(back)[0] ?? await back.wait((m) => m.t === 'result', 2000)) as Extract<ServerMsg, { t: 'result' }>;
    expect(replay.envelope).toEqual(missed.envelope);
    const order = history(back).map((m) => m.t).filter((t) => t === 'joined' || t === 'state' || t === 'result');
    expect(order).toEqual(['joined', 'state', 'result']);
    back.close(); cs.forEach((c) => c.close());
  }, 120_000);

  it('health and version report the protocol, rules and load; unknown API paths are 404 and accounts are off without a database', async () => {
    const h = await fetch(`${base}/api/health`).then(async (r) => ({ s: r.status, b: (await r.json()) as Record<string, unknown> }));
    expect(h.s).toBe(200);
    expect(h.b).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, rules: 'race-core-2026.11.7', db: 'disabled', accounts: false, roomCap: cfg.roomCap });
    expect(typeof h.b.rssMb).toBe('number');
    expect(await fetch(`${base}/api/version`).then((r) => r.json())).toMatchObject({ protocol: PROTOCOL_VERSION });
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status).toBe(503);
  });
});

describe('a leave that arrives while the server is closing the socket (#106)', () => {
  /** the server's end of a client's socket (same loopback connection) */
  const serverEnd = (c: OnlineClient): WebSocket => {
    const port = ((c.ws as unknown as { _socket: { localPort: number } })._socket).localPort;
    const s = [...app.wss.clients].find((x) => (x as unknown as { _socket: { remotePort: number } })._socket.remotePort === port);
    expect(s, 'server end of the client socket').toBeDefined();
    return s!;
  };
  const settle = () => sleep(150);
  async function pair() {
    const { cs, id } = await room(2);
    const b = cs[1];
    const pid = b.me!;
    const r = mgr.room(id)!;
    return { a: cs[0], b, pid, r };
  }

  it('gives up the seat at once instead of after the reconnect grace', async () => {
    const { a, b, pid, r } = await pair();
    const end = serverEnd(b);
    // the leave is on the wire first; the server starts closing before it reads it, so it is handled on a CLOSING socket
    b.send({ t: 'leave' });
    end.close(4009, 'test');
    expect(end.readyState).toBe(end.CLOSING);
    await settle();
    // a lobby seat given up is removed outright (in a race it would be kept, marked left)
    const p = r.participant(pid);
    expect(p === undefined || (p.left && p.lostAt === null)).toBe(true);
    expect(r.publicRoom().participants.map((x) => x.id)).not.toContain(pid);
    a.close();
  });

  it('a socket being closed because its seat was resumed elsewhere cannot give up the new connection\'s seat', async () => {
    const { a, b, pid, r } = await pair();
    const end = serverEnd(b);
    const token = (history(b).find((m) => m.t === 'joined') as Extract<ServerMsg, { t: 'joined' }>).token;
    const other: Peer = { send: () => {}, close: () => {}, bufferedAmount: 0 };
    b.send({ t: 'leave' });
    // the seat moves to another connection before the old socket's leave is read: the room closes the old socket
    expect(mgr.resume(other, '127.0.0.1', r.id, pid, token, null).ok).toBe(true);
    expect(end.readyState).toBe(end.CLOSING);
    await settle();
    const p = r.participant(pid)!;
    expect(p.left).toBe(false);
    expect(p.peer).toBe(other);
    r.leave(pid, mgr.now());
    a.close();
  });

  it('any other message on a closing socket is still ignored', async () => {
    const { a, b, pid, r } = await pair();
    const end = serverEnd(b);
    b.send({ t: 'ready', ready: true });
    end.close(4009, 'test');
    await settle();
    const p = r.participant(pid)!;
    expect(p.ready).toBe(false);
    expect(p.left).toBe(false);
    expect(p.lostAt).not.toBeNull(); // waiting out the grace, as before
    r.leave(pid, mgr.now());
    a.close();
  });
});
