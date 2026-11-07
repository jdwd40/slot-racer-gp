# Simulation timing

Race time comes from a fixed-step clock (`FixedStepper`, `src/timing.ts`), so a slow frame no longer slows the race. This fixes clock accuracy only. It does not make rendering faster or smoother: a 10 FPS machine still shows 10 FPS.

## Policy

| Setting | Value | Meaning |
| --- | --- | --- |
| `STEP` | 1/60 s | One simulation step. `Race.update` runs it as two 1/120 s sub-steps. |
| `MAX_GAP` | 250 ms | Longest gap between animation callbacks that counts in full. |
| `MAX_STEPS` | 15 | Most steps one callback can run. 10 FPS needs 6. |

- **Normal play (gaps up to 250 ms, so 4 FPS and above):** all elapsed time is kept. Under one step of remainder carries to the next callback.
- **Stall or overload (gap over 250 ms):** the callback runs 250 ms of simulation and the excess is dropped at once. It is never carried, so no backlog builds and no burst follows. A sustained rate under 4 FPS therefore runs the race slower than wall time, at 250 ms per callback.
- **Pause, blur, hidden tab, restart, session or track change:** the time baseline is rebased, so the next callback counts as zero elapsed time and nothing is replayed. Blur and hidden both clear held keys and pause a running race. Hidden was not a pause trigger before; it now is, in case a browser hides the tab without a blur.
- **Session ends mid-callback:** if a step hands over to a screen that does not simulate (championship standings), the remaining steps are dropped.

`tick()` runs once per step, so physics, clocks, penalties, events, timing-line crossings and ghost samples share one timeline. Held keys are read on every step. Lane and pit requests stay on `keydown`, outside the step loop, so each press applies once.

`frame()` renders once per callback. Cars and the camera are drawn blended between the last two simulation states; blended poses are never written back to `Race`. The ghost is drawn at the same blended time. Camera, wheels and toasts use the real frame gap, capped at `MAX_GAP`. The HUD clock reads the authoritative race time.

Gameplay constants and the save and ghost formats are unchanged.

## Evidence

All results were taken on Node 22.23.4 (the `.nvmrc` pin).

`npm run typecheck`, `npm test` (114 tests: 72 existing, 42 new in `test/timing.test.ts`) and `npm run build` pass. Reintroducing seven defects one at a time (the 50 ms clamp, no clamp, no stop when a session ends, no rebase while inactive, a no-op rebase, negative gaps, no teleport snap) each made tests fail.

The tests show:

- Race time stays within one step of active wall time at 60, 30, 20, 15 and 10 FPS, and within one step plus 0.05 s on the displayed clock. Active time starts when the lights go out.
- Irregular gaps up to 240 ms accumulate no slowdown over 80 s or more.
- With the same seed, a race is identical at all five rates after 3,600 steps, including every event.
- A lap differs by under 0.05 s from the old variable sub-steps, so stored lap times stay comparable.
- A 10 FPS practice lap records the same ghost as a 60 FPS one. That ghost survives save and load and replays within 0.03 track units of the driven path, from the second sample on. The t=0 sample is taken just past the line, as it was before this change, so it reads up to one step ahead.
- A ghost and a leaderboard in the previous build's stored form load, play and rank correctly.

### Browser diagnostics (SwiftShader only)

The build host has no GPU. Every result here is a Chromium SwiftShader diagnostic. **No real GPU was tested, and none of this is evidence of smooth rendering.**

Controlled rate through the real `main.ts`, with synthetic `requestAnimationFrame` timestamps. The baseline is commit `02a5de5`.

| FPS | Wall time | Baseline race clock | Fixed race clock |
| --- | --- | --- | --- |
| 60 | 3.10 s | +3.1000 s | +3.0833 s |
| 30 | 3.00 s | +3.0000 s | +3.0167 s |
| 20 | 3.00 s | +3.0000 s | +3.0000 s |
| 15 | 3.07 s | +2.3000 s | +3.0500 s |
| 10 | 3.00 s | +1.5000 s | +3.0000 s |

Free-running, with the browser's own frame timing:

| Viewport | Rate | Baseline | Fixed |
| --- | --- | --- | --- |
| 240×150 | about 5 FPS | 5.23 s of 20.07 s | 19.13 s of 20.20 s |
| 1280×720 | about 0.9 FPS | 0.55 s of 13.07 s | 2.33 s of 12.19 s |

The fixed build falls short in both rows because of the 250 ms limit: 11 gaps exceeded it in the first row, and the median gap was 1.13 s in the second. The second row is the overload policy, not clock accuracy. The controlled differences above are all within one step (0.0167 s); gaps of 50 ms or less never lost time on the baseline either, so 15 and 10 FPS are the rows that show the fix.

Smoke checks through the real game at a controlled 10 FPS:

- **Rendering:** 20 renders for 20 callbacks.
- **Input:** holding W gave full throttle and the HUD bar showed 100%. Space and P each armed once and showed their chips, and a second press cancelled.
- **Stall:** an 8 s stall advanced the race 0.25 s and dropped 7.75 s. The next second advanced exactly 1 s.
- **Pause:** 20 s paused with Esc advanced 0 s. The first callback after resume advanced 0 s and the second 0.1 s.
- **Blur:** blur paused the race, and throttle was 0 after resume with W never released.
- **Hidden tab:** 60 s hidden advanced 0 s and returned paused.
- **Restart and track change:** the first callback advanced 0 s.
- **Practice ghost:** recorded and saved at 10 FPS with 0.05 s sample spacing and the existing fields, and was running and visible on the next lap.
- **Camera and HUD:** at 960×540, follow, full view and zoom screenshots were correct, and the HUD and minimap agreed. There were no page errors.

## Remaining limitations

- Below 4 FPS the race still runs slower than wall time, by design. The 7 November playtest was not reproduced and its frame rate is unknown, so it may be in this range. If so, it needs the separate graphics work.
- Real-GPU behaviour is untested, including how interpolation looks on 60 Hz and 120 Hz or faster displays.
- Blur and hidden were simulated with synthetic events, not a real tab switch. The hidden-tab return on the results screen and the mid-callback stop were checked only in unit tests.
- `test/timing.test.ts` drives real `Race` and `FixedStepper` objects but mirrors `tick()` in a small harness, because `main.ts` needs a DOM. The browser checks above cover the real code; that one-off script is not committed, and `docs/validation.md` has the repeatable checks.
- Blending draws cars up to one step (16.7 ms) behind the simulation. The minimap is not blended.
- Input is still sampled per callback. A key press applies to every step of that callback, and a tap shorter than a frame gap can be missed, as it could before.
