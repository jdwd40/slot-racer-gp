// Shared pit-lane traffic: the stop-and-go box, the service bays, bay-to-lane merges and the pit exit (see docs/pit-queue.md).
// The simulation owns this state. It is rebuilt from a snapshot of the cars at the start of every step, before any car moves,
// so car-array order, frame rate and who is human never decide priority. The HUD only reads it.
import * as T from './track';
import type { Car, Race } from './race';

/** What an assisted car is waiting for, or null when it is not being held. */
export type PitWait = 'queued' | 'bay' | 'exit' | null;
export type Zone = 'box' | 'exit' | `bay${number}` | `merge${number}`;
export type ReleaseWhy = 'done' | 'defer' | 'route' | 'passed' | 'terminal' | 'moved' | 'reorder';
export interface ResEntry { t: number; car: number; zone: Zone; op: 'grant' | 'release'; why?: ReleaseWhy }

export const PIT_Q = {
  gap: 0.5,          // clear slot kept behind a stopped leader (beyond bumper contact)
  decel: 20,         // braking the assisted speed cap plans with (m/s²); the cap itself is enforced at up to 45
  leadBrake: 30,     // braking assumed for a moving leader
  look: 40,          // obstacles further ahead than this are ignored
  approach: 40,      // road distance before the pit entrance in which a routed car joins the queue
  hold: 0.6,         // an assisted cap below this (m/s) holds the car: it is queued
  mergeSpacing: 4,   // bay merges closer than this are never under way together (adjacent bays are 3 m apart)
  mergeTime: 1.0,    // seconds of a reversing car's travel a bay departure allows for
  exitWin: 4,        // yield window before the pit exit merge starts
  boxMargin: 0.4,    // a car held out of an occupied box plans to stop this far short of its entry line
};

const BAY_MODES = new Set(['bayIn', 'service', 'bayOut']);
const inBay = (c: Car): boolean => BAY_MODES.has(c.mode);
const LOG_MAX = 400;

export class PitTraffic {
  /** car idx holding each resource, -1 for free */
  box = -1;
  exit = -1;
  bays: number[] = T.BAYS.map(() => -1);
  merges: number[] = T.BAYS.map(() => -1);
  /** pit traffic this step, foremost first: approach, pit lane and bays, by physical progress (ties: lower car number) */
  order: number[] = [];
  /** grants and releases, newest last (bounded) */
  log: ResEntry[] = [];

  constructor(private r: Race) {}

  holder(z: Zone): number {
    if (z === 'box') return this.box;
    if (z === 'exit') return this.exit;
    const j = +z.slice(z.startsWith('bay') ? 3 : 5);
    return z.startsWith('bay') ? this.bays[j] : this.merges[j];
  }
  private set(z: Zone, v: number): void {
    if (z === 'box') this.box = v;
    else if (z === 'exit') this.exit = v;
    else if (z.startsWith('bay')) this.bays[+z.slice(3)] = v;
    else this.merges[+z.slice(5)] = v;
  }
  private note(e: Omit<ResEntry, 't'>): void {
    this.log.push({ t: this.r.t, ...e });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }
  /** Give a free resource to a car. Never takes one from another holder. */
  grant(z: Zone, c: Car): boolean {
    const h = this.holder(z);
    if (h === c.idx) return true;
    if (h !== -1) return false;
    this.set(z, c.idx);
    this.note({ car: c.idx, zone: z, op: 'grant' });
    return true;
  }
  /** Release a resource the car holds. A second release of the same reservation does nothing. */
  release(z: Zone, c: Car, why: ReleaseWhy): void {
    if (this.holder(z) !== c.idx) return;
    this.set(z, -1);
    this.note({ car: c.idx, zone: z, op: 'release', why });
  }
  /** Every resource the car holds. */
  held(c: Car): Zone[] {
    const out: Zone[] = [];
    if (this.box === c.idx) out.push('box');
    this.bays.forEach((h, j) => { if (h === c.idx) out.push(`bay${j}`); });
    this.merges.forEach((h, j) => { if (h === c.idx) out.push(`merge${j}`); });
    if (this.exit === c.idx) out.push('exit');
    return out;
  }
  releaseAll(c: Car, why: ReleaseWhy): void { for (const z of this.held(c)) this.release(z, c, why); }
  /** The bay this car has reserved, or -1. */
  bayOf(c: Car): number { return this.bays.indexOf(c.idx); }

  // ------------------------------------------------------------ geometry
  /** Routed into the pit at the coming entrance: on the outside lane, no change running, within the approach. */
  approaching(c: Car): boolean {
    if (c.mode !== 'race' || !c.pitReq || c.status !== 'running' || c.finished || c.change || c.laneSide >= 0) return false;
    if (c.isPlayer && c.laneOverride) return false;     // heading for the inside lane at the next switch
    return T.ahead(this.r.s(c), T.PIT_IN0) < PIT_Q.approach;
  }
  /** Pit traffic: on the approach, in the pit lane or in a bay. */
  member(c: Car): boolean { return c.mode === 'pitlane' || inBay(c) || this.approaching(c); }
  /** Progress along the pit path from the entrance: negative on the approach. Only meaningful for members. */
  progress(c: Car): number {
    if (inBay(c)) return T.gapS(T.PIT_IN0, T.BAYS[c.bay]);
    if (c.mode === 'pitlane') return T.gapS(T.PIT_IN0, this.r.s(c));
    return -T.ahead(this.r.s(c), T.PIT_IN0);
  }
  /** Lateral position the car's path will have at track position s. */
  pathD(c: Car, member: boolean, s: number): number { return member ? T.pitD(s) : c.laneSide * T.laneHalf(s); }
  /** A car on the through lane at its bay, or about to be: bay merges in progress or granted. */
  merging(o: Car): boolean { return o.mode === 'bayOut' || (o.mode === 'service' && this.merges[o.bay] === o.idx); }
  /** Lateral position a car takes up for traffic: a merging bay car already counts as in the lane. */
  laneD(o: Car): number { return this.merging(o) ? T.PIT_D : o.d; }
  /** A fuel visit wanted on this approach, or still to be made in the pit lane. */
  wantsBay(c: Car): boolean {
    if (c.serviced || c.status !== 'running' || c.finished) return false;
    if (!c.isPlayer) return c.pitPlan;
    return c.mode === 'pitlane' ? c.pitFuel : c.fuelReq || c.fuelDue > 0;
  }
  /** A bay can be taken by this car: nobody else is in it or has reserved it. */
  bayAvail(j: number, c: Car): boolean {
    const h = this.bays[j];
    if (h !== -1 && h !== c.idx) return false;
    return !this.r.cars.some((o) => o !== c && o.bay === j && inBay(o));
  }

  // ------------------------------------------------------------ the step
  /** Rebuild reservations and every car's assisted cap from where the cars are now. Runs before any car moves. */
  update(): void {
    const r = this.r;
    const cars = r.cars;
    const mem = new Map<Car, number>();
    for (const c of cars) if (this.member(c)) mem.set(c, this.progress(c));
    const byOrder = [...mem.keys()].sort((a, b) => (mem.get(b)! - mem.get(a)!) || a.idx - b.idx);
    this.order = byOrder.map((c) => c.idx);

    this.updateBox(byOrder, mem);
    this.updateBays(byOrder);
    this.updateMerges();
    this.updateExit(byOrder);

    // assisted caps and what each held car is waiting for. Pit traffic first; then road cars behind a held queue on the
    // outside lane, which brake only for held cars (decided in the first pass), never for ordinary racing traffic
    for (const c of cars) {
      c.pitCap = 1e9; c.pitWait = null; c.pitHold = false;
      c.waitingClear = c.mode === 'service' && c.exitReq && this.merges[c.bay] !== c.idx;
      if (c.waitingClear) c.pitWait = 'exit';
    }
    const assist = (c: Car, isMem: boolean, onlyHeld: Set<Car> | null): void => {
      const lead = this.leader(c, isMem, onlyHeld);
      if (lead) { c.pitCap = lead.cap; if (lead.held) { c.pitHold = true; c.pitWait = lead.bay ? 'bay' : 'queued'; } }
      if (c.exitHold) { c.pitWait = 'exit'; c.pitHold = true; }
    };
    for (const c of cars) if (mem.has(c) && (c.mode === 'race' || c.mode === 'pitlane')) assist(c, true, null);
    const heldQ = new Set(cars.filter((c) => c.pitHold));
    for (const c of cars) {
      const follower = !mem.has(c) && c.mode === 'race' && !c.change && c.laneSide < 0 && T.ahead(r.s(c), T.PIT_IN0) < PIT_Q.approach;
      if (follower && heldQ.size) assist(c, false, heldQ);
    }
  }

  /** The nearest thing ahead on the car's own path and the speed that still stops short of it. */
  leader(c: Car, isMem: boolean, onlyHeld: Set<Car> | null): { cap: number; bay: boolean; held: boolean } | null {
    const r = this.r;
    const s = r.s(c);
    let best: { cap: number; bay: boolean; held: boolean } | null = null;
    for (const o of r.cars) {
      if (o === c) continue;
      const counts = o.mode === 'race' || o.mode === 'pitlane' || o.mode === 'grid' || o.mode === 'bayIn' || this.merging(o);
      if (!counts) continue;
      if (onlyHeld && !onlyHeld.has(o)) continue;     // a road car only brakes for the held queue, not ordinary racing traffic
      const so = r.s(o);
      const g = T.ahead(s, so);
      if (g <= 1e-6 || g > PIT_Q.look) continue;
      if (Math.abs(this.pathD(c, isMem, so) - this.laneD(o)) >= T.CAR_W) continue;
      const vl = inBay(o) ? 0 : o.v;
      const room = g - T.CAR_LEN - PIT_Q.gap + (vl > 0 ? (vl * vl) / (2 * PIT_Q.leadBrake) : vl * 0.5);
      const cap = Math.sqrt(2 * PIT_Q.decel * Math.max(0, room));
      // held: the cap stops the car, or it already stands at the stopping gap behind something standing still
      const held = cap < PIT_Q.hold || (Math.abs(vl) < 0.05 && room < 0.3);
      if (!best || cap < best.cap) best = { cap, bay: inBay(o), held };
    }
    // the stop-and-go box is exclusive: while another car stands in it, a car on the pit path stops short of its entry line
    const g = T.gapS(s, T.PEN_S - T.PEN_HALF);
    if (isMem && !onlyHeld && g > 0 && g <= PIT_Q.look && this.boxTaken(c)) {
      const room = Math.max(0, g - PIT_Q.boxMargin);
      const cap = Math.sqrt(2 * PIT_Q.decel * room);
      const held = cap < PIT_Q.hold || (Math.abs(c.v) < 0.05 && room < 0.3);
      if (!best || cap < best.cap) best = { cap, bay: false, held };
    }
    return best;
  }

  /** Another car holds the stop-and-go box and is standing (or rolling) in it. */
  boxTaken(c: Car): boolean {
    if (this.box < 0 || this.box === c.idx) return false;
    const h = this.r.cars.find((o) => o.idx === this.box);
    return !!h && h.mode === 'pitlane' && Math.abs(T.gapS(this.r.s(h), T.PEN_S)) < T.PEN_HALF;
  }

  /** The single stop-and-go box goes to the foremost car that owes a stop and has not passed it. */
  updateBox(byOrder: Car[], mem: Map<Car, number>): void {
    const end = T.gapS(T.PIT_IN0, T.PEN_S + T.PEN_HALF);
    const wants = (c: Car): boolean => mem.has(c) && !inBay(c) && c.sgOwed > 0 && c.status === 'running' && !c.finished && (mem.get(c)! <= end || c.sgServing);
    const desired = byOrder.find(wants) ?? null;
    const h = this.box >= 0 ? this.r.cars.find((c) => c.idx === this.box) ?? null : null;
    if (h && !wants(h)) {
      const why: ReleaseWhy = h.sgOwed <= 0 ? 'done' : h.mode === 'off' || h.mode === 'tow' || h.status !== 'running' || h.finished ? 'terminal' : mem.has(h) ? 'passed' : 'route';
      this.release('box', h, why);
    } else if (h && desired && desired !== h && !h.sgServing) this.release('box', h, 'reorder');
    if (this.box === -1 && desired) this.grant('box', desired);
  }

  /** Each fuel visit holds one bay from the approach until its merge back into the lane completes. */
  updateBays(byOrder: Car[]): void {
    const r = this.r;
    this.bays.forEach((hi, j) => {
      if (hi < 0) return;
      const h = r.cars.find((c) => c.idx === hi);
      if (!h) { this.bays[j] = -1; return; }
      if (inBay(h) && h.bay === j) return;
      let why: ReleaseWhy | null = null;
      if (h.mode === 'off' || h.mode === 'tow' || h.status !== 'running' || h.finished) why = 'terminal';
      else if (!this.member(h)) why = 'route';
      else if (!this.wantsBay(h)) why = h.serviced ? 'done' : 'route';
      else if (h.mode === 'pitlane' && T.gapS(r.s(h), T.BAYS[j]) < -T.BAY_HALF) why = 'passed';
      if (why) this.release(`bay${j}`, h, why);
    });
    for (const c of byOrder) {
      if (inBay(c) || this.bayOf(c) >= 0 || !this.wantsBay(c)) continue;
      const s = r.s(c);
      const ahead = (j: number): boolean => c.mode !== 'pitlane' || T.gapS(s, T.BAYS[j]) > -0.45;
      let j = c.bay >= 0 && c.bay < T.BAYS.length && ahead(c.bay) && this.bayAvail(c.bay, c) ? c.bay : -1;
      for (let k = 0; k < T.BAYS.length && j < 0; k++) if (ahead(k) && this.bayAvail(k, c)) j = k;
      if (j >= 0 && this.grant(`bay${j}`, c)) c.bay = j;
    }
  }

  /** Bay departures: downstream bays first, each only when the current gap and its projected movement are clear. */
  updateMerges(): void {
    const r = this.r;
    this.merges.forEach((hi, j) => {
      if (hi < 0) return;
      const h = r.cars.find((c) => c.idx === hi);
      if (!h) { this.merges[j] = -1; return; }
      const ok = h.bay === j && (h.mode === 'bayOut' || (h.mode === 'service' && h.exitReq));
      if (!ok) this.release(`merge${j}`, h, h.mode === 'pitlane' ? 'done' : h.mode === 'tow' || h.mode === 'off' ? 'terminal' : 'route');
    });
    const req = r.cars.filter((c) => c.mode === 'service' && c.exitReq && this.merges[c.bay] !== c.idx)
      .sort((a, b) => (T.BAYS[b.bay] - T.BAYS[a.bay]) || a.idx - b.idx);
    for (const c of req) if (this.mergeSafe(c)) this.grant(`merge${c.bay}`, c);
  }

  /**
   * Passage priority at a bay: a through-lane car already in the merge zone, or too close to stop before it, goes first.
   * Otherwise the departing bay car gets the merge and lane traffic brakes for it. Two bay merges closer than
   * `mergeSpacing` are never under way together, so adjacent cars cannot both see the gap and pull out.
   */
  mergeSafe(c: Car): boolean {
    const r = this.r;
    const sb = T.BAYS[c.bay];
    for (let k = 0; k < this.merges.length; k++) {
      const h = this.merges[k];
      if (h >= 0 && h !== c.idx && Math.abs(T.BAYS[k] - sb) < PIT_Q.mergeSpacing) return false;
    }
    const need = T.CAR_LEN + PIT_Q.gap;
    for (const o of r.cars) {
      if (o === c) continue;
      const onLane = o.mode === 'pitlane' || this.merging(o) || (o.mode === 'bayIn' && Math.abs(o.d - T.PIT_D) < T.CAR_W);
      if (!onLane) continue;
      const g = T.gapS(sb, r.s(o));
      const v = inBay(o) ? 0 : o.v;
      if (g >= 0) { if (g + Math.min(0, v) * PIT_Q.mergeTime < need) return false; }
      else if (-g < need + (Math.max(0, v) ** 2) / (2 * PIT_Q.decel) + Math.max(0, v) * 0.05) return false;
    }
    return true;
  }

  /** The pit exit is taken by one car at a time, foremost first, and only when the outside lane is clear to merge into. */
  updateExit(byOrder: Car[]): void {
    const r = this.r;
    for (const c of r.cars) c.exitHold = false;
    if (this.exit >= 0) {
      const h = r.cars.find((c) => c.idx === this.exit);
      if (!h) this.exit = -1;
      else if (h.mode !== 'pitlane') this.release('exit', h, h.mode === 'race' ? 'done' : 'terminal');
      else if (T.gapS(r.s(h), T.PIT_OUT0) >= PIT_Q.exitWin) this.release('exit', h, 'passed');
    }
    // only the foremost car at the exit can take it: a car further back never goes first because its own view looked clear
    let first = true;
    for (const c of byOrder) {
      if (c.mode !== 'pitlane') continue;
      const a = T.gapS(r.s(c), T.PIT_OUT0);
      if (a >= PIT_Q.exitWin || T.gapS(r.s(c), T.PIT_OUT1) <= 0) continue;
      const lead = first; first = false;
      if (!lead && this.exit === c.idx && a > 0) this.release('exit', c, 'reorder');
      const blocked = r.mergeBlocked(c);
      if (this.exit === c.idx) { c.exitHold = a > 0 && blocked; continue; }
      if (lead && this.exit === -1 && !blocked) { this.grant('exit', c); continue; }
      // somebody else is merging, or the outside lane is not clear: wait at the line (a car already past it is committed)
      c.exitHold = a > 0;
    }
  }
}
