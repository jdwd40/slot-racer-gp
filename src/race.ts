import * as T from './track';
import { PitTraffic, PitWait } from './pit';
import { outOfTraffic } from './traffic';
import { raceLength, type RaceLength, type RaceLengthId } from './raceLength';
import { carSetup, isSetupId, DEFAULT_SETUP, type CarSetup, type SetupId } from './carSetup';
import { DebriefCollector, type DriverDebrief } from './debrief';
import { BRAKE, PEN, SERVICE_READY } from './raceConst';
import * as stall from './stall';
import * as away from './away';
import * as autoSg from './autoStopGo';
import { AUTO, SG_STOP } from './autoStopGo';
import * as rev from './reverse';
import { REV, REV_CAP } from './reverse';
import * as squeeze from './squeeze';
import { SQUEEZE } from './squeeze';
import * as recover from './recover';

// No lap count lives here: each Race takes its target from an allowlisted preset (src/raceLength.ts, #132), as `race.targetLaps`.
// Drive, top speed, drag and grip are not here either: each car has its own setup preset (src/carSetup.ts, #133, Car.setup).
// ACC, VMAX, DRAG, GRIP and AI_GRIP are Balanced's values, kept for the rules that are the same for every car (a coasting
// retired car, the wording of tuning comments) and for tests; no car's dynamics read them. Coasting and braking are shared.
const BAL = carSetup(DEFAULT_SETUP);
export const ACC = BAL.acc, VMAX = BAL.vmax, COAST = 9, DRAG = BAL.drag;
/** BRAKE (shared braking), PEN and SERVICE_READY: src/raceConst.ts (#141), a leaf the subsystem modules read them from */
export { BRAKE, PEN, SERVICE_READY } from './raceConst';
export const AI_GRIP = BAL.aiGrip;   // cornering speeds the Balanced AI aims for
export const GRIP = BAL.grip;        // real grip of the slot for a Balanced car (well above the AI's target, so cars stick)
/** Fuel burned per unit of track for a lap of length L. L is required: a default read from the displayed track would let it reach a race. */
export function fuelRate(L: number): number { return 1 / (L * 7.4); }
export const REFUEL_RATE = 0.2;           // tank per second
export const LOW_FUEL = 0.2;
/** burn multiplier the AI plans with: near full throttle (0.5 + 0.7*thr) plus a safety margin */
const PLAN_BURN = 1.25;

/**
 * Service obligations (see docs/penalties.md). A stop-and-go is due by the end of the lap of its first reachable pit entrance;
 * a deferred fuel stop by the end of the next lap. Each obligation may be put back one lap, once, and never past the final lap.
 * A deadline still unmet at its lap's timing-line crossing latches a breach, and the car is disqualified when it finishes.
 * SERVICE_READY, the stationary service in a bay before the car may leave, is in src/raceConst.ts (#141).
 */
/**
 * simulated seconds the field is run on for after the race ends, so every car gets a real result rather than an estimate:
 * Standard's (and Sprint's) run-on; each preset has its own (RaceLength.runOutS), so Endurance has twice this
 */
export const RUN_OUT_MAX = 240;
/** shown for the last human finish (or terminal result) before the race closes and the rest of the field is run on */
export const CLOSE_DELAY = 3.2;
/**
 * Per-driver race status: `running` is still racing; `finished` is classified; `dq` and `dnf` are terminal and never classified.
 * Every car ends in exactly one terminal status, set once.
 */
export type CarStatus = 'running' | 'finished' | 'dq' | 'dnf';
export type DqReason = 'deadline' | 'stopGo' | 'fuel';
/** why a car was not classified: the finish window or race time limit ran out, or the field run-on did */
export type DnfReason = 'window' | 'timeout' | 'runout' | 'retired';
/** Stable driver identity for a whole race (a room seat or the solo driver). Never an array position. */
export type DriverId = string;
export type Control = 'human' | 'ai';
/** One race entry. `slot` (0–3) is the grid position, race number and own bay; omitted, the lowest free slot is used. */
export interface RosterEntry {
  id: DriverId; control: Control; slot?: number; name?: string; color?: number; persona?: PersonaId;
  /** the car's setup preset (#133): an allowlisted id only (an unknown one throws). Default Balanced, for humans and AI alike */
  setup?: SetupId;
}
/** Random source in [0, 1). Each race owns one, so seeding one race never couples it to another. */
export type Rng = () => number;
/** Throttle that holds speed v against coasting and drag with a car's own drive (#133: per setup, never a global). */
export function holdThrottle(S: CarSetup, v: number): number {
  return (COAST + S.drag * v * v) / (S.acc * Math.max(0.05, 1 - v / S.vmax) + COAST);
}
/** Small seeded generator (mulberry32) for reproducible races. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The single-player adapter's driver: the one human in solo races and practice. */
export const SOLO_ID: DriverId = 'solo';
/** why Defer is not available now, or null when it is */
export type DeferBlock = 'phase' | 'none' | 'pit' | 'held' | 'used' | 'final';
/** where an obligation stands against the lap being raced */
export type DueState = 'none' | 'next' | 'due' | 'overdue' | 'late';

/** Player reverse gear (REV, REV_CAP, REV_PIT_MIN): src/reverse.ts (#141). */
export { REV, REV_CAP, REV_PIT_MIN } from './reverse';
/** Automatic stop-and-go and bay visits for the player (AUTO, SG_STOP): src/autoStopGo.ts (#141). */
export { AUTO, SG_STOP } from './autoStopGo';
/**
 * What automatic pit service is doing for the player, for the HUD (null when nothing applies). Stop-and-go: armed, entry,
 * queued, serving. Fuel visit (docs/auto-bay.md): entry, queued, then `bay` (driving to the car's own bay), `bayWait` (its
 * bay or the way in is occupied), `refuel` (settling or a penalty still running: departure not available yet), `release`
 * (Throttle still held from before departure was ready), `ready` (a fresh Throttle press leaves), `exit` (departure latched,
 * waiting for a clear merge). Both end with `leaving`, driven to the pit exit.
 */
export type SgPhase = 'armed' | 'entry' | 'queued' | 'serving' | 'leaving' | 'deferred' | 'bay' | 'bayWait' | 'refuel' | 'release' | 'ready' | 'exit' | null;
/** why a departure from the bay is not available yet: the minimum stationary service, or a tow penalty still running */
export type DepartBlock = 'settle' | 'penalty';

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

/** A retired car's way off the track: rolling to a stop, then parked (see Race.retire()). null for every other car. */
export type RetireState = 'coast' | 'parked' | null;
/** Longest a retired car rolls before it is parked: src/recover.ts (#141), with de-slot, parking and the tow. */
export { RETIRE_COAST_MAX } from './recover';

/** Stopped-on-track recovery (#69): src/stall.ts (#141), re-exported for the HUD, tests and the room server. */
export { STALL, stallCountPaused } from './stall';
/** When a car held for an away driver may rejoin traffic (#74, #77): src/away.ts (#141). */
export { AWAY_REJOIN } from './away';
/** The squeeze priority queue's braking and margins (#110): src/squeeze.ts (#141). */
export { SQUEEZE } from './squeeze';

export interface OffState { x: number; y: number; vx: number; vy: number; yaw: number; spin: number; t: number; z: number; vz: number; u0: number; lane: number; }

export interface Car {
  /** stable driver ID from the roster: events, snapshots, actions and the local view address the car by it */
  id: DriverId;
  /** grid slot (0–3), fixed for the race; it is also the car's number in pit reservations */
  idx: number; name: string; color: number;
  /** controlled by a person (any of up to four), not the AI. Says nothing about whose screen this is */
  human: boolean;
  /** race number painted on the car and on its bay's pit board */
  num: number;
  /**
   * The car's own service bay for the whole race: its participant slot, fixed at the start. Grants, captures and tows only
   * ever use this bay; an occupied bay means waiting, never another team's bay. `bay` is the bay currently held or used.
   */
  bayHome: number;
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
  /** the tow in progress started in the pit lane: the car is moved to the nearest free bay, never round a lap */
  towPit: boolean;
  /**
   * The car was retired (its driver left or never came back, see `retire()`): `coast` while it rolls to a stop with no one
   * driving it, then `parked` in its own bay, off the racing line and out of collisions for the rest of the race.
   */
  retire: RetireState;
  /** simulation seconds the retired car has been coasting (bounded by RETIRE_COAST_MAX) */
  retireT: number;
  /** terminal result: finished means classified; dq and dnf are never classified */
  status: CarStatus;
  dqReason: DqReason | null;
  dnfReason: DnfReason | null;
  /** one-switch manual choice of the inside lane while pit routing is active */
  laneOverride: boolean;
  mode: Mode; d: number; yawOff: number;
  throttle: number; brake: number;
  fuel: number; slip: number; latRatio: number; wobble: number;
  off: OffState | null; recoverT: number; towT: number;
  bay: number; bayT: number; serviceT: number; penalty: number; fuelAtBay: number;
  crossed: number; lapsDone: number; lastLap: number; bestLap: number;
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
  /**
   * The car's setup preset (#133), fixed for the race: its drive, top speed, drag, grip and the AI's planned cornering all
   * come from here, never from a global. A frozen preset, shared by every car with that setup; nothing can change it.
   */
  readonly setup: CarSetup;
  // rear-end offences: warnings, outstanding stop-and-go, service progress and result-time penalty
  offences: number; sgOwed: number; sgServed: number; sgServing: boolean; timePen: number;
  /** immunity timers: fresh respawn/pit exit/start, recently hit from behind, recently changed lane */
  graceT: number; pushedT: number; cutT: number;
  /** the hit that set pushedT was itself waived (grace / re-slot, #76): the onward contact it causes is waived the same way */
  pushedFree: boolean;
  // AI defending state
  threatIdx: number; reactT: number; defendOk: boolean; defendCooldown: number; defendPending: boolean; defendSw: number;
  // render pose (x, y on the mat; z height; roll/pitch from banking and ramps)
  x: number; y: number; h: number; z: number; roll: number; pitch: number;
  bumpT: number;
  /** reverse gear engaged (human cars only: AI cars never reverse) */
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
  /**
   * left the pit lane inside the squeeze (circuit-4) and not yet in the squeeze queue: it joins at its physical place once
   * every car that would be behind it can stop behind it (joinSqueezeWaiting). Server-side only, like the queue (#110)
   */
  sqWait: boolean;
  /** a departure from the bay was asked for and waits for a safe merge; latched, so it completes without pressing again */
  exitReq: boolean;
  /** this pit visit is for fuel (set at the entrance, from the reasons the car entered with) */
  pitFuel: boolean;
  /** automatic stop-and-go state shown to the player (set each step) */
  sgPhase: SgPhase;
  /** automatic control owns the pedals this step: Throttle and Brake do not move the car */
  sgCtl: boolean;
  /** approach the automatic entry was taken over on (-1 none) */
  sgCommit: number;
  /** cruise speed latched at the takeover: the controller never accelerates the car above it on the road */
  sgVc: number;
  /** driven to the pit exit, where normal control returns: after a penalty-only stop, or after leaving the bay */
  sgLeave: boolean;
  /** Throttle as last seen in the bay: a departure needs a fresh press, so a pedal held while arriving must be released first */
  upPrev: boolean;
  /** stopped-on-track episode (#69): simulation seconds counted towards recovery, 0 when none is running */
  stallT: number;
  /** distance driven without a break under the car's own Throttle at STALL.goV or faster: a resumption at STALL.goDist */
  stallRun: number;
  /**
   * The running count was paused on this step because the car is backing up (stallCountPaused, from the full-precision speed);
   * false whenever no count runs. Set by Race.stallUpdate() only. Null only on an online mirror whose server's snapshots do
   * not carry it (older than #119): the HUD then falls back to the rule on the snapshot's rounded speed.
   */
  stallPaused: boolean | null;
  /** recovered off the track (mode `tow`, out of traffic) and waiting for its own bay to be free to be placed in */
  stallHold: boolean;
  /** this bay stay is a stopped-on-track recovery: nothing is refuelled or served, the car may only rejoin (#69 review B1) */
  stallSvc: boolean;
  /**
   * The driver's link is down this step (#74): the room server says so in the step input (`Input.away`) while the seat is in
   * its reconnect hold. Never inferred from anything else, so a replay of the same inputs gives the same race.
   */
  linkAway: boolean;
  /**
   * Held where it stopped while its driver is away (#74): on the racing lane, out of collisions and of everyone's traffic
   * checks, exempt from the stopped-on-track rule. It stays set after the driver is back until no other car overlaps it, so
   * the return never starts with a shunt. Drawn dimmed by every client.
   */
  away: boolean;
  /** simulation seconds a held car has waited to rejoin since its driver came back (#74); 0 while away or in traffic */
  awayWaitT: number;
}

export type MsgKind = 'info' | 'good' | 'warn' | 'bad';
/** Race events. `msg` is personal: it is addressed to one human driver (`to`) and only that driver's view shows it. */
export type RaceEvent =
  | { type: 'msg'; to: DriverId; text: string; kind: MsgKind; vars?: Record<string, string | number> }
  | { type: 'bump'; car: Car; other: Car; power: number }
  | { type: 'deslot'; car: Car }
  | { type: 'switch'; car: Car }
  | { type: 'lap'; car: Car; time: number; best: boolean; valid: boolean; lapsDone: number }
  | { type: 'finish'; car: Car; pos: number }
  | { type: 'dq'; car: Car; reason: DqReason }
  | { type: 'dnf'; car: Car; reason: DnfReason }
  | { type: 'final' }
  | { type: 'breach'; car: Car; what: 'stopGo' | 'fuel' }
  | { type: 'tow'; car: Car }
  /** a stopped car was moved off the racing lane to its own bay (#69): once per recovery, for every client */
  | { type: 'recover'; car: Car }
  | { type: 'offence'; car: Car; other: Car; n: number; cause: 'rear' | 'cut'; stop: boolean }
  | { type: 'served'; car: Car }
  | { type: 'go' }
  | { type: 'light'; n: number };

/** An event as it goes over the wire: every car reference is the driver's stable ID. */
type Wire<E> = { [K in keyof E]: E[K] extends Car ? DriverId : E[K] };
type Distribute<E> = E extends RaceEvent ? Wire<E> : never;
export type WireEvent = Distribute<RaceEvent>;
/** Serializable form of an event: plain data with driver IDs, no object references. */
export function wireEvent(e: RaceEvent): WireEvent {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) out[k] = v && typeof v === 'object' && 'id' in v && 'idx' in v ? (v as Car).id : v && typeof v === 'object' ? { ...v } : v;
  return out as WireEvent;
}

/** One driver in an authoritative snapshot: plain values keyed by driver ID, nothing a client could not rebuild a view from. */
export interface CarSnapshot {
  id: DriverId; slot: number; control: Control; name: string; color: number; num: number; bay: number;
  /**
   * #133: the car's setup preset and its tuning, fixed for the race (static fields, sent once per race). A current server
   * always sends both; an older one sends neither, which the mirror reads as Balanced (all an older server races)
   */
  setup?: SetupId; tuning?: number;
  status: CarStatus; dqReason: DqReason | null; dnfReason: DnfReason | null; finished: boolean;
  mode: Mode; u: number; v: number; d: number; laneSide: number; change: { from: number; to: number; s0: number; s1: number } | null;
  x: number; y: number; z: number; h: number; roll: number; pitch: number; yawOff: number; wobble: number; off: OffState | null;
  throttle: number; brake: number; fuel: number;
  crossed: number; lapsDone: number; lastLap: number; bestLap: number; lapStartT: number; lapValid: boolean; finishTime: number; pitStops: number;
  offences: number; sgOwed: number; sgServed: number; sgServing: boolean; timePen: number; svcBreach: 'stopGo' | 'fuel' | null;
  laneReq: boolean; pitReq: boolean; fuelReq: boolean; fuelDue: number; sgDue: number; sgDeferred: boolean; routeHold: number; laneOverride: boolean;
  revOn: boolean; sgPhase: SgPhase; sgCtl: boolean; pitWait: PitWait; exitReq: boolean; bayInUse: number;
  serviceT: number; penalty: number; towT: number; recoverT: number; bumpT: number;
  /** view state a client's HUD and arrows read (approach numbering, queue holds, bay targeting, fresh-throttle cue) */
  hiU: number; squeezeHold: boolean; pitHold: boolean; towSvc: boolean; pitFuel: boolean; serviced: boolean; upPrev: boolean;
  /** stopped-on-track recovery (#69): the warning's count and the wait for the bay. Additive, so optional for older snapshots */
  stallT?: number; stallHold?: boolean; stallSvc?: boolean;
  /**
   * #119: the race core's own pause decision for a running count (Car.stallPaused), sent exactly so the HUD never re-derives it
   * from the rounded speed. A current server always sends it (true or false); an older one omits it, which the mirror reads
   * as unknown (null), never as false
   */
  stallPaused?: boolean;
  /** held while its driver reconnects (#74): present (true) only while held, so older snapshots and quiet cars omit it */
  away?: boolean;
}
/** Authoritative race state: JSON-safe (no cycles, no Infinity or NaN, no browser objects), with driver IDs for every reference. */
export interface RaceSnapshot {
  v: 1; track: string; laps: number; practice: boolean;
  phase: Race['phase']; t: number; raceTime: number; goT: number; lights: number; firstFlagT: number;
  /** null when unlimited */
  finishWindow: number | null; timeLimit: number | null;
  cars: CarSnapshot[];
  pit: { box: DriverId | null; exit: DriverId | null; bays: (DriverId | null)[]; merges: (DriverId | null)[]; order: DriverId[] };
  /** highest applied action sequence number per human driver (a null-prototype table: every driver ID is an own key) */
  lastSeq: Record<DriverId, number>;
  final: Standing[] | null;
}

/**
 * Held pedals for one human driver. Missing or released means neutral, for that driver only. `away`: the room server has
 * lost this driver's link (peer gone, or no controls for LINK_AWAY_MS) and is holding the seat for a reconnect (#74). It is
 * part of the input, never guessed by the race, so replaying the same inputs replays the same race. An away driver's
 * pedals are neutral whatever they say.
 */
export interface Input { up: boolean; down: boolean; away?: true; }
/** Held inputs for this step, per human driver. A driver absent from the map is neutral. */
export type Controls = Readonly<Record<DriverId, Input | undefined>>;
export const NEUTRAL: Input = Object.freeze({ up: false, down: false });
/** An away driver's input as the race applies it: pedals released, link down (#74). */
export const AWAY: Input = Object.freeze({ up: false, down: false, away: true as const });
/** Sequenced one-shot driver actions (Lane, Pit, Defer). Reverse and bay departure come from the held pedals. */
export type ActionType = 'lane' | 'pit' | 'defer';
export interface DriverAction { driver: DriverId; seq: number; type: ActionType; }
export type ActResult = 'queued' | 'stale' | 'unknown';

export interface RaceOpts {
  /** practice: one driver, unlimited laps, no fuel consumption */
  practice?: boolean;
  /**
   * race-length preset (#132): the lap target and the default bounded-end limits, fixed for this race. Default Standard (13
   * laps). Only an allowlisted preset id is accepted (an unknown one throws); there is no way to ask for an arbitrary count.
   * Practice never ends on a lap count, whatever the preset.
   */
  length?: RaceLengthId;
  /** livery colour of the slot-0 human in the default solo roster */
  playerColor?: number;
  /** entries (1–4 cars, any mix of human and AI). Default: the solo human in slot 0 and three AI (practice: the solo human only) */
  roster?: RosterEntry[];
  /** circuit id or context. Default: the displayed track at construction */
  track?: string | T.Track;
  /** random source. Default: Math.random, read at each call */
  rng?: Rng;
  /** seed for a private seeded random source (ignored when `rng` is given) */
  seed?: number;
  /** seconds after the first car takes the flag before every car still running is terminally classified. Default: unlimited with one human, the preset's finishWindowS (Standard 90 s) with more */
  finishWindow?: number;
  /** race-time limit (seconds of racing) after which every car still running is terminally classified. Default: unlimited with one human, the preset's timeLimitS (Standard 1200 s) with more */
  timeLimit?: number;
  /**
   * How the AI field is finished once every human is terminal. 'sync' (default, the browser): run on synchronously at close,
   * up to RUN_OUT_MAX seconds in one call. 'live' (the room server): the race stays in 'racing' and keeps stepping normally
   * until every car is terminal (finish window and time limit still apply), so no single update blocks for the run-on.
   * 'watch' (the browser's local race with spectating, #135): like 'live', the field keeps racing step by step after every
   * human is terminal, so it can be watched at normal speed; it closes once every car is terminal, and never runs longer than
   * the synchronous run-on would (the preset's runOutS after CLOSE_DELAY, then the cars still running are classified
   * 'runout', exactly as 'sync' does). skipRunOut() finishes it at once through the same synchronous run-on. The steps, and so
   * the result, are the same as 'sync': only when they are simulated differs.
   */
  runOn?: 'sync' | 'live' | 'watch';
}

/** A terminal, authoritative result row: only cars with a terminal status ever appear, and never an estimated time. */
export interface Standing {
  id: DriverId; slot: number; control: Control;
  /** classified position (1-based) for finishers, null for DQ and DNF */
  pos: number | null;
  status: Exclude<CarStatus, 'running'>;
  /** finish time plus time penalties (seconds), null when not classified */
  time: number | null;
  laps: number; bestLap: number; pitStops: number; timePen: number;
  dqReason: DqReason | null; dnfReason: DnfReason | null;
}

/** participant slots: the slot is the car's identity (idx), its race number and its own bay (bayHome) */
export const DRIVERS: { name: string; color: number; persona: PersonaId; num: number; tag: string }[] = [
  { name: 'YOU', color: 0xffcc1a, persona: 'player', num: 7, tag: 'YOU' },
  { name: 'Red Comet', color: 0xe8322a, persona: 'aggressive', num: 11, tag: 'RED' },
  { name: 'Blue Arrow', color: 0x2a6df0, persona: 'consistent', num: 3, tag: 'BLUE' },
  { name: 'Green Viper', color: 0x22b04b, persona: 'tactical', num: 24, tag: 'GREEN' },
];

const STATUS_RANK: Record<CarStatus, number> = { finished: 0, running: 1, dnf: 2, dq: 3 };

/** Validate a roster and give every entry its slot. Throws on anything a race cannot be built from. */
export function resolveRoster(roster: RosterEntry[]): (RosterEntry & { slot: number })[] {
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > DRIVERS.length) throw new Error(`roster: 1-${DRIVERS.length} entries`);
  const ids = new Set<string>(), used = new Set<number>();
  for (const e of roster) {
    if (typeof e.id !== 'string' || !e.id) throw new Error('roster: every entry needs a driver id');
    if (ids.has(e.id)) throw new Error(`roster: duplicate driver id ${e.id}`);
    ids.add(e.id);
    if (e.control !== 'human' && e.control !== 'ai') throw new Error(`roster: bad control for ${e.id}`);
    if (e.setup !== undefined && !isSetupId(e.setup)) throw new Error(`roster: unknown setup for ${e.id}`);
    if (e.slot !== undefined) {
      if (!Number.isInteger(e.slot) || e.slot < 0 || e.slot >= DRIVERS.length || used.has(e.slot)) throw new Error(`roster: bad slot for ${e.id}`);
      used.add(e.slot);
    }
  }
  return roster.map((e) => {
    if (e.slot !== undefined) return { ...e, slot: e.slot };
    let k = 0; while (used.has(k)) k++;
    used.add(k);
    return { ...e, slot: k };
  });
}

/**
 * Key of a planned speed profile in Race.profiles: persona, side and whether it is the lapse ('hot') profile. Balanced keeps
 * the keys profiles always had (`player:-1`, `aggressive:1:hot`); another setup's are prefixed with its id (#133).
 */
export function profKey(setup: SetupId, persona: PersonaId, side: number, hot: boolean): string {
  return `${setup === DEFAULT_SETUP ? '' : `${setup}~`}${persona}:${side}${hot ? ':hot' : ''}`;
}

/** The single-player adapter's roster: the solo human in slot 0, AI rivals in the other slots (none in practice). */
export function soloRoster(practice = false): RosterEntry[] {
  const r: RosterEntry[] = [{ id: SOLO_ID, control: 'human', slot: 0 }];
  if (!practice) for (let k = 1; k < DRIVERS.length; k++) r.push({ id: `ai${k}`, control: 'ai', slot: k });
  return r;
}

export class Race {
  cars: Car[] = [];
  phase: 'countdown' | 'racing' | 'done' = 'countdown';
  t = 0; goT = 4.6; raceTime = 0; lights = 0;
  events: RaceEvent[] = [];
  squeezeQ: Car[] = [];
  /** simulation-owned pit-lane reservations and queue order: the HUD reads this, it never keeps its own */
  pit: PitTraffic = new PitTraffic(this);
  profiles: Record<string, Float32Array> = {};
  /** simulation time at which every human driver had a terminal result (-1 while one is still racing) */
  humansDoneT = -1;
  /** race time of the first car's arrival at the flag (-1 before) */
  firstFlagT = -1;
  practice = false;
  /** this race's own circuit geometry: never the displayed-track globals */
  readonly T: T.Track;
  /**
   * this race's length preset (#132), fixed at construction (a frozen preset in a non-writable property): the flag, every
   * deadline and the AI's fuel plan read `targetLaps` from it
   */
  readonly length: RaceLength;
  /** laps to the flag: this race's own target, never a process-wide count */
  get targetLaps(): number { return this.length.laps; }
  readonly rng: Rng;
  readonly finishWindow: number;
  readonly timeLimit: number;
  readonly runOn: 'sync' | 'live' | 'watch';
  /** 'watch' (#135): simulation time the watched run-on began (CLOSE_DELAY after humansDoneT), -1 before */
  watchT = -1;
  /** the final standings, set once when the race closes; null until then */
  final: readonly Standing[] | null = null;
  /** highest action sequence number applied, per driver: a null-prototype table, so any string driver ID (even `__proto__`) is an own key */
  lastSeq: Record<DriverId, number> = Object.create(null) as Record<DriverId, number>;
  private pending: DriverAction[] = [];
  /**
   * Post-race debrief metrics (#134, src/debrief.ts): read-only observation of events and per-step state, collected from the
   * green light until each driver's own terminal result. Never read by the simulation.
   */
  readonly debriefs = new DebriefCollector();

  constructor(opts: RaceOpts = {}) {
    this.practice = !!opts.practice;
    this.T = opts.track instanceof T.Track ? opts.track : opts.track ? T.trackFor(opts.track) : T.ACTIVE;
    this.length = raceLength(opts.length);
    Object.defineProperty(this, 'length', { writable: false, configurable: false });
    this.rng = opts.rng ?? (opts.seed !== undefined ? seededRng(opts.seed) : () => Math.random());
    const roster = resolveRoster(opts.roster ?? soloRoster(this.practice));
    const humans = roster.filter((e) => e.control === 'human').length;
    this.finishWindow = opts.finishWindow ?? (humans > 1 ? this.length.finishWindowS : Infinity);
    this.timeLimit = opts.timeLimit ?? (humans > 1 ? this.length.timeLimitS : Infinity);
    this.runOn = opts.runOn ?? 'sync';
    // planned speed profiles per persona, side and setup (#133): each built from that setup's own top speed and planned grip,
    // so an AI (or the automatic pit controller's corner limit) never plans a speed its car could not carry. Balanced keeps
    // the keys it always had; only setups in this roster are built
    const setups = new Set<SetupId>([DEFAULT_SETUP, ...roster.map((e) => e.setup ?? DEFAULT_SETUP)]);
    for (const id of setups) {
      const S = carSetup(id);
      for (const P of Object.values(PERSONAS)) for (const side of [-1, 1]) {
        this.profiles[profKey(id, P.id, side, false)] = this.T.buildProfile(side, S.aiGrip * P.grip, S.vmax, P.brake);
        this.profiles[profKey(id, P.id, side, true)] = this.T.buildProfile(side, S.aiGrip * P.grip * P.lapseGrip, S.vmax, P.brake * P.lapseBrake);
      }
    }
    this.profiles['-1'] = this.profiles['player:-1']; this.profiles['1'] = this.profiles['player:1'];
    this.goT = this.practice ? 1.6 : 4.0 + this.rnd(0.5, 1.4);
    // grid: two rows, each slot in its fixed place (slot 0, the solo driver's, in row 2)
    const grid = [
      { di: 1, prog: -1.3, side: 1 }, { di: 2, prog: -1.3, side: -1 },
      { di: 3, prog: -3.9, side: 1 }, { di: 0, prog: -3.9, side: -1 },
    ];
    for (const g of grid) {
      const e = roster.find((x) => x.slot === g.di);
      if (!e) continue;
      const D = DRIVERS[g.di];
      const human = e.control === 'human';
      // humans drive with the player assistance persona; an AI in slot 0 (normally the solo seat) races as a consistent driver
      const P = PERSONAS[e.persona ?? (human ? 'player' : D.persona === 'player' ? 'consistent' : D.persona)];
      const color = e.color ?? (g.di === 0 && opts.playerColor !== undefined ? opts.playerColor : D.color);
      const setup = carSetup(e.setup ?? DEFAULT_SETUP);
      const c: Car = {
        id: e.id, idx: g.di, name: e.name ?? D.name, color, human,
        num: D.num, bayHome: g.di,
        u: this.T.FINISH_S + g.prog, v: 0, laneSide: g.side, change: null, laneReq: false, pitReq: false, pitPenaltyOnly: false, laneOverride: false,
        fuelReq: false, fuelDue: 0, sgDue: 0, sgDeferred: false, routeHold: -1, overAppr: -1, hiU: this.T.FINISH_S + g.prog,
        svcBreach: null, towSvc: false, towPit: false, retire: null, retireT: 0, status: 'running', dqReason: null, dnfReason: null,
        mode: 'grid', d: g.side * this.T.LANE_HALF, yawOff: 0, throttle: 0, brake: 0,
        fuel: 1, slip: 0, latRatio: 0, wobble: 0, off: null, recoverT: 0, towT: 0,
        bay: g.di, bayT: 0, serviceT: 0, penalty: 0, fuelAtBay: 0,
        crossed: 0, lapsDone: 0, lastLap: 0, bestLap: 0, lapStartT: 0, lapValid: true, sectors: 0,
        finished: false, finishTime: 0, pitStops: 0,
        squeezeHold: false, yielding: false, waitingClear: false,
        skill: P.skill, lapse: 0, mistakeT: this.rnd(P.mistakeEvery[0], P.mistakeEvery[1]), pitPlan: false, refuelTarget: 1, changeCooldown: 0,
        lowFuelWarned: false, serviced: false, persona: P, setup,
        offences: 0, sgOwed: 0, sgServed: 0, sgServing: false, timePen: 0,
        graceT: 0, pushedT: 0, pushedFree: false, cutT: 0,
        threatIdx: -1, reactT: 0, defendOk: false, defendCooldown: 0, defendPending: false, defendSw: -1,
        x: 0, y: 0, h: 0, z: 0, roll: 0, pitch: 0, bumpT: 0,
        revOn: false, revHoldT: 0, revLatch: false, revMark: null,
        pitWait: null, pitCap: 1e9, pitHold: false, exitHold: false, sqWait: false, exitReq: false, pitFuel: false,
        sgPhase: null, sgCtl: false, sgCommit: -1, sgVc: 0, sgLeave: false, upPrev: false,
        stallT: 0, stallRun: 0, stallPaused: false, stallHold: false, stallSvc: false, linkAway: false, away: false, awayWaitT: 0,
      };
      // the setup is the car's for the whole race: not writable, so no rule or client can swap it mid-race
      Object.defineProperty(c, 'setup', { writable: false, configurable: false, enumerable: true });
      this.cars.push(c);
    }
    this.cars.sort((a, b) => a.idx - b.idx);
    for (const c of this.cars) this.pose(c);
  }

  /** The car of a driver, by stable ID. */
  car(id: DriverId): Car | undefined { return this.cars.find((c) => c.id === id); }
  /** A human driver's car, or undefined: actions for unknown drivers or AI entries are ignored. */
  private humanCar(id: DriverId): Car | undefined { const c = this.car(id); return c && c.human ? c : undefined; }

  rnd(a: number, b: number): number { return a + this.rng() * (b - a); }
  fuelRate(): number { return fuelRate(this.T.L); }

  s(c: Car): number { return this.T.wrapS(c.u); }

  emit(e: RaceEvent): void { this.events.push(e); this.debriefs.event(this, e); }
  /** a personal message for one human driver: AI cars get none */
  pmsg(c: Car, text: string, kind: MsgKind, vars?: Record<string, string | number>): void {
    if (c.human) this.emit(vars ? { type: 'msg', to: c.id, text, kind, vars } : { type: 'msg', to: c.id, text, kind });
  }

  /**
   * Queue a sequenced one-shot action for a human driver. It is applied once, at the start of the next update, in sequence
   * order per driver; a sequence number already applied or queued is stale and ignored. Unknown drivers and AI entries are refused.
   */
  act(a: DriverAction): ActResult {
    if (!this.humanCar(a.driver) || (a.type !== 'lane' && a.type !== 'pit' && a.type !== 'defer')) return 'unknown';
    if (!Number.isInteger(a.seq) || a.seq <= (this.lastSeq[a.driver] ?? 0) || this.pending.some((p) => p.driver === a.driver && p.seq === a.seq)) return 'stale';
    this.pending.push({ driver: a.driver, seq: a.seq, type: a.type });
    return 'queued';
  }
  /** Apply queued actions: by grid slot, then sequence. Each touches only its own driver's car. */
  private applyActions(): void {
    if (!this.pending.length) return;
    const slot = (id: DriverId): number => this.car(id)?.idx ?? 99;
    const q = this.pending.sort((a, b) => slot(a.driver) - slot(b.driver) || a.seq - b.seq);
    this.pending = [];
    for (const a of q) {
      if (a.seq <= (this.lastSeq[a.driver] ?? 0)) continue;
      this.lastSeq[a.driver] = a.seq;
      if (a.type === 'lane') this.requestLane(a.driver);
      else if (a.type === 'pit') this.requestPit(a.driver);
      else this.requestDefer(a.driver);
    }
  }

  /** Lane (L, or the touch Lane button) for one human driver. */
  requestLane(id: DriverId): void {
    const c = this.humanCar(id);
    if (!c || c.finished) return;
    // inside the single-file pit lane there is no other lane: nothing moves, and the player is told why
    if (c.mode === 'pitlane' || c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') { this.pmsg(c, 'msg.pitSingleFile', 'warn'); return; }
    if (c.mode !== 'race' && c.mode !== 'grid') return;
    if (this.pitAssist(c)) {
      // queued on the approach with no switch left before the entrance: an override could not be used, so it is not armed
      if (c.pitHold && !c.laneOverride && !this.switchBeforeEntry(c)) {
        this.pmsg(c, this.deferBlock(c) === null ? 'msg.queueNoSwitch' : 'msg.queueNoSwitchFinal', 'warn');
        return;
      }
      // the same with a stop-and-go owed or a fuel visit under way: an override no switch can use would only release automatic entry
      if ((c.sgOwed > 0 || c.fuelReq || c.fuelDue > 0) && !c.laneOverride && !this.switchBeforeEntry(c)) {
        this.pmsg(c, c.sgOwed > 0 ? (this.deferBlock(c) === null ? 'msg.sgNoSwitch' : 'msg.sgNoSwitchFinal') : 'msg.fuelNoSwitch', 'warn');
        return;
      }
      c.laneOverride = !c.laneOverride;
      // skipping a last-chance stop is the move that leads to the DQ, so the override says so at the moment it is chosen
      if (c.laneOverride && this.lastChance(c)) this.pmsg(c, 'msg.routeInsideDq', 'bad');
      else this.pmsg(c, c.laneOverride ? 'msg.routeInside' : 'msg.routeOutside', 'info');
      return;
    }
    if (c.change) return;
    c.laneReq = !c.laneReq;
    this.pmsg(c, c.laneReq ? 'msg.laneReady' : 'msg.laneCancelled', c.laneReq ? 'info' : 'warn');
  }
  /** Pit (P) for one human driver. */
  requestPit(id: DriverId): void {
    const c = this.humanCar(id);
    if (!c || c.finished || (c.mode !== 'race' && c.mode !== 'grid')) return;
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
  requestDefer(id: DriverId): void {
    const c = this.humanCar(id);
    if (!c || c.finished) return;
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
    if (this.practice || this.phase !== 'racing' || c.finished || !c.human) return 'phase';
    const k = this.apprLap(c);
    const sgNow = c.sgOwed > 0 && c.sgDue <= k;
    const fuelNow = c.fuelDue > 0 && c.fuelDue <= k;
    if (!c.fuelReq && c.sgOwed <= 0 && c.fuelDue <= 0) return 'none';
    if (c.mode === 'off' || c.mode === 'tow') return 'phase';   // nothing to choose until the car is back on the road
    if (c.mode !== 'race') return 'pit';
    if (c.routeHold === k) return 'held';
    if (fuelNow || (sgNow && (c.sgDeferred || c.sgDue < k))) return 'used';
    if (k + 1 > this.targetLaps) return 'final';
    return null;
  }

  /**
   * The pit approach the car is heading for, numbered by lap: the entrance on lap n is approach n. Counted from the furthest
   * distance ever reached, so reversing over the entrance, a re-slot behind it or a pause never brings an approach back.
   */
  apprLap(c: Car): number { return Math.floor((c.hiU - this.T.PIT_IN0) / this.T.L) + 1; }

  /** Where an obligation due by the end of lap `due` stands against the lap being raced. */
  dueState(c: Car, due: number): DueState {
    if (due <= 0) return 'none';
    if (due > this.targetLaps) return 'late';
    const lap = Math.max(1, c.crossed);
    return due > lap ? 'next' : due === lap ? 'due' : 'overdue';
  }

  /**
   * Last chance (#65): a compulsory stop is due on the lap being raced and missing this lap's entrance would latch the breach
   * (a DQ at the flag): a committed fuel stop, or a stop-and-go whose one deferral is used or that is due on the final lap.
   * Read-only, from fields every online snapshot carries, so the mirror's HUD shows the same chip offline and online.
   * Off while the car is already in the pits on a visit that will pay that debt (#81): it is no longer about to miss it.
   */
  lastChance(c: Car): boolean {
    // a retired (dnf) or disqualified car is out of the race: nothing is due any more, so no chip and no message
    if (this.practice || c.finished || c.status !== 'running' || c.svcBreach) return false;
    const lap = Math.max(1, c.crossed);
    if (c.fuelDue > 0 && c.fuelDue === lap && !this.fuelVisit(c)) return true;
    return c.sgOwed > 0 && c.sgDue === lap && (c.sgDeferred || lap >= this.targetLaps) && !this.sgVisit(c);
  }

  /**
   * The car is in the pits on a visit that will serve its committed fuel stop (#81): turning into a bay, standing in one on a
   * real visit (a tow or a stopped-on-track recovery serves no fuel stop), or a fuel visit in the pit lane that is still short
   * of its own bay's turn-in window with the fuel to get there (one that runs dry is towed, and a tow serves nothing).
   * Read by the HUD's last-chance state only; it decides nothing.
   */
  fuelVisit(c: Car): boolean {
    if (c.mode === 'bayIn') return true;
    if (c.mode === 'service') return !c.towSvc;
    return c.mode === 'pitlane' && c.pitFuel && !c.serviced && this.pitReach(c, this.T.BAYS[c.bayHome], this.T.BAY_HALF);
  }

  /** The car is in the pit lane on a visit that will serve its stop-and-go (#81): short of the end of the box, fuel to reach it. */
  sgVisit(c: Car): boolean {
    return c.mode === 'pitlane' && this.pitReach(c, SG_STOP, this.T.PEN_HALF);
  }

  /** A pit-lane car is not past `at` by more than `half` and its tank covers the way there at the highest burn (#81). */
  private pitReach(c: Car, at: number, half: number): boolean {
    const gap = this.T.gapS(this.s(c), at);
    return gap > -half && c.fuel > Math.max(0, gap) * this.fuelRate() * 1.2;
  }

  /** Another car is standing in (or rolling through) the stop-and-go box. */
  boxBusy(c: Car): boolean {
    if (this.pit.box >= 0 && this.pit.box !== c.idx) return true;
    return this.cars.some((o) => o !== c && o.mode === 'pitlane' && Math.abs(this.T.gapS(this.s(o), this.T.PEN_S)) < this.T.PEN_HALF);
  }

  /** The car whose own bay j is for this race, or null (practice leaves the rivals' bays unowned). Ownership is identity, never colour. */
  bayOwner(j: number): Car | null { return this.cars.find((c) => c.bayHome === j) ?? null; }

  /** Pit routing assists human drivers. The AI chooses its own approach. */
  pitAssist(c: Car): boolean { return c.human && c.pitReq && !c.finished; }

  /**
   * An owed stop or fuel request routes a human driver to the next entrance, except on an approach released by a deferral.
   * Debts persist, and an active optional request keeps routing on.
   */
  syncRoute(c: Car): void {
    if (!c.human) return;
    if (c.finished) { c.pitReq = false; c.fuelReq = false; c.pitPenaltyOnly = false; c.laneOverride = false; return; }
    const k = this.apprLap(c);
    if (c.routeHold >= 0 && c.routeHold < k) c.routeHold = -1;
    if (c.routeHold === k) { c.pitReq = false; c.laneOverride = false; }
    else if ((c.sgOwed > 0 || c.fuelDue > 0 || c.fuelReq) && !c.pitReq) { c.pitReq = true; c.laneReq = false; }
    c.pitPenaltyOnly = c.pitReq && c.sgOwed > 0 && !c.fuelReq && c.fuelDue <= 0;
  }

  /** A lane switch still lies ahead of the car before the coming pit entrance. */
  switchBeforeEntry(c: Car): boolean {
    const s = this.s(c), entry = this.T.ahead(s, this.T.PIT_IN0);
    return this.T.SWITCHES.some((sw) => { const a = this.T.ahead(s, sw.s0); return a > 0.05 && a < entry; });
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
      if (a.status === 'finished') return a.finishTime + a.timePen - (b.finishTime + b.timePen) || a.idx - b.idx;
      return b.u - a.u || a.idx - b.idx;
    });
  }

  /**
   * Once every human is done, run the rest of the field on to the flag (no rendering, every pedal neutral) so every car gets a
   * real result. Anything still running after the preset's runOutS (RUN_OUT_MAX for Standard and Sprint) is terminally
   * classified. Only result events are kept from the run.
   */
  runOut(maxSec = this.length.runOutS): void {
    const keep = this.events.length;
    for (let t = 0; t < maxSec && this.cars.some((c) => c.status === 'running'); t += 1 / 120) this.step(1 / 120, {});
    this.classifyRunning('runout');
    this.events = [...this.events.slice(0, keep), ...this.events.slice(keep).filter((e) => e.type === 'finish' || e.type === 'dq' || e.type === 'dnf')];
  }

  /**
   * Terminal classification of every car still running, in a fixed order (furthest first, then grid slot): a latched service
   * breach is a DQ (as it would have been at the flag), anything else a DNF. Each car is classified once; nothing re-runs it.
   */
  classifyRunning(why: DnfReason): void {
    const run = this.cars.filter((c) => c.status === 'running').sort((a, b) => b.u - a.u || a.idx - b.idx);
    for (const c of run) {
      this.endService(c);
      if (c.svcBreach) {
        c.status = 'dq'; c.dqReason = 'deadline';
        this.emit({ type: 'dq', car: c, reason: 'deadline' });
        this.pmsg(c, 'msg.dq.deadline', 'bad');
      } else {
        c.status = 'dnf'; c.dnfReason = why;
        this.emit({ type: 'dnf', car: c, reason: why });
      }
    }
  }

  /**
   * Retire one car now: its driver left the race or did not come back within the reconnect grace. Like the finish window, a
   * latched service breach is still a DQ (leaving never escapes one); anything else is DNF `retired`. The car is then a
   * terminal car, and nobody drives it any more (not even the AI that drives a finished car's cool-down lap): it coasts to a
   * stop and is then parked in its own bay, off the racing line and out of collisions (`stepCar`, `park`), so an abandoned car
   * never circulates as an obstacle. Returns false (and changes nothing) for an unknown or already terminal car.
   */
  retire(id: DriverId): boolean {
    const c = this.car(id);
    if (!c || c.status !== 'running') return false;
    this.endService(c);
    c.retire = 'coast'; c.retireT = 0;
    if (c.svcBreach) {
      c.status = 'dq'; c.dqReason = 'deadline';
      this.emit({ type: 'dq', car: c, reason: 'deadline' });
    } else {
      c.status = 'dnf'; c.dnfReason = 'retired';
      this.emit({ type: 'dnf', car: c, reason: 'retired' });
    }
    return true;
  }

  /** The car's race is over: routing, automatic service and pit reservations end with it. */
  private endService(c: Car): void {
    c.finished = true; c.laneReq = false; c.sgLeave = false; c.sgCtl = false; c.sgPhase = null; this.clearPitIntent(c); c.pitPlan = false; c.routeHold = -1;
    c.revOn = false; c.revHoldT = 0;
    this.pit.releaseAll(c, 'terminal');
  }

  /**
   * Authoritative standings: every car terminal, classified finishers by time (then grid slot), then DNF, then DQ.
   * Null while any car is still running, so an estimate can never be read as a result.
   */
  standings(): Standing[] | null {
    if (this.cars.some((c) => c.status === 'running')) return null;
    let pos = 0;
    return this.order().map((c) => {
      const fin = c.status === 'finished';
      return {
        id: c.id, slot: c.idx, control: c.human ? 'human' : 'ai', pos: fin ? ++pos : null,
        status: c.status as Standing['status'], time: fin ? c.finishTime + c.timePen : null,
        laps: c.lapsDone, bestLap: c.bestLap, pitStops: c.pitStops, timePen: c.timePen, dqReason: c.dqReason, dnfReason: c.dnfReason,
      };
    });
  }

  /** Close the race once: the field is run on, the standings are frozen and a single `final` event is sent. */
  private close(runOutS = this.length.runOutS): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.runOut(runOutS);
    this.final = Object.freeze((this.standings() ?? []).map((x) => Object.freeze(x)));
    this.emit({ type: 'final' });
  }

  nextSwitch(c: Car): T.Switch {
    const s = this.s(c);
    let best = this.T.SWITCHES[0], bd = 1e9;
    for (const sw of this.T.SWITCHES) { const a = this.T.ahead(s, sw.s0); if (a < bd) { bd = a; best = sw; } }
    return best;
  }

  /** Advance by dt with each human driver's held pedals. A driver missing from `inputs` is neutral; AI entries ignore it. */
  update(dt: number, inputs: Controls = {}): void {
    this.applyActions();
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, inputs);
  }

  /** The pedals a car drives with this step: its own driver's held input when human, never anyone else's. */
  inputOf(c: Car, inputs: Controls): Input {
    if (!c.human) return NEUTRAL;
    const i = Object.prototype.hasOwnProperty.call(inputs, c.id) ? inputs[c.id] : undefined;
    if (i?.away === true) return AWAY;
    return i ? { up: i.up === true, down: i.down === true } : NEUTRAL;
  }

  step(dt: number, inputs: Controls): void {
    this.t += dt;
    if (this.phase === 'countdown') {
      const n = this.t < this.goT ? Math.min(5, Math.floor(this.t / 0.8)) : 0;
      if (n !== this.lights && this.t < this.goT) { this.lights = n; this.emit({ type: 'light', n }); }
      if (this.t >= this.goT) {
        this.lights = 0; this.phase = 'racing'; this.emit({ type: 'go' });
        // a car retired on the grid is already parked in its bay and stays there
        for (const c of this.cars) if (!c.retire) { c.mode = 'race'; c.graceT = PEN.grace; }
      }
    } else {
      this.raceTime += dt;
    }
    // pit traffic is decided from where every car is before any of them moves, so array order never grants priority
    this.pit.update();
    // a car out of the pits inside the squeeze joins the queue when it safely can, also decided before any car moves (#110)
    this.joinSqueezeWaiting();
    for (const c of this.cars) this.stepCar(c, dt, this.inputOf(c, inputs));
    // after every car has moved and before any touch: who is held out of traffic for an away driver this step (#74)
    away.awayUpdate(this, dt);
    this.collide();
    for (const c of this.cars) this.pose(c);
    if (this.phase === 'countdown') return;
    // bounded end (also during the run-on): after the first car reaches the flag the rest have the finish window, and the
    // race-time limit caps the whole race
    if (this.firstFlagT >= 0 && this.raceTime - this.firstFlagT > this.finishWindow) this.classifyRunning('window');
    if (this.raceTime > this.timeLimit) this.classifyRunning('timeout');
    // after the terminal classification, so a car the window or the time limit ends on this step gets that one outcome only
    this.stallUpdate(dt, inputs);
    // every transition of this step is done: the debrief observes it (read only), before a close can run the field on
    this.debriefs.observe(this);
    if (this.phase !== 'racing') return;
    // one human finishing never ends anyone else's race: it closes once every human is terminal (with no human, every car)
    const humans = this.cars.filter((c) => c.human);
    const done = (humans.length ? humans : this.cars).every((c) => c.status !== 'running');
    if (done && this.humansDoneT < 0) this.humansDoneT = this.t;
    if (this.humansDoneT >= 0 && this.t - this.humansDoneT > CLOSE_DELAY) {
      if (this.runOn === 'sync' || this.cars.every((c) => c.status !== 'running')) { this.close(); return; }
      if (this.runOn !== 'watch') return;
      // watched (#135): the same bound as the synchronous run-on, counted in the same simulated steps
      if (this.watchT < 0) this.watchT = this.t;
      if (this.t - this.watchT >= this.length.runOutS) { this.classifyRunning('runout'); this.close(); }
    }
  }

  /**
   * #135: finish a watched race now (the local Skip to results): once every human is terminal, the rest of the field is run on
   * synchronously through the same steps it would have been watched through (runOut), with what is left of the run-on budget,
   * and the race closes with its final standings. False (nothing changes) before every human is terminal or once closed.
   */
  skipRunOut(): boolean {
    if (this.phase !== 'racing' || this.humansDoneT < 0) return false;
    const used = this.watchT >= 0 ? this.t - this.watchT : 0;
    this.close(Math.max(0, this.length.runOutS - used));
    return true;
  }

  // ---------------------------------------------------------------- car step
  stepCar(c: Car, dt: number, input: Input): void {
    c.bumpT = Math.max(0, c.bumpT - dt);
    c.recoverT = Math.max(0, c.recoverT - dt);
    c.changeCooldown = Math.max(0, c.changeCooldown - dt);
    c.graceT = Math.max(0, c.graceT - dt); c.pushedT = Math.max(0, c.pushedT - dt); c.cutT = Math.max(0, c.cutT - dt);
    c.defendCooldown = Math.max(0, c.defendCooldown - dt);
    c.linkAway = c.human && input.away === true;
    // a car held out of traffic (#74) has no pedals until it is back in traffic, even once its driver is back: nothing it
    // could do while it overlaps another car may move it (no driving through anyone), and reverse gear is let go
    if (c.away) input = NEUTRAL;
    if (c.human) { this.sgUpdate(c); rev.reverseControl(this, c, dt, input); }
    if (c.retire === 'parked') { c.v = 0; c.throttle = 0; c.brake = 0; return; }
    if (c.retire) c.retireT += dt;
    if (c.retire && recover.parkable(this, c)) { recover.park(this, c); return; }
    if (c.mode === 'off') { recover.stepOff(this, c, dt); return; }
    if (c.mode === 'tow') { if (c.stallHold) stall.stepStallHold(this, c, dt); else recover.stepTow(this, c, dt); return; }
    if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') { this.stepBay(c, dt, input); return; }

    // ---- control
    let thrIn = 0, brkIn = 0;
    let autoV: number | null = null;
    if (c.mode !== 'grid' || c.human) {
      // held out of traffic (#74): it stands still on the brakes, whoever would drive it (its driver, automatic stop-and-go
      // control, or the AI that drives a finished car), so it never moves while others pass through its spot
      if (c.away) brkIn = 1;
      // braking takes priority: with both held, Throttle does nothing
      else if (c.human && !c.finished && c.sgCtl) {
        // automatic stop-and-go: the controller owns the pedals, so a held Throttle or Brake changes nothing
        autoV = this.sgTarget(c);
        const err = autoV - c.v;
        if (err > 0.3) thrIn = 1;
        else if (err < -0.05) brkIn = 1;
        else thrIn = holdThrottle(c.setup, c.v);
      } else if (c.human && !c.finished) { brkIn = input.down ? 1 : 0; thrIn = input.up && !input.down ? 1 : 0; }
      // a retired car has no driver: both pedals stay released and it coasts to a stop (COAST + drag, under 3 s from VMAX)
      else if (c.mode !== 'grid' && !c.retire) { const a = this.ai(c, dt); thrIn = a.t; brkIn = a.b; }
    }
    const rise = c.human ? 4.5 : c.persona.rise, fall = 9;
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
      // the car's own setup (#133): drive and drag are its preset's, braking and coasting are everyone's
      const S = c.setup;
      const drive = thr * S.acc * Math.max(0, 1 - v0 / S.vmax);
      const decel = (1 - thr) * COAST + brkIn * BRAKE + S.drag * v0 * v0;
      c.v = Math.max(0, v0 + (drive - decel) * dt);
    }
    // the controller tracks its target: braking stops at it, driving never passes it
    if (autoV !== null && v0 >= 0) c.v = v0 > autoV ? Math.max(c.v, autoV) : Math.min(c.v, autoV);

    // ---- automatic caps (pit limiter, squeeze priority, pit exit yield)
    const s0 = this.s(c);
    let cap = 1e9;
    c.squeezeHold = false; c.yielding = false;
    if (c.mode === 'pitlane') {
      cap = this.T.PIT_SPEED;
      // the pit exit: wait at the line while the outside lane is not clear or another car is merging
      if (c.exitHold) {
        const a = this.T.gapS(s0, this.T.PIT_OUT0);
        cap = Math.min(cap, Math.sqrt(2 * 25 * Math.max(0, a - 0.4)));
        c.yielding = true;
      }
    }
    // shared pit queue: a stopping gap behind whatever is ahead on the car's own path
    cap = Math.min(cap, c.pitCap);
    // (a car held for an away driver is not in the squeeze queue while held: awayUpdate takes it out and puts it back)
    const qi = this.squeezeQ.indexOf(c);
    if (qi > 0) {
      const ah = this.squeezeQ[qi - 1];
      const gap = this.T.gapS(s0, this.s(ah));
      const minGap = this.T.CAR_LEN + 0.3;
      const lim = Math.max(0, ah.v + 3 * (gap - minGap));
      if (gap < minGap + 2.5 && Math.abs(c.d - ah.d) > 0.05) c.squeezeHold = lim < c.v + 1;
      cap = Math.min(cap, lim);
    }
    if (c.v > cap) c.v = Math.max(cap, c.v - SQUEEZE.brake * dt);

    // ---- move along slot
    const k = this.T.curvature(s0);
    let ds = (c.v * dt) / Math.max(0.3, 1 - k * c.d);
    if (ds < 0) ds = rev.reverseTravel(this, c, s0, ds);
    const prevD = c.d;
    const u0 = c.u;
    c.u += ds;
    const s = this.s(c);
    const crossed = (x: number): boolean => { const g = this.T.gapS(s0, x); return ds > 0 && g >= 0 && g < ds; };
    /** crossed on new ground: after backing up, points short of the furthest position already reached are not decided again */
    const fresh = (x: number): boolean => crossed(x) && (c.revMark === null || u0 + this.T.gapS(s0, x) >= c.revMark);

    // fuel: burn follows distance travelled in either direction, so backing up can never refill the tank
    // cars on their cool-down lap after the flag no longer burn fuel (they would otherwise run dry and get towed)
    if (!c.finished && !this.practice) c.fuel = Math.max(0, c.fuel - Math.abs(c.v) * dt * this.fuelRate() * (0.5 + 0.7 * (revDrive ? 1 : thr)));
    if (c.human && !c.lowFuelWarned && c.fuel < LOW_FUEL && !c.finished) { c.lowFuelWarned = true; this.pmsg(c, 'msg.lowFuel', 'bad'); }
    if (c.fuel > LOW_FUEL + 0.05) c.lowFuelWarned = false;

    if (c.mode === 'race') {
      // an owed stop keeps routing on, including after a pit exit or tow that did not serve it; a deferral releases one approach
      if (c.human) this.syncRoute(c);
      // lane switches
      for (const sw of this.T.SWITCHES) {
        if (!fresh(sw.s0)) continue;
        const route = this.nextRoute(c);
        if (route) { c.laneReq = !route.stay && !c.change; if (route.override) c.overAppr = this.apprLap(c); c.laneOverride = false; }
        if (c.laneReq && !c.change) {
          c.laneReq = false;
          const to = c.laneSide > 0 ? -1 : 1;
          const defensive = c.defendPending; c.defendPending = false;
          const clear = this.laneClear(c, to);
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
        const p = this.T.ahead(c.change.s0, s);
        if (p >= len && p < len + 20) { c.laneSide = c.change.to; c.change = null; c.cutT = PEN.cutInWindow; }
        else c.laneSide = c.change.from + (c.change.to - c.change.from) * this.T.smooth(p / len);
      }
      // pit entry: a physical forward crossing. Entering clears the routing and an optional request, never a debt
      if (crossed(this.T.PIT_IN0)) {
        let entered = false;
        // a stop-and-go entrance reached too fast for the controller to take over is not entered: no instant stop, the debt stays
        const tooFast = c.human && c.sgOwed > 0 && !c.sgCtl && c.v > this.T.PIT_SPEED + AUTO.entryTol;
        if (c.pitReq && tooFast && c.laneSide < 0 && !c.change && !c.finished) this.pmsg(c, 'msg.sgTooLate', 'bad');
        else if (c.pitReq) {
          if (c.laneSide < 0 && !c.change && !c.finished) {
            c.mode = 'pitlane'; c.lapValid = false; entered = true;
            c.pitFuel = c.fuelReq || c.fuelDue > 0 || c.pitPlan;
            this.clearPitIntent(c);
            this.pmsg(c, c.sgOwed > 0 ? 'msg.pitInPen' : 'msg.pitIn', 'info');
          } else {
            if (!c.human) c.pitReq = false; // the AI decides again every step; a player's request waits for the next lap
            this.pmsg(c, 'msg.pitMissed', 'bad');
          }
        }
        // an optional fuel request driven past on a manual override is a deferral: it is now owed by the end of the next lap.
        // Judged once per approach, so backing up and passing again changes nothing
        if (!entered && c.human && c.fuelReq && !c.finished && !this.practice && fresh(this.T.PIT_IN0)) {
          const k = Math.round((u0 + this.T.gapS(s0, this.T.PIT_IN0) - this.T.PIT_IN0) / this.T.L);
          if (c.overAppr === k && k + 1 <= this.targetLaps) { c.fuelReq = false; c.fuelDue = k + 1; this.syncRoute(c); this.pmsg(c, 'msg.fuelOverride', 'bad'); }
        }
      }
      // squeeze priority queue
      if (crossed(this.T.SQ_ENTRY) && !this.squeezeQ.includes(c)) this.squeezeQ.push(c);
      // backing up left the queue (reverseTravel): driving forward again inside the squeeze (revMark: short of the furthest
      // point reached before backing up) puts the car back at its physical place, so it waits for the cars ahead and holds
      // those behind again (#100). Backed out past the entry, it is queued by the crossing above instead
      if (ds > 0 && c.revMark !== null) this.rejoinSqueeze(c);
      if (crossed(this.T.SQ_EXIT)) squeeze.leaveSqueeze(this, c);
      c.d = c.laneSide * this.T.laneHalf(s);
    } else if (c.mode === 'pitlane') {
      c.d = this.T.pitD(s);
      this.servePenalty(c, s, dt);
      if (crossed(this.T.PIT_OUT1)) {
        c.mode = 'race'; c.laneSide = -1; c.d = -this.T.LANE_HALF; c.serviced = false; c.graceT = PEN.grace; c.pitFuel = false;
        // the handover point: past the pit-exit merge, back in the outside lane, normal control returns
        if (c.sgLeave) { c.sgLeave = false; c.sgCtl = false; c.sgPhase = null; this.pmsg(c, 'msg.sgHandover', 'info'); }
        this.pit.release('exit', c, 'done');
        // a pit exit inside the squeeze (circuit-4: the zone starts short of PIT_OUT1, so the car never crosses SQ_ENTRY on the
        // road) waits to join the squeeze queue (joinSqueezeWaiting). Elsewhere the exit is short of the zone and the car is
        // queued by crossing the entry, as before (#110)
        c.sqWait = this.T.inRange(this.s(c), this.T.SQ_ENTRY, this.T.SQ_EXIT);
        if (c.sgOwed > 0 && !c.finished) this.pmsg(c, 'msg.penStillOwed', 'bad');
      }
      // automatic fuel visit: brought to rest at the centre of the car's own bay, it turns in (the usual entry animation)
      else if (c.human && c.sgCtl && autoSg.autoBay(this, c, s)) {
        if (Math.abs(this.T.gapS(s, this.T.BAYS[c.bayHome])) < AUTO.bayTol && Math.abs(c.v) < 0.05 && this.bayFree(c.bayHome, c)) this.enterBay(c, c.bayHome);
      }
      // a bay is only captured nearly stopped: never while reversing past it, nor while the queue holds the car (unless braking there)
      else if (Math.abs(c.v) < 0.7 && !c.revOn && c.human && !c.sgCtl && !c.sgLeave && !c.serviced && !c.sgServing && (!c.pitHold || input.down)) this.tryBay(c, s);
      else if (!c.human && c.pitPlan) {
        // only the car's own bay: occupied, it waits short of it (ai()); passed, it goes round again and never takes another team's
        if (Math.abs(this.T.gapS(s, this.T.BAYS[c.bayHome])) < 0.45 && c.v < 1.5 && this.bayFree(c.bayHome, c)) this.enterBay(c, c.bayHome);
      }
    }

    // render yaw from lateral motion
    // backing up, the car still faces forward
    const yo = ds > 1e-5 ? Math.atan2(c.d - prevD, ds) : ds < -1e-5 ? Math.atan2(prevD - c.d, -ds) : 0;
    c.yawOff += (yo - c.yawOff) * Math.min(1, dt * 20);

    // ---- grip / deslot (racing lanes only)
    if (c.mode === 'race') {
      const k2 = this.T.curvature(s);
      const kl = Math.abs(k2 / (1 - k2 * c.d));
      // banked sections (new circuits only) give a modest, predictable grip bonus to everyone
      const r = (c.v * c.v * kl) / (c.setup.grip * this.T.gripScale(s));
      c.latRatio = r;
      if (r > 1) c.slip += ((r - 1) * 3 + 0.2) * dt; else c.slip = Math.max(0, c.slip - 2.5 * dt);
      const target = Math.max(0, Math.min(1, (r - 0.8) / 0.2)) * 0.6 + c.slip * 0.8;
      c.wobble += (target - c.wobble) * Math.min(1, dt * 10);
      if (c.slip >= 1) this.deslot(c);
    } else { c.latRatio = 0; c.wobble *= 0.9; c.slip = 0; }

    // out of fuel: towed to a bay from the road, or from anywhere in the pit lane except standing in the box to serve the stop
    const dryPit = c.mode === 'pitlane' && !(c.sgOwed > 0 && this.pit.box === c.idx && Math.abs(this.T.gapS(s, this.T.PEN_S)) < this.T.PEN_HALF);
    // (a retired car is never towed: it is parked instead once it stops)
    if (c.fuel <= 0 && !c.retire && (c.mode === 'race' || dryPit) && Math.abs(c.v) < 0.4) {
      c.towPit = c.mode === 'pitlane'; c.sgLeave = false; c.sgServing = false;
      c.mode = 'tow'; c.towT = 0; c.lapValid = false; squeeze.leaveSqueeze(this, c); c.laneReq = false; this.clearPitIntent(c);
      this.pit.releaseAll(c, 'terminal');
      if (c.change) { c.laneSide = c.change.to; c.change = null; }
      this.emit({ type: 'tow', car: c });
      this.pmsg(c, 'msg.outOfFuel', 'bad');
    }
    // ordered sector checkpoints (quarter, half, three-quarter distance from the timing line)
    for (let i = 0; i < 3; i++) {
      if (fresh(this.T.wrapS(this.T.FINISH_S + (this.T.L * (i + 1)) / 4))) {
        if (c.sectors === (1 << i) - 1) c.sectors |= 1 << i; else c.lapValid = false;
      }
    }
    if (c.u > c.hiU) c.hiU = c.u;
    this.laps(c, dt, ds, s0);
    // back at the furthest point reached before backing up (or never got away from it: a reverse blocked at once by the car
    // behind leaves u at the mark, and the step that clears it has no forward travel): the car rejoins the squeeze queue at its
    // physical place here too, unless it is still rolling backwards (#100)
    if (c.revMark !== null && c.u >= c.revMark) { if (ds >= 0) this.rejoinSqueeze(c); c.revMark = null; }
  }

  // ---------------------------------------------------------------- automatic pit service for human drivers: src/autoStopGo.ts
  sgUpdate(c: Car): void { autoSg.sgUpdate(this, c); }

  /** The bay number shown to the driver: 1 for the first bay down the pit lane. */
  bayNo(c: Car): number { return c.bayHome + 1; }

  departBlock(c: Car): DepartBlock | null { return autoSg.departBlock(this, c); }
  sgTarget(c: Car): number { return autoSg.sgTarget(this, c); }
  sgCorner(c: Car, s: number): number { return autoSg.sgCorner(this, c, s); }

  /**
   * The assisted-driver ('player' persona) planned speed profile of a car's own setup on one side (#133): what the automatic
   * pit controller's corner limit reads, and what scripted test drivers follow. Balanced's is `profiles['-1']` / `['1']`.
   */
  playerProfile(c: Car, side: number): Float32Array {
    return this.profiles[profKey(c.setup.id, 'player', side < 0 ? -1 : 1, false)];
  }

  // ---------------------------------------------------------------- reverse for human drivers: src/reverse.ts
  reverseBlock(c: Car): 'phase' | 'mode' | 'change' | 'fuel' | 'service' | 'assist' | null { return rev.reverseBlock(this, c); }
  clearReverse(): void { rev.clearReverse(this); }

  /** Lap counting. dt/ds/s0 describe the step just taken so the crossing time can be interpolated to sub-step precision. */
  laps(c: Car, dt = 0, ds = 0, s0 = 0): void {
    const prog = c.u - this.T.FINISH_S;
    const cr = prog >= 0 ? Math.floor(prog / this.T.L) + 1 : 0;
    while (c.crossed < cr) {
      c.crossed++;
      // precise crossing time: fraction of this step travelled before the line
      let tCross = this.raceTime;
      if (ds > 1e-6 && dt > 0) { const frac = Math.max(0, Math.min(1, this.T.ahead(s0, this.T.FINISH_S) / ds)); tCross = this.raceTime - dt * (1 - frac); }
      const valid = c.lapValid && c.sectors === 7 && c.crossed >= 2;
      if (c.crossed >= 2 && !c.finished) {
        const lt = tCross - c.lapStartT;
        c.lapsDone = c.crossed - 1;
        c.lastLap = lt;
        const best = valid && (c.bestLap === 0 || lt < c.bestLap);
        if (best) c.bestLap = lt;
        this.emit({ type: 'lap', car: c, time: lt, best, valid, lapsDone: c.lapsDone });
        // service earlier in this step (box, bay) is already applied; deadlines are judged before the finish is classified
        const prior = c.svcBreach;
        const flag = c.lapsDone >= this.targetLaps && !this.practice;
        const sgWasDeferred = c.sgDeferred;
        // "Final lap!" first: the HUD shows only the newest toast, so any deadline warning or breach posted at this same
        // crossing must come after it, or the cheerful message would hide the DQ one (#65)
        if (!flag && c.human && c.lapsDone === this.targetLaps - 1 && !this.practice) this.pmsg(c, 'msg.finalLap', 'good');
        this.serviceDeadline(c, flag);
        if (flag) this.finishCar(c, tCross, prior);
        // a compulsory stop now on its last lap gets a one-off warning a whole lap before the entrance that decides it
        // (#65). An automatic deferral at this crossing has already said "last chance". A message only: nothing reads it back
        if (!flag && c.human && this.lastChance(c) && !(c.sgDeferred && !sgWasDeferred)) this.pmsg(c, 'msg.pitThisLap', 'bad');
      }
      c.lapStartT = tCross; c.lapValid = true; c.sectors = 0;
    }
  }

  // ---------------------------------------------------------------- the squeeze priority queue (#100, #110): src/squeeze.ts
  joinSqueezeWaiting(): void { squeeze.joinSqueezeWaiting(this); }
  rejoinSqueeze(c: Car): void { squeeze.rejoinSqueeze(this, c); }
  laneClear(c: Car, to: number): boolean { return squeeze.laneClear(this, c, to); }
  mergeBlocked(c: Car): boolean { return squeeze.mergeBlocked(this, c); }

  /** Nobody else is in bay j or has reserved it. */
  bayFree(j: number, self: Car): boolean { return this.pit.bayAvail(j, self); }

  /** A car stopped by hand alongside its own bay turns in, if the bay is free. Another team's bay never captures it. */
  tryBay(c: Car, s: number): void {
    const j = c.bayHome;
    if (j >= 0 && j < this.T.BAYS.length && Math.abs(this.T.gapS(s, this.T.BAYS[j])) < this.T.BAY_HALF && this.bayFree(j, c)) this.enterBay(c, j);
  }

  /** fuel the AI needs to reach the flag from here, planned at a realistic burn rate */
  fuelToFinish(c: Car, s: number): number {
    const lapsLeft = this.targetLaps - c.lapsDone;
    return (lapsLeft * this.T.L - this.T.ahead(this.T.FINISH_S, s)) * this.fuelRate() * PLAN_BURN;
  }

  enterBay(c: Car, j: number): void {
    this.holdBay(c, j);
    // Throttle counts as held until the bay sees it released: a pedal held on arrival never asks to leave
    c.mode = 'bayIn'; c.bay = j; c.bayT = 0; c.v = 0; c.serviceT = 0; c.fuelAtBay = c.fuel; c.towSvc = false; c.stallSvc = false; c.exitReq = false; c.upPrev = true;
    c.pitStops++;
    if (!c.human) c.refuelTarget = Math.min(1, Math.max(0.3, this.fuelToFinish(c, this.s(c)) + this.rnd(0.06, 0.2)));
  }

  /** The car's bay reservation is bay j: a reservation it held for another bay moves here. */
  holdBay(c: Car, j: number): void {
    const had = this.pit.bayOf(c);
    if (had === j) return;
    if (had >= 0) this.pit.release(`bay${had}`, c, 'moved');
    this.pit.grant(`bay${j}`, c);
  }

  stepBay(c: Car, dt: number, input: Input): void {
    const bs = this.T.BAYS[c.bay];
    const s = this.s(c);
    c.v = 0; c.yawOff *= 0.8; c.wobble *= 0.9;
    if (!c.human || c.finished) c.throttle = 0; else c.throttle += ((input.up ? 1 : 0) - c.throttle) * Math.min(1, dt * 6);
    // a Throttle held while turning in is still the arrival's: it has to be released before a press can ask to leave
    if (c.human && c.mode === 'bayIn') c.upPrev = c.upPrev && input.up;
    if (c.mode === 'bayIn') {
      c.bayT = Math.min(1, c.bayT + dt / 0.45);
      c.u += this.T.gapS(s, bs) * Math.min(1, dt * 10);
      c.d = this.T.PIT_D + (this.T.BAY_D - this.T.PIT_D) * this.T.smooth(c.bayT);
      c.yawOff = -Math.sin(c.bayT * Math.PI) * 0.5;
      if (c.bayT >= 1) { c.mode = 'service'; c.serviceT = 0; if (c.human) this.pmsg(c, 'msg.refuelling', 'info'); }
    } else if (c.mode === 'service') {
      c.serviceT += dt;
      c.penalty = Math.max(0, c.penalty - dt);
      // refuelling stops at the departure request; the tank never passes full
      // a stopped-on-track recovery gets none: fuel stays exactly as it was, so stopping by the bay never beats a real visit
      if (c.serviceT > 0.4 && !c.exitReq && !c.stallSvc) c.fuel = Math.min(1, c.fuel + REFUEL_RATE * dt);
      // a committed fuel stop counts once the car has stood in its bay for the departure-ready time (a full tank is fine; a tow is not a visit)
      if (c.fuelDue > 0 && !c.towSvc && c.serviceT > SERVICE_READY) { c.fuelDue = 0; this.pmsg(c, 'msg.fuelDone', 'good'); }
      // a departure request is latched: it waits in the bay for a safe merge and then goes, once, without pressing again.
      // The player asks with a fresh Throttle press once departure is ready; a full tank never leaves by itself
      if (c.human && !c.finished) {
        const press = input.up && !c.upPrev;
        c.upPrev = input.up;
        if (press && !c.exitReq) {
          const why = this.departBlock(c);
          if (!why) { c.exitReq = true; this.pmsg(c, 'msg.departReq', 'info'); }
          else this.pmsg(c, why === 'penalty' ? 'msg.departPenalty' : 'msg.departSettle', 'warn', { n: Math.max(0.1, why === 'penalty' ? c.penalty : SERVICE_READY - c.serviceT + 0.05).toFixed(1) });
        }
      } else if ((c.stallSvc || c.fuel >= c.refuelTarget || c.fuel >= 1) && c.penalty <= 0) c.exitReq = true;
      // the merge is granted by the shared pit traffic at the start of a step, from where everyone is
      if (c.exitReq && this.pit.merges[c.bay] === c.idx) { c.mode = 'bayOut'; c.bayT = 0; c.pitPlan = false; c.waitingClear = false; }
    } else {
      c.bayT = Math.min(1, c.bayT + dt / 0.4);
      c.d = this.T.BAY_D + (this.T.PIT_D - this.T.BAY_D) * this.T.smooth(c.bayT);
      c.yawOff = Math.sin(c.bayT * Math.PI) * 0.5;
      if (c.bayT >= 1) {
        c.mode = 'pitlane'; c.v = 0; c.d = this.T.PIT_D; c.yawOff = 0; c.serviced = true; c.exitReq = false; c.stallSvc = false;
        // the player is driven on along the pit lane, through the exit yield, and handed back past the merge
        if (c.human && !c.finished) c.sgLeave = true;
        // back in the through lane: the merge and the bay are released, once
        this.pit.release(`merge${c.bay}`, c, 'done'); this.pit.release(`bay${c.bay}`, c, 'done');
      }
    }
  }

  // ---------------------------------------------------------------- de-slot, re-slot, parking and tow: src/recover.ts
  deslot(c: Car): void { recover.deslot(this, c); }

  // ---------------------------------------------------------------- stopped-on-track recovery (#69): src/stall.ts
  stallBlock(c: Car): 'off' | 'held' | null { return stall.stallBlock(this, c); }
  stallTrapped(c: Car): boolean { return stall.stallTrapped(this, c); }
  stallUpdate(dt: number, inputs: Controls): void { stall.stallUpdate(this, dt, inputs); }
  stallRecover(c: Car): boolean { return stall.stallRecover(this, c); }

  // ---------------------------------------------------------------- AI
  ai(c: Car, dt: number): { t: number; b: number } {
    const s = this.s(c);
    const P = c.persona;
    // lapses of concentration: for a while the driver brakes later and carries more speed into corners
    // (how much is rolled per lapse; an aggressive driver's lapse can exceed the real grip limit)
    c.mistakeT -= dt;
    if (c.mistakeT < 0 && c.lapse === 0) c.lapse = this.rnd(P.lapseMix[0], P.lapseMix[1]);
    if (c.mistakeT < -P.mistakeDur) { c.mistakeT = this.rnd(P.mistakeEvery[0], P.mistakeEvery[1]); c.lapse = 0; }
    let target: number;
    if (c.mode === 'pitlane') {
      target = this.T.PIT_SPEED;
      if (c.sgOwed > 0) {
        // stop-and-go first: roll to a halt inside the penalty box and wait there
        const a = this.T.gapS(s, this.T.PEN_S);
        if (a > -this.T.PEN_HALF) target = Math.min(target, Math.sqrt(2 * 16 * Math.max(0, a)));
      } else if (c.pitPlan) {
        // its own bay; while that is occupied it waits short of it, clear of the occupant's merge
        const a = this.T.gapS(s, this.T.BAYS[c.bayHome]);
        const free = this.bayFree(c.bayHome, c);
        if (a > -0.3) target = Math.min(target, Math.sqrt(2 * 16 * Math.max(0, a - (free ? 0 : AUTO.bayWait))) + (free ? 0.4 : 0));
      }
    } else {
      const look = s + c.v * P.look;
      const n = this.profiles['1'].length;
      const i0 = Math.floor(this.T.wrapS(s) / this.T.PROFILE_STEP) % n;
      const i1 = Math.floor(this.T.wrapS(look) / this.T.PROFILE_STEP) % n;
      const prof = (side: number): number => {
        // the planned limits of this car's own setup (#133), with its personality's margins on top
        const pr = this.profiles[profKey(c.setup.id, P.id, side, false)];
        const a = Math.min(pr[i0], pr[i1]);
        if (c.lapse === 0) return a;
        const hot = this.profiles[profKey(c.setup.id, P.id, side, true)];
        return a + (Math.min(hot[i0], hot[i1]) - a) * c.lapse;
      };
      target = c.change ? Math.min(prof(-1), prof(1)) : prof(c.laneSide < 0 ? -1 : 1);
      target *= c.recoverT > 0 ? 0.8 : c.skill;
      if (c.finished) target *= 0.55;
    }
    // follow traffic in the same slot
    let nearest: Car | null = null, ng = 1e9;
    for (const o of this.cars) {
      if (o === c || o.mode === 'grid' || outOfTraffic(o)) continue;
      if (Math.abs(o.d - c.d) > this.T.CAR_W) continue;
      const g = this.T.gapS(s, this.s(o));
      if (g > 0 && g < ng) { ng = g; nearest = o; }
    }
    if (nearest && ng < 9) target = Math.min(target, nearest.v + P.followGain * (ng - this.T.CAR_LEN - 0.5) + c.lapse * P.lapsePush);

    // strategy: fuel + lane choice
    if (!c.finished && c.mode === 'race') {
      const lapFuel = this.T.L * this.fuelRate() * PLAN_BURN;
      const needFinish = this.fuelToFinish(c, s);
      // plan the stop with two laps of fuel in hand (time to find a switch and reach the pit),
      // and in any case before the last lap's worth is gone
      if (!c.pitPlan && c.fuel < needFinish && (c.fuel < lapFuel * 2.2 || c.fuel < lapFuel * 1.2 + 0.02)) {
        c.pitPlan = true;
        c.refuelTarget = Math.min(1, Math.max(0.3, needFinish + this.rnd(0.06, 0.2)));
      }
      // a tactical driver who will have to stop anyway pits early to escape traffic (never an extra stop)
      if (P.pitEarly && !c.pitPlan && c.fuel < needFinish && c.fuel < lapFuel * 3.4 && nearest && ng < 6 && nearest.v < c.v + 1) {
        c.pitPlan = true;
        c.refuelTarget = Math.min(1, Math.max(0.3, needFinish + this.rnd(0.06, 0.2)));
      }
      const mustPit = c.pitPlan || c.sgOwed > 0;
      c.pitReq = mustPit;
      if (!c.change && !c.laneReq && c.changeCooldown <= 0) {
        if (mustPit && c.laneSide > 0) c.laneReq = true;
        else if (!mustPit && nearest && ng < 7 && Math.abs(nearest.d - c.d) < 0.3 && nearest.v < c.setup.vmax * 0.98) c.laneReq = true;
      }
      if (c.laneReq && mustPit && c.laneSide < 0) c.laneReq = false;
      if (!mustPit) this.defend(c, dt, s);
    }

    const v = c.v;
    const hold = holdThrottle(c.setup, v);
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
      if (o === c || o.mode !== 'race' || o.finished || outOfTraffic(o)) continue;
      const g = this.T.gapS(this.s(o), s); // how far o is behind us
      if (g <= 0 || g > DEF.look || g >= tg) continue;
      if (o.v - c.v < DEF.closing) continue;
      tg = g; threat = o;
    }
    if (!threat) { c.threatIdx = -1; return; }
    if (threat.idx !== c.threatIdx) {
      // new threat: decide whether to defend at all, and how quickly we notice
      c.threatIdx = threat.idx; c.reactT = this.rnd(P.react[0], P.react[1]); c.defendOk = this.rng() < P.defendProb;
    }
    c.reactT -= dt;
    if (c.reactT > 0 || !c.defendOk || c.defendCooldown > 0 || c.change || c.laneReq) return;
    const theirLane = threat.change ? threat.change.to : Math.sign(threat.laneSide) || 1;
    const myLane = Math.sign(c.laneSide) || 1;
    if (theirLane === myLane) return;                       // already covering their lane: hold it
    if (tg < this.T.CAR_LEN + DEF.alongside) return;              // alongside: never cut across
    const sw = this.nextSwitch(c);
    if (sw.s0 === c.defendSw) return;                        // one defensive move per straight
    if (this.T.ahead(s, sw.s0) > 25) return;                      // no switch soon: nothing to decide yet
    c.laneReq = true; c.defendPending = true;
  }

  /** Extra safety for a defensive block: the attacker keeps reaction time, nobody is alongside, no pit-bound car is cut off. */
  defendSafe(c: Car, to: number, sw: T.Switch): boolean {
    const s = this.s(c);
    // never block inside the squeeze or the pit-entry approach
    if (this.T.inRange(sw.s0, this.T.SQ_ENTRY - 2, this.T.SQ_EXIT) || this.T.inRange(sw.s1, this.T.SQ_ENTRY - 2, this.T.SQ_EXIT)) return false;
    if (to < 0 && this.T.ahead(sw.s1, this.T.PIT_IN0) < 10) return false;
    for (const o of this.cars) {
      if (o === c || o.mode !== 'race' || outOfTraffic(o)) continue;
      const g = this.T.gapS(this.s(o), s); // o behind us by g
      if (g > 0 && g < 30 && o.pitReq && to < 0 && this.T.ahead(s, this.T.PIT_IN0) < 40) return false;
      if (!squeeze.occupies(this, o, to) && !(o.change && o.change.to === to)) continue;
      if (Math.abs(g) < this.T.CAR_LEN + DEF.alongside) return false;
      if (g > 0 && g < this.T.CAR_LEN + DEF.clearance + Math.max(0, o.v - c.v) * DEF.reactMargin + o.v * 0.08) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- penalties
  /** continuous stationary countdown inside the penalty box; moving early resets it */
  servePenalty(c: Car, s: number, dt: number): void {
    if (c.sgOwed <= 0) { c.sgServing = false; return; }
    // only the box's reservation holder serves: a car that stops in it behind another, without the grant, accumulates nothing
    const inBox = this.pit.box === c.idx && Math.abs(this.T.gapS(s, this.T.PEN_S)) < this.T.PEN_HALF;
    if (inBox && Math.abs(c.v) < REV.still) {
      c.sgServing = true;
      c.sgServed += dt;
      if (c.sgServed >= c.sgOwed) {
        c.sgOwed = 0; c.sgServed = 0; c.sgServing = false; c.sgDue = 0; c.sgDeferred = false;
        this.endPenaltyRoute(c);
        // a penalty-only visit is driven on to the pit exit; a fuel visit is handed back here, at the box, for its bay
        if (c.human) c.sgLeave = !c.pitFuel;
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
    const next = Math.round((c.u + this.T.ahead(this.s(c), this.T.PIT_IN0) - this.T.PIT_IN0) / this.T.L);
    return Math.max(this.apprLap(c), this.reachablePitEntry(c) ? next : next + 1);
  }

  /** can this car still make the upcoming pit entrance (outside lane, or a switch to it, with room to spare)? */
  reachablePitEntry(c: Car): boolean {
    const s = this.s(c);
    const dist = this.T.ahead(s, this.T.PIT_IN0);
    const outside = c.change ? c.change.to < 0 : c.laneSide < 0;
    // the player's entry is driven automatically, so it must also be possible to brake to the pit limit in time
    const late = c.human ? Math.max(0, c.v * c.v - this.T.PIT_SPEED ** 2) / (2 * AUTO.late) : 0;
    if (outside) return dist > Math.max(PEN.minEntryDist, late);
    return late < dist && this.T.SWITCHES.some((sw) => { const a = this.T.ahead(s, sw.s0); return a > 1.5 && a + this.T.SWITCH_LEN + 3 < dist; });
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
      if (!c.sgDeferred && c.crossed <= this.targetLaps) {
        c.sgDeferred = true; c.sgDue = c.crossed;
        this.pmsg(c, c.crossed === this.targetLaps ? 'msg.sgLastLapFinal' : 'msg.sgLastLap', 'bad');
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
    if (c.status !== 'running') return;
    c.finished = true; c.finishTime = tCross; c.laneReq = false; c.sgLeave = false; c.sgCtl = false; c.sgPhase = null; this.clearPitIntent(c); c.pitPlan = false; c.routeHold = -1;
    if (this.firstFlagT < 0) this.firstFlagT = tCross;
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
      if (c.human) {
        if (first) c.routeHold = -1;
        this.syncRoute(c);
        // awarded after the last entrance it could be served at: still owed, and the consequence is shown now
        if (first && c.sgDue > this.targetLaps && !c.finished && !this.practice) this.pmsg(c, 'msg.sgLate', 'bad');
      }
    }
    this.emit({ type: 'offence', car: c, other, n: c.offences, cause, stop });
  }

  /** Judge a fresh rear-end impact (rear closing on front faster than PEN.impactRel) and attribute it. */
  judge(rear: Car, front: Car): void {
    if (rear.mode !== 'race' || front.mode !== 'race') return;          // pit-lane shuffles don't count
    if (rear.retire || front.retire) return;                               // nobody is driving a retired car, so no one is to blame
    if (Math.abs(rear.z - front.z) > 1) return;                            // different bridge levels (cannot touch anyway)
    if (rear.v < PEN.minSpeed) return;                                     // crawling / grid contact
    const pushed = rear.pushedT > 0;                                       // we were just hit from behind ourselves
    // Contact grace (respawn / re-slot, pit exit, start, an away car's rejoin #74) waives the contact for BOTH cars, as it
    // always has: a car merging or re-slotting is never blamed for touching the car ahead, nor anyone for running into it.
    // #76: the car it shoves is still marked as pushed, and since the shove itself was waived, so is the contact that shove
    // causes with the next car (no offence, no voided lap), along the whole chain. Without this the shoved car carried the
    // blame onward and the car with grace could aim it. Grace stays symmetric (not only for a car hit from behind) so the
    // existing re-slot / pit-exit / start rules are unchanged; only the chain behind such a contact is new.
    const free = rear.graceT > 0 || front.graceT > 0 || rear.recoverT > 0 || front.recoverT > 0 || (pushed && rear.pushedFree);
    front.pushedT = PEN.chainWindow; front.pushedFree = free;             // front may now be shoved into the next car
    if (free) return;
    rear.lapValid = false; front.lapValid = false;                         // collision-affected laps never set records
    if (pushed) return;
    const cutIn = front.change !== null || front.cutT > 0;                 // front moved into our lane just now
    if (cutIn) this.offence(front, rear, 'cut'); else this.offence(rear, front, 'rear');
  }

  // ---------------------------------------------------------------- collisions
  /** pairs currently in contact (indexed a.idx*4+b.idx, a<b): a new incident needs clear separation first */
  touching: boolean[] = [];
  /** diagnostics for tuning: defensive decisions made / executed / rejected for safety / rejected for no gap */

  collide(): void {
    // a car held for an away driver (#74) is out of collisions, like a de-slotted, towed or parked one
    const act = this.cars.filter((c) => (c.mode === 'race' || c.mode === 'pitlane') && !outOfTraffic(c));
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const key = Math.min(a.idx, b.idx) * 4 + Math.max(a.idx, b.idx);
      const g = this.T.gapS(this.s(a), this.s(b));
      if (Math.abs(a.d - b.d) >= this.T.CAR_W || Math.abs(g) >= this.T.CAR_LEN + PEN.separateGap) { this.touching[key] = false; continue; }
      if (Math.abs(g) >= this.T.CAR_LEN) continue;
      let front = g > 0 ? b : a, rear = g > 0 ? a : b;
      const qa = this.squeezeQ.indexOf(a), qb = this.squeezeQ.indexOf(b);
      if (qa >= 0 && qb >= 0) { front = qa < qb ? a : b; rear = front === a ? b : a; }
      const gap = this.T.gapS(this.s(rear), this.s(front));
      const overlap = this.T.CAR_LEN - gap;
      if (overlap <= 0) continue;
      // a car backing into the one behind takes the whole correction, so no car is ever shoved backwards by it
      if (front.v < 0) front.u += overlap;
      else { rear.u -= overlap * 0.75; front.u += overlap * 0.25; }
      const rel = rear.v - front.v;
      const backing = front.v < 0 || rear.v < 0;
      const fresh = !this.touching[key];
      this.touching[key] = true;
      // contact with a reversing car is resolved but never judged as a rear-end offence
      if (fresh && rel > PEN.impactRel && !backing) this.judge(rear, front);
      if (rel > 0) {
        const vc = (rear.v + front.v) / 2, e = 0.35;
        rear.v = (vc - (e * rel) / 2) * 0.93;
        front.v = (vc + (e * rel) / 2) * 0.97;
        // the reverser stops against the car it backed into, and neither car is sent backwards (forward contacts never go negative)
        if (backing) { rear.v = Math.max(0, rear.v); front.v = Math.max(0, front.v); }
        front.slip += rel * 0.015; rear.slip += rel * 0.01;
        if (rel > 0.8 && rear.bumpT <= 0) {
          rear.bumpT = 0.25; front.bumpT = 0.25;
          this.emit({ type: 'bump', car: rear, other: front, power: Math.min(1, rel / 8) });
        }
      }
    }
  }

  pose(c: Car): void {
    if (c.mode === 'off' && c.off) { c.x = c.off.x; c.y = c.off.y; c.h = c.off.yaw; c.z = c.off.z; c.roll *= 0.9; c.pitch *= 0.9; return; }
    const s = this.s(c);
    const p = this.T.point3(s, c.d);
    const wob = c.wobble > 0.02 ? Math.sin(this.t * 38 + c.idx) * c.wobble * 0.2 : 0;
    const jig = c.bumpT > 0 ? Math.sin(this.t * 70) * c.bumpT * 0.3 : 0;
    c.x = p.x; c.y = p.y; c.h = p.h + c.yawOff + wob + jig; c.z = p.z;
    c.roll = this.T.rollAt(s); c.pitch = Math.atan(this.T.slopeZ(s));
  }

  /** Authoritative snapshot of the whole race (see RaceSnapshot). */
  snapshot(): RaceSnapshot {
    const idOf = (slot: number): DriverId | null => (slot < 0 ? null : this.cars.find((c) => c.idx === slot)?.id ?? null);
    const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);
    return {
      v: 1, track: this.T.DEF.id, laps: this.targetLaps, practice: this.practice,
      phase: this.phase, t: this.t, raceTime: this.raceTime, goT: this.goT, lights: this.lights, firstFlagT: this.firstFlagT,
      finishWindow: fin(this.finishWindow), timeLimit: fin(this.timeLimit),
      cars: this.cars.map((c) => ({
        id: c.id, slot: c.idx, control: c.human ? 'human' : 'ai', name: c.name, color: c.color, num: c.num, bay: c.bayHome,
        setup: c.setup.id, tuning: c.setup.tuning,
        status: c.status, dqReason: c.dqReason, dnfReason: c.dnfReason, finished: c.finished,
        mode: c.mode, u: c.u, v: c.v, d: c.d, laneSide: c.laneSide, change: c.change ? { ...c.change } : null,
        x: c.x, y: c.y, z: c.z, h: c.h, roll: c.roll, pitch: c.pitch, yawOff: c.yawOff, wobble: c.wobble, off: c.off ? { ...c.off } : null,
        throttle: c.throttle, brake: c.brake, fuel: c.fuel,
        crossed: c.crossed, lapsDone: c.lapsDone, lastLap: c.lastLap, bestLap: c.bestLap, lapStartT: c.lapStartT, lapValid: c.lapValid,
        finishTime: c.finishTime, pitStops: c.pitStops,
        offences: c.offences, sgOwed: c.sgOwed, sgServed: c.sgServed, sgServing: c.sgServing, timePen: c.timePen, svcBreach: c.svcBreach,
        laneReq: c.laneReq, pitReq: c.pitReq, fuelReq: c.fuelReq, fuelDue: c.fuelDue, sgDue: c.sgDue, sgDeferred: c.sgDeferred,
        routeHold: c.routeHold, laneOverride: c.laneOverride,
        revOn: c.revOn, sgPhase: c.sgPhase, sgCtl: c.sgCtl, pitWait: c.pitWait, exitReq: c.exitReq, bayInUse: c.bay,
        serviceT: c.serviceT, penalty: c.penalty, towT: c.towT, recoverT: c.recoverT, bumpT: c.bumpT,
        hiU: c.hiU, squeezeHold: c.squeezeHold, pitHold: c.pitHold, towSvc: c.towSvc, pitFuel: c.pitFuel, serviced: c.serviced, upPrev: c.upPrev,
        stallT: c.stallT, stallHold: c.stallHold, stallSvc: c.stallSvc,
        // always sent by a race that decides it; only a mirror fed by an older server holds null (unknown), and passes it on as absent
        ...(c.stallPaused === null ? {} : { stallPaused: c.stallPaused }),
        ...(c.away ? { away: true } : {}),
      })),
      pit: {
        box: idOf(this.pit.box), exit: idOf(this.pit.exit),
        bays: this.pit.bays.map(idOf), merges: this.pit.merges.map(idOf),
        order: this.pit.order.map(idOf).filter((x): x is DriverId => x !== null),
      },
      lastSeq: Object.assign(Object.create(null) as Record<DriverId, number>, this.lastSeq),
      final: this.final ? this.final.map((x) => ({ ...x })) : null,
    };
  }

  /** One driver's debrief summary (#134): final once that driver is terminal; null for an unknown driver or before the green. */
  debrief(id: DriverId): DriverDebrief | null { return this.debriefs.summary(id); }

  /** Take this step's events in wire form (and clear them). */
  drainEvents(): WireEvent[] {
    const out = this.events.map(wireEvent);
    this.events.length = 0;
    return out;
  }

  /**
   * Result rows in order. Only `finished` rows are classified and carry a time. A DQ or DNF never gets one. A car still running
   * (only mid-race; the run-out settles everyone before the results screen) shows an estimate marked `est`, never a classification.
   */
  results(): { car: Car; time: number; est: boolean; status: CarStatus }[] {
    return this.order().map((c) => {
      if (c.status === 'finished') return { car: c, time: c.finishTime + c.timePen, est: false, status: c.status };
      if (c.status !== 'running') return { car: c, time: NaN, est: false, status: c.status };
      const prog = Math.max(1, c.u - this.T.FINISH_S);
      const remain = this.targetLaps * this.T.L - prog;
      const avg = prog / Math.max(1, this.raceTime);
      return { car: c, time: this.raceTime + remain / Math.max(4, avg) + c.timePen, est: true, status: c.status };
    });
  }
}
