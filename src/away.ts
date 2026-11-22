// The away hold (#74, #76, #77), moved out of the Race class (#141): a car whose driver's link is down is held out of traffic
// once it stops, and rejoins when nothing is inside it or closing on it. Race calls awayUpdate() from step(), after every car
// has moved and before collide(), as before.
import type { Car, Race } from './race';
import { BRAKE, PEN } from './raceConst';
import { STALL } from './stall';
import * as squeeze from './squeeze';

/**
 * When a car held for an away driver (#74) may rejoin traffic, counted from the moment the driver is back (`awayWaitT`):
 * - never while a car is inside it (less than CAR_LEN of slot apart, in the same slot). That is never capped: the car inside
 *   is in traffic and drives on, or its own stopped-on-track count recovers it.
 * - for the first `maxWait` s, not while a car closing from behind (on its lane, or changing lanes into it) could not stop
 *   short of it with time to react. With `rel` the closing car's speed above the held car's and `gap` the clear slot between
 *   the closing car's nose and the held car's tail (centre gap - CAR_LEN), it needs
 *       gap >= rel * react + rel² / (2 * BRAKE) + margin
 *   (reaction at `react` seconds, then full braking at the race's own BRAKE deceleration, 30 m/s², with `margin` m to spare).
 *   At 25 m/s that is about 12.5 + 10.4 + 1 = 24 m.
 * - from `maxWait` to `hardWait` s (#77), only the reaction time and the margin are waived: not while a closing car is inside
 *   its pure braking distance,
 *       gap >= rel² / (2 * BRAKE) + brakeMargin
 *   so a car that brakes (Brake without Throttle, as a human's Brake always is) from the step the held car is back in traffic
 *   always stops short of it. `brakeMargin` (0.25 m) is the one thing the pure formula misses: a car braking from full
 *   Throttle keeps some drive while the throttle falls (9/s), so below about 9 m/s its real stop runs up to 0.10 m past
 *   rel² / (2 * BRAKE) (worst case about 4.75 m/s, at any step of 1/20 s or less); above that, the coasting drag it gets
 *   on top of BRAKE more than makes up. The gap is nose to tail, so gap = 0 is bumper contact, which is not an impact.
 * - after `hardWait` s only a car inside it delays the return. A closing car cannot be shown to clear in bounded time (a
 *   stream of cars that never brake drives through the held car's spot, and a driver can approach, brake, back off and come
 *   again), so this second, deterministic cap in simulation time keeps the closing-car wait bounded by `hardWait`. Whatever
 *   then reaches it is covered by the rejoin's contact grace (PEN.grace, as for a re-slotted car): nobody is judged for the
 *   contact, and a car it shoves is not blamed for the onward contact either (#76).
 */
export const AWAY_REJOIN = { react: 0.5, margin: 1, maxWait: 2, brakeMargin: 0.25, hardWait: 5 };

/**
 * Hold the cars of away drivers out of traffic (#74). It must never gain anything, above all never track position through
 * another car, so:
 * - A car whose driver's link is down (Input.away) stays in traffic while it is still moving: neutral pedals, it can be
 *   bumped and bumps like any car. Only once it has stopped (slower than STALL.stopV) on the racing lane is it held: out of
 *   collisions and everyone's traffic checks, so the field drives through its spot and nobody is trapped behind it for the
 *   length of the reconnect hold. A coasting car that slips through another would gain; a standing one cannot.
 * - While held it stands on the brakes, whoever would drive it (stepCar), and its stopped count is held at 0 (stallBlock).
 *   Its lap, lap validity, fuel, debts and deadlines run on as usual.
 * - When its driver is back it rejoins traffic as soon as no car really penetrates it and none closing on it could not
 *   stop (`penetrated`, AWAY_REJOIN: with time to react for maxWait s, then by braking at once until hardWait s), and
 *   gets its pedals back only then, so the driver can never drive it through anything. A car merely touching it (bumper
 *   to bumper, as after any contact) does not delay the return. It rejoins with the same contact grace as a re-slotted
 *   car (graceT = PEN.grace): a contact involving it in that time is resolved but judged against neither car (judge()),
 *   so the driver who was told to drive through a held car is never penalised for it, and a car it shoves is not blamed
 *   for the onward contact either (#76).
 * - It cannot be held for ever: the closing-car wait ends at AWAY_REJOIN.hardWait at the latest, and the penetrating car
 *   is in traffic and not trapped by a held car (stallTrapped), so it either drives on or, a stopped human car, is
 *   recovered by its own stopped-on-track count within 3 s; an AI never follows a held car and drives on. Two held cars
 *   inside each other ignore each other here, so both rejoin when both drivers are back and collide() then separates them
 *   in their order on the slot (front stays front), as with any overlap.
 * In the pit lane, a bay or a service nothing changes. Leaving the racing lane (a de-slot, a tow, parking) ends the hold,
 * and a retired car (the hold expired) rejoins like a returned one, then parks once it stands. Runs on c.linkAway, which
 * stepCar has just set from this step's input.
 */
export function awayUpdate(r: Race, dt: number): void {
  // judged from who was held before this pass, so array order never decides which of two held cars rejoins first
  const held = new Set(r.cars.filter((c) => c.away));
  for (const c of r.cars) {
    if (c.mode !== 'race') { c.away = false; c.awayWaitT = 0; continue; }
    if (c.linkAway && !c.retire) {
      // a car the automatic pit controller is driving (sgCtl: the approach, the box queue) is never held: the controller
      // still drives it on into the pits when its turn comes, so the cars queued behind it are not stuck for the hold
      if (!c.away && Math.abs(c.v) < STALL.stopV && !c.sgCtl) { c.away = true; squeeze.leaveSqueeze(r, c); }
      c.awayWaitT = 0;
      continue;
    }
    if (!c.away) continue;
    c.awayWaitT += dt;
    // the closing-car test for this point of the wait (AWAY_REJOIN): stopping distance, then pure braking distance, then none
    const w = c.awayWaitT;
    const closing = w <= AWAY_REJOIN.maxWait + 1e-9 ? 'stop' : w <= AWAY_REJOIN.hardWait + 1e-9 ? 'brake' : null;
    if (penetrated(r, c, held, closing)) continue;
    // back in traffic, with the re-slot path's contact grace (judge() exempts both cars of a contact during it)
    c.away = false; c.awayWaitT = 0; c.graceT = PEN.grace;
    r.rejoinSqueeze(c);
  }
}

/**
 * Whether a held car must stay out of traffic for now: a car on the road or in the pit lane is inside it in the same slot
 * (less than a car length of slot between them, beyond a float's tolerance: bumper-to-bumper contact is not inside), or
 * one behind it is closing inside the clear slot `closing` asks for (AWAY_REJOIN): 'stop', its stopping distance with
 * reaction time and margin; 'brake', its pure braking distance (#77); null, no closing-car test at all. A car changing
 * lanes into the held car's lane counts as in that lane, wherever it is in the change. A change that starts after the
 * rejoin needs laneClear(), which sees the rejoined car, so only changes already under way can arrive unannounced. Cars
 * held at the start of this step (`held`) do not count: they are out of collisions, and two of them rejoining together
 * are separated by collide() like any overlap, front car in front.
 */
export function penetrated(r: Race, c: Car, held: ReadonlySet<Car>, closing: 'stop' | 'brake' | null): boolean {
  const s = r.s(c);
  const lane = c.change ? c.change.to : Math.sign(c.laneSide);
  return r.cars.some((o) => {
    if (o === c || held.has(o) || (o.mode !== 'race' && o.mode !== 'pitlane')) return false;
    const into = o.mode === 'race' && o.change !== null && o.change.to === lane;
    if (!into && Math.abs(o.d - c.d) >= r.T.CAR_W) return false;
    const g = r.T.gapS(r.s(o), s);   // > 0: o is behind c by g
    if (Math.abs(g) < r.T.CAR_LEN - 1e-6) return true;
    const rel = o.v - c.v;
    if (closing === null || g <= 0 || rel <= 0) return false;
    const brake = (rel * rel) / (2 * BRAKE);
    const need = closing === 'stop' ? rel * AWAY_REJOIN.react + brake + AWAY_REJOIN.margin : brake + AWAY_REJOIN.brakeMargin;
    return g - r.T.CAR_LEN < need;   // the clear slot, nose to tail
  });
}
