// The squeeze priority queue (#100, #110), moved out of the Race class (#141): leaving and rejoining the queue at a car's
// physical place, a pit exit inside the squeeze waiting to join it, and the lane and merge clearance checks. Race keeps thin
// methods of the names tests and the pit traffic call or override (joinSqueezeWaiting, laneClear, mergeBlocked,
// rejoinSqueeze), and every internal call to those still dispatches through the Race instance.
import type { Car, Race } from './race';
import { outOfTraffic } from './traffic';

/**
 * The squeeze priority queue: a queued car slows at up to `brake` m/s² for the car ahead of it. A car leaving the pit lane
 * inside the squeeze (circuit-4) waits to join the queue while a road car behind it could not stop behind it at that
 * braking with `margin` m to spare; closing by no more than `creep` m/s (crawling up behind it, say) never counts (#110).
 */
export const SQUEEZE = { brake: 45, margin: 1, creep: 0.5 };

export function leaveSqueeze(r: Race, c: Car): void { const i = r.squeezeQ.indexOf(c); if (i >= 0) r.squeezeQ.splice(i, 1); }

/**
 * Road car o could not stop behind car p in the squeeze: it is closing on p by more than a crawl, and its stopping
 * distance at the queue's braking, plus a margin, is more than its clear slot to p's tail less the queue's gap. Queued
 * behind p it would run up to or past p before the cap held it, and once queued the cap and collide() go by queue order.
 */
export function cannotStopBehind(r: Race, o: Car, p: Car, margin = SQUEEZE.margin): boolean {
  if (o.v <= p.v + SQUEEZE.creep) return false;
  const room = r.T.gapS(r.s(o), r.s(p)) - (r.T.CAR_LEN + 0.3);
  return (o.v * o.v) / (2 * SQUEEZE.brake) + margin > room;
}

/**
 * A car that left the pit lane inside the squeeze (circuit-4) waits to join the queue (Car.sqWait). It joins at its
 * physical place (rejoinSqueeze) on the first step, before any car moves, at which every car on the road that would be
 * behind it, queued or still short of the entry, can stop behind it, and it can stop behind every queued car that would be
 * ahead of it (cannotStopBehind). Until then it runs outside the
 * queue as before #110: a faster car closing on it goes by first, physically, and the queue stays in physical order. It
 * stops waiting once out of the squeeze or out of traffic, or no longer on the racing lane.
 */
export function joinSqueezeWaiting(r: Race): void {
  for (const c of r.cars) {
    if (!c.sqWait) continue;
    if (c.mode !== 'race' || outOfTraffic(c) || !r.T.inRange(r.s(c), r.T.SQ_ENTRY, r.T.SQ_EXIT) || r.squeezeQ.includes(c)) {
      c.sqWait = false; continue;
    }
    const behind = (o: Car): boolean => {
      const g = r.T.gapS(r.s(o), r.s(c));
      return g > 0 || (g === 0 && o.idx > c.idx);
    };
    // and it can stop behind every queued car that would be ahead of it, so it never overruns one either
    const blocked = r.cars.some((o) => o !== c && o.mode === 'race' && !outOfTraffic(o) && behind(o) && cannotStopBehind(r, o, c))
      || r.squeezeQ.some((o) => !outOfTraffic(o) && !behind(o) && cannotStopBehind(r, c, o, 0));
    if (blocked) continue;
    c.sqWait = false;
    r.rejoinSqueeze(c);
  }
}

export function occupies(r: Race, c: Car, side: number): boolean {
  if (c.mode !== 'race') return false;
  if (c.change) return true;
  return Math.sign(c.laneSide) === side;
}

export function laneClear(r: Race, c: Car, to: number): boolean {
  const s = r.s(c);
  for (const o of r.cars) {
    if (o === c || outOfTraffic(o) || !occupies(r, o, to)) continue;
    const g = r.T.gapS(s, r.s(o));
    const front = r.T.CAR_LEN + 0.5 + Math.max(0, c.v - o.v) * 0.45;
    const back = r.T.CAR_LEN + 0.5 + Math.max(0, o.v - c.v) * 0.55;
    if (g < front && g > -back) return false;
  }
  return true;
}

/**
 * The outside lane is not clear for a pit-exit merge: a car standing, crawling or backing up in the merge's conflict zone
 * (or too close beyond it to stop behind), a car backing towards it, or traffic passing alongside.
 */
export function mergeBlocked(r: Race, c: Car): boolean {
  const s = r.s(c);
  const zone = r.T.PIT_OUT1 - r.T.PIT_OUT0 + r.T.CAR_LEN + 2;
  for (const o of r.cars) {
    if (o === c || o.mode !== 'race' || outOfTraffic(o)) continue;
    if (!(o.change || o.laneSide < 0)) continue;
    const z = r.T.gapS(r.T.PIT_OUT0, r.s(o));
    if (o.v < 1 && z > 1.5 && z < zone + Math.max(0, -o.v) * 1.5) return true;
    // a car backing up counts however slow: it is coming towards the merge from ahead
    if (o.v >= 0 && o.v < 1) continue;
    const g = r.T.gapS(s, r.s(o));
    if (g < 2.5 + Math.max(0, -o.v) * 1.5 && g > -(3 + Math.max(0, o.v) * 0.75)) return true;
  }
  return false;
}

/**
 * A car leaves the squeeze priority queue while it is out of traffic (held, de-slotted) or backing up (it would cap the
 * cars behind it, which drive through its spot or that it backs past), so a car that is back in traffic inside the
 * squeeze is put back in the queue at its physical place: behind every queued car ahead of it on the slot, ahead of those
 * behind it (ties by grid slot, deterministic). That place is read now, not remembered, so a car that backed up behind
 * cars it was ahead of, or was re-slotted behind cars that went past, queues behind them. Callers: an away car's rejoin,
 * the marshal's re-slot, a car driving forward again after backing up (#100) and a car leaving the pit lane inside the
 * squeeze (#110). Outside the squeeze, or already queued, nothing changes.
 */
export function rejoinSqueeze(r: Race, c: Car): void {
  const s = r.s(c);
  // (a car waiting to join after its pit exit joins only through joinSqueezeWaiting)
  if (c.mode !== 'race' || outOfTraffic(c) || c.sqWait) return;
  if (!r.T.inRange(s, r.T.SQ_ENTRY, r.T.SQ_EXIT) || r.squeezeQ.includes(c)) return;
  const prog = (x: Car): number => r.T.gapS(r.T.SQ_ENTRY, r.s(x));
  const p = prog(c);
  // (queued cars are always in traffic: every way out of traffic leaves the queue; the check keeps the traffic invariant)
  const at = r.squeezeQ.findIndex((x) => !outOfTraffic(x) && (prog(x) < p || (prog(x) === p && x.idx > c.idx)));
  if (at < 0) r.squeezeQ.push(c); else r.squeezeQ.splice(at, 0, c);
}
