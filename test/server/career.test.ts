// Career points and personal bests from server-finalized results (docs/career.md): scoring, the final-lap DQ podium change
// on the real room/race core, identical awards for every member, and the durable result queue across a simulated restart.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAPS, PEN, type Standing } from '../../src/race';
import { CHAMP_POINTS, roundPoints } from '../../src/records';
import { parseClientMessage, type AwardsView } from '../../src/net/protocol';
import { computeAwards, lapBests, makeScoring, parsePodium, type Scoring } from '../../server/career';
import { buildEnvelope, type EnvelopeParticipant, type ResultEnvelope } from '../../server/envelope';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink, ResultConflict, type ResultSink } from '../../server/results';
import { DurableSink } from '../../server/spool';
import type { Room } from '../../server/room';
import { BotClient, FakePeer, harness } from './harness';

const S = makeScoring();
type H = ReturnType<typeof harness>;

function env(o: { mode?: ResultEnvelope['mode']; outcome?: ResultEnvelope['outcome']; rows: [string, Standing['status'], 'acct' | 'guest' | 'ai'][]; laps?: ResultEnvelope['laps'] }): Readonly<ResultEnvelope> {
  let pos = 0;
  const participants: EnvelopeParticipant[] = o.rows.map(([id, , kind], slot) => ({ id, control: kind === 'ai' ? 'ai' : 'human', slot, num: slot + 1, bay: slot, name: id, livery: 'red', accountId: kind === 'acct' ? `${100 + slot}` : null }));
  const classification: Standing[] = o.rows.map(([id, status, kind], slot) => ({
    id, slot, control: kind === 'ai' ? 'ai' : 'human', pos: status === 'finished' ? ++pos : null, status, time: status === 'finished' ? 100 + slot : null,
    laps: LAPS, bestLap: 7, pitStops: 1, timePen: 0, dqReason: status === 'dq' ? 'stopGo' : null, dnfReason: status === 'dnf' ? 'retired' : null,
  }));
  return buildEnvelope({
    raceId: '33333333-3333-4333-8333-333333333333', roomId: '44444444-4444-4444-8444-444444444444', mode: o.mode ?? 'multiplayer', championship: null,
    outcome: o.outcome ?? 'completed', abortReason: null, trackId: 'circuit-1', settings: { track: 'circuit-1', aiFill: false }, participants,
    classification: (o.outcome ?? 'completed') === 'completed' && o.mode !== 'practice' ? classification : null, laps: o.laps ?? [],
    times: { roomCreatedAt: '2026-11-09T12:00:00.000Z', startedAt: '2026-11-09T12:00:01.000Z', greenAt: null, finishedAt: '2026-11-09T12:05:00.000Z', raceTimeS: 300, ticks: 1 },
  });
}
const pts = (e: Readonly<ResultEnvelope>) => computeAwards(e, S).view.rows.map((r) => [r.participant, r.pos, r.points, r.credit]);

describe('career scoring policy', () => {
  it('1st/2nd/3rd/4th award 10/6/4/0; DQ and DNF award 0; the local championship still scores 10/6/4/2', () => {
    expect(S.version).toBe('career-1:10-6-4');
    expect(pts(env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct'], ['c', 'finished', 'acct'], ['d', 'finished', 'acct']] })))
      .toEqual([['a', 1, 10, true], ['b', 2, 6, true], ['c', 3, 4, true], ['d', 4, 0, true]]);
    const w = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct'], ['c', 'dnf', 'acct'], ['d', 'dq', 'acct']] });
    expect(pts(w)).toEqual([['a', 1, 10, true], ['b', 2, 6, true], ['c', null, 0, true], ['d', null, 0, true]]);
    expect(computeAwards(w, S).ledger.map((l) => [l.accountId, l.status, l.points])).toEqual([['100', 'finished', 10], ['101', 'finished', 6], ['102', 'dnf', 0], ['103', 'dq', 0]]);
    // local championship scoring is a separate system and is unchanged
    expect(CHAMP_POINTS).toEqual([10, 6, 4, 2]);
    expect(roundPoints({ track: 'circuit-1', order: [0, 1, 2, 3].map((idx) => ({ idx, dnf: false, time: 1 })) }, 3)).toBe(2);
  });

  it('AI and guests occupy their positions but credit nobody; accounts behind them score from their real position', () => {
    const e = env({ rows: [['ai1', 'finished', 'ai'], ['g', 'finished', 'guest'], ['a', 'finished', 'acct'], ['ai2', 'finished', 'ai']] });
    expect(pts(e)).toEqual([['ai1', 1, 0, false], ['g', 2, 0, false], ['a', 3, 4, true], ['ai2', 4, 0, false]]);
    expect(computeAwards(e, S).ledger.map((l) => l.participant)).toEqual(['a']);
  });

  it('practice, aborted and unclassified sessions are ineligible and award nothing to anyone', () => {
    const rows: [string, Standing['status'], 'acct'][] = [['a', 'finished', 'acct'], ['b', 'finished', 'acct']];
    expect(computeAwards(env({ mode: 'practice', outcome: 'ended', rows }), S)).toMatchObject({ view: { eligible: false, reason: 'practice', rows: [] }, ledger: [] });
    expect(computeAwards(env({ outcome: 'aborted', rows }), S)).toMatchObject({ view: { eligible: false, reason: 'incomplete', rows: [] }, ledger: [] });
  });

  it('points are configurable; the scoring version follows the points so a retune is never confused with the old one', () => {
    expect(parsePodium(undefined)).toEqual([10, 6, 4]);
    expect(parsePodium('12, 8,5')).toEqual([12, 8, 5]);
    expect(() => parsePodium('10,x')).toThrow();
    expect(() => parsePodium('-1')).toThrow();
    const alt = makeScoring([12, 8, 5]);
    expect(alt.version).not.toBe(S.version);
    expect(computeAwards(env({ rows: [['a', 'finished', 'acct']] }), alt).view.rows[0].points).toBe(12);
  });

  it('personal-best candidates: fastest valid lap per signed-in human, final lap included; invalid laps, guests and aborted races never qualify', () => {
    const laps = [
      { driver: 'a', lap: 1, time: 9.1, valid: true, raceT: 9 }, { driver: 'a', lap: 2, time: 7.2, valid: false, raceT: 16 },
      { driver: 'a', lap: 13, time: 7.5, valid: true, raceT: 100 }, { driver: 'g', lap: 2, time: 6.0, valid: true, raceT: 10 },
      { driver: 'a', lap: 3, time: 0.2, valid: true, raceT: 17 },
    ];
    const rows: [string, Standing['status'], 'acct' | 'guest'][] = [['a', 'finished', 'acct'], ['g', 'finished', 'guest']];
    expect(lapBests(env({ rows, laps }))).toEqual([expect.objectContaining({ accountId: '100', lapMs: 7500, lap: 13, mode: 'multiplayer', trackId: 'circuit-1' })]);
    expect(lapBests(env({ rows, laps, outcome: 'aborted' }))).toEqual([]);
    expect(lapBests(env({ rows, laps, mode: 'practice', outcome: 'ended' }))[0]).toMatchObject({ mode: 'practice', lapMs: 7500 });
  });

  it('a client cannot send a result, award or points message: the protocol has no such client message', () => {
    for (const t of ['result', 'awards', 'points', 'pb']) expect(parseClientMessage(JSON.stringify({ t, points: 10 }))).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseClientMessage(JSON.stringify({ t: 'ready', ready: true, points: 99 }))).toMatchObject({ ok: false });
  });
});

/** A four-human multiplayer room of signed-in accounts. */
function fourAccounts(h: H, track = 'circuit-1') {
  const peers = [new FakePeer()];
  const c = h.mgr.create(peers[0], { name: 'A', accountId: '1', mode: 'multiplayer', settings: { track } });
  if (!c.ok) throw new Error(c.code);
  const ids = [c.participant];
  for (let k = 1; k < 4; k++) {
    const p = new FakePeer();
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: 'ABCD'[k], accountId: `${k + 1}` });
    if (!j.ok) throw new Error(j.code);
    peers.push(p); ids.push(j.participant);
  }
  for (const id of ids.slice(1)) c.room.handle(id, { t: 'ready', ready: true }, h.now);
  c.room.handle(ids[0], { t: 'start' }, h.now);
  return { room: c.room, peers, ids };
}
function drive(h: H, room: Room, peers: FakePeer[], ids: string[]): void {
  const bots = ids.map((id, k) => new BotClient(peers[k], id, 1 - k * 0.03));
  h.advance(900_000, 50, () => {
    if (room.state !== 'race') return;
    for (const b of bots) {
      const o = b.controls(); if (!o) continue;
      room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now);
      if (o.pit) room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now);
    }
  }, () => room.state !== 'race');
}

describe('awards from a real server race', () => {
  it('an unserved stop-and-go given to the leader on the final lap disqualifies them at the flag: the podium moves up and every member sees the same awards', async () => {
    const h = harness();
    const { room, peers, ids } = fourAccounts(h);
    const r = room.race!;
    let leader = '';
    const update = r.update.bind(r);
    r.update = (dt, inputs) => {
      update(dt, inputs);
      if (leader || r.phase !== 'racing') return;
      // the leading car, past the last pit entrance on its final lap: a stop it can no longer serve
      const lead = [...r.cars].sort((a, b) => b.u - a.u)[0];
      const s = r.T.wrapS(lead.u);
      if (lead.crossed === LAPS && lead.mode === 'race' && lead.sgOwed === 0 && s > r.T.PIT_IN1 + 1 && s < r.T.FINISH_S - 4) {
        lead.sgOwed = PEN.stopSeconds; lead.sgDue = LAPS; lead.sgDeferred = true; leader = lead.id;
      }
    };
    drive(h, room, peers, ids);
    expect(leader).not.toBe('');
    const e = room.result!;
    expect(e.outcome).toBe('completed');
    const dq = e.classification!.find((s) => s.id === leader)!;
    expect(dq).toMatchObject({ status: 'dq', pos: null, dqReason: 'stopGo' });
    // the leader would have won: they were first on the road; classification ranks the others 1..3 without them
    const fin = e.classification!.filter((s) => s.status === 'finished');
    expect(fin.map((s) => s.pos)).toEqual(fin.map((_, i) => i + 1));
    await Promise.resolve(); await Promise.resolve();
    const views = peers.map((p) => p.of('awards'));
    for (const v of views) expect(v.map((m) => m.awards.sync)).toEqual(['saving', 'saved']);
    const final = views[0].at(-1)!.awards as AwardsView;
    for (const v of views) expect(JSON.stringify(v.at(-1)!.awards)).toBe(JSON.stringify(final));
    expect(final.rows.find((x) => x.participant === leader)).toMatchObject({ status: 'dq', pos: null, points: 0, credit: true });
    const byPos = new Map(final.rows.filter((x) => x.pos).map((x) => [x.pos, x.points]));
    expect([byPos.get(1), byPos.get(2), byPos.get(3)]).toEqual([10, 6, 4]);
    // the awards never carry account ids to the room
    expect(JSON.stringify(final)).not.toMatch(/accountId/);
    // every finisher's final lap is in the envelope, so it can count as a personal best
    for (const s of fin) expect(e.laps.filter((l) => l.driver === s.id).map((l) => l.lap)).toContain(LAPS);
    expect(lapBests(e).length).toBeGreaterThan(0);
  });

  it('a reconnect after the result replays the same result and awards; the sink stored the race once', async () => {
    const h = harness();
    const { room, peers, ids } = fourAccounts(h, 'circuit-2');
    drive(h, room, peers, ids);
    await Promise.resolve(); await Promise.resolve();
    expect(room.awards?.sync).toBe('saved');
    expect(h.sink.calls).toBe(1);
    expect(await h.sink.consume(room.result!)).toBe('duplicate');
  });
});

class Flaky implements ResultSink {
  down = true; calls = 0;
  /** the scoring version each successful store was given */
  scored: string[] = [];
  constructor(readonly inner = new MemoryResultSink()) {}
  async consume(e: Readonly<ResultEnvelope>, s?: Scoring) {
    this.calls++;
    if (this.down) throw new Error('connect ECONNREFUSED');
    const r = await this.inner.consume(e);
    if (r === 'stored') this.scored.push(s?.version ?? 'none');
    return r;
  }
}
/** wait (real time: the sink writes to disk) until the room's awards leave `from` */
async function settledFrom(room: Room, from: AwardsView['sync']): Promise<void> {
  for (let i = 0; i < 400 && (!room.awards || room.awards.sync === from); i++) await new Promise((r) => setTimeout(r, 5));
}
const spoolDir = () => mkdtempSync(join(tmpdir(), 'srgp-spool-'));
/** a spool path that cannot be written: a regular file stands where the directory should be */
function blockedSpool(): string { const d = join(spoolDir(), 'spool'); writeFileSync(d, 'not a directory'); return d; }

describe('durable result queue', () => {
  it('a storage failure is spooled to disk and reported pending; after a restart the spool is stored exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srgp-spool-'));
    const log = memoryLogger();
    const store = new Flaky();
    const a = new DurableSink(store, { dir, log, retryMs: 60_000 });
    const e = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct']] });
    expect(await a.consume(e)).toBe('queued');
    expect(await a.consume(e)).toBe('queued');   // a second delivery while queued is the same queued result
    expect(readdirSync(dir)).toEqual([`${e.raceId}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${e.raceId}.json`), 'utf8')).envelope.digest).toBe(e.digest);
    a.stop();   // the process stops with the database still down

    // restart: a new process loads the spool and stores it once the database is back
    store.down = false;
    const settled: string[] = [];
    const b = new DurableSink(store, { dir, log, retryMs: 60_000 });
    b.onSettled = (id, r) => settled.push(`${id}:${r}`);
    await b.start();
    expect(settled).toEqual([`${e.raceId}:saved`]);
    expect(readdirSync(dir)).toEqual([]);
    expect(store.inner.stored.size).toBe(1);
    // a re-delivery after that (a retry that raced the drain, a second process) is a duplicate, never a second award
    expect(await b.consume(e)).toBe('duplicate');
    const c = new DurableSink(store, { dir, log });
    await c.start();
    expect(store.inner.stored.size).toBe(1);
    b.stop(); c.stop();
  });

  it('a spooled result edited on disk (more points, another position) is refused by its digest and never stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srgp-spool-'));
    const log = memoryLogger();
    const store = new Flaky();
    const e = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct']] });
    const a = new DurableSink(store, { dir, log, retryMs: 60_000 });
    await a.consume(e); a.stop();
    const f = join(dir, `${e.raceId}.json`);
    const j = JSON.parse(readFileSync(f, 'utf8')) as { envelope: { classification: Standing[] } };
    const cl = j.envelope.classification;
    [cl[0].id, cl[1].id] = [cl[1].id, cl[0].id];
    writeFileSync(f, JSON.stringify(j));
    store.down = false;
    const b = new DurableSink(store, { dir, log });
    await b.start();
    expect(store.inner.stored.size).toBe(0);
    expect(readdirSync(dir)).toEqual([`${e.raceId}.json.bad`]);
    expect(log.lines.some((l) => l.includes('result.spool_corrupt'))).toBe(true);
    b.stop();
  });

  it('a spooled result is stored with the scoring policy shown at the finish, even after the points are reconfigured', async () => {
    const dir = spoolDir();
    const log = memoryLogger();
    const store = new Flaky();
    const e = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct']] });
    const shown = makeScoring([10, 6, 4]);
    const a = new DurableSink(store, { dir, log, scoring: shown, retryMs: 60_000 });
    expect(await a.consume(e, shown)).toBe('queued');
    expect(JSON.parse(readFileSync(join(dir, `${e.raceId}.json`), 'utf8')).scoring).toEqual({ version: 'career-1:10-6-4', podium: [10, 6, 4] });
    a.stop();
    // restart with SLOTRUSH_CAREER_POINTS changed: the queued race still stores the policy its room showed
    store.down = false;
    const b = new DurableSink(store, { dir, log, scoring: makeScoring([25, 18, 15]) });
    await b.start();
    expect(store.scored).toEqual(['career-1:10-6-4']);
    expect(log.lines.some((l) => l.includes('result.spool_scoring'))).toBe(true);
    b.stop();
  });

  it('a spool file whose scoring policy was altered (points without the matching version) is refused', async () => {
    const dir = spoolDir();
    const log = memoryLogger();
    const store = new Flaky();
    const e = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct']] });
    const a = new DurableSink(store, { dir, log, retryMs: 60_000 });
    await a.consume(e, S); a.stop();
    const f = join(dir, `${e.raceId}.json`);
    const j = JSON.parse(readFileSync(f, 'utf8')) as { scoring: { podium: number[] } };
    j.scoring.podium = [100, 60, 40];
    writeFileSync(f, JSON.stringify(j));
    store.down = false;
    const b = new DurableSink(store, { dir, log });
    await b.start();
    expect(store.inner.stored.size).toBe(0);
    expect(readdirSync(dir)).toEqual([`${e.raceId}.json.bad`]);
    b.stop();
  });

  it('a result the spool cannot write is reported unsaved, never queued; it turns pending once the spool takes it', async () => {
    const dir = blockedSpool();
    const log = memoryLogger();
    const store = new Flaky();
    const e = env({ rows: [['a', 'finished', 'acct'], ['b', 'finished', 'acct']] });
    const a = new DurableSink(store, { dir, log, retryMs: 60_000 });
    const settled: string[] = [];
    a.onSettled = (id, r) => settled.push(`${id}:${r}`);
    expect(await a.consume(e, S)).toBe('unsaved');
    expect(await a.consume(e, S)).toBe('unsaved');   // a re-delivery is not acknowledged as durable either
    expect([a.pending, a.unsaved]).toEqual([1, 1]);
    expect(log.lines.some((l) => l.includes('result.spool_failed'))).toBe(true);
    // the disk problem clears while the database is still down: the next pass writes it to the spool
    unlinkSync(dir);
    await a.drain();
    expect(settled).toEqual([`${e.raceId}:pending`]);
    expect([a.pending, a.unsaved]).toEqual([1, 0]);
    expect(readdirSync(dir)).toEqual([`${e.raceId}.json`]);
    expect(await a.consume(e, S)).toBe('queued');
    a.stop();
    expect(log.lines.some((l) => l.includes('result.lost'))).toBe(false);
  });

  it('stopping with a result held only in memory logs it as lost; without a spool directory nothing is reported queued', async () => {
    const log = memoryLogger();
    const a = new DurableSink(new Flaky(), { dir: null, log, retryMs: 60_000 });
    expect(await a.consume(env({ rows: [['a', 'finished', 'acct']] }), S)).toBe('unsaved');
    a.stop();
    expect(log.lines.some((l) => l.includes('result.lost'))).toBe(true);
  });

  it('a room whose result the spool cannot write shows unsaved, then pending once it is on disk, then saved', async () => {
    const h = harness();
    const store = new Flaky();
    const dir = blockedSpool();
    const durable = new DurableSink(store, { dir, log: h.log, retryMs: 60_000 });
    (h.mgr as unknown as { deps: { sink: ResultSink } }).deps.sink = durable;
    durable.onSettled = (id, r) => h.mgr.settled(id, r);
    const { room, peers, ids } = fourAccounts(h, 'circuit-3');
    drive(h, room, peers, ids);
    await settledFrom(room, 'saving');
    expect(room.awards?.sync).toBe('unsaved');
    unlinkSync(dir);
    await durable.drain();
    expect(room.awards?.sync).toBe('pending');
    store.down = false;
    await durable.drain();
    for (const p of peers) expect(p.of('awards').map((m) => m.awards.sync)).toEqual(['saving', 'unsaved', 'pending', 'saved']);
    expect(store.scored).toEqual([S.version]);
    durable.stop();
  });

  it('a room shows pending while storage is down and saved once the queue stores it; a conflicting result is reported failed', async () => {
    const h = harness();
    const store = new Flaky();
    const durable = new DurableSink(store, { dir: spoolDir(), log: h.log, retryMs: 60_000 });
    (h.mgr as unknown as { deps: { sink: ResultSink } }).deps.sink = durable;
    durable.onSettled = (id, r) => h.mgr.settled(id, r);
    const { room, peers, ids } = fourAccounts(h, 'circuit-3');
    drive(h, room, peers, ids);
    await settledFrom(room, 'saving');
    expect(room.awards?.sync).toBe('pending');
    expect(peers[0].of('awards').at(-1)!.awards.sync).toBe('pending');
    store.down = false;
    await durable.drain();
    expect(room.awards?.sync).toBe('saved');
    for (const p of peers) expect(p.of('awards').map((m) => m.awards.sync)).toEqual(['saving', 'pending', 'saved']);
    expect(store.inner.stored.size).toBe(1);
    // a different result for an already-stored race is a conflict: refused, never stored over the first
    const other = { ...room.result!, digest: '0'.repeat(64) };
    await expect(store.inner.consume(other)).rejects.toBeInstanceOf(ResultConflict);
    durable.stop();
  });
});
