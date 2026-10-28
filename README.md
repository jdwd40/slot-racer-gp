# Slot Rush GP

A tabletop slot-car racing game: TypeScript, Three.js and Vite. It runs entirely in the browser with no backend; leaderboards, practice ghosts and championship progress are stored in the browser's `localStorage`.

Originally exported from Tesana on 2026-10-26; the Tesana play-service integration has since been removed so the game is self-hosted.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve dist/ locally
```

The build output is plain HTML/JS/CSS; serve the `dist/` folder from any static host.

## Layout

- `index.html` — the page that boots the game.
- `src/` — TypeScript source (`src/main.ts` is the entry; `src/race.ts` and `src/track.ts` are the simulation).
- `assets/ui/strings.json` — all player-visible text.
- `docs/architecture-audit.md` — architecture and deployment audit.
