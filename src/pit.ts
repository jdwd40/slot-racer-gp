// Shared pit-lane traffic: the stop-and-go box, the service bays, bay-to-lane merges and the pit exit (see docs/pit-queue.md).
// The simulation owns this state. It is rebuilt from a snapshot of the cars at the start of every step, before any car moves,
// so car-array order, frame rate and who is human never decide priority. The HUD only reads it.
import * as T from './track';
import type { Car, Race } from './race';
import { outOfTraffic } from './traffic';
import { PIT_Q } from './pitConst';

/** What an assisted car is waiting for, or null when it is not being held. */
export type PitWait = 'queued' | 'bay' | 'exit' | null;
export type Zone = 'box' | 'exit' | `bay${number}` | `merge${number}`;
export type ReleaseWhy = 'done' | 'defer' | 'route' | 'passed' | 'terminal' | 'moved' | 'reorder' | 'recover';
export interface ResEntry { t: number; car: number; zone: Zone; op: 'grant' | 'release'; why?: ReleaseWhy }

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
  /** the race's own track context */
  private get T(): T.Track { return this.r.T; }

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
    // a car held out of traffic for an away driver (#74) is not pit traffic: it takes no place in the queue or the box order
    if (outOfTraffic(c)) return false;
    if (c.mode !== 'race' || !c.pitReq || c.status !== 'running' || c.finished || c.change || c.laneSide >= 0) return false;
    if (c.human && c.laneOverride) return false;     // heading for the inside lane at the next switch
    return this.T.ahead(this.r.s(c), this.T.PIT_IN0) < PIT_Q.approach;
  }
  /** Pit traffic: on the approach, in the pit lane or in a bay. */
  member(c: Car): boolean { return c.mode === 'pitlane' || inBay(c) || this.approaching(c); }
  /** Progress along the pit path from the entrance: negative on the approach. Only meaningful for members. */
  progress(c: Car): number {
    if (inBay(c)) return this.T.gapS(this.T.PIT_IN0, this.T.BAYS[c.bay]);
    if (c.mode === 'pitlane') return this.T.gapS(this.T.PIT_IN0, this.r.s(c));
    return -this.T.ahead(this.r.s(c), this.T.PIT_IN0);
  }
  /** Lateral position the car's path will have at track position s. */
  pathD(c: Car, member: boolean, s: number): number { return member ? this.T.pitD(s) : c.laneSide * this.T.laneHalf(s); }
  /** A car on the through lane at its bay, or about to be: bay merges in progress or granted. */
  merging(o: Car): boolean { return o.mode === 'bayOut' || (o.mode === 'service' && this.merges[o.bay] === o.idx); }
  /** Lateral position a car takes up for traffic: a merging bay car already counts as in the lane. */
  laneD(o: Car): number { return this.merging(o) ? this.T.PIT_D : o.d; }
  /** A fuel visit wanted on this approach, or still to be made in the pit lane. */
  wantsBay(c: Car): boolean {
    if (c.serviced || c.status !== 'running' || c.finished) return false;
    if (!c.human) return c.pitPlan;
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
    // road followers nearest the entrance first: one braking for the queue joins it, so the car behind brakes for it in turn
    const queue = new Set(cars.filter((c) => c.pitHold));
    const toEntry = (c: Car): number => this.T.ahead(r.s(c), this.T.PIT_IN0);
    const road = cars.filter((c) => !mem.has(c) && c.mode === 'race' && !outOfTraffic(c) && !c.change && c.laneSide < 0 && toEntry(c) < PIT_Q.approach)
      .sort((a, b) => (toEntry(a) - toEntry(b)) || a.idx - b.idx);
    for (const c of road) {
      if (!queue.size) break;
      assist(c, false, queue);
      if (c.pitHold || c.pitCap < c.v + PIT_Q.join) queue.add(c);
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
      // a car out of traffic (#74: held for an away driver) is driven through, so nobody queues behind it
      if (!counts || outOfTraffic(o)) continue;
      if (onlyHeld && !onlyHeld.has(o)) continue;     // a road car only brakes for the held queue, not ordinary racing traffic
      const so = r.s(o);
      const g = this.T.ahead(s, so);
      if (g <= 1e-6 || g > PIT_Q.look) continue;
      if (Math.abs(this.pathD(c, isMem, so) - this.laneD(o)) >= this.T.CAR_W) continue;
      const vl = inBay(o) ? 0 : o.v;
      const room = g - this.T.CAR_LEN - PIT_Q.gap + (vl > 0 ? (vl * vl) / (2 * PIT_Q.leadBrake) : vl * 0.5);
      const cap = Math.sqrt(2 * PIT_Q.decel * Math.max(0, room));
      // held: the cap stops the car, or it already stands at the stopping gap behind something standing still
      const held = cap < PIT_Q.hold || (Math.abs(vl) < 0.05 && room < 0.3);
      if (!best || cap < best.cap) best = { cap, bay: inBay(o), held };
    }
    // the stop-and-go box is exclusive: while another car stands in it, a car on the pit path stops short of its entry line
    const g = this.T.gapS(s, this.T.PEN_S - this.T.PEN_HALF);
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
    return !!h && h.mode === 'pitlane' && Math.abs(this.T.gapS(this.r.s(h), this.T.PEN_S)) < this.T.PEN_HALF;
  }

  /** The single stop-and-go box goes to the foremost car that owes a stop and has not passed it. */
  updateBox(byOrder: Car[], mem: Map<Car, number>): void {
    const end = this.T.gapS(this.T.PIT_IN0, this.T.PEN_S + this.T.PEN_HALF);
    const wants = (c: Car): boolean => mem.has(c) && !inBay(c) && c.sgOwed > 0 && c.status === 'running' && !c.finished && (mem.get(c)! <= end || c.sgServing);
    const desired = byOrder.find(wants) ?? null;
    const h = this.box >= 0 ? this.r.cars.find((c) => c.idx === this.box) ?? null : null;
    if (h && !wants(h)) {
      const why: ReleaseWhy = h.sgOwed <= 0 ? 'done' : h.mode === 'off' || h.mode === 'tow' || h.status !== 'running' || h.finished ? 'terminal' : mem.has(h) ? 'passed' : 'route';
      this.release('box', h, why);
    } else if (h && desired && desired !== h && !h.sgServing) this.release('box', h, 'reorder');
    if (this.box === -1 && desired) this.grant('box', desired);
  }

  /** Each fuel visit holds its own bay (Car.bayHome) from the approach until its merge back into the lane completes. */
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
      else if (h.mode === 'pitlane' && this.T.gapS(r.s(h), this.T.BAYS[j]) < -this.T.BAY_HALF) why = 'passed';
      if (why) this.release(`bay${j}`, h, why);
    });
    for (const c of byOrder) {
      if (inBay(c) || this.bayOf(c) >= 0 || !this.wantsBay(c)) continue;
      // only the car's own bay, ever: while it is occupied the car waits for it, it never takes another team's bay
      const j = c.bayHome;
      if (j < 0 || j >= this.T.BAYS.length) continue;
      if (c.mode === 'pitlane' && this.T.gapS(r.s(c), this.T.BAYS[j]) <= -0.45) continue;
      if (this.bayAvail(j, c) && this.grant(`bay${j}`, c)) c.bay = j;
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
      .sort((a, b) => (this.T.BAYS[b.bay] - this.T.BAYS[a.bay]) || a.idx - b.idx);
    for (const c of req) if (this.mergeSafe(c)) this.grant(`merge${c.bay}`, c);
  }

  /**
   * Passage priority at a bay: a through-lane car already in the merge zone, or too close to stop before it, goes first.
   * Otherwise the departing bay car gets the merge and lane traffic brakes for it. Two bay merges closer than
   * `mergeSpacing` are never under way together, so adjacent cars cannot both see the gap and pull out.
   */
  mergeSafe(c: Car): boolean {
    const r = this.r;
    const sb = this.T.BAYS[c.bay];
    for (let k = 0; k < this.merges.length; k++) {
      const h = this.merges[k];
      if (h >= 0 && h !== c.idx && Math.abs(this.T.BAYS[k] - sb) < PIT_Q.mergeSpacing) return false;
    }
    const need = this.T.CAR_LEN + PIT_Q.gap;
    for (const o of r.cars) {
      if (o === c) continue;
      const onLane = o.mode === 'pitlane' || this.merging(o) || (o.mode === 'bayIn' && Math.abs(o.d - this.T.PIT_D) < this.T.CAR_W);
      if (!onLane) continue;
      const g = this.T.gapS(sb, r.s(o));
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
      else if (this.T.gapS(r.s(h), this.T.PIT_OUT0) >= PIT_Q.exitWin) this.release('exit', h, 'passed');
    }
    // only the foremost car at the exit can take it: a car further back never goes first because its own view looked clear
    let first = true;
    for (const c of byOrder) {
      if (c.mode !== 'pitlane') continue;
      const a = this.T.gapS(r.s(c), this.T.PIT_OUT0);
      if (a >= PIT_Q.exitWin || this.T.gapS(r.s(c), this.T.PIT_OUT1) <= 0) continue;
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
