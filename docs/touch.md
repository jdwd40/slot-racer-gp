# Touch controls

The game can be played without a keyboard. **Touch controls: Auto / On / Off** is on the title and pause screens. This is mobile browser support with a basic layout: full responsive layouts are a separate follow-up.

## Setting

- `srgp.touch` holds `auto`, `on` or `off`. A missing or invalid value, or unavailable storage, gives Auto. If storage is blocked, the choice lasts the session.
- Auto turns touch on when `(any-pointer: coarse)` matches or `navigator.maxTouchPoints > 0`. It never reads the user agent, and it follows the media query if the device changes.
- On works on any device, for testing and hybrids. Off hides the pad on any device.
- Changing the setting only changes layout, so a race carries on untouched. The keyboard works in every mode.

## Controls

| Control | Action | Place |
| --- | --- | --- |
| Throttle | Hold | Bottom right, the largest control |
| Brake | Hold | Bottom left |
| Lane, Pit | Tap | Beside Brake, or above it in portrait, so the left thumb has them while the right holds Throttle |
| View, Pause | Tap | Top right, replacing the desktop buttons so they work with a finger already down |

Zoom, sound and ghost stay as ordinary buttons, enlarged to 48×48 CSS pixels. Menu buttons also grow to at least 48 pixels in touch mode. The keyboard legend gives way to a one-line hint.

| State | Shown as |
| --- | --- |
| Pressed | Control shrinks and gains a heavy outline |
| Lane ready | `✓ ready`, solid border |
| Automatic pit route | `P auto`, double border |
| Override | `⇄ override`, dashed border |
| Pit armed | `✓ armed`, solid border |
| Compulsory stop-and-go | `■ must stop`, thick double border |

Lane and Pit states come from `Race` every frame through `laneCue` and `pitCue`. The pad keeps no request state of its own.

## Input layer

`src/input.ts` holds the shared layer. `src/main.ts` connects it to the race.

- `DrivingInput` records which source holds which action. Each key is `key:<code>` and each finger is `pointer:<id>`, so one source letting go never releases another. An action is held while any source holds it.
- Taps call one handler per action, and those handlers call `Race.requestLane()` and `Race.requestPit()`. Space and P use the same path, so [pit routing](pit-routing.md) needs no touch logic.
- `TouchPad` follows each pointer id. Every control captures its pointer, and `pointerup`, `pointercancel` and `lostpointercapture` all release it. Repeats are no-ops, and a pointer id only counts on the control that holds it.
- Taps fire on `pointerdown`, because browsers do not reliably send `click` for a second finger while the first is held. `touchstart` is cancelled on the controls, so no `click` follows and a tap cannot land on the menu it opens. A second finger on a pressed tap control is not another tap.

### Lifecycle

Every change of screen goes through `enter()`, which clears all held input, capture and pressed state. That covers pause, restart, results and leaving a race, on any device. Blur and hidden tabs clear input as well. Removing the pad resets it.

Nothing held survives, and only a new press counts. A finger left on the glass is ignored, and keyboard auto-repeat no longer restores a key.

**Changes for keyboard players:**

- W held through Esc or R now needs pressing again.
- A key pressed during a menu does not count once the race starts.
- Space and Enter on a focused menu button now activate that button. Before, they started or resumed the race whichever button had focus.

### Browser gestures

`touch-action: none`, selection and callout suppression, and the cancelled `contextmenu` apply to the driving controls only. Menus and the track view keep scrolling and browser zoom, and the viewport tag does not restrict zoom.

### Audio

Audio starts from the existing `Sfx.init()`. The pad calls it on press and release, because touch browsers accept `pointerup` but not `pointerdown` as a user activation. Every menu button calls it too. Mute is untouched.

## Evidence

**Touch results are Chromium touch emulation, not a physical device. Browser runs used SwiftShader on a host with no GPU, so they are diagnostics only and say nothing about real-GPU behaviour or smoothness.** No physical phone or tablet has been tested. Emulated fingers go through the browser's real pointer, touch and capture pipeline, but emulation reports `maxTouchPoints` 1 and cannot show how real screens, thumbs, system gestures or iOS Safari behave.

RESULTS_PLACEHOLDER
