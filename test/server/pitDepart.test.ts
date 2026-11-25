// #164: the bay departure as a remote driver sees it. A page (or a bot) sends its held pedals as `ctl` messages, here one
// every 40 ms. Throttle held from the pit entrance into the bay is never a departure request: the car refuels until the
// driver releases Throttle and presses it again, and the snapshot it is sent says which (`release`, then `ready`).
import { describe, it, expect } from 'vitest';
import { REFUEL_RATE, SERVICE_READY, type CarSnapshot, type RaceSnapshot } from '../../src/race';
import { LENGTH_SET } from '../../src/raceLength';
import { FakePeer, harness } from './harness';
import { drive } from './bot';

const TICK = 40;

/** A solo Harbour Loop room (Standard) with one remote driver; the race is racing when this returns. */
function solo() {
  const h = harness({}, 7);
  const peer = new FakePeer();
  const c = h.mgr.create(peer, { name: 'P0', accountId: null, mode: 'solo', settings: { track: 'circuit-2', aiFill: true, length: 'standard' }, lengths: LENGTH_SET });
  if (!c.ok) throw new Error(c.code);
  const room = c.room, id = c.participant;
  room.handle(id, { t: 'start' }, h.now);
  let seq = 0, act = 0;
  const ctl = (up: boolean, down = false) => { room.handle(id, { t: 'ctl', seq: ++seq, up, down }, h.now); };
  h.advance(10_000, TICK, () => ctl(false), () => room.race!.phase === 'racing');
  const car = () => room.race!.car(id)!;
  const snap = (): CarSnapshot => (peer.lastSnap() as RaceSnapshot).cars.find((x) => x.id === id)!;
  /** One 40 ms tick with these controls sent first; `pit` asks for a fuel stop (numbered, as the page does). */
  const tick = (up: boolean, down = false, pit = false) => {
    ctl(up, down);
    if (pit) room.handle(id, { t: 'act', seq: ++act, type: 'pit' }, h.now);
    h.advance(TICK, TICK);
  };
  return { h, room, id, peer, car, snap, tick };
}

/** Drive from the snapshot (the test bot) until the car stands in its bay, with Throttle held from the pit entrance on. */
function intoBay(s: ReturnType<typeof solo>): void {
  s.car().fuel = 0.4;                                      // low enough that the bot asks for a stop on this lap
  for (let i = 0; i < 60_000 / TICK && s.car().mode !== 'service'; i++) {
    const c = s.snap();
    const b = drive(s.peer.lastSnap() as RaceSnapshot, s.id);
    // held from the moment the car is in the pit lane (or the automatic entry has it), never let go on the way in
    const held = c.mode !== 'race' || c.sgCtl;
    s.tick(held || b.up, held ? false : b.down, !held && b.pit && i % 10 === 0);
  }
  expect(s.car().mode).toBe('service');
}

describe('#164 bay departure over the room server, controls every 40 ms', () => {
  it('Throttle held from the pit entrance keeps refuelling past the minimum; a release then a press leaves', () => {
    const s = solo();
    intoBay(s);
    const f0 = s.car().fuel;
    const phases = new Set<string | null>();
    for (let i = 0; i < 5000 / TICK; i++) { s.tick(true); phases.add(s.snap().sgPhase); }
    const c = s.car();
    expect(c.mode).toBe('service'); expect(c.exitReq).toBe(false);
    expect(c.serviceT).toBeGreaterThan(SERVICE_READY + 4);
    expect(c.fuel).toBeGreaterThanOrEqual(Math.min(1, f0 + REFUEL_RATE * 4) - 1e-6);   // refuelled on (to full here)
    // what the driver's HUD reads: never "press Throttle to leave" while it is held, "release Throttle" once departure is ready
    expect(phases.has('ready')).toBe(false);
    expect(s.snap().sgPhase).toBe('release');
    // let go for one message, then press: the request is taken on the next step and refuelling stops there
    s.tick(false);
    expect(c.sgPhase).toBe('ready');
    s.tick(true);
    expect(c.exitReq || c.mode !== 'service').toBe(true);
    const fAt = c.fuel;
    for (let i = 0; i < 10_000 / TICK && c.mode !== 'pitlane' && c.mode !== 'race'; i++) s.tick(true);
    expect(['pitlane', 'race']).toContain(c.mode);
    expect(c.fuel).toBeLessThanOrEqual(fAt + 1e-9);
  });

  it('Throttle released in the bay: a tap once the minimum is up leaves straight away', () => {
    const s = solo();
    intoBay(s);
    for (let i = 0; i < 60 && s.car().serviceT < SERVICE_READY + 0.05; i++) s.tick(false);
    expect(s.car().serviceT).toBeLessThan(SERVICE_READY + 0.2);
    expect(s.car().sgPhase).toBe('ready');
    s.tick(true);
    expect(s.car().exitReq || s.car().mode !== 'service').toBe(true);
  });
});
