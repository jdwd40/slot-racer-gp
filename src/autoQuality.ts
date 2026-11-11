// Automatic fallback to the Low graphics preset on devices too slow for the chosen one (#66).
// Pure: no DOM, no renderer and no clock of its own. main.ts feeds it requestAnimationFrame timestamps and applies the
// preset it asks for. See docs/graphics.md ("Automatic fallback to Low").
//
// Why it exists: the race clock throws away any part of a frame over MAX_GAP (src/timing.ts), so on a device drawing
// ~7 FPS an offline race runs slower than real time. Low draws a quarter of Balanced's pixels, which is the one lever
// that helps there. This is a render-quality choice only: nothing here reaches the simulation, results or the server.

import { GRAPHICS_KEY, PRESETS, PresetId } from './graphics';

/** Per-device record of the automatic switch: `switched:<preset it replaced>` or `manual`. */
export const AUTO_KEY = 'srgp.gfxAuto';
/** Wall time of racing frames sampled at the start of each race before deciding. */
export const WINDOW_MS = 5000;
/** A median frame longer than this (under 20 FPS) means the device cannot keep up with the current preset. */
export const SLOW_MEDIAN_MS = 50;
/**
 * Fewest frame gaps a decision may rest on. A single shader-compile or scene-build stall can fill the whole 5 s window
 * by itself; without this floor its one sample would be the median.
 */
export const MIN_SAMPLES = 10;

/**
 * - `eligible`: never switched automatically and the player has not picked a preset: may switch once.
 * - `switched`: switched to Low automatically; never switches again, and the player may undo it.
 * - `manual`: the player picked a preset (or undid the switch): their choice is final, nothing is switched automatically.
 */
export type AutoState = 'eligible' | 'switched' | 'manual';

const isPreset = (v: unknown): v is PresetId => PRESETS.some((p) => p.id === v);

/** Median of a non-empty list. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class AutoQuality {
  private st: AutoState = 'eligible';
  /** the preset the automatic switch replaced, offered back by undo */
  private from: PresetId | null = null;
  private gaps: number[] = [];
  private sum = 0;
  /** timestamp of the previous counted frame; null when the next frame has nothing valid to measure against */
  private prev: number | null = null;
  /** this race's verdict is in (or the race no longer qualifies); stays so until the next race */
  private decided = false;

  /** `store` is localStorage or a double; null, or one that throws, makes the record last this page only. */
  constructor(private readonly store: Storage | null) {
    const v = this.read(AUTO_KEY);
    if (v === 'manual') this.st = 'manual';
    else if (v?.startsWith('switched:')) {
      this.st = 'switched';
      const f = v.slice('switched:'.length);
      this.from = isPreset(f) ? f : null;
    } else if (isPreset(this.read(GRAPHICS_KEY))) {
      // a preset saved before this feature existed was the player's own pick (only the selector ever saved one)
      this.st = 'manual';
    }
  }

  get state(): AutoState { return this.st; }

  /** The preset an undo returns to, while the automatic switch is in force and `current` is still its Low. */
  undoTarget(current: PresetId): PresetId | null {
    return this.st === 'switched' && current === 'low' && this.from && this.from !== 'low' ? this.from : null;
  }

  /** A new race (offline, practice, championship or online): sample its first WINDOW_MS afresh. */
  beginRace(): void {
    this.gaps = []; this.sum = 0; this.prev = null; this.decided = false;
  }

  /**
   * The next gap spans time this page did not draw (hidden tab, frozen page): do not measure it. Hidden tabs get no
   * frames, or throttled ones, so the first gap back would otherwise look like one enormous slow frame.
   */
  interrupt(): void { this.prev = null; }

  /**
   * Called every animation frame. `counting` is true only while a race is on screen and the page is visible; frames
   * on menus, pause and results are not part of "the first 5 s of a race", and the gap into the first counted frame
   * after any break is dropped. Returns 'low' exactly once, on the frame the switch should happen; otherwise null.
   */
  frame(now: number, counting: boolean, current: PresetId): PresetId | null {
    if (!counting || this.decided || this.st !== 'eligible') { this.prev = null; return null; }
    if (current === 'low') { this.decided = true; return null; }   // nothing lower to go to
    const prev = this.prev;
    this.prev = now;
    if (prev === null) return null;
    const gap = now - prev;
    if (!(gap >= 0)) return null;   // clock went backwards or NaN: ignore rather than guess
    this.gaps.push(gap); this.sum += gap;
    if (this.sum < WINDOW_MS || this.gaps.length < MIN_SAMPLES) return null;
    this.decided = true;
    if (median(this.gaps) <= SLOW_MEDIAN_MS) return null;
    this.st = 'switched';
    this.from = current;
    this.write(`switched:${current}`);
    return 'low';
  }

  /** The player picked a preset in the selector: from now on nothing is switched for them. */
  playerChose(): void {
    this.st = 'manual'; this.from = null; this.decided = true;
    this.write('manual');
  }

  /** Undo the automatic switch: the preset to restore, or null when there is nothing to undo. Counts as the player's choice. */
  undo(current: PresetId): PresetId | null {
    const to = this.undoTarget(current);
    if (to) this.playerChose();
    return to;
  }

  private read(k: string): string | null {
    try { return this.store?.getItem(k) ?? null; } catch { return null; }
  }
  private write(v: string): void {
    try { this.store?.setItem(AUTO_KEY, v); } catch { /* storage unavailable: the record lasts this page */ }
  }
}
