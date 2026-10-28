# Slot Rush GP — Architecture & Deployment Readiness Audit

Date: 2026-10-28. Scope: the working tree at commit `6c8a7da` plus the uncommitted practice/championship/leaderboard and collision-penalty work (`git status` lists seven modified files and two new files, `src/ghost.ts` and `src/records.ts`). This is an audit only; no gameplay code was changed.

Severity scale: **Critical** (will break the deployment or the product), **High** (must be fixed before going live or before starting multiplayer), **Medium** (fix soon, limited blast radius), **Low** (hygiene). Each finding is marked **Confirmed** (observed in code or by running something) or **Risk** (plausible, not observed).

---

## 1. Executive summary

Slot Rush GP is a 3,900-line TypeScript + Three.js single-page application built with Vite. It has **no backend**: every feature, including leaderboards, ghosts and championships, lives in the browser's `localStorage`. The production build is a static folder (`dist/`) and can be served by Nginx as-is.

Condition:

| Area | State |
|---|---|
| Type check (`tsc --noEmit`) | Clean, 1.4 s |
| Production build (`vite build`) | OK, 1.2 s. One JS chunk, 678 KB (186 KB gzip), one CSS file, 9.8 KB |
| `npm audit` (prod and dev) | 0 vulnerabilities |
| Tests | None in the repository |
| Lint | None configured |
| CI | None (`.github/` absent) |
| Headless load of the production build | No page errors. One 404 (no favicon). Game reaches the racing phase |
| Uncommitted work | Two feature rounds (practice/championship/boards, penalties/AI personalities) are not committed |

**Deployment verdict: deployable as static files once the uncommitted work is committed and one decision is taken about the third-party Tesana SDK that `index.html` loads from unpkg.** Nothing else blocks a first release. CI/CD can be set up now; the only genuine gap is that there are no automated tests to gate on beyond the type check and build.

**Multiplayer verdict: the simulation is in better shape than most browser games.** `src/race.ts` and `src/track.ts` import nothing from Three.js or the DOM, and during this work they were bundled with esbuild and driven from Node for thousands of simulated races without modification. The real obstacles are structural: the active track is module-level mutable state, the simulation assumes exactly one human car at index 0, randomness is unseeded, and several race rules (championship points, record validity, DNF classification) live in `src/main.ts` beside the renderer.

---

## 2. Current architecture

### 2.1 Modules

| File | Lines | Role | Touches rendering? |
|---|---|---|---|
| `src/track.ts` | 526 | Five `TrackDef`s, loop solver, centreline/elevation/banking geometry, pit-lane and penalty-box constants, AI speed profiles | No |
| `src/race.ts` | 843 | `Race` class: car state, physics, lane switches, squeeze priority, pit lane and bays, fuel, de-slot, towing, lap counting, AI driving/defending, collision response and penalty judging, results | No |
| `src/records.ts` | 114 | `localStorage` persistence: initials, livery, lap boards, ghost data, championship; pure `standings()` | No |
| `src/ghost.ts` | 93 | `GhostRecorder` (sim-side sampling) and `GhostPlayer` (Three.js visual) | Player yes, recorder no |
| `src/main.ts` | 673 | Entry point: renderer, scene, camera, overlays/screens, keyboard input, event handling, record/championship bookkeeping, frame loop, debug hooks | Yes |
| `src/hud.ts` | 252 | DOM HUD and minimap, reads `Race` each frame | Yes |
| `src/world.ts`, `src/scenery.ts`, `src/gfx.ts`, `src/carModel.ts` | 1,303 | Procedural track/scenery/car meshes | Yes |
| `src/audio.ts` | 100 | Procedural Web Audio | Yes |
| `src/i18n.ts` | 19 | `t()` via the Tesana `l10n` object with `assets/ui/strings.json` fallback | No |

### 2.2 Game loop and timing

`src/main.ts` `frame()` runs on `requestAnimationFrame`. It clamps the frame delta to 50 ms, calls `tick(dt)` only while the screen is `race` or `results`, then updates camera, car visuals, ghost, arrows, audio and HUD, and renders.

`tick()` builds an `Input` from the pressed-key set and calls `Race.update(dt, input)` (`src/race.ts:225`). `update()` splits the frame into `ceil(dt / (1/120))` sub-steps of equal size `h = dt / steps` and calls `step(h)` for each. Each step advances the countdown or race clock, runs `stepCar()` for every car, runs `collide()`, then `pose()`.

Assessment:

- **Simulation is independent of rendering** (Confirmed). `race.ts` and `track.ts` have no DOM or Three.js imports and run in Node unchanged.
- **Simulation timing is decoupled from frame rate but not fixed-step** (Confirmed). The sub-step size varies with the frame delta (a 16.7 ms frame gives two 8.3 ms steps, a 20 ms frame gives three 6.7 ms steps). Results differ slightly across frame rates. Lap times are robust to this because `laps()` interpolates the exact crossing time within the step (`src/race.ts:424`).
- **Not deterministic** (Confirmed). `rnd()` wraps `Math.random()` with no seed. It is used for the start delay (`goT`), AI lapse timing and intensity, defend probability and reaction time, and AI refuel targets. Given a seeded random source and the same sequence of `dt` values, the simulation would be reproducible; there is no other hidden input.
- Backgrounding the tab fires `blur`, which clears keys and pauses (`src/main.ts:436`), so there is no catch-up problem after the rAF stall.

### 2.3 How things are calculated

- **Position**: each car has a 1-D slot coordinate `u` (unbounded, laps counted from it), a lane side and lateral offset `d`. World position is derived in `pose()` through `T.point3(s, d)`. There is no 2-D physics; de-slotted cars get a short ballistic flight in `stepOff()`.
- **Movement**: throttle/brake inputs, `ACC/VMAX/COAST/BRAKE/DRAG` constants, speed caps for the pit limiter and squeeze queue, then `u += v·dt / (1 − k·d)` to account for lane radius.
- **Lane changes**: a request flag is consumed when the car crosses a switch start (`crossed(sw.s0)`), gated by `laneClear()` and, for AI defensive moves, `defendSafe()`. The change itself is a smooth interpolation of `laneSide` over `SWITCH_LEN`.
- **AI**: `ai()` reads a precomputed per-persona speed profile (`T.buildProfile`) with lookahead, blends a "hot" profile during lapses, follows traffic, plans fuel stops and asks `defend()` for blocking moves.
- **Fuel**: burn proportional to distance and throttle, scaled to lap length; refuel in bays at `REFUEL_RATE`.
- **Collisions**: `collide()` resolves overlap along the slot for cars in the same lateral band, applies an inelastic velocity exchange, and on a fresh contact above `PEN.impactRel` calls `judge()` to attribute an offence.
- **Penalties**: `offence()` escalates warnings to a stop-and-go; `servePenalty()` counts stationary time in the penalty box; `convertUnserved()` turns a missed stop into a result-time penalty applied in `order()`/`results()`.

### 2.4 State and persistence

All live state is in the `Race` instance (cars, phase, clocks, squeeze queue, contact flags) plus module-level `let`s in `main.ts` (`mode`, `screen`, `champ`, `pbMs`, camera state). `main.ts` drains `race.events` every tick and reacts (toasts, sounds, analytics, record submission).

Persistence is `localStorage` only, through `src/records.ts`, under `srgp.*` keys: initials, car, per-track practice/race boards (top 10), ghosts (versioned, rejected if lap length differs by more than 5 cm), championship progress (versioned), and `srgp.track`. All reads are wrapped in try/catch and degrade silently when storage is unavailable.

### 2.5 Weaknesses, duplication and fragile dependencies

| # | Finding | Severity | Status |
|---|---|---|---|
| A1 | **Active track is module-level mutable state.** `T.setTrack()` reassigns exported `let`s (`SEGS`, `L`, `SWITCHES`, …) and `Race` reads them live through about 90 `T.*` references. Only one track can exist per JavaScript realm. | High (multiplayer), Low (single-player) | Confirmed |
| A2 | **Single human car hard-wired.** `isPlayer` is `idx === 0`; `Race.player` is `cars[0]`; `requestLane()`/`requestPit()` take no car argument; `update()` accepts one `Input`. | High (multiplayer) | Confirmed |
| A3 | **Race rules live in the presentation layer.** `recordChampRound()` in `src/main.ts:279` decides DNF and stores points; valid-lap submission to boards and ghost saving happen in `handle()`/`onPlayerCross()`. A server would have to re-implement these. | Medium | Confirmed |
| A4 | **Driver names and colours duplicated.** `driverName()`/`driverColor()` in `src/main.ts:275-276` hard-code the rivals that `DRIVERS` in `race.ts` already defines. | Low | Confirmed |
| A5 | **Four-car assumptions.** `collide()` keys contact state as `min*4+max` (`src/race.ts:794`); the grid layout and `[7, 11, 3, 24]` race numbers are literal four-entry tables. | Low now, Medium for multiplayer | Confirmed |
| A6 | **AI lane decision uses the player profile.** `src/race.ts:664` compares traffic speed to `this.profiles['1'][0]` (the player's outside-lane profile at `s = 0`) rather than the persona's own profile. Harmless as a heuristic, but misleading. | Low | Confirmed |
| A7 | **Render-only fields inside the simulation.** `pose()` writes `x, y, h, z, roll, pitch` and adds wobble/jig noise from `this.t` into `h`. Cheap, but it is view data computed server-side. | Low | Confirmed |
| A8 | **Debug hooks shipped to production.** `window.__game` (`src/main.ts:673`) exposes the race, tuning tables and `advance()`; `Race.dbg` counters exist for tuning. Useful for testing, trivially lets players cheat local leaderboards (which are local anyway). | Low | Confirmed |
| A9 | **Events hold object references.** `RaceEvent` carries `Car` objects, not ids. Fine in-process, not serialisable. | Low | Confirmed |

---

## 3. Deployment blockers

Ordered by severity. Only D1 and D2 must be settled before going live.

| # | Finding | Severity | Status |
|---|---|---|---|
| D1 | **Two rounds of work are uncommitted.** Deploying from `main` today would ship the version without practice mode, championships, leaderboards and penalties. | High | Confirmed (`git status`) |
| D2 | **Third-party SDK loaded from unpkg at runtime with telemetry.** `index.html` loads `https://unpkg.com/@tesana/sdk@1.2.0/dist/tesana.iife.js` as a synchronous classic script and sets `window.__TESANA__` with a game id and a CloudFront endpoint. The headless load of the production build showed the SDK fetching `/v1/config` and POSTing `/v1/auth/guest`, then storing a JWT under `localStorage['tesana.play.v1']`. The game calls it for `levelStart`, `death`, `levelComplete`, `race_finished` and translations, all behind optional chaining so it works offline. Consequences for a self-hosted deployment: (a) the page's parsing blocks until unpkg answers, so an unpkg outage delays or stalls the game start; (b) every player's browser talks to a service you do not run; (c) no Subresource Integrity on the script; (d) a Content-Security-Policy must allow both hosts. | High | Confirmed |
| D3 | **No automated tests or lint.** CI can only gate on `tsc` and `vite build`. The scripted rule tests, all-AI simulations and Playwright scenarios used in this session live in a scratch directory outside the repository. | High (for CI/CD), none for a manual first deploy | Confirmed |
| D4 | **Unused dependencies inflate installs.** `phaser`, `@dimforge/rapier2d-compat`, `@dimforge/rapier3d-compat` and `three.quarks` are in `package.json` but never imported (`grep` of `src/`). `node_modules` is 253 MB; CI installs pay for this on every run. | Medium | Confirmed |
| D5 | **2.4 MB of unused decoders in `dist/`.** The `vite.config.ts` plugin copies Draco/Basis decoders into `public/decoders/` and the build ships them, but nothing in `src/` uses `GLTFLoader`, `DRACOLoader` or `KTX2Loader`. Harmless, but it triples the deploy size (3.0 MB total, 0.7 MB real). | Low | Confirmed |
| D6 | **No WebGL failure path.** `new THREE.WebGLRenderer()` is called at module top level (`src/main.ts:26`). Three r185 requires WebGL 2; where it is unavailable or blocked the page is blank with an uncaught exception and no message. | Medium | Confirmed by code reading; failure not reproduced |
| D7 | **No favicon.** Every load logs a 404 for `/favicon.ico` (observed in the headless console). | Low | Confirmed |
| D8 | **Tesana export artefacts in git.** `.engine_turns.json`, `.storefront_kit_status.json`, `.tesana_storage_state.json`, `assets/ui/.storefront_pass.json`, `README_EXPORT.md` and marketing images in `assets/ui/` are tracked. They are not referenced by the game. A 617 KB export zip sits in the working tree (ignored by `*.zip`). | Low | Confirmed |
| D9 | **Single 678 KB chunk.** Vite warns above 500 KB. Three.js is the bulk; gzip brings it to 186 KB, which is acceptable for a game. | Low | Confirmed |

Other deployment facts checked:

- **Build and runtime requirements**: build needs Node `^20.19 || >=22.12` (Vite 7's engine field) and `npm ci`. Runtime needs nothing: no server, no environment variables, no API. Configuration is the inline Tesana JSON in `index.html` and compile-time constants.
- **Static assets and routing**: `base: "./"` in `vite.config.ts`, so the app works at the domain root or under a sub-path. There is no client-side routing, so Nginx needs no history fallback. `strings.json` is imported at build time, not fetched.
- **Browser compatibility**: `target: es2022`. Required APIs: ES2022 syntax, WebGL 2, Web Audio, `CanvasRenderingContext2D.roundRect` (Chrome 99, Safari 16, Firefox 112). No polyfills. Keyboard-only controls; no touch input, so phones can watch but not play.
- **Local storage**: all saves are per-browser; nothing on the server can destroy them. Schema is versioned for ghosts (`GHOST_VERSION`) and championships (`v: 1`). Changing a track's geometry silently invalidates its ghosts (by design, via the lap-length check).
- **Error handling and console**: no global error handler; the production build logs nothing except the favicon 404. The `.engine_turns.json` style artefacts do not affect runtime.
- **Local-only assumptions**: `vite preview` and Nginx both serve `.wasm` with the right MIME type (Nginx ≥ 1.21 includes `application/wasm`), and the decoders are unused anyway. No absolute URLs, no `process.env`, no `fetch` of local files.

---

## 4. Multiplayer blockers

What a server-authoritative, four-human-player game needs, measured against the current code.

### 4.1 Runs on a server unchanged

- `src/track.ts` in its entirety, including `buildProfile()`. Track definitions are plain data and can be shared between client and server from the same module (Confirmed: bundled and executed in Node during this session).
- `src/race.ts` physics, lane-switch gating, squeeze queue, pit lane and bays, fuel, de-slot/recovery, towing, lap counting with sub-step crossing times, collision response and penalty judging, AI driving and defending, `order()` and `results()` (Confirmed in Node, with an AI driving the player car by setting `isPlayer = false`).
- `records.ts` `standings()` and `CHAMP_POINTS` (pure functions).
- `ghost.ts` `GhostRecorder` (no rendering dependency).

### 4.2 Needs refactoring

| # | Finding | Severity | Status |
|---|---|---|---|
| M1 | **Per-realm track state (A1).** A Node server hosting rooms on different circuits cannot use `T.setTrack()`; the second room would re-geometry the first. Options: one worker/process per room (no code change, higher memory), or turn the active-track state into an object passed to `Race`. | High | Confirmed |
| M2 | **One human, at index 0 (A2).** `update()` must take an input per car; `isPlayer` must become a per-car "human" flag; `requestLane`/`requestPit` must take the car; the grid must be built from a lobby, with AI filling empty seats. Everything that reads `race.player` in `main.ts`/`hud.ts` must take "my car" from the session. | High | Confirmed |
| M3 | **Unseeded randomness.** Not required for server authority, but required for any client-side prediction of AI cars and for reproducible bug reports. Inject a seeded PRNG into `Race`. | Medium | Confirmed |
| M4 | **No state snapshot format.** `Car` has roughly seventy fields, several of them object references (`change`, `off`, `persona`). The server needs a compact per-tick snapshot (`u, v, laneSide, d, mode, fuel, offences, sgOwed, …`) and the client needs to render from it. Nothing exists yet. | Medium | Confirmed |
| M5 | **Rules in `main.ts` (A3).** Championship rounds, DNF, valid-lap records and ghost saving must move behind the server's authority or they can be forged by any client. | Medium | Confirmed |
| M6 | **Event references (A9) and four-car keys (A5).** Mechanical but necessary. | Low | Confirmed |

### 4.3 Inputs, synchronisation, prediction

- **Inputs**: the current `Input` is already a tiny per-tick struct (`up`, `down`) plus two edge-triggered requests (lane, pit). Over the network this becomes `{tick, up, down, laneReq?, pitReq?}` per player, with the server running a fixed 60 Hz sim and holding a short input buffer. The sub-step loop in `update()` should become a true fixed step (`h = 1/120` or `1/60`) on the server.
- **Snapshots**: 20 Hz server snapshots of all cars plus the event list for that interval. Because motion is one-dimensional along the slot, clients can interpolate `u` and `d` between snapshots and derive everything visual through `T.point3()`, exactly as `pose()` does now.
- **Prediction and reconciliation**: the player's own car can be predicted locally by running `stepCar()` for that car only, since longitudinal dynamics depend only on its own input and speed caps. On a snapshot, rewind to the server's `u, v` and replay buffered inputs. Interactions (collisions, squeeze caps, lane-switch acceptance) stay server-side and will cause occasional visible corrections, which the 1-D model keeps small.
- **Lane-switch conflicts**: `laneClear()` is already evaluated at a single discrete moment (crossing `sw.s0`), so the server simply applies requests in tick order; the losing car gets the existing "no gap" message. Latency means a request sent 100 ms before the switch may arrive after it; a request should carry the client tick and be honoured if the car had not yet crossed on the server at that tick, or the UI should arm the request a switch earlier.
- **Collision fairness**: `judge()` runs on the server from authoritative positions, so attribution is consistent for everyone. The only latency effect is that a lagging player sees a hit slightly after the server has already applied it.
- **AI alongside humans**: `Race` already mixes AI and human cars; AI cars are just cars with `isPlayer = false`. On the server they cost nothing extra.
- **Transport**: WebSockets from a Node process, proxied by Nginx with upgrade headers. Rooms of four, one `Race` each, AI filling empty seats.

### 4.4 Recommended incremental approach

Single-player keeps running the local `Race` throughout; each step is independently shippable and keeps `npm run build` green.

1. **Lock the simulation boundary with tests.** Move the existing scratch harness into the repo as Vitest tests against `race.ts`/`track.ts`. No code change.
2. **Per-car input and human flag.** `update(dt, inputs: Input[])`, `requestLane(car)`, `requestPit(car)`; `main.ts` passes `[input]` for car 0. Behaviour unchanged.
3. **Seeded PRNG** injected through `RaceOpts`; default to `Math.random` so single-player is unaffected.
4. **Track as an instance** (`new Track(def)`) owned by `Race`, with `track.ts` keeping thin module-level accessors for the renderer during the transition. This is the largest mechanical change (about 90 references in `race.ts`, plus `world.ts`, `hud.ts`, `main.ts`).
5. **Snapshot/apply.** `race.snapshot()` and `race.applySnapshot()`, with `main.ts` able to render from a snapshot instead of a live `Race`. Verify by running single-player through a local loopback "server" in the same page.
6. **Headless server package** (`server/`), sharing `src/sim/` via the same TypeScript sources, with a lobby, rooms and WebSocket transport. Deploy as a `systemd` service behind the existing Nginx.
7. **Prediction** for the local car, then AI prediction using the seeded PRNG if corrections are visible.

---

## 5. Technical debt

Ranked by practical impact on the two goals.

1. **No tests in the repository** (High). The penalty and AI rules were verified with 39 scripted checks and multi-race simulations that exist only in a scratch directory. Until they are committed, any CI gate is just "it compiles".
2. **Runtime dependency on the Tesana SDK and unpkg** (High). Covered in D2. Also makes `i18n.ts` depend on a global the deployment does not control.
3. **Module-level track state** (High for multiplayer, see A1/M1).
4. **Single-player assumptions in `Race`** (High for multiplayer, see A2/M2).
5. **Unused dependencies and shipped decoders** (Medium, D4/D5): slower CI, larger deploys, confusing to newcomers.
6. **Rules in the presentation layer** (Medium, A3/M5).
7. **Variable sub-step size and unseeded randomness** (Medium, see 2.2/M3).
8. **Snapshot-unfriendly `Car` shape** (Medium, M4).
9. **No WebGL failure message** (Medium, D6).
10. **`window.__game` and `Race.dbg` in production** (Low, A8). Keep for tests, but gate behind `import.meta.env.DEV` or a query flag.
11. **Duplicated driver tables, four-car literals, event object references** (Low, A4/A5/A9).
12. **Repository hygiene** (Low, D7/D8): favicon, export artefacts, loose zip.

---

## 6. Recommended architecture

A realistic target that keeps single-player identical and does not introduce frameworks.

```
src/sim/        track.ts, race.ts, rng.ts, snapshot.ts    (shared, no DOM, no THREE)
src/client/     main.ts, hud.ts, world.ts, scenery.ts, gfx.ts, carModel.ts, audio.ts, ghost.ts, records.ts, i18n.ts
server/         index.ts (ws + rooms), room.ts (one Race per room, fixed 60 Hz), protocol.ts
```

- **Single-player**: the client instantiates `Race` locally exactly as today. No network.
- **Multiplayer**: the server owns the `Race`; clients send inputs, receive 20 Hz snapshots and events, render from snapshots, and predict their own car. AI seats use the same `Race` code with no client involvement.
- **Shared track data**: `TRACKS` stays a plain array in `src/sim/track.ts`, imported by both bundles, so geometry can never drift between client and server.
- **Persistence**: local boards and ghosts stay in `localStorage` for single-player. Multiplayer results, if persisted, go through the server (a JSON file or SQLite is enough for four-player rooms; do not add a database before there is a need).
- **Deployment**: Nginx serves `dist/` and proxies `/ws` to the Node service on localhost. The single-player deployment already in place is unchanged by adding the service later.

What to avoid: a generic entity-component framework, a physics engine (the 1-D slot model is the game's strength), lockstep determinism across clients (server authority removes the need), and any shared state library on the client.

---

## 7. CI/CD recommendations

### 7.1 Workflow shape

One workflow, `.github/workflows/ci.yml`, two jobs.

**`check`** on every push and pull request:

1. `actions/checkout`
2. `actions/setup-node` with Node 22 and `cache: npm`
3. `npm ci`
4. `npx tsc --noEmit`
5. `npm test` (once Vitest tests exist; see 7.3)
6. `npm run build`
7. Upload `dist/` as an artifact (retention 14 days)

**`deploy`** only on `push` to `main`, `needs: check`, in a GitHub Environment named `production` (gives you required reviewers and a deployment log if wanted):

1. Download the `dist/` artifact from the `check` job, so the deployed files are exactly what was tested.
2. Start `ssh-agent` with a **deploy-only SSH private key** stored as an environment secret, and pin the server's host key via a `known_hosts` secret. Never echo secrets; the SSH user should be an unprivileged account that owns the web root only.
3. `rsync -az --delete dist/ deploy@host:/var/www/slot-rush/releases/<git-sha>/`
4. `ssh deploy@host "ln -sfn /var/www/slot-rush/releases/<git-sha> /var/www/slot-rush/current && ls -dt /var/www/slot-rush/releases/* | tail -n +6 | xargs -r rm -rf"` (keep the last five releases).
5. Smoke test: `curl -fsS https://host/` returns 200 and contains `<title>Slot Rush GP`.

Nginx `root` points at `/var/www/slot-rush/current`. **Rollback** is re-pointing the symlink to the previous release directory, by hand or through a `workflow_dispatch` job that takes a SHA. No build is needed to roll back.

Branch protection on `main`: require the `check` job to pass before merging, so a broken build never reaches the deploy job.

### 7.2 Nginx notes

- `gzip on` (or Brotli if the module is available) for `text/html`, `text/css`, `application/javascript`, `application/json`, `application/wasm`.
- `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }` because Vite hashes those filenames; `location = /index.html { add_header Cache-Control "no-cache"; }`.
- Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` as desired. A CSP is practical only after the Tesana decision: with the SDK removed, `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'` works (the inline bootstrap script in `index.html` would also need to go).
- No history fallback is needed; `try_files $uri $uri/ =404` is fine.
- Later, for multiplayer: `location /ws { proxy_pass http://127.0.0.1:8080; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }`.

### 7.3 Player saves

Saves live only in each player's browser, so no deployment step can delete them. Two rules keep that true:

- Treat the `srgp.*` keys and the ghost/championship `v` fields as a public schema. Bump the version and migrate (or ignore old entries) rather than clearing storage.
- Do not change `T.FINISH_S`, lane geometry or track `segs` casually: `loadGhost()` rejects ghosts whose lap length changed, and board times become incomparable. If a circuit must change, give it a new `id` or clear only that circuit's boards with a one-off migration.

If the Tesana SDK stays, note that it also writes `tesana.play.v1` to `localStorage`; removing the SDK leaves that key as harmless debris.

### 7.4 Missing tests

Add Vitest (one dev dependency, runs TypeScript directly, no bundling step). The simulation needs no browser, so these run in Node in well under a second. Suggested first files, in priority order:

| File | What to cover | Existing building block |
|---|---|---|
| `test/track.test.ts` | Every `TrackDef` solves to a closed loop (`solve()` finite, `L > 0`), switches do not overlap the squeeze or pit entry, `gapS`/`ahead`/`wrapS` identities, `buildProfile()` never exceeds `vmax` and respects braking distance | `T.layout()` |
| `test/physics.test.ts` | Full-throttle acceleration curve, coast and brake decelerations, `VMAX` asymptote, de-slot occurs above the grip limit and not below it on each track, banked grip bonus | `Race.step()` with `isPlayer` input |
| `test/laps.test.ts` | Lap count increments once per `L`, finish on lap 13, sub-step crossing-time interpolation, `lapValid` cleared by de-slot/pit/tow/sector skip, `bestLap` only from valid laps | `laps()` |
| `test/lanes.test.ts` | Request consumed only at a switch, `laneClear()` front/back margins, change completes with `cutT` set, cancellation when blocked, pit entry requires outside lane | `requestLane()` |
| `test/penalties.test.ts` | Port the 39 scratch checks: escalation, single incident per contact, grace windows, cut-in blame, chain blame, reachable entrances, deadline conversion, box countdown and reset, AI compliance, per-race reset | `judge()`, `offence()`, `servePenalty()` |
| `test/ai.test.ts` | Each persona completes a 13-lap race alone on each circuit without towing; fuel plan triggers a stop before running dry; defensive move never executes with a car alongside; `defendSafe()` rejects squeeze/pit approach | all-AI race by setting `isPlayer = false` |
| `test/championship.test.ts` | `standings()` points, tie-breaks and DNF handling; `recordChampRound()` logic once extracted from `main.ts` | `R.standings()` |
| `test/records.test.ts` | Board insertion/ordering/trim to ten, ghost rejection on version or lap-length mismatch, initials normalisation | with a fake `localStorage` |

A later browser smoke test (Playwright, already working on this machine with system Chromium) can load the built `dist/` and assert no page errors, the title screen renders, and `advance(60)` reaches lap 2. Keep it out of the required check initially; it needs a browser in CI.

### 7.5 Lint

There is no linter. `tsc --noEmit` under `strict: true` already catches most of what matters. If a linter is wanted, add `eslint` with `typescript-eslint` recommended rules and nothing else; do not add Prettier or a plugin stack to a 4k-line project unless more contributors arrive.

---

## 8. Prioritised action plan

Small, independent tasks. Estimated effort is for a developer who knows the code.

**Before the first deployment**

1. **Commit the current working tree** as two commits (practice/championship/boards; penalties/AI personalities). (High, minutes)
2. **Decide on the Tesana SDK.** Recommended: remove the three `data-tesana-bootstrap` tags from `index.html`, delete the `tesana()` calls in `main.ts` and the `l10n()` lookup in `i18n.ts` (the English fallback is already the real source), and drop the export artefacts (D8). If it stays, add `async`/`defer` to the script tag so unpkg cannot block rendering, and document the data it sends. (High, under an hour)
3. **Remove unused dependencies** `phaser`, both `rapier` packages and `three.quarks`; run `npm ci`, `tsc` and `vite build` to confirm. (Medium, minutes)
4. **Drop the decoder copy plugin** from `vite.config.ts` and delete `public/decoders/` (already git-ignored). (Low, minutes)
5. **Add a favicon** and a `<noscript>`/WebGL fallback: wrap the renderer creation in try/catch and show a plain message in `#app`. (Medium/Low, under an hour)

**Setting up CI/CD**

6. **Add Vitest and the first test file** (`penalties.test.ts` from the existing scratch checks), with `"test": "vitest run"` in `package.json`. (High, half a day)
7. **Add `.github/workflows/ci.yml`** with the `check` job only; enable branch protection on `main`. (High, under an hour)
8. **Provision the VPS**: unprivileged deploy user, release directory layout with `current` symlink, Nginx site config from 7.2, HTTPS via certbot. Manual, one-off. (High, an hour)
9. **Add the `deploy` job** with environment secrets and the rsync/symlink steps; do one deploy; practise a rollback by re-pointing the symlink. (High, an hour)
10. **Add the remaining test files** from 7.4, starting with laps and lanes. (Medium, a day in total)

**Preparing for multiplayer (no behaviour change)**

11. Gate `window.__game` behind `import.meta.env.DEV` or `?debug`. (Low, minutes)
12. Replace `driverName`/`driverColor` in `main.ts` with `DRIVERS`. (Low, minutes)
13. Move `recordChampRound()`'s classification into `race.ts` (or `records.ts`) as a pure function with a test. (Medium, an hour)
14. Per-car input and human flag (M2). (High, half a day)
15. Seeded PRNG through `RaceOpts` (M3). (Medium, an hour)
16. Track instance owned by `Race` (M1). (High, one to two days)
17. Snapshot/apply and the loopback test (M4). (Medium, a day)
18. Fixed-step server loop, rooms and WebSocket transport. (High, multi-day; start only after 14–17)

---

## Appendix: checks run for this audit

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Clean, 1.4 s wall |
| Production build | `npx vite build` | OK, 1.2 s; `index-*.js` 678.18 kB (gzip 185.70 kB), `index-*.css` 9.79 kB; chunk-size warning |
| Build output size | `du -sh dist/*` | 3.0 MB total, of which `decoders/` 2.4 MB unused |
| Vulnerabilities | `npm audit` (prod and full) | 0 found |
| Unused imports | `grep` for `phaser`, `rapier`, `quarks`, `GLTFLoader`, `DRACO`, `KTX2` in `src/` | No matches |
| Lint / test tooling | listed `node_modules/.bin`, looked for `eslint.config.*`, `vitest`, `.github/` | None present |
| Headless production load | `vite preview` + Playwright with system Chromium, WebGL via SwiftShader | Page loaded in about 5 s in the software renderer; no `pageerror`; console: one 404 (favicon); `window.__game` present; `startSession('race')` + `advance(30)` reached `phase: 'racing'` |
| Network on load | Playwright request log | Local: `/`, JS, CSS. External: `unpkg.com` SDK script, `GET …cloudfront.net/v1/config?gameId=…`, `POST …cloudfront.net/v1/auth/guest`; `localStorage['tesana.play.v1']` written with a JWT |
| Node/npm | `node -v`, `npm -v` | v26.12.1, 11.20.0; Vite requires `^20.19.0 \|\| >=22.12.0` |
| Simulation in Node | esbuild bundle of `track.ts` + `race.ts` driven from Node (earlier in this session) | 20 all-AI races and 5 player-controller races across all circuits completed; 39 scripted rule checks passed |

No infrastructure was installed and nothing was deployed.
