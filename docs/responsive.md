# Responsive layouts for phones and tablets

The race HUD and every menu adapt to phone portrait, short phone landscape and tablet sizes. The desktop layout is unchanged. This builds on the [touch controls](touch.md) and [pit routing](pit-routing.md), and reuses the Low / Balanced / High [graphics presets](graphics.md) and their saved choice.

**All browser evidence here is Chromium's mobile and touch emulation rendered by SwiftShader on a host with no GPU. It is diagnostic only. No physical phone or tablet, no iOS Safari, no Android Chrome and no real GPU were available, so none of those were tested.**

## Layouts

Layouts are chosen by CSS media queries on the viewport, not by device. "Compact" means at most 700 CSS px wide or at most 500 px tall.

| Layout | Applies to (tested at) | Racing HUD |
| --- | --- | --- |
| Desktop | Wider than 700 px and taller than 500 px, without touch (1440×900) | As before: standings, times, 36 px buttons, 230×200 minimap |
| Tablet, touch | Same sizes with touch on (768×1024) | Touch pad; meters and race messages stacked between Lane/Pit and Throttle; 138×120 minimap |
| Short landscape | Compact and landscape (640×360, 844×390) | Position, lap and time in one top bar. Pause and a **More** (⋯) button at top right. Minimap below them. Meters and messages stacked in the centre column between the controls |
| Phone portrait | Compact, portrait, at most 600 px wide (360×640, 390×844) | Brake, Lane/Pit and Throttle share one bottom row. Fuel, chips and race instructions sit in a full-width band above them. Toasts and start lights sit below the minimap |

What collapses on compact layouts:

- The standings list, the championship round label and the Last / Best times are hidden. Position, lap, time, fuel, penalty and route chips, the refuelling and stop-and-go instructions, and Pause stay visible. The round and the standings are still on the pause and championship cards.
- The throttle meter is hidden, because the Throttle control already shows when it is pressed.
- View, zoom, sound and the practice ghost move into the **More** tray. It is a labelled button with `aria-expanded`, and the tray opens under it, clear of the driving controls. It closes on pause and every other screen change, and when the screen rotates.
- In portrait the follow camera widens until its view is as wide as it would be on a square screen, so the track ahead is not cut to a narrow strip. Landscape and desktop views are unchanged. The overview marker's zoom threshold uses the same measure, so portrait does not show it all the time.

The minimap's size comes from CSS variables. `Hud.fitMini()` reads the computed size, then sets the backing store to that size times the device pixel ratio (capped at 2), and rebuilds the projection. This works while the HUD is hidden on menus, so the drawing logic is unchanged and it stays sharp.

HUD buttons (More, zoom, sound, ghost) act on `touchstart` for a finger and on `click` for a mouse, keyboard or assistive technology. A second finger gets no `click` while the first holds Throttle, and cancelling `touchstart` means no click follows, so nothing fires twice. They have accessible names, and sound and ghost report `aria-pressed`. Every button has a visible `:focus-visible` outline, and hover effects only apply on devices that can hover. Keyboard shortcut hints such as "(R)" are hidden in touch mode.

## Menus

- Cards are no wider than the screen. Their minimum widths, and the 460 px leaderboard and championship table minimums, no longer apply on narrow screens. Every table sits in its own horizontal scroller.
- On compact layouts the card's action row (Start, Resume, Menu, Again…) is pinned to the bottom of the card while the rest scrolls. Track cards form a grid, rival descriptions are dropped and spacing is tighter.
- Overlays sit above the HUD and the pad. The pad is hidden on every menu screen, so a tap on a menu cannot reach a driving control.

## Viewport lifecycle

- `index.html` adds `viewport-fit=cover`, so `env(safe-area-inset-*)` is reported. Browser zoom is not restricted.
- `#app` is one fixed box sized `height: 100%` with a `100dvh` override where supported. The canvas, HUD and menus all fill that box, so they cannot drift apart. Every HUD edge and the overlay padding use `max(margin, env(safe-area-inset-*))`.
- `main.ts` checks the box size and device pixel ratio once per animation frame, before drawing, and refits the renderer, camera aspect and minimap when they change. This replaces the `resize` listener. It catches browser bars and display changes that send no event, and adds no second loop. The canvas is no longer given an inline pixel size, so it always matches the box.
- **Held input:** when the width changes, or the height changes by more than 140 px in total since the current hold began (`ControlsAnchor` and `controlsMoved` in `src/input.ts`), the controls have moved from under the fingers. Every touch hold is released, and the finger must press again. Address and tool bars sliding in or out change only the height, by less than that, so they keep the throttle held. A resize that arrives in many small steps is measured from where the hold began, not frame by frame. Held keys are never released by a resize. The race and its clock carry on untouched. A pause stays paused.
- **On-screen keyboard:** iOS Safari, and Chrome by default, lay the keyboard over the page and shrink only the visual viewport. While a menu field has focus, the overlay pads its bottom by the covered height from `visualViewport`, and the field is scrolled into view. The canvas keeps its size. The initials field also has `autocapitalize="characters"` and `enterkeyhint="done"`, and its 18 px text avoids iOS focus zoom.

## Interaction checklist

Results come from `node scripts/browser-check.mjs responsive` and `touchrace` (emulated touch, SwiftShader). See [Runs](#runs). ✓ means an automated check passed in that run.

| Check | 360×640 | 390×844 | 640×360 | 844×390 | 768×1024 | 1440×900 |
| --- | --- | --- | --- | --- | --- | --- |
| Pad controls on screen, 48 px or more, 8 px or more apart, on top where tapped | ✓ | ✓ | ✓ | ✓ | ✓ | n/a (no touch) |
| Position, lap, time, fuel, chips, status, toast and minimap on screen, overlapping no control or each other, with every message showing at once | ✓ | ✓ | ✓ | ✓ | ✓ | unchanged |
| Screen middle (the car) clear, and at least half the screen is track view | ✓ 70% | ✓ 77% | ✓ 67%, but see [Runs](#runs) | ✓ 72% | ✓ 85% | unchanged |
| Minimap backing = CSS size × DPR, projection matches | ✓ 108×94 | ✓ 117×102 | ✓ 108×94 | ✓ 117×102 | ✓ 138×120 | ✓ 230×200 |
| Canvas fills the box, camera aspect follows | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| More tray: labelled, opens by touch, View/zoom/sound on screen, 48 px, clear of the pad | ✓ | ✓ | ✓ | ✓ | n/a (full row) | n/a |
| Title, pause, results, leaderboards, championship: no sideways page or card overflow, every button and field reachable by scrolling the card and 44 px or more | ✓ | ✓ | ✓ | ✓ | ✓ | — |

Other checks in the same runs:

- **Desktop 1440×900, mouse and keys:** HUD panels at the same positions as before (12 px margins, 280 px meter panel, 230×200 minimap at the bottom right, 36 px buttons), no More button, and no touch class. C and the View button toggle the camera. The pause card keeps its keyboard legend. Resizing the window keeps a held W.
- **Second finger:** with Throttle held, More and Sound each act once and Throttle stays held.
- **Browser bar:** a 56 px height change keeps Throttle held.
- **Rotation mid-hold** (640×360 to 360×640): the hold is released, and the race carries on with the same lap and clock still advancing. The canvas, camera aspect and controls follow. The old finger sliding cannot revive the hold, and a fresh press works. Rotating while paused stays paused with the clock unchanged.
- **Taps on a menu:** taps on the pause overlay where the pad was land on the overlay and drive nothing. Resume leaves nothing held or requested.
- **Championship by touch:** continue a fixture championship, finish the round (by script), store it, start the next round, pause and leave. The save survives a reload.
- **Practice by touch:** the ghost toggles from the tray and reports `aria-pressed`, pause closes the tray, and Restart works.
- **Settings:** Balanced and Touch On chosen by tap survive rotation and a reload. Viewport changes never rewrite the saved preset.
- **Initials with a keyboard:** typed after a tap on the field. The keyboard is simulated by shrinking `visualViewport` to 508 of 844 px, as iOS Safari would. The card clears it, the field and Start stay in view, and the canvas keeps its size. Enter closes the field, the space comes back and the initials are kept.
- **Safe areas:** Chromium's `Emulation.setSafeAreaInsetsOverride` at 47 / 47 / 21 px on 844×390. The controls, the top bar and the pause card stay inside the insets.
- **Full race by touch (`touchrace`):** see [Runs](#runs).

Lane override and the stop-and-go workflow by touch are covered by the existing `touch` scenario (Pit, override, restore and cancel parity with the keyboard, and the compulsory stop that Pit cannot cancel). It now opens the More tray where View and sound moved.

### Screenshots

Half-size WebP copies from the emulated runs are in [`responsive/`](responsive/). The HUD shots are from before the chip-size tweak.

- `race-360x640.webp`, `race-640x360.webp`: the race HUD with every message shown at once (scripted worst case)
- `race-tray-360x640.webp`: the More tray open
- `title-360x640.webp`: the title card with its pinned actions
- `touchrace-service.webp`: refuelling during the touch race at 844×390
- `desktop-1440x900.webp`: the desktop HUD, for regression comparison

## Runs

| Run | Environment | Result |
| --- | --- | --- |
| `responsive` on the source of commit `42ae65c`, before the last CSS tweak below | Headless Chromium 156.0.8078.4, mobile and touch emulation (`isMobile`, `hasTouch`, `maxTouchPoints` 1, coarse pointer), DPR 2, Low, SwiftShader (ANGLE Vulkan, software) | Every layout, lifecycle, menu, keyboard, safe-area, Practice and Championship check above passed, except one: at 640×360 with every message shown at once, the stacked messages reached the middle of the screen. The run then hit its 8-minute limit during the Balanced timing step, so it wrote no report file. Its console output is the record |
| `touchrace` on the source of commit `42ae65c` | Same browser and renderer, 844×390, DPR 1, Low, 422×195 drawing buffer | **7 of 7 passed in 479 s.** 13 laps of Clubman Park driven on the pad alone, finishing P4 in 416.2 s with no unplanned pause. Fuel stop: pit lane, bay, service, bay exit, pit lane, race, in order. The status read "REFUELLING 45% · Hold throttle to leave", clear of every control. Results fit with no overflow, and Race Again gave a fresh countdown, zero clock and a full tank |
| `npm run typecheck`, `npm test`, `npm run build` | Node 22 | Pass, 232 tests, including new `controlsMoved` cases |

After the first `responsive` run, the compact chips and the stop-and-go text were made smaller, and the start lights in portrait moved below the toast, which they could cover. The middle-of-screen check now uses the normal HUD, and reports the everything-at-once case separately. `responsive` has not been re-run on that final CSS.

**Frame time and control response (Low, 844×390, DPR 2, SwiftShader):** the median frame took 233 ms (p95 267 ms), about 4 frames a second. All 12 emulated Brake presses reached the race on the next frame. The press-to-frame figure from that run is not valid: it compared clocks wrongly, and the probe has since been fixed. Balanced was not measured, because the run hit its time limit first. Low and Balanced were both chosen and saved by touch in the same run. These figures describe a software renderer on a CPU-only host. They are not phone frame times or input latency, and no physical-phone performance is claimed.

## Not verified

- **No physical device.** Nothing has run on an Android phone, an iPhone or a tablet, in Chrome, Safari or Firefox. Emulation reports `maxTouchPoints` 1 and cannot reproduce thumbs, palm rejection, system edge gestures or real browser bars.
- **iOS Safari specifics:** the real keyboard behaviour (visual-viewport panning and `offsetTop`), `100dvh` while the toolbar collapses, safe areas on a notched phone, and audio unlock. The keyboard and safe areas were simulated as described above.
- **Real browser chrome:** address bars were simulated as a 56 px height change.
- **Real GPU and phone performance:** SwiftShader frame times are many times slower than any phone GPU, and say nothing about frame time or input latency on a device.
- **Screen readers** with the More tray and the pad.
- **The final CSS** (smaller chips, portrait lights) has not been through `responsive` again. Balanced timing, and press-to-frame timing with the fixed probe, are also unmeasured.
- The existing `touch`, `race`, `routing`, `controlled`, `practice`, `championship` and `tracks` scenarios were not re-run. `touch` and `race` were changed to open the More tray where View and sound moved.
