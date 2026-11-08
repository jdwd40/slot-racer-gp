# Service obligations, deferral and disqualification

A stop-and-go stays owed until it is served. A pit visit the player puts back a lap must be made on that lap. If a deadline is missed, or a stop is still owed when the car finishes, the car is **disqualified when it crosses the line at the end of its final lap**. Unserved stops are no longer turned into time penalties. Lane routing is in [pit routing](pit-routing.md). Recovery by reversing is in [reverse](reverse.md).

## Visit reasons

Each reason is stored apart from lane routing (`pitReq`, `laneOverride`), so entering the pit lane or clearing an arrow never clears a debt.

| Reason | Field | Owed? | Cleared by |
| --- | --- | --- | --- |
| Optional fuel request (P) | `fuelReq` | No. Cancelling it, missing the entrance or reaching the flag with it on costs nothing | Entering the pit lane, cancelling with P, a tow or the flag |
| Committed fuel stop | `fuelDue` (lap) | Yes, by the end of lap `fuelDue` | Standing in a bay in `service` for `SERVICE_READY` (0.5 s, the time before the car may leave). A full tank is fine. Driving through the pit lane, a bay that is only being entered and a tow's service do not count |
| Stop-and-go | `sgOwed` (seconds), `sgDue` (lap), `sgDeferred` | Yes, by the end of lap `sgDue` | `sgOwed` seconds of continuous stationary time in the box. Moving off restarts the count |

The reasons are independent. One visit can serve the stop-and-go in the box and then the fuel stop in a bay, and clearing one never clears the other.

## Deadlines

Laps and approaches are numbered so that the pit entrance on lap *n* is approach *n*. On every circuit the entrance is 20 m before the timing line, and the box and all bays are before it.

- **Lap** is `crossed`, which only increases. A deadline "by the end of lap *n*" is judged at the forward timing-line crossing that makes `crossed` reach *n* + 1.
- **Approach** is `Race.apprLap()`, counted from `hiU`, the furthest distance the car has ever reached. Reversing over the entrance, a de-slot re-slot behind it, a tow or a pause can never bring an approach back.
- **A new stop-and-go** is due on the first entrance the car can still make (`firstReachableAppr()`): the one physically ahead of it, or the one after if `reachablePitEntry()` says that one is already out of reach, but never earlier than its current approach (`apprLap()`). So a car that reversed back short of an entrance it had already passed is due on the next lap's entrance, not one lap later still. **More stop time** from a later offence adds seconds and keeps the existing deadline and deferral.
- **A committed fuel stop** is due on the lap after the one it was deferred from.

At the crossing that ends lap *n*, for each obligation due by then and still owed:

| Obligation | Deferral unused and lap *n* + 1 exists | Otherwise |
| --- | --- | --- |
| Stop-and-go | Uses its one deferral automatically: due by the end of lap *n* + 1, "last chance" message | Breach |
| Committed fuel stop | Never: committing it already used the deferral | Breach |

A **breach** (`svcBreach`) is latched at once, announced immediately (`msg.breachSg` or `msg.breachFuel`, a "DEADLINE MISSED" flash and a red `DEADLINE MISSED · DQ AT FLAG` chip), and never cleared. Routing stays on, so the stop can still be settled, but serving it later cannot remove the breach. The disqualification is applied at the finish, not at the missed approach.

Service can be completed at any time up to the deadline crossing, including after reversing back to the entrance before the line. Serving early is always allowed.

## Deferring

**Defer to next lap** is the N key, or the touch **Defer** button, which appears above Pit only while deferral is available. `Race.deferBlock()` decides this, and the HUD, the touch pad and `requestDefer()` all use it.

| Allowed when | Refused (message) |
| --- | --- |
| Racing, on the road, with an optional request or an obligation due on this approach | Practice or countdown (nothing shown), nothing to defer (`msg.deferNone`), already in the pit lane (`msg.deferPit`) |
| The approach has not already been deferred | Already deferred (`msg.deferHeld`) |
| Every obligation due now still has its deferral | Deferral used, or overdue (`msg.deferUsed`) |
| Another lap remains | Final lap (`msg.deferFinal`). The car must queue and serve |

What a deferral does:

- An optional fuel request becomes a committed fuel stop, due by the end of next lap. From then on Pit cannot cancel it (`msg.pitDue`).
- A stop-and-go due on this approach moves to the next lap and uses its one deferral.
- Routing is released for this approach only (`routeHold`): no outside route, no entry, and the touch Pit button shows `⏭ next lap`. Once the car is past the entrance, routing re-arms for the next approach. Pressing Pit while the approach is held puts the route back ("stopping this lap") and changes no deadline.
- Driving past a requested entrance after using the one-switch lane override on that approach counts as deferring the optional request (`msg.fuelOverride`). Missing it without an override, for example when a switch was blocked, leaves the request optional and armed.

Repeated N or P presses, lane overrides, reversing, pauses, tows, re-slots and further offences cannot move a deadline later or give a deferral back.

### Occupied box

If another car is in the stop-and-go box or holds its reservation (see [pit queues](pit-queue.md)), the car still routes in and queues by default. While another lap remains and the deferral is unused, the status line says "box occupied — queue, or defer one lap", and Defer is offered. On the final lap it says "queue: final lap, no deferral". A manual lane override cannot waive the stop.

### Late awards

A stop-and-go awarded after the final lap's last reachable entrance (`sgDue > LAPS`) is still owed. The player is told at once (`msg.sgLate`), and the chip reads `NO ENTRY LEFT · DQ AT FLAG`. Reversing back to the entrance before the line and serving it is allowed under the normal reverse rules, and then the car finishes normally.

## The finish

At each car's final forward timing-line crossing (`lapsDone` reaches `LAPS`), in this order:

1. Service earlier in the same simulation step is already applied: the box is counted in the pit-lane step before lap counting, and bays come before the line.
2. Deadlines for the lap just ended are judged as above.
3. The car is disqualified if a breach was already latched (`deadline`), a stop-and-go is still owed (`stopGo`), or a committed fuel stop is still owed (`fuel`). Otherwise it is classified.

A disqualification sets `status = 'dq'` and `dqReason`, emits one `dq` event and no `finish` event, and ends the car's race (`finished = true`, so the session ends 3.2 s later as usual). Crossing the line again changes nothing. Practice never finishes and never disqualifies.

## Results

`Car.status` is the terminal result: `running`, `finished` (classified), `dq` or `dnf`. `finished = true` alone never classifies a car.

- **Order:** classified finishers by finish time plus any existing `timePen`, then running cars by distance, then DNF, then DQ.
- **Run-out:** when the race ends (3.2 s after the player's last crossing), `Race.runOut()` runs the rest of the field to the flag without rendering, for up to `RUN_OUT_MAX` (240 s simulated). Every car gets a real result. A car still running after that is a DNF. Before this, cars still running were given an estimated time and could score.
- **Results screen:** a DQ row shows `DQ` with its reason and no position. The player sees "You were disqualified · …" and no trophy.
- **Championship:** `R.roundRecord()` stores classified finishers first with their times, then DNF (`dnf: true`) and DQ (`dq: true`) entries, which score nothing (`R.roundPoints()`). Round tables show `DQ`.
- **Records:** a disqualified final lap is never submitted to the race board. Laps completed earlier in the race stay. Practice records, ghosts and existing saves are untouched.
- **Existing penalties:** `timePen` is no longer added by anything, but a value already present stays and still counts in a classified time.

## Save compatibility

Championship saves stay at `v: 1`. `dq` is an optional field: older saves have none, load unchanged and score exactly as before (tested in `test/records.test.ts`). Leaderboards and ghosts use unchanged keys and formats. A new or restarted race builds fresh cars, so every obligation, hold and breach starts clear.

## HUD

| State | Shown as |
| --- | --- |
| Optional request | Cyan `⛽ FUEL STOP REQUESTED · OPTIONAL` chip, Pit `✓ armed` |
| Deferred (approach released) | Yellow `⏭ DEFERRED · PIT NEXT LAP` chip, Pit `⏭ next lap` with a dashed orange border |
| Due / next / overdue | `■ STOP-AND-GO · DUE THIS LAP / DUE NEXT LAP / OVERDUE` and `⛽ FUEL STOP · …` chips, and the status line. Pit `■ must stop` |
| Deferral available | Keyboard: `N DEFER TO NEXT LAP` chip. Touch: the Defer button |
| Serving | "SERVING STOP-AND-GO · n s — stay still", or "stay n s for the fuel stop to count" in the bay |
| Fulfilled | "Penalty served" or "Fuel stop done — obligation cleared" message, and "fuel stop done ✓" in the bay |
| Breach | Red blinking `DEADLINE MISSED · DQ AT FLAG` chip, flash and message |
| DQ | `DQ` flash, `DQ` flag in the standings and results, reason on the results screen |

In portrait, the meters and messages move up by one button height while Defer is shown, so nothing lands on a control.

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader (ANGLE, Vulkan, software), and touch was Chromium emulation through CDP. **They are diagnostics only and say nothing about behaviour or smoothness on a real phone, tablet or GPU.** No physical device was tested.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass, 305 tests in 12 files. `test/obligations.test.ts` adds 28, and the penalty, routing, reverse, input, records and tracks tests were rewritten for the new rules |
| AI determinism | 10 seeded all-AI races (5 circuits × 2 seeds, up to 200 s) against baseline `525b55b`. Nine are identical (position, speed, fuel, laps, stops, offences, stop owed, best lap). The tenth (circuit-4, seed 2) reached the flag inside 200 s. It matches up to the end of the race, and its finish times are identical. The only difference is that a car the baseline left with an estimated time now gets a real finish (189.93 s) from the run-out |
| `service` browser scenario (new) | 16 of 16, run twice (on `99b63f3` and `254ba32`). Covers keyboard N and touch Defer, refused toggles, route release and re-arm, breach shown at once, DQ on the results screen and in a championship round, Defer layout at 360×640 and 640×360, and the final lap with the box occupied |
| `tracks`, `race`, `controlled` | 6, 23 and 17 passed on `99b63f3`. The one `controlled` n/a, real window blur and tab switch, was already there. `controlled` now checks that an unserved stop disqualifies at the flag |
| `routing`, `practice`, `championship`, `reverse` | 16, 10, 9 and 9 passed on `254ba32` |
| `touch`, `responsive`, `touchrace` | 53, 71 and 7 passed on `254ba32`. `responsive`'s crowded HUD now includes both service chips and the breach chip |

Browser setup: headless Chromium 156.0.8078.4, Linux 7.0.0-42-generic x64, Node 26.7.0, 480×270 at Low unless a scenario sets its own size. All runs are bounded by `--max-minutes`.

`test/obligations.test.ts` covers:

- **Optional requests:** never requested, missed without an override, cancelled, still armed at the flag.
- **Deferring:** the first deferral and its re-arm, a second N, P bringing the route back, P refused, the lane override as a deferral, the final lap, practice, the pit lane, and de-slot or tow.
- **The box:** occupied before and on the final lap, a used deferral, added stop time, continuous service, a late award and recovering it by reversing.
- **Fuel service:** drive-through, entering the bay, departure-ready time with a full tank, a tow, combined service, service after the breach.
- **The final crossing:** service before the line, a deadline on the final lap, same-step ordering, practice.
- **Robustness:** reversing, re-slots, pause and a fresh race.
- **Settlement:** a DQ reaching results with no wait, the run-out, DNF, and championship scoring.

Save compatibility is tested in `test/records.test.ts`.

### Known limits

- Scripted placement (`__game.advance` and direct state) sets up the browser situations, so they are functional coverage, not play-testing. No full race was played to a DQ in real frames.
- The run-out simulates up to 240 s in one frame when the race ends. That is a single pause while the results screen opens. It was not measured on a real device.
- The touch Defer cue is short (`⏭ next lap`). Its consequence is in the toast on tapping, the touch hint and the HUD chip.
