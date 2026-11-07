// The shared driving input, the touch pad's pointer handling and the touch preference.
// Buttons here are plain event targets, so the pad's real listeners run; browser behaviour itself is covered by the `touch` browser scenario.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import { Car, Race } from '../src/race';
import { DEFAULT_TOUCH, DrivingInput, KEY_HOLDS, KEY_TAPS, PadButton, TOUCH_KEY, TOUCH_MODES, TapAction, TouchPad, laneCue, pitCue, savedTouchMode, saveTouchMode, touchActive } from '../src/input';
import { t } from '../src/i18n';
import { fresh, memStorage, place, seedRandom } from './helpers';

class FakeButton extends EventTarget implements PadButton {
  dataset: { hold?: string; tap?: string };
  classes = new Set<string>();
  captured = new Set<number>();
  captureFails = false;
  classList = { toggle: (name: string, on: boolean): void => { if (on) this.classes.add(name); else this.classes.delete(name); } };
  constructor(data: { hold?: string; tap?: string }) { super(); this.dataset = data; }
  setPointerCapture(id: number): void { if (this.captureFails) throw new Error('NotFoundError'); this.captured.add(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  get pressed(): boolean { return this.classes.has('down'); }
  fire(type: string, pointerId: number): Event {
    const e = Object.assign(new Event(type, { cancelable: true }), { pointerId });
    this.dispatchEvent(e);
    return e;
  }
}

function rig() {
  const calls: TapAction[] = [];
  const log = (a: TapAction) => () => { calls.push(a); };
  const input = new DrivingInput({ lane: log('lane'), pit: log('pit'), view: log('view'), pause: log('pause') });
  const throttle = new FakeButton({ hold: 'throttle' }), brake = new FakeButton({ hold: 'brake' });
  const lane = new FakeButton({ tap: 'lane' }), pit = new FakeButton({ tap: 'pit' });
  const gesture = vi.fn();
  const pad = new TouchPad([throttle, brake, lane, pit], input, gesture);
  return { calls, input, throttle, brake, lane, pit, pad, gesture };
}

describe('DrivingInput sources', () => {
  it('holds an action while any source holds it', () => {
    const { input } = rig();
    input.press('key:KeyW', 'throttle');
    input.press('key:ArrowUp', 'throttle');
    input.press('pointer:1', 'throttle');
    input.release('key:KeyW');
    expect(input.held('throttle')).toBe(true);
    input.release('pointer:1');
    expect(input.held('throttle')).toBe(true);
    input.release('key:ArrowUp');
    expect(input.held('throttle')).toBe(false);
  });

  it('keeps throttle and brake apart', () => {
    const { input } = rig();
    input.press('key:KeyW', 'throttle');
    input.press('key:KeyS', 'brake');
    input.release('key:KeyW');
    expect(input.held('throttle')).toBe(false);
    expect(input.held('brake')).toBe(true);
  });

  it('ignores releases of sources that hold nothing, however often they come', () => {
    const { input } = rig();
    input.press('key:KeyW', 'throttle');
    input.release('pointer:9');
    input.release('pointer:9');
    expect(input.held('throttle')).toBe(true);
  });

  it('clears every source at once', () => {
    const { input } = rig();
    input.press('key:KeyW', 'throttle');
    input.press('pointer:1', 'brake');
    input.clear();
    expect(input.held('throttle')).toBe(false);
    expect(input.held('brake')).toBe(false);
  });

  it('maps the desktop keys unchanged', () => {
    expect(KEY_HOLDS).toEqual({ KeyW: 'throttle', ArrowUp: 'throttle', KeyS: 'brake', ArrowDown: 'brake' });
    expect(KEY_TAPS).toEqual({ Space: 'lane', KeyP: 'pit' });
  });
});

describe('hold controls', () => {
  it('holds from press to release, with capture and pressed state, and never toggles', () => {
    const { input, throttle } = rig();
    for (let i = 0; i < 2; i++) {
      throttle.fire('pointerdown', 1);
      expect(input.held('throttle')).toBe(true);
      expect(throttle.pressed).toBe(true);
      expect(throttle.captured.has(1)).toBe(true);
      throttle.fire('pointerup', 1);
      expect(input.held('throttle')).toBe(false);
      expect(throttle.pressed).toBe(false);
    }
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('%s ends the hold', (type) => {
    const { input, brake } = rig();
    brake.fire('pointerdown', 4);
    brake.fire(type, 4);
    expect(input.held('brake')).toBe(false);
    expect(brake.pressed).toBe(false);
  });

  it('survives every release event arriving, in any repeat', () => {
    const { input, throttle, brake } = rig();
    throttle.fire('pointerdown', 1);
    brake.fire('pointerdown', 2);
    for (const type of ['pointerup', 'lostpointercapture', 'pointercancel', 'pointerup']) throttle.fire(type, 1);
    expect(input.held('throttle')).toBe(false);
    expect(input.held('brake')).toBe(true);
    expect(brake.pressed).toBe(true);
  });

  it('a stale release of a reused pointer id on another control changes nothing', () => {
    const { input, throttle, brake } = rig();
    throttle.fire('pointerdown', 1);
    brake.fire('lostpointercapture', 1);
    expect(input.held('throttle')).toBe(true);
    expect(throttle.pressed).toBe(true);
  });

  it('keeps a control pressed until the last finger on it lifts', () => {
    const { input, throttle } = rig();
    throttle.fire('pointerdown', 1);
    throttle.fire('pointerdown', 2);
    throttle.fire('pointerup', 1);
    expect(input.held('throttle')).toBe(true);
    expect(throttle.pressed).toBe(true);
    throttle.fire('pointerup', 2);
    expect(input.held('throttle')).toBe(false);
    expect(throttle.pressed).toBe(false);
  });

  it('runs throttle and brake on separate fingers with separate lifetimes', () => {
    const { input, throttle, brake } = rig();
    throttle.fire('pointerdown', 1);
    brake.fire('pointerdown', 2);
    expect([input.held('throttle'), input.held('brake')]).toEqual([true, true]);
    throttle.fire('pointerup', 1);
    expect([input.held('throttle'), input.held('brake')]).toEqual([false, true]);
    throttle.fire('pointerdown', 3);
    brake.fire('pointercancel', 2);
    expect([input.held('throttle'), input.held('brake')]).toEqual([true, false]);
  });

  it('a finger lifting leaves a held key alone, and a key lifting leaves a finger alone', () => {
    const { input, throttle } = rig();
    input.press('key:KeyW', 'throttle');
    throttle.fire('pointerdown', 1);
    throttle.fire('pointerup', 1);
    expect(input.held('throttle')).toBe(true);
    throttle.fire('pointerdown', 2);
    input.release('key:KeyW');
    expect(input.held('throttle')).toBe(true);
  });

  it('still works if the browser refuses capture', () => {
    const { input, throttle } = rig();
    throttle.captureFails = true;
    expect(() => throttle.fire('pointerdown', 1)).not.toThrow();
    expect(input.held('throttle')).toBe(true);
    throttle.fire('pointerup', 1);
    expect(input.held('throttle')).toBe(false);
  });
});

describe('tap controls', () => {
  it('fires once per tap, on the press', () => {
    const { calls, lane } = rig();
    lane.fire('pointerdown', 1);
    expect(calls).toEqual(['lane']);
    lane.fire('pointerup', 1);
    lane.fire('lostpointercapture', 1);
    lane.dispatchEvent(new Event('click'));
    expect(calls).toEqual(['lane']);
    expect(lane.pressed).toBe(false);
  });

  it('cancels touchstart so no click can follow, and the long-press menu', () => {
    const { lane, throttle } = rig();
    for (const [b, type] of [[lane, 'touchstart'], [throttle, 'touchstart'], [throttle, 'contextmenu']] as const) expect(b.fire(type, 1).defaultPrevented).toBe(true);
  });

  it('a second finger on an already pressed tap control is not a second tap', () => {
    const { calls, pit } = rig();
    pit.fire('pointerdown', 1);
    pit.fire('pointerdown', 2);
    pit.fire('pointerup', 1);
    pit.fire('pointerup', 2);
    expect(calls).toEqual(['pit']);
    pit.fire('pointerdown', 3);
    expect(calls).toEqual(['pit', 'pit']);
  });

  it('taps Lane and Pit while throttle and brake stay held', () => {
    const { calls, input, throttle, brake, lane, pit } = rig();
    throttle.fire('pointerdown', 1);
    lane.fire('pointerdown', 2); lane.fire('pointerup', 2);
    brake.fire('pointerdown', 3);
    pit.fire('pointerdown', 4); pit.fire('pointerup', 4);
    expect(calls).toEqual(['lane', 'pit']);
    expect([input.held('throttle'), input.held('brake')]).toEqual([true, true]);
  });
});

describe('reset', () => {
  it('drops holds, capture and pressed state, and needs a fresh press afterwards', () => {
    const { input, throttle, brake, pad } = rig();
    throttle.fire('pointerdown', 1);
    brake.fire('pointerdown', 2);
    pad.reset();
    expect([input.held('throttle'), input.held('brake')]).toEqual([false, false]);
    expect([throttle.pressed, brake.pressed]).toEqual([false, false]);
    expect([throttle.captured.size, brake.captured.size]).toEqual([0, 0]);
    // the finger is still down: its late release does nothing, and only a new press counts
    throttle.fire('pointerup', 1);
    throttle.fire('lostpointercapture', 1);
    expect(input.held('throttle')).toBe(false);
    throttle.fire('pointerdown', 5);
    expect(input.held('throttle')).toBe(true);
  });

  it('leaves the keyboard to its own source and is safe to repeat', () => {
    const { input, throttle, pad } = rig();
    input.press('key:KeyW', 'throttle');
    throttle.fire('pointerdown', 1);
    pad.reset();
    pad.reset();
    expect(input.held('throttle')).toBe(true);
  });

  it('copes with a tap whose own action resets the pad, as Pause does', () => {
    const calls: string[] = [];
    const button = new FakeButton({ tap: 'pause' }), throttle = new FakeButton({ hold: 'throttle' });
    const nop = (): void => {};
    const input = new DrivingInput({ lane: nop, pit: nop, view: nop, pause: () => { calls.push('pause'); pad.reset(); input.clear(); } });
    const pad: TouchPad = new TouchPad([button, throttle], input, nop);
    throttle.fire('pointerdown', 1);
    button.fire('pointerdown', 2);
    expect(calls).toEqual(['pause']);
    expect(input.held('throttle')).toBe(false);
    expect([button.pressed, throttle.pressed]).toEqual([false, false]);
    expect(button.captured.size).toBe(0);
    button.fire('pointerup', 2);
    expect(calls).toEqual(['pause']);
  });

  it('offers audio both presses and releases, including a release after a reset', () => {
    const { throttle, pad, gesture } = rig();
    throttle.fire('pointerdown', 1);
    expect(gesture).toHaveBeenCalledTimes(1);
    pad.reset();
    throttle.fire('pointerup', 1);
    expect(gesture).toHaveBeenCalledTimes(2);
  });
});

describe('same race behaviour as the keyboard', () => {
  beforeEach(() => seedRandom(9));
  afterEach(() => vi.restoreAllMocks());
  const snapshot = (r: Race) => { const p = r.player; return { lane: p.laneReq, pit: p.pitReq, only: p.pitPenaltyOnly, over: p.laneOverride, route: r.nextRoute(p), cues: [laneCue(p, r.nextRoute(p)), pitCue(p)] }; };
  function setup(side: number): { r: Race; P: Car; tap: (a: 'lane' | 'pit') => void } {
    const r = fresh('circuit-1');
    const P = r.player;
    P.isPlayer = true;
    place(P, T.SWITCHES[0].s0 - 8, side, 8);
    const button = { lane: new FakeButton({ tap: 'lane' }), pit: new FakeButton({ tap: 'pit' }) };
    const nop = (): void => {};
    const input = new DrivingInput({ lane: () => r.requestLane(), pit: () => r.requestPit(), view: nop, pause: nop });
    new TouchPad([button.lane, button.pit], input, nop);
    let id = 10;
    const tap = (a: 'lane' | 'pit'): void => { id++; button[a].fire('pointerdown', id); button[a].fire('pointerup', id); button[a].fire('lostpointercapture', id); };
    return { r, P, tap };
  }

  it.each([[-1, 'outside'], [1, 'inside']])('a tap sequence from the %s lane matches direct requests step by step', (side) => {
    const a = setup(side as number), b = setup(side as number);
    for (const act of ['lane', 'lane', 'pit', 'lane', 'lane', 'lane', 'pit', 'pit'] as const) {
      a.tap(act);
      if (act === 'lane') b.r.requestLane(); else b.r.requestPit();
      expect(snapshot(a.r)).toEqual(snapshot(b.r));
    }
  });

  it('shows armed, routed, override and compulsory states from the race itself', () => {
    const { r, P, tap } = setup(1);
    expect(snapshot(r).cues).toEqual(['idle', 'idle']);
    tap('lane');
    expect(snapshot(r).cues).toEqual(['armed', 'idle']);
    tap('lane');
    tap('pit');
    expect(snapshot(r).cues).toEqual(['routed', 'armed']);
    tap('lane');
    expect(snapshot(r).cues).toEqual(['override', 'armed']);
    tap('lane');
    tap('pit');
    expect(snapshot(r).cues).toEqual(['idle', 'idle']);
    P.offences = 2;
    r.offence(P, r.cars[1], 'rear');
    expect(snapshot(r).cues).toEqual(['routed', 'compulsory']);
    // Pit cannot cancel a stop-and-go: it adds a fuel stop on top and takes it off again
    tap('pit');
    expect(snapshot(r).cues).toEqual(['routed', 'armed']);
    expect(P.pitReq).toBe(true);
    tap('pit');
    expect(snapshot(r).cues).toEqual(['routed', 'compulsory']);
  });

  it('has a label for every state', () => {
    for (const s of ['idle', 'armed', 'routed', 'override']) expect(t(`touch.lane.${s}`)).not.toBe(`touch.lane.${s}`);
    for (const s of ['idle', 'armed', 'compulsory']) expect(t(`touch.pit.${s}`)).not.toBe(`touch.pit.${s}`);
    for (const m of TOUCH_MODES) expect(t(`touch.${m}`)).not.toBe(`touch.${m}`);
  });
});

describe('touch preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to Auto', () => {
    vi.stubGlobal('localStorage', memStorage());
    expect(DEFAULT_TOUCH).toBe('auto');
    expect(savedTouchMode()).toBe('auto');
  });

  it.each(TOUCH_MODES)('saves and reloads %s', (m) => {
    const store = memStorage();
    vi.stubGlobal('localStorage', store);
    saveTouchMode(m);
    expect(store.getItem(TOUCH_KEY)).toBe(m);
    expect(savedTouchMode()).toBe(m);
  });

  it.each(['', 'ON', 'true', '{"mode":"on"}'])('treats %j as the default', (bad) => {
    vi.stubGlobal('localStorage', memStorage({ [TOUCH_KEY]: bad }));
    expect(savedTouchMode()).toBe('auto');
  });

  it('survives storage that throws or does not exist', () => {
    const blocked = (): never => { throw new Error('SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(savedTouchMode()).toBe('auto');
    expect(() => saveTouchMode('on')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(savedTouchMode()).toBe('auto');
    expect(() => saveTouchMode('on')).not.toThrow();
  });

  it('Auto follows device capability; On and Off do not', () => {
    const desktop = { coarse: false, maxTouchPoints: 0 }, phone = { coarse: true, maxTouchPoints: 5 }, hybrid = { coarse: false, maxTouchPoints: 10 };
    expect(touchActive('auto', desktop)).toBe(false);
    expect(touchActive('auto', phone)).toBe(true);
    expect(touchActive('auto', hybrid)).toBe(true);
    expect(touchActive('auto', { coarse: true, maxTouchPoints: 0 })).toBe(true);
    expect(touchActive('on', desktop)).toBe(true);
    expect(touchActive('off', phone)).toBe(false);
  });
});
