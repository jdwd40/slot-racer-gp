# Slot Rush GP

A tabletop slot-car racing game: TypeScript, Three.js and Vite. It runs entirely in the browser with no backend; leaderboards, practice ghosts and championship progress are stored in the browser's `localStorage`.

Originally exported from Tesana on 2026-10-26; the Tesana play-service integration has since been removed so the game is self-hosted.

## Run it locally

Use Node 22 (the current LTS; `.nvmrc` pins it, so `nvm use` picks it up). Vite and Vitest need at least Node 22.12.

```bash
npm ci             # install exactly the locked dependencies
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

## Checks

```bash
npm run typecheck  # tsc --noEmit over src/ and test/
npm test           # vitest run: the regression suite, once, no watch mode
npm run check:browser  # bounded real-browser checks, about 11 minutes; not part of CI
```

The same checks plus `npm run build` run in GitHub Actions (`.github/workflows/ci.yml`) on pull requests and pushes to `main`. Successful pushes to `main` then deploy that exact checked build artifact to the static VPS site; PRs never deploy. See [deployment and rollback](docs/deployment.md).

The tests cover the simulation and graphics preset logic only (`src/race.ts`, `src/pit.ts`, `src/track.ts`, `src/records.ts`, `src/timing.ts`, `src/graphics.ts`, `src/input.ts`): collision penalties, lap counting, lane changes, leaderboards and championship scoring, fixed-step timing, graphics preset resolution and storage, input sources and touch pointer handling, and a bounded all-AI race on each circuit, plus the frame-time statistics. Rendering and browser input are covered by `npm run check:browser` instead, and audio by neither. See [browser validation](docs/validation.md), which also has the frame-time capture and comparison.

The build output is plain HTML/JS/CSS; serve the `dist/` folder from any static host.

## Layout

- `index.html` — the page that boots the game.
- `src/` — TypeScript source (`src/main.ts` is the entry; `src/race.ts` and `src/track.ts` are the simulation).
- `assets/ui/strings.json` — all player-visible text.
- `docs/architecture-audit.md` — architecture and deployment audit.
- `docs/timing.md` — simulation timing policy and its test evidence.
- `docs/graphics.md` — graphics presets, their trade-offs and measurements.
- `docs/touch.md` — touch controls, the shared input layer and their evidence.
- `docs/reverse.md` — hold-Brake reverse: tuning, recovery limits, race-integrity rules and evidence.
- `docs/penalties.md` — service obligations: deferral, deadlines, disqualification, results and save compatibility.
- `docs/pit-routing.md` — automatic outside-lane routing for pit visits.
- `docs/pit-queue.md` — shared pit-lane queues, box and bay reservations, bay and pit-exit merges, and their evidence.
- `docs/auto-stop-go.md` — automatic stop-and-go service and its evidence.
- `docs/auto-bay.md` — race-long bay ownership, automatic fuel visits to the car's own bay, the fresh-Throttle departure, and their evidence.
- `docs/validation.md` — repeatable browser checks, results and the remaining hardware validation.
- `scripts/` — the browser check and its frame-time statistics.
