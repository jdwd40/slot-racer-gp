// Post-finish spectating in the browser (#135, docs/spectating.md): the view target is separate from the driver (src/spectate.ts),
// and a local race watched live ('watch' run-on) gives exactly the result the synchronous run-on gave; Skip to results finishes
// it through that same run-on, at any moment, with the same classification and debrief; held input after the finish changes nothing.
import { describe, it, expect } from 'vitest';
import { Race, CLOSE_DELAY, type Controls, type RosterEntry } from '../src/race';
import { Spectator, shouldSpectate } from '../src/spectate';

const roster = (): RosterEntry[] => [
  { id: 'me', control: 'human', slot: 0 },
  { id: 'ai1', control: 'ai', slot: 1 }, { id: 'ai2', control: 'ai', slot: 2 }, { id: 'ai3', control: 'ai', slot: 3 },
];
const mk = (runOn: 'sync' | 'watch', seed = 11): Race => new Race({ seed, track: 'circuit-1', roster: roster(), length: 'sprint', runOn });

/**
 * Drive the human with a crude scripted throttle until the race closes (or `stop`). `after`: the input held once the human is
 * terminal (a key still down at the flag, say). Returns the step count.
 */
function run(r: Race, after: Controls = {}, stop?: (r: Race) => boolean, maxSteps = 200_000): number {
  let n = 0;
  for (; n < maxSteps && r.phase !== 'done'; n++) {
    if (stop?.(r)) break;
    const c = r.car('me')!;
    const up = c.status === 'running' && (c.v < 7.5 || n % 3 !== 0);
    r.update(1 / 60, c.status === 'running' ? { me: { up, down: false } } : after);
  }
  return n;
}
/** Put the human one stretch from the flag on the last lap, so it finishes ahead of most of the field. */
function nearFlag(r: Race): void {
  for (let i = 0; i < 400; i++) r.update(1 / 60, { me: { up: true, down: false } });
  const c = r.car('me')!;
  c.u = r.T.FINISH_S + r.targetLaps * r.T.L - 4; c.crossed = r.targetLaps; c.lapsDone = r.targetLaps - 1; c.sectors = 7; c.mode = 'race';
}
const result = (r: Race): string => JSON.stringify({ f: r.final, d: r.debrief('me'), ai: r.cars.map((c) => [c.id, c.lapsDone, c.bestLap, c.pitStops]) });

describe('local watched run-on (#135)', () => {
  it('watched live, the field races on after the player finishes and closes with the same result as the synchronous run-on', () => {
    const sync = mk('sync'), watch = mk('watch');
    for (const r of [sync, watch]) nearFlag(r);
    run(sync); run(watch);
    expect(sync.phase).toBe('done');
    expect(watch.phase).toBe('done');
    expect(watch.car('me')!.status).toBe('finished');
    expect(result(watch)).toBe(result(sync));
    expect(watch.final!.every((x) => x.status === 'finished' || x.status === 'dq' || x.status === 'dnf')).toBe(true);
  });

  it('the watched race stays open while cars run: it is not closed CLOSE_DELAY after the player, as the synchronous one is', () => {
    const watch = mk('watch');
    nearFlag(watch);
    run(watch, {}, (r) => r.humansDoneT >= 0 && r.t - r.humansDoneT > CLOSE_DELAY + 1);
    expect(watch.phase).toBe('racing');
    expect(watch.cars.some((c) => c.status === 'running')).toBe(true);
    expect(shouldSpectate(watch, watch.car('me'), true)).toBe(true);
  });

  it.each([0.5, CLOSE_DELAY + 0.5, 20])('Skip to results %f s after the flag gives the same valid classification and debrief', (afterS) => {
    const sync = mk('sync'), watch = mk('watch');
    for (const r of [sync, watch]) nearFlag(r);
    run(sync);
    run(watch, {}, (r) => r.humansDoneT >= 0 && r.t - r.humansDoneT >= afterS);
    expect(watch.phase).toBe('racing');
    expect(watch.skipRunOut()).toBe(true);
    expect(watch.phase).toBe('done');
    expect(watch.final).not.toBe(null);
    expect(result(watch)).toBe(result(sync));
    expect(watch.skipRunOut()).toBe(false);   // once only
  });

  it('Skip is refused while the player is still racing', () => {
    const r = mk('watch');
    for (let i = 0; i < 300; i++) r.update(1 / 60, { me: { up: true, down: false } });
    expect(r.skipRunOut()).toBe(false);
    expect(r.phase).toBe('racing');
  });

  it('a key (Throttle or Brake) still held after the flag changes nothing: the finished car is not the driver\'s any more', () => {
    const a = mk('watch'), b = mk('watch'), c = mk('watch');
    for (const r of [a, b, c]) nearFlag(r);
    run(a, {}); run(b, { me: { up: true, down: false } }); run(c, { me: { up: false, down: true } });
    expect(result(b)).toBe(result(a));
    expect(result(c)).toBe(result(a));
  });

  it('bounded like the synchronous run-on: a car that can never finish is classified runout after the preset\'s runOutS', () => {
    const r = mk('watch');
    nearFlag(r);
    // stop one AI car for good (out of fuel, parked on the racing line is not possible; drained fuel is)
    const stuck = r.car('ai3')!;
    run(r, {}, (x) => { stuck.fuel = 0; return x.humansDoneT >= 0; });
    run(r, {}, () => { stuck.fuel = 0; stuck.v = 0; return false; }, 120 * 60 * 10);
    expect(r.phase).toBe('done');
    expect(r.final!.find((x) => x.id === 'ai3')).toMatchObject({ status: 'dnf', dnfReason: 'runout' });
    expect(r.t - r.humansDoneT).toBeLessThanOrEqual(CLOSE_DELAY + r.length.runOutS + 1);
  });
});

describe('the spectator view target (#135)', () => {
  /** a race where the player is done and the AI field is still out */
  function watched(): Race {
    const r = mk('watch');
    nearFlag(r);
    run(r, {}, (x) => x.humansDoneT >= 0);
    return r;
  }

  it('enters following the leading car still running; never the player, whose ID is unchanged', () => {
    const r = watched();
    const s = new Spectator();
    s.enter(r);
    const lead = r.order().find((c) => c.status === 'running')!;
    expect(s.active).toBe(true);
    expect(s.target).toBe(lead.id);
    expect(s.target).not.toBe('me');
    expect(s.focus(r)).toBe(lead);
  });

  it('Previous / Next walk the running cars in race order and wrap; Whole track keeps the target', () => {
    const r = watched();
    const s = new Spectator();
    s.enter(r);
    const run = r.order().filter((c) => c.status === 'running').map((c) => c.id);
    const seen = [s.target];
    for (let k = 0; k < run.length; k++) { s.step(r, 1); seen.push(s.target); }
    expect(seen.slice(0, run.length)).toEqual(run);
    expect(seen[run.length]).toBe(run[0]);
    s.step(r, -1);
    expect(s.target).toBe(run[run.length - 1]);
    s.whole = true;
    expect(s.focus(r)).toBe(null);
    expect(s.target).toBe(run[run.length - 1]);
    s.step(r, 1);
    expect(s.whole).toBe(false);
  });

  it('picks only a running car; when the target finishes it moves to the car behind, and to nobody once none is left', () => {
    const r = watched();
    const s = new Spectator();
    s.enter(r);
    expect(s.pick(r, 'me')).toBe(false);
    expect(s.pick(r, 'nobody')).toBe(false);
    const order = r.order().filter((c) => c.status === 'running');
    const first = order[0];
    expect(s.pick(r, first.id)).toBe(true);
    // the target takes the flag: the next car behind it in race order is followed
    r.finishCar(first, r.raceTime, null);
    s.ensure(r);
    expect(s.target).toBe(order[1]?.id ?? null);
    // ...and a retirement the same way; with nobody left, no target (the whole track, waiting for results)
    for (const c of r.cars) if (c.status === 'running') r.retire(c.id);
    s.ensure(r);
    expect(s.target).toBe(null);
    expect(s.focus(r)).toBe(null);
    expect(shouldSpectate(r, r.car('me'), true)).toBe(false);   // local: nobody left to watch
    expect(shouldSpectate(r, r.car('me'), false)).toBe(true);   // online: spectate until the server's result
  });

  it('is never offered while the player is racing, in practice, or once the race has closed; reset clears everything', () => {
    const r = mk('watch');
    expect(shouldSpectate(r, r.car('me'), true)).toBe(false);
    const p = new Race({ practice: true, track: 'circuit-1' });
    expect(shouldSpectate(p, p.cars[0], false)).toBe(false);
    const done = mk('sync');
    nearFlag(done); run(done);
    expect(shouldSpectate(done, done.car('me'), false)).toBe(false);
    const s = new Spectator();
    s.enter(watched());
    s.whole = true;
    s.reset();
    expect([s.active, s.target, s.whole]).toEqual([false, null, false]);
  });
});
