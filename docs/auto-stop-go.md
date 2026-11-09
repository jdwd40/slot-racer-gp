# Automatic stop-and-go

When the player owes a stop-and-go, the car now enters the pits, queues, stops in the box, serves the whole stop and leaves the pits by itself. The player does not need a braking point or Brake. This builds on [lane routing](pit-routing.md), [obligations](penalties.md), the [shared pit queue](pit-queue.md) and [reverse](reverse.md), and keeps their rules. AI cars are not affected.

## How it works

`Race.sgUpdate()` runs for the player at the start of each car step, before reverse control and before the car moves. It sets `Car.sgCtl` (the controller has the pedals) and `Car.sgPhase` (what the HUD shows). While `sgCtl` is set, `Race.sgTarget()` sets the speed and Throttle and Brake are ignored. All of it uses simulation time and distance, and the simulation already runs in fixed 1/120 s steps, so frame rate cannot change the result.

| Where | Who drives | Phase |
| --- | --- | --- |
| Road, stop-and-go owed, more than 40 m from the entrance | Player | `armed`: **Stop-and-go armed** |
| Road, the deferred approach (`routeHold`) | Player | `deferred`: **Deferred — due next lap** |
| Road, within `AUTO.window` (40 m, the pit-queue approach) of an entrance the car is routed into and can still reach | Controller | `entry`: **Auto entry**, or `queued` while the queue holds it |
| Pit lane, entrance to the end of the box | Controller | `entry`, `queued`, then `serving`: **Serving** with a countdown |
| Pit lane after a penalty-only stop | Controller | `leaving`: **Leaving pits** |
| Past `PIT_OUT1` (the pit-exit merge, back in the outside lane) | Player | **The handover point.** "Out of the pits — you have control" |

**Can the car still reach the entrance?** It is in the outside lane, a change to the outside lane is under way, or a switch ahead ends before the entrance. Routing still makes the switch as before, and only when `laneClear` allows it. If a switch is blocked, the car stays in its lane, the controller lets go, and the car drives past the entrance.

**Speed target.** On the road the controller holds the speed the car had at the takeover. It never accelerates above that speed, and holds at least the pit limit, so a coasting car keeps moving. It is limited by four things:

- braking at `AUTO.plan` (18 m/s²) to the pit limit (8 m/s) 0.5 m before the entrance
- braking at `AUTO.box` (6 m/s²) to rest at the box centre (`PEN_S`)
- the player's cornering profile, so a takeover in a corner never holds a speed the slot cannot take
- a stopping gap behind any car ahead in the car's lane or the outside lane

The shared queue's `pitCap` and the pit limiter apply on top of this. The car comes to rest within `AUTO.stopTol` (0.05 m) of the box centre. The controller reaches its target with the normal pedals: full Brake is the most it ever uses, never the 45 m/s² cap. There is no teleport and no lane snap.

**Holding still.** While serving, the target is 0. Only the holder of the box reservation counts time, at `|v| < REV.still`. A car rolling backwards is first braked to rest, and only then does time count. Throttle or Brake during the stop changes nothing, so it can neither reset the stop nor clear it early. Stop time added by later offences (6 s, 9 s, …) is served in full.

## Late approaches and overrides (debt policy unchanged)

- **Too late.** The controller only takes over if braking to the pit limit by the entrance needs at most `AUTO.late` (24 m/s²). The player's `reachablePitEntry()` uses the same test, so a stop awarded too close to the entrance or too fast is due at the next entrance, and no deferral is used. If the car reaches the entrance with a stop-and-go owed, not under automatic control and more than 0.5 m/s over the pit limit, it is not let in ("Too fast for this pit entrance — the stop-and-go stays owed"). Nothing stops it instantly.
- **Defer** (N, or the touch Defer button) works whenever [penalties](penalties.md) allows it: before the takeover, and on the road during Auto entry. Using it during Auto entry hands control straight back, releases the reservations and moves the stop one lap. It is refused on the final lap and in the pit lane.
- **Lane override** (Space, or touch Lane) works as in [pit routing](pit-routing.md) wherever a switch is still ahead, including during Auto entry, for example on circuit-2, whose last switch is inside the 40 m window. The controller lets go, and the stop is missed on that approach. At the line the stop uses its one deferral automatically. Missing it again breaches the deadline, and the car is disqualified at the flag. With no switch left, Space is refused as before.
- In the pit lane there is no override. The lane is single file, as in [pit queues](pit-queue.md).

## Fuel visits

- **Penalty only** (`pitFuel` false at the entrance). The controller drives on through the pit lane after the stop and never captures a bay, even with Brake held next to one. Fuel never increases, no pit stop is counted, and the lap is counted once at the timing line.
- **Combined** (an optional or committed fuel stop, so `pitFuel` is true). The fuel reason is kept. After the stop the controller hands back at the box (the status line then reads "Brake to stop in a service bay"), and the bay reserved for the car on the approach stays reserved. The assigned-bay controller is the next task. Until it lands, the player brakes into the bay as before. The two debts clear independently.
- **Out of fuel in the pit lane.** If the tank runs dry while Leaving pits, the controller hands back ("Out of fuel in the pit lane — stop in a service bay or wait for the tow"). A car that comes to rest beside a free bay is captured by it and refuelled as normal. Anywhere else in the pit lane a car at rest with no fuel is towed to the nearest free bay, ahead or behind, never round a lap, with the usual tow penalty. The one exception is a car standing in the box with the stop owed: it serves the whole stop first, then is towed. A car that runs dry short of the box is towed and keeps the debt. This applies to AI cars too (none ran dry in the pit lane in the 20 seeded all-AI races, which are unchanged).

## Brake, reverse, pause

- `reverseBlock()` returns `assist` while `sgCtl` is set. The refusal latches the current Brake press, so Brake held through Auto entry, the queue, the box and Leaving pits never reverses after the handover. The car simply brakes to rest. A fresh press after the handover is ordinary reverse.
- Pause, blur, a hidden tab and screen changes still call `releaseDriving()` (inputs cleared, reverse forgotten). The simulation does not run while paused. Debt, deadlines, the takeover and reservations are kept, and on resume the stop carries on with no key pressed. A restart builds a new `Race`, so nothing is owed or reserved.
- Saved records, ghosts and championships are untouched. No storage keys or formats changed.

## HUD and help

The phase chip (`.sgp`) sits in the meter panel's chip row. The status line explains the phase. While the controller has the car, the touch Brake cue reads `auto · no R`. The pit-queue `QUEUED` chip and the deferral chip are not repeated while the phase chip says the same. The keyboard rules (title and pause) and the touch hint each add one sentence: the stop drives itself, Defer or Lane before the entrance are the only ways to skip it, and skipping it on its last allowed lap means DQ. No control was added to the racing view.

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader (ANGLE on Vulkan, software), and touch was Chromium emulation through CDP. **They are diagnostics only, not evidence of behaviour or smoothness on a real phone, tablet or GPU. No physical device was tested.** Scripted placement sets up every scenario, so this is functional coverage, not play-testing. Setup: headless Chromium 156.0.8078.4, Linux 7.0.0-42-generic x64, 480×270 at Low unless a scenario sets its own size.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass. 373 tests in 14 files, of which `test/autoStopGo.test.ts` adds 43. Older tests that encoded manual stopping were updated (see below) |
| AI determinism | 20 seeded all-AI races (5 circuits × 4 seeds, to the flag) give the same final state (distance, status, stops, offences, finish time, fuel) on `777598e` and on this change |
| `autosg` browser scenario (new) | 16 of 16 on `85b9d77` and again on `fd2a05d`. Keyboard: Armed, then Throttle held into Auto entry, Serving with countdown, Leaving pits and the handover, with no Brake, no bay and no fuel. Brake held through Queued (an AI car in the box), service and handover, with no reverse, and a fresh press reverses. N gives Deferred, and the entrance is not entered. Esc mid-service freezes the stop and keeps the one box reservation, and resuming with no key completes it. The pause help text. Touch at 844×390: Throttle finger into Queued, `auto · no R`, the phase chip clear of every pad button, served and handed back, Defer button. No page errors |
| `reverse` | 9 of 9 on `85b9d77` and `fd2a05d`. Its box check now expects the car to be driven to the exit with Brake held, never reversing, and still at rest after the handover |
| `queue`, `routing`, `service` | 12, 16 and 16 passed on `85b9d77` |
| `controlled` | 17 passed, plus the existing n/a (real window blur and tab switch), on `fd2a05d`. On `85b9d77` its "Served message shown" check failed: a second toast replaced "Penalty served". That toast was removed in `fd2a05d`, and the status line now gives the next step |
| `tracks`, `race`, `practice`, `championship`, `touch`, `responsive`, `touchrace` | 6, 23, 10, 9, 53, 71 and 7 passed on `85b9d77`. Records, ghost and championship saves are covered by `practice` and `championship` |

Two harness fixes in `autosg`, not game fixes. The "armed" read placed the car at rest, because a car at 12 m/s reached the takeover before two software frames were read. The handover position is read from the first drawn frame after the crossing, which can be one slow frame (a few metres) late. The unit tests assert the handover within 0.2 m of `PIT_OUT1` at 1/60 s frames.

`test/autoStopGo.test.ts` covers:

- **Every circuit × both lanes × {Throttle held, no pedal}:** served with Brake never pressed after the takeover, in the phases armed → entry → serving → leaving. Entry speed ≤ the pit limit. Never backwards, no position jumps, deceleration within a normal full brake. Handover just past `PIT_OUT1` in the outside lane. No bay grant, no fuel gained, no pit stop counted, one lap counted, no deferral used.
- **Box:** a clear box at 3, 6 and 9 s stops, stationary for the full time. Time added on the approach. Rolling backwards in the box is not counted. Throttle and Brake during the stop change nothing.
- **Queues:** an occupied box. Two- and four-car queues served in physical order, the player last on Throttle alone, the same at 1/24 s frames, with no overlaps or offences.
- **Approach:** a late award at 24 m/s, 6.5 m out, is due next lap and not entered, with no braking. A fast approach that can still be braked for is taken over. A blocked last switch misses the entrance with no lane snap, and the deferral is used at the line. Ordinary Brake before the approach.
- **Deferral and overrides:** valid deferral, then served next lap. Defer during Auto entry hands back. Repeated lane override on circuit-2 (inside the window): the first uses the deferral, the second gives a breach and a DQ at the flag. The final lap with an occupied box: queued, served, classified.
- **Fuel:** an optional request handed back at the box with the bay reserved and refuelled by hand. A committed fuel stop and the stop-and-go clear independently. A penalty-only visit with Brake held past the bays captures nothing. Running dry while Leaving pits hands back and the bay alongside refuels the car. Out of fuel in the box, the stop is served before the tow. Dry short of the box is towed with the debt kept. A tow from beyond the last bay moves back up the pit lane and the timing line is not counted twice.
- **Inputs:** Brake held through the queue and box, with no reverse after the handover and a fresh press reversing. Pause mid-queue (inputs and reverse cleared, debt and reservations kept, completes after resume, every grant released once). Restart. Frames of 1/144 to 1/8 s give the same stop point (within 0.02 m) and total time (within 0.15 s of frame rounding). Duplicate and refused N, Space and P in the pit lane, and keyboard plus touch both holding Throttle. AI never taken over.

Updated older tests (manual stopping is gone):

- `reverse.test.ts`: after service the car is now driven to the exit with Brake held, and it never reverses. Throttle while serving no longer resets the stop. Backing up over the entrance is now taken over.
- `obligations.test.ts`: the reversing recovery is taken over and served with no pedal. The combined-visit test sets `pitFuel`, as the entrance would.
- `pitQueue.test.ts`: the drive-through-the-box case is placed beyond a reachable stop.
- `pitRouting.test.ts`: the scripted entrance crossing is at the pit limit, not 10 m/s 0.2 m short of it, which is now "too late".

### Known limits

- The assigned-bay controller (next task) is not here. A combined visit hands back at the box for a manual bay stop.
- The controller does not accelerate a car above its takeover speed. A player who takes their foot off long before the 40 m window can still coast to a stop there. That is ordinary control.
- Scripted placement only. No full race was played to an automatic stop-and-go in real frames, and no physical device was tested.
