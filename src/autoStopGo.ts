// Automatic pit service for human drivers (docs/auto-stop-go.md, docs/auto-bay.md), moved out of the Race class (#141): the
// takeover tuning, the per-step decision whether the controller owns the pedals, the speed it drives at, and the departure
// gate in the bay. Race keeps thin methods of the names tests, the HUD and the net session call or override (sgUpdate,
// departBlock, sgTarget, sgCorner), and calls in here from the same places as before.
import * as T from './track';
import type { Car, DepartBlock, Race } from './race';
import { PIT_Q } from './pitConst';
import { SERVICE_READY } from './raceConst';
import { outOfTraffic } from './traffic';

/**
 * Automatic stop-and-go service for the player (see docs/auto-stop-go.md). From `window` metres before the pit entrance the
 * car's pedals belong to the controller: it brakes to the pit limit by the entrance, follows the shared queue, stops in the box,
 * holds still for the whole stop and drives to the pit exit. Everything is in simulation time and distance, never frames.
 */
export const AUTO = {
  window: PIT_Q.approach, // road distance before the entrance where the approach is taken over (the pit-queue approach)
  plan: 18,            // braking the entry profile plans with (m/s²) so the car reaches the pit limit at the entrance
  late: 24,            // braking an approach may need at most and still be taken over; beyond it the entrance is too late
  box: 6,              // braking the box stop plans with (m/s²)
  stopTol: 0.05,       // within this of the stop point the car is brought to rest
  entryLead: 0.5,      // the entry profile reaches the pit limit this far before the entrance
  entryTol: 0.5,       // a stop-and-go car not under automatic control is refused entry this far above the pit limit
  bayWait: T.CAR_LEN + 0.5 + 0.3, // with its own bay occupied, a car waits this far short of it: clear of the occupant's merge
  bayTol: 0.15,        // a car at rest within this of its bay centre turns in
};

/** where the car is stopped: the centre of the penalty box */
export const SG_STOP = T.PEN_S;

/**
 * Decide, before the car moves, whether automatic control owns the pedals and what to show. On the road it takes over within
 * `AUTO.window` of an entrance the car is routed into for a stop-and-go or a fuel visit and can still reach (outside lane, a
 * change to it, or a switch to it ahead), and only if braking to the pit limit by the entrance is possible. Defer, the lane
 * override and cancelling an optional stop release it. In the pit lane it keeps control from the entrance to the box and through
 * the stop, then to the car's own bay on a fuel visit (docs/auto-bay.md), through the bay service, and on to the pit exit.
 */
export function sgUpdate(r: Race, c: Car): void {
  c.sgCtl = false; c.sgPhase = null;
  if (!c.human || c.finished || c.status !== 'running' || r.phase !== 'racing') return;
  const s = r.s(c);
  if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') {
    // in the bay the pedals never move the car; only a fresh Throttle press once departure is ready asks to leave
    c.sgCtl = true;
    c.sgPhase = c.mode === 'bayIn' ? 'refuel' : c.mode === 'bayOut' ? 'leaving' : c.exitReq ? 'exit' : r.departBlock(c) ? 'refuel' : c.upPrev ? 'release' : 'ready';
    return;
  }
  if (c.mode === 'pitlane') {
    // run dry on the way out: the controller cannot drive the car on, so it hands back and its bay or the tow takes over
    if (c.sgLeave && c.fuel <= 0) { c.sgLeave = false; r.pmsg(c, 'msg.sgDry', 'bad'); }
    if (c.sgLeave) { c.sgCtl = true; c.sgPhase = 'leaving'; return; }
    // in control up to the end of the box; a car beyond it (it can only get there in reverse recovery) is driven by hand
    if (c.sgOwed > 0) {
      if (r.T.gapS(s, SG_STOP) > -r.T.PEN_HALF) { c.sgCtl = true; c.sgPhase = c.sgServing ? 'serving' : c.pitHold ? 'queued' : 'entry'; }
      return;
    }
    if (autoBay(r, c, s)) { c.sgCtl = true; c.sgPhase = c.pitHold ? 'queued' : r.bayFree(c.bayHome, c) ? 'bay' : 'bayWait'; }
    return;
  }
  c.sgLeave = false;
  const sg = c.sgOwed > 0;
  if ((!sg && !c.fuelReq && c.fuelDue <= 0) || c.mode !== 'race') { c.sgCommit = -1; return; }
  const k = r.apprLap(c);
  if (c.routeHold === k) { if (sg) c.sgPhase = 'deferred'; c.sgCommit = -1; return; }
  if (sg) c.sgPhase = 'armed';
  const dEntry = r.T.ahead(s, r.T.PIT_IN0);
  // an override armed earlier that no switch before the entrance can use any more changes nothing: drop it
  if (c.laneOverride && !r.switchBeforeEntry(c) && (c.change ? c.change.to < 0 : c.laneSide < 0)) c.laneOverride = false;
  if (!r.pitAssist(c) || c.laneOverride || dEntry >= AUTO.window || !sgPath(r, c, s, dEntry)) { c.sgCommit = -1; return; }
  if (c.sgCommit !== k) {
    // too fast for this entrance: no takeover (a stop-and-go is then not entered; a fuel visit is taken over in the pit lane)
    if (c.v * c.v > r.T.PIT_SPEED ** 2 + 2 * AUTO.late * dEntry) return;
    c.sgCommit = k; c.sgVc = Math.max(r.T.PIT_SPEED, c.v);
    r.pmsg(c, sg ? 'msg.sgAuto' : 'msg.bayAuto', 'info', { n: r.bayNo(c) });
  }
  c.sgCtl = true; c.sgPhase = c.pitHold ? 'queued' : 'entry';
}

/**
 * The player's fuel visit in the pit lane is still to reach its own bay: the controller drives it there (stop-and-go first).
 * A car already past the bay centre (only by hand) is left to the driver: reversing back and releasing captures the bay as usual.
 */
export function autoBay(r: Race, c: Car, s: number): boolean {
  return c.mode === 'pitlane' && c.pitFuel && !c.serviced && !c.sgLeave && c.sgOwed <= 0 && r.T.gapS(s, r.T.BAYS[c.bayHome]) > -AUTO.bayTol;
}

/** Why the car in its bay may not ask to leave yet, or null. A stationary minimum (so a fuel stop counts) and any tow penalty. */
export function departBlock(r: Race, c: Car): DepartBlock | null {
  if (c.penalty > 0) return 'penalty';
  if (c.serviceT <= SERVICE_READY) return 'settle';
  return null;
}

/** Where automatic control brings the car to rest next: the box centre, its own bay, or short of that bay while it is occupied. */
export function autoStopS(r: Race, c: Car): number {
  if (c.sgOwed > 0) return SG_STOP;
  const bs = r.T.BAYS[c.bayHome];
  return r.bayFree(c.bayHome, c) ? bs : bs - AUTO.bayWait;
}

/** The car can still be on the outside lane at the entrance `dEntry` ahead: it is there, changing to it, or has a switch to it in time. */
export function sgPath(r: Race, c: Car, s: number, dEntry: number): boolean {
  if (c.change) return c.change.to < 0;
  if (c.laneSide < 0) return true;
  return r.T.SWITCHES.some((sw) => { const a = r.T.ahead(s, sw.s0); return a > 0.05 && a + r.T.SWITCH_LEN < dEntry; });
}

/**
 * Speed the controller drives at now: the takeover speed on the road, braking at `AUTO.plan` to the pit limit at the entrance and
 * at `AUTO.box` to rest at the box centre or the car's own bay, and a stopping gap behind traffic ahead. The shared queue's cap still applies on top.
 */
export function sgTarget(r: Race, c: Car): number {
  const s = r.s(c);
  if (c.sgLeave) return r.T.PIT_SPEED;
  const road = c.mode === 'race';
  const dEntry = road ? r.T.ahead(s, r.T.PIT_IN0) : 0;
  const stopS = autoStopS(r, c);
  const dStop = road ? dEntry + stopS - r.T.PIT_IN0 : r.T.gapS(s, stopS);
  if (c.sgServing || (!road && dStop <= AUTO.stopTol)) return 0;
  let v = road ? Math.max(r.T.PIT_SPEED, c.sgVc) : r.T.PIT_SPEED;
  if (road) v = Math.min(v, Math.sqrt(r.T.PIT_SPEED ** 2 + 2 * AUTO.plan * Math.max(0, dEntry - AUTO.entryLead)), sgFollow(r, c, s), r.sgCorner(c, s));
  return Math.min(v, Math.sqrt(2 * AUTO.box * Math.max(0, dStop)), c.pitCap);
}

/** The player's planned cornering speed here and just ahead, on every lane the car may use: a takeover mid-corner never holds a speed the slot cannot. */
export function sgCorner(r: Race, c: Car, s: number): number {
  const n = r.profiles['-1'].length;
  const i0 = Math.floor(r.T.wrapS(s) / r.T.PROFILE_STEP) % n;
  const i1 = Math.floor(r.T.wrapS(s + c.v * c.persona.look) / r.T.PROFILE_STEP) % n;
  const sides = c.change || c.laneSide > 0 ? [-1, 1] : [-1];
  // the player profile of this car's own setup (#133): a Speed car is never held at a corner speed only Grip could carry
  return Math.min(...sides.map((k) => { const p = r.playerProfile(c, k); return Math.min(p[i0], p[i1]); }));
}

/** A stopping gap behind any car ahead on the car's lane or the outside lane it is heading for (road only). */
export function sgFollow(r: Race, c: Car, s: number): number {
  let cap = 1e9;
  const paths = [c.d, -r.T.laneHalf(s)];
  for (const o of r.cars) {
    if (o === c || (o.mode !== 'race' && o.mode !== 'pitlane' && o.mode !== 'grid') || outOfTraffic(o)) continue;
    const g = r.T.gapS(s, r.s(o));
    if (g <= 1e-6 || g > PIT_Q.look || !paths.some((d) => Math.abs(d - o.d) < r.T.CAR_W)) continue;
    const room = g - r.T.CAR_LEN - PIT_Q.gap + (o.v > 0 ? (o.v * o.v) / (2 * PIT_Q.leadBrake) : o.v * 0.5);
    cap = Math.min(cap, Math.sqrt(2 * PIT_Q.decel * Math.max(0, room)));
  }
  return cap;
}
