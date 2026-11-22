// De-slot, the marshal's re-slot, retirement parking and the out-of-fuel tow, moved out of the Race class (#141). Race keeps
// a thin deslot() (tests and browser-check call it) and calls the rest from stepCar() at the same points as before.
import type { Car, Race } from './race';
import { PEN } from './raceConst';
import * as squeeze from './squeeze';
import { outOfTraffic } from './traffic';

/** `off.t` given to a parked retired car: past the crash tumble and screech, so it is drawn and heard as standing still */
const PARKED_OFF_T = 2;

/**
 * Longest a retired car rolls before it is parked whatever its speed (simulation seconds). Unpushed it stops well inside this
 * (under 3 s from VMAX), but a car held against it from behind on full throttle can keep it rolling for ever (#44 review).
 */
export const RETIRE_COAST_MAX = 4;

export function deslot(r: Race, c: Car): void {
  const s = r.s(c);
  const p = r.T.point(s, c.d);
  const k = r.T.curvature(s);
  const hd = p.h + c.yawOff;
  const outx = Math.sin(p.h) * Math.sign(k || 1), outy = -Math.cos(p.h) * Math.sign(k || 1);
  c.off = {
    x: p.x, y: p.y,
    z: r.T.surfZ(s, c.d), vz: 2.5 + c.v * 0.12,
    vx: Math.cos(hd) * c.v * 0.5 + outx * c.v * 0.25,
    vy: Math.sin(hd) * c.v * 0.5 + outy * c.v * 0.25,
    yaw: hd, spin: -(Math.sign(k) || 1) * (5 + c.v * 0.35), t: 0,
    u0: c.u, lane: c.change ? c.change.to : Math.sign(c.laneSide) || 1,
  };
  c.mode = 'off'; c.slip = 0; c.laneReq = false; c.laneOverride = false; c.change = null; c.throttle = 0; c.lapValid = false;
  squeeze.leaveSqueeze(r, c); r.pit.releaseAll(c, 'terminal');
  r.emit({ type: 'deslot', car: c });
  r.pmsg(c, 'msg.deslot', 'bad');
}

export function stepOff(r: Race, c: Car, dt: number): void {
  const o = c.off!;
  o.t += dt;
  o.x += o.vx * dt; o.y += o.vy * dt;
  const fr = o.z > 0.01 ? 0.8 : 4.0;
  const f = Math.exp(-fr * dt);
  o.vx *= f; o.vy *= f;
  o.z += o.vz * dt; o.vz -= 28 * dt;
  if (o.z < 0) { o.z = 0; o.vz = Math.abs(o.vz) > 1.5 ? -o.vz * 0.35 : 0; }
  o.yaw += o.spin * dt; o.spin *= Math.exp(-2.2 * dt);
  c.v = 0;
  // a retired car is not put back: once it has landed it is parked instead (stepCar)
  if (o.t > 1.7 && !c.retire) {
    // marshal returns the car to the slot just behind where it left
    const u = o.u0 - 1.6;
    const s = r.T.wrapS(u);
    const d = o.lane * r.T.laneHalf(s);
    const busy = r.cars.some((x) => x !== c && (x.mode === 'race' || x.mode === 'pitlane') && !outOfTraffic(x) && Math.abs(r.T.gapS(s, r.s(x))) < 2.4 && Math.abs(x.d - d) < r.T.CAR_W);
    if (!busy) {
      c.u = u; c.laneSide = o.lane; c.d = d; c.mode = 'race'; c.off = null; c.v = 0; c.recoverT = 1.0; c.graceT = PEN.grace; c.yawOff = 0; c.wobble = 0;
      // the de-slot left the squeeze queue: a re-slot inside the squeeze queues the car again at its physical place (#100)
      r.rejoinSqueeze(c);
      if (c.human) r.pmsg(c, 'msg.backOn', 'info');
    }
  }
}

/**
 * A retired car may leave the track now: at once when it is already standing out of the racing line's way (grid, bay, tow),
 * once it has rolled to rest on the road or in the pit lane, and after a de-slot once it has landed (when the marshal would
 * otherwise have put it back). In any case after RETIRE_COAST_MAX: a car pushed from behind may never come to rest by itself.
 */
export function parkable(r: Race, c: Car): boolean {
  if (c.retireT >= RETIRE_COAST_MAX) return true;
  if (c.mode === 'race' || c.mode === 'pitlane') return Math.abs(c.v) < 0.05;
  if (c.mode === 'off') return !c.off || c.off.t > 1.7;
  return true;
}

/**
 * Take a retired car off the track for good, the way a de-slotted car leaves the slot (mode `off`, placed by `c.off`) but
 * placed at rest in its own bay, which no other team ever uses. Every rule that looks at traffic (collisions, the AI's
 * following, pit traffic, lane-change and merge clearance, the squeeze queue) already ignores an `off` car, so the cars
 * behind drive through the spot where it stopped. `u` is kept: it is the distance the DNF classification orders by.
 */
export function park(r: Race, c: Car): void {
  const p = r.T.point3(r.T.BAYS[c.bayHome], r.T.BAY_D);
  c.off = { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, yaw: p.h, spin: 0, t: PARKED_OFF_T, u0: c.u, lane: -1 };
  c.mode = 'off'; c.retire = 'parked'; c.v = 0; c.throttle = 0; c.brake = 0; c.change = null; c.slip = 0; c.wobble = 0; c.yawOff = 0;
  c.bumpT = 0; c.recoverT = 0; c.towT = 0; c.latRatio = 0; c.squeezeHold = false; c.yielding = false; c.pitHold = false; c.exitHold = false;
  c.stallHold = false; c.stallSvc = false; c.stallT = 0; c.stallRun = 0; c.stallPaused = false;
  squeeze.leaveSqueeze(r, c); r.pit.releaseAll(c, 'terminal');
}

export function stepTow(r: Race, c: Car, dt: number): void {
  c.towT += dt; c.v = 0;
  if (c.towT < 1.6) return;
  const s = r.s(c);
  // always to the car's own bay; while it is occupied the tow waits. From the pit lane it moves ahead or back, never round a lap
  const j = c.bayHome;
  if (!r.bayFree(j, c)) return;
  const dist = c.towPit ? r.T.gapS(s, r.T.BAYS[j]) : r.T.ahead(s, r.T.BAYS[j]);
  // pulled back up the pit lane: points already passed (the timing line among them) are not decided again
  const mark = dist < 0 ? Math.max(c.revMark ?? -Infinity, c.u) : null;
  c.u += dist;
  r.holdBay(c, j);
  c.bay = j; c.mode = 'service'; c.serviceT = 0; c.d = r.T.BAY_D; c.laneSide = -1; c.yawOff = 0; c.revMark = null; c.towSvc = true; c.stallSvc = false; c.exitReq = false; c.upPrev = true;
  if (mark !== null) c.revMark = mark;
  c.towPit = false;
  if (c.u > c.hiU) c.hiU = c.u;
  c.penalty = 8 + Math.abs(dist) / 11; c.pitStops++;
  c.refuelTarget = Math.max(c.refuelTarget, 0.75);
  if (c.human) r.pmsg(c, 'msg.towPenalty', 'bad', { n: Math.round(c.penalty) });
  r.laps(c);
}
