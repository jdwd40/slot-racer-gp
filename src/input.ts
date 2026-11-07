// Driving input shared by the keyboard and the touch pad. No race logic lives here: holds are read by
// the fixed-step loop, and taps call the one handler main.ts registers for each action.
// See docs/touch.md for the design and its evidence.

export type HoldAction = 'throttle' | 'brake';
export type TapAction = 'lane' | 'pit' | 'view' | 'pause';
export type TouchMode = 'auto' | 'on' | 'off';

export const KEY_HOLDS: Readonly<Record<string, HoldAction>> = { KeyW: 'throttle', ArrowUp: 'throttle', KeyS: 'brake', ArrowDown: 'brake' };
export const KEY_TAPS: Readonly<Record<string, TapAction>> = { Space: 'lane', KeyP: 'pit' };

/** Which sources hold which action. Every key and every pointer is its own source, so one letting go never releases another. */
export class DrivingInput {
  private holds = new Map<string, HoldAction>();

  constructor(private taps: Record<TapAction, () => void>) {}

  press(source: string, action: HoldAction): void { this.holds.set(source, action); }
  release(source: string): void { this.holds.delete(source); }
  /** Forget every source: whatever is still physically down needs a fresh press to count again. */
  clear(): void { this.holds.clear(); }
  held(action: HoldAction): boolean {
    for (const a of this.holds.values()) if (a === action) return true;
    return false;
  }
  tap(action: TapAction): void { this.taps[action](); }
}

// ------------------------------------------------------------ touch pad
/** The slice of a button the pad needs, so it can be driven by plain event targets in tests. */
export interface PadButton extends EventTarget {
  dataset: { hold?: string; tap?: string };
  classList: { toggle(name: string, on: boolean): unknown };
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
}

type PadPointerEvent = Event & { pointerId: number };

/**
 * Turns pointers on the driving controls into actions. Each finger is tracked by its pointer id.
 * A tap fires on pointerdown because browsers do not reliably send click for a second finger while the first is held;
 * touchstart is cancelled so no click can follow, which also keeps a control's tap from landing on the menu it opens.
 */
export class TouchPad {
  private pointers = new Map<number, PadButton>();

  /** onGesture runs on every press and release: release is the event browsers accept for unlocking audio on touch. */
  constructor(private buttons: readonly PadButton[], private input: DrivingInput, private onGesture: () => void) {
    for (const b of buttons) {
      b.addEventListener('pointerdown', (e) => this.down(b, e as PadPointerEvent));
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, (e) => this.up(b, e as PadPointerEvent));
      for (const type of ['touchstart', 'contextmenu']) b.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  private down(b: PadButton, e: PadPointerEvent): void {
    e.preventDefault();
    this.onGesture();
    const repeat = [...this.pointers.values()].includes(b);
    this.pointers.set(e.pointerId, b);
    // capture so the release still arrives here when the finger slides off the control
    try { b.setPointerCapture(e.pointerId); } catch { /* the pointer has already gone; its release is handled by reset at worst */ }
    b.classList.toggle('down', true);
    const { hold, tap } = b.dataset;
    if (hold) this.input.press(`pointer:${e.pointerId}`, hold as HoldAction);
    else if (tap && !repeat) this.input.tap(tap as TapAction);
  }

  private up(b: PadButton, e: PadPointerEvent): void {
    if (e.type === 'pointerup') this.onGesture();
    // pointerup is followed by lostpointercapture: the second is a no-op, and a pointer id only counts on its own control
    if (this.pointers.get(e.pointerId) !== b) return;
    this.pointers.delete(e.pointerId);
    this.input.release(`pointer:${e.pointerId}`);
    b.classList.toggle('down', [...this.pointers.values()].includes(b));
  }

  /** Let go of every pointer. A finger still on the glass stays ignored until it presses again. */
  reset(): void {
    for (const [id, b] of this.pointers) {
      this.input.release(`pointer:${id}`);
      try { if (b.hasPointerCapture(id)) b.releasePointerCapture(id); } catch { /* the pointer has already gone */ }
    }
    this.pointers.clear();
    for (const b of this.buttons) b.classList.toggle('down', false);
  }
}

// ------------------------------------------------------------ viewport
/** The most a browser's address and tool bars change the viewport height, with margin. */
export const CHROME_MAX = 140;

/**
 * Whether a viewport change moved the controls out from under the fingers. Rotation and real resizes do, so holds end there.
 * Browser bars sliding only change the height a little, and must not cut the throttle.
 */
export function controlsMoved(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return a.w !== b.w || Math.abs(a.h - b.h) > CHROME_MAX;
}

// ------------------------------------------------------------ what the pad shows
export type LaneCue = 'idle' | 'armed' | 'routed' | 'override';
export type PitCue = 'idle' | 'armed' | 'compulsory';

/** Lane button state, read from the race: `route` is Race.nextRoute for the player. */
export function laneCue(p: { laneReq: boolean }, route: { override: boolean } | null): LaneCue {
  if (route) return route.override ? 'override' : 'routed';
  return p.laneReq ? 'armed' : 'idle';
}

export function pitCue(p: { pitReq: boolean; pitPenaltyOnly: boolean }): PitCue {
  if (!p.pitReq) return 'idle';
  return p.pitPenaltyOnly ? 'compulsory' : 'armed';
}

// ------------------------------------------------------------ preference
export const TOUCH_MODES: readonly TouchMode[] = ['auto', 'on', 'off'];
export const DEFAULT_TOUCH: TouchMode = 'auto';
export const TOUCH_KEY = 'srgp.touch';
export const COARSE_QUERY = '(any-pointer: coarse)';

/** The stored choice, or the default when it is missing, invalid or storage is unavailable. */
export function savedTouchMode(): TouchMode {
  try { return TOUCH_MODES.find((m) => m === localStorage.getItem(TOUCH_KEY)) ?? DEFAULT_TOUCH; } catch { return DEFAULT_TOUCH; }
}

export function saveTouchMode(m: TouchMode): void {
  try { localStorage.setItem(TOUCH_KEY, m); } catch { /* storage unavailable: the choice lasts this session */ }
}

/** Whether the pad applies. Auto goes by what the device can do: a coarse pointer or any touch points. */
export function touchActive(mode: TouchMode, device: { coarse: boolean; maxTouchPoints: number }): boolean {
  if (mode !== 'auto') return mode === 'on';
  return device.coarse || device.maxTouchPoints > 0;
}
