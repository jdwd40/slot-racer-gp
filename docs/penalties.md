# Service obligations, deferral and disqualification

A stop-and-go stays owed until it is served. A pit visit the player puts back a lap must be made on that lap. If a deadline is missed, or a stop is still owed when the car finishes, the car is **disqualified when it crosses the line at the end of its final lap**. Unserved stops are no longer turned into time penalties. Lane routing is in [pit routing](pit-routing.md). The player's stop is driven automatically: see [automatic stop-and-go](auto-stop-go.md). Recovery by reversing is in [reverse](reverse.md).

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

## Last-chance warning

A compulsory stop is on its **last chance** (`Race.lastChance()`) when it is due on the lap being raced and missing that lap's entrance would latch the breach: a committed fuel stop due this lap, or a stop-and-go due this lap whose deferral is used or that is due on the final lap. It is off in practice, after the flag, for a car that is no longer running (retired or disqualified) and once a breach is latched. It is read-only and uses only fields every online snapshot carries, so the mirror's HUD shows the same thing online as offline. The rules, deadlines and results did not change (`RULES_VERSION` is unchanged). Only messages were added.

While it holds, the HUD shows a red blinking `⚠ PIT THIS LAP — or DQ` chip (its blink never fades below 80 % opacity, unlike other blinking chips, so it stays readable on phones), first in the chip row, on the keyboard and touch HUDs alike. It goes as soon as the stop is served, and is replaced by `DEADLINE MISSED · DQ AT FLAG` if the breach is latched.

Every path to a missed-deadline DQ gets a warning that names the DQ on the due lap, at the timing line, before the entrance that decides it. That is the length of the lap minus 20 m, about 13 s at race pace on Clubman Park:

| Path | Before the due lap | At the line starting the due lap | Space on the due lap | At the line ending it, if missed |
| --- | --- | --- | --- | --- |
| Stop-and-go missed on its first lap (automatic deferral) | Offence toast with its deadline | `msg.sgLastLap`, or `msg.sgLastLapFinal` on the final lap | `msg.routeInsideDq` | `msg.breachSg` |
| Stop-and-go deferred with N | `msg.deferred` ("you MUST pit next lap or be disqualified") | `msg.pitThisLap` | `msg.routeInsideDq` | `msg.breachSg` |
| Fuel request driven past on the override (a committed fuel stop) | `msg.fuelOverride` at that entrance | `msg.pitThisLap` | `msg.routeInsideDq` | `msg.breachFuel` |
| Fuel request deferred with N | `msg.deferred` | `msg.pitThisLap` | `msg.routeInsideDq` | `msg.breachFuel` |
| Due on the final lap | As above | `msg.finalLap`, then `msg.pitThisLap` or `msg.sgLastLapFinal`, so the DQ warning is the toast left on screen. A stop-and-go awarded during the final lap gets its offence toast ("before the flag — final lap, no deferral") at once instead | `msg.routeInsideDq` | None: `msg.dq.fuel` or `msg.dq.stopGo` at the flag |
| Stop-and-go awarded after the last usable entrance | None | Not applicable: `msg.sgLate` and the `NO ENTRY LEFT · DQ AT FLAG` chip, at once | Not applicable | `msg.dq.stopGo` at the flag |

- The HUD keeps one toast, so at a crossing that posts several messages the player sees the last one. The order is: `msg.finalLap` ("Final lap!"), then the deadline judgement (`msg.sgLastLap*`, or `msg.breachSg` / `msg.breachFuel`), then `msg.pitThisLap`. So a DQ-worded message always ends up on screen. Before the review of #65, `msg.finalLap` came after the deadline judgement and hid `msg.sgLastLapFinal` when a stop-and-go was automatically deferred onto the final lap. The tests assert that each warning is the last message of its simulation step.
- `msg.sgLastLap` is "Stop-and-go not served — last chance: serve it this lap or be disqualified". The words "or be disqualified" were added in #65. `msg.sgLastLapFinal` and `msg.deferred` already named the DQ.
- `msg.pitThisLap` is "Compulsory stop due this lap — pit at this lap's entrance or be disqualified". It is posted once, at the crossing that starts the due lap, unless that crossing has just posted `msg.sgLastLap*` for an automatic deferral.
- `msg.routeInsideDq` replaces `msg.routeInside` when the one-switch override is armed during a last chance: "Inside lane: skipping this lap's compulsory stop means disqualification". The override still works as before.
- Before #65, a fuel stop committed by an override was announced only at the entrance it was committed at (`msg.fuelOverride`, "compulsory next lap", with no mention of a DQ). On the due lap there was only the orange `FUEL STOP · DUE THIS LAP` chip, and `msg.routeInside` on Space. Repeated overrides, as from the test bot in #65 that pressed Space every 8 s, then led to `msg.breachFuel` and a deadline DQ with no DQ wording before the deciding entrance.
- Online, both new messages are ordinary race-core `msg` events. The room server forwards every event in `state.ev`, and each client shows only those addressed to its own driver. No protocol change was needed (`PROTOCOL_VERSION` is unchanged). A client older than the server would show the new message IDs as raw text.

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
| Last chance (see above) | Red blinking `⚠ PIT THIS LAP — or DQ` chip, first in the row, and `msg.pitThisLap` at the line. Space shows `msg.routeInsideDq` |
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

**Last-chance warning (#65).** `test/deadlineWarning.test.ts` (10 tests) drives a human car under continuous simulation on Clubman Park and records its messages and events in order to the flag. It covers a stop-and-go deferred automatically, one deferred with N, one due on the final lap, a fuel stop committed by an override and then served, one committed on the second-last lap, repeated overrides, and the bot from the issue (Space every 8 s for a whole 4-car race: 8 phase offsets on each of two circuits, 8 of the 16 races ending in a missed-deadline DQ). In every case it asserts that a DQ-worded warning comes before the entrance that decides the breach, that it is the last message of its step (the toast left on screen), and that the chip state is on from that warning through that entrance. It also checks that a retired car gets no last chance or message, that the mirror built from a snapshot reads the same last-chance state, and that the message survives the wire. 80 seeded races (5 circuits × 8 offsets, bot player and all-AI, run out to full results) gave byte-identical results, finish times, stops, offences, fuel and standings before and after the change. The `lastchance` browser scenario drives the override path with real keys at 1280×720 and on the emulated touch pad at 390×844 and 844×390. It checks the toast order, that the chip comes first and stays clear of every control, the Space warning and the breach chip replacing it. It also takes screenshots. It passed 14 of 14.

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
