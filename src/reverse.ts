// Player reverse gear (docs/reverse.md), moved out of the Race class (#141): the tuning, why reverse cannot engage, the Brake
// hold that engages it, and one step of backward travel. Race keeps thin methods of the names tests and the client call
// (reverseBlock, clearReverse), and calls in here from stepCar() as before.
import * as T from './track';
import type { Car, Input, Race } from './race';
import * as squeeze from './squeeze';

/**
 * Player reverse gear, for backing into an overshot pit bay, penalty box or pit entrance (see docs/reverse.md).
 * Brake held at a standstill engages it after `engage` seconds of simulation time; braking while still rolling never counts.
 */
export const REV = {
  engage: 0.6,         // seconds of continued Brake while stationary before reverse engages
  speed: 3,            // reverse speed cap (m/s, by magnitude)
  acc: 5,              // reverse acceleration (m/s²)
  still: 0.02,         // speed magnitude that counts as stationary
};

/** the reverse cap by magnitude, never above the pit-lane limit */
export const REV_CAP = Math.min(REV.speed, T.PIT_SPEED);

/** a pit-lane car backs up no further than where the pit lane has fully left the road */
export const REV_PIT_MIN = T.PIT_IN1;

/** Why reverse cannot engage now, or null. Checked by speed magnitude and position, never by direction alone. */
export function reverseBlock(r: Race, c: Car): 'phase' | 'mode' | 'change' | 'fuel' | 'service' | 'assist' | null {
  if (r.phase !== 'racing' || c.finished) return 'phase';
  if (c.mode !== 'race' && c.mode !== 'pitlane') return 'mode';
  // held by the pit queue or the exit: automatic control, so Brake held now never backs away when the hold ends
  if (c.pitHold || c.sgCtl) return 'assist';
  if (c.change) return 'change';
  if (c.fuel <= 0) return 'fuel';
  // standing (or arriving) in the penalty box with a stop owed is service: Brake must keep the car still for all of it
  if (c.mode === 'pitlane' && c.sgOwed > 0 && Math.abs(r.T.gapS(r.s(c), r.T.PEN_S)) < r.T.PEN_HALF) return 'service';
  return null;
}

/**
 * Reverse engagement from the Brake hold, in simulation time. Releasing Brake ends it; Throttle cancels it and restarts the hold;
 * any reason it cannot run latches it off until Brake is released and pressed again, so finishing a service with Brake held never backs away.
 */
export function reverseControl(r: Race, c: Car, dt: number, input: Input): void {
  if (!input.down || c.finished) { c.revOn = false; c.revHoldT = 0; c.revLatch = false; return; }
  const block = r.reverseBlock(c);
  const still = Math.abs(c.v) < REV.still;
  if (block === 'change') {
    // a committed lane change is never reversed: an attempt is refused for this press, with a word why
    c.revOn = false;
    if (c.revLatch || !still) { c.revHoldT = 0; return; }
    c.revHoldT += dt;
    if (c.revHoldT >= REV.engage) { c.revHoldT = 0; c.revLatch = true; r.pmsg(c, 'msg.revChange', 'warn'); }
    return;
  }
  if (block) { c.revOn = false; c.revHoldT = 0; c.revLatch = true; return; }
  if (input.up || c.revLatch) { c.revOn = false; c.revHoldT = 0; return; }
  if (c.revOn) return;
  if (!still) { c.revHoldT = 0; return; }
  c.revHoldT += dt;
  if (c.revHoldT >= REV.engage) { c.revOn = true; c.revHoldT = 0; }
}

/** Forget the Brake hold and reverse gear, e.g. on pause: a resumed race never restores a reverse command. */
export function clearReverse(r: Race): void { for (const c of r.cars) { c.revOn = false; c.revHoldT = 0; c.revLatch = false; } }

/** One step of backward travel: a pit-lane car stops at the upstream end of the pit path. Backing up leaves the squeeze queue and voids the lap. */
export function reverseTravel(r: Race, c: Car, s0: number, ds: number): number {
  if (c.mode === 'pitlane') {
    const room = Math.max(0, r.T.gapS(REV_PIT_MIN, s0));
    if (-ds >= room) { ds = -room; c.v = 0; }
  }
  if (ds < 0) {
    c.lapValid = false;
    if (c.revMark === null) c.revMark = c.u;
    squeeze.leaveSqueeze(r, c);
  }
  return ds;
}
