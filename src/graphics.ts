// Graphics presets: the one place that says how many pixels each quality level draws, and whether it pays for MSAA and shadows.
// See docs/graphics.md for the chosen values and the evidence behind them.

export type PresetId = 'low' | 'balanced' | 'high';

export interface Preset {
  id: PresetId;
  /** string-table id of the player-visible name */
  label: string;
  /** most drawing-buffer pixels per CSS pixel, per axis; the real device pixel ratio applies below this */
  maxPixelRatio: number;
  /**
   * MSAA on the WebGL drawing buffer. Fixed when the renderer is created (WebGLRenderer's `antialias`), so the 3D view takes
   * it from the preset it is built with: a change of preset during a session changes MSAA from the next page load (#167).
   */
  antialias: boolean;
  /** the sun's 2048² PCF shadow map, re-rendered every frame; applies at once on a change of preset (#167) */
  shadows: boolean;
}

/** in selector order, lowest quality first */
export const PRESETS: readonly Preset[] = [
  // under 1 so that a DPR 1 display also draws fewer pixels: a quarter of Balanced
  // and without the two fixed GPU costs, MSAA and the shadow pass (#167)
  { id: 'low', label: 'gfx.low', maxPixelRatio: 0.5, antialias: false, shadows: false },
  { id: 'balanced', label: 'gfx.balanced', maxPixelRatio: 1, antialias: true, shadows: true },
  // the cap the game always used, so High is the original picture
  { id: 'high', label: 'gfx.high', maxPixelRatio: 2, antialias: true, shadows: true },
];

export const DEFAULT_PRESET: PresetId = 'balanced';
export const GRAPHICS_KEY = 'srgp.graphics';

const find = (id: unknown): Preset | undefined => PRESETS.find((p) => p.id === id);

/** The preset's definition; an unknown id gives the default's. */
export function presetFor(id: PresetId): Preset {
  return find(id) ?? find(DEFAULT_PRESET)!;
}

/** Renderer pixel ratio for a preset on a display; a missing or nonsensical device ratio counts as 1. */
export function pixelRatioFor(id: PresetId, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(find(id)?.maxPixelRatio ?? 1, dpr);
}

/** The stored preset, or the default when it is missing, invalid or storage is unavailable. */
export function savedPreset(): PresetId {
  try { return find(localStorage.getItem(GRAPHICS_KEY))?.id ?? DEFAULT_PRESET; } catch { return DEFAULT_PRESET; }
}

export function savePreset(id: PresetId): void {
  try { localStorage.setItem(GRAPHICS_KEY, id); } catch { /* storage unavailable: the choice lasts this session */ }
}
