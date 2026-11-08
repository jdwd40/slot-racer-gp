import * as T from './track';
import { PitTraffic, PitWait } from './pit';

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

/** rear-end collision judging and stop-and-go penalty tuning */
export const PEN = {
  impactRel: 2.5,      // closing speed (m/s) that makes a rear-end contact a counted offence
  separateGap: 0.4,    // cars must open this much clear slot beyond bumper contact before a fresh impact can count
  minSpeed: 4,         // the following car must be at least this fast (ignores grid shuffles and crawling contact)
  grace: 1.5,          // seconds of immunity after a respawn, pit exit or the start
  cutInWindow: 1.0,    // seconds after completing a lane change in which the changer is blamed for contact from behind
  chainWindow: 0.5,    // seconds after being hit from behind in which a car is not blamed for being pushed into the next one
  stopSeconds: 3,      // stationary time for one stop-and-go
  minEntryDist: 6,     // an entrance closer than this (in the outside lane) is already unreachable
};

/**
 * Service obligations (see docs/penalties.md). A stop-and-go is due by the end of the lap of its first reachable pit entrance;
 * a deferred fuel stop by the end of the next lap. Each obligation may be put back one lap, once, and never past the final lap.
 * A deadline still unmet at its lap's timing-line crossing latches a breach, and the car is disqualified when it finishes.
 */
/** stationary service in a bay before the car may leave: the same time a deferred fuel stop needs to count */
export const SERVICE_READY = 0.5;
/** simulated seconds the field is run on for after the race ends, so every car gets a real result rather than an estimate */
export const RUN_OUT_MAX = 240;
export type CarStatus = 'running' | 'finished' | 'dq' | 'dnf';
export type DqReason = 'deadline' | 'stopGo' | 'fuel';
/** why Defer is not available now, or null when it is */
export type DeferBlock = 'phase' | 'none' | 'pit' | 'held' | 'used' | 'final';
/** where an obligation stands against the lap being raced */
export type DueState = 'none' | 'next' | 'due' | 'overdue' | 'late';

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

/** AI defending tuning */
export const DEF = {
  look: 12,            // a car this close behind is a threat
  closing: -0.3,       // ...if it is at least keeping pace (its speed minus ours)
  clearance: 1.0,      // clear slot (beyond bumper contact) that must remain behind after a block
  reactMargin: 0.8,    // seconds of closing-speed reaction time the attacker must still have after a block
  alongside: 0.3,      // no block when the attacker's nose is within this of our tail (already alongside)
};

export type PersonaId = 'player' | 'aggressive' | 'consistent' | 'tactical';
export interface Persona {
  id: PersonaId;
  skill: number;                       // base fraction of the planned speed the driver actually carries
  grip: number;                        // cornering grip planned with, relative to AI_GRIP
  brake: number;                       // braking decel planned with (higher = brakes later)
  look: number;                        // speed-profile lookahead (seconds)
  thrGain: number; brkGain: number;    // how hard throttle/brake respond to a speed error
  rise: number;                        // throttle ramp rate
  mistakeEvery: [number, number];      // seconds between lapses of concentration
  lapseGrip: number; lapseBrake: number; // during a lapse the driver plans corners with this much more grip / later braking...
  lapseMix: [number, number];          // ...blended in by a random fraction per lapse (over the real grip limit = de-slot)
  lapsePush: number;                   // extra closing speed (m/s) tolerated on the car ahead during a lapse (rear-end risk)
  mistakeDur: number;
  defendProb: number;                  // chance of defending when a threat appears
  react: [number, number];             // reaction delay before acting on a threat
  cooldown: number;                    // seconds between defensive lane changes
  followGain: number;                  // how aggressively the driver closes on a car ahead
  pitEarly: boolean;                   // pit early (within the fuel window) to find clear track
}
export const PERSONAS: Record<PersonaId, Persona> = {
  player:     { id: 'player', skill: 1, grip: 1, brake: 20, look: 0.16, thrGain: 0.7, brkGain: 0.3, rise: 6, mistakeEvery: [20, 45], lapseGrip: 1.2, lapseBrake: 1.1, lapseMix: [0.3, 1], lapsePush: 0, mistakeDur: 2.5, defendProb: 0, react: [0.3, 0.7], cooldown: 7, followGain: 2.2, pitEarly: false },
  aggressive: { id: 'aggressive', skill: 0.925, grip: 1.04, brake: 24, look: 0.13, thrGain: 1.0, brkGain: 0.45, rise: 9, mistakeEvery: [12, 26], lapseGrip: 2.8, lapseBrake: 1.4, lapseMix: [0.4, 1], lapsePush: 4, mistakeDur: 3, defendProb: 0.85, react: [0.2, 0.6], cooldown: 5, followGain: 3.0, pitEarly: false },
  consistent: { id: 'consistent', skill: 0.985, grip: 1.0, brake: 18, look: 0.18, thrGain: 0.5, brkGain: 0.22, rise: 5, mistakeEvery: [45, 90], lapseGrip: 1.15, lapseBrake: 1.05, lapseMix: [0.3, 1], lapsePush: 0.5, mistakeDur: 2, defendProb: 0.35, react: [0.5, 1.0], cooldown: 9, followGain: 2.0, pitEarly: false },
  tactical:   { id: 'tactical', skill: 0.965, grip: 1.03, brake: 20, look: 0.16, thrGain: 0.7, brkGain: 0.3, rise: 6, mistakeEvery: [25, 50], lapseGrip: 1.3, lapseBrake: 1.1, lapseMix: [0.3, 1], lapsePush: 1.5, mistakeDur: 2.5, defendProb: 0.6, react: [0.3, 0.7], cooldown: 7, followGain: 2.2, pitEarly: true },
};

export type Mode = 'grid' | 'race' | 'pitlane' | 'bayIn' | 'service' | 'bayOut' | 'off' | 'tow';

export interface OffState { x: number; y: number; vx: number; vy: number; yaw: number; spin: number; t: number; z: number; vz: number; u0: number; lane: number; }

export interface Car {
  idx: number; name: string; color: number; isPlayer: boolean;
  u: number; v: number; laneSide: number;
  change: { from: number; to: number; s0: number; s1: number } | null;
  laneReq: boolean;
  /** lane routing and pit entry: the car will route outside and enter at the next entrance. A routing state, never a debt */
  pitReq: boolean;
  /** pitReq exists only because of a stop-and-go (no fuel reason): serving it ends the request */
  pitPenaltyOnly: boolean;
  /** optional fuel stop the player asked for with Pit. Never a debt by itself: cancelling or skipping it costs nothing */
  fuelReq: boolean;
  /** committed (deferred) fuel stop, due by the end of this lap; 0 when none is owed */
  fuelDue: number;
  /** stop-and-go due by the end of this lap while sgOwed > 0; 0 when none is owed */
  sgDue: number;
  /** the stop-and-go owed now has used its one deferral */
  sgDeferred: boolean;
  /** approach whose routing a deferral released (-1 none); routing re-arms once the car is past it */
  routeHold: number;
  /** approach at which a manual lane override was last used (-1 none) */
  overAppr: number;
  /** furthest distance ever reached: approaches are counted from it, so reversing or a re-slot never brings one back */
  hiU: number;
  /** latched missed service deadline: nothing clears it, and the car is disqualified at the flag */
  svcBreach: 'stopGo' | 'fuel' | null;
  /** the bay service in progress came from a tow, which is recovery, not a pit visit */
  towSvc: boolean;
  /** terminal result: finished means classified; dq and dnf are never classified */
  status: CarStatus;
  dqReason: DqReason | null;
  /** one-switch manual choice of the inside lane while pit routing is active */
  laneOverride: boolean;
  mode: Mode; d: number; yawOff: number;
  throttle: number; brake: number;
  fuel: number; slip: number; latRatio: number; wobble: number;
  off: OffState | null; recoverT: number; towT: number;
  bay: number; bayT: number; serviceT: number; penalty: number; fuelAtBay: number;
  crossed: number; lapsDone: number; lapStart: number; lastLap: number; bestLap: number;
  /** precise (sub-step) race time of the last timing-line crossing */
  lapStartT: number;
  /** true while the current lap has had no de-slot, tow, pit visit or reset */
  lapValid: boolean;
  /** ordered sector checkpoints passed this lap (bitmask) */
  sectors: number;
  finished: boolean; finishTime: number; pitStops: number;
  squeezeHold: boolean; yielding: boolean; waitingClear: boolean;
  skill: number; lapse: number; mistakeT: number; pitPlan: boolean; refuelTarget: number; changeCooldown: number;
  lowFuelWarned: boolean;
  serviced: boolean;
  persona: Persona;
  // rear-end offences: warnings, outstanding stop-and-go, service progress and result-time penalty
  offences: number; sgOwed: number; sgServed: number; sgServing: boolean; timePen: number;
  /** immunity timers: fresh respawn/pit exit/start, recently hit from behind, recently changed lane */
  graceT: number; pushedT: number; cutT: number;
  // AI defending state
  threatIdx: number; reactT: number; defendOk: boolean; defendCooldown: number; defendPending: boolean; defendSw: number;
  // render pose (x, y on the mat; z height; roll/pitch from banking and ramps)
  x: number; y: number; h: number; z: number; roll: number; pitch: number;
  bumpT: number;
  /** reverse gear engaged (player only: AI cars never reverse) */
  revOn: boolean;
  /** stationary Brake hold so far towards engaging reverse (simulation seconds) */
  revHoldT: number;
  /** reverse refused for the rest of the current Brake press (service, countdown, a mode it cannot run in) */
  revLatch: boolean;
  /** furthest u reached before backing up: fixed points short of it are not decided again when driving forward over them */
  revMark: number | null;
  /** shared pit traffic (see docs/pit-queue.md), set by the simulation each step: what an assisted car is held for */
  pitWait: PitWait;
  /** assisted speed cap from the pit queue this step (1e9 when none) */
  pitCap: number;
  /** held by the pit queue or the exit this step: Brake held now cannot arm reverse */
  pitHold: boolean;
  /** must wait at the pit-exit line this step */
  exitHold: boolean;
  /** a departure from the bay was asked for and waits for a safe merge; latched, so it completes without pressing again */
  exitReq: boolean;
  /** this pit visit is for fuel (set at the entrance, from the reasons the car entered with) */
  pitFuel: boolean;
}

export type RaceEvent =
  | { type: 'msg'; text: string; kind: 'info' | 'good' | 'warn' | 'bad'; vars?: Record<string, string | number> }
  | { type: 'bump'; car: Car; power: number }
  | { type: 'deslot'; car: Car }
  | { type: 'switch'; car: Car }
  | { type: 'lap'; car: Car; time: number; best: boolean; valid: boolean; lapsDone: number }
  | { type: 'finish'; car: Car; pos: number }
  | { type: 'dq'; car: Car; reason: DqReason }
  | { type: 'breach'; car: Car; what: 'stopGo' | 'fuel' }
  | { type: 'tow'; car: Car }
  | { type: 'offence'; car: Car; other: Car; n: number; cause: 'rear' | 'cut'; stop: boolean }
  | { type: 'served'; car: Car }
  | { type: 'go' }
  | { type: 'light'; n: number };

export interface Input { up: boolean; down: boolean; }

export interface RaceOpts {
  /** practice: player only, unlimited laps, no fuel consumption */
  practice?: boolean;
  /** player livery colour */
  playerColor?: number;
}

export const DRIVERS: { name: string; color: number; persona: PersonaId }[] = [
  { name: 'YOU', color: 0xffcc1a, persona: 'player' },
  { name: 'Red Comet', color: 0xe8322a, persona: 'aggressive' },
  { name: 'Blue Arrow', color: 0x2a6df0, persona: 'consistent' },
  { name: 'Green Viper', color: 0x22b04b, persona: 'tactical' },
];

const STATUS_RANK: Record<CarStatus, number> = { finished: 0, running: 1, dnf: 2, dq: 3 };

function rnd(a: number, b: number): number { return a + Math.random() * (b - a); }

export class Race {
  cars: Car[] = [];
  phase: 'countdown' | 'racing' | 'done' = 'countdown';
  t = 0; goT = 4.6; raceTime = 0; lights = 0;
  events: RaceEvent[] = [];
  squeezeQ: Car[] = [];
  /** simulation-owned pit-lane reservations and queue order: the HUD reads this, it never keeps its own */
  pit: PitTraffic = new PitTraffic(this);
  profiles: Record<string, Float32Array> = {};
  playerDoneT = -1;
  practice = false;

  constructor(opts: RaceOpts = {}) {
    this.practice = !!opts.practice;
    for (const P of Object.values(PERSONAS)) for (const side of [-1, 1]) {
      this.profiles[`${P.id}:${side}`] = T.buildProfile(side, AI_GRIP * P.grip, VMAX, P.brake);
      this.profiles[`${P.id}:${side}:hot`] = T.buildProfile(side, AI_GRIP * P.grip * P.lapseGrip, VMAX, P.brake * P.lapseBrake);
    }
    this.profiles['-1'] = this.profiles['player:-1']; this.profiles['1'] = this.profiles['player:1'];
    this.goT = this.practice ? 1.6 : 4.0 + rnd(0.5, 1.4);
    // grid: two rows; player in row 2 on the outside lane
    const grid = [
      { di: 1, prog: -1.3, side: 1 }, { di: 2, prog: -1.3, side: -1 },
      { di: 3, prog: -3.9, side: 1 }, { di: 0, prog: -3.9, side: -1 },
    ];
    for (const g of grid) {
      if (this.practice && g.di !== 0) continue;
      const D = DRIVERS[g.di];
      const P = PERSONAS[D.persona];
      const c: Car = {
        idx: g.di, name: D.name, color: g.di === 0 && opts.playerColor !== undefined ? opts.playerColor : D.color, isPlayer: g.di === 0,
        u: T.FINISH_S + g.prog, v: 0, laneSide: g.side, change: null, laneReq: false, pitReq: false, pitPenaltyOnly: false, laneOverride: false,
        fuelReq: false, fuelDue: 0, sgDue: 0, sgDeferred: false, routeHold: -1, overAppr: -1, hiU: T.FINISH_S + g.prog,
        svcBreach: null, towSvc: false, status: 'running', dqReason: null,
        mode: 'grid', d: g.side * T.LANE_HALF, yawOff: 0, throttle: 0, brake: 0,
        fuel: 1, slip: 0, latRatio: 0, wobble: 0, off: null, recoverT: 0, towT: 0,
        bay: g.di, bayT: 0, serviceT: 0, penalty: 0, fuelAtBay: 0,
        crossed: 0, lapsDone: 0, lapStart: 0, lastLap: 0, bestLap: 0, lapStartT: 0, lapValid: true, sectors: 0,
        finished: false, finishTime: 0, pitStops: 0,
        squeezeHold: false, yielding: false, waitingClear: false,
        skill: P.skill, lapse: 0, mistakeT: rnd(P.mistakeEvery[0], P.mistakeEvery[1]), pitPlan: false, refuelTarget: 1, changeCooldown: 0,
        lowFuelWarned: false, serviced: false, persona: P,
        offences: 0, sgOwed: 0, sgServed: 0, sgServing: false, timePen: 0,
        graceT: 0, pushedT: 0, cutT: 0,
        threatIdx: -1, reactT: 0, defendOk: false, defendCooldown: 0, defendPending: false, defendSw: -1,
        x: 0, y: 0, h: 0, z: 0, roll: 0, pitch: 0, bumpT: 0,
        revOn: false, revHoldT: 0, revLatch: false, revMark: null,
        pitWait: null, pitCap: 1e9, pitHold: false, exitHold: false, exitReq: false, pitFuel: false,
      };
      this.cars.push(c);
    }
    this.cars.sort((a, b) => a.idx - b.idx);
    for (const c of this.cars) this.pose(c);
  }

  get player(): Car { return this.cars.find((c) => c.isPlayer) ?? this.cars[0]; }

  s(c: Car): number { return T.wrapS(c.u); }

  emit(e: RaceEvent): void { this.events.push(e); }
  pmsg(c: Car, text: string, kind: 'info' | 'good' | 'warn' | 'bad', vars?: Record<string, string | number>): void {
    if (c.isPlayer) this.emit({ type: 'msg', text, kind, vars });
  }

  requestLane(): void {
    const c = this.player;
    if (c.finished) return;
    // inside the single-file pit lane there is no other lane: nothing moves, and the player is told why
    if (c.mode === 'pitlane' || c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') { this.pmsg(c, 'msg.pitSingleFile', 'warn'); return; }
    if (c.mode !== 'race' && c.mode !== 'grid') return;
    if (this.pitAssist(c)) {
      // queued on the approach with no switch left before the entrance: an override could not be used, so it is not armed
      if (c.pitHold && !c.laneOverride && !this.switchBeforeEntry(c)) {
        this.pmsg(c, this.deferBlock(c) === null ? 'msg.queueNoSwitch' : 'msg.queueNoSwitchFinal', 'warn');
        return;
      }
      c.laneOverride = !c.laneOverride;
      this.pmsg(c, c.laneOverride ? 'msg.routeInside' : 'msg.routeOutside', 'info');
      return;
    }
    if (c.change) return;
    c.laneReq = !c.laneReq;
    this.pmsg(c, c.laneReq ? 'msg.laneReady' : 'msg.laneCancelled', c.laneReq ? 'info' : 'warn');
  }
  requestPit(): void {
    const c = this.player;
    if (c.finished || (c.mode !== 'race' && c.mode !== 'grid')) return;
    if (c.routeHold >= 0 && c.routeHold === this.apprLap(c)) {
      // Pit after a deferral: stop on this approach after all. Deadlines and the used deferral are unchanged
      c.routeHold = -1; this.syncRoute(c);
      this.pmsg(c, 'msg.pitUndefer', 'info');
      return;
    }
    if (c.fuelDue > 0) {
      // a committed fuel stop cannot be toggled away
      this.syncRoute(c);
      this.pmsg(c, 'msg.pitDue', 'warn');
      return;
    }
    if (c.sgOwed > 0) {
      // the stop-and-go cannot be cancelled: P only adds or drops an optional fuel stop that outlives it
      c.fuelReq = !c.fuelReq;
      this.syncRoute(c);
      this.pmsg(c, 'msg.pitRequired', 'warn');
      if (c.fuelReq) this.pmsg(c, 'msg.pitFuelToo', 'info');
      return;
    }
    if (c.pitReq) { this.clearPitIntent(c); this.pmsg(c, 'msg.pitCancelled', 'warn'); return; }
    c.pitReq = true; c.fuelReq = true; c.laneReq = false;
    const outside = c.change ? c.change.to < 0 : c.laneSide < 0;
    this.pmsg(c, outside ? 'msg.pitRequested' : 'msg.pitNeedLane', outside ? 'info' : 'warn');
  }

  /**
   * Defer to next lap (N, or the touch Defer button). Allowed once per obligation while the approach is still avoidable,
   * never on the final lap. An optional fuel request becomes a committed fuel stop due next lap; a stop-and-go due on this
   * approach moves to the next lap's. Routing is released for this approach only and re-arms beyond it.
   */
  requestDefer(): void {
    const c = this.player;
    if (c.finished) return;
    const why = this.deferBlock(c);
    if (why) {
      const msg: Record<DeferBlock, string> = { phase: '', none: 'msg.deferNone', pit: 'msg.deferPit', held: 'msg.deferHeld', used: 'msg.deferUsed', final: 'msg.deferFinal' };
      if (msg[why]) this.pmsg(c, msg[why], 'warn');
      return;
    }
    const k = this.apprLap(c);
    // the planned service route is given up for this approach: its reservations go, the debt stays
    this.pit.releaseAll(c, 'defer');
    if (c.fuelReq) { c.fuelReq = false; c.fuelDue = k + 1; }
    if (c.sgOwed > 0 && c.sgDue <= k) { c.sgDue = k + 1; c.sgDeferred = true; }
    c.routeHold = k;
    this.syncRoute(c);
    this.pmsg(c, 'msg.deferred', 'warn');
  }

  /** Why Defer cannot be used now, or null. Read by the HUD and touch pad as well, so they only offer it when it works. */
  deferBlock(c: Car): DeferBlock | null {
    if (this.practice || this.phase !== 'racing' || c.finished || !c.isPlayer) return 'phase';
    const k = this.apprLap(c);
    const sgNow = c.sgOwed > 0 && c.sgDue <= k;
    const fuelNow = c.fuelDue > 0 && c.fuelDue <= k;
    if (!c.fuelReq && c.sgOwed <= 0 && c.fuelDue <= 0) return 'none';
    if (c.mode === 'off' || c.mode === 'tow') return 'phase';   // nothing to choose until the car is back on the road
    if (c.mode !== 'race') return 'pit';
    if (c.routeHold === k) return 'held';
    if (fuelNow || (sgNow && (c.sgDeferred || c.sgDue < k))) return 'used';
    if (k + 1 > LAPS) return 'final';
    return null;
  }

  /**
   * The pit approach the car is heading for, numbered by lap: the entrance on lap n is approach n. Counted from the furthest
   * distance ever reached, so reversing over the entrance, a re-slot behind it or a pause never brings an approach back.
   */
  apprLap(c: Car): number { return Math.floor((c.hiU - T.PIT_IN0) / T.L) + 1; }

  /** Where an obligation due by the end of lap `due` stands against the lap being raced. */
  dueState(c: Car, due: number): DueState {
    if (due <= 0) return 'none';
    if (due > LAPS) return 'late';
    const lap = Math.max(1, c.crossed);
    return due > lap ? 'next' : due === lap ? 'due' : 'overdue';
  }

  /** Another car is standing in (or rolling through) the stop-and-go box. */
  boxBusy(c: Car): boolean {
    if (this.pit.box >= 0 && this.pit.box !== c.idx) return true;
    return this.cars.some((o) => o !== c && o.mode === 'pitlane' && Math.abs(T.gapS(this.s(o), T.PEN_S)) < T.PEN_HALF);
  }

  /** Pit routing applies: only the player is assisted, the AI makes its own lane decisions. */
  pitAssist(c: Car): boolean { return c.isPlayer && c.pitReq && !c.finished; }

  /**
   * Player routing from the visit reasons: any owed stop or fuel request routes to the next entrance, except the approach
   * a deferral released. Never clears a debt; an optional request the car still holds keeps routing on.
   */
  syncRoute(c: Car): void {
    if (!c.isPlayer) return;
    if (c.finished) { c.pitReq = false; c.fuelReq = false; c.pitPenaltyOnly = false; c.laneOverride = false; return; }
    const k = this.apprLap(c);
    if (c.routeHold >= 0 && c.routeHold < k) c.routeHold = -1;
    if (c.routeHold === k) { c.pitReq = false; c.laneOverride = false; }
    else if ((c.sgOwed > 0 || c.fuelDue > 0 || c.fuelReq) && !c.pitReq) { c.pitReq = true; c.laneReq = false; }
    c.pitPenaltyOnly = c.pitReq && c.sgOwed > 0 && !c.fuelReq && c.fuelDue <= 0;
  }

  /** A lane switch still lies ahead of the car before the coming pit entrance. */
  switchBeforeEntry(c: Car): boolean {
    const s = this.s(c), entry = T.ahead(s, T.PIT_IN0);
    return T.SWITCHES.some((sw) => { const a = T.ahead(s, sw.s0); return a > 0.05 && a < entry; });
  }

  /** Routing state only: debts (stop-and-go, committed fuel stop) are untouched. */
  clearPitIntent(c: Car): void { c.pitReq = false; c.pitPenaltyOnly = false; c.fuelReq = false; c.laneOverride = false; }

  /** What pit routing will do at the next switch; null when no routing applies on the road. Drives the switch logic, HUD and arrows. */
  nextRoute(c: Car): { to: number; stay: boolean; override: boolean } | null {
    if ((c.mode !== 'race' && c.mode !== 'grid') || !this.pitAssist(c)) return null;
    const to = c.laneOverride ? 1 : -1;
    const side = (c.change ? c.change.to : c.laneSide) < 0 ? -1 : 1;
    return { to, stay: to === side, override: c.laneOverride };
  }

  /** Classified finishers by time, then cars still running by distance, then DNF, then DQ. `finished` alone never classifies. */
  order(): Car[] {
    return [...this.cars].sort((a, b) => {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r) return r;
      if (a.status === 'finished') return a.finishTime + a.timePen - (b.finishTime + b.timePen);
      return b.u - a.u;
    });
  }

  /**
   * Once the player is done, run the rest of the field on to the flag (no rendering) so every car gets a real result.
   * Anything still running after RUN_OUT_MAX is a DNF. Only finish and DQ events are kept from the run.
   */
  runOut(maxSec = RUN_OUT_MAX): void {
    const keep = this.events.length;
    const idle: Input = { up: false, down: false };
    for (let t = 0; t < maxSec && this.cars.some((c) => c.status === 'running'); t += 1 / 120) this.step(1 / 120, idle);
    for (const c of this.cars) if (c.status === 'running') { c.status = 'dnf'; c.finished = true; }
    this.events = [...this.events.slice(0, keep), ...this.events.slice(keep).filter((e) => e.type === 'finish' || e.type === 'dq')];
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
        for (const c of this.cars) { c.mode = 'race'; c.graceT = PEN.grace; }
      }
    } else {
      this.raceTime += dt;
    }
    // pit traffic is decided from where every car is before any of them moves, so array order never grants priority
    this.pit.update();
    for (const c of this.cars) this.stepCar(c, dt, input);
    this.collide();
    for (const c of this.cars) this.pose(c);
    if (this.player.finished && this.playerDoneT < 0) this.playerDoneT = this.t;
    if (this.playerDoneT >= 0 && this.t - this.playerDoneT > 3.2 && this.phase !== 'done') { this.phase = 'done'; this.runOut(); }
  }

  // ---------------------------------------------------------------- car step
  stepCar(c: Car, dt: number, input: Input): void {
    c.bumpT = Math.max(0, c.bumpT - dt);
    c.recoverT = Math.max(0, c.recoverT - dt);
    c.changeCooldown = Math.max(0, c.changeCooldown - dt);
    c.graceT = Math.max(0, c.graceT - dt); c.pushedT = Math.max(0, c.pushedT - dt); c.cutT = Math.max(0, c.cutT - dt);
    c.defendCooldown = Math.max(0, c.defendCooldown - dt);
    if (c.isPlayer) this.reverseControl(c, dt, input);
    if (c.mode === 'off') { this.stepOff(c, dt); return; }
    if (c.mode === 'tow') { this.stepTow(c, dt); return; }
    if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') { this.stepBay(c, dt, input); return; }

    // ---- control
    let thrIn = 0, brkIn = 0;
    if (c.mode !== 'grid' || c.isPlayer) {
      // braking takes priority: with both held, Throttle does nothing
      if (c.isPlayer && !c.finished) { brkIn = input.down ? 1 : 0; thrIn = input.up && !input.down ? 1 : 0; }
      else if (c.mode !== 'grid') { const a = this.ai(c, dt); thrIn = a.t; brkIn = a.b; }
    }
    const rise = c.isPlayer ? 4.5 : c.persona.rise, fall = 9;
    c.throttle += Math.max(-fall * dt, Math.min(rise * dt, thrIn - c.throttle));
    c.brake = brkIn;
    if (c.mode === 'grid') return;
    const thr = c.fuel > 0 ? c.throttle : 0;

    // ---- longitudinal dynamics
    const v0 = c.v;
    const revDrive = c.revOn && brkIn > 0;
    if (revDrive) {
      // reverse gear: back up gently to the cap (a car still rolling forward is braked to rest first)
      c.v = v0 > 0 ? Math.max(0, v0 - BRAKE * dt) : Math.max(-REV_CAP, v0 - REV.acc * dt);
    } else if (v0 < 0) {
      // rolling backwards without reverse drive: Brake or Throttle stop it, releasing coasts it to rest; never a sign flip in one step
      c.v = Math.min(0, v0 + (thrIn > 0 || brkIn > 0 ? BRAKE : COAST) * dt);
    } else {
      const drive = thr * ACC * Math.max(0, 1 - v0 / VMAX);
      const decel = (1 - thr) * COAST + brkIn * BRAKE + DRAG * v0 * v0;
      c.v = Math.max(0, v0 + (drive - decel) * dt);
    }

    // ---- automatic caps (pit limiter, squeeze priority, pit exit yield)
    const s0 = this.s(c);
    let cap = 1e9;
    c.squeezeHold = false; c.yielding = false;
    if (c.mode === 'pitlane') {
      cap = T.PIT_SPEED;
      // the pit exit: wait at the line while the outside lane is not clear or another car is merging
      if (c.exitHold) {
        const a = T.gapS(s0, T.PIT_OUT0);
        cap = Math.min(cap, Math.sqrt(2 * 25 * Math.max(0, a - 0.4)));
        c.yielding = true;
      }
    }
    // shared pit queue: a stopping gap behind whatever is ahead on the car's own path
    cap = Math.min(cap, c.pitCap);
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
    let ds = (c.v * dt) / Math.max(0.3, 1 - k * c.d);
    if (ds < 0) ds = this.reverseTravel(c, s0, ds);
    const prevD = c.d;
    const u0 = c.u;
    c.u += ds;
    const s = this.s(c);
    const crossed = (x: number): boolean => { const g = T.gapS(s0, x); return ds > 0 && g >= 0 && g < ds; };
    /** crossed on new ground: after backing up, points short of the furthest position already reached are not decided again */
    const fresh = (x: number): boolean => crossed(x) && (c.revMark === null || u0 + T.gapS(s0, x) >= c.revMark);

    // fuel: burn follows distance travelled in either direction, so backing up can never refill the tank
    // cars on their cool-down lap after the flag no longer burn fuel (they would otherwise run dry and get towed)
    if (!c.finished && !this.practice) c.fuel = Math.max(0, c.fuel - Math.abs(c.v) * dt * fuelRate() * (0.5 + 0.7 * (revDrive ? 1 : thr)));
    if (c.isPlayer && !c.lowFuelWarned && c.fuel < LOW_FUEL && !c.finished) { c.lowFuelWarned = true; this.pmsg(c, 'msg.lowFuel', 'bad'); }
    if (c.fuel > LOW_FUEL + 0.05) c.lowFuelWarned = false;

    if (c.mode === 'race') {
      // an owed stop keeps routing on, including after a pit exit or tow that did not serve it; a deferral releases one approach
      if (c.isPlayer) this.syncRoute(c);
      // lane switches
      for (const sw of T.SWITCHES) {
        if (!fresh(sw.s0)) continue;
        const route = this.nextRoute(c);
        if (route) { c.laneReq = !route.stay && !c.change; if (route.override) c.overAppr = this.apprLap(c); c.laneOverride = false; }
        if (c.laneReq && !c.change) {
          c.laneReq = false;
          const to = c.laneSide > 0 ? -1 : 1;
          const defensive = c.defendPending; c.defendPending = false;
          const clear = this.laneClear(c, to);
          if (defensive) { this.dbg.defendReq++; if (!clear) this.dbg.defendNoGap++; else if (!this.defendSafe(c, to, sw)) this.dbg.defendUnsafe++; else this.dbg.defendDone++; }
          if (clear && (!defensive || this.defendSafe(c, to, sw))) {
            c.change = { from: c.laneSide, to, s0: sw.s0, s1: sw.s1 };
            c.changeCooldown = 3;
            if (defensive) { c.defendCooldown = c.persona.cooldown; c.defendSw = sw.s0; }
            this.emit({ type: 'switch', car: c });
            this.pmsg(c, 'msg.laneGo', 'good');
          } else {
            this.pmsg(c, route && !route.override ? 'msg.routeBlocked' : 'msg.laneBlocked', 'bad');
          }
        }
      }
      if (c.change) {
        const len = c.change.s1 - c.change.s0;
        const p = T.ahead(c.change.s0, s);
        if (p >= len && p < len + 20) { c.laneSide = c.change.to; c.change = null; c.cutT = PEN.cutInWindow; }
        else c.laneSide = c.change.from + (c.change.to - c.change.from) * T.smooth(p / len);
      }
      // pit entry: a physical forward crossing. Entering clears the routing and an optional request, never a debt
      if (crossed(T.PIT_IN0)) {
        let entered = false;
        if (c.pitReq) {
          if (c.laneSide < 0 && !c.change && !c.finished) {
            c.mode = 'pitlane'; c.lapValid = false; entered = true;
            c.pitFuel = c.fuelReq || c.fuelDue > 0 || c.pitPlan;
            this.clearPitIntent(c);
            this.pmsg(c, c.sgOwed > 0 ? 'msg.pitInPen' : 'msg.pitIn', 'info');
          } else {
            if (!c.isPlayer) c.pitReq = false; // the AI decides again every step; a player's request waits for the next lap
            this.pmsg(c, 'msg.pitMissed', 'bad');
          }
        }
        // an optional fuel request driven past on a manual override is a deferral: it is now owed by the end of the next lap.
        // Judged once per approach, so backing up and passing again changes nothing
        if (!entered && c.isPlayer && c.fuelReq && !c.finished && !this.practice && fresh(T.PIT_IN0)) {
          const k = Math.round((u0 + T.gapS(s0, T.PIT_IN0) - T.PIT_IN0) / T.L);
          if (c.overAppr === k && k + 1 <= LAPS) { c.fuelReq = false; c.fuelDue = k + 1; this.syncRoute(c); this.pmsg(c, 'msg.fuelOverride', 'bad'); }
        }
      }
      // squeeze priority queue
      if (crossed(T.SQ_ENTRY) && !this.squeezeQ.includes(c)) this.squeezeQ.push(c);
      if (crossed(T.SQ_EXIT)) this.leaveSqueeze(c);
      c.d = c.laneSide * T.laneHalf(s);
    } else if (c.mode === 'pitlane') {
      c.d = T.pitD(s);
      this.servePenalty(c, s, dt);
      if (crossed(T.PIT_OUT1)) {
        c.mode = 'race'; c.laneSide = -1; c.d = -T.LANE_HALF; c.serviced = false; c.graceT = PEN.grace; c.pitFuel = false;
        this.pit.release('exit', c, 'done');
        if (c.sgOwed > 0 && !c.finished) this.pmsg(c, 'msg.penStillOwed', 'bad');
      }
      // a bay is only captured nearly stopped: never while reversing past it, nor while the queue holds the car (unless braking there)
      else if (Math.abs(c.v) < 0.7 && !c.revOn && c.isPlayer && !c.serviced && !c.sgServing && (!c.pitHold || input.down)) this.tryBay(c, s);
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
    // backing up, the car still faces forward
    const yo = ds > 1e-5 ? Math.atan2(c.d - prevD, ds) : ds < -1e-5 ? Math.atan2(prevD - c.d, -ds) : 0;
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
    if (c.fuel <= 0 && c.mode === 'race' && Math.abs(c.v) < 0.4) {
      c.mode = 'tow'; c.towT = 0; c.lapValid = false; this.leaveSqueeze(c); c.laneReq = false; this.clearPitIntent(c);
      this.pit.releaseAll(c, 'terminal');
      if (c.change) { c.laneSide = c.change.to; c.change = null; }
      this.emit({ type: 'tow', car: c });
      this.pmsg(c, 'msg.outOfFuel', 'bad');
    }
    // ordered sector checkpoints (quarter, half, three-quarter distance from the timing line)
    for (let i = 0; i < 3; i++) {
      if (fresh(T.wrapS(T.FINISH_S + (T.L * (i + 1)) / 4))) {
        if (c.sectors === (1 << i) - 1) c.sectors |= 1 << i; else c.lapValid = false;
      }
    }
    if (c.u > c.hiU) c.hiU = c.u;
    this.laps(c, dt, ds, s0);
    if (c.revMark !== null && c.u >= c.revMark) c.revMark = null;
  }

  // ---------------------------------------------------------------- reverse (player only)
  /** Why reverse cannot engage now, or null. Checked by speed magnitude and position, never by direction alone. */
  reverseBlock(c: Car): 'phase' | 'mode' | 'change' | 'fuel' | 'service' | 'assist' | null {
    if (this.phase !== 'racing' || c.finished) return 'phase';
    if (c.mode !== 'race' && c.mode !== 'pitlane') return 'mode';
    // held by the pit queue or the exit: automatic control, so Brake held now never backs away when the hold ends
    if (c.pitHold) return 'assist';
    if (c.change) return 'change';
    if (c.fuel <= 0) return 'fuel';
    // standing (or arriving) in the penalty box with a stop owed is service: Brake must keep the car still for all of it
    if (c.mode === 'pitlane' && c.sgOwed > 0 && Math.abs(T.gapS(this.s(c), T.PEN_S)) < T.PEN_HALF) return 'service';
    return null;
  }

  /**
   * Reverse engagement from the Brake hold, in simulation time. Releasing Brake ends it; Throttle cancels it and restarts the hold;
   * any reason it cannot run latches it off until Brake is released and pressed again, so finishing a service with Brake held never backs away.
   */
  reverseControl(c: Car, dt: number, input: Input): void {
    if (!input.down || c.finished) { c.revOn = false; c.revHoldT = 0; c.revLatch = false; return; }
    const block = this.reverseBlock(c);
    const still = Math.abs(c.v) < REV.still;
    if (block === 'change') {
      // a committed lane change is never reversed: an attempt is refused for this press, with a word why
      c.revOn = false;
      if (c.revLatch || !still) { c.revHoldT = 0; return; }
      c.revHoldT += dt;
      if (c.revHoldT >= REV.engage) { c.revHoldT = 0; c.revLatch = true; this.pmsg(c, 'msg.revChange', 'warn'); }
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
  clearReverse(): void { for (const c of this.cars) { c.revOn = false; c.revHoldT = 0; c.revLatch = false; } }

  /** One step of backward travel: a pit-lane car stops at the upstream end of the pit path. Backing up leaves the squeeze queue and voids the lap. */
  reverseTravel(c: Car, s0: number, ds: number): number {
    if (c.mode === 'pitlane') {
      const room = Math.max(0, T.gapS(REV_PIT_MIN, s0));
      if (-ds >= room) { ds = -room; c.v = 0; }
    }
    if (ds < 0) {
      c.lapValid = false;
      if (c.revMark === null) c.revMark = c.u;
      this.leaveSqueeze(c);
    }
    return ds;
  }

  /** Lap counting. dt/ds/s0 describe the step just taken so the crossing time can be interpolated to sub-step precision. */
  laps(c: Car, dt = 0, ds = 0, s0 = 0): void {
    const prog = c.u - T.FINISH_S;
    const cr = prog >= 0 ? Math.floor(prog / T.L) + 1 : 0;
    while (c.crossed < cr) {
      c.crossed++;
      // precise crossing time: fraction of this step travelled before the line
      let tCross = this.raceTime;
      if (ds > 1e-6 && dt > 0) { const frac = Math.max(0, Math.min(1, T.ahead(s0, T.FINISH_S) / ds)); tCross = this.raceTime - dt * (1 - frac); }
      const valid = c.lapValid && c.sectors === 7 && c.crossed >= 2;
      if (c.crossed >= 2 && !c.finished) {
        const lt = tCross - c.lapStartT;
        c.lapStart = this.raceTime;
        c.lapsDone = c.crossed - 1;
        c.lastLap = lt;
        const best = valid && (c.bestLap === 0 || lt < c.bestLap);
        if (best) c.bestLap = lt;
        this.emit({ type: 'lap', car: c, time: lt, best, valid, lapsDone: c.lapsDone });
        // service earlier in this step (box, bay) is already applied; deadlines are judged before the finish is classified
        const prior = c.svcBreach;
        const flag = c.lapsDone >= LAPS && !this.practice;
        this.serviceDeadline(c, flag);
        if (flag) this.finishCar(c, tCross, prior);
        else if (c.isPlayer && c.lapsDone === LAPS - 1 && !this.practice) this.pmsg(c, 'msg.finalLap', 'good');
      }
      c.lapStartT = tCross; c.lapValid = true; c.sectors = 0;
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

  /**
   * The outside lane is not clear for a pit-exit merge: a car standing, crawling or backing up in the merge's conflict zone
   * (or too close beyond it to stop behind), a car backing towards it, or traffic passing alongside.
   */
  mergeBlocked(c: Car): boolean {
    const s = this.s(c);
    const zone = T.PIT_OUT1 - T.PIT_OUT0 + T.CAR_LEN + 2;
    for (const o of this.cars) {
      if (o === c || o.mode !== 'race') continue;
      if (!(o.change || o.laneSide < 0)) continue;
      const z = T.gapS(T.PIT_OUT0, this.s(o));
      if (o.v < 1 && z > 1.5 && z < zone + Math.max(0, -o.v) * 1.5) return true;
      // a car backing up counts however slow: it is coming towards the merge from ahead
      if (o.v >= 0 && o.v < 1) continue;
      const g = T.gapS(s, this.s(o));
      if (g < 2.5 + Math.max(0, -o.v) * 1.5 && g > -(3 + Math.max(0, o.v) * 0.75)) return true;
    }
    return false;
  }

  /** Nobody else is in bay j or has reserved it. */
  bayFree(j: number, self: Car): boolean { return this.pit.bayAvail(j, self); }

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
    this.holdBay(c, j);
    c.mode = 'bayIn'; c.bay = j; c.bayT = 0; c.v = 0; c.serviceT = 0; c.fuelAtBay = c.fuel; c.towSvc = false; c.exitReq = false;
    c.pitStops++;
    if (!c.isPlayer) c.refuelTarget = Math.min(1, Math.max(0.3, this.fuelToFinish(c, this.s(c)) + rnd(0.06, 0.2)));
  }

  /** The car's bay reservation is bay j: a reservation it held for another bay moves here. */
  holdBay(c: Car, j: number): void {
    const had = this.pit.bayOf(c);
    if (had === j) return;
    if (had >= 0) this.pit.release(`bay${had}`, c, 'moved');
    this.pit.grant(`bay${j}`, c);
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
      // a committed fuel stop counts once the car has stood in its bay for the departure-ready time (a full tank is fine; a tow is not a visit)
      if (c.fuelDue > 0 && !c.towSvc && c.serviceT > SERVICE_READY) { c.fuelDue = 0; this.pmsg(c, 'msg.fuelDone', 'good'); }
      // a departure request is latched: it waits in the bay for a safe merge and then goes, once, without pressing again
      let wantGo: boolean;
      if (c.isPlayer && !c.finished) wantGo = input.up && c.serviceT > SERVICE_READY;
      else wantGo = c.fuel >= c.refuelTarget || c.fuel >= 1;
      if (wantGo && c.penalty <= 0) c.exitReq = true;
      // the merge is granted by the shared pit traffic at the start of a step, from where everyone is
      if (c.exitReq && this.pit.merges[c.bay] === c.idx) { c.mode = 'bayOut'; c.bayT = 0; c.pitPlan = false; c.waitingClear = false; }
    } else {
      c.bayT = Math.min(1, c.bayT + dt / 0.4);
      c.d = T.BAY_D + (T.PIT_D - T.BAY_D) * T.smooth(c.bayT);
      c.yawOff = Math.sin(c.bayT * Math.PI) * 0.5;
      if (c.bayT >= 1) {
        c.mode = 'pitlane'; c.v = 0; c.d = T.PIT_D; c.yawOff = 0; c.serviced = true; c.exitReq = false;
        // back in the through lane: the merge and the bay are released, once
        this.pit.release(`merge${c.bay}`, c, 'done'); this.pit.release(`bay${c.bay}`, c, 'done');
      }
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
    c.mode = 'off'; c.slip = 0; c.laneReq = false; c.laneOverride = false; c.change = null; c.throttle = 0; c.lapValid = false;
    this.leaveSqueeze(c); this.pit.releaseAll(c, 'terminal');
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
        c.u = u; c.laneSide = o.lane; c.d = d; c.mode = 'race'; c.off = null; c.v = 0; c.recoverT = 1.0; c.graceT = PEN.grace; c.yawOff = 0; c.wobble = 0;
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
    this.holdBay(c, j);
    c.bay = j; c.mode = 'service'; c.serviceT = 0; c.d = T.BAY_D; c.laneSide = -1; c.yawOff = 0; c.revMark = null; c.towSvc = true; c.exitReq = false;
    if (c.u > c.hiU) c.hiU = c.u;
    c.penalty = 8 + dist / 11; c.pitStops++;
    c.refuelTarget = Math.max(c.refuelTarget, 0.75);
    if (c.isPlayer) this.pmsg(c, 'msg.towPenalty', 'bad', { n: Math.round(c.penalty) });
    this.laps(c);
  }

  // ---------------------------------------------------------------- AI
  ai(c: Car, dt: number): { t: number; b: number } {
    const s = this.s(c);
    const P = c.persona;
    // lapses of concentration: for a while the driver brakes later and carries more speed into corners
    // (how much is rolled per lapse; an aggressive driver's lapse can exceed the real grip limit)
    c.mistakeT -= dt;
    if (c.mistakeT < 0 && c.lapse === 0) c.lapse = rnd(P.lapseMix[0], P.lapseMix[1]);
    if (c.mistakeT < -P.mistakeDur) { c.mistakeT = rnd(P.mistakeEvery[0], P.mistakeEvery[1]); c.lapse = 0; }
    let target: number;
    if (c.mode === 'pitlane') {
      target = T.PIT_SPEED;
      if (c.sgOwed > 0) {
        // stop-and-go first: roll to a halt inside the penalty box and wait there
        const a = T.gapS(s, T.PEN_S);
        if (a > -T.PEN_HALF) target = Math.min(target, Math.sqrt(2 * 16 * Math.max(0, a)));
      } else if (c.pitPlan) {
        const a = T.gapS(s, T.BAYS[c.bay]);
        const free = this.bayFree(c.bay, c);
        if (a > -0.3) target = Math.min(target, Math.sqrt(2 * 16 * Math.max(0, a - (free ? 0 : 0.8))) + (free ? 0.4 : 0));
      }
    } else {
      const look = s + c.v * P.look;
      const n = this.profiles['1'].length;
      const i0 = Math.floor(T.wrapS(s) / T.PROFILE_STEP) % n;
      const i1 = Math.floor(T.wrapS(look) / T.PROFILE_STEP) % n;
      const prof = (side: number): number => {
        const pr = this.profiles[`${P.id}:${side}`];
        const a = Math.min(pr[i0], pr[i1]);
        if (c.lapse === 0) return a;
        const hot = this.profiles[`${P.id}:${side}:hot`];
        return a + (Math.min(hot[i0], hot[i1]) - a) * c.lapse;
      };
      target = c.change ? Math.min(prof(-1), prof(1)) : prof(c.laneSide < 0 ? -1 : 1);
      target *= c.recoverT > 0 ? 0.8 : c.skill;
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
    if (nearest && ng < 9) target = Math.min(target, nearest.v + P.followGain * (ng - T.CAR_LEN - 0.5) + c.lapse * P.lapsePush);

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
      // a tactical driver who will have to stop anyway pits early to escape traffic (never an extra stop)
      if (P.pitEarly && !c.pitPlan && c.fuel < needFinish && c.fuel < lapFuel * 3.4 && nearest && ng < 6 && nearest.v < c.v + 1) {
        c.pitPlan = true;
        c.refuelTarget = Math.min(1, Math.max(0.3, needFinish + rnd(0.06, 0.2)));
      }
      const mustPit = c.pitPlan || c.sgOwed > 0;
      c.pitReq = mustPit;
      if (!c.change && !c.laneReq && c.changeCooldown <= 0) {
        if (mustPit && c.laneSide > 0) c.laneReq = true;
        else if (!mustPit && nearest && ng < 7 && Math.abs(nearest.d - c.d) < 0.3 && nearest.v < this.profiles['1'][0] * 0.98) c.laneReq = true;
      }
      if (c.laneReq && mustPit && c.laneSide < 0) c.laneReq = false;
      if (!mustPit) this.defend(c, dt, s);
    }

    const v = c.v;
    const hold = (COAST + DRAG * v * v) / (ACC * Math.max(0.05, 1 - v / VMAX) + COAST);
    const err = target - v;
    if (err > 0) return { t: Math.min(1, hold + err * P.thrGain), b: 0 };
    if (err < -1.2) return { t: 0, b: Math.min(1, -err * P.brkGain) };
    return { t: Math.max(0, hold + err * P.thrGain), b: 0 };
  }

  /** Defensive lane choice: block a closing attacker in the other lane at the next switch, after a reaction delay. */
  defend(c: Car, dt: number, s: number): void {
    const P = c.persona;
    let threat: Car | null = null, tg = 1e9;
    for (const o of this.cars) {
      if (o === c || o.mode !== 'race' || o.finished) continue;
      const g = T.gapS(this.s(o), s); // how far o is behind us
      if (g <= 0 || g > DEF.look || g >= tg) continue;
      if (o.v - c.v < DEF.closing) continue;
      tg = g; threat = o;
    }
    if (!threat) { c.threatIdx = -1; return; }
    if (threat.idx !== c.threatIdx) {
      // new threat: decide whether to defend at all, and how quickly we notice
      c.threatIdx = threat.idx; c.reactT = rnd(P.react[0], P.react[1]); c.defendOk = Math.random() < P.defendProb;
    }
    c.reactT -= dt;
    if (c.reactT > 0 || !c.defendOk || c.defendCooldown > 0 || c.change || c.laneReq) return;
    const theirLane = threat.change ? threat.change.to : Math.sign(threat.laneSide) || 1;
    const myLane = Math.sign(c.laneSide) || 1;
    if (theirLane === myLane) return;                       // already covering their lane: hold it
    if (tg < T.CAR_LEN + DEF.alongside) return;              // alongside: never cut across
    const sw = this.nextSwitch(c);
    if (sw.s0 === c.defendSw) return;                        // one defensive move per straight
    if (T.ahead(s, sw.s0) > 25) return;                      // no switch soon: nothing to decide yet
    c.laneReq = true; c.defendPending = true;
  }

  /** Extra safety for a defensive block: the attacker keeps reaction time, nobody is alongside, no pit-bound car is cut off. */
  defendSafe(c: Car, to: number, sw: T.Switch): boolean {
    const s = this.s(c);
    // never block inside the squeeze or the pit-entry approach
    if (T.inRange(sw.s0, T.SQ_ENTRY - 2, T.SQ_EXIT) || T.inRange(sw.s1, T.SQ_ENTRY - 2, T.SQ_EXIT)) return false;
    if (to < 0 && T.ahead(sw.s1, T.PIT_IN0) < 10) return false;
    for (const o of this.cars) {
      if (o === c || o.mode !== 'race') continue;
      const g = T.gapS(this.s(o), s); // o behind us by g
      if (g > 0 && g < 30 && o.pitReq && to < 0 && T.ahead(s, T.PIT_IN0) < 40) return false;
      if (!this.occupies(o, to) && !(o.change && o.change.to === to)) continue;
      if (Math.abs(g) < T.CAR_LEN + DEF.alongside) return false;
      if (g > 0 && g < T.CAR_LEN + DEF.clearance + Math.max(0, o.v - c.v) * DEF.reactMargin + o.v * 0.08) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- penalties
  /** continuous stationary countdown inside the penalty box; moving early resets it */
  servePenalty(c: Car, s: number, dt: number): void {
    if (c.sgOwed <= 0) { c.sgServing = false; return; }
    const inBox = Math.abs(T.gapS(s, T.PEN_S)) < T.PEN_HALF;
    if (inBox && Math.abs(c.v) < REV.still) {
      c.sgServing = true;
      c.sgServed += dt;
      if (c.sgServed >= c.sgOwed) {
        c.sgOwed = 0; c.sgServed = 0; c.sgServing = false; c.sgDue = 0; c.sgDeferred = false;
        this.endPenaltyRoute(c);
        this.emit({ type: 'served', car: c });
        this.pmsg(c, 'msg.penServed', 'good');
      }
    } else if (c.sgServing && Math.abs(c.v) > 0.3) {
      c.sgServing = false; c.sgServed = 0;
      this.pmsg(c, 'msg.penReset', 'bad');
    }
  }

  /** The stop-and-go is settled: a request that existed only for it ends, a chosen fuel stop carries on. */
  endPenaltyRoute(c: Car): void { if (c.pitPenaltyOnly) this.clearPitIntent(c); }

  /**
   * The first approach this car can still be served at: the entrance physically ahead of it (or the one after, if that is
   * out of reach), never earlier than its current approach, so reversing back over an entrance gains no lap.
   */
  firstReachableAppr(c: Car): number {
    const next = Math.round((c.u + T.ahead(this.s(c), T.PIT_IN0) - T.PIT_IN0) / T.L);
    return Math.max(this.apprLap(c), this.reachablePitEntry(c) ? next : next + 1);
  }

  /** can this car still make the upcoming pit entrance (outside lane, or a switch to it, with room to spare)? */
  reachablePitEntry(c: Car): boolean {
    const s = this.s(c);
    const dist = T.ahead(s, T.PIT_IN0);
    const outside = c.change ? c.change.to < 0 : c.laneSide < 0;
    if (outside) return dist > PEN.minEntryDist;
    return T.SWITCHES.some((sw) => { const a = T.ahead(s, sw.s0); return a > 1.5 && a + T.SWITCH_LEN + 3 < dist; });
  }

  /**
   * The timing-line crossing that ends a lap: an obligation due by the end of that lap and still owed either uses its one
   * deferral (a stop-and-go only, and only if another lap remains) or latches the missed-deadline breach. The breach is
   * shown at once and kept for good; later service can settle the stop but never the breach.
   */
  serviceDeadline(c: Car, flag: boolean): void {
    if (this.practice) return;
    const ended = c.crossed - 1;
    if (c.sgOwed > 0 && c.sgDue > 0 && c.sgDue <= ended) {
      if (!c.sgDeferred && c.crossed <= LAPS) {
        c.sgDeferred = true; c.sgDue = c.crossed;
        this.pmsg(c, c.crossed === LAPS ? 'msg.sgLastLapFinal' : 'msg.sgLastLap', 'bad');
      } else this.breach(c, 'stopGo', flag);
    }
    if (c.fuelDue > 0 && c.fuelDue <= ended) this.breach(c, 'fuel', flag);
  }

  breach(c: Car, what: 'stopGo' | 'fuel', flag: boolean): void {
    if (c.svcBreach) return;
    c.svcBreach = what;
    this.emit({ type: 'breach', car: c, what });
    if (!flag) this.pmsg(c, what === 'stopGo' ? 'msg.breachSg' : 'msg.breachFuel', 'bad');
  }

  /**
   * The car's final forward timing-line crossing: a latched breach, an unserved stop-and-go or an unserved committed fuel stop
   * disqualifies it, once. Otherwise it is classified on finish time plus any time penalties it already carries.
   */
  finishCar(c: Car, tCross: number, prior: 'stopGo' | 'fuel' | null): void {
    c.finished = true; c.finishTime = tCross; c.laneReq = false; this.clearPitIntent(c); c.pitPlan = false; c.routeHold = -1;
    const reason: DqReason | null = prior ? 'deadline' : c.sgOwed > 0 ? 'stopGo' : c.fuelDue > 0 ? 'fuel' : c.svcBreach ? 'deadline' : null;
    if (reason) {
      c.status = 'dq'; c.dqReason = reason;
      this.emit({ type: 'dq', car: c, reason });
      this.pmsg(c, `msg.dq.${reason}`, 'bad');
      return;
    }
    c.status = 'finished';
    const pos = this.cars.filter((o) => o.status === 'finished' && o.finishTime + o.timePen <= c.finishTime + c.timePen).length;
    this.emit({ type: 'finish', car: c, pos });
  }

  /** one attributed offence: warning, final warning, then stop-and-go (plus more stop time while one is outstanding) */
  offence(c: Car, other: Car, cause: 'rear' | 'cut'): void {
    c.offences++;
    const stop = c.offences >= 3;
    if (stop) {
      // a fresh stop-and-go is due on the first entrance the car can still make; more stop time keeps the existing deadline
      const first = c.sgOwed <= 0;
      if (first) { c.sgDue = this.firstReachableAppr(c); c.sgDeferred = false; c.sgServed = 0; }
      c.sgOwed += PEN.stopSeconds;
      if (c.isPlayer) {
        if (first) c.routeHold = -1;
        this.syncRoute(c);
        // awarded after the last entrance it could be served at: still owed, and the consequence is shown now
        if (first && c.sgDue > LAPS && !c.finished && !this.practice) this.pmsg(c, 'msg.sgLate', 'bad');
      }
    }
    this.emit({ type: 'offence', car: c, other, n: c.offences, cause, stop });
  }

  /** Judge a fresh rear-end impact (rear closing on front at rel m/s) and attribute it. */
  judge(rear: Car, front: Car, rel: number): void {
    if (rear.mode !== 'race' || front.mode !== 'race') return;          // pit-lane shuffles don't count
    if (Math.abs(rear.z - front.z) > 1) return;                            // different bridge levels (cannot touch anyway)
    if (rear.v < PEN.minSpeed) return;                                     // crawling / grid contact
    if (rear.graceT > 0 || front.graceT > 0 || rear.recoverT > 0 || front.recoverT > 0) return; // respawn / pit exit / start overlaps
    rear.lapValid = false; front.lapValid = false;                         // collision-affected laps never set records
    const pushed = rear.pushedT > 0;                                       // we were just hit from behind ourselves
    front.pushedT = PEN.chainWindow;                                       // front may now be shoved into the next car
    if (pushed) return;
    const cutIn = front.change !== null || front.cutT > 0;                 // front moved into our lane just now
    if (cutIn) this.offence(front, rear, 'cut'); else this.offence(rear, front, 'rear');
  }

  // ---------------------------------------------------------------- collisions
  /** pairs currently in contact (indexed a.idx*4+b.idx, a<b): a new incident needs clear separation first */
  touching: boolean[] = [];
  /** diagnostics for tuning: defensive decisions made / executed / rejected for safety / rejected for no gap */
  dbg = { defendReq: 0, defendDone: 0, defendUnsafe: 0, defendNoGap: 0 };

  collide(): void {
    const act = this.cars.filter((c) => c.mode === 'race' || c.mode === 'pitlane');
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const key = Math.min(a.idx, b.idx) * 4 + Math.max(a.idx, b.idx);
      const g = T.gapS(this.s(a), this.s(b));
      if (Math.abs(a.d - b.d) >= T.CAR_W || Math.abs(g) >= T.CAR_LEN + PEN.separateGap) { this.touching[key] = false; continue; }
      if (Math.abs(g) >= T.CAR_LEN) continue;
      let front = g > 0 ? b : a, rear = g > 0 ? a : b;
      const qa = this.squeezeQ.indexOf(a), qb = this.squeezeQ.indexOf(b);
      if (qa >= 0 && qb >= 0) { front = qa < qb ? a : b; rear = front === a ? b : a; }
      const gap = T.gapS(this.s(rear), this.s(front));
      const overlap = T.CAR_LEN - gap;
      if (overlap <= 0) continue;
      // a car backing into the one behind takes the whole correction, so no car is ever shoved backwards by it
      if (front.v < 0) front.u += overlap;
      else { rear.u -= overlap * 0.75; front.u += overlap * 0.25; }
      const rel = rear.v - front.v;
      const backing = front.v < 0 || rear.v < 0;
      const fresh = !this.touching[key];
      this.touching[key] = true;
      // contact with a reversing car is resolved but never judged as a rear-end offence
      if (fresh && rel > PEN.impactRel && !backing) this.judge(rear, front, rel);
      if (rel > 0) {
        const vc = (rear.v + front.v) / 2, e = 0.35;
        rear.v = (vc - (e * rel) / 2) * 0.93;
        front.v = (vc + (e * rel) / 2) * 0.97;
        // the reverser stops against the car it backed into, and neither car is sent backwards (forward contacts never go negative)
        if (backing) { rear.v = Math.max(0, rear.v); front.v = Math.max(0, front.v); }
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

  /**
   * Result rows in order. Only `finished` rows are classified and carry a time. A DQ or DNF never gets one. A car still running
   * (only mid-race; the run-out settles everyone before the results screen) shows an estimate marked `est`, never a classification.
   */
  results(): { car: Car; time: number; est: boolean; status: CarStatus }[] {
    return this.order().map((c) => {
      if (c.status === 'finished') return { car: c, time: c.finishTime + c.timePen, est: false, status: c.status };
      if (c.status !== 'running') return { car: c, time: NaN, est: false, status: c.status };
      const prog = Math.max(1, c.u - T.FINISH_S);
      const remain = LAPS * T.L - prog;
      const avg = prog / Math.max(1, this.raceTime);
      return { car: c, time: this.raceTime + remain / Math.max(4, avg) + c.timePen, est: true, status: c.status };
    });
  }
}
