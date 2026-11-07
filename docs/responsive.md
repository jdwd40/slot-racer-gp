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
- **Held input:** when the width changes, or the height changes by more than 140 px (`controlsMoved` in `src/input.ts`), the controls have moved from under the fingers. Every touch hold is released, and the finger must press again. Address and tool bars sliding in or out change only the height, by less than that, so they keep the throttle held. Held keys are never released by a resize. The race and its clock carry on untouched. A pause stays paused.
- **On-screen keyboard:** iOS Safari, and Chrome by default, lay the keyboard over the page and shrink only the visual viewport. While a menu field has focus, the overlay pads its bottom by the covered height from `visualViewport`, and the field is scrolled into view. The canvas keeps its size. The initials field also has `autocapitalize="characters"` and `enterkeyhint="done"`, and its 18 px text avoids iOS focus zoom.

## Interaction checklist

Results come from `node scripts/browser-check.mjs responsive` and `touchrace` (emulated touch, SwiftShader). ✓ means checked by an automated check in that run.

| Check | 360×640 | 390×844 | 640×360 | 844×390 | 768×1024 | 1440×900 |
| --- | --- | --- | --- | --- | --- | --- |
| Pad controls on screen, 48 px or more, 8 px or more apart, on top where tapped | ✓ | ✓ | ✓ | ✓ | ✓ | n/a (no touch) |
| Position, lap, time, fuel, chips, status, toast and minimap on screen, overlapping no control or each other, with every message showing at once | ✓ | ✓ | ✓ | ✓ | ✓ | unchanged |
| Screen middle (the car) clear, and at least half the screen is track view | ✓ 70% | ✓ 77% | ✓ 67% | ✓ 72% | ✓ 85% | unchanged |
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
- **Full race by touch (`touchrace`):** see [results](#touch-race-and-performance).

Lane override and the stop-and-go workflow by touch are covered by the existing `touch` scenario (Pit, override, restore and cancel parity with the keyboard, and the compulsory stop that Pit cannot cancel). It now opens the More tray where View and sound moved.

### Screenshots

Small WebP copies of the emulated runs are in [`responsive/`](responsive/): the race HUD with every message shown at 360×640 and 640×360, the More tray, the title card at 360×640, and the desktop HUD at 1440×900.

## Touch race and performance

See the run notes below. All numbers are from SwiftShader and say nothing about phone performance.

## Not verified

- **No physical device.** Nothing has run on an Android phone, an iPhone or a tablet, in Chrome, Safari or Firefox. Emulation reports `maxTouchPoints` 1 and cannot reproduce thumbs, palm rejection, system edge gestures or real browser bars.
- **iOS Safari specifics:** the real keyboard behaviour (visual-viewport panning and `offsetTop`), `100dvh` while the toolbar collapses, safe areas on a notched phone, and audio unlock. The keyboard and safe areas were simulated as described above.
- **Real browser chrome:** address bars were simulated as a 56 px height change.
- **Real GPU and phone performance:** SwiftShader frame times are many times slower than any phone GPU, and say nothing about frame time or input latency on a device.
- **Screen readers** with the More tray and the pad.
