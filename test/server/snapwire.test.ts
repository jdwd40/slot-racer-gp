// Snapshot wire format v2 (#67): static car fields once per race, per-tick deltas of rounded dynamic fields, a keyframe at
// least every second. A whole recorded race is round-tripped and compared with its full snapshots; sizes are measured; a
// client that misses deltas or resumes mid-race recovers; the race result never depends on any of it.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Race, type CarSnapshot, type RaceSnapshot } from '../../src/race';
import { STEP } from '../../src/timing';
import { applySnapshot, mirrorRace } from '../../src/net/mirror';
import { PROTOCOL_VERSION, RULES_VERSION, type ServerMsg } from '../../src/net/protocol';
import { CAR_DYNAMIC, CAR_STATIC, DELETED, KEYFRAME_MS, RACE_FIELDS, SnapDecoder, SnapEncoder, wireRounded, type Precision, type WireStateMsg } from '../../src/net/snapwire';
import { drive } from './bot';
import { BotClient, FakePeer, harness } from './harness';

/** Whole race on the race core, published as the room server does at 20 Hz: one snapshot every 3 steps, with its events. */
function recordRace(seed = 11, track = 'circuit-3') {
  const roster = [
    { id: 'h_a', control: 'human' as const, slot: 0, name: 'Ann' }, { id: 'h_b', control: 'human' as const, slot: 2, name: 'Bob' },
    { id: 'ai_1', control: 'ai' as const, slot: 1 }, { id: 'ai_3', control: 'ai' as const, slot: 3 },
  ];
  const race = new Race({ roster, track, seed, runOn: 'live' });
  const frames: { tick: number; snap: RaceSnapshot; ev: unknown[] }[] = [];
  let seq = 0, ev: unknown[] = [], parkFrom = -1;
  for (let tick = 1; tick < 60 * 600 && !race.final; tick++) {
    const s = race.snapshot();
    const a = drive(s, 'h_a', 1), b = drive(s, 'h_b', 0.93);
    if (a.pit) race.act({ driver: 'h_a', seq: ++seq, type: 'pit' });
    // b changes lane now and then and spins off on a slow lap: lane changes, de-slots, tows and their timers all travel
    if (tick % 1500 === 0) race.act({ driver: 'h_b', seq: ++seq, type: 'lane' });
    const fast = tick % 4000 > 3700;
    // and once lets go entirely on the racing lane: stopped for 3 s it is recovered to its bay (#69 stallT/stallHold/stallSvc
    // and a `recover` event), a recovery a v2 client must see exactly as the server does
    if (parkFrom < 0 && tick >= 8000 && s.cars.find((c) => c.id === 'h_b')!.mode === 'race') parkFrom = tick;
    const parked = parkFrom > 0 && tick < parkFrom + 600;
    race.update(STEP, { h_a: a, h_b: parked ? { up: false, down: false } : fast ? { up: true, down: false } : b });
    ev.push(...race.drainEvents());
    if (tick % 3 === 0 || race.final) { frames.push({ tick, snap: race.snapshot(), ev }); ev = []; }
  }
  expect(race.final).not.toBe(null);
  return frames;
}

const wire = (tick: number, frame: object, ev: unknown[] = []): WireStateMsg & { ev: unknown[] } => JSON.parse(JSON.stringify({ t: 'state', tick, now: 0, lagMs: 0, ev, ...frame })) as WireStateMsg & { ev: unknown[] };
/** within the declared rounding of each field: half a unit of the last kept decimal (exact fields equal) */
function close(full: unknown, got: unknown, p: Precision, path: string): void {
  if (p === 'exact' || typeof full !== 'number') {
    if (full !== null && typeof full === 'object') { for (const k of Object.keys(full)) close((full as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], p, `${path}.${k}`); return; }
    if (p === 'exact') { expect(got, path).toEqual(full); return; }
  }
  if (typeof full === 'number') expect(Math.abs((got as number) - full), path).toBeLessThanOrEqual(0.5 * 10 ** -(p as number) + 1e-9);
  else expect(got, path).toEqual(full);
}

describe('snapshot wire format v2 (#67)', () => {
  const frames = recordRace();

  it('every snapshot field is either static or listed with its precision, once', () => {
    // every field a snapshot ever has is sent (the `satisfies` on the tables is the compile-time half: every CarSnapshot key,
    // optional ones included, must be listed); optional fields may be absent from a given car
    const listed = new Set<string>([...CAR_STATIC, ...Object.keys(CAR_DYNAMIC)]);
    const seen = new Set(frames.flatMap((f) => f.snap.cars.flatMap((c) => Object.keys(c))));
    expect([...seen].filter((k) => !listed.has(k))).toEqual([]);
    expect(CAR_STATIC.every((k) => k in frames[0].snap.cars[0])).toBe(true);
    expect(Object.keys(frames[0].snap).filter((k) => k !== 'cars').sort()).toEqual(Object.keys(RACE_FIELDS).sort());
    expect(CAR_STATIC.some((k) => k in CAR_DYNAMIC)).toBe(false);
  });

  it('a whole recorded race round-trips: decoded = full snapshots with the declared rounding, mirrors agree within it', () => {
    const enc = new SnapEncoder('race-1'), dec = new SnapDecoder();
    let mFull: Race | null = null, mWire: Race | null = null;
    const seen = { off: 0, change: 0, service: 0, final: 0, statics: 0, stallT: 0, stallHold: 0, stallSvc: 0, recover: 0 };
    for (const f of frames) {
      const msg = wire(f.tick, enc.next(f.snap, f.tick, f.tick * STEP * 1000), f.ev);
      // events travel as they are, beside the snapshot
      expect(msg.ev).toEqual(JSON.parse(JSON.stringify(f.ev)));
      seen.recover += f.ev.filter((e) => (e as { type: string }).type === 'recover').length;
      if (msg.static) seen.statics++;
      const got = dec.decode(msg);
      expect(got).not.toBe(null);
      // identical to the full snapshot with the wire rounding, field for field
      expect(got).toEqual(JSON.parse(JSON.stringify(wireRounded(f.snap))));
      for (const [k, p] of Object.entries(RACE_FIELDS)) close((f.snap as unknown as Record<string, unknown>)[k], (got as unknown as Record<string, unknown>)[k], p, k);
      f.snap.cars.forEach((c, i) => {
        for (const k of CAR_STATIC) expect(got!.cars[i][k]).toEqual(c[k]);
        for (const [k, p] of Object.entries(CAR_DYNAMIC)) close(c[k as keyof CarSnapshot], got!.cars[i][k as keyof CarSnapshot], p, `${c.id}.${k}`);
        if (c.off) seen.off++;
        if (c.change) seen.change++;
        if (c.mode === 'service') seen.service++;
        if ((c.stallT ?? 0) > 0) seen.stallT++;
        if (c.stallHold) seen.stallHold++;
        if (c.stallSvc) seen.stallSvc++;
      });
      if (f.snap.final) seen.final++;
      // the browser's mirror: the same state whether fed the full snapshots (v1) or the decoded stream (v2)
      const full = JSON.parse(JSON.stringify(f.snap)) as RaceSnapshot;
      if (!mFull) { mFull = mirrorRace(full); mWire = mirrorRace(got!); } else { applySnapshot(mFull, full); applySnapshot(mWire!, got!); }
      const pitOf = (r: Race) => [r.pit.box, r.pit.exit, r.pit.bays, r.pit.merges, r.pit.order];
      expect([mWire!.phase, mWire!.lights, pitOf(mWire!), mWire!.final]).toEqual([mFull.phase, mFull.lights, pitOf(mFull), mFull.final]);
      for (const c of mFull.cars) {
        const w = mWire!.car(c.id)!;
        for (const [k, p] of Object.entries(CAR_DYNAMIC)) if (k in c) close((c as unknown as Record<string, unknown>)[k], (w as unknown as Record<string, unknown>)[k], p, `mirror ${c.id}.${k}`);
        expect([w.bay, w.idx, w.num, w.name, w.color, w.human]).toEqual([c.bay, c.idx, c.num, c.name, c.color, c.human]);
      }
      expect(mWire!.order().map((c) => c.id)).toEqual(mFull.order().map((c) => c.id));
    }
    // the race exercised what the format has to carry, and the static fields went exactly once
    expect(seen.statics).toBe(1);
    expect(seen.off).toBeGreaterThan(0); expect(seen.change).toBeGreaterThan(0); expect(seen.service).toBeGreaterThan(0); expect(seen.final).toBe(1);
    expect(seen.stallT).toBeGreaterThan(0); expect(seen.stallSvc).toBeGreaterThan(0); expect(seen.recover).toBeGreaterThanOrEqual(1);
    // stallHold (recovered while its own bay was taken) is the rare branch: the next test drives it through the wire
    expect(dec.stats).toMatchObject({ gaps: 0, noStatic: 0 });
    expect(dec.stats.keyframes).toBeGreaterThanOrEqual(Math.floor((frames.length * 3 * STEP * 1000) / KEYFRAME_MS));
    expect(enc.stats.deltas).toBeGreaterThan(enc.stats.keyframes * 15);
  });

  it('the wire copy never touches the race: snapshots and the encoder baseline are independent', () => {
    const r = new Race({ track: 'circuit-1', seed: 3 });
    for (let i = 0; i < 600; i++) r.update(STEP, {});
    const before = JSON.stringify(r.snapshot());
    const enc = new SnapEncoder('x');
    const s = r.snapshot();
    enc.next(s, 1, 0);
    expect(JSON.stringify(s)).toBe(before);        // the snapshot handed in is not rounded in place
    expect(JSON.stringify(r.snapshot())).toBe(before);
  });

  it('deltas carry only what changed; an optional field that disappears is named as deleted, and comes back', () => {
    const enc = new SnapEncoder('r'), dec = new SnapDecoder();
    const [a, b] = [frames[400].snap, frames[401].snap];
    dec.decode(wire(1, enc.next(a, 1, 0)));
    const same = enc.next(a, 2, 50);
    expect(same.snap.cars.every((c) => Object.keys(c).length === 0)).toBe(true);
    expect(Object.keys(same.snap).filter((k) => k !== 'cars')).toEqual([]);
    expect(dec.decode(wire(2, same))).toEqual(JSON.parse(JSON.stringify(wireRounded(a))));
    // a field absent from a car (as an optional field would be), then present again
    const gone = JSON.parse(JSON.stringify(b)) as RaceSnapshot;
    delete (gone.cars[1] as Partial<CarSnapshot>).bumpT;
    const d = enc.next(gone, 3, 100);
    expect(d.snap.cars[1][DELETED]).toEqual(['bumpT']);
    const got = dec.decode(wire(3, d))!;
    expect('bumpT' in got.cars[1]).toBe(false);
    expect(got).toEqual(JSON.parse(JSON.stringify(wireRounded(gone))));
    const back = dec.decode(wire(4, enc.next(b, 4, 150)))!;
    expect(back).toEqual(JSON.parse(JSON.stringify(wireRounded(b))));
  });

  it('the #69 stall fields round-trip in every state: countdown, hold in the tow, bay without fuel, and absent', () => {
    const enc = new SnapEncoder('r'), dec = new SnapDecoder();
    const base = frames[600].snap;
    const variant = (k: number, f: (c: CarSnapshot) => void): RaceSnapshot => { const s = JSON.parse(JSON.stringify(base)) as RaceSnapshot; f(s.cars[1]); s.t += k; return s; };
    const seq = [
      variant(0, () => undefined),
      variant(1, (c) => { c.stallT = 1.2345678; }),
      variant(2, (c) => { c.stallT = 0; c.stallHold = true; c.mode = 'tow'; }),
      variant(3, (c) => { c.stallHold = false; c.stallSvc = true; c.mode = 'service'; }),
      // an older-shaped snapshot without the optional fields: they are named as deleted and the mirror reads no countdown
      variant(4, (c) => { delete c.stallT; delete c.stallHold; delete c.stallSvc; }),
      variant(5, (c) => { c.stallT = 0.5; c.stallHold = false; c.stallSvc = false; }),
    ];
    seq.forEach((s, i) => {
      const f = enc.next(s, i + 1, i * 50);
      const got = dec.decode(wire(i + 1, f))!;
      expect(got).toEqual(JSON.parse(JSON.stringify(wireRounded(s))));
      expect(got.cars[1].stallT).toBe(s.cars[1].stallT);   // exact on the wire: the HUD counts down the server's value
      if (i === 4) expect(f.snap.cars[1][DELETED]).toEqual(['stallT', 'stallHold', 'stallSvc']);
    });
  });

  it('a 4-car race averages well under 1.5 KB a state (v1 sent every field of every car)', () => {
    const enc = new SnapEncoder('3f2c6e1a-0d5b-4a8e-9a77-2f1d7b0c9e41');
    let v1 = 0, v2 = 0;
    for (const f of frames) {
      const base = { t: 'state', tick: f.tick, now: 1_762_862_400_000 + f.tick * 17, lagMs: 0 };
      v1 += Buffer.byteLength(JSON.stringify({ ...base, snap: f.snap, ev: f.ev }));
      v2 += Buffer.byteLength(JSON.stringify({ ...base, ev: f.ev, ...enc.next(f.snap, f.tick, f.tick * STEP * 1000) }));
    }
    const avg1 = v1 / frames.length, avg2 = v2 / frames.length;
    expect(avg2).toBeLessThan(1500);
    expect(avg2 / avg1).toBeLessThan(0.3);   // at least 70% smaller
  });
});

describe('keyframes and recovery', () => {
  const frames = recordRace(23, 'circuit-1').slice(0, 400);

  it('a client that misses deltas shows nothing half-applied and is whole again at the next keyframe', () => {
    const enc = new SnapEncoder('r'), ok = new SnapDecoder(), lossy = new SnapDecoder();
    const msgs = frames.map((f) => wire(f.tick, enc.next(f.snap, f.tick, f.tick * STEP * 1000)));
    const keys = msgs.flatMap((m, i) => (m.key ? [i] : []));
    // a keyframe at least every KEYFRAME_MS of race time
    for (let k = 1; k < keys.length; k++) expect((msgs[keys[k]].tick - msgs[keys[k - 1]].tick) * STEP * 1000).toBeLessThanOrEqual(KEYFRAME_MS + 1e-6);
    const lost = keys[2] + 5;
    let recovered = -1;
    msgs.forEach((m, i) => {
      const want = ok.decode(m);
      if (i === lost) return;   // never delivered
      const got = lossy.decode(m);
      if (i > lost && i < keys[3]) expect(got).toBe(null);
      else { expect(got).toEqual(want); if (i >= keys[3] && recovered < 0) recovered = i; }
    });
    expect(recovered).toBe(keys[3]);
    expect(lossy.stats.gaps).toBe(keys[3] - lost - 1);
  });

  it('a client without the race\'s static fields waits; the resume keyframe makes it whole and later deltas apply', () => {
    const enc = new SnapEncoder('r'), ok = new SnapDecoder(), late = new SnapDecoder();
    frames.forEach((f, i) => {
      const m = wire(f.tick, enc.next(f.snap, f.tick, f.tick * STEP * 1000));
      const want = ok.decode(m);
      if (i < 150) return;
      if (i < 200) { expect(late.decode(m)).toBe(null); return; }   // ordinary keyframes and deltas only: no static fields
      if (i === 200) {
        // resuming: the room's resume state is the last broadcast, as a keyframe with the static fields
        const r = enc.resume()!;
        expect(r.tick).toBe(f.tick);
        expect(r.frame.static?.cars.map((c) => c.id)).toEqual(f.snap.cars.map((c) => c.id));
        expect(late.decode(wire(r.tick, r.frame))).toEqual(want);
        return;
      }
      expect(late.decode(m)).toEqual(want);
    });
    expect(late.stats.noStatic).toBeGreaterThan(0);
  });
});

/** A 4-human room race in the in-process harness, bots driving from their own peer's decoded snapshots. */
function roomRace(seed: number) {
  const h = harness({}, seed);
  const peers = [new FakePeer()];
  const c = h.mgr.create(peers[0], { name: 'Player0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1' } });
  if (!c.ok) throw new Error(c.code);
  const ids = [c.participant], tokens = [c.token];
  for (let k = 1; k < 4; k++) {
    const p = new FakePeer();
    const j = h.mgr.join(p, `10.0.0.${k}`, { code: c.room.code, name: `Player${k}`, accountId: null });
    if (!j.ok) throw new Error(j.code);
    peers.push(p); ids.push(j.participant); tokens.push(j.token);
  }
  const room = c.room;
  for (const id of ids.slice(1)) room.handle(id, { t: 'ready', ready: true }, h.now);
  room.handle(ids[0], { t: 'start' }, h.now);
  return { h, room, peers, ids, tokens };
}
const states = (p: FakePeer): string[] => p.raw.filter((s) => s.startsWith('{"t":"state"'));

describe('the room server streams v2 states', () => {
  it('a 4-human race at 20 Hz: < 1.5 KB a state on average, a keyframe every second, identical bytes to every member', () => {
    const { h, room, peers, ids } = roomRace(4242);
    const bots = ids.map((id, k) => new BotClient(peers[k], id, 1 - k * 0.03));
    h.advance(900_000, 50, () => {
      if (room.state !== 'race') return;
      for (const b of bots) {
        const o = b.controls(); if (!o) continue;
        room.handle(b.id, { t: 'ctl', seq: ++b.ctl, up: o.up, down: o.down }, h.now);
        if (o.pit) room.handle(b.id, { t: 'act', seq: ++b.act, type: 'pit' }, h.now);
      }
    }, () => room.state !== 'race');
    expect(room.result?.outcome).toBe('completed');
    const raw = states(peers[0]);
    for (const p of peers) expect(states(p)).toEqual(raw);
    const avg = raw.reduce((n, s) => n + Buffer.byteLength(s), 0) / raw.length;
    expect(avg).toBeLessThan(1500);
    const msgs = raw.map((s) => JSON.parse(s) as WireStateMsg & { now: number });
    expect(msgs[0]).toMatchObject({ key: 1, static: { race: room.result!.raceId } });
    expect(msgs.filter((m) => m.static)).toHaveLength(1);   // static fields once per race
    const keyAt = msgs.filter((m) => m.key).map((m) => m.now);
    for (let k = 1; k < keyAt.length; k++) expect(keyAt[k] - keyAt[k - 1]).toBeLessThanOrEqual(KEYFRAME_MS);
    // every delta builds on the state broadcast just before it, and every member decoded every state
    for (let i = 1; i < msgs.length; i++) if (!msgs[i].key) expect(msgs[i].base).toBe(msgs[i - 1].tick);
    for (const p of peers) expect(p.dec.stats).toMatchObject({ gaps: 0, noStatic: 0 });
    expect((peers[0].lastSnap()!.final ?? []).map((x) => x.id)).toEqual(room.result!.classification!.map((x) => x.id));
  });

  it('a seat resumed mid-race gets a keyframe of the last broadcast with the static fields, then decodes what everyone does', () => {
    const { h, room, peers, ids, tokens } = roomRace(99);
    const drive = () => { let n = 0; return () => { n++; ids.forEach((id, k) => { if (room.participant(id)?.peer) room.handle(id, { t: 'ctl', seq: n, up: (n + 5 * k) % 30 < 24, down: false }, h.now); }); }; };
    const each = drive();
    h.advance(20_000, 50, each);
    room.disconnect(ids[2], peers[2], h.now);
    h.advance(3_330, 10, each);   // off the 50 ms grid: the resume falls between snapshot slots and keyframes
    const back = new FakePeer();
    expect(h.mgr.resume(back, '10.0.0.2', room.id, ids[2], tokens[2], null)).toMatchObject({ ok: true });
    // sent at once, as app.ts does after `joined`
    const st = room.stateMsg(h.now)!;
    back.send(st);
    const first = JSON.parse(st) as WireStateMsg;
    expect(first).toMatchObject({ key: 1, static: { race: room.raceId } });
    expect(first.tick).toBe(peers[0].of('state').at(-1)!.tick);   // the last broadcast state, not a newer one
    expect(back.lastSnap()).toEqual(peers[0].lastSnap());
    const from = peers[0].raw.length;
    h.advance(10_000, 10, each);
    const after = peers[0].of('state').filter((m) => peers[0].msgs.indexOf(m) >= from - 0);
    expect(after.length).toBeGreaterThan(100);
    // from the next broadcast on the resumed seat gets the same bytes and decodes the same states
    const tail = (p: FakePeer) => p.of('state').slice(-after.length);
    expect(tail(back)).toEqual(tail(peers[0]));
    expect(back.dec.stats).toMatchObject({ gaps: 0, noStatic: 0 });
  });

  it('same seed and inputs give the same result digest as before the wire change (race results unchanged)', () => {
    // inputs scripted by tick (never read from snapshots), so the result is a function of the seed and inputs alone. The
    // digest covers the whole envelope except its random ids and the protocol number; pinned on main before #67 (1b2f865, rules race-core-2026.11.3)
    const run = () => {
      const h = harness({}, 4242);
      const peers = [new FakePeer(), new FakePeer()];
      const c = h.mgr.create(peers[0], { name: 'P0', accountId: null, mode: 'multiplayer', settings: { track: 'circuit-1', aiFill: true } });
      if (!c.ok) throw new Error(c.code);
      const j = h.mgr.join(peers[1], '10.0.0.1', { code: c.room.code, name: 'P1', accountId: null });
      if (!j.ok) throw new Error(j.code);
      const ids = [c.participant, j.participant], room = c.room;
      room.handle(ids[1], { t: 'ready', ready: true }, h.now); room.handle(ids[0], { t: 'start' }, h.now);
      let n = 0;
      h.advance(2_000_000, 50, () => { n++; ids.forEach((id, k) => room.handle(id, { t: 'ctl', seq: n, up: (n + 7 * k) % 40 < 31, down: false }, h.now)); }, () => room.state !== 'race');
      const env = room.result!;
      expect(env.rules).toEqual({ version: RULES_VERSION, protocol: PROTOCOL_VERSION });
      const norm = ids.reduce((s, id, k) => s.split(id).join(`H${k}`), JSON.stringify({ ...env, digest: '', raceId: '', roomId: '', rules: { version: env.rules.version } }));
      return { digest: createHash('sha256').update(norm).digest('hex'), outcome: env.outcome, ticks: env.times.ticks };
    };
    const a = run(), b = run();
    expect(b).toEqual(a);
    expect(a).toEqual({ digest: '00ce7abd722e661d701f68521260aba33d08fdb24160b5477c345c1505eacfc0', outcome: 'completed', ticks: 18031 });
  });
});

describe('protocol version', () => {
  it('v2, and the server build reads it the way scripts/build-server.mjs writes server-dist/protocol.json', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    const src = readFileSync(new URL('../../src/net/protocol.ts', import.meta.url), 'utf8');
    expect(Number(/PROTOCOL_VERSION = (\d+)/.exec(src)?.[1])).toBe(PROTOCOL_VERSION);
    const build = readFileSync(new URL('../../scripts/build-server.mjs', import.meta.url), 'utf8');
    expect(build).toContain("/PROTOCOL_VERSION = (\\d+)/.exec(src)");
    expect(build).toContain('server-dist/protocol.json');
  });

  it('a v1-shaped state (a full snapshot, no key or base) is never decoded into a partial race', () => {
    const dec = new SnapDecoder();
    const v1 = JSON.parse(JSON.stringify({ t: 'state', tick: 3, now: 0, lagMs: 0, snap: new Race({ track: 'circuit-1', seed: 1 }).snapshot(), ev: [] })) as ServerMsg;
    expect(dec.decode(v1 as unknown as WireStateMsg)).toBe(null);
  });
});
