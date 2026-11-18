# Post-race debrief (#134)

After a race the results card shows a compact personal debrief: the result, pace and consistency, progress against a compatible personal best, incidents, pit and recovery time, penalties, and one short takeaway. It is shown for local races, championship rounds, connected solo, connected championship rounds and multiplayer. The standings table, career sync messages and the Race Again / Continue / Rematch / Leave actions stay where they were: the debrief sits under the standings, and on a phone its breakdown is folded under the takeaway (one tap expands it) while the action row stays pinned at the bottom of the card.

## Where the numbers come from

- **One collector, in the race core.** `src/debrief.ts` (`DebriefCollector`) is owned by every `Race` (`race.debriefs`, summary via `race.debrief(id)`). It sees every race event as it is emitted (`Race.emit`) and observes every car once per simulation step, after every transition of that step (moves, contacts, the bounded end and stopped-on-track recoveries) and before a close can run the field on. It only reads race state: nothing in the simulation reads it back. Collection uses race time (`race.raceTime`), so the countdown, a paused game, frame rate, snapshot rate and the server's catch-up never change a duration.
- **Local races and championship rounds** read the summary from the browser's own `Race` when the results card is drawn.
- **Online races** read it from the server's result envelope (`envelope.debrief`), which the room server fills from its own `Race` when the race completes. The browser never builds an online debrief from the events or snapshots it received: its mirror race has no metrics of its own.
- **Bounded.** Each car has a fixed set of running sums (Welford mean and variance for the laps, counters and durations): no lap list, event list or snapshot history. A summary is about 400 bytes of JSON per human, whatever the race length.

## Collection window

From the green light (the first step out of the countdown) until **that driver's own terminal result**: the finish, a DQ or a DNF (finish window, time limit, run-out, retirement). The step in which the car becomes terminal freezes its summary; afterwards nothing is added: not the cool-down lap after the flag (driven by the AI), not the AI run-on (`runOut` locally, the accelerated `RUNON_STEPS` on the server), not a de-slot or contact after the finish, not time spent watching. A visit still under way at that moment is closed then and named in `open` (shown as a note). A new `Race` (Race Again, a rematch, the next round) starts every figure from zero.

## Metric definitions (`DriverDebrief`, model version 1)

| Field | Definition |
| --- | --- |
| `laps` | Laps completed: the race core's `lap` events for this driver while running (the flag lap included). |
| `valid` | **Valid flying laps**: laps the race core marks valid (`lap.valid`: all three sectors in order and not voided by a pit entry, contact, a de-slot, reversing, a tow or a stopped-on-track recovery) **and** not lap 1, which starts from the grid (a standing start). |
| `best`, `bestLap` | The fastest valid flying lap (seconds) and its lap number. `null` without one. A fastest lap on the flag lap counts (the core emits the flag lap before classifying the finish). |
| `mean` | Mean of the valid flying laps (seconds). |
| `sd` | **Consistency**: the standard deviation of the valid flying laps in seconds (population form, the spread of the laps driven). Lower is more consistent. `null` (an em dash on the card) with fewer than two valid flying laps. |
| `deslots`, `offS` | De-slots (`deslot` events), and the time the car spent off the slot (mode `off`) until the marshal put it back. |
| `offences` | Collision offences **charged to this driver** (`offence` events naming it: rear-end or cut-in). |
| `stopGos` | Of those, the offences that awarded stop-and-go time (`offence.stop`). |
| `hitBy` | Offences charged to **another** driver for contact with this car (this car is the `offence.other`). Being hit is never counted as an offence of your own. |
| `served` | Stop-and-go penalties served in the box (`served` events). |
| `tows` | Out-of-fuel tows (`tow` events). |
| `recoveries` | Stopped-on-track recoveries (`recover` events, #69). |
| `pit.visits` | Visits the driver entered through the pit entrance (the car's mode changes from the road to the pit lane). |
| `pit.fuel` | Of those, visits with a stop in the car's bay (it turned in: mode `bayIn`). `visits − fuel` visits had no bay stop (a stop-and-go only, or a drive-through). The race core's own `pitStops` also counts tows, so it is not used for this. |
| `pit.s` | Time from the pit entrance to the pit exit (the car back on the road), summed over the visits. |
| `pit.bayS` | Part of `pit.s`: in the bay (turning in, service, departure). |
| `pit.serveS` | Part of `pit.s`: standing in the box serving a stop-and-go (`sgServing`), including any service lost by moving early. |
| `pit.queueS` | Part of `pit.s`: held by the shared pit queue or the exit yield (`pitHold` in the pit lane). |
| `forced.towS` | Time from running dry (the tow) to the pit exit: the tow wait, the bay, the tow penalty and the drive out. |
| `forced.penS` | Part of `towS`: the car held in its bay by the tow penalty (`penalty > 0` in service). |
| `forced.recS` | Time from a stopped-on-track recovery to the pit exit. |
| `open` | `pit`, `tow` or `recover` when that visit was still under way at the driver's terminal result (closed at that moment), else `null`. |

Durations are rounded to the millisecond; the card shows laps to 0.001 s and durations to 0.1 s.

### Interval boundaries and overlap

- Each step's time goes to the state the car is in **at the end of that step**, so every interval is exact to within one simulation step (1/120 s); the tests hold each scenario to two steps.
- A visit opens on the step the car is first seen in the pit lane after the road, or on a `tow` / `recover` event; it closes on the step the car is back on the road, or at the driver's terminal result.
- At any moment a car is in **at most one** of a driver-entered visit, a tow and a recovery. A car that runs dry inside a pit visit ends that visit there and starts the tow: `pit.s + forced.towS` is the whole time from the entrance to the exit, never more.
- Inside a driver-entered visit at most one component counts per step (bay first, then the box, then the queue), so `bayS + serveS + queueS ≤ pit.s` and the card lists them as "includes …", never as an extra total. The remainder is driving through the lane at the pit limit.
- **Served penalty time is time spent; an added time penalty is separate.** `serveS` is time in the box, already part of `pit.s`. A classification time penalty (`Standing.timePen`, added to the race time) is shown under Penalties on its own and is never added to any measured duration.
- Everything is **time spent**, not time lost: a pit visit takes time even in a good race, and no counterfactual finish time is ever computed.

## Progress: personal best

The comparison is between this race's best valid lap (the race core's `bestLap`, the value records and server bests are made of) and a **compatible personal best read before the race**, so a lap set in this race is never its own baseline:

- **Local** (races and championship rounds): when the race is started (also on Race Again), the fastest row with the driver's initials on this device's race board for the same circuit and the same setup at its current tuning (`R.personalBest('race', …)`). The board is per circuit, setup and tuning (#133) and the race board only holds race laps, never practice; local boards carry no rules version (they are this build's). A baseline that fell off the board's top ten is simply unavailable.
- **Online**: only for a signed-in driver. When the race starts the page reads the account's career bests (`/api/profile/stats`); it keeps them only if they arrive before that race's result. At the result, a best counts only with the same circuit, circuit layout version, mode, rules version, setup and tuning as the envelope; earlier results shown in the same tab for the same account and key count too (their storage may still be pending). The baseline is fixed when the result is first shown, so a resend or reconnect never compares the race with itself.
- No compatible baseline (a guest online, a first race on a setup, an incompatible layout, mode, rules, setup or tuning, or bests that did not arrive in time): **no comparison** is shown and no "new PB" is claimed.

The card says "New PB: 0.240 s quicker than your previous best of 14.240 s", "Equalled your best…" or "0.312 s off your best…".

## Takeaway

One line, from fixed rules in a fixed order (`takeaway()` in `src/debrief.ts`), each using only figures the card shows:

1. DQ: its reason (stop-and-go not served, deferred fuel stop not served, missed service deadline).
2. A new personal best: "New best lap: 0.240 s quicker".
3. Tows: "Ran dry N× — pit for fuel before the tank empties".
4. De-slots: "N de-slots — focus on corner entry speed".
5. Offences charged: "N contact offences — leave more room to the car ahead".
6. Stopped-on-track recoveries: "Stopped on track N× — keep moving, or reverse clear".
7. DNF: "Did not finish after N laps".
8. Fewer than two valid flying laps: "Valid flying laps: N — clean laps give a pace and consistency score".
9. A classification time penalty: "+N s time penalty this race".
10. Otherwise: "No incidents or penalties this race".

Without a summary (an older result) there is **no takeaway**: a clean race is never inferred from missing metrics.

## Pending results

Online, a driver who is done while others still race sees the pending card (no positions, nothing estimated) with "Your debrief arrives with the final classification." No personal summary is shown until the server's final result, which is the only source of the online debrief, the final placing and career awards.

## Compatibility

The static site deploys on merge; the room server is upgraded by hand later; older tabs stay open.

| Page | Server | What happens |
| --- | --- | --- |
| new | old (before #134) | The envelope has no `debrief`. Each results card shows "Debrief unavailable" with the result line only: no figures, no zeros, no takeaway. Everything else is unchanged. Local races have the full debrief. |
| old | new | The envelope carries an extra `debrief` field the old page never reads (it renders the fields it knows). Nothing else on the wire changed. |
| new | new | The card shows the server's summary for this seat. |

- **`PROTOCOL_VERSION` stays 2.** No message, field or snapshot changed: the only addition is an optional top-level field of the result envelope, which every client receives as opaque data.
- **`RULES_VERSION` stays `race-core-2026.11.8`.** Collection never changes the race: the same seed and inputs give the same events and snapshots (see below), so results and personal bests stay comparable.
- **`ENVELOPE_SCHEMA` stays 1.** `debrief` is optional and additive (`{ v: 1, drivers: DriverDebrief[] }`, completed races only); readers check `debrief.v` (`DEBRIEF_VERSION`) and every field (`readDebrief`), and treat anything missing, of another version or malformed as unavailable. A later, incompatible summary model raises `debrief.v`, not the envelope schema. The digest covers the debrief like every other field, so a stored, spooled or resent envelope is identical byte for byte; an envelope stored before #134 keeps its digest and simply has no debrief.
- **No database migration.** The summary lives inside the envelope JSON already stored in `race_results`; no table, column or award changes. An older server runs against the same database unchanged.
- **Idempotent.** The debrief is part of the one immutable envelope per race: duplicate consumption is `duplicate`, a resume or resend delivers the same envelope, and awards are computed exactly as before (they never read it).

## Simulation unchanged

- `test/carSetup.test.ts`'s four pinned seeded digests (every event and a snapshot every 30 steps) still result.
- A scratch harness hashing 20 seeded races (five circuits × all-AI, a scripted human with three AI, two scripted humans with mixed setups on the live run-on, and an all-AI Sprint; every event and a snapshot every 30 steps) gives identical digests before (`9ba30bf`) and after.
- `test/server/snapwire.test.ts`: the room server's seeded two-human race. The envelope's only new key is `debrief`; with it removed, the previous envelope digest (`fa2c3efc…efce55`) still results.

## Tests

- `test/debrief.test.ts`: lap validity (lap 1, invalid laps, no / one valid lap, a flag-lap best, laps after the finish), a real race against the core's own lap events; scripted scenarios with exact durations within one or two steps: a combined pit visit (queue, stop-and-go service, bay; components never summed), a tow from the road (its penalty held in the bay; not a fuel visit), running dry inside a pit visit (no double counting), a stopped-on-track recovery, a de-slot, an offence charged against being hit; freezing at a retirement mid-visit, after the flag, a DQ; a rematch starting from zero; bounded size; the takeaway rules; the personal-best comparison and the local baseline; reading a received summary.
- `test/server/debrief.test.ts`: a two-human server race with a dropped and resumed seat: one summary per human in the envelope, frozen at each driver's terminal step (the run-on adds nothing), equal to a local replay of the same seed and inputs (`runOn: 'sync'`, as the browser), duplicates and resends, an older envelope, an aborted race.
- `test/server/debrief.db.test.ts` (PostgreSQL): an envelope spooled while the database is down and replayed by a fresh process, stored byte for byte, awarded once, a duplicate a no-op; an envelope from before debriefs stored and listed as before.
- Browser: `node scripts/browser-check.mjs debrief` (desktop and emulated touch, see [validation.md](validation.md)); online browsers: `node scripts/online-check.mjs debrief`.

Results on `3bcc152`'s code with the final check scripts (SwiftShader, diagnostics; local servers only): `debrief` 18/18, `responsive` 251/251, `touch` 53/53, `championship` 9/9, `racelength` 36/36, `carsetup` 30/30, `netbanner` 49/49, `online` 3 pass + 1 n/a (default build); `online-check debrief` 8/8, `lengths` 10/10, `setups` 10/10. `npm test` 1072 passed, 35 skipped (the database files without a database); `npm run test:db` 35/35 in 7 files.

## Limitations

- Local personal bests are this device's board (top ten per circuit, setup and tuning, by initials): a slower personal best that dropped off the board is unavailable, and two people sharing initials on one device share a baseline.
- Online comparisons need a signed-in account and the career read at the race start; a guest gets no comparison.
- The pending card does not show a provisional summary; the online debrief appears with the final result.
- `timePen` (a classification time penalty) is shown when present, but the current rules never award one.
