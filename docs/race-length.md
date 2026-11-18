# Race length (#132)

Three race-length presets, defined once in `src/raceLength.ts` (`RACE_LENGTHS`) and shared by the race core, the browser and the room server:

| Preset | Laps | Finish window, 2+ humans | Finish window, 1 human (room server) | Race time limit | Browser run-on |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sprint | 5 | 90 s | 120 s | 1200 s | 240 s |
| **Standard** (default) | 13 | 90 s | 120 s | 1200 s | 240 s |
| Endurance | 26 | 180 s | 240 s | 2400 s | 480 s |

Standard is the length every race had before presets, with exactly the limits races had then. Anything that names no length (an older client, a save or a stored result from before presets) is Standard. Fuel capacity, burn, refill rate and every pit and penalty rule are the same at every length: Sprint needs no fuel stop (a tank is about 7.4 laps), Standard one or two and Endurance three to five, and there is no mandatory stop. Championship and career points per finish are unchanged. Tuning a value is a deliberate change in that one table.

## The lap target belongs to the race

`new Race({ length })` takes an allowlisted preset id (an unknown one throws; there is no lap-count option) and keeps it as `race.length`, a frozen preset in a non-writable property; `race.targetLaps` reads it. There is no process-wide lap count any more (the old `LAPS = 13` export is gone), so rooms of different lengths in one server process cannot affect each other (`test/server/raceLength.test.ts` runs a Sprint and an Endurance room side by side and each gives exactly the result it gives alone).

Every rule that used the old constant reads `targetLaps`:

| Where | What |
| --- | --- |
| `Race.laps()` | the flag (`lapsDone >= targetLaps`, never in practice) and "Final lap!" at the line that starts the last lap. The standing start's first crossing is not a lap |
| `Race.serviceDeadline()` | a stop-and-go missed on its lap is put back one lap only if that lap is not past the flag (`crossed <= targetLaps`); "last lap" wording at the final one |
| `Race.deferBlock()` | Defer is refused on the final lap (`'final'`) |
| `Race.dueState()` | a deadline past the flag is `late` |
| `Race.lastChance()` | a stop-and-go due on the final lap is the last chance |
| fuel override deferral | a fuel request overridden on the final lap is not deferred past the flag |
| `Race.offence()` | a stop-and-go awarded after the final lap's entrance says so (`msg.sgLate`) |
| `Race.fuelToFinish()` | the AI's fuel to the flag, so it refuels for this race's distance |
| `Race.results()` | the estimate for a car still running |
| `Race.snapshot()` | `laps`, which the online mirror maps back to the preset (`mirrorRace`) |
| defaults | `finishWindow` / `timeLimit` with 2+ humans, and `runOut()` |
| HUD (`src/hud.ts`) | the lap counter `n/targetLaps` (practice shows the lap alone) and the fuel figure's colour (laps to the flag) |
| `src/main.ts` | stop-and-go toasts ("due on the final lap"), the pending (netwait) card's `lap n/N`, the title goal line |

## Where the length is chosen and carried

- **Local race and championship.** The title screen's *Race length* selector (a radio group: click, tap or the arrow keys). The choice is remembered on the device (`srgp.raceLength`, read and written with the same try/catch as every other save). A new championship takes the length chosen when it starts and stores it in its save (`Championship.length`); every round and every resume races that length whatever the selector says later, and the Continue button and standings name it. A championship saved before presets has no length and loads as Standard. Practice has no lap target at any length.
- **Online.** The online menu shows the same selector (and remembered choice) when the server's `/api/health` lists `lengths`; a new multiplayer room, connected solo race or the first round of a connected championship asks for it. A connected championship stores its length beside its round (account-scoped `cchamp`) when the first round starts, and later rounds ask for that length. In the lobby every driver sees *Race length: name · n laps* before Ready/Start; the host of a multiplayer or solo room gets the selector. Results, the online results card and the career's recent results name the length.
- **Room server.** `RoomSettings.length` (`server/room.ts`): only the host changes it, only in the lobby or the results screen (a change clears everyone else's Ready, as any settings change does), never during a race (`bad_state`). An unknown id is `bad_settings`; a number or a `laps` key is malformed. The race's target is fixed when it starts, and the result envelope records the race's own length in `settings.length`. A championship round keeps the length its room was created with. A practice room accepts only Standard (practice has no length). Rematch and reconnect keep the room's length (the `joined` room and the resume state carry it).

## Compatibility

The static site is deployed on merge and the room server upgraded by hand afterwards, and older tabs may stay open, so every pairing is handled without a protocol bump:

| Page | Server | What happens |
| --- | --- | --- |
| new | old (before #132) | Health and `welcome` list no presets. The online menu shows no selector and says the server races Standard only; `NetSession` sends no `length` and no `lengths` (the old parser would refuse them as malformed), so rooms are Standard, as the old server runs them. The lobby shows *Standard · 13 laps* and no selector. |
| old | new | The old page sends no `length` (Standard) and no `lengths`. It can create and join Standard rooms as before. It is refused (`bad_settings`, "reload the page to join") from a Sprint or Endurance room, and a host cannot switch a room to Sprint or Endurance while such a page is seated, because its HUD counts to 13. |
| new | new | `welcome.lengths` lists the presets; create and join send `lengths: 1` (the preset-list version, `LENGTH_SET`) and the chosen `length`. |

`lengths` is a version of the preset list: a preset added later raises it, and the server keeps a page out of any race of a preset newer than its list (`knowsLength`).

- `PROTOCOL_VERSION` stays **2**: every change is additive and optional (`settings.length`, `lengths` on create/join, `lengths` in `welcome` and health, `length` in career `recent`), and the snapshot already carried `laps`. A bump would have cut every open page off online play between the static deploy and the server upgrade.
- `RULES_VERSION` stays **`race-core-2026.11.8`**: with the same inputs and seed a Standard race is the race it was (below), so results and personal bests under it stay comparable. A Sprint or Endurance lap is driven under the same physics, fuel and pit rules, so personal bests are kept per circuit, mode and rules as before, not per length; the length of a result is in its envelope.
- **No database migration.** The envelope (stored whole as `jsonb`) carries `settings.length`; the career's recent results read it from the stored result (`server/stats.ts`, a join on `race_results`), and a result stored before presets has none and reads as Standard. Stored results, awards and bests are untouched.

## Standard is unchanged

- A seeded digest of 15 races (five circuits × all-AI, one scripted human with three AI, two scripted humans with two AI and the live run-on), hashing every event and a snapshot every 30 steps, is identical before (`b62a7a9`) and after.
- `test/server/snapwire.test.ts` pins the room-server result digest of a seeded two-human race: the only difference in the envelope is the new `settings.length: 'standard'` key, and with it removed the pre-#132 digest results.
- `test/raceLength.test.ts`: a default race and an explicit Standard race are the same race step for step; Standard's limits are the old 90/120/1200/240 s.

## Endurance timing

Measured with seeded races at the room server's limits for the preset (scratch harness over `src/race.ts`, two seeds per circuit; the scripted humans drive the player profile at 92% and pit when low, so they are slow and pit often):

| Circuit | All-AI race time | Solo (human last) race time / spread | Two humans race time / spread |
| --- | --- | --- | --- |
| circuit-1 | 414-415 s | 513-515 s / 103 s | 508-517 s / 97-103 s |
| circuit-2 | 417-421 s | 523 s / 107-110 s | 524-537 s / 108-118 s |
| circuit-3 | 425-436 s | 501-518 s / 79-95 s | 525-528 s / 102 s (one run both humans DQ'd for unserved stop-and-go) |
| circuit-4 | 385 s | 479-480 s / 96-99 s | 491-506 s / 109-124 s |
| circuit-5 | 401-402 s | 497-499 s / 103 s | 497-505 s / 97-105 s |

Every race finished; all-AI fields finish within 14 s of each other with three to five stops each and never run dry. The same scripted drivers in Standard finish 35-59 s behind the leader (inside its 90 s window); in Endurance they finish 79-124 s behind, so Standard's 90 s window would classify them DNF. Hence Endurance's window and limits are twice Standard's: 180 s (multiplayer) and 240 s (one human) after the first finisher, 2400 s of race time, 480 s of browser run-on. All are bounded, and the longest measured race (537 s) is under a quarter of the time limit. Room lifetime (`SLOTRUSH_ROOM_MAX_S`, 3 h) is unchanged. Sprint keeps Standard's limits; its races take 71-82 s.

## Tests

- `test/raceLength.test.ts`: the table; per length, the flag and "Final lap!", the standing start, practice never ending, legal and refused deferrals, automatic deferral, unserved stops and breaches disqualifying, a late award, the final lap as a valid best lap, the AI's fuel plan; seeded all-AI races on all five circuits at all three lengths (every car classified on the right lap, enough stops, never dry, no tow, inside the limits), a local race with a human at each length, and two humans at Endurance with the multiplayer limits.
- `test/server/raceLength.test.ts`: the wire shape; defaults and refusals; host-only changes clearing Ready; frozen at the start; reconnect; practice; older pages refused or allowed; multiplayer races at each length with rematch; final-lap bests at each length; independent rooms; solo and championship limits; real sockets (health, `welcome`, a Sprint race through `NetSession`, an older client refused); a current page against an older server.
- `test/server/career.db.test.ts`: recent results name each length, results stored before presets read as Standard.
- `test/records.test.ts`: the remembered choice and championship saves.
- Browser: `node scripts/browser-check.mjs racelength` (desktop and emulated-touch flows, see [validation.md](validation.md)).
