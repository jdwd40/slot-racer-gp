import * as T from './track';

export const LAPS = 13;
export const ACC = 30, VMAX = 26, COAST = 9, BRAKE = 30, DRAG = 0.006;
export const AI_GRIP = 36;   // cornering speeds the AI aims for
export const GRIP = 52;      // real grip of the slot (well above the AI's target, so cars stick)
/** fuel per unit distance at nominal throttle (scaled to the active lap length) */
export function fuelRate(): number { return 1 / (T.L * 7.4); }
export const REFUEL_RATE = 0.2;           // tank per second
export const LOW_FUEL = 0.2;
/** burn multiplier the AI plans with: near full throttle (0.5 + 0.7*thr) plus a safety margin */
const PLAN_BURN = 1.25;

export type Mode = 'grid' | 'race' | 'pitlane' | 'bayIn' | 'service' | 'bayOut' | 'off' | 'tow';

export interface OffState { x: number; y: number; vx: number; vy: number; yaw: number; spin: number; t: number; z: number; vz: number; u0: number; lane: number; }

export interface Car {
  idx: number; name: string; color: number; isPlayer: boolean;
  u: number; v: number; laneSide: number;
  change: { from: number; to: number; s0: number; s1: number } | null;
  laneReq: boolean; pitReq: boolean;
  mode: Mode; d: number; yawOff: number;
  throttle: number; brake: number;
  fuel: number; slip: number; latRatio: number; wobble: number;
  off: OffState | null; recoverT: number; towT: number;
  bay: number; bayT: number; serviceT: number; penalty: number; fuelAtBay: number;
  crossed: number; lapsDone: number; lapStart: number; lastLap: number; bestLap: number;
  finished: boolean; finishTime: number; pitStops: number;
  squeezeHold: boolean; yielding: boolean; waitingClear: boolean;
  skill: number; skillNow: number; mistakeT: number; pitPlan: boolean; refuelTarget: number; changeCooldown: number;
  lowFuelWarned: boolean;
  serviced: boolean;
  // render pose (x, y on the mat; z height; roll/pitch from banking and ramps)
  x: number; y: number; h: number; z: number; roll: number; pitch: number;
  bumpT: number;
}

export type RaceEvent =
  | { type: 'msg'; text: string; kind: 'info' | 'good' | 'warn' | 'bad'; vars?: Record<string, string | number> }
  | { type: 'bump'; car: Car; power: number }
  | { type: 'deslot'; car: Car }
  | { type: 'switch'; car: Car }
  | { type: 'lap'; car: Car; time: number; best: boolean }
  | { type: 'finish'; car: Car; pos: number }
  | { type: 'tow'; car: Car }
  | { type: 'go' }
  | { type: 'light'; n: number };

export interface Input { up: boolean; down: boolean; }

const DRIVERS = [
  { name: 'YOU', color: 0xffcc1a },
  { name: 'Red Comet', color: 0xe8322a },
  { name: 'Blue Arrow', color: 0x2a6df0 },
  { name: 'Green Viper', color: 0x22b04b },
];

function rnd(a: number, b: number): number { return a + Math.random() * (b - a); }

export class Race {
  cars: Car[] = [];
  phase: 'countdown' | 'racing' | 'done' = 'countdown';
  t = 0; goT = 4.6; raceTime = 0; lights = 0;
  events: RaceEvent[] = [];
  squeezeQ: Car[] = [];
  profiles: Record<string, Float32Array> = {};
  playerDoneT = -1;

  constructor() {
    this.profiles['-1'] = T.buildProfile(-1, AI_GRIP, VMAX, 20);
    this.profiles['1'] = T.buildProfile(1, AI_GRIP, VMAX, 20);
    this.goT = 4.0 + rnd(0.5, 1.4);
    // grid: two rows; player in row 2 on the outside lane
    const grid = [
      { di: 1, prog: -1.3, side: 1 }, { di: 2, prog: -1.3, side: -1 },
      { di: 3, prog: -3.9, side: 1 }, { di: 0, prog: -3.9, side: -1 },
    ];
    const skills = [1, 0.955, 0.94, 0.925];
    for (const g of grid) {
      const D = DRIVERS[g.di];
      const c: Car = {
        idx: g.di, name: D.name, color: D.color, isPlayer: g.di === 0,
        u: T.FINISH_S + g.prog, v: 0, laneSide: g.side, change: null, laneReq: false, pitReq: false,
        mode: 'grid', d: g.side * T.LANE_HALF, yawOff: 0, throttle: 0, brake: 0,
        fuel: 1, slip: 0, latRatio: 0, wobble: 0, off: null, recoverT: 0, towT: 0,
        bay: g.di, bayT: 0, serviceT: 0, penalty: 0, fuelAtBay: 0,
        crossed: 0, lapsDone: 0, lapStart: 0, lastLap: 0, bestLap: 0,
        finished: false, finishTime: 0, pitStops: 0,
        squeezeHold: false, yielding: false, waitingClear: false,
        skill: skills[g.di], skillNow: skills[g.di], mistakeT: rnd(18, 40), pitPlan: false, refuelTarget: 1, changeCooldown: 0,
        lowFuelWarned: false, serviced: false,
        x: 0, y: 0, h: 0, z: 0, roll: 0, pitch: 0, bumpT: 0,
      };
      this.cars.push(c);
    }
    this.cars.sort((a, b) => a.idx - b.idx);
    for (const c of this.cars) this.pose(c);
  }

  get player(): Car { return this.cars[0]; }

  s(c: Car): number { return T.wrapS(c.u); }

  emit(e: RaceEvent): void { this.events.push(e); }
  pmsg(c: Car, text: string, kind: 'info' | 'good' | 'warn' | 'bad', vars?: Record<string, string | number>): void {
    if (c.isPlayer) this.emit({ type: 'msg', text, kind, vars });
  }

  requestLane(): void {
    const c = this.player;
    if (c.finished || (c.mode !== 'race' && c.mode !== 'grid')) return;
    if (c.change) return;
    c.laneReq = !c.laneReq;
    this.pmsg(c, c.laneReq ? 'msg.laneReady' : 'msg.laneCancelled', c.laneReq ? 'info' : 'warn');
  }
  requestPit(): void {
    const c = this.player;
    if (c.finished || (c.mode !== 'race' && c.mode !== 'grid')) return;
    c.pitReq = !c.pitReq;
    if (!c.pitReq) { this.pmsg(c, 'msg.pitCancelled', 'warn'); return; }
    const outside = c.change ? c.change.to < 0 : c.laneSide < 0;
    this.pmsg(c, outside ? 'msg.pitRequested' : 'msg.pitNeedLane', outside ? 'info' : 'warn');
  }

  order(): Car[] {
    return [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.u - a.u;
    });
  }

  nextSwitch(c: Car): T.Switch {
    const s = this.s(c);
    let best = T.SWITCHES[0], bd = 1e9;
    for (const sw of T.SWITCHES) { const a = T.ahead(s, sw.s0); if (a < bd) { bd = a; best = sw; } }
    return best;
  }

  update(dt: number, input: Input): void {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, input);
  }

  step(dt: number, input: Input): void {
    this.t += dt;
    if (this.phase === 'countdown') {
      const n = this.t < this.goT ? Math.min(5, Math.floor(this.t / 0.8)) : 0;
      if (n !== this.lights && this.t < this.goT) { this.lights = n; this.emit({ type: 'light', n }); }
      if (this.t >= this.goT) {
        this.lights = 0; this.phase = 'racing'; this.emit({ type: 'go' });
        for (const c of this.cars) c.mode = 'race';
      }
    } else {
      this.raceTime += dt;
    }
    for (const c of this.cars) this.stepCar(c, dt, input);
    this.collide();
    for (const c of this.cars) this.pose(c);
    if (this.player.finished && this.playerDoneT < 0) this.playerDoneT = this.t;
    if (this.playerDoneT >= 0 && this.t - this.playerDoneT > 3.2 && this.phase !== 'done') this.phase = 'done';
  }

  // ---------------------------------------------------------------- car step
  stepCar(c: Car, dt: number, input: Input): void {
    c.bumpT = Math.max(0, c.bumpT - dt);
    c.recoverT = Math.max(0, c.recoverT - dt);
    c.changeCooldown = Math.max(0, c.changeCooldown - dt);
    if (c.mode === 'off') { this.stepOff(c, dt); return; }
    if (c.mode === 'tow') { this.stepTow(c, dt); return; }
    if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') { this.stepBay(c, dt, input); return; }

    // ---- control
    let thrIn = 0, brkIn = 0;
    if (c.mode !== 'grid' || c.isPlayer) {
      if (c.isPlayer && !c.finished) { thrIn = input.up ? 1 : 0; brkIn = input.down ? 1 : 0; }
      else if (c.mode !== 'grid') { const a = this.ai(c, dt); thrIn = a.t; brkIn = a.b; }
    }
    const rise = c.isPlayer ? 4.5 : 6, fall = 9;
    c.throttle += Math.max(-fall * dt, Math.min(rise * dt, thrIn - c.throttle));
    c.brake = brkIn;
    if (c.mode === 'grid') return;
    const thr = c.fuel > 0 ? c.throttle : 0;

    // ---- longitudinal dynamics
    const v0 = c.v;
    const drive = thr * ACC * Math.max(0, 1 - v0 / VMAX);
    const decel = (1 - thr) * COAST + brkIn * BRAKE + DRAG * v0 * v0;
    c.v = Math.max(0, v0 + (drive - decel) * dt);

    // ---- automatic caps (pit limiter, squeeze priority, pit exit yield)
    const s0 = this.s(c);
    let cap = 1e9;
    c.squeezeHold = false; c.yielding = false;
    if (c.mode === 'pitlane') {
      cap = T.PIT_SPEED;
      const a = T.gapS(s0, T.PIT_OUT0);
      if (a > 0 && a < 4 && this.mergeBlocked(c)) {
        cap = Math.min(cap, Math.sqrt(2 * 25 * Math.max(0, a - 0.4)));
        c.yielding = true;
      }
    }
    const qi = this.squeezeQ.indexOf(c);
    if (qi > 0) {
      const ah = this.squeezeQ[qi - 1];
      const gap = T.gapS(s0, this.s(ah));
      const minGap = T.CAR_LEN + 0.3;
      const lim = Math.max(0, ah.v + 3 * (gap - minGap));
      if (gap < minGap + 2.5 && Math.abs(c.d - ah.d) > 0.05) c.squeezeHold = lim < c.v + 1;
      cap = Math.min(cap, lim);
    }
    if (c.v > cap) c.v = Math.max(cap, c.v - 45 * dt);

    // ---- move along slot
    const k = T.curvature(s0);
    const ds = (c.v * dt) / Math.max(0.3, 1 - k * c.d);
    const prevD = c.d;
    c.u += ds;
    const s = this.s(c);
    const crossed = (x: number): boolean => { const g = T.gapS(s0, x); return ds > 0 && g >= 0 && g < ds; };

    // fuel
    // cars on their cool-down lap after the flag no longer burn fuel (they would otherwise run dry and get towed)
    if (!c.finished) c.fuel = Math.max(0, c.fuel - c.v * dt * fuelRate() * (0.5 + 0.7 * thr));
    if (c.isPlayer && !c.lowFuelWarned && c.fuel < LOW_FUEL && !c.finished) { c.lowFuelWarned = true; this.pmsg(c, 'msg.lowFuel', 'bad'); }
    if (c.fuel > LOW_FUEL + 0.05) c.lowFuelWarned = false;

    if (c.mode === 'race') {
      // lane switches
      for (const sw of T.SWITCHES) {
        if (crossed(sw.s0) && c.laneReq && !c.change) {
          c.laneReq = false;
          const to = c.laneSide > 0 ? -1 : 1;
          if (this.laneClear(c, to)) {
            c.change = { from: c.laneSide, to, s0: sw.s0, s1: sw.s1 };
            c.changeCooldown = 3;
            this.emit({ type: 'switch', car: c });
            this.pmsg(c, 'msg.laneGo', 'good');
          } else {
            this.pmsg(c, 'msg.laneBlocked', 'bad');
          }
        }
      }
      if (c.change) {
        const len = c.change.s1 - c.change.s0;
        const p = T.ahead(c.change.s0, s);
        if (p >= len && p < len + 20) { c.laneSide = c.change.to; c.change = null; }
        else c.laneSide = c.change.from + (c.change.to - c.change.from) * T.smooth(p / len);
      }
      // pit entry
      if (crossed(T.PIT_IN0) && c.pitReq) {
        c.pitReq = false;
        if (c.laneSide < 0 && !c.change && !c.finished) {
          c.mode = 'pitlane';
          this.pmsg(c, 'msg.pitIn', 'info');
        } else this.pmsg(c, 'msg.pitMissed', 'bad');
      }
      // squeeze priority queue
      if (crossed(T.SQ_ENTRY) && !this.squeezeQ.includes(c)) this.squeezeQ.push(c);
      if (crossed(T.SQ_EXIT)) this.leaveSqueeze(c);
      c.d = c.laneSide * T.laneHalf(s);
    } else if (c.mode === 'pitlane') {
      c.d = T.pitD(s);
      if (crossed(T.PIT_OUT1)) { c.mode = 'race'; c.laneSide = -1; c.d = -T.LANE_HALF; c.serviced = false; }
      else if (c.v < 0.7 && c.isPlayer && !c.serviced) this.tryBay(c, s);
      else if (!c.isPlayer && c.pitPlan) {
        const bs = T.BAYS[c.bay];
        if (Math.abs(T.gapS(s, bs)) < 0.45 && c.v < 1.5 && this.bayFree(c.bay, c)) this.enterBay(c, c.bay);
        else if (T.gapS(s, bs) < -0.45 || !this.bayFree(c.bay, c)) {
          // own bay passed or occupied: take the next free one ahead, else queue at the last bay
          const j = this.pickBay(c, s);
          if (j >= 0) c.bay = j;
        }
      }
    }

    // render yaw from lateral motion
    const yo = ds > 1e-5 ? Math.atan2(c.d - prevD, ds) : 0;
    c.yawOff += (yo - c.yawOff) * Math.min(1, dt * 20);

    // ---- grip / deslot (racing lanes only)
    if (c.mode === 'race') {
      const k2 = T.curvature(s);
      const kl = Math.abs(k2 / (1 - k2 * c.d));
      // banked sections (new circuits only) give a modest, predictable grip bonus to everyone
      const r = (c.v * c.v * kl) / (GRIP * T.gripScale(s));
      c.latRatio = r;
      if (r > 1) c.slip += ((r - 1) * 3 + 0.2) * dt; else c.slip = Math.max(0, c.slip - 2.5 * dt);
      const target = Math.max(0, Math.min(1, (r - 0.8) / 0.2)) * 0.6 + c.slip * 0.8;
      c.wobble += (target - c.wobble) * Math.min(1, dt * 10);
      if (c.slip >= 1) this.deslot(c);
    } else { c.latRatio = 0; c.wobble *= 0.9; c.slip = 0; }

    // out of fuel
    if (c.fuel <= 0 && c.mode === 'race' && c.v < 0.4) {
      c.mode = 'tow'; c.towT = 0; this.leaveSqueeze(c); c.laneReq = false; c.pitReq = false;
      if (c.change) { c.laneSide = c.change.to; c.change = null; }
      this.emit({ type: 'tow', car: c });
      this.pmsg(c, 'msg.outOfFuel', 'bad');
    }
    this.laps(c);
  }

  laps(c: Car): void {
    const prog = c.u - T.FINISH_S;
    const cr = prog >= 0 ? Math.floor(prog / T.L) + 1 : 0;
    while (c.crossed < cr) {
      c.crossed++;
      if (c.crossed >= 2 && !c.finished) {
        const lt = this.raceTime - c.lapStart;
        c.lapStart = this.raceTime;
        c.lapsDone = c.crossed - 1;
        c.lastLap = lt;
        const best = c.bestLap === 0 || lt < c.bestLap;
        if (best) c.bestLap = lt;
        this.emit({ type: 'lap', car: c, time: lt, best });
        if (c.lapsDone >= LAPS) {
          c.finished = true; c.finishTime = this.raceTime; c.laneReq = false; c.pitReq = false; c.pitPlan = false;
          const pos = this.cars.filter((o) => o.finished).length;
          this.emit({ type: 'finish', car: c, pos });
        } else if (c.isPlayer && c.lapsDone === LAPS - 1) this.pmsg(c, 'msg.finalLap', 'good');
      }
    }
  }

  leaveSqueeze(c: Car): void { const i = this.squeezeQ.indexOf(c); if (i >= 0) this.squeezeQ.splice(i, 1); }

  occupies(c: Car, side: number): boolean {
    if (c.mode !== 'race') return false;
    if (c.change) return true;
    return Math.sign(c.laneSide) === side;
  }

  laneClear(c: Car, to: number): boolean {
    const s = this.s(c);
    for (const o of this.cars) {
      if (o === c || !this.occupies(o, to)) continue;
      const g = T.gapS(s, this.s(o));
      const front = T.CAR_LEN + 0.5 + Math.max(0, c.v - o.v) * 0.45;
      const back = T.CAR_LEN + 0.5 + Math.max(0, o.v - c.v) * 0.55;
      if (g < front && g > -back) return false;
    }
    return true;
  }

  mergeBlocked(c: Car): boolean {
    const s = this.s(c);
    for (const o of this.cars) {
      if (o === c || o.mode !== 'race' || o.v < 1) continue;
      if (!(o.change || o.laneSide < 0)) continue;
      const g = T.gapS(s, this.s(o));
      if (g < 2.5 && g > -(3 + o.v * 0.75)) return true;
    }
    return false;
  }

  bayFree(j: number, self: Car): boolean {
    return !this.cars.some((o) => o !== self && o.bay === j && (o.mode === 'bayIn' || o.mode === 'service' || o.mode === 'bayOut'));
  }

  tryBay(c: Car, s: number): void {
    for (let j = 0; j < T.BAYS.length; j++) {
      if (Math.abs(T.gapS(s, T.BAYS[j])) < T.BAY_HALF && this.bayFree(j, c)) { this.enterBay(c, j); return; }
    }
  }

  /** first free bay still ahead of s in the pit lane; -1 if none */
  pickBay(c: Car, s: number): number {
    for (let j = 0; j < T.BAYS.length; j++) {
      if (T.gapS(s, T.BAYS[j]) > -0.45 && this.bayFree(j, c)) return j;
    }
    return -1;
  }

  /** fuel the AI needs to reach the flag from here, planned at a realistic burn rate */
  fuelToFinish(c: Car, s: number): number {
    const lapsLeft = LAPS - c.lapsDone;
    return (lapsLeft * T.L - T.ahead(T.FINISH_S, s)) * fuelRate() * PLAN_BURN;
  }

  enterBay(c: Car, j: number): void {
    c.mode = 'bayIn'; c.bay = j; c.bayT = 0; c.v = 0; c.serviceT = 0; c.fuelAtBay = c.fuel;
    c.pitStops++;
    if (!c.isPlayer) c.refuelTarget = Math.min(1, Math.max(0.3, this.fuelToFinish(c, this.s(c)) + rnd(0.06, 0.2)));
  }

  stepBay(c: Car, dt: number, input: Input): void {
    const bs = T.BAYS[c.bay];
    const s = this.s(c);
    c.v = 0; c.yawOff *= 0.8; c.wobble *= 0.9;
    if (!c.isPlayer || c.finished) c.throttle = 0; else c.throttle += ((input.up ? 1 : 0) - c.throttle) * Math.min(1, dt * 6);
    if (c.mode === 'bayIn') {
      c.bayT = Math.min(1, c.bayT + dt / 0.45);
      c.u += T.gapS(s, bs) * Math.min(1, dt * 10);
      c.d = T.PIT_D + (T.BAY_D - T.PIT_D) * T.smooth(c.bayT);
      c.yawOff = -Math.sin(c.bayT * Math.PI) * 0.5;
      if (c.bayT >= 1) { c.mode = 'service'; c.serviceT = 0; if (c.isPlayer) this.pmsg(c, 'msg.refuelling', 'info'); }
    } else if (c.mode === 'service') {
      c.serviceT += dt;
      c.penalty = Math.max(0, c.penalty - dt);
      if (c.serviceT > 0.4) c.fuel = Math.min(1, c.fuel + REFUEL_RATE * dt);
      let wantGo: boolean;
      if (c.isPlayer && !c.finished) wantGo = input.up && c.serviceT > 0.5;
      else wantGo = c.fuel >= c.refuelTarget || c.fuel >= 1;
      c.waitingClear = false;
      if (wantGo && c.penalty <= 0) {
        const blocked = this.cars.some((o) => o !== c && (o.mode === 'pitlane') && Math.abs(T.gapS(s, this.s(o))) < 2.2);
        if (blocked) c.waitingClear = true;
        else { c.mode = 'bayOut'; c.bayT = 0; c.pitPlan = false; }
      }
    } else {
      c.bayT = Math.min(1, c.bayT + dt / 0.4);
      c.d = T.BAY_D + (T.PIT_D - T.BAY_D) * T.smooth(c.bayT);
      c.yawOff = Math.sin(c.bayT * Math.PI) * 0.5;
      if (c.bayT >= 1) { c.mode = 'pitlane'; c.v = 0; c.d = T.PIT_D; c.yawOff = 0; c.serviced = true; }
    }
  }

  deslot(c: Car): void {
    const s = this.s(c);
    const p = T.point(s, c.d);
    const k = T.curvature(s);
    const hd = p.h + c.yawOff;
    const outx = Math.sin(p.h) * Math.sign(k || 1), outy = -Math.cos(p.h) * Math.sign(k || 1);
    c.off = {
      x: p.x, y: p.y,
      z: T.surfZ(s, c.d), vz: 2.5 + c.v * 0.12,
      vx: Math.cos(hd) * c.v * 0.5 + outx * c.v * 0.25,
      vy: Math.sin(hd) * c.v * 0.5 + outy * c.v * 0.25,
      yaw: hd, spin: -(Math.sign(k) || 1) * (5 + c.v * 0.35), t: 0,
      u0: c.u, lane: c.change ? c.change.to : Math.sign(c.laneSide) || 1,
    };
    c.mode = 'off'; c.slip = 0; c.laneReq = false; c.change = null; c.throttle = 0;
    this.leaveSqueeze(c);
    this.emit({ type: 'deslot', car: c });
    this.pmsg(c, 'msg.deslot', 'bad');
  }

  stepOff(c: Car, dt: number): void {
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
    if (o.t > 1.7) {
      // marshal returns the car to the slot just behind where it left
      const u = o.u0 - 1.6;
      const s = T.wrapS(u);
      const d = o.lane * T.laneHalf(s);
      const busy = this.cars.some((x) => x !== c && (x.mode === 'race' || x.mode === 'pitlane') && Math.abs(T.gapS(s, this.s(x))) < 2.4 && Math.abs(x.d - d) < T.CAR_W);
      if (!busy) {
        c.u = u; c.laneSide = o.lane; c.d = d; c.mode = 'race'; c.off = null; c.v = 0; c.recoverT = 1.0; c.yawOff = 0; c.wobble = 0;
        if (c.isPlayer) this.pmsg(c, 'msg.backOn', 'info');
      }
    }
  }

  stepTow(c: Car, dt: number): void {
    c.towT += dt; c.v = 0;
    if (c.towT < 1.6) return;
    let j = this.bayFree(c.bay, c) ? c.bay : -1;
    for (let i = 0; i < T.BAYS.length && j < 0; i++) if (this.bayFree(i, c)) j = i;
    if (j < 0) return;
    const s = this.s(c);
    const dist = T.ahead(s, T.BAYS[j]);
    c.u += dist;
    c.bay = j; c.mode = 'service'; c.serviceT = 0; c.d = T.BAY_D; c.laneSide = -1; c.yawOff = 0;
    c.penalty = 8 + dist / 11; c.pitStops++;
    c.refuelTarget = Math.max(c.refuelTarget, 0.75);
    if (c.isPlayer) this.pmsg(c, 'msg.towPenalty', 'bad', { n: Math.round(c.penalty) });
    this.laps(c);
  }

  // ---------------------------------------------------------------- AI
  ai(c: Car, dt: number): { t: number; b: number } {
    const s = this.s(c);
    c.mistakeT -= dt;
    if (c.mistakeT < 0) { c.skillNow = c.skill * rnd(1.05, 1.09); if (c.mistakeT < -2.5) { c.mistakeT = rnd(20, 45); c.skillNow = c.skill; } }
    let target: number;
    if (c.mode === 'pitlane') {
      target = T.PIT_SPEED;
      if (c.pitPlan) {
        const a = T.gapS(s, T.BAYS[c.bay]);
        const free = this.bayFree(c.bay, c);
        if (a > -0.3) target = Math.min(target, Math.sqrt(2 * 16 * Math.max(0, a - (free ? 0 : 0.8))) + (free ? 0.4 : 0));
      }
    } else {
      const look = s + c.v * 0.16;
      const i0 = Math.floor(T.wrapS(s) / T.PROFILE_STEP) % this.profiles['1'].length;
      const i1 = Math.floor(T.wrapS(look) / T.PROFILE_STEP) % this.profiles['1'].length;
      const prof = (side: number): number => Math.min(this.profiles[String(side)][i0], this.profiles[String(side)][i1]);
      target = c.change ? Math.min(prof(-1), prof(1)) : prof(c.laneSide < 0 ? -1 : 1);
      target *= c.recoverT > 0 ? 0.8 : c.skillNow;
      if (c.finished) target *= 0.55;
    }
    // follow traffic in the same slot
    let nearest: Car | null = null, ng = 1e9;
    for (const o of this.cars) {
      if (o === c || o.mode === 'off' || o.mode === 'tow' || o.mode === 'grid') continue;
      if (Math.abs(o.d - c.d) > T.CAR_W) continue;
      const g = T.gapS(s, this.s(o));
      if (g > 0 && g < ng) { ng = g; nearest = o; }
    }
    if (nearest && ng < 9) target = Math.min(target, nearest.v + 2.2 * (ng - T.CAR_LEN - 0.5));

    // strategy: fuel + lane choice
    if (!c.finished && c.mode === 'race') {
      const lapFuel = T.L * fuelRate() * PLAN_BURN;
      const needFinish = this.fuelToFinish(c, s);
      // plan the stop with two laps of fuel in hand (time to find a switch and reach the pit),
      // and in any case before the last lap's worth is gone
      if (!c.pitPlan && c.fuel < needFinish && (c.fuel < lapFuel * 2.2 || c.fuel < lapFuel * 1.2 + 0.02)) {
        c.pitPlan = true;
        c.refuelTarget = Math.min(1, Math.max(0.3, needFinish + rnd(0.06, 0.2)));
      }
      c.pitReq = c.pitPlan;
      if (!c.change && !c.laneReq && c.changeCooldown <= 0) {
        if (c.pitPlan && c.laneSide > 0) c.laneReq = true;
        else if (!c.pitPlan && nearest && ng < 7 && Math.abs(nearest.d - c.d) < 0.3 && nearest.v < this.profiles['1'][0] * 0.98) c.laneReq = true;
      }
      if (c.laneReq && c.pitPlan && c.laneSide < 0) c.laneReq = false;
    }

    const v = c.v;
    const hold = (COAST + DRAG * v * v) / (ACC * Math.max(0.05, 1 - v / VMAX) + COAST);
    const err = target - v;
    if (err > 0) return { t: Math.min(1, hold + err * 0.7), b: 0 };
    if (err < -1.2) return { t: 0, b: Math.min(1, -err * 0.3) };
    return { t: Math.max(0, hold + err * 0.7), b: 0 };
  }

  // ---------------------------------------------------------------- collisions
  collide(): void {
    const act = this.cars.filter((c) => c.mode === 'race' || c.mode === 'pitlane');
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      if (Math.abs(a.d - b.d) >= T.CAR_W) continue;
      const g = T.gapS(this.s(a), this.s(b));
      if (Math.abs(g) >= T.CAR_LEN) continue;
      let front = g > 0 ? b : a, rear = g > 0 ? a : b;
      const qa = this.squeezeQ.indexOf(a), qb = this.squeezeQ.indexOf(b);
      if (qa >= 0 && qb >= 0) { front = qa < qb ? a : b; rear = front === a ? b : a; }
      const gap = T.gapS(this.s(rear), this.s(front));
      const overlap = T.CAR_LEN - gap;
      if (overlap <= 0) continue;
      rear.u -= overlap * 0.75; front.u += overlap * 0.25;
      const rel = rear.v - front.v;
      if (rel > 0) {
        const vc = (rear.v + front.v) / 2, e = 0.35;
        rear.v = (vc - (e * rel) / 2) * 0.93;
        front.v = (vc + (e * rel) / 2) * 0.97;
        front.slip += rel * 0.015; rear.slip += rel * 0.01;
        if (rel > 0.8 && rear.bumpT <= 0) {
          rear.bumpT = 0.25; front.bumpT = 0.25;
          this.emit({ type: 'bump', car: rear.isPlayer || front.isPlayer ? this.player : rear, power: Math.min(1, rel / 8) });
        }
      }
    }
  }

  pose(c: Car): void {
    if (c.mode === 'off' && c.off) { c.x = c.off.x; c.y = c.off.y; c.h = c.off.yaw; c.z = c.off.z; c.roll *= 0.9; c.pitch *= 0.9; return; }
    const s = this.s(c);
    const p = T.point3(s, c.d);
    const wob = c.wobble > 0.02 ? Math.sin(this.t * 38 + c.idx) * c.wobble * 0.2 : 0;
    const jig = c.bumpT > 0 ? Math.sin(this.t * 70) * c.bumpT * 0.3 : 0;
    c.x = p.x; c.y = p.y; c.h = p.h + c.yawOff + wob + jig; c.z = p.z;
    c.roll = T.rollAt(s); c.pitch = Math.atan(T.slopeZ(s));
  }

  results(): { car: Car; time: number; est: boolean }[] {
    return this.order().map((c) => {
      if (c.finished) return { car: c, time: c.finishTime, est: false };
      const prog = Math.max(1, c.u - T.FINISH_S);
      const remain = LAPS * T.L - prog;
      const avg = prog / Math.max(1, this.raceTime);
      return { car: c, time: this.raceTime + remain / Math.max(4, avg), est: true };
    }).sort((a, b) => a.time - b.time);
  }
}
