// The automatic Low fallback's decision logic (#66), driven by synthetic requestAnimationFrame timestamps.
import { describe, it, expect } from 'vitest';
import { AUTO_KEY, AutoQuality, MIN_SAMPLES, SLOW_MEDIAN_MS, WINDOW_MS, median } from '../src/autoQuality';
import { GRAPHICS_KEY, PresetId } from '../src/graphics';
import { memStorage } from './helpers';

/** A driver that plays frames `gap` ms apart into `aq`, the way main.ts's frame() does, and counts the switches it asks for. */
function rig(aq: AutoQuality, start: PresetId = 'balanced') {
  let now = 1000;
  let preset: PresetId = start;
  let switches = 0;
  const step = (gap: number, counting = true): void => {
    now += gap;
    const to = aq.frame(now, counting, preset);
    if (to) { preset = to; switches++; }
  };
  return {
    get preset() { return preset; }, set preset(p: PresetId) { preset = p; },
    get switches() { return switches; },
    step,
    /** `ms` of wall time in frames `gap` ms apart (plus the first frame, which only starts the clock) */
    run(ms: number, gap: number, counting = true): void { for (let t = 0; t <= ms; t += gap) step(gap, counting); },
  };
}

const throwing = (): Storage => new Proxy({} as Storage, { get: () => () => { throw new Error('SecurityError'); } });

describe('median', () => {
  it('takes the middle value, or the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('automatic fallback to Low', () => {
  it('leaves a fast device alone', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.run(20000, 1000 / 60);
    expect(r.switches).toBe(0);
    expect(r.preset).toBe('balanced');
    expect(aq.state).toBe('eligible');
  });

  it('switches a slow device to Low exactly once, after the 5 s window and not before', () => {
    const store = memStorage();
    const aq = new AutoQuality(store);
    const r = rig(aq); aq.beginRace();
    r.run(WINDOW_MS - 400, 150);   // the issue's SwiftShader p50: 150 ms
    expect(r.switches).toBe(0);
    r.run(30000, 150);
    expect(r.switches).toBe(1);
    expect(r.preset).toBe('low');
    expect(aq.state).toBe('switched');
    expect(store.getItem(AUTO_KEY)).toBe('switched:balanced');
  });

  it('uses the median: a one-off compile stall, or a few slow frames, cannot trigger it alone', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.step(16);                // first frame: starts the clock
    r.step(4000);              // shader compile / scene build stall that fills most of the window
    r.step(1500);
    r.run(20000, 20);          // then a steady 50 FPS
    expect(r.switches).toBe(0);
  });

  it('does not decide from fewer than MIN_SAMPLES gaps, however long they were', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.step(0);                                          // clock starts
    for (let i = 0; i < MIN_SAMPLES - 1; i++) r.step(6000);
    expect(r.switches).toBe(0);
    r.step(6000);
    expect(r.switches).toBe(1);                         // a device this slow really is slow
  });

  it('treats exactly the threshold as fast (it must be over 50 ms)', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.run(10000, SLOW_MEDIAN_MS);
    expect(r.switches).toBe(0);
  });

  it('decides each race from its own first 5 s, and a fast first race does not stop a later slow one', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq);
    aq.beginRace(); r.run(10000, 16);
    r.run(10000, 150);             // slowness later in the same race is outside the window
    expect(r.switches).toBe(0);
    aq.beginRace(); r.run(10000, 150);
    expect(r.switches).toBe(1);
  });

  it('never counts frames off the race screen, or the gap across a hidden tab or pause', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.run(30000, 200, false);      // menus, pause or results drawing slowly: not part of a race
    expect(r.switches).toBe(0);
    for (let i = 0; i < 40; i++) {
      r.run(100, 16);              // a little racing at 60 FPS ...
      aq.interrupt();              // ... then the tab is hidden ...
      r.step(3000);                // ... and the first frame back spans the hidden time
    }
    expect(r.switches).toBe(0);
    for (let i = 0; i < 40; i++) { r.run(100, 16); r.step(3000, false); r.step(16); }   // pause and resume
    expect(r.switches).toBe(0);
  });

  it('does nothing when the current preset is already Low', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq, 'low'); aq.beginRace();
    r.run(20000, 150);
    expect(r.switches).toBe(0);
    expect(aq.state).toBe('eligible');
  });
});

describe('the player decides', () => {
  it('never switches after the player picked a preset, even on a slow device', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    aq.playerChose();
    for (let i = 0; i < 5; i++) { aq.beginRace(); r.run(10000, 150); }
    expect(r.switches).toBe(0);
    expect(r.preset).toBe('balanced');
  });

  it('treats a preset saved before this feature as the player’s own choice', () => {
    const aq = new AutoQuality(memStorage({ [GRAPHICS_KEY]: 'high' }));
    const r = rig(aq, 'high'); aq.beginRace();
    r.run(10000, 150);
    expect(r.switches).toBe(0);
    expect(aq.state).toBe('manual');
  });

  it('a pick mid-window stops the measurement for that race', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.run(3000, 150);
    aq.playerChose(); r.preset = 'high';
    r.run(10000, 150);
    expect(r.switches).toBe(0);
    expect(r.preset).toBe('high');
  });

  it('switches once and then never again: no oscillation after undo, a manual pick, or more slow races', () => {
    const store = memStorage();
    const aq = new AutoQuality(store);
    const r = rig(aq); aq.beginRace();
    r.run(10000, 150);
    expect(r.switches).toBe(1);
    // still switched, more slow races: nothing more to do
    for (let i = 0; i < 3; i++) { aq.beginRace(); r.run(10000, 150); }
    expect(r.switches).toBe(1);
    // undo restores what it replaced and is the player's choice from then on
    expect(aq.undoTarget(r.preset)).toBe('balanced');
    const to = aq.undo(r.preset);
    expect(to).toBe('balanced');
    r.preset = to!;
    expect(aq.state).toBe('manual');
    expect(aq.undo(r.preset)).toBeNull();
    for (let i = 0; i < 3; i++) { aq.beginRace(); r.run(10000, 150); }
    expect(r.switches).toBe(1);
    expect(r.preset).toBe('balanced');
    expect(store.getItem(AUTO_KEY)).toBe('manual');
  });

  it('offers no undo once the player moved off Low themselves', () => {
    const aq = new AutoQuality(memStorage());
    const r = rig(aq); aq.beginRace();
    r.run(10000, 150);
    expect(aq.undoTarget('balanced')).toBeNull();
    expect(aq.undoTarget('low')).toBe('balanced');
  });
});

describe('remembered per device', () => {
  it('the switch survives a reload: no second switch, undo still offered', () => {
    const store = memStorage();
    const a = new AutoQuality(store);
    const r = rig(a); a.beginRace();
    r.run(10000, 150);
    store.setItem(GRAPHICS_KEY, 'low');   // what setPreset('low') saves alongside
    // reload: a fresh instance on the same storage
    const b = new AutoQuality(store);
    expect(b.state).toBe('switched');
    expect(b.undoTarget('low')).toBe('balanced');
    const r2 = rig(b, 'low'); b.beginRace();
    r2.run(10000, 150);
    expect(r2.switches).toBe(0);
  });

  it('the player’s choice survives a reload', () => {
    const store = memStorage();
    new AutoQuality(store).playerChose();
    const b = new AutoQuality(store);
    expect(b.state).toBe('manual');
    const r = rig(b); b.beginRace();
    r.run(10000, 150);
    expect(r.switches).toBe(0);
  });

  it('works without storage, or with storage that throws: once per page', () => {
    for (const store of [null, throwing()]) {
      const aq = new AutoQuality(store);
      expect(aq.state).toBe('eligible');
      const r = rig(aq); aq.beginRace();
      r.run(10000, 150);
      aq.beginRace(); r.preset = 'balanced'; r.run(10000, 150);
      expect(r.switches).toBe(1);
    }
  });

  it('ignores a corrupt record (eligible) and an unknown replaced preset (no undo)', () => {
    expect(new AutoQuality(memStorage({ [AUTO_KEY]: 'banana' })).state).toBe('eligible');
    const b = new AutoQuality(memStorage({ [AUTO_KEY]: 'switched:ultra' }));
    expect(b.state).toBe('switched');
    expect(b.undoTarget('low')).toBeNull();
  });
});
