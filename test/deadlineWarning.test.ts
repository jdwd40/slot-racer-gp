// Advance warning before a missed-service-deadline DQ (#65). Each path to the breach is driven with a human car under
// continuous simulation, and the player's messages and events are recorded in order until the flag. The rule checked
// everywhere: a warning that names the consequence reaches the player before the last pit entrance at which the stop can
// still be served, and the HUD's last-chance state (`Race.lastChance`, the "PIT THIS LAP — or DQ" chip) is on from that
// warning until the stop is served or the breach is latched. Rules are untouched; see docs/penalties.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, LAPS, Race, type RaceEvent, type WireEvent } from '../src/race';
import { mirrorRace, localEvent } from '../src/net/mirror';
import { DT, all, fresh, me, place, seedRandom } from './helpers';

beforeEach(() => seedRandom(11));
afterEach(() => vi.restoreAllMocks());

/** Messages that tell the player, before the deciding entrance, that missing it means a DQ. */
const WARN = ['msg.sgLastLap', 'msg.sgLastLapFinal', 'msg.pitThisLap', 'msg.deferred'];

/** `step`: the simulation step it happened in; `lastMsg`: it is the last message of that step, so the toast the HUD shows */
interface Mark { t: number; lap: number; what: string; chip: boolean; step: number; lastMsg: boolean }
type Hook = (r: Race, P: Car) => void;

/** The player alone on circuit-1, `into` metres past the line on lap `lap`. */
function solo(lap: number): { r: Race; P: Car; rival: Car } {
  const r = fresh('circuit-1');
  const rival = r.cars[1];
  r.cars.splice(1);
  const P = me(r);
  P.human = true;
  P.crossed = lap; P.lapsDone = lap - 1; P.sectors = 0;
  place(P, T.FINISH_S + (lap - 1) * T.L + 40, -1, 12);
  return { r, P, rival };
}

/**
 * Drive to the flag: Throttle below the cornering profile, hands off while the pit controller has the car, and one fresh
 * Throttle press to leave the bay once departure is ready. Returns the player's timeline: messages, its own events, and
 * `entrance n` each time the car passes the pit entrance of lap n (in the pit lane or not).
 */
function drive(r: Race, P: Car, hook: Hook = () => {}, maxSec = 400, until?: () => boolean, wire?: WireEvent[]): Mark[] {
  const out: Mark[] = [];
  let appr = r.apprLap(P), tap = false, step = 0;
  const mark = (what: string): void => { out.push({ t: r.raceTime, lap: P.crossed, what, chip: r.lastChance(P), step, lastMsg: false }); };
  for (let t = 0; t < maxSec && !P.finished && !until?.(); t += DT) {
    hook(r, P);
    tap = !tap;
    const prof = r.profiles[P.laneSide < 0 ? '-1' : '1'];
    const up = P.mode === 'service' ? r.departBlock(P) === null && tap
      : P.sgCtl || P.sgLeave ? false : P.v < prof[Math.floor(r.s(P) / r.T.PROFILE_STEP) % prof.length] * 0.95;
    r.update(DT, all(r, { up, down: false }));
    step++;
    // hud.toast keeps one toast: the player sees the step's last message (events are handled in order, offline and online)
    const mine = r.events.filter((e) => e.type === 'msg' && e.to === P.id);
    const shown = mine[mine.length - 1];
    for (const e of r.events) {
      if (e.type === 'msg') { if (e.to === P.id) { mark(e.text); out[out.length - 1].lastMsg = e === shown; } }
      else if ('car' in e && e.car === P && (e.type === 'breach' || e.type === 'dq' || e.type === 'finish' || e.type === 'offence')) mark(e.type === 'dq' ? `dq:${e.reason}` : e.type === 'breach' ? `breach:${e.what}` : e.type);
    }
    // taken off the race as the room server does, so a test can replay them into a mirror
    const sent = r.drainEvents();
    wire?.push(...sent);
    const a = r.apprLap(P);
    if (a !== appr) { mark(`entrance ${appr}${P.mode === 'race' ? '' : ' (in)'}`); appr = a; }
  }
  return out;
}

/** Press Space once on each listed approach, 15 m before the last switch ahead of the pit entrance. */
function overrideOn(laps: number[]): Hook {
  const done = new Set<number>();
  return (r, P) => {
    const k = r.apprLap(P);
    if (!laps.includes(k) || done.has(k) || P.mode !== 'race') return;
    const sw = [...r.T.SWITCHES].sort((a, b) => r.T.ahead(a.s0, r.T.PIT_IN0) - r.T.ahead(b.s0, r.T.PIT_IN0))[0];
    if (r.T.ahead(r.s(P), sw.s0) < 15 && r.T.ahead(r.s(P), r.T.PIT_IN0) > r.T.ahead(sw.s0, r.T.PIT_IN0)) { done.add(k); r.requestLane(P.id); }
  };
}

const at = (tl: Mark[], what: string): number => tl.findIndex((m) => m.what === what);
const whats = (tl: Mark[]): string[] => tl.map((m) => m.what).filter((w) => !/^msg\.(laneGo|lowFuel|routeInside$|routeOutside|sgHandover|refuelling|departReq|pitMissed)$/.test(w));

/** The warning comes before the last usable entrance, which comes before the breach, and the chip spans exactly that time. */
function warnedBefore(tl: Mark[], warn: string, lastEntrance: number, breach: string): void {
  const w = at(tl, warn), e = at(tl, `entrance ${lastEntrance}`), b = at(tl, breach);
  expect(w, `${warn} posted`).toBeGreaterThanOrEqual(0);
  expect(w, `${warn} before entrance ${lastEntrance}`).toBeLessThan(e);
  // and it is the toast left on screen: nothing posted later in the same step (such as "Final lap!") replaces it
  expect(tl[w].lastMsg, `${warn} is the last message of its step: ${tl.filter((m) => m.step === tl[w].step).map((m) => m.what)}`).toBe(true);
  expect(e).toBeLessThan(b);
  // a full lap's warning, not a last-second one: at least ~10 s on circuit-1 before the deciding entrance
  expect(tl[e].t - tl[w].t).toBeGreaterThan(10);
  for (let i = w; i <= e; i++) expect(tl[i].chip, `chip on at ${tl[i].what}`).toBe(true);
  expect(tl[b].chip).toBe(false); // the red DEADLINE MISSED chip (or the flag) takes over
}

describe('a deferred stop-and-go', () => {
  it('automatic deferral: "last chance" at the line, a DQ-worded override, then the breach and a deadline DQ', () => {
    const { r, P, rival } = solo(9);
    P.offences = 2; r.offence(P, rival, 'rear');           // due on lap 9's entrance
    const tl = drive(r, P, overrideOn([9, 10]));
    expect(whats(tl)).toEqual([
      'offence', 'entrance 9', 'msg.sgLastLap', 'msg.routeInsideDq', 'entrance 10', 'breach:stopGo', 'msg.breachSg',
      'msg.sgAuto', 'msg.pitInPen', 'entrance 11 (in)', 'msg.penServed', 'entrance 12', 'msg.finalLap', 'entrance 13',
      'dq:deadline', 'msg.dq.deadline',
    ]);
    warnedBefore(tl, 'msg.sgLastLap', 10, 'breach:stopGo');
    expect(at(tl, 'msg.routeInsideDq')).toBeLessThan(at(tl, 'entrance 10'));
  });

  it('deferred with N: "MUST pit next lap" at once, "pit this lap" again at the line, then the breach', () => {
    const { r, P, rival } = solo(9);
    P.offences = 2; r.offence(P, rival, 'rear');
    r.requestDefer(P.id);
    const tl = drive(r, P, overrideOn([10]));
    expect(whats(tl).slice(0, 7)).toEqual(['offence', 'msg.deferred', 'entrance 9', 'msg.pitThisLap', 'msg.routeInsideDq', 'entrance 10', 'breach:stopGo']);
    warnedBefore(tl, 'msg.pitThisLap', 10, 'breach:stopGo');
    expect(P.dqReason).toBe('deadline');
  });

  it('due on the final lap with no deferral left to use: the chip and the "final lap" warning precede the DQ', () => {
    const { r, P, rival } = solo(LAPS - 1);
    P.offences = 2; r.offence(P, rival, 'rear');
    const tl = drive(r, P, overrideOn([LAPS - 1, LAPS]));
    // "Final lap!" is posted first at that crossing, so the DQ warning is the toast left on screen
    const at12 = tl.filter((m) => m.step === tl[at(tl, 'msg.sgLastLapFinal')].step).map((m) => m.what);
    expect(at12).toEqual(['msg.finalLap', 'msg.sgLastLapFinal']);
    warnedBefore(tl, 'msg.sgLastLapFinal', LAPS, 'dq:stopGo');
  });
});

describe('a committed fuel stop from an inside-lane override', () => {
  it('committed at the entrance, "pit this lap or be disqualified" at the line, then served automatically: no DQ', () => {
    const { r, P } = solo(9);
    P.fuel = 0.5; r.requestPit(P.id);
    const tl = drive(r, P, overrideOn([9]));
    expect(whats(tl).slice(0, 8)).toEqual(['msg.pitRequested', 'msg.fuelOverride', 'entrance 9', 'msg.pitThisLap', 'msg.bayAuto', 'msg.pitIn', 'entrance 10 (in)', 'msg.fuelDone']);
    const w = at(tl, 'msg.pitThisLap');
    expect(tl[w].lap).toBe(10); expect(tl[w].chip).toBe(true);
    expect(tl[at(tl, 'msg.fuelDone')].chip).toBe(false);   // served: the chip goes
    expect([P.status, P.svcBreach]).toEqual(['finished', null]);
  });

  it('committed on the second-last lap: the final-lap warning precedes the flag, and an unserved stop is a fuel DQ', () => {
    const { r, P } = solo(LAPS - 1);
    P.fuel = 0.5; r.requestPit(P.id);
    const tl = drive(r, P, overrideOn([LAPS - 1, LAPS]));
    expect(whats(tl).slice(0, 6)).toEqual(['msg.pitRequested', 'msg.fuelOverride', `entrance ${LAPS - 1}`, 'msg.finalLap', 'msg.pitThisLap', 'msg.routeInsideDq']);
    warnedBefore(tl, 'msg.pitThisLap', LAPS, 'dq:fuel');
  });

  it('a retired car is out of the race: no last chance and no message at the line that starts its due lap', () => {
    const { r, P } = solo(9);
    P.fuel = 0.5; r.requestPit(P.id);
    drive(r, P, overrideOn([9]), 60, () => P.fuelDue > 0);
    expect(P.fuelDue).toBe(10);
    r.retire(P.id);
    expect(P.status).toBe('dnf');
    // a retired car usually parks at once; if it does coast over the line, the lap count still runs (laps()), so call it
    // directly at the crossing that starts the due lap
    r.events.length = 0;
    P.u = T.FINISH_S + 9 * T.L + 1; P.hiU = P.u; P.crossed = 9; P.lapsDone = 8; P.sectors = 7;
    r.laps(P);
    expect(P.crossed).toBe(10);
    expect(r.lastChance(P)).toBe(false);
    expect(r.events.filter((e) => e.type === 'msg').map((e) => (e as { text: string }).text)).not.toContain('msg.pitThisLap');
    // retire() already sets finished, which lastChance() checks; status is checked too, so a terminal car whose finished
    // flag is not set (a hand-built or older snapshot) still reads as out of the race
    P.finished = false;
    expect(r.lastChance(P)).toBe(false);
    // control: the same crossing for a running car does post it
    const { r: r2, P: Q } = solo(10);
    Q.fuelDue = 10; Q.u = T.FINISH_S + 9 * T.L - 1; Q.hiU = Q.u; Q.crossed = 9; Q.lapsDone = 8;
    r2.laps(Q); Q.u += 2; Q.hiU = Q.u; r2.laps(Q);
    expect(r2.events.filter((e) => e.type === 'msg').map((e) => (e as { text: string }).text)).toContain('msg.pitThisLap');
  });
});

describe('repeated overrides', () => {
  it('a second override on the due lap: warned at the line and again on Space, then the breach and a deadline DQ', () => {
    const { r, P } = solo(9);
    P.fuel = 0.5; r.requestPit(P.id);
    const tl = drive(r, P, overrideOn([9, 10]));
    expect(whats(tl).slice(0, 8)).toEqual(['msg.pitRequested', 'msg.fuelOverride', 'entrance 9', 'msg.pitThisLap', 'msg.routeInsideDq', 'entrance 10', 'breach:fuel', 'msg.breachFuel']);
    warnedBefore(tl, 'msg.pitThisLap', 10, 'breach:fuel');
    expect(P.dqReason).toBe('deadline');
  });

  it('an override that is not a last chance keeps its usual message', () => {
    const { r, P } = solo(9);
    P.fuel = 0.5; r.requestPit(P.id);
    const tl = drive(r, P, overrideOn([9]), 3);
    expect(at(tl, 'msg.routeInsideDq')).toBe(-1);
    r.requestLane(P.id);
    expect(r.events.filter((e) => e.type === 'msg').map((e) => (e as { text: string }).text)).toEqual(['msg.routeInside']);
  });
});

describe('the test bot from the issue: Space every 8 s for a whole race', () => {
  /** A real 4-car race from the lights: Throttle by profile, P when fuel runs low, Space every 8 s from `off`. */
  function bot(track: string, off: number, fuelAt: number): { tl: Mark[]; P: Car } {
    seedRandom(5 + off);
    T.setTrack(track);
    const r = new Race();
    const P = me(r);
    let next = off + 8;
    const tl = drive(r, P, (r2, P2) => {
      if (r2.phase !== 'racing') return;
      if (r2.raceTime >= next) { next += 8; r2.requestLane(P2.id); }
      if (P2.fuel < fuelAt && !P2.fuelReq && P2.fuelDue <= 0 && P2.mode === 'race' && !P2.pitReq) r2.requestPit(P2.id);
    }, 600);
    return { tl, P };
  }

  // sweeping the phase of the 8 s cadence reproduces the issue's "DQ · missed service deadline" several times over
  it('every breach the bot runs into was warned on its due lap, before the entrance that decided it', () => {
    const seen: string[] = [];
    for (const track of ['circuit-1', 'circuit-2']) for (let off = 0; off < 8; off++) {
      const { tl, P } = bot(track, off, 0.3);
      const b = tl.findIndex((m) => m.what.startsWith('breach:'));
      if (P.dqReason === 'deadline') seen.push(`${track}+${off}:${tl[b].what}`);
      if (b < 0 || P.dqReason !== 'deadline') continue;
      // the breach is judged at the line ending the due lap: the entrance just before it is the last one that could serve the stop
      const due = tl[b].lap - 1;
      const e = tl.slice(0, b).map((m) => m.what.startsWith(`entrance ${due}`)).lastIndexOf(true);
      const w = tl.slice(0, e).map((m) => WARN.includes(m.what) && m.lap === due).lastIndexOf(true);
      expect(e, `${track}+${off}`).toBeGreaterThan(0);
      expect(w, `${track}+${off}: warned on lap ${due}`).toBeGreaterThanOrEqual(0);
      expect(tl[w].lastMsg, `${track}+${off}: ${tl[w].what} is the visible toast`).toBe(true);
      // (no minimum lead here: a bot that runs dry is towed over the entrance, and a tow's service never settles the stop)
      for (let i = w; i <= e; i++) expect(tl[i].chip, `${track}+${off}: chip at ${tl[i].what}`).toBe(true);
    }
    console.log(`deadline DQs reproduced: ${seen.join(', ')}`);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('online', () => {
  it('the mirror reads the same last-chance state from a snapshot, and the message is a plain wire event', () => {
    const { r, P } = solo(9);
    P.fuel = 0.5; r.requestPit(P.id);
    // the events are taken off the race as the server does (drainEvents), until the line that starts lap 10
    const wire: WireEvent[] = [];
    drive(r, P, overrideOn([9]), 60, () => P.crossed >= 10, wire);
    const ev: RaceEvent[] = [];
    const m = mirrorRace(r.snapshot());
    expect(r.lastChance(P)).toBe(true);
    expect(m.lastChance(m.car(P.id)!)).toBe(true);
    for (const w of wire) { const e = localEvent(m, w); if (e) ev.push(e); }
    expect(ev.some((e) => e.type === 'msg' && e.to === P.id && e.text === 'msg.pitThisLap')).toBe(true);
  });
});
