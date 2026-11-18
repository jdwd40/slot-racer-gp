// Race-length presets (#132): Sprint 5, Standard 13, Endurance 26. The lap target is each Race's own, from the one preset
// table; every rule that reads it (the flag, final-lap messages, deferrals, deadlines and DQ, the AI's fuel plan, PB laps)
// is checked at every length, and seeded full races run on every circuit at every length. docs/race-length.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Race, Car, PEN, RUN_OUT_MAX, type RaceEvent, type RosterEntry, type Controls } from '../src/race';
import { DEFAULT_LENGTH, LENGTH_IDS, LENGTH_SET, RACE_LENGTHS, isRaceLengthId, knowsLength, lengthForLaps, lengthOr, raceLength, type RaceLengthId } from '../src/raceLength';
import { mirrorRace } from '../src/net/mirror';
import { DT, NONE, UP, crossLine, fresh, msgs, place, seedRandom, stepEvents, me } from './helpers';

beforeEach(() => seedRandom(11));
afterEach(() => vi.restoreAllMocks());

const OUTSIDE = -1;
const lapsOf = (ev: RaceEvent[]) => ev.filter((e): e is Extract<RaceEvent, { type: 'lap' }> => e.type === 'lap');

describe('the preset table', () => {
  it('has exactly Sprint 5, Standard 13 (the default) and Endurance 26, frozen', () => {
    expect(RACE_LENGTHS.map((l) => [l.id, l.laps])).toEqual([['sprint', 5], ['standard', 13], ['endurance', 26]]);
    expect(DEFAULT_LENGTH).toBe('standard');
    expect(Object.isFrozen(RACE_LENGTHS) && RACE_LENGTHS.every((l) => Object.isFrozen(l))).toBe(true);
    expect(() => { (RACE_LENGTHS[1] as { laps: number }).laps = 40; }).toThrow();
    expect(raceLength().laps).toBe(13);
  });

  it("Standard keeps every limit races had before presets; Endurance's are twice Standard's; Sprint never cuts sooner", () => {
    const std = raceLength('standard');
    expect([std.finishWindowS, std.soloFinishWindowS, std.timeLimitS, std.runOutS]).toEqual([90, 120, 1200, RUN_OUT_MAX]);
    const end = raceLength('endurance');
    expect([end.finishWindowS, end.soloFinishWindowS, end.timeLimitS, end.runOutS]).toEqual([180, 240, 2400, 480]);
    const spr = raceLength('sprint');
    expect([spr.finishWindowS, spr.soloFinishWindowS, spr.timeLimitS, spr.runOutS]).toEqual([90, 120, 1200, RUN_OUT_MAX]);
  });

  it('only allowlisted ids are accepted; anything stored or received that is missing or unknown reads as Standard', () => {
    for (const id of LENGTH_IDS) expect(isRaceLengthId(id)).toBe(true);
    for (const x of ['', 'Sprint', 'marathon', 13, null, undefined, {}, '__proto__']) {
      expect(isRaceLengthId(x)).toBe(false);
      expect(lengthOr(x)).toBe('standard');
    }
    expect(() => raceLength('marathon' as RaceLengthId)).toThrow(/unknown race length/);
    expect(() => new Race({ length: 'marathon' as RaceLengthId })).toThrow(/unknown race length/);
    // there is no lap-count option: an arbitrary count smuggled in is ignored and the race is Standard
    expect(new Race({ laps: 40 } as unknown as { length: RaceLengthId }).targetLaps).toBe(13);
    expect(lengthForLaps(26)?.id).toBe('endurance');
    expect(lengthForLaps(14)).toBe(null);
  });

  it('a client that knows no preset list (older than presets) can show Standard only', () => {
    expect(LENGTH_SET).toBe(1);
    expect(knowsLength(0, 'standard')).toBe(true);
    expect(knowsLength(0, 'sprint')).toBe(false);
    expect(knowsLength(0, 'endurance')).toBe(false);
    for (const id of LENGTH_IDS) expect(knowsLength(LENGTH_SET, id)).toBe(true);
  });

  it('races of different lengths built side by side keep their own targets (no process-wide count)', () => {
    const races = LENGTH_IDS.map((length) => new Race({ length, seed: 1 }));
    expect(races.map((r) => r.targetLaps)).toEqual([5, 13, 26]);
    expect(races.map((r) => r.snapshot().laps)).toEqual([5, 13, 26]);
    expect(new Race({ seed: 1 }).targetLaps).toBe(13);
    // fixed at runtime as well as in the types: neither the preset nor the target can be changed once the race exists
    expect(races[0].length).toBe(raceLength('sprint'));
    expect(() => { (races[0] as { length: unknown }).length = raceLength('endurance'); }).toThrow(TypeError);
    expect(() => { (races[0] as { targetLaps: number }).targetLaps = 26; }).toThrow(TypeError);
    expect(races[0].targetLaps).toBe(5);
  });

  it("the online mirror counts to the server's target, read from the snapshot (an older server's 13 is Standard)", () => {
    for (const length of LENGTH_IDS) {
      const snap = new Race({ length, seed: 2 }).snapshot();
      expect(mirrorRace(snap).targetLaps).toBe(raceLength(length).laps);
    }
    const old = { ...new Race({ seed: 2 }).snapshot(), laps: 13 };
    expect(mirrorRace(old).length.id).toBe('standard');
  });
});

describe.each(LENGTH_IDS)('%s: every rule counts to its own flag', (id) => {
  const n = raceLength(id).laps;
  /** The player alone on lap `lap` of a `id` race, on the road well before that lap's pit entrance. */
  function solo(lap: number): { r: Race; P: Car; rival: Car } {
    const r = fresh('circuit-1', { length: id });
    const rival = r.cars[1];
    r.cars.splice(1);
    const P = me(r);
    P.human = true;
    P.crossed = lap; P.lapsDone = lap - 1; P.sectors = 0; P.revMark = null;
    place(P, T.FINISH_S + (lap - 1) * T.L + 60, OUTSIDE, 10);
    return { r, P, rival };
  }
  /** On the road just short of lap `lap`'s pit entrance. */
  function nearEntrance(P: Car, lap: number): void {
    P.crossed = lap; P.lapsDone = lap - 1;
    place(P, lap * T.L + T.PIT_IN0 - 30, OUTSIDE, 10);
  }

  it(`the standing start is not a lap; "Final lap!" comes at the line that starts lap ${n}, the flag at the one that ends it`, () => {
    const r = new Race({ length: id, seed: 4, track: 'circuit-1', roster: [{ id: 'a', control: 'ai', slot: 0 }] });
    const ev: RaceEvent[] = [];
    while (r.car('a')!.crossed < 1) { r.update(DT, {}); ev.push(...r.events); r.events.length = 0; }
    expect(r.car('a')!.lapsDone).toBe(0);
    expect(lapsOf(ev)).toHaveLength(0);

    const { r: s, P } = solo(n - 2 > 0 ? n - 2 : 1);
    if (n > 2) expect(msgs(crossLine(s, P, n - 2))).not.toContain('msg.finalLap');
    const fin = crossLine(s, P, n - 1);
    expect(msgs(fin)).toContain('msg.finalLap');
    expect([P.finished, P.lapsDone]).toEqual([false, n - 1]);
    const flag = crossLine(s, P, n);
    expect(msgs(flag)).not.toContain('msg.finalLap');
    expect(flag.some((e) => e.type === 'finish' && e.car === P)).toBe(true);
    expect([P.status, P.lapsDone]).toEqual(['finished', n]);
  });

  it('practice never ends, whatever the preset', () => {
    const r = fresh('circuit-1', { practice: true, length: id });
    r.cars.splice(1);
    const P = me(r); P.human = true;
    for (const lap of [n - 1, n, n + 1, 2 * n + 3]) crossLine(r, P, lap);
    expect([P.finished, P.status, P.lapsDone]).toEqual([false, 'running', 2 * n + 3]);
    expect(r.phase).toBe('racing');
  });

  it(`deferring is legal up to lap ${n - 1} and refused on the final lap; the deferred stop is due on lap ${n}`, () => {
    // a stop-and-go awarded on lap n-1, before its entrance: one deferral moves it to the final lap
    const a = solo(n - 1);
    nearEntrance(a.P, n - 1);
    a.P.offences = 2; a.r.offence(a.P, a.rival, 'rear');
    expect(a.P.sgDue).toBe(n - 1);
    expect(a.r.deferBlock(a.P)).toBe(null);
    a.r.requestDefer(a.P.id);
    expect([a.P.sgDue, a.P.sgDeferred]).toEqual([n, true]);
    // an optional fuel request on lap n-1 becomes a fuel stop committed for lap n
    const b = solo(n - 1);
    nearEntrance(b.P, n - 1);
    b.P.fuel = 0.4; b.r.requestPit(b.P.id);
    expect(b.r.deferBlock(b.P)).toBe(null);
    b.r.requestDefer(b.P.id);
    expect(b.P.fuelDue).toBe(n);
    // on the final lap there is no lap left to defer to
    const c = solo(n);
    nearEntrance(c.P, n);
    c.P.offences = 2; c.r.offence(c.P, c.rival, 'rear');
    expect(c.P.sgDue).toBe(n);
    expect(c.r.deferBlock(c.P)).toBe('final');
    c.r.requestDefer(c.P.id);
    expect([c.P.sgDue, c.P.sgDeferred]).toEqual([n, false]);
    expect(c.r.dueState(c.P, n)).toBe('due');
    expect(c.r.dueState(c.P, n + 1)).toBe('late');
    expect(c.r.lastChance(c.P)).toBe(true);
  });

  it(`a stop-and-go missed on lap ${n - 1} is put back to the final lap automatically, with the final-lap warning`, () => {
    const { r, P } = solo(n - 1);
    P.sgOwed = PEN.stopSeconds; P.sgDue = n - 1; P.sgDeferred = false; P.pitReq = true;
    const ev = crossLine(r, P, n - 1);
    expect([P.sgDue, P.sgDeferred, P.svcBreach]).toEqual([n, true, null]);
    expect(msgs(ev)).toContain('msg.sgLastLapFinal');
    // an earlier miss (with laps left after the next) gets the ordinary "last lap to serve" message instead
    if (n > 3) {
      const e = solo(2);
      e.P.sgOwed = PEN.stopSeconds; e.P.sgDue = 2; e.P.pitReq = true;
      expect(msgs(crossLine(e.r, e.P, 2))).toContain('msg.sgLastLap');
      expect(e.P.sgDue).toBe(3);
    }
  });

  it('an obligation still unserved at the flag disqualifies: stop-and-go, committed fuel stop, latched breach', () => {
    const sg = solo(n);
    sg.P.sgOwed = PEN.stopSeconds; sg.P.sgDue = n; sg.P.sgDeferred = true; sg.P.pitReq = true;
    crossLine(sg.r, sg.P, n);
    expect([sg.P.status, sg.P.dqReason, sg.P.svcBreach]).toEqual(['dq', 'stopGo', 'stopGo']);
    const fuel = solo(n);
    fuel.P.fuelDue = n;
    crossLine(fuel.r, fuel.P, n);
    expect([fuel.P.status, fuel.P.dqReason, fuel.P.svcBreach]).toEqual(['dq', 'fuel', 'fuel']);
    // a breach latched on an earlier lap (a missed deadline) disqualifies at the flag even with the stop served since
    const breach = solo(n);
    breach.P.svcBreach = 'fuel';
    crossLine(breach.r, breach.P, n);
    expect([breach.P.status, breach.P.dqReason]).toEqual(['dq', 'deadline']);
    // owed but not yet past its deadline when the flag falls (awarded too late to serve): DQ for the stop itself
    const late = solo(n);
    late.P.sgOwed = PEN.stopSeconds; late.P.sgDue = n + 1; late.P.pitReq = true;
    crossLine(late.r, late.P, n);
    expect([late.P.status, late.P.dqReason]).toEqual(['dq', 'stopGo']);
    // nothing owed: classified
    const ok = solo(n);
    crossLine(ok.r, ok.P, n);
    expect(ok.P.status).toBe('finished');
  });

  it('a stop-and-go awarded after the last entrance it could be served at says so at once', () => {
    const { r, P, rival } = solo(n);
    place(P, n * T.L + T.PIT_IN0 + 5, OUTSIDE, 10);   // past the final lap's entrance
    P.offences = 2; r.offence(P, rival, 'rear');
    expect(P.sgDue).toBe(n + 1);
    expect(msgs(r.events)).toContain('msg.sgLate');
  });

  it(`the final lap (lap ${n}) is a valid lap event in the step that finishes, so it can be a personal best`, () => {
    const { r, P } = solo(n);
    P.lapStartT = r.raceTime - 8; P.sectors = 7; P.lapValid = true;
    place(P, T.FINISH_S + n * T.L - 0.3, 1, 10);
    let lap: Extract<RaceEvent, { type: 'lap' }> | undefined;
    for (let i = 0; i < 10 && !lap; i++) {
      const ev = stepEvents(r, 1, UP);
      lap = lapsOf(ev)[0];
      if (lap) expect(ev.some((e) => e.type === 'finish' && e.car === P)).toBe(true);
    }
    expect(lap).toMatchObject({ lapsDone: n, valid: true, best: true });
    expect(P.bestLap).toBeCloseTo(lap!.time, 9);
    expect(lapsOf(stepEvents(r, 120, UP))).toHaveLength(0);
  });

  it("the AI plans its fuel to this race's flag", () => {
    const r = new Race({ length: id, seed: 1, track: 'circuit-1' });
    const c = r.cars[1];
    const std = new Race({ seed: 1, track: 'circuit-1' });
    const s = r.T.FINISH_S + 1;
    expect(r.fuelToFinish(c, s) / std.fuelToFinish(std.cars[1], s)).toBeCloseTo(n / 13, 2);
  });
});

/** Every car's lowest fuel reading while it was still racing, and every DNF/DQ reason, from a seeded race run to its end. */
function runToEnd(r: Race, maxSec: number, drive?: (r: Race, step: number) => Controls) {
  let low = 1, step = 0, tows = 0;
  while (r.phase !== 'done' && step * DT < maxSec) {
    r.update(DT, drive ? drive(r, step) : {});
    for (const e of r.events) if (e.type === 'tow') tows++;
    r.events.length = 0;
    for (const c of r.cars) if (c.status === 'running' && !c.finished) low = Math.min(low, c.fuel);
    step++;
  }
  return { low, tows };
}
/** A plain scripted human: the player profile at 92%, a fuel stop when low, fresh Throttle presses to leave the bay. */
function scripted(r: Race, step: number): Controls {
  const out: Record<string, { up: boolean; down: boolean }> = {};
  for (const c of r.cars) if (c.human) {
    const prof = r.profiles[c.laneSide > 0 ? '1' : '-1'];
    const want = prof[Math.floor(((r.T.wrapS(c.u) + 6) % r.T.L) / r.T.PROFILE_STEP) % prof.length] * 0.92;
    out[c.id] = c.mode === 'race' ? { up: c.v < want, down: c.v > want + 2 } : { up: step % 40 < 20, down: false };
    if (c.fuel < 0.25 && !c.pitReq && c.mode === 'race' && step % 30 === 0) r.requestPit(c.id);
  }
  return out;
}

describe('seeded full races: every circuit at every length', () => {
  const ai: RosterEntry[] = [0, 1, 2, 3].map((slot) => ({ id: `ai${slot}`, control: 'ai' as const, slot }));
  // fewest fuel stops a full tank (about 7.4 laps of nominal burn, less at race pace) allows: none for Sprint
  const minStops: Record<RaceLengthId, number> = { sprint: 0, standard: 1, endurance: 3 };
  for (const length of LENGTH_IDS) {
    it.each(T.TRACKS.map((d) => d.id))(`${length} on %s: the all-AI field finishes every lap with fuel to spare, inside every limit`, (track) => {
      const L = raceLength(length);
      const r = new Race({ track, length, seed: 132, roster: ai });
      const { low, tows } = runToEnd(r, L.timeLimitS);
      expect(r.phase).toBe('done');
      expect(r.final!.map((s) => s.status)).toEqual(['finished', 'finished', 'finished', 'finished']);
      for (const s of r.final!) {
        expect(s.laps).toBe(L.laps);
        expect(s.pitStops).toBeGreaterThanOrEqual(minStops[length]);
      }
      // the AI fuel plan reaches the flag: no car ran dry or was towed, and Sprint needs no stop at all
      expect(low).toBeGreaterThan(0);
      expect(tows).toBe(0);
      if (length === 'sprint') expect(r.final!.every((s) => s.pitStops === 0)).toBe(true);
      const times = r.final!.map((s) => s.time!);
      // the whole field is classified well inside the multiplayer finish window and the race time limit
      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(L.finishWindowS / 2);
      expect(Math.max(...times)).toBeLessThan(L.timeLimitS / 2);
    });
  }

  it.each(LENGTH_IDS)('%s with a human (local race): the human takes the flag and the run-on classifies every AI car for real', (length) => {
    const L = raceLength(length);
    const roster: RosterEntry[] = [{ id: 'me', control: 'human', slot: 0 }, ...[1, 2, 3].map((slot) => ({ id: `ai${slot}`, control: 'ai' as const, slot }))];
    const r = new Race({ track: 'circuit-2', length, seed: 7, roster });
    runToEnd(r, 3 * L.timeLimitS, scripted);
    expect(r.phase).toBe('done');
    // the human reaches the flag (this plain script does not serve every stop-and-go it collects, so it may be a DQ there);
    // every AI car gets a real classification from the run-on, none an estimate or a run-out DNF
    const human = r.final!.find((s) => s.id === 'me')!;
    expect([human.laps, human.status === 'finished' || human.status === 'dq']).toEqual([L.laps, true]);
    expect(r.final!.filter((s) => s.id !== 'me').every((s) => s.status === 'finished' && s.laps === L.laps)).toBe(true);
  });

  it('two humans at Endurance (the multiplayer limits): both finish inside the doubled window, which Standard\'s 90 s would not allow', () => {
    const L = raceLength('endurance');
    const roster: RosterEntry[] = [{ id: 'h0', control: 'human', slot: 0 }, { id: 'h1', control: 'human', slot: 1 }, { id: 'ai2', control: 'ai', slot: 2 }, { id: 'ai3', control: 'ai', slot: 3 }];
    const r = new Race({ track: 'circuit-4', length: 'endurance', seed: 1, roster, runOn: 'live' });
    expect([r.finishWindow, r.timeLimit]).toEqual([L.finishWindowS, L.timeLimitS]);
    runToEnd(r, L.timeLimitS + 10, scripted);
    expect(r.phase).toBe('done');
    expect(r.final!.every((s) => s.status === 'finished' && s.laps === 26)).toBe(true);
    const times = r.final!.map((s) => s.time!);
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeGreaterThan(90);
    expect(spread).toBeLessThan(L.finishWindowS);
  });
});

describe('Standard is the race it always was', () => {
  it('a default race and an explicit Standard race are the same race, step for step', () => {
    const run = (o: { length?: RaceLengthId }) => {
      const r = new Race({ track: 'circuit-3', seed: 99, ...o });
      me(r).human = false;
      const snaps: string[] = [];
      for (let i = 0; i < 6000; i++) { r.update(DT, { solo: NONE }); r.events.length = 0; if (i % 500 === 0) snaps.push(JSON.stringify(r.snapshot())); }
      return snaps;
    };
    expect(run({ length: 'standard' })).toEqual(run({}));
  });
});
