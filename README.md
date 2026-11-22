# Slot Rush GP

A tabletop slot-car racing game: TypeScript, Three.js and Vite. The game runs entirely in the browser; leaderboards, practice ghosts and championship progress are stored in the browser's `localStorage`. An optional authoritative online room server (`server/`, Node + WebSocket + PostgreSQL) hosts private rooms for 2–4 players; the browser has create/join lobbies, connected solo and online races for desktop and touch ([online client](docs/online-client.md)). Online play is live at https://slotrush.jdwd40.com/: the deployed client is built with `VITE_ONLINE=1` and offers online play only while the server's `/api/health` answers `ok` with its exact protocol version ([online server](docs/online-server.md)).

Originally exported from Tesana on 2026-10-26; the Tesana play-service integration has since been removed so the game is self-hosted.

Licence: all rights reserved, see [LICENSE](LICENSE). The source is public for reference only; no permission to copy, modify, distribute or use it is granted without written permission.

## Run it locally

Use Node 22, the project's pinned runtime (`.nvmrc` pins it, so `nvm use` picks it up). Vite and Vitest need at least Node 22.12. Node 22 is in maintenance LTS and reaches end of life around April 2027; the upgrade checklist is in [docs/online-server.md](docs/online-server.md#upgrading-node).

```bash
npm ci             # install exactly the locked dependencies
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
npm run build:server && npm run server   # optional room server on 127.0.0.1:8787 (dev/preview proxy /api and /ws to it)
```

## Checks

```bash
npm run typecheck  # tsc --noEmit over src/, server/, test/, scripts/*.ts and the build configs
npm run lint       # ESLint + typescript-eslint recommended rules, warn-only (eslint.config.js): reports, exits 0 on warnings
npm test           # vitest run: the regression suite, once, no watch mode
npm run check:browser  # bounded real-browser checks, about 11 minutes; not part of CI
npm run test:db    # database tests against a private local PostgreSQL (.local-pg/); CI runs them on PostgreSQL 17
npm run server:smoke -- http://127.0.0.1:8787   # health and connection check of a running room server
node scripts/online-check.mjs                   # browser checks of lobbies and online races against the real server code (diagnostics)
```

The same checks plus `npm run build` run in GitHub Actions (`.github/workflows/ci.yml`) on pull requests and pushes to `main`. The `server` CI job builds, tests (PostgreSQL 17 service container, no secrets), smoke-checks and packages the room server. A push to `main` deploys the exact checked static build artifact to the VPS site only when **both** the `check` and `server` jobs succeeded for that commit; a failed, cancelled or skipped job blocks it, and PRs never deploy ([deployment and rollback](docs/deployment.md)). A separate `lint` job runs `npm run lint` on the same triggers as a visible report; it is not in the deploy job's `needs`, so it never gates a deployment. Nothing deploys the room server automatically: the owner rolls it out by hand ([release procedure](docs/online-server.md#release-procedure-owner)). Green CI is not four-player browser or accelerated-hardware validation; that is #4. The tests also cover the room server (`test/server/`): room rules, the protocol, headless WebSocket races and the database layer.

The game tests cover the simulation and graphics preset logic (`src/race.ts`, `src/pit.ts`, `src/track.ts`, `src/records.ts`, `src/timing.ts`, `src/graphics.ts`, `src/autoQuality.ts`, `src/input.ts`): collision penalties, lap counting, lane changes, leaderboards and championship scoring, fixed-step timing, graphics preset resolution and storage, the automatic fallback to Low on slow devices, input sources and touch pointer handling, and a bounded all-AI race on each circuit, plus the frame-time statistics. Rendering and browser input are covered by `npm run check:browser` instead, and audio by neither. See [browser validation](docs/validation.md), which also has the frame-time capture and comparison.

The build output is plain HTML/JS/CSS; serve the `dist/` folder from any static host.

### Where new code goes (hub-size budget)

`src/main.ts` (the client hub) and `src/race.ts` (the `Race` class) are capped by line ceilings in `test/hubSize.test.ts`, which runs with `npm test` and so in CI (#141). New behaviour belongs in a subsystem module, wired in from the hub, not in the hub's body: client screens and menu HTML in `src/menu/` (`controls.ts`, `title.ts`, `results.ts`, `account.ts`, `online.ts`, each built once by `src/main.ts` with the state and actions it needs), race rules in a module of their own beside `src/race.ts` with `Race` calling into it (`src/stall.ts`, `src/away.ts`, `src/autoStopGo.ts`, `src/reverse.ts`, `src/squeeze.ts`, `src/recover.ts`, and `src/raceConst.ts` for the tuning they share). A subsystem module takes the `Race` as its first argument, only type-imports `src/race.ts` (no runtime import cycle), and `Race` keeps a one-line method only where tests, the HUD, the server or browser checks call or override that name; new race behaviour goes in such a module, not in the `Race` class body. A PR that only grows a hub is out of scope; one that moves code out of a hub ratchets that hub's ceiling down to its new line count plus 50 lines of slack, in the same PR. A PR that grows either hub by more than 20 net lines without such a ratchet waits for John's sign-off, as does any `RULES_VERSION` / `PROTOCOL_VERSION` change ([shipping: when a PR waits for John](docs/shipping.md), #143).

## Layout

- `index.html` — the page that boots the game.
- `src/` — TypeScript source (`src/main.ts` is the entry; `src/race.ts` and `src/track.ts` are the simulation, with the race rules split out of `Race` in the modules listed above; `src/net/` is the online protocol and client, `src/online.ts` the online gate).
- `server/` — the online room server; `deploy/server/` its systemd unit and environment example.
- `assets/ui/strings.json` — all player-visible text.
- `docs/architecture-audit.md` — the first architecture and deployment audit (2026-10-28, historical).
- `docs/deployment.md` — static deployment, CI artifact handoff and rollback.
- `docs/shipping.md` — the two cases where an automated ship PR waits for John (`needs-john`, `JOHN-OK: rules` / `JOHN-OK: hubs`) (#143).
- `docs/multiplayer-core.md` — the multiplayer race core: seeded, multi-human `Race` (#21).
- `docs/timing.md` — simulation timing policy and its test evidence.
- `docs/graphics.md` — graphics presets, the automatic fallback to Low, their trade-offs and measurements.
- `docs/responsive.md` — layouts for phones and tablets.
- `docs/player-marker.md` — the player marker in the full-circuit view.
- `docs/touch.md` — touch controls, the shared input layer and their evidence.
- `docs/reverse.md` — hold-Brake reverse: tuning, recovery limits, race-integrity rules and evidence.
- `docs/penalties.md` — service obligations: deferral, deadlines, disqualification, results and save compatibility.
- `docs/pit-routing.md` — automatic outside-lane routing for pit visits.
- `docs/pit-queue.md` — shared pit-lane queues, box and bay reservations, bay and pit-exit merges, and their evidence.
- `docs/auto-stop-go.md` — automatic stop-and-go service and its evidence.
- `docs/fuel-laps.md` — the approximate laps-of-fuel figure beside the fuel bar (#87): estimator, fallback, refills, online behaviour and warning colours.
- `docs/auto-bay.md` — race-long bay ownership, automatic fuel visits to the car's own bay, the fresh-Throttle departure, stopped-on-track recovery to the bay (#69), and their evidence.
- `docs/online-client.md` — online lobbies and the online race client; `docs/online-client-evidence.md` — its evidence.
- `docs/online-server.md` — the online room server: rules, protocol, timing policy, accounts, configuration, resource limits, activation and rollback runbook; `docs/online-evidence.md` — its evidence.
- `docs/restore.md` — the restore drill (#144): Postgres dump and restore into a throwaway database, what a host loss keeps, unpacking a checked server release, server and static rollback.
- `docs/accounts.md` — player accounts and driver profiles; `docs/accounts-evidence.md` — its evidence.
- `docs/career.md` — career points, personal bests and race history; `docs/career-evidence.md` — its evidence.
- `docs/validation.md` — repeatable browser checks, results and the remaining hardware validation.
- `scripts/` — the browser and online checks, frame-time and tick statistics, the room server build/pack/smoke/load scripts and the local PostgreSQL runner.
