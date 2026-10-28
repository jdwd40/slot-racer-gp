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
```

The same three steps plus `npm run build` run in GitHub Actions (`.github/workflows/ci.yml`) on pull requests and pushes to `main`. The workflow only checks; it does not deploy.

The tests cover the simulation only (`src/race.ts`, `src/track.ts`, `src/records.ts`): collision penalties, lap counting, lane changes, leaderboards and championship scoring, and a bounded all-AI race on each circuit. Rendering, audio and input are not covered.

The build output is plain HTML/JS/CSS; serve the `dist/` folder from any static host.

## Layout

- `index.html` — the page that boots the game.
- `src/` — TypeScript source (`src/main.ts` is the entry; `src/race.ts` and `src/track.ts` are the simulation).
- `assets/ui/strings.json` — all player-visible text.
- `docs/architecture-audit.md` — architecture and deployment audit.
