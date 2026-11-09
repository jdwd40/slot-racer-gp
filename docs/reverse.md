# Hold-Brake reverse

Keep holding Brake (S, ↓ or the touch **Brake** button) once the car has stopped, and it backs up slowly along its current slot. This is for recovering an overshot pit bay, penalty box or pit entrance without driving another lap. It is driving, not a reset: the car never jumps.

## Tuning

Constants are in `src/race.ts` (`REV`, `REV_CAP`, `REV_PIT_MIN`).

| Constant | Value | Meaning |
| --- | --- | --- |
| `REV.engage` | 0.6 s | Continued Brake at a standstill before reverse engages. Counted in simulation time, so pause or frame rate cannot change it |
| `REV.speed` | 3 m/s | Reverse speed cap by magnitude. `REV_CAP = min(REV.speed, PIT_SPEED)`, so it stays under the 8 m/s pit limit and far below racing speed (26 m/s) |
| `REV.acc` | 5 m/s² | Reverse acceleration, so the cap takes 0.6 s |
| `REV.still` | 0.02 m/s | Speed magnitude that counts as stationary. The stop-and-go box uses the same threshold |
| `REV_PIT_MIN` | `PIT_IN1` (8 m) | Upstream end of the reversible pit path, where the pit lane has fully left the road |

The starting values from the issue held up in tests and the browser check, so they are unchanged.

## Controls

| Situation | Result |
| --- | --- |
| Brake while moving forward | Normal braking. The hold timer stays at zero, so braking before the stop never counts towards reverse |
| Brake held at rest for 0.6 s | Reverse engages: `R REVERSING` chip, and the touch Brake button shows `R reverse` with a white border |
| Brake released | Any pending engagement is cancelled and the gear disengages. A reversing car coasts to rest at 9 m/s². Nothing stays latched |
| Throttle while reversing | Brakes the car to rest first, then drives forward. Speed is clamped at zero in the step where it would change sign |
| Throttle and Brake together | Brake wins: Throttle does nothing, the hold timer stays at zero and reverse cannot arm. A reversing car brakes to rest |
| Pause, blur, hidden tab, screen change, restart | `releaseDriving()` clears pointers and keys and calls `Race.clearReverse()`. On resume, a key or finger still down needs a fresh press, so reverse is never restored |
| Pointer cancel | Releases Brake like `pointerup`, so reverse ends |

Keyboard and touch both feed `DrivingInput`'s `brake` hold. The race sees only `{ up, down }`, so the two cannot differ.

## When reverse is refused

`Race.reverseBlock()` gives the reason. Except for a lane change, any refusal **latches** reverse off for the rest of the current Brake press. A fresh press and a fresh 0.6 s stationary hold are then needed.

| Reason | When |
| --- | --- |
| `phase` | Countdown, or after the finish |
| `mode` | De-slotted, towed, bay entry, refuelling or bay exit (automatic manoeuvres) |
| `service` | In the pit lane, inside the penalty box with a stop-and-go owed |
| `fuel` | Tank empty |
| `assist` | Held by the shared pit queue or waiting at the pit-exit line (`pitHold`): see [pit queues](pit-queue.md) |
| `change` | A committed lane change is running. A stationary attempt shows "Finish the lane change before reversing" once and latches that press. Braking through a switch at speed never latches, because the timer only counts at rest |

AI cars never reverse. `reverseControl` runs only for the player, and AI speed stays clamped at zero or above.

## Service

- **Stop-and-go.** Since [automatic stop-and-go](auto-stop-go.md), the controller holds the car still for the whole stop and ignores Brake and Throttle. Reverse is refused (`assist`) while it has the car, and that refusal latches the press, so Brake held through the entry, queue, box and exit never backs away at the handover. A car beyond the box (only reachable by scripted placement or an earlier overshoot) is driven by hand: holding Brake reverses it, and once it is back inside the box the controller takes it, brings it to rest and serves the stop. Service checks speed by magnitude, so a car rolling backwards is not stationary.
- **Bays.** Capture still needs a speed magnitude under 0.7 m/s, and never happens while reverse is engaged. Reversing past a bay with Brake held does not capture it. Releasing in a free bay's window captures it in the usual way. Occupied bays are never captured. Brake held through bay entry, refuelling and exit is latched, so the car does not reverse when it rejoins the pit lane.

## Recovery limits

- **Pit lane.** A pit-lane car reverses along the pit path only, and stops with zero speed at `REV_PIT_MIN`. A car still inside the branch (between `PIT_IN0` and `PIT_IN1`) cannot back out onto the road.
- **Missed entrance.** An outside-lane car on the road can back up past `PIT_IN0`, then drive forward into the pits with the request on. The pit branch is only entered on a forward crossing, from the outside lane with no change running. There is no reverse entry and no lane jump.
- **Road.** Reverse is allowed anywhere on the racing lanes at the capped speed. It never starts a lane change.

## Race integrity

- **High-water mark.** `Car.revMark` holds the furthest `u` reached before the car first backed up. Fixed points short of it are not decided again when the car drives forward over them: switches, sector checkpoints and the stop-and-go opportunity at the pit entrance. The mark clears once the car passes it, and on a tow. Pit entry and squeeze-queue entry are physical, so they still happen on a forward crossing.
- **Laps.** `crossed` only ever increases, so backing over the timing line and crossing it again gives no extra lap, finish, record or ghost. Backing up sets `lapValid = false` for the current lap. The next real crossing starts a clean lap under the usual rules.
- **Penalties.** Approaches are counted from `Car.hiU`, the furthest distance ever reached, so driving the same approach again after backing up neither uses nor restores a deferral, and never moves a deadline. Recovery before the line still counts towards the due lap. A fuel stop counts only through `enterBay` and `SERVICE_READY` of service. See [service obligations](penalties.md).
- **Routing.** A one-switch override used at a switch is not given back by reversing over that switch. An armed lane request carries on to the next switch on new ground. Backing over an entrance whose routing a deferral released does not release it again. The routing lifecycle is in [pit routing](pit-routing.md).
- **Collisions.** Contacts are resolved in both directions. A car backing into the one behind takes the whole positional correction and stops against it, so no car is shoved backwards and nothing passes through. Contacts with a reversing car are never judged as rear-end offences. Backing up leaves the squeeze priority queue, so queue order cannot push one car through another. Cars on different levels of a bridge have different track positions, so they never touch.
- **Fuel.** Burn uses speed magnitude, with full effort while reversing, so the tank never refills. Running dry while reversing brakes the car to rest, and the usual tow takes over.
- **Presentation.** Wheels turn backwards. The motor sound follows speed by magnitude. The body keeps facing forward. The camera's lead follows the direction of travel.

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader (ANGLE, Vulkan, software), and touch was Chromium emulation through CDP. **They are diagnostics only and say nothing about real-device behaviour or smoothness.**

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass, 275 tests in 11 files. `test/reverse.test.ts` adds 38 |
| AI determinism | 10 seeded all-AI races (5 circuits × 2 seeds, up to 200 s each) produced identical final state (position, speed, fuel, laps, stops, offences, penalties, best lap) before and after the change |
| `reverse` browser scenario | 9 of 9 checks, 2 runs out of 2, at 480×270 Low |
| `routing`, `controlled` | 16 of 16 and 17 of 17 passed. The one `controlled` n/a ("real window blur and tab switch") was already there |
| `touch`, `practice` | 53 of 53 and 10 of 10 passed: touch release paths, lifecycle and parity, and practice ghost and records saves, are unchanged |

`test/reverse.test.ts` covers:

- **Controls:** braking, the delay only at rest, short holds, the cap, release, Throttle and both pedals, clearing, restart.
- **Refusals:** countdown with the latch, finish, de-slot and tow, AI.
- **Service:** the box held, overshot and released, a rolling car not counted as stationary. The bay: passed at speed, the pit boundary, the branch, recovery with refuelling and the latch, an occupied bay.
- **Entrance:** recovery, back and forth with opportunities and deadline kept, no restore after a conversion.
- **Lane changes:** a refused change, no switch in reverse or on replay, no snapping, the override kept.
- **Collisions:** a parked car, a fast arrival, a bridge, the squeeze queue.
- **Timing:** the line, sectors, the finish.
- **Fuel:** burn while reversing, running dry.
- **Keyboard and touch:** parity, pointer cancel, app switch.

The `reverse` browser scenario (`node scripts/browser-check.mjs reverse`) uses scripted placement, then real keys and emulated touch:

- Keyboard reverse shows the HUD chip.
- An overshot box is served in full, with no reverse afterwards on the same press.
- An overshot bay is captured after backing up and releasing.
- Blur pauses and clears reverse, and resuming with the key still down coasts to rest.
- The touch Brake button reverses and shows `R`, and a cancelled touch stops reverse.
- No page errors.

### Known limits

- The scripted browser driver releases keys a few slow software frames late. The bay check releases at the bay's far edge to allow for that. A player at normal frame rates has more room.
- No physical phone or tablet was tested.
