// Same-seed replay (#141): two Race instances built from the same seed, roster and track and fed the same input tape stay
// identical, step for step, in snapshot() and drainEvents(). The tape drives the subsystems the race-core extracts move out
// of the Race class (stopped-on-track recovery, the away hold, automatic stop-and-go and bay visits, reverse, the squeeze
// queue, de-slot, tow and parking), and the test checks it really reached them, so an extract that changed evaluation order
// or state in any of them shows up here as a divergence or a missing path.
import { describe, expect, it } from 'vitest';
import { Race, type Controls, type Input, type RosterEntry, type WireEvent } from '../src/race';

const DT = 1 / 60;
const STEPS = 3600;   // 60 s of frames, 7,200 simulation steps
const AWAY_IN: Input = { up: false, down: false, away: true };

interface Replay { snaps: unknown[]; wire: WireEvent[]; seen: Set<string> }

function replay(seed: number, track: string): Replay {
  const roster: RosterEntry[] = [
    { id: 'h0', control: 'human' }, { id: 'h1', control: 'human' }, { id: 'ai-a', control: 'ai' }, { id: 'ai-b', control: 'ai' },
  ];
  const r = new Race({ roster, seed, track });
  const car = (id: string) => r.car(id)!;
  const snaps: unknown[] = [], wire: WireEvent[] = [];
  const seen = new Set<string>();
  let seq0 = 0, seq1 = 0;
  for (let i = 0; i < STEPS; i++) {
    const t = i * DT;
    // h0 runs flat out (de-slots, contact), asks for Pit every 20 s and Defer every 30 s, and collects a stop-and-go at 25 s
    if (i % 1200 === 300) r.act({ driver: 'h0', seq: ++seq0, type: 'pit' });
    if (i === 1500) { const o = car('ai-a'); for (let k = 0; k < 3; k++) r.offence(car('h0'), o, 'rear'); }
    if (i % 1800 === 900) r.act({ driver: 'h0', seq: ++seq0, type: 'defer' });
    // h1 asks for a lane change every 3 s
    if (i % 180 === 90) r.act({ driver: 'h1', seq: ++seq1, type: 'lane' });
    // ai-b is nearly dry at 15 s (out-of-fuel tow); ai-a retires at 50 s (coasts, then parks)
    if (i === 900) car('ai-b').fuel = 0.004;
    if (i === 3000) r.retire('ai-a');
    // h1, in 14 s cycles: drive, brake to a stop, stand (stopped-on-track recovery), hold Brake (reverse), drive; away 40-47 s
    const c1 = t % 14;
    const h1: Input = t >= 40 && t < 47 ? AWAY_IN
      : c1 < 4 ? { up: true, down: false } : c1 < 5 ? { up: false, down: true } : c1 < 9 ? { up: false, down: false }
      : c1 < 11.5 ? { up: false, down: true } : { up: true, down: false };
    const inputs: Controls = { h0: { up: true, down: false }, h1 };
    r.update(DT, inputs);
    const ev = r.drainEvents();
    for (const e of ev) seen.add(`ev:${e.type}`);
    wire.push(...ev);
    for (const c of r.cars) {
      if (c.revOn) seen.add('reverse');
      if (c.away) seen.add('away');
      if (c.sgServing) seen.add('serving');
      if (c.stallSvc) seen.add('stallBay');
      if (c.mode === 'off' && !c.retire) seen.add('off');
      if (c.retire === 'parked') seen.add('parked');
      if (c.squeezeHold) seen.add('squeezeHold');
      if (c.sqWait) seen.add('squeezeWait');
    }
    if (r.squeezeQ.length > 1) seen.add('squeezeQueue');
    if (i % 30 === 0) snaps.push(r.snapshot());
  }
  snaps.push(r.snapshot());
  return { snaps, wire, seen };
}

describe('same-seed replay (#141)', () => {
  it.each([[7, 'circuit-1'], [7, 'circuit-4']] as const)('seed %i on %s: two races fed one input tape stay identical', (seed, track) => {
    const a = replay(seed, track), b = replay(seed, track);
    expect(a.snaps.length).toBe(STEPS / 30 + 1);
    expect(b.snaps).toEqual(a.snaps);
    expect(b.wire).toEqual(a.wire);
    // the tape reached every subsystem it is meant to cover
    const want = ['ev:recover', 'ev:offence', 'ev:served', 'ev:tow', 'ev:dnf', 'ev:bump', 'ev:switch', 'ev:lap',
      'away', 'serving', 'stallBay', 'parked', 'squeezeHold', 'squeezeQueue'];
    // circuit-1: a car backs up and one leaves the slot; circuit-4: a car out of the pit lane waits to join the squeeze queue (#110)
    want.push(...(track === 'circuit-1' ? ['ev:deslot', 'off', 'reverse'] : ['squeezeWait']));
    expect(want.filter((k) => !a.seen.has(k))).toEqual([]);
  });
});
