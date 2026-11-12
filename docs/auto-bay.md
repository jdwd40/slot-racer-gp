# Automatic bay visits

After Pit is selected, the car takes the outside route, enters, queues and stops in its own bay, without manual braking. It refuels as before, then leaves when the player asks with a fresh Throttle press. If the merge or the exit is blocked, the car waits and then goes. This builds on [lane routing](pit-routing.md), [obligations](penalties.md), the [shared pit queue](pit-queue.md) and [automatic stop-and-go](auto-stop-go.md), and finishes the combined stop-and-go and fuel visit.

## Bay ownership

- `Car.bayHome` is the car's own bay for the whole race. It is the car's participant slot (`idx`), fixed when the `Race` is built: the player has bay 1 (the first down the pit lane), then Red Comet, Blue Arrow and Green Viper. `Car.bay` is separate and mutable: the bay the car currently holds or stands in. `Race.bayOwner(j)` answers who owns bay *j*. In practice only the player races, so the other three bays have no owner.
- Authority comes only from `bayHome`. `PitTraffic.updateBays` grants only the car's own bay. The player's manual capture (`tryBay`), the AI's stop, the automatic stop and both tows (road and pit lane) use only that bay. The old fallback to "the first free bay ahead" (`pickBay`) has been removed. If a car's own bay is occupied or reserved, the car **waits**. The AI and the player stop `AUTO.bayWait` (2.2 m) short of the bay, which is clear of the occupant's merge zone, so the occupant can always leave. A car never takes another team's bay.
- Colour is presentation only. `main.ts` paints each bay from `Race.bayOwner()` through `World.paintBays()`. That covers the bay lines (sides and a new back line), the crew, the pit-wall monitor and a pit board showing `BAY n`, the owner's race number (the one on the car) and its tag (`YOU`, `RED`, `BLUE`, `GREEN`). The player's board also has a border in the livery. All four liveries (Sunburst, Blaze, Frost, Violet) are supported, and bays are repainted whenever a race is built, so changing the car on the title screen repaints them. Unowned bays in practice are neutral grey with `–`. The rendering never decides who may use a bay.
- The same rule applies to AI cars, and it is keyed by participant slot, not by "human or AI". Four human participants later would each keep their own bay with no change.

## Driving

`Race.sgUpdate()` (the automatic pit controller) now drives fuel visits as well as stop-and-go visits. It runs for the player before each car step and sets `sgCtl` (the controller has the pedals) and `sgPhase` (what the HUD shows).

| Where | Phase | HUD chip / status |
| --- | --- | --- |
| Road, a fuel visit (`fuelReq` or `fuelDue`) routed to this entrance, within `AUTO.window` (40 m) and reachable | `entry`, or `queued` | **AUTO ENTRY** · "Auto entry — braking for your bay n" |
| Pit lane, stop-and-go owed | `entry`, `queued`, `serving` | As in [automatic stop-and-go](auto-stop-go.md) |
| Pit lane, fuel visit, own bay still ahead | `bay`, or `bayWait` while the bay is occupied, or `queued` | **AUTO PIT · BAY n** / **WAITING FOR BAY n** |
| Turning in, then refuelling before departure is available | `refuel` | **IN BAY n** · "REFUELLING n% · stay n s for the fuel stop to count" or "you can leave in n s" or the tow penalty |
| Departure available, Throttle still held since before | `release` | **RELEASE THROTTLE** · "release Throttle, then press it to leave". Touch Throttle reads `lift off` |
| Departure available | `ready` | **READY — THROTTLE TO LEAVE** · "press Throttle to leave". Touch Throttle reads `tap · leave` |
| Departure latched, merge not yet clear | `exit` | **WAITING FOR CLEAR EXIT** · "Waiting for clear exit — you leave as soon as it is safe" |
| Bay exit and the pit lane to the exit | `leaving` | **LEAVING PITS**, plus **WAITING FOR CLEAR EXIT** at the exit line |
| Past `PIT_OUT1` | none | "Out of the pits — you have control" |

- **Speed.** The target is the same as for the box (`sgTarget`). On the road it brakes at `AUTO.plan` to the pit limit by the entrance. In the pit lane it brakes at `AUTO.box` to rest at `Race.autoStopS()`, which is the box centre while a stop-and-go is owed, otherwise the centre of the car's own bay, or `AUTO.bayWait` short of it while the bay is occupied. The shared queue cap (`pitCap`) and the pit limiter apply on top. Throttle and Brake are ignored while `sgCtl` is set, so a held Throttle cannot overshoot. At rest within `AUTO.bayTol` (0.15 m) of the bay centre, the car turns in through `enterBay`, using the existing entry animation (0.45 s), refuel delay (0.4 s), refuel rate (0.2 tank/s), tank cap (1.0) and exit animation (0.4 s).
- **Too fast to take over.** A fuel visit, unlike a stop-and-go, is still entered. The pit limiter slows the car and the controller takes it in the pit lane. In practice the takeover test (braking of at most `AUTO.late`, 24 m/s², by the entrance) always passes below about 44 m/s.
- **Combined visit.** The stop-and-go is served first in the shared box (it lies before every bay). The controller then continues to the bay. Refuelling never changes `sgOwed`. A penalty-only visit has `pitFuel` false, is driven past the bays and never stops in one. The two debts still clear independently, as in [service obligations](penalties.md).
- **After the visit.** `serviced` is set when the car leaves the bay, the fuel request was cleared at the entrance, and a committed fuel stop clears after `SERVICE_READY` in the bay. So completing a fuel stop neither re-arms routing at the next switch nor clears another obligation (both are tested).

## Departure

- **Ready** means `Race.departBlock()` is null. The car must have stood in service for longer than `SERVICE_READY` (0.5 s, the time a committed fuel stop needs to count), and no tow penalty may be running. A full tank never leaves by itself.
- **A fresh press.** `Car.upPrev` is the Throttle seen in the bay. `enterBay` and a tow set it to "held", so a pedal held on arrival must be seen released before anything counts. A press is a rising edge in `service`. If it comes before departure is ready, it is refused with the reason ("Not yet — stay n s for the stop to count, then press Throttle" or "Not yet — tow penalty, n s left") and does not latch. Holding it through the ready moment then needs a release and another press. Keyboard and touch are the same action through `DrivingInput`. Pause, blur, a hidden tab and screen changes clear held input (`releaseDriving`), which the bay sees as a release. A key still physically down sends no new keydown, so it never departs by itself.
- **Latched.** One accepted press sets `exitReq`. Refuelling stops at that moment, for every car. The request is kept through release, pause and blur. The car stays in its bay ("Waiting for clear exit") until `PitTraffic` grants its merge under the existing [passage rules](pit-queue.md#bay-departures-and-passage-priority), then performs the exit animation once.
- **Leaving.** Back in the through lane the controller drives at the pit limit (`sgLeave`), waits at the exit line while the outside lane is blocked (`exitHold`), merges when it holds the exit, and hands back past `PIT_OUT1`, in the outside lane. If the car finishes the race in the pit lane (the timing line is between the bays and the exit), control ends there as before.

## Overrides, reverse and pause

- **Before the entrance** the existing rules apply. Defer (N) works where [penalties](penalties.md) allows it. Pit (P) cancels an optional stop and releases the controller on the road. Space takes a switch that is still ahead (an optional stop driven past on the override becomes a committed stop due next lap, which is then served automatically). With no switch left during a fuel takeover, Space is now refused ("No switch before the pit entrance — the car stops in your bay. P cancels an optional stop, N defers it if offered") instead of arming an override nothing can use.
- **Inside the pit geometry** the lane is single file. Space is refused as before, Defer and Pit do nothing, and the queue and exit rules decide who moves.
- **Reverse.** While the controller has the car, `reverseBlock()` returns `assist`, and in a bay it returns `mode`. Either refusal latches the current Brake press, so Brake held through the approach, the bay, the wait and the exit never reverses, even after the handover. A fresh press after the handover reverses as usual. A car that gets past its own bay by hand is not controlled, can reverse back, and is captured by its own bay when it is released there. Backing over the pit entrance with a fuel visit owed brings the car into the 40 m window, so it is taken over and driven in. This is the same rule as for a stop-and-go.
- Saved records, ghosts and championships are untouched. No storage keys or formats changed. `DRIVERS` gained `num` and `tag` (the race numbers 7, 11, 3 and 24 that were already painted on the cars).

## Stopped-on-track recovery

A human car must not park on the racing lane and trap the cars behind it (#69, rules `race-core-2026.11.3`). When an eligible car stops, its driver gets a three-second countdown. If it has not genuinely driven off when the count runs out, it is taken off the racing lane and put in its own bay. The driver stays in the race and leaves the bay like after any stop. There is no DQ, retirement or extra penalty; the cost is the distance lost (below).

The rule is part of the shared race core (`Race.stallUpdate()` and the methods next to it in `src/race.ts`). It runs in simulation time, so the room server owns the count online, a paused offline race does not count, and frame rate and snapshot rate change nothing.

### Who it applies to

`Race.stallBlock()` decides each step, for every car, from where the field is after all cars have moved and touched. All cars are judged before any is recovered, so array order never decides who was blocking whom.

- **Off (no count at all):** practice, AI cars, the grid and the lights, a terminal result (finished, DQ, DNF), a retired car, and anything but the racing lane (`mode` `race`): the pit lane, bays, the box, tow and de-slot all count as off. The rule starts at the green: a car that has not moved off by then gets its countdown from the green.
- **Held (a legitimate wait; the count is reset to zero):**
  - the driver is away: online, the room server has lost the link and is holding the seat for a reconnect (`Input.away`, #74; see *Online* below)
  - held by the shared pit queue, on the approach or behind it (`pitHold`), or at the pit exit (`exitHold`, `yielding`)
  - the squeeze priority hold (`squeezeHold`)
  - automatic pit control has the pedals (`sgCtl`)
  - the marshal has just re-slotted the car after a de-slot (`recoverT`, 1 s)
  - an empty tank, because the out-of-fuel tow recovers that car, so it is never recovered twice
  - **trapped**: a car slower than `STALL.goV` stands within `STALL.blockGap` of clear slot ahead on the car's own path (`Race.stallTrapped()`). This is judged along the slot, so a car on the other lane, on another level of a bridge, or out of traffic (de-slotted, towed, in a bay) is no exemption.

  Selecting Pit, holding Brake or Throttle, or asking for lane changes is none of these. An actual hold or a car ahead must exist.

### Thresholds (`STALL`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `grace` | 3 s | Simulation time stopped before the car is recovered, at the first step at or after it |
| `stopV` | 1 m/s | Below this speed (by magnitude) a car has **stopped**: an episode starts, unless the driver is pressing Throttle alone (pulling away) |
| `goV` | 3 m/s | A **resumption** must be driven at this speed or faster, under the car's own Throttle (Throttle without Brake)... |
| `goDist` | 4 m | ...for this distance without a break, about three car lengths |
| `blockGap` | 6 m | Clear slot to a slow car ahead within which a stopped car is trapped, not blocking |

The stop and resume thresholds are far apart on purpose. One frame of Throttle, a nudge forward, tiny back-and-forth or a push from behind never covers 4 m under the car's own power at 3 m/s, so none of them ends an episode. A pushed car has no Throttle in it, so a push never resumes it. From a standstill a real pull-away takes about 0.6 s to resume. The test boundaries are exact: `stopV` itself does not start an episode, and `goDist` ends it on the step it is reached.

### The state machine

Per car: `stallT` (seconds counted, 0 when no episode), `stallRun` (the unbroken run towards resumption) and `stallHold` (recovered and waiting for the bay).

1. **No episode.** Eligible, not held, slower than `stopV` and the driver is not pressing Throttle alone: an episode starts and counts this step.
2. **Counting.** Every step adds its time, except while the car rolls backwards at `stopV` or more. Reverse is the legitimate recovery manoeuvre ([reverse](reverse.md)), so it pauses the count without resetting it; the standstill that engages reverse still counts. Moving forward slowly, being pushed, flickering a pedal or nudging all still count.
3. **Resumed.** `stallRun` reaches `goDist`: the episode ends and the warning goes at once. A later stop starts a fresh three seconds.
4. **Held or off.** The episode ends (reset to 0). A car trapped in a queue that stays put after the queue clears gets a fresh three seconds of its own, never the time it spent waiting.
5. **Due.** `stallT` reaches `grace`: the car is recovered on that step. One case waits: a car already pulling away under its own Throttle at that moment is let finish that pull-away. Lifting, braking or stopping during it recovers the car on that step, so a last-moment nudge buys nothing.

In a three-car queue only the front car counts; the two behind it are trapped. If nobody moves, the front car is recovered at 3 s, the second at 6 s and the third at 9 s. If they drive off once the front car is gone, nobody else is recovered. Independent blockers (one in each lane, two levels of a bridge) are each recovered on their own count, in the same step when they stopped together.

### The recovery

`Race.stallRecover()` is a new recovery, not the out-of-fuel tow. It emits one `recover` event (for every client) and `msg.stallRecovered` ("Stopped on track — moved to pits") to its driver. It returns false and changes nothing for a car no longer on the racing lane with a running result. So a car towed, de-slotted, retired or finished on the same step is never recovered too, and a recovered car is never recovered again.

- **Off the lane at once.** The car leaves the squeeze queue. Any pit reservation is released (`recover`). A lane change in progress is completed, routing intent is cleared (as entering the pit lane clears it) and contact state is cleared. Speed, pedals, slip, reverse and every automatic hold are reset.
- **Into its own bay, only to rejoin.** The car is placed at rest in `service` in `bayHome`, holding that bay, as if it had just turned in. It is not counted as a pit stop and no penalty runs. The bay is only a safe place to rejoin from: `stallSvc` is set, so **no fuel is added** however long it stands there (the HUD says `MOVED TO PITS · NO REFUELLING · FUEL n%`). `towSvc` is set too, so standing there does not serve a committed fuel stop, and the stop-and-go box is behind it, so a stop-and-go is not served either. For fuel or service the car must make a real visit through the pit entrance.
- **Bay not free.** No other car ever uses a car's bay, so this only arises in a scripted set-up. If the bay is taken anyway, the car waits in mode `tow` with `stallHold`: out of collisions and traffic, and drawn as gone (`towT` past the tow blink). It is placed the first step the bay is free. That step emits no second event, takes no second reservation and leaves no permanent limbo.
- **Kept:** the driver, car, livery, number, `status: running`, laps, lap times and best lap, offences, `timePen`, the fuel in the tank at the moment of transfer, every stop-and-go and fuel-stop debt, deadline and deferral, a latched breach, `hiU` (approach numbering) and the sector bits.
- **Leaving.** The usual bay rules apply ([departure](#departure)): `upPrev` is set, so a Throttle held through the stop and the recovery must be released and pressed again once Ready. The fuel stays exactly as it was at the transfer. It leaves when the merge is clear and is driven to the pit exit, with the start grace there as usual. Out-of-fuel tows keep their own rules and their own time penalty; this recovery adds none.

### No shortcut

The car is moved **back** to the last place it passed its own bay (`u` falls by the distance from the bay to where it stopped), never forward. Progress (`u`) only falls, and `order()` ranks running cars by it, so a recovery can only lose distance and places. The bays are just before the timing line. So:

- Stopped anywhere from the line round to just before its bay, the car moves back over the line it last crossed. `crossed` never decreases and `laps()` counts only new crossings, so driving over that line again counts nothing. The lap is completed only at the real next crossing, and it is void (`lapValid` false), so it cannot be a best lap, a board entry or a career best. This covers the start-line wrap on lap 1 and the final lap: a car recovered mid-way round its final lap must drive the whole lap again and finishes at the real flag.
- Stopped between its bay and the line, it moves back a few metres and crosses the line once, from the pit lane, as after any stop.
- Stopped after its bay (anywhere from the bay round to the pit entrance), the stretch moved over does not contain the pit entrance. Stopped between the pit entrance and its own bay, the car moves back about a lap, over the line *and* over that entrance, and drives the same approach again. Approaches count from `hiU`, so no approach number, deadline or deferral moves. The car can use that approach once more, just as reversing back over a missed entrance already allows, at the cost of almost a lap (tested).
- Fuel: none is added in the bay (above). Stopping by the bay to be recovered and then making a real visit is never faster than the real visit alone. On Clubman Park with 0.3 fuel, 120 m before the line, to rejoin with 0.85: a real visit took 16.2 s with the box free and 20.6 s behind a 12 s stop-and-go; the recovery route took 38.2 to 38.8 s (tested for bays 1 and 4, box free and busy).

The loss is the distance driven since the car last passed its bay, from a few metres up to about a lap. It never pays to stop.

**Order on one step.** The rule is judged after the finish window and the race-time limit, so a car those classify on the same step gets that one result (for example DNF `window`) and no recovery.

**Known limits.** The rule is about stopped cars, as the issue asks. A car crawling at `stopV` or more, or one that hops (stops for under 3 s, drives the 4 m at 3 m/s, stops again), never completes a count. Followers can pass it at the switches. Reversing on an empty road pauses the count for as long as it continues; reversing into a car behind stops the car, and the count then runs. A rolling minimum-progress rule could be a follow-up.

### Player feedback

- While the count runs, the driver's HUD shows a red blinking chip, first in the row, `⚠ MOVE YOUR CAR · PITS IN n`, and the status line `⚠ Move your car — pit recovery in n…` with n going 3, 2, 1 (`stallLeft()` in `src/hud.ts`). Both are words and a number, not colour alone. They sit where the other service chips and status lines sit, which the responsive checks keep clear of the touch pad. Both clear the moment the car resumes, is held or is recovered.
- On recovery: `Stopped on track — moved to pits` to the driver, and `<name> stopped on track — moved to the pits` to everyone else. In the bay, the usual `IN BAY n`, Release Throttle and Ready prompts follow. Waiting for a taken bay shows `Stopped on track — moved to pits · waiting for bay n`.
- The pause help (`ctl.rules`) states the rule.

### Online

The server's race core counts, decides and recovers. Snapshots carry `stallT`, `stallHold` and `stallSvc` per car; both are additive, and the mirror copies them, so the HUD reads the server's count. The recovery goes out once as the ordinary race event `{ type: 'recover', car }`, with the personal message alongside. There is no new message type and no extra message loop. A reconnect gets the current state, with no events replayed, so a recovery is never repeated.

**A driver whose link is down is held, not recovered (#74, rules `race-core-2026.11.4`).** The reconnect banner promises "your car is held where it stopped", so that is what happens. The room server marks an in-race seat *away* while its connection is gone (the reconnect hold, `SLOTRUSH_RECONNECT_GRACE_S`) or while no `ctl` has arrived for more than `LINK_AWAY_MS` (1.5 s; a half-open mobile link still has its socket). It sends that seat's step input as neutral pedals plus `away`, so the race core is told, never guesses, and a replay is exact. The rule it follows: an away car must never gain anything, above all never track position through another car.

- **While it is still moving** it stays in traffic: neutral pedals, it bumps and can be bumped like any car, so a coasting car can never slip through the one ahead. `stallBlock()` already returns *held*, so its count is 0.
- **Once it has stopped** (slower than `STALL.stopV`) on the racing lane it is held (`Car.away`), unless automatic pit control is driving it (`sgCtl`, on the approach or in the box queue): the controller still takes such a car on into the pits when its turn comes, as before #74, so the cars queued behind it are never stuck for the hold. A held car:
  - never counted and never recovered (`stallBlock()` *held*, the count reset to 0)
  - out of traffic like a de-slotted, towed or parked car. Every check that reads other cars asks one predicate, `outOfTraffic()` (`src/traffic.ts`: mode `off` or `tow`, or held): collisions, `stallTrapped()`, the AI's following and defensive driving, automatic pit control's following, the shared pit queue (`PitTraffic.leader()`; a held car is not pit traffic at all, so it takes no place in the approach queue, the box order or a bay reservation while held), lane-change, pit-exit merge and re-slot clearance. It is also taken out of the squeeze priority queue while held, so it caps nobody there, and put back at its physical place if it rejoins inside the squeeze. Other cars drive through its spot, and a car stopped behind it is not trapped by it (that car's own count runs)
  - standing on its brakes, whoever would drive it: its driver, automatic stop-and-go control or the AI of a finished car
  - its place on the lap, lap validity, fuel and every debt and deadline unchanged. A service deadline is not exempt: an away car carried over its last chance breaches as before
  - snapshotted with `away: true` and drawn dimmed by every client

In the pit lane, a bay or a service nothing changes: the rule does not apply there and the queue and bay rules run as for anyone.

**The return** (a resume, or the first `ctl` on a live socket). A held car rejoins traffic as soon as both hold:

- no car in traffic is really inside it: less than `CAR_LEN` of slot apart in the same slot (touching bumper to bumper is not inside)
- no car closing from behind could fail to stop short of it. With `rel` the closing car's speed above the held car's, its clear slot must exceed `rel × 0.5 s + rel² / (2 × BRAKE) + 1 m` (`AWAY_REJOIN`: half a second to react, then full braking at the race's own `BRAKE`, 30 m/s², with a metre to spare; about 24 m at 25 m/s). A car changing lanes into the held car's lane counts as in that lane wherever it is in the change. A change that starts after the rejoin needs `laneClear()`, which sees the rejoined car, so only one already under way can arrive unannounced.

The wait for closing cars is capped at `AWAY_REJOIN.maxWait` (2 s) after the driver is back, so a stream of traffic cannot keep it out for ever; after that only a car inside it delays the return. Until it rejoins its pedals are still not its own (it stays on the brakes and is still *held* for the count), so the driver can never drive it through anything.

It rejoins with the same contact grace as a re-slotted car (`graceT = PEN.grace`, 1.5 s): a contact involving it in that time is resolved but judged against neither car, so a driver who was told to drive through a held car is never penalised for meeting it as it comes back. After the grace, contact is judged as usual.

The grace does not stop the returning car itself driving into the car ahead (from standstill it covers about 16.6 m and reaches about 19.7 m/s within 1.5 s). That contact is waived too, as for a re-slotted car or one leaving the pits, but the car it shoves is still marked as pushed (`pushedT`, `PEN.chainWindow`), and because the shove was waived, so is that car's own contact with the next car: no offence and no voided lap for either of them, along the whole chain (#76, rules `race-core-2026.11.5`). Before, `judge()` returned for the grace before marking the shoved car, so it took the rear-end offence for the chain and both front laps were voided. A connected driver shoving the same car gets the offence himself and the shoved car none, as always. The grace stays waived for both cars of a contact rather than only for the car hit from behind, so the re-slot, pit-exit and start rules are unchanged. A stop after the return is a fresh episode with the full three seconds.

It cannot wait for ever. A car inside it is in traffic and is not trapped by a held car, so it either drives on (an AI never follows a held car) or, a stopped human car, is recovered by its own three-second count, and the held car rejoins on the next step. Two held cars inside each other ignore each other and rejoin together once both drivers are back; `collide()` then separates them like any overlap, front car in front, so neither passes the other (the front one is pushed forward by at most a quarter of the overlap, about 0.35 m, as in any contact, and the rejoin grace means neither is judged for it). (A car held legitimately inside it, for example by the pit queue, keeps it waiting just as long: it would be queueing there anyway.)

**The hold window.** If the reconnect grace runs out, nothing new happens: `dropSeat()` retires the car (DNF `retired`, or DQ with a latched breach), and it parks in its own bay as in *Disconnects, grace and retirement* ([online-server.md](online-server.md)). The same window applies to a socket that stays open but sends no controls: after `SLOTRUSH_RECONNECT_GRACE_S` of silence the server treats it as expired in exactly the same way, for a car still racing. A finished car affects nobody, so its driver keeps the seat (and gets the result) however quiet the page is. From #69 until #74 a disconnected car had no immunity and was moved to its bay 3 s after it stopped, losing up to a lap.

### Evidence (#69)

Automated simulation and network evidence, on Node 26.7.0 (Node 22, the `.nvmrc` pin, is not on the build host; typecheck also passed on Node 24.21.0):

- `test/stall.test.ts` (64 tests, the shared race core): the boundary on both lanes at 30, 60 and 144 fps (nothing before 3.0 s, one recovery at the first step at or after it, frame size never moving it by more than one 1/120 s sub-step); pause; exact `stopV`, `goV` and `goDist` boundaries; Throttle flickers, micro-nudges, reverse back-and-forth and pushes from behind; 2- and 3-car queues (front first, fresh three seconds after); the `blockGap` boundary; the other lane, the circuit-4 bridge and two independent blockers in the same step, in any roster order; the grid, the pit queue and approach holds, the squeeze, the box, refuelling, a blocked merge, the pit exit, a de-slot, out of fuel (the tow only, also when both fall on the same step), terminal, retired, practice and AI cars, a terminal result on the same step, and Pit, both pedals or lane requests being no exemption; the reverse recovery of an overshot entrance; kept state and debts with no tow penalty and no served visit; the lane clear at once; a taken bay (held out of traffic, placed once, no duplicate reservation); recovery once; release, then a fresh press, then a clear merge; moved back from either side of the line and the bay, the lap-1 start-line wrap and the final lap (one void lap, finishing only at the real flag, never a better position); the mirror and the wire; determinism; and AI and a never-stopping human unchanged with the rule switched off.
- `test/server/stall.test.ts` (6 tests): the real `RoomManager` with 2 and 4 clients, a reconnect during the countdown (recovered at the same simulation time as without the drop, no events replayed, same classification) and after the recovery, 5 Hz against 60 Hz publication (same recovery time and result, each within its snapshot cap), and two browser `NetSession`s over real WebSockets (one recovery on both mirrors, 3, 2, 1 counted from the server's snapshots, no message history kept).
- Cross-commit regression: 40 seeded races to the flag (5 circuits × 4 seeds, all-AI and a bot human) on `0d7ef98` and on this change gave identical classifications, finish times, stops, offences, fuel, laps and best laps, with no recovery.
- Mutation checks, each reverted: the deadline 50 ms early (18 tests fail), one step late (11 fail), no follower exemption (5 fail), no recovery-once guard (1 fails). After the review: refuelling in the recovery bay (6 fail, including all four "never faster than a real visit" races), no reservation release, no contact reset, no `pitHold`, no empty-tank exemption and no bridge-level check (1 each), and the rule judged before the finish window (1).
- Review B1 (#72): before the fix, stopping by the car's own bay to be recovered refuelled it with no penalty and skipped the box queue, 3.5 to 4.3 s faster than a real visit behind a busy box. Now the recovery bay adds no fuel; the test above times both routes (real visit 16.2 s free and 20.6 s busy; recovery route 38.2 to 38.8 s).
- `stall` browser scenario: 27 of 27 on headless Chromium 156.0.8078.4 with SwiftShader and emulated touch. These are diagnostics only. **No physical keyboard, phone, tablet or GPU was used; the physical-device steps are in [validation](validation.md#final-multiplayer-validation-4-stopped-on-track) and remain to be done.**

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader (ANGLE on Vulkan, software), and touch was Chromium CDP emulation. **They are diagnostics only. They say nothing about behaviour or smoothness on a real phone, tablet or GPU. No physical device was tested.** Every browser scenario was set up by scripted placement, so this is functional coverage, not play-testing. Setup: headless Chromium 156.0.8078.4, Linux 7.0.0-42-generic x64, 480×270 at Low unless a scenario sets its own size.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass on `64c86f8`: 427 tests in 15 files, of which `test/autoBay.test.ts` adds 46 |
| AI regression | 20 seeded all-AI races (5 circuits × 4 seeds, to the flag) on `1abddd9` and on this change. They match in every car's status, pit-stop count (140 in total), offences and finish time to 0.01 s. Final fuel is 0.001 to 0.002 lower, because refuelling now stops at the departure request instead of running on while the merge is granted. No bay was granted to any car but its owner, and no car stood still outside a bay or tow for more than 0.92 s (the same as the baseline) |
| `autobay` browser scenario (new) | 27 of 27 on `64c86f8`. Bay paint for all four liveries (number 7, tag `YOU`, rivals unchanged), with a screenshot of the Violet bay. Keyboard: P and W held into its own bay at the pit limit, never past it, no Brake. Release Throttle, then Ready, then one tap of W leaves with refuelling stopped at the tap, Leaving pits and the handover past the exit. A blocked bay merge shows Waiting for clear exit in the bay, and the request survives Esc and a window blur, then leaves with no second press. A key held across a blur never departs. A blocked pit exit waits at the line, then hands back. A combined visit goes box, then bay. Pause help text. Emulated touch at 844×390, 360×640 and 1024×768: finger held (`lift off`, Release Throttle, no departure), lifted (`tap · leave`), one tap leaves. Chip and status line stay on screen and clear of every pad control. No page errors |
| `reverse` | 8 of 9 on `eaf437a`. Its bay check reversed into bay 4, which is Green Viper's and now correctly never captured. It now recovers the player's own bay: 9 of 9 on `64c86f8` |
| `race` (13 laps, real keys) | 23 of 23 on `eaf437a`, with two automatic bay stops (pit entry, service and exit in order). The shared driver no longer brakes by hand while the controller drives, and it presses W afresh to leave |
| `touchrace` (13 laps on the emulated pad) | 7 of 7 on `eaf437a`, including its fuel stop |
| `tracks`, `controlled`, `routing`, `practice`, `championship`, `touch`, `responsive`, `service`, `queue`, `autosg` | 6, 17 (plus the existing n/a for a real window blur and tab switch), 16, 10, 9, 53, 71, 16, 12 and 16 passed on `eaf437a` (one bounded run of 41 minutes). Records, ghost and championship saves are covered by `practice` and `championship` |

`eaf437a` and `64c86f8` differ only in the pit-lane edge case below, its unit tests and the browser-check script.

`test/autoBay.test.ts` (46 tests) covers:

- **Ownership:** `bayHome` per slot and independent of `bay`, `bayOwner`, practice leaving rivals' bays unowned, every livery on the player's bay with the rivals unchanged, and reservations, AI stops and tows using only the car's own bay.
- **Every circuit × both lanes × {Throttle held, no pedal}**, rotating liveries: phases entry → bay → refuel, no Brake after the takeover, entry at or under the pit limit, never past its bay before turning in, never backwards. Own bay only, one stop, refuel rate within bounds, held Throttle never departs. One fresh press leaves with no fuel added after it. Leaving pits, then the handover within 0.3 m past `PIT_OUT1` in the outside lane, with no overlap or offence. Nothing owed or re-armed afterwards and every grant released.
- **Departure press:** held on arrival (needs release, then one press, one merge and one exit even after repeated presses), a press before ready (refused with its reason, then only a fresh press counts), a tow penalty (refused, then accepted after), a full tank (never leaves, never above 1.0), refuelling stopping at the request and the request surviving release while a lane car blocks the merge, keyboard and touch sources and a pause clearing a held key, and Brake held through service, wait and exit with no reverse until a fresh press after the handover.
- **Conflicts:** the player's own bay occupied (waits at `AUTO.bayWait`, no other bay, enters once it is free), an AI car's bay occupied, three simultaneous arrivals in either array order at 1/30, 1/60 and 1/144 s (each to its own bay, no overlap, offences or wrong-bay grants), adjacent departures at once (downstream first, never together, both leave), and a blocked pit exit (waits at the line, then merges and is handed back).
- **Obligations:** combined visit (box, then bay, each debt clearing only itself, no Brake), a stop-and-go not paid by refuelling, a penalty-only visit never stopping in a bay, the final-lap fuel stop classified at the flag, due next lap after an override (served automatically next lap, not re-armed after), Space refused with no switch left, Pit cancelling during the takeover, a manual stop beside another team's bay never captured but reversing back to its own bay captured.
- **Past the bay by hand:** a fuel visit beyond its bay's capture window is not controlled. Brake-hold reverse brings it back, and releasing captures its own bay. Just short of or at the centre, the controller still brings it in. This found and fixed an edge case on `eaf437a`: a car reversed back to just past the centre was retaken with its stop point behind it and would have stood still. The controller now only claims a car within `AUTO.bayTol` of the centre or short of it.
- **Frame rate:** the turn-in point is within `AUTO.bayTol` at 1/24, 1/60 and 1/144 s.

Older tests that encoded "any free bay" or a manual bay stop were updated. These are the obligations helper using the player's own bay, the combined-visit and dry-tank cases in `autoStopGo.test.ts`, the queue tests (four-car train with the player stopping in its bay, own-bay reservations, a fresh press to leave), and the reverse tests (recovery into the car's own bay, an occupied own bay, a missed entrance now taken over).

### Known limits

- No physical keyboard, phone or tablet was used. All touch input is emulated and the renderer is software.
- Scripted placement only. No full race was played by a person to an automatic bay visit. The `race` and `touchrace` scenarios do drive whole races with real key or touch events through the new flow.
- The waiting point short of an occupied bay assumes the occupant arrived first. A car could only reach another car's bay in a scripted set-up, because every grant, stop and tow uses the car's own bay.
