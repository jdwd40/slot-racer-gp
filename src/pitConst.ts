// Pit-queue tuning constants (see docs/pit-queue.md). A leaf module with no imports: the race core (src/race.ts) derives its
// own constants from these (AUTO.window) and the shared pit traffic (src/pit.ts) reads them, and neither has to import the
// other for a value (#106; pit.ts only takes the Car and Race types from race.ts, which are erased at build time).

export const PIT_Q = {
  gap: 0.5,          // clear slot kept behind a stopped leader (beyond bumper contact)
  decel: 20,         // braking the assisted speed cap plans with (m/s²); the cap itself is enforced at up to 45
  leadBrake: 30,     // braking assumed for a moving leader
  look: 40,          // obstacles further ahead than this are ignored
  approach: 40,      // road distance before the pit entrance in which a routed car joins the queue
  hold: 0.6,         // an assisted cap below this (m/s) holds the car: it is queued
  join: 2,           // a road car whose queue cap comes within this (m/s) of its speed is braking for the queue: it joins it
  mergeSpacing: 4,   // bay merges closer than this are never under way together (adjacent bays are 3 m apart)
  mergeTime: 1.0,    // seconds of a reversing car's travel a bay departure allows for
  exitWin: 4,        // yield window before the pit exit merge starts
  boxMargin: 0.4,    // a car held out of an occupied box plans to stop this far short of its entry line
};
