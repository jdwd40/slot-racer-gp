# Car setup (#133)

Three fixed handling presets, defined once in `src/carSetup.ts` (`CAR_SETUPS`) and shared by the race core, the browser and the room server. All are available at once; none is unlocked, bought or tuned by the player, and paint stays cosmetic (a livery never changes handling).

| Setup | Tuning | Drive at rest `acc` (m/s²) | Drive asymptote `vmax` (m/s) | Drag | Grip | AI planned grip | Advantage | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| **Balanced** (default) | 0 | 30 | 26 | 0.006 | 52 | 36 | the handling every car has always had | no specialist advantage |
| Speed | 1 | 24.35 | 27.81 | 0.0052 | 52 | 36 | attainable straight-line speed 24.3 m/s (+1.1 m/s, +4.7%) | 19% less drive from rest; weaker than Balanced at every speed below about 19.25 m/s (off the line, out of the pits and the slower corners) |
| Grip | 1 | 30 | 23.3 | 0.006 | 56 | 38.769 | +7.7% grip: about 3.8% more cornering speed before a de-slot, and more forgiving at the same speed | attainable straight-line speed 21.2 m/s (−2.0 m/s, −8.6%) |

Braking (30 m/s²), coasting, fuel burn and refill, the pit speed limit (8 m/s), the pit queue and its braking, the reverse cap (3 m/s), stopped-on-track recovery, the tow, contact judging and every penalty are the same for every setup. The AI keeps Balanced's planning margin under each setup's real grip (`aiGrip / grip = 36 / 52`).

The issue's design directions were kept: Speed trades acceleration for top speed, Grip trades top speed for cornering. In this physics model a higher top speed cannot come without more drive near the top end, so Speed is weaker below about 19.25 m/s and slightly stronger above it, like a taller gearing.

## Where a car's setup is read

There are no mutable globals. `new Race({ roster })` takes an allowlisted id per entry (`RosterEntry.setup`, Balanced when omitted; an unknown id throws) and freezes it as `Car.setup`, a frozen preset in a non-writable property. The old `ACC`, `VMAX`, `DRAG`, `GRIP` and `AI_GRIP` exports remain as Balanced's values for tests and comments, but no car's dynamics read them.

| Where | What reads the car's own setup |
| --- | --- |
| `Race.stepCar()` | drive `acc · thr · (1 − v / vmax)` and drag `drag · v²` (coasting and braking are shared), and the de-slot load `v² · k / (grip · banking)` |
| `holdThrottle(setup, v)` | the throttle that holds a speed, used by the AI and by the automatic pit controller |
| `Race.profiles` | the AI's planned speed profiles (normal and lapse) per persona, side and setup, built from the setup's `aiGrip` and `vmax`; only setups in the roster are built, and Balanced keeps its old keys (`profKey()`) |
| `Race.ai()` | its corner targets from its own setup's profiles; "the car ahead is slower than me" is judged against its own `vmax` |
| `Race.sgCorner()` / `Race.playerProfile()` | the automatic pit controller's corner limit on the approach (auto stop-and-go and auto-bay): the player profile of the car's own setup |
| `Race.snapshot()` | `setup` and `tuning` per car, static fields of the wire snapshot (`CAR_STATIC`) |

AI personalities (aggressive, consistent, tactical) are unchanged and separate: the AI roster carries an explicit setup (`setup: 'balanced'` in the local roster and the room server's AI fill, `AI_SETUP`).

## Where it is chosen and carried

- **Local race, practice and championship.** The title's *Car setup* selector, a radio group under *Race length* (click, tap or the arrow keys; the chosen setup's strength and cost are written out under it in a polite live region, and each button's accessible name is that sentence). The choice is remembered on the device (`srgp.setup`) and is shared with the online menu. Restart and *Race again* use it. A new championship stores it in its save (`Championship.setup`); between rounds the standings card offers the selector for the next round (never the race menu); each round records the setup it was raced with (`RoundResult.setup`). A save from before setups loads as Balanced.
- **Online.** When `/api/health` lists `setups`, the online menu shows the selector, and a new room, a join, a connected solo race and each connected championship round send the driver's own setup. In the lobby every driver's and AI car's setup is shown as text; each driver has a selector for their own. Results (local, online and the pending card) label every row's setup, and the career names each best's and recent result's setup.
- **Room server.** Each seat's `setup` is set only by its own create/join or its own `setup` message (it has no driver field, so no client can name another car), lobby only (`bad_state` in a race and on the results screen), and only to an allowlisted id (`bad_settings` otherwise; numbers, objects and extra fields are `malformed`). A change clears that driver's Ready only. The roster freezes every car's setup at the start; rematch and resume keep each seat's; the envelope records each participant's `setup` and `tuning`.

## Records and ghosts

A personal best, a leaderboard row and a ghost are compared only within the same **setup and tuning** (as well as circuit layout, mode and rules, as before). `tuning` is a per-preset revision: a later retune of a preset raises it, so laps driven under its old numbers are kept but never shown or loaded as current.

**Legacy data is Balanced at tuning 0, and stays current.** Every record made before setups was driven with exactly today's Balanced physics (verified bit for bit, below), so it is a Balanced record and is not invalidated. It never counts for Speed or Grip.

- **Local** (`src/records.ts`): Balanced at tuning 0 keeps the storage keys records always had (`srgp.lb.<kind>.<track>`, `srgp.ghost.<track>.<car>.<initials>`), so a page from before setups and this one read the same Balanced board and ghost. Every other setup or tuning has keys of its own (`…~speed.1`). Rows and ghosts now carry `setup` and `tuning`; one whose data names another setup or tuning than its key's is ignored, so an incompatible record cannot silently become current. Practice loads only the ghost of the car's own setup and current tuning; the leaderboard screen has a setup filter and is labelled "… · Speed setup".
- **Server** (migration `004_setup_bests`): `personal_bests` keeps holding Balanced tuning-0 bests under its unchanged key (so a server from before setups, during a rollout, writes the same rows); every other setup or tuning goes to the new `setup_bests`, keyed `(account_id, track_id, track_version, mode, rules_version, setup, tuning)`, monotonic like `personal_bests`. A check constraint keeps Balanced at tuning 0 out of `setup_bests`. The career reads both, each best labelled with its setup; a best of an older tuning is shown as "older tuning", not current (`tuningCurrent`). Recent results read the driver's setup from the stored envelope (results from before setups are Balanced).

**Migration 004** is additive: one new table, nothing existing altered, dropped or rewritten (tested on a 003 database with a stored result, award and best: all unchanged). The service refuses to start until it is applied. Reverting is `DROP TABLE setup_bests` (no other table references it); a server from before setups simply ignores it.

## Compatibility

The static site deploys on merge and the room server is upgraded by hand afterwards; older tabs stay open.

| Page | Server | What happens |
| --- | --- | --- |
| new | old (before #133) | Health and `welcome` list no `setups`. The online menu shows a note instead of the selector, and `NetSession` sends no `setup`/`setups` field and no `setup` message (the old parser would refuse them). Every car is Balanced and shows so. Local play has setups as usual. |
| old | new | The old page sends no `setups` (it knows Balanced only). It is seated in a room where every car is Balanced, and while it is seated the room offers Balanced only (`PublicRoom.setups: ['balanced']`; another choice is `bad_settings`, "a driver's page is out of date… must reload"); a current page that asked for another setup joins as Balanced and its lobby says why. It is refused (`bad_settings`, "reload the page to join") from a room where a setup other than Balanced is chosen, because its lobby could not show that choice. Its mirror ignores the new static fields; it races as before. |
| new | new | `welcome.setups` lists the presets; create and join send `setups: 1` (the preset-list version, `SETUP_SET`) and the driver's `setup`. |

- **`PROTOCOL_VERSION` stays 2.** Every change is additive and optional (fields on create/join, the `setup` message only sent to a server that lists setups, `setups` in welcome/health/version, `setup`/`tuning` on participants, AI and snapshot static fields, `PublicRoom.setups`). A bump would cut every open page off online play between the static deploy and the server upgrade.
- **`RULES_VERSION` stays `race-core-2026.11.8`.** With the same inputs and seed a Balanced race is the race it was, so results and bests under it stay comparable and existing personal bests stay current. A bump would have started a new set of bests for everyone and made the release's smoke check (which compares the server's rules with the build's) a mismatch between the two halves of the deployment; Speed and Grip laps are kept apart by setup and tuning instead, which is the finer key.
- **`ENVELOPE_SCHEMA` stays 1**: participants gained two optional fields; an envelope without them is Balanced at tuning 0.

## Balanced is unchanged

- A seeded digest of 20 local races (five circuits × all-AI, one scripted human with three AI, two scripted humans with two AI and the live run-on, and an all-AI Sprint), hashing every event and a snapshot every 30 steps (the two new static snapshot keys left out), is identical before (`3b00cb9`) and after. Four of them are pinned in `test/carSetup.test.ts`.
- `test/server/snapwire.test.ts`: the room server's seeded two-human race; the envelope's only differences are `settings.length` (#132) and each participant's `setup: 'balanced', tuning: 0`, and with those removed the pre-#132 digest results.

## Balance evidence

All numbers below are automated measurements on the shared race core (`src/race.ts`) with the final presets, from a scratch harness (bundled with esbuild, not committed): repeatable inputs, seeded races. They are evidence, not human playtesting.

**Straight line** (the race's own longitudinal model at full throttle, the human's throttle ramp; top speed is where drive meets drag):

| Setup | 0-15 m/s | 0-20 m/s | 60 m from rest | Speed at 60 m | Attainable top speed | Safe corner speed (steady, vs Balanced) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Balanced | 0.91 s | 1.57 s | 3.44 s | 22.98 m/s | 23.20 m/s | 1.000 |
| Speed | 1.06 s | 1.76 s | 3.52 s | 23.71 m/s | 24.30 m/s | 1.000 |
| Grip | 0.97 s | 2.04 s | 3.63 s | 21.10 m/s | 21.20 m/s | 1.038 (√(56/52)) |

`test/carSetup.test.ts` also holds a car at a constant speed at circuit-2's tightest point: a speed between the two limits de-slots Balanced and not Grip.

**Clean laps** (practice, no traffic; a driver that follows a speed profile built from a fraction of its *own* setup's grip and top speed, so it accounts for each setup; best valid lap of 120 s, lap time in seconds):

| Circuit | Balanced 0.90 | Speed 0.90 | Grip 0.90 | Balanced 0.72 | Speed 0.72 | Grip 0.72 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| circuit-1 | 13.358 | **13.276** | 13.567 | 14.510 | 14.435 | **14.433** |
| circuit-2 | 13.440 | **13.403** | 13.433 | 14.670 | 14.638 | **14.468** |
| circuit-3 | 13.679 | 13.692 | **13.623** | 14.940 | 14.963 | **14.724** |
| circuit-4 | 12.291 | **12.237** | 12.316 | 13.448 | 13.457 | **13.227** |
| circuit-5 | 13.228 | **13.056** | 13.709 | 13.969 | **13.842** | 14.284 |

(0.90: a driver near the limit; 0.72: the AI's own margin, about where a cautious driver is.) Speed is quickest where speed builds on long, fast sections (circuit-5, also circuit-1 and -4 near the limit) and slowest on twisty circuit-3; Grip is quickest on circuit-3 and, for a cautious driver, everywhere but circuit-5, where it is clearly slowest.

**Full races, one car changed** (all-AI fields; in each race one car, in each grid slot in turn, gets Speed or Grip and the rest stay Balanced; that car's finish time against the same seed's all-Balanced race; negative is faster):

| Circuit | Sprint Speed | Sprint Grip | Standard Speed | Standard Grip | Endurance Speed | Endurance Grip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| circuit-1 | +0.02 s | −0.07 s | +1.16 s | +0.41 s | +1.02 s | +0.36 s |
| circuit-2 | +0.12 s | −0.24 s | +1.54 s | +0.48 s | +0.21 s | −1.63 s |
| circuit-3 | +0.20 s | −1.05 s | +0.69 s | +0.50 s | −1.12 s | −4.02 s |
| circuit-4 | +0.22 s | −0.22 s | +0.65 s | +1.45 s | −0.81 s | −0.56 s |
| circuit-5 | −0.39 s | +1.82 s | −1.47 s | +4.14 s | −2.99 s | +9.86 s |
| mean | +0.04 s | +0.05 s | +0.51 s | +1.40 s | −0.74 s | +0.80 s |

Sprint and Standard: 4 seeds × 4 slots per cell; Endurance: 2 seeds × 4 slots (races of 75 s, 200 s and 400 s).

**Mixed fields** (slots 1-3, the aggressive, consistent and tactical AI, get Balanced, Speed and Grip in all three rotations, slot 0 stays Balanced, so personality and grid slot cancel; wins of a setup out of its races):

| Length | Balanced wins | Speed wins | Grip wins | Mean position B / S / G | Best mean position per circuit (1-5) |
| --- | ---: | ---: | ---: | --- | --- |
| Sprint (4 seeds) | 15 of 60 | 18 of 60 | 27 of 60 | 2.17 / 2.28 / 2.17 | S, G, G, G, S |
| Standard (4 seeds) | 22 of 60 | 21 of 60 | 7 of 60 | 2.15 / 2.45 / 2.90 | B, G, B, B, S |
| Endurance (2 seeds) | 4 of 30 | 10 of 30 | 16 of 30 | 2.43 / 2.27 / 2.10 | S, G, G, G, S |

**Reading.** Each specialist has a circuit where it wins and one where it loses clearly: Speed wins circuit-5 at every length and every driving level and is behind on circuit-3 (and, off the line and out of the pits, in every standing start); Grip wins circuit-3 and is last on circuit-5 in every race (up to 9.9 s behind in Endurance) and slower near the limit on circuit-1 and -4. Across the circuit set no setup wins everything: over all 150 mixed-field races Balanced won 41, Speed 49 and Grip 50. Consistent AI drivers never de-slot on any setup (test); the de-slots in the harness are the aggressive persona's deliberate lapses, about as frequent on each setup.

**Tuning history.** First candidates (Speed with only 12% less drive and a much higher asymptote; Grip at 56.68) were faster than Balanced on almost every circuit at every driving level, because cars spend most of a lap above 15 m/s, where top-end drive pays. Speed's drive was cut until it is weaker below about 19 m/s, and Grip's top end lowered, over seven measured rounds; the last round lowered Grip (56.5 → 56, top 21.4 → 21.2 m/s) because it won 28 of 45 Sprint mixed fields.

**Limitations.** No human playtesting: the drivers are scripted (bang-bang Throttle/Brake on a profile, like a human's pedals) or the race core's own AI, so balance for real players, who make mistakes and gain most from Grip's forgiveness, is unmeasured. The balance depends on the driving level (near the limit Speed is quicker than Balanced on four circuits; at the AI's margin Grip is quicker on four), so a very good driver may find Speed strong and a cautious one Grip. Seeds are few (2-4 per cell) and AI races are noisy (a single incident moves a car several seconds). Only all-AI and scripted fields were raced; two human online races with mixed setups were driven by the headless bot and the browser harness only.

## Tests

- `test/carSetup.test.ts`: the table; Balanced's old constants; refusals and the frozen per-car setup; the pinned before/after digests; Speed and Grip straight-line and corner behaviour (a speed that de-slots Balanced holds for Grip); two races with different setups in one process unaffected by each other; a deterministic mixed field; each setup's AI profiles; no de-slot by consistent AI on any setup (no stale limits); the pit controller's corner limit per setup; the pit limit, braking and reverse cap the same for every setup; the mirror; local boards, ghosts, preference and championship saves.
- `test/server/carSetup.test.ts`: the wire (forged numbers, objects, extra fields and a driver field are malformed); defaults and refusals; own-seat changes clearing only that Ready; frozen at the start (mid-race and results refused); rematch and reconnect; solo, championship rounds and practice; a mixed four-player room (envelope, every client's mirror and the server agree; a rerun is identical); bests per setup and tuning; older pages; real sockets (health, welcome, a change seen by the other page, an older client refused, a Grip solo race); a current page against an older server.
- `test/server/setupBests.db.test.ts` (PostgreSQL): migration 004 on a 003 database; bests routed and monotonic per setup and tuning; the career's labels.
- Browser: `node scripts/browser-check.mjs carsetup` (desktop and emulated touch, see [validation.md](validation.md)); online browsers: `node scripts/online-check.mjs setups`.
