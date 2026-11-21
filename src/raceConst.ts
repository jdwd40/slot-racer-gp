// Race-core tuning shared by src/race.ts and the subsystem modules beside it (#141). A leaf that imports nothing, so a
// subsystem module reads these without a value import of race.ts (no runtime import cycle). race.ts re-exports every name.

/** braking deceleration (m/s²) at full Brake: shared by every car, whatever its setup (src/race.ts) */
export const BRAKE = 30;

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

/** stationary service in a bay before the car may leave: the same time a deferred fuel stop needs to count */
export const SERVICE_READY = 0.5;
