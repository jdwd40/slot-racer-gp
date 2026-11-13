# Multiplayer race core (#21)

The simulation can now run up to four independently controlled human drivers, alongside AI entries. It is headless: no DOM, Three.js, audio or storage. An online room service can own it. The browser game drives it through a single-player adapter, and solo races and practice behave as they did. The lobby, networking and room workers are not part of this issue.

## API

| Piece | What it is |
| --- | --- |
| `RaceOpts.roster` | 1–4 `RosterEntry` items: `{ id, control: 'human' \| 'ai', slot?, name?, color?, persona? }`. The `id` is a stable driver ID. `slot` (0–3) sets the car's grid place, race number and its own bay, which are fixed for the race. Leave it out and the lowest free slot is used. Duplicate IDs, duplicate or out-of-range slots and empty rosters are rejected. With no roster, the race uses `soloRoster()`: the `SOLO_ID` human in slot 0 plus three AI cars (practice: the human only). |
| `Car.id`, `Car.human` | `human` replaces `isPlayer`. It means "a person drives this car" and says nothing about whose screen is showing it. Every human car gets the player assistance and service rules: routing, automatic stop-and-go, own-bay visits, queue holds, the inside-lane override, reverse and the fresh-Throttle departure. AI cars keep `ai()`. |
| `update(dt, inputs)` | `inputs` maps driver IDs to held `{ up, down }`. A driver missing from the map is neutral, and so is any value other than `true`. AI entries never read inputs. |
| `act({ driver, seq, type })` | Sequenced one-shot actions (`lane`, `pit`, `defer`). Each is applied once, at the start of the next `update`, in sequence order per driver. A sequence number already applied or queued returns `stale`. Unknown drivers and AI entries return `unknown`. `lastSeq` (also in the snapshot) is the acknowledgement. `requestLane(id)`, `requestPit(id)` and `requestDefer(id)` apply an action at once. |
| `msg` events | Each has `to: DriverId`. Only that driver's view shows it. |
| Status | Per car: `running` (racing), `finished`, `dq` or `dnf` (with `dnfReason` `window`, `timeout`, `runout` or `retired`; a retired car parks in its bay, see [online-server.md](online-server.md)). A status is set once and stays terminal. |
| Finish | One human finishing ends nobody else's race. The race closes `CLOSE_DELAY` (3.2 s) after every human is terminal, or every car when there are no humans. The AI field is then run on, as before. `finishWindow` (seconds after the first car reaches the flag) and `timeLimit` (seconds of race time) classify every car still running, furthest first and then by slot. A car with a latched service breach is DQ (`deadline`), any other is DNF. Both are unlimited by default with one human. With two or more humans they default to 90 s and 1200 s. |
| `standings()`, `final` | `standings()` is null while any car is still running. `final` is frozen once, when the race closes, and a single `final` event is sent. It holds only terminal rows: positions and times for finishers, null for DQ and DNF. `results()` still exists for the live display and can contain estimates; awards never read it. |
| `snapshot()`, `drainEvents()`, `wireEvent()` | Plain JSON with driver IDs for every car reference, including pit reservations and the queue order. No `Car` objects, no cycles, no `Infinity` or `NaN`, and no local-player field. |
| `rng` / `seed` | Each race has its own random source (`seededRng`, mulberry32). The default reads `Math.random` at each call, so existing seeded tests still work. A seeded race never touches `Math.random`. |
| `track` | Each race holds an immutable `Track` context (`trackFor(id)`, built once per circuit and shared). The simulation reads geometry only through `race.T`. `T.setTrack()` now only chooses the *displayed* circuit, whose globals the renderer, HUD and menus read. |

## Single-player adapter (browser)

`main.ts` has a `localId` (`SOLO_ID`). It builds the roster, sends `{ [localId]: keys }` each step, and calls `requestX(localId)`. The camera, player marker, HUD (`HudExtra.me`), minimap dot, "You" labels, own-bay paint and glow, audio emphasis, personal toasts, lap records and the practice ghost all use the car with that ID. None of them use car 0. The diagnostics hook `__game.setLocalSlot(n)` puts the local driver in another grid slot. The rival from that slot moves to slot 0 with its own name, colour and persona. Championships always use slot 0, which is the slot their saved results are keyed by. A championship round is recorded only from `race.final`.

Behaviour changes, all deliberate:

- At the end of the run-on, an AI car that is still running *with a latched service breach* is now DQ rather than DNF. It is classified by the same rule as the finish window.
- Order ties are broken by grid slot.
- `bump` events carry both cars (`car` = rear, `other` = front).

## Evidence

All on the build host (Linux, no GPU). Browser runs use Chromium with SwiftShader software rendering. Touch is Chromium emulation. **Browser results are diagnostics only:** they show logic and wiring, not smooth play on a physical device. No physical phone, tablet or second machine was used.

- `npm run typecheck`: clean.
- `npm test`: 16 files, 457 tests pass (427 existing ones migrated to the driver-ID API, plus 30 in `test/multiplayer.test.ts`):
  - Rosters: the solo and practice defaults are unchanged; 1–4 cars; a human in a nonzero slot gets that slot's grid place, number and bay; invalid rosters are rejected; bays are unique and stable.
  - 2, 3 and 4 humans at once. One holds Throttle, one holds Brake from rest until reverse engages and also asks to Pit, one sends no input and asks for a lane change, one sends a released input and two out-of-order lane actions. Each car does only its own thing, and messages go only to the driver who caused them. A differential check also runs: each driver's final car state in the shared race equals its state when only that driver's input and actions are applied.
  - Sequencing: stale, duplicate, non-integer, unknown-driver, AI-target and unknown-type actions are refused. Sequence numbers are per driver.
  - Service for every human:
    - Two humans owing a stop-and-go are taken over, queued, served one at a time (box grants in order) and handed back.
    - Two humans asking for fuel are each driven to their own bay (slots 1 and 3).
    - Throttle held from the arrival never leaves the bay. One driver's fresh press releases only that driver's car.
    - The inside-lane override and reverse stay with the driver who used them.
  - Finishing: a first finish does not end the race, and a second human keeps control for 10 s afterwards. The race closes once with one `final` event. The finish window classifies cars in a fixed order (a breach becomes DQ), each once, and releases their pit resources. The time limit sets DNF `timeout`. A DQ at the flag for an unserved stop-and-go still applies. Live results with estimates never become final, and the championship record is built from `final`. A solo race still closes 3.2 s after the solo finish.
  - Authoritative state: snapshots and wire events from 30 s of a 2-human/2-AI race round-trip through JSON. They contain only driver IDs and no local-player key. Seeded races are reproducible and never call `Math.random`.
  - Concurrent circuits: a Clubman Park race and a Speedway race are stepped in turn while the displayed track changes every step. Their snapshots equal those of each race run alone.
  - Headless: `race.ts`, `pit.ts` and `track.ts` import only each other (and, since #74, `traffic.ts`) and use no browser globals. A race runs to `final` in Node with no `window` or `document`.
- `npm run build`: OK.
- Browser checks (`node scripts/browser-check.mjs`, SwiftShader, diagnostics only): see the table below. The new `localslot` scenario puts the local driver in slot 2 and checks the camera, marker, HUD, fuel readout, own bay, motor volume and personal toast, then checks that slot 0 restores the solo grid.

Chromium 156 headless with SwiftShader, 480×270 at DPR 1 on the Low preset unless the scenario sets its own size, scripted driver on real keys, seed 20261028. These are diagnostics only.

| Scenario | Result | Notes |
| --- | --- | --- |
| `tracks` | 6/6 pass | All five circuits draw in follow and full views |
| `race` | 22/22 pass | Full 13-lap race on real keys: countdown, camera, pause, lane, two pit visits, results, play again |
| `controlled` | 17 pass, 1 n/a | De-slot and recovery, warnings, stop-and-go served, DQ at the flag, synthetic blur and hidden tab, stall, resize, restart. Real window blur is not automatable |
| `routing` | 11 pass, 0 fail, incomplete | Every check that ran passed (fuel routing chips and arrows, override, routed entry on circuits 1–4). The run was cut off by the build host's 30-minute background-job limit before it finished |
| `practice` | 10/10 pass | PB lap, practice board, ghost saved, loaded and replayed against the recording, fixture saves preserved |
| `championship` | 9/9 pass | Rounds stored once from the final result, fixture championship continued |
| `touch` | 53/53 pass | Emulated multi-touch pads, taps, holds, second finger, mode setting. The first run failed 2 checks because this script's request counter dropped the new driver-ID argument; the fixed script passes |
| `reverse` | 9/9 pass | Hold-Brake reverse into the box and bay, no reverse after service |
| `autosg` | 16/16 pass | Automatic stop-and-go phases, queue, defer, pause mid-service |
| `autobay` | 27/27 pass | Own-bay visits, release/ready/fresh-press departure, blocked merge and exit |
| `queue` | 12/12 pass | Shared pit queue, bay and exit waits |
| `service` | 16/16 pass | Defer, due and overdue states, deadlines, keyboard and touch |
| `responsive` | 71/71 pass | Phone, tablet and desktop layouts under mobile emulation, menus, championship by touch. The first run failed 1 check: the script forced `phase = 'done'` mid-race, which skips the race's close step, so no `final` existed and no round was recorded. That refusal is the intended rule now. The script ends the round by terminal classification instead, and the check passes |
| `localslot` (new) | 11/11 pass | Local driver in slot 2: camera, marker, HUD row/position/fuel, own bay, motor emphasis, personal toast, back to slot 0 |

`touchrace` (a 13-lap race on emulated touch only) was not run, and `routing` did not finish, because of the build host's time limits; the touch pads and the routing logic are covered by `touch`, the unit tests and the `routing` checks that did run. No physical phone, tablet, touch device or GPU was available, so smooth play on real devices is unverified.

## Next service task (rooms) — done in #22

The room server ([online-server.md](online-server.md)) now covers the items below: seats, transport, snapshot cadence, disconnect grace and retirement, room finish window and time limit, and a live run-on in place of the synchronous `runOut()`. Tracks are now deep-frozen as well.

Original notes:

- Contexts are isolated per race and tested concurrently here, so a room service can host rooms on different circuits in one process. Isolated workers are optional, not required for safety.
- Still to do: lobby and seat assignment to roster slots, a network transport for `act` and held inputs (with `lastSeq` acks), a snapshot cadence, disconnect handling, and choosing room `finishWindow`/`timeLimit` values. A disconnected driver currently just sends neutral input until the window or limit classifies them.
- `runOut()` simulates up to 240 s synchronously once every human is terminal. In a room service it should run off the request path or be bounded more tightly.
