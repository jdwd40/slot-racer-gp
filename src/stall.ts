// Stopped-on-track recovery (#69, docs/auto-bay.md#stopped-on-track-recovery), moved out of the Race class (#141): the
// stall tuning table, the one pause rule of a running count, and the per-step episode, recovery and bay placement. Race keeps
// thin methods of the same names (stallBlock, stallTrapped, stallUpdate, stallRecover) that call in here, and calls in here
// from the same places as before, so tests, the HUD and the room server see the same API.
import type { Car, Controls, Race } from './race';
import { outOfTraffic } from './traffic';

/**
 * Stopped-on-track recovery (#69, docs/auto-bay.md#stopped-on-track-recovery). A human car stopped on the racing lane, not held
 * by the game and not trapped behind a car ahead, gets a warning; after `grace` seconds of simulation time it is moved off the
 * track to its own bay. Speeds in m/s and distances in m of slot, like every other tuning table here. The stop and resume
 * thresholds are far apart (hysteresis): a flicker of Throttle, a nudge or a push from behind never ends a stopped episode.
 */
export const STALL = {
  grace: 3,            // seconds of active simulation time stopped before the car is recovered (first step at or after it)
  stopV: 1,            // a car slower than this (by magnitude), its driver not pressing Throttle alone, has stopped: an episode starts
  goV: 3,              // ...and it ends only when the car drives on at this speed or faster under its own Throttle...
  goDist: 4,           // ...for this distance without a break (about three car lengths)
  blockGap: 6,         // a stopped car with a slow car this close ahead (clear slot) on its own path is trapped, not blocking
};

/**
 * The one pause rule of a running stopped-on-track count (#82, #119): a car backing up (reverse gear, or rolling back after it)
 * at STALL.stopV or more is making the legitimate recovery manoeuvre (docs/reverse.md), so the step adds nothing to its count.
 * Reverse gear alone is not the pause: the standstill that engages reverse still counts. Race.stallUpdate() decides with it
 * and records the result on the car (Car.stallPaused), which the HUD shows and online snapshots carry exactly; the HUD calls
 * it itself only for a snapshot from a server that predates that field (with the wire's rounded speed). Written as
 * `!(v > -stopV)` so it is the exact negation of the condition the count has always advanced under.
 */
export function stallCountPaused(v: number): boolean { return !(v > -STALL.stopV); }

/**
 * Why a car's stopped episode cannot run now, or null when the rule applies. `off`: not this car or not now (practice, the
 * AI, before the green, a terminal result, a retired car, anywhere but the racing lane). `held`: a legitimate wait the
 * simulation itself imposes, never a guess at intent: the pit queue or its approach, the pit exit, the squeeze priority,
 * automatic pit control, a marshal's re-slot, an empty tank (the out-of-fuel tow recovers that car, so never twice), or a
 * slow car close ahead on its own path. Selecting Pit, holding a pedal or asking for a lane is none of these.
 */
export function stallBlock(r: Race, c: Car): 'off' | 'held' | null {
  if (r.practice || r.phase !== 'racing' || !c.human || c.status !== 'running' || c.finished || c.retire || c.mode !== 'race') return 'off';
  // the driver's link is down (#74): the seat is held for a reconnect, and the car coasts to a stop and is then held out of
  // traffic, so it blocks nobody. Also while it is held after the driver is back, waiting to rejoin: its pedals are not
  // its own then. Held, so the count is reset: the driver who comes back gets a fresh three seconds, never the rest
  if (c.linkAway || c.away) return 'held';
  if (c.pitHold || c.exitHold || c.squeezeHold || c.yielding || c.sgCtl || c.recoverT > 0 || c.fuel <= 0) return 'held';
  return r.stallTrapped(c) ? 'held' : null;
}

/**
 * A car stands (or crawls, slower than STALL.goV) within STALL.blockGap of clear slot ahead of this one on its own travel
 * path: this car is trapped behind it, not blocking. Judged along the slot, so a car on the other lane, on another level
 * of a bridge (or out of traffic: de-slotted, towed, in a bay) never counts. A car moving off at STALL.goV or more does
 * not trap anyone, so a follower that then stays put gets a fresh episode of its own.
 */
export function stallTrapped(r: Race, c: Car): boolean {
  const s = r.s(c);
  for (const o of r.cars) {
    // a car held for an away driver (#74) is out of traffic like a towed one: others drive through it, so it traps nobody
    if (o === c || (o.mode !== 'race' && o.mode !== 'pitlane' && o.mode !== 'grid') || outOfTraffic(o) || o.v >= STALL.goV) continue;
    if (Math.abs(o.d - c.d) >= r.T.CAR_W || Math.abs(o.z - c.z) > 1) continue;
    const g = r.T.gapS(s, r.s(o));
    if (g > 0 && g - r.T.CAR_LEN < STALL.blockGap) return true;
  }
  return false;
}

/**
 * Run every human car's stopped episode for this step, once all cars have moved and touched. Every car is judged from the
 * same placement before any is recovered, so array order never decides who was blocking whom: in a queue the front car is
 * the one counting and the cars trapped behind it are held, in the same step. Due cars are then recovered in grid order.
 * Everything is simulation time: a paused race steps nothing, and frame rate or snapshot rate never changes the count.
 */
export function stallUpdate(r: Race, dt: number, inputs: Controls): void {
  const blocks = r.cars.map((c) => r.stallBlock(c));
  const due: Car[] = [];
  r.cars.forEach((c, i) => {
    c.stallPaused = false;
    // a legitimate wait (or the rule not applying) ends the episode: a trapped car that then stays put starts afresh
    if (blocks[i]) { c.stallT = 0; c.stallRun = 0; return; }
    const inp = r.inputOf(c, inputs);
    const own = inp.up && !inp.down;
    if (c.stallT <= 0) {
      // Throttle alone pressed at a standstill is driving off (anything that still holds the car is a case above), so the
      // start, a pull-away behind traffic or a re-slot never flashes a warning
      if (Math.abs(c.v) < STALL.stopV && !own) { c.stallT = dt; c.stallRun = 0; }
      return;
    }
    // only a genuine resumption ends a running episode: an unbroken run of STALL.goDist under the car's own Throttle at
    // STALL.goV or faster. A push from behind has no Throttle in it, and a flicker or a nudge never covers the distance
    c.stallRun = own && c.v >= STALL.goV ? c.stallRun + c.v * dt : 0;
    if (c.stallRun >= STALL.goDist - 1e-9) { c.stallT = 0; c.stallRun = 0; return; }
    // backing up (reverse gear, or rolling back after it) is the legitimate recovery manoeuvre (docs/reverse.md): it pauses
    // the count, never resets it. The standstill that engages reverse still counts, so a back-and-forth nudge gains nothing
    c.stallPaused = stallCountPaused(c.v);
    if (!c.stallPaused) c.stallT += dt;
    // the tolerance only absorbs float summing (360 steps of 1/120 s): the first step at or after the deadline. A car that is
    // pulling away under its own Throttle at that moment is let finish the pull-away (about 0.6 s from a standstill, the
    // run above): lifting, braking or stopping during it recovers it on that step, so a last-moment nudge buys nothing
    if (c.stallT >= STALL.grace - 1e-9 && !(own && c.v > 0)) due.push(c);
  });
  for (const c of due) r.stallRecover(c);
}

/**
 * Recover a stopped car (#69): off the racing lane at once, then into its own bay. This is not the out-of-fuel tow: there
 * is no time penalty, no lap or service bookkeeping, and no distance is gained. The car goes back to the last place it
 * passed its own bay (never forward), so it can only lose progress: `u` decreases while `crossed`, the laps, `hiU` (approach
 * numbering) and the sectors stay; the move crosses no timing line forward, and a line it is moved back over is not counted
 * again when it is driven (laps() counts only new crossings). Debts, deadlines, a latched breach and the fuel in the tank
 * are kept and the lap is void. Returns false, changing nothing, for a car no longer on the racing lane with a running
 * result: one towed, de-slotted, retired or finished this step, or already recovered, is never recovered (again).
 */
export function stallRecover(r: Race, c: Car): boolean {
  if (c.mode !== 'race' || c.status !== 'running' || c.finished || c.retire) return false;
  c.u -= r.T.ahead(r.T.BAYS[c.bayHome], r.s(c));
  if (c.change) { c.laneSide = c.change.to; c.change = null; }
  // out of traffic now: the squeeze queue, any pit reservation, routing state and contact state go; debts stay
  r.leaveSqueeze(c); r.pit.releaseAll(c, 'recover');
  r.clearPitIntent(c);
  c.laneReq = false; c.sgCommit = -1; c.sgLeave = false; c.sgCtl = false; c.sgPhase = null; c.sgServing = false;
  c.revOn = false; c.revHoldT = 0;
  c.v = 0; c.throttle = 0; c.brake = 0; c.slip = 0; c.wobble = 0; c.latRatio = 0; c.yawOff = 0; c.bumpT = 0;
  c.squeezeHold = false; c.yielding = false; c.pitHold = false; c.exitHold = false; c.pitCap = 1e9; c.pitWait = null;
  c.laneSide = -1; c.d = r.T.BAY_D; c.lapValid = false; c.towPit = false;
  c.stallT = 0; c.stallRun = 0; c.stallPaused = false;
  for (const o of r.cars) if (o !== c) r.touching[Math.min(o.idx, c.idx) * 4 + Math.max(o.idx, c.idx)] = false;
  r.emit({ type: 'recover', car: c });
  r.pmsg(c, 'msg.stallRecovered', 'bad');
  // its own bay is normally free (no other car ever uses it); if not, it waits out of traffic and invisible, never on the slot
  if (r.bayFree(c.bayHome, c)) stallPlace(r, c);
  else { c.mode = 'tow'; c.stallHold = true; c.towT = 1; }
  r.pose(c);
  return true;
}

/** Put a recovered car at rest in its own bay, as if it had just turned in: the usual service and fresh-Throttle departure follow. */
export function stallPlace(r: Race, c: Car): void {
  r.holdBay(c, c.bayHome);
  c.mode = 'service'; c.bay = c.bayHome; c.stallHold = false; c.serviceT = 0; c.fuelAtBay = c.fuel; c.off = null;
  c.d = r.T.BAY_D; c.v = 0; c.yawOff = 0; c.towT = 0;
  // recovery, not a pit visit: no fuel is added (stallSvc), it serves no committed fuel stop (towSvc), runs no penalty and is
  // not counted as a stop. The bay is only a safe place to rejoin from: fuel needs a real visit through the entrance.
  // Throttle counts as held until the bay sees it released, so a pedal held through the recovery never leaves
  c.towSvc = true; c.stallSvc = true; c.penalty = 0; c.exitReq = false; c.upPrev = true;
}

/** A recovered car whose own bay is taken waits out of traffic until it is free, then is placed in it (#69). */
export function stepStallHold(r: Race, c: Car, dt: number): void {
  c.v = 0; c.towT += dt;
  if (r.bayFree(c.bayHome, c)) stallPlace(r, c);
}
