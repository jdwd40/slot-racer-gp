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
| Status | Per car: `running` (racing), `finished`, `dq` or `dnf` (with `dnfReason` `window`, `timeout` or `runout`). A status is set once and stays terminal. |
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
  - Headless: `race.ts`, `pit.ts` and `track.ts` import only each other and use no browser globals. A race runs to `final` in Node with no `window` or `document`.
- `npm run build`: OK.
- Browser checks (`node scripts/browser-check.mjs`, SwiftShader, diagnostics only): see the table below. The new `localslot` scenario puts the local driver in slot 2 and checks the camera, marker, HUD, fuel readout, own bay, motor volume and personal toast, then checks that slot 0 restores the solo grid.

BROWSER_TABLE

## Next service task (rooms)

- Contexts are isolated per race and tested concurrently here, so a room service can host rooms on different circuits in one process. Isolated workers are optional, not required for safety.
- Still to do: lobby and seat assignment to roster slots, a network transport for `act` and held inputs (with `lastSeq` acks), a snapshot cadence, disconnect handling, and choosing room `finishWindow`/`timeLimit` values. A disconnected driver currently just sends neutral input until the window or limit classifies them.
- `runOut()` simulates up to 240 s synchronously once every human is terminal. In a room service it should run off the request path or be bounded more tightly.
