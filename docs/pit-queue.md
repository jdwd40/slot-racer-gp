# Shared pit-lane queues, reservations and safe exits

Cars arriving at an occupied stop-and-go box, a busy pit lane or a car leaving its bay now queue behind it with a real stopping gap. Nobody overlaps, passes through a stopped car or jumps lanes to get out of a queue. Automatic stopping at the box and at the car's own bay is left for the next tasks. The player still brakes into the box and the bay, and the AI drives itself as before.

## Ownership

`Race.pit` (`src/pit.ts`, `PitTraffic`) owns all pit traffic state. `PitTraffic.update()` runs at the start of every simulation step, before any car moves. It works from a snapshot of where every car is, so the order of the car array, the frame rate and whether a car is human or AI never decide who goes first. There is no networking, so there is no client that could be offline or late. The HUD reads `Car.pitWait`, `Car.pitHold` and `Race.pit`, and keeps no queue of its own. The squeeze-section queue (`squeezeQ`) is not used here.

| Resource | Holder | Granted | Released (`why`) |
| --- | --- | --- | --- |
| Stop-and-go box (one) | `pit.box` | To the foremost car (by progress) that owes a stop and has not passed the box | Served (`done`), drove past or overshot it (`passed`), routing dropped (`route`), Defer (`defer`), de-slot, tow or finish (`terminal`), a car physically ahead now owes one too and the holder is not yet serving (`reorder`) |
| Fuel bay *j* | `pit.bays[j]` | On the approach to a car that wants fuel: its own bay (`Car.bay`) if free, otherwise the first free bay ahead. Also when it stops in a bay (`enterBay`) or a tow lands in one | Back in the through lane after the bay exit (`done`), drove past it (`passed`), route dropped (`route`), Defer, de-slot, tow (`terminal`), stopped in a different bay (`moved`) |
| Bay merge *j* (bay → through lane) | `pit.merges[j]` | When the bay car's departure request is safe (below) | When the exit animation ends and the car is in the lane (`done`) |
| Pit exit | `pit.exit` | To the foremost pit car within 4 m of the exit while the outside lane is clear | On crossing `PIT_OUT1` onto the road (`done`), towed (`terminal`), backed out of the window (`passed`), a car is now ahead of it (`reorder`) |

`grant` never takes a resource from another holder, and `release` only acts on the current holder. So nothing is ever double-reserved, and each reservation is released exactly once. Every grant and release is recorded in `pit.log` (bounded to 400 entries) for tests and diagnostics. A restart builds a new `Race`, so everything starts free.

**Pit traffic** means a car in the pit lane or a bay, or a car routed into the coming entrance (`pitReq`, outside lane, no change running, no manual override) within 40 m of it. **Progress** is the distance along the pit path from the entrance (negative on the approach). Order is by progress, and the tie-break for equal progress is the lower car number. Car numbers are fixed identities, not array positions.

## Queueing and stopping gaps

Each pit-traffic car gets an assisted speed cap (`Car.pitCap`) from the nearest obstacle ahead on its own path. The pit path is the outside lane up to the entrance, then `pitD(s)`. An obstacle is any car whose position across the track overlaps that path. A car turning into or out of a bay counts while it is in the lane, and a car with a granted merge counts from the moment it is granted. A car standing in its bay does not count.

`cap = √(2 · 20 · room)`, where `room = gap − CAR_LEN − 0.5 m` plus the leader's own stopping distance at 30 m/s² if it is moving forwards, or minus 0.5 s of its travel if it is reversing. The cap is applied like the existing pit limiter, at up to 45 m/s². A car is **held** (`pitHold`) when the cap is under 0.6 m/s, or when it stands within 0.3 m of the stopping point behind something stationary.

- The player joins a queue on Throttle alone and is stopped behind the car ahead. Braking is never needed.
- Queues can spill back past the entrance. The tail then waits on the outside road lane short of `PIT_IN0` and is never forced into an occupied pit lane. A road car behind such a held car on the outside lane also brakes for it, but never for ordinary racing traffic.
- The box sits in the single pit lane, so a car serving there blocks every car behind it, including cars going to later bays.
- The box is exclusive. While another car holds `pit.box` and stands or rolls in it, every pit-traffic car behind its entry line (`PEN_S − PEN_HALF`) is capped to stop 0.4 m short of that line and is held there as `queued`. This applies even when the owner stands at the very front of the box. Only the holder of `pit.box` accumulates stop-and-go time, so a car that ends up stationary in the box without the grant serves nothing.
- A held player does not capture a bay just by being stopped level with it. Braking there still captures it.

## Bay departures and passage priority

A departure request (`Car.exitReq`) is latched. The player presses Throttle once after the departure-ready time, and the AI asks once its tank reaches its target. The car waits in the bay ("Waiting for clear exit") until the merge is granted, then leaves once. No second press is needed.

The merge for bay *j* is granted when all of these are true:

1. No other merge within 4 m is held. Adjacent bays are 3 m apart, so two neighbours never pull out together.
2. No car on the through lane ahead is within `CAR_LEN + 0.5 m` of the bay, after allowing 1 s of travel for one that is reversing towards it.
3. No car behind is too close to stop short of the merge: within `CAR_LEN + 0.5 m` plus its stopping distance at 20 m/s².

Requests are taken downstream bay first. **Passage priority:** a through-lane car already in the merge zone, or unable to stop before it, goes first. Otherwise the bay car gets the merge and the lane car brakes for it. A queued lane car waiting for something further on (the box, the exit, its own bay) always stops outside the zones it is not waiting for, so the two can never wait on each other. When the lane car moves on, the bay car departs.

## The pit exit

A pit car waits at the line 0.4 m short of `PIT_OUT0` ("Waiting for clear exit") unless it holds the exit. Only the foremost car within 4 m of the exit can take it, and only while `Race.mergeBlocked()` is false. That check now counts:

- A car standing, crawling or reversing in the outside lane anywhere from 1.5 m into the merge to `CAR_LEN + 2 m` past `PIT_OUT1`, further for a reversing car. Before this change, stationary and slow cars were ignored.
- A car backing towards the merge, within 1.5 s of its travel.
- Traffic passing alongside, as before.

## Player override and escapes

- **Defer** (N or the touch button) works as described in [service obligations](penalties.md). It releases every reservation the car holds (`defer`) and keeps the debt. The stop moves one lap and uses the one deferral. It is only offered while another lap and that deferral remain. On the final lap it is refused and the reservation stays.
- **Lane override** (Space) before the entrance still takes the next switch only if `laneClear` allows it. Once the override is set the car is no longer pit traffic for this approach, so its reservations go (`route`). The debt is untouched.
- **Queued on the approach with no switch left** before the entrance: Space is refused with "No switch before the pit entrance — Defer to skip this lap, or wait in the queue". On the final lap the message is "…no deferral left — wait in the queue". Nothing is armed and the car does not move.
- **In the pit lane or a bay:** Space is refused with "Single-file pit lane: no way past. Wait for the queue to move". Position, lane and queue order are unchanged. There is no exit except driving on through the lane. Reversing is allowed where [reverse](reverse.md) allows it.
- Driving through the box, overshooting it or backing into it moves the box reservation (`passed`, then granted again) and never grants a deferral.

## Brake and reverse

`Race.reverseBlock()` returns `assist` while the car is held by the queue or waiting at the exit (`pitHold`). Bay entry and exit were already blocked as `mode`. Either refusal latches reverse off for the rest of that Brake press. So Brake held through a hold never backs the car away when the queue moves or service ends. A fresh press once the car is out of assisted control is ordinary reverse, as before.

## HUD

| Simulation state | Keyboard and touch chip | Status line |
| --- | --- | --- |
| `pitWait = 'queued'` (held behind lane traffic or the occupied box) | `⏸ QUEUED` | "Queued — you move up when the car ahead goes" |
| `pitWait = 'bay'` (held for a car turning into or out of a bay) | `⏸ WAITING FOR BAY` | "Waiting for bay — a car ahead is turning in or pulling out" |
| `pitWait = 'exit'` (departure request waiting in the bay, or waiting at the pit-exit line) | `⏸ WAITING FOR CLEAR EXIT` | "auto-exit when clear" in the bay, or "Waiting for clear exit — you go when the outside lane is clear" |

While held, the touch Brake button reads `queued · no R`. The old `YIELD TO TRAFFIC` chip is replaced by the exit chip.

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader, and touch was Chromium emulation through CDP. **They are diagnostics only and say nothing about behaviour or smoothness on a real phone, tablet or GPU.** No physical device was tested. Scripted placement sets up every queue situation, so this is functional coverage, not play-testing. Setup: headless Chromium 156.0.8078.4, ANGLE on SwiftShader (software), Linux 7.0.0-42-generic x64, Node 26.7.0, 480×270 at Low unless a scenario sets its own size.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass, 328 tests in 13 files. `test/pitQueue.test.ts` adds 21 |
| AI regression | 40 seeded all-AI races (5 circuits × 8 seeds, to the flag), baseline `fbdc413` against this change. Every race finishes in both, with the same 290 pit stops. Frames with two pit-lane cars in contact fell from 35 to 0, and no car stood still for more than 1.4 s (no deadlock). Every grant was released exactly once and nothing was held at the end. Rear-end offences were 10 and 13, all mid-lap racing incidents away from the pit approach and exit. Most are identical to the baseline, and the rest come from the races diverging. Finish times moved by a median of 0.3 s |
| `queue` browser scenario (new) | 12 of 12 on `4fe918a`. Keyboard: Queued on Throttle alone, Brake held through the hold and its release with no reverse, a fresh press reverses, Waiting for bay, a bay exit from one press that completes once, Waiting for clear exit at the exit line, then the merge. Emulated touch at 844×390: Queued, Brake cue `queued · no R`, and Brake held through the hold with no reverse. No contact and no page errors. Earlier runs failed on harness timing and were fixed in the script, not the game: the touch was too late for a 6 s stop, and a 5 ms sampler missed short HUD states, so it is now a MutationObserver |
| Existing browser scenarios | All passed in one bounded run on `4fe918a`: `tracks` 6, `race` 23 (13-lap race with real keys, including pit entry, service and exit), `controlled` 17 plus the existing n/a (real window blur and tab switch), `routing` 16, `practice` 10, `championship` 9 (records, ghost and championship saves), `touch` 53, `responsive` 71, `touchrace` 7, `reverse` 9, `service` 16 |

`test/pitQueue.test.ts` covers:

- **Order:** two AI cars arriving behind a car in the box, with the array reversed and at 1/24, 1/30, 1/60 and 1/144 s frames. Served order and every box grant and release are identical. An exact tie in progress goes to the lower car number in either array order.
- **Four cars, mixed:** three AI cars and the player (on Throttle only) behind a car serving at the back of the box. The tail waits on the road short of the entrance, nobody overtakes, the stops are served in order, and the player's bay is released when it drives past. The same results come out with the array reversed and at 1/30 and 1/144 s frames.
- **Gaps:** stopping behind a stopped leader with a real gap, following a slower one, and an AI car driving at the player while the player reverses down the pit lane (stops short, never pushed backwards).
- **Occupancy:** a car parked in its bay does not slow the through lane. A car serving in the box holds back a car going to bay 3. With the owner standing at the very front of the box and owing 6 s, the player on Throttle alone is held outside the box and serves nothing. Once the owner is done, the player is granted the box and serves. A reserved bay cannot be captured, and nobody holds two.
- **Bay departures:** a request waits for a committed lane car and completes exactly once from one press. Adjacent bays never merge together, downstream first in either array order. A bay car goes before a lane car that can still stop. No deadlock with a lane car standing in the merge zone behind a blocked exit.
- **Exit:** a car standing in the outside lane at the merge, and a car reversing towards it.
- **Lifecycle:** Defer releases the box and bay and keeps the debt, and is refused on the final lap. Drive-through then reverse back into the box, with no deferral granted. Tow, de-slot and restart.
- **Player:** a refused lane change in the pit lane and on the approach with no switch left moves nothing. The override takes a real switch and keeps a committed stop owed. Brake held through a queue hold never reverses, and a fresh press can.

Every scenario asserts no overlapping cars on one path, no offences, and that each grant is followed by exactly one release.

### Known limits

- Automatic stopping at the box and the car's own bay is not here. A player who stops level with an occupied bay, inside a departing car's merge zone, keeps that car waiting until the player moves on. The player is never held there automatically.
- The assisted cap protects a road car only from the held pit queue ahead on the outside lane, not from ordinary racing traffic.
- Two or more cars owing a stop and arriving together depends on the AI or the player stopping in the box. The queue itself only orders and holds them.
