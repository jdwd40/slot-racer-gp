# Browser validation

Repeatable checks of the real game in a real browser, what they showed, and what is still open.

**The accelerated-hardware item is outstanding, so the validation issue stays open.** The build host has no GPU. Every browser result below is a SwiftShader diagnostic. Nothing here shows real-time smoothness on any hardware.

## Procedure

Needs Node 22 (`.nvmrc`), `npm ci`, and a Chromium for Playwright. `playwright-core` is pinned to 1.64.0 and downloads nothing on install, so run `npx playwright-core install chromium` once, or pass `--channel chrome` to use an installed Chrome. Every browser context is a new throwaway profile, so existing browser data is neither read nor changed. Saves are test fixtures.

```bash
npm run check:browser                                # build, then every scenario
node scripts/browser-check.mjs race controlled       # chosen scenarios on the existing dist/
npm run check:perf -- --label updated --machine "<name>"   # frame-time capture of dist/
node scripts/browser-check.mjs compare <baseline.json> <updated.json>
node scripts/browser-check.mjs tracks --url https://slotrush.jdwd40.com/   # production, records /REVISION
```

The check is not part of CI: it needs a browser and takes about 11 minutes. Output goes to `.qa/browser-check/` (git-ignored) unless `--out` is given. Each report records the commit, public `/REVISION` for `--url` runs, browser, OS, WebGL renderer, hardware or software status, viewport, drawing-buffer size, DPR, track, car, camera and preset.

**Bounds:** every run has a hard limit (`--max-minutes`, default 25) and exits with code 2 if it is reached. Each scenario also has its own driving budgets. Exit 0 means every check passed, and 1 means a check failed.

Functional runs default to 480×270 at Low so SwiftShader can run them. Perf captures default to 1280×720 at Balanced, DPR 1, 120 s active with one 2 s pause.

| Scenario | How it runs | Covers |
| --- | --- | --- |
| `race` | Real frames and real keys, no scripted state | Clubman Park, Sunburst, 13 laps: countdown, throttle, brake, lane request, camera, pause and resume, pit request, entry, service and exit, finish, results, restart, clock policy |
| `controlled` | Scripted set-up with `__game.advance`, then real frames and keys | De-slot and recovery, warning, stop-and-go served, and unserved (disqualified at the flag), blur, hidden tab, 1.5 s stall, resize, restart |
| `routing` | Scripted placement, then real frames and keys | Pit and stop-and-go outside routing: Space override, HUD chips and arrows, fuel stop, serve, and pit entry from the inside lane on every circuit |
| `practice` | Real keys, fixture saves | Valid lap, PB, ghost save and replay, invalid lap, reload |
| `championship` | Fixture saves, race skipped by script | Continue, round stored once, reload, damaged saves |
| `tracks` | Real frames | Every configured circuit loads and draws in both camera views |
| `touch` | Chromium touch emulation and real mouse and keys, some scripted placement | Touch setting, multi-touch, release paths, lifecycle, Lane and Pit parity with the keyboard, touch-only flow, layouts. See [touch controls](touch.md) |
| `responsive` | Chromium mobile emulation at DPR 2, 1440×900 desktop, some scripted state | HUD and menus at 360×640, 390×844, 640×360, 844×390 and 768×1024, desktop geometry, rotation and browser bars with input held, overlays, keyboard, safe areas, Practice and Championship by touch, frame and press timing. See [responsive layouts](responsive.md) |
| `touchrace` | Real frames, emulated touch only, 844×390 | Clubman Park, 13 laps on the pad: fuel stop, finish, results, Race Again |
| `reverse` | Scripted placement, then real keys and emulated touch | Hold-Brake reverse: HUD cue, overshot box and bay, blur and resume, touch Brake and pointer cancel. See [reverse](reverse.md) |
| `queue` | Scripted placement, then real keys and emulated touch at 844×390 | Shared pit queue: Queued behind the box on Throttle alone, Brake held through the hold, Waiting for bay, a latched bay exit, Waiting for clear exit at the pit exit, the same on the touch pad. See [pit queues](pit-queue.md) |
| `service` | Scripted placement, then real keys and emulated touch at 360×640 and 640×360 | Service obligations: request, N and touch Defer, route release and re-arm, refused toggles, latched breach, DQ on the results screen and in a championship round, Defer layout, final lap with the box occupied. See [service obligations](penalties.md) |

`__game.advance` and scripted state are functional coverage only and are never used for timing or smoothness.

### Metrics

`scripts/frame-stats.mjs` works from one row per animation callback, tested in `test/frameStats.test.ts`.

- A frame gap counts as active only when both ends are racing. Countdown, pause and other screens are reported separately, and measurement duration covers everything.
- Frame time and clock are reported independently. Frame time is median, p95, p99 and gaps over 50 ms.
- Clock error is race time minus (active wall time minus dropped time). It should stay within one step under the policy in [timing](timing.md).
- The renderer stays on for every capture, and the report records draw calls.

## Status

| Item | Status |
| --- | --- |
| Bounded browser procedure and diagnostics | Completed |
| 13-lap Clubman Park race to the real results screen and restart | Completed on SwiftShader |
| Controlled, practice, championship and per-circuit checks | Completed on SwiftShader |
| Clock against the [timing](timing.md) policy | Completed on SwiftShader |
| Real window blur and tab switch | Unavailable: only synthetic events were tested |
| Like-for-like comparison with `02a5de5` | Completed on SwiftShader as a diagnostic. Unavailable on accelerated hardware: no genuine baseline capture exists |
| **Accelerated-hardware frame-time goal** | **Outstanding: not assessed** |
| CI outcome for this work | Unavailable: not pushed, and the build host has no GitHub access |

No check failed in the recorded runs. No new game defect was found.

## Results

All browser results are **SwiftShader diagnostics**, taken 7 November 2026 on the build host. They show the game works functionally. They say nothing about smoothness on real hardware.

| Field | Value |
| --- | --- |
| Tested commit | `a95432fa1e2c1425977b420b6b3b52ee1f7ffd59` (local `vite preview` of the production build). This is the commit that added the checks; only docs changed after it |
| Machine | `build-host-no-gpu`, 4 vCPU |
| Browser and OS | Headless Chromium 156.0.8078.4, Linux 7.0.0-42-generic x64, Node 26.7.0 (the `.nvmrc` pin, 22, is not on this host) |
| Renderer | ANGLE, Vulkan 1.3.0, SwiftShader Device (Subzero). Status: software |
| Race settings | Clubman Park, Sunburst, follow camera, Low, 480×270 CSS viewport, 240×135 drawing buffer, DPR 1 |

### Functional

| Scenario | Status | Passed | Failed | Unavailable | Seconds |
| --- | --- | --- | --- | --- | --- |
| tracks | Passed | 6 | 0 | 0 | 173 |
| race | Passed | 23 | 0 | 0 | 306 |
| controlled | Passed | 17 | 0 | 1 | 45 |
| practice | Passed | 10 | 0 | 0 | 87 |
| championship | Passed | 9 | 0 | 0 | 66 |

**Race.** The car reached the flag on lap 13 of 13 and the real Race Results screen appeared: phase `done`, four rows, "You finished P4". Race Again gave a fresh countdown, a zero clock and a full tank. The scripted driver is cautious, so P4 at +65.7 s says nothing about the AI balance.

- **Start:** lights 1 to 5 then GO. W held through the lights revved the car without moving it.
- **Controls:** full throttle, 23.0 top speed, 357 braking frames. Space changed lane and back. C, the mouse wheel and the View button all switched camera.
- **Pause:** Esc on lap 2 held the clock at 41.650 s for 2 s, then resumed. `race-paused.png` is the pause card and is not used as finish evidence.
- **Pits:** two stops, each with P armed, then pit lane, bay, service, bay exit and back to racing. The first stop entered at 117.2 s and serviced from 120.5 s to 125.4 s. The second entered at 238.9 s and serviced from 241.5 s to 243.6 s.
- **Laps:** the counter ran 1 to 13 once each. The 13 lap times add up to the 263.366 s finish time, less the run to the first crossing.
- **Clock:** 266.906 s active wall time, 266.367 s race time, 0.550 s dropped by the 250 ms rule. The unexplained error is 0.010 s, inside the one-step tolerance of 0.019 s. Countdown (5.5 s), the pause (4.2 s) and other screens (21.5 s) are excluded from the 298.1 s measurement.

**Controlled.** A flat-out corner entry de-slotted the car and voided the lap, and the marshal replaced it behind the exit with grace. The first contact gave a warning. The third gave a stop-and-go, served in the box with no time penalty. An unserved stop added +10 s at the flag and on the results screen. Blur and hidden paused the race, and hidden replayed nothing on return. A real 1.5 s main-thread stall raced 250 ms and dropped the rest with no burst after. Resize and R restart also passed.

**Practice.** A valid lap of 19.364 s set the PB, joined the board beside a fixture lap and saved a ghost of 389 samples. The ghost replayed on its recorded path. A de-slotted lap saved nothing and was announced as invalid. PB and ghost came back after a reload, and fixture saves for other tracks and cars stayed byte-identical.

**Championship.** A two-round save continued to round 3 on Workshop Crossing, stored that round once, and offered round 4 after a reload. Corrupt and wrong-version saves left a working title screen. Other saves stayed byte-identical.

**Tracks.** All five circuits loaded and drew in both camera views, checked by pixel variety and by looking at the screenshots.

### Frame time and clock, baseline against updated

Same machine, renderer, 640×360 viewport and 640×360 drawing buffer, DPR 1, Clubman Park, Sunburst, follow camera and workload: race mode from the grid, seed 20261107, 60 s active with one 2 s pause, scripted driver on real keys, renderer on. The preset is Balanced on the updated build. The baseline has no presets. `compare` reported like for like.

| Build | Commit | Median ms | p95 ms | p99 ms | Gaps > 50 ms | Active wall s | Race s | Dropped s | Countdown s | Pauses / s | Measured s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | `02a5de5` | 333.4 | 416.7 | 466.6 | 176 of 176 | 60.781 | 8.800 | n/a | 37.848 | 1 / 2.716 | 125.262 |
| Updated | `a95432f` | 316.7 | 416.5 | 483.3 | 185 of 185 | 60.448 | 46.250 | 14.198 | 9.016 | 1 / 2.917 | 100.263 |

**Diagnostic only, and not a performance result.** Frame times are about the same, and this software renderer says nothing about a GPU. Every gap exceeded 250 ms, so at about 3 FPS both builds were overloaded. What the capture does show is the clock: the baseline raced 8.8 s of 60.8 s. The updated build raced 46.25 s, dropped 14.198 s under the policy, and had 0.000 s unexplained. Below 4 FPS the policy runs slower than wall time by design. The goal assessment is `unavailable` for both.

### Production

`/REVISION` on https://slotrush.jdwd40.com/ returned `f2c47fcca73c4f2c279e4d6ea7eedb55ce6681b7` on 7 November 2026. That is the parent of `a95432f`, so the fixes from #1 to #3 are live and these checks are not. `tracks --url` passed against it: 6 of 6, all five circuits, no page errors, Low, 960×540 viewport, SwiftShader.

### Repository checks

`npm run typecheck`, `npm test` (134 tests, 12 of them new in `test/frameStats.test.ts`), `npm run build` and the 17 deployment tooling tests pass locally on Node 26.7.0. CI and deployment files are unchanged. No CI run exists for this work yet.

## Limitations

- **Functional runs are Low at 480×270**, chosen so SwiftShader can finish. Only the race ran in real frames from start to finish, and its input lands several frames late at about 7 FPS.
- **Scripted steps:** `controlled` and `championship` use scripted state and `__game.advance` to reach their situations. Penalties in the full race were not exercised: it had no offences.
- **Ghost evidence is scene state** (running, visible, position against the recording). At 480×270 the fixed-size HUD covers most of the view, so `practice-ghost.png` does not show the ghost.
- **Each scenario was recorded once.** Earlier runs of the penalty-box driver sometimes missed the box. After the fix, seven `controlled` runs passed in about 47 s, and an eighth hit a deliberately tight 66 s limit with no report, so the cause is unknown. Treat a repeat of that as harness flakiness until shown otherwise. The default limit is far higher.
- **Seeded defects** (for example results replaced by the pause card, a skipped lap, an unsaved ghost and a no-op rebase) were all caught by an earlier version of the harness. That was not repeated on the final version.
- **Not tested:** Firefox, Safari, real high-DPR displays and audio.
- **Instrumentation:** the frame trace and scripted driver add a little main-thread work to both builds in a capture.

## Follow-ups to file

GitHub is not reachable from the build host, so these still need filing:

1. Run the accelerated-hardware procedure below. This is the open item on the validation issue.
2. Find out why `controlled` occasionally exceeds about 66 s.
3. Check real window blur and tab switching by hand on a real display.

## Remaining hardware validation

Not done. **Keep the validation issue open until this is recorded here.**

The proposed goal below is in `scripts/frame-stats.mjs` and was fixed before any assessment. It still needs the owner's agreement, and the reference machine needs naming.

| Metric, active racing only | Goal |
| --- | --- |
| Median frame time | ≤ 17.5 ms |
| p95 | ≤ 25 ms |
| p99 | ≤ 34 ms |
| Gaps over 50 ms | ≤ 1 per minute |
| Sample | ≥ 60 s |

Use one named machine with a real GPU, on mains power, with other apps closed. Keep the game window in front, because losing focus pauses the race. Note the display refresh rate by hand, as the page cannot report it.

```bash
# baseline, in its own checkout
git worktree add /tmp/slot-baseline 02a5de5d3ad1f128ec6e53dc3f0639505a4f1e63
(cd /tmp/slot-baseline && npm ci && npm run build)

# updated build
npm ci && npm run build

# same settings for both
SET=(--machine "<name>" --headed --channel chrome --viewport 1280x720 --dpr 1 --preset balanced --seconds 120 --out .qa/perf)
node scripts/browser-check.mjs perf --dist /tmp/slot-baseline/dist --commit 02a5de5d3ad1f128ec6e53dc3f0639505a4f1e63 --label baseline "${SET[@]}"
node scripts/browser-check.mjs perf --label updated "${SET[@]}"
node scripts/browser-check.mjs compare .qa/perf/perf-baseline.json .qa/perf/perf-updated.json

# the full race on the same machine
node scripts/browser-check.mjs race --machine "<name>" --headed --channel chrome --viewport 1280x720 --preset balanced
```

Accept only if:

1. The report shows `acceleration: hardware` and a renderer that names the actual GPU. Record that device and the preset.
2. `compare` says like for like. The baseline has no presets, so its drawing buffer stands in for the preset.
3. `compare` prints `Goal, updated: met`. If Balanced misses, record that, then repeat at Low and report both.
4. `race` passes with renderer and preset recorded.

Then add the results here, labelled as the user's own hardware or as reference-machine evidence. A different machine is reference-machine evidence only. By hand, also press Alt+Tab and switch tabs mid-race: each should pause and resume without a jump in race time.
