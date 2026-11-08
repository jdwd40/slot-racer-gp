# Pit and stop-and-go lane routing

While a pit request or stop-and-go is active, the player's car takes the outside lane at every switch. This is lane routing only: the player still controls throttle and braking and must stop correctly.

## Behaviour

| State at the next switch | Choice | Outcome, subject to clearance |
| --- | --- | --- |
| Inside | Automatic | Change to outside |
| Outside | Automatic | Stay outside |
| Inside | One-switch override | Stay inside |
| Outside | One-switch override | Change to inside |

- `Race.requestLane()` (Space) toggles the override while routing is active, and is the normal lane request otherwise. `Race.requestPit()` (P) arms or cancels an optional fuel stop. `Race.requestDefer()` (N) puts the visit back one lap: see [service obligations](penalties.md). Touch controls call these same actions: see [touch controls](touch.md).
- `Race.nextRoute()` is the single decision. The switch logic, HUD chip and arrows all read it.
- The override is used up at the next switch, even if the move is blocked or a committed change is still running. The approach it was used on is recorded (`overAppr`).
- A blocked automatic move retries at the next switch. Committed changes are never reversed.

## Why a request is active

Routing (`pitReq`) is kept apart from the reasons for a visit: the optional request `fuelReq`, the committed fuel stop `fuelDue` and the stop-and-go `sgOwed`. `Race.syncRoute()` runs every step on the road and turns routing on while any reason exists, except on the approach a deferral released (`routeHold`). `pitPenaltyOnly` means the only reason is a stop-and-go. Clearing routing never clears a debt.

| Event | Effect |
| --- | --- |
| Stop-and-go awarded, nothing armed | Penalty-only route, due on the first reachable entrance |
| Stop-and-go awarded, fuel stop armed | Fuel stop stays independent |
| P while a stop-and-go is owed | Adds or drops the optional fuel stop. The penalty route cannot be cancelled |
| P with a committed fuel stop | Refused: it cannot be cancelled |
| N (Defer), when offered | Releases routing for this approach only, and moves what is due to the next lap. Re-arms once past the entrance |
| P while the approach is deferred | Routing back on for this approach. Deadlines unchanged |
| Missed or blocked entry | Request stays armed. Driving past an optional request after using the override on that approach commits it to the next lap |
| Successful entry | Routing, override and the optional request clear. Owed stops stay until served |
| Pit exit or tow with a stop still owed | Routing resumes |
| Stop-and-go served | Penalty-only routing ends. A fuel stop carries on |
| De-slot | Override clears, request stays |
| Tow, finish, restart | Routing, override and the optional request clear |

Deadlines, deferral and disqualification are described in [service obligations](penalties.md). Queueing in the pit lane, the box and bay reservations and the exits are in [pit queues](pit-queue.md). AI cars are never assisted and never defer.

## Evidence

Browser runs used SwiftShader on a host with no GPU. **They are diagnostics only and say nothing about real-GPU behaviour or smoothness.**

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass, 192 tests. `test/pitRouting.test.ts` covers the routing table, override, clearance, wraparound, lifecycle, penalties and overlap |
| Mutation spot-check of `src/race.ts` | 14 deliberate faults, all caught. Two survived at first and gained tests |
| AI regression | 10 seeded all-AI races (5 circuits, 2 seeds), identical state hashes before and after |
| `routing` scenario | 16 of 16 checks, 3 runs out of 3, at 480×270 Low |
| `tracks`, `race`, `controlled`, `practice`, `championship` | All passed on commit `1ba506a`: 65 checks passed, 1 unavailable (see below) |

The `routing` scenario covers a fuel stop with service, a stop-and-go served in the box, and routed pit entry from the inside lane on all five circuits. Cars are placed by script, so this is functional coverage.

### Known limits

- `routing` failed in the full run on `1ba506a` because it ran at 960×540. At about 300 ms per frame the scripted driver moved 2.4 m per frame and overran the 2.2 m box, so the penalty converted. Routing and accounting were correct in that run. The scenario now uses the default window. Only `routing` was re-run after that change.
- Scripted placement must clear `squeezeQ`: a car moved past the squeeze never leaves the queue and holds the cars behind it. Normal driving cannot do this.
