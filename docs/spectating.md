# Post-finish spectating (#135)

When a driver's own race is over (finished, DQ or DNF) while other cars are still running, the page switches to a **spectator view** instead of putting a results card over the action. This works the same in local races, championship rounds, connected solo and multiplayer rooms. It is not a public spectator system: nobody can join a room to watch, and no seats, replays or broadcast tools were added.

## What the player sees

- **Entry.** The moment the page sees its own car terminal, it releases every held input (keys, fingers, reverse gear, and online the held pedals the server has), hides the driving pad and the driving dock (meters, chips, race instructions) and the start lights, and shows a short message with the driver's own result: *You took the flag · P2 provisional*, *You were disqualified · reason*, or *You did not finish*. The camera then follows the **leading car still running**.
- **Spectator panel** (bottom edge, where the driving dock was). *Spectating · Watching #12 Red Comet · Lap 9/13* (the watched car's number, name and lap against the race's own target from #132; the minimap rings it in cyan), the driver's own result line under it, and buttons:
  - **◀ / ▶** (Previous / Next driver; keyboard **←** / **→**): the running cars in race order, wrapping.
  - **Whole track** (keyboard **C**, also the HUD's View button): the overview camera. The selected car stays selected; ◀ / ▶ or a zoom go back to following.
  - **Standings** (keyboard **T**): *Standings / My result*, the live classification card (below). **Watch the race**, **Escape** or **T** come back.
  - **Skip to results** (local races only) or **Leave room** (online only).
- **The watched car stops running.** When it finishes, is disqualified or retires, the camera moves to the car that was next behind it in race order (else the leader). With no car left running the panel says *No car is still racing. Waiting for the final results…* and shows the whole track: it never follows a stale target.
- **Standings / My result.** The live standings: finished cars with their time, cars still racing with their lap and a **Watch** button (follow that car and go back to the race), DQ / DNF spelled out; no positions or estimated times for anyone still running. Your own row is marked *YOU*, and the card says the debrief comes with the final classification. Online it is the existing *Classification pending* card (with **Leave**); locally the race keeps running behind it, with **Skip to results** and **Menu**.
- **The end.** Online, the server's final results replace the spectator view as soon as they arrive, even over the race menu or the standings card; Rematch and championship continuation work as before. Locally, the results (or the championship standings) appear when the last car is done, or at once with **Skip to results**.
- **Back to driving.** Results, a rematch, Race again, the next championship round, the menu, leaving or the session ending reset the spectator state. A key or finger that was held at the flag (or pressed while watching) counts again only after a fresh press: spectating never registers driving holds, and every screen change clears what was held.

## Identity and control safety

- The view target is its own state (`src/spectate.ts`, `Spectator`). Following another car never changes `localId`, the server seat, *YOU*, the personal result line, points, personal messages or the debrief: those stay the local driver's. Watched-car figures are labelled with that car's number and name.
- While spectating the page **drives nothing**. `driving()` (race view and not spectating) gates every hold, tap (Lane, Pit, Defer) and the held pedals sent to the server. Online the heartbeat keeps going with neutral pedals for the driver's *own* seat, so the seat is never taken for a lost link; nothing is ever sent for a watched car (the server refuses controls for any seat but the sender's anyway). Locally the driver's finished car gets neutral pedals, exactly what the run-on gave it.
- Camera, HUD and panel only read the race. A finished car keeps its existing behaviour (the AI drives its cool-down lap).
- The personal race clock in the HUD stops at the driver's own terminal time (the finish time, or the race time the page saw the DQ / DNF). The debrief is frozen at that moment by the race core (#134), whatever is watched afterwards.

## Pacing

### Room server

Before #135 the server ran the AI field at 8 steps per 10 ms tick (`RUNON_STEPS`, about 13× real time) as soon as every human was terminal, so there was nothing to watch at normal speed.

- Now the race keeps **wall-clock pace while any in-race seat still has a connection** (a finisher on the spectator view or the standings card may be watching; another driver still racing needs it anyway). The accelerated run-on is used only when **no** in-race seat is connected: every human dropped (in the reconnect hold) or left. `Room.pace` is `'live'` or `'runon'`, decided every tick and logged as `race.pace` on a change.
- **No burst, no skipped step.** The run-on re-anchors the wall clock to the steps done after every tick, so going back to wall-clock pace (a finisher resumes) owes only the time since the last tick: one step per tick at most in the test, never a catch-up. Going to the run-on drops no step either: it runs 8 more per tick.
- **Snapshot rate unchanged.** States are cut into wall-clock slots (#49) in every phase; the tests measure the cap through live watching and through repeated drop / resume switches at 10, 20 and 60 Hz, and the resumed page gets the ordinary rate, no more.
- **Results cannot change.** The race is a function of its seed and per-step inputs. Pacing changes only how many steps happen per wall millisecond. A connected finisher sends neutral heartbeats every 250 ms, well inside the 1.5 s away threshold, so its car gets the same input at either pace. (Inputs that do depend on wall time, such as a seat going *away* after 1.5 s of silence, were already observed at a pace-dependent step before #135, as under server load.)
- **Bounds kept.** The finish window and race-time limit are race time and still classify every car; spectators cannot pause, reset or prolong the race. The room lifetime cap (`SLOTRUSH_ROOM_MAX_S`, 3 h) still aborts any race. A silent but still-open socket of a finished driver keeps wall-clock pace until the transport notices (the ws ping, 25 s), never beyond the finish window.

### Local races

A local race used to close `CLOSE_DELAY` (3.2 s) after the player was done and run the rest of the field synchronously (`Race.runOut`, up to the preset's `runOutS`). Local races now use `runOn: 'watch'`:

- the field keeps racing step by step at normal speed, so it can be watched, and the race closes once every car is terminal;
- it is bounded exactly like the synchronous run-on: `runOutS` of simulated time after `CLOSE_DELAY`, then every car still running is classified `runout`;
- **Skip to results** (`Race.skipRunOut()`) finishes it at once through the same synchronous `runOut` steps, with what is left of that budget. Watching, skipping at any moment, and the old synchronous run-on are the same simulated steps, so they give the same classification and debrief (`test/spectate.test.ts`, also with Throttle or Brake held after the flag).
- A race with nobody left running still closes on its own after `CLOSE_DELAY`, as before; practice has no spectating.

## Compatibility

The static site deploys on merge; the room server is upgraded later by hand; old tabs stay open. No protocol, rules or envelope bump was needed (below), so every pairing connects:

| Page | Server | Behaviour |
| --- | --- | --- |
| new | new | Spectator view; AI field at wall-clock pace while a finisher is connected; final results replace it. |
| new | old (before #135) | Spectator view with every control; once every human is done the old server accelerates the AI field, so the remaining cars run fast (as before), then the results replace the view. |
| old | new | The old *Classification pending* card and its **Watch the race**; the AI field now finishes at wall-clock pace, so the card waits longer (bounded by the finish window). Snapshots keep arriving at the normal rate, so its 30 s lost-contact timer (#43) is never tripped by the wait. |
| old | old | Unchanged. |

**Versions.** `PROTOCOL_VERSION` stays 2: no message or field was added (the spectator view is built from the existing snapshot stream, and controls are still bound to the sender's seat). `RULES_VERSION` stays `race-core-2026.11.8`: the race core's server path (`runOn: 'live'`) is unchanged, and the pinned digest test still gives the digests from before #135 when the old pacing is forced. `ENVELOPE_SCHEMA` stays 1 and the DB schema stays at 004: the envelope's fields are unchanged; only its `times.finishedAt` (wall time) is later when the race was watched. The local `runOn: 'watch'` mode never reaches the server.

## Server capacity

Simulation work per race is unchanged (the same steps). What changes is how long a finished race keeps its room:

- With every human done and at least one connected, the race phase lasts up to the **finish window** after the first car took the flag (Standard / Sprint 90 s with 2+ humans, 120 s for one human; Endurance 180 / 240 s), or up to the race-time limit (1200 / 2400 s of racing) if a human retired or was disqualified before any car flagged. Before, that tail took about 1/13 of the time. Measured with the bot race fixtures (`test/server/spectate.test.ts`, and the cross-version comparison below): three humans forced to the flag at 40 s of racing, the tail took 6.8 s of wall time before and 90 s after (the finish window), with an identical classification.
- During that tail each connected finisher receives the ordinary 20 states a second (the same as racing, about 1.5 KB each in v2) and the room costs one step per tick, so per-second load is that of a race in progress, lower than the accelerated run-on's 8 steps per tick. Concurrent rooms rise by roughly the share of time races spend in the tail; the room cap (`SLOTRUSH_ROOM_CAP`, default 6) and admission by tick load (`tickLoadMs`) still bound the total. With the small default cap, a room held through a watched tail is a room another group cannot create for up to that long: at peak, new rooms are refused (`unavailable`) a little more often.

## Evidence

- `test/spectate.test.ts`: the view target (enter on the leader, Previous / Next with wrap, picks only running cars, moves on when the target finishes or retires, none when nobody is left), when spectating is offered, and the local watched run-on: the same result as the synchronous run-on, staying open while cars run, Skip at 0.5 s, 3.7 s and 20 s after the flag giving the same classification and debrief, Skip refused while racing, held keys after the flag changing nothing, the `runOutS` bound.
- `test/server/spectate.test.ts`: wall-clock pace with connected finishers (steps per second, at most one step a tick), the accelerated run-on with nobody connected, back without a burst on resume, the #49 cap through switches at 10 / 20 / 60 Hz, the finish window still bounding a watched race, leaving after the flag keeping the finish, and two seeds of a bot-driven race giving the same classification, laps, debriefs, race time and ticks at wall-clock pace and forced accelerated pace.
- `test/server/snapwire.test.ts`: the pinned digest from before #135 still results with the old pacing forced; at wall-clock pace only `times.finishedAt` differs (later).
- Cross-version: the same seeded bot races run on `ed230a9` and on this change give identical classification, laps, debriefs, race time and ticks (three seeds with humans finishing behind the AI; three with three humans forced to the flag at 40 s, where the old server's tail took 6.8 s and the new one's 90 s).
- Browser check `spectate` (desktop mouse and keys, phone touch emulation): entry with Throttle held across the flag, Previous / Next, Whole track, the standings and a row's Watch, the watched car finishing, the panel's layout at every `MSG_VIEWS` size with a mouse and with touch (31 + 2 and 31 sizes, a long message and the reconnect banner shown), Skip to results, Race again with the key or finger still down, a championship round.
- Online check `spectate` (local servers only): two browsers, the first finisher watching the second at normal speed, all humans ahead of the AI watching the AI at normal speed, leaving after the flag, reconnecting while watching, a result arriving while the race menu is open.

## Known limitations

- The spectator camera reuses the race's follow and overview cameras: no free camera, no chase cam, no replay.
- Online, the watched car is drawn from the same interpolated snapshot stream as before: on an old server that still accelerates the AI field, it moves fast and steps between snapshots, as the run-on always did.
- The provisional place in the personal line is the order at the flag: penalties and DQs are settled by the server (or the local race) at the end, so the final place can differ.
- Touch and layout results come from Chromium's emulation on a GPU-less host (SwiftShader), not physical phones.
