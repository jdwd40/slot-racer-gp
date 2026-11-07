// Graphics presets: the one place that says how many pixels each quality level draws.
// See docs/graphics.md for the chosen values and the evidence behind them.

export type PresetId = 'low' | 'balanced' | 'high';

export interface Preset {
  id: PresetId;
  /** string-table id of the player-visible name */
  label: string;
  /** most drawing-buffer pixels per CSS pixel, per axis; the real device pixel ratio applies below this */
  maxPixelRatio: number;
}

/** in selector order, lowest quality first */
export const PRESETS: readonly Preset[] = [
  // under 1 so that a DPR 1 display also draws fewer pixels: a quarter of Balanced
  { id: 'low', label: 'gfx.low', maxPixelRatio: 0.5 },
  { id: 'balanced', label: 'gfx.balanced', maxPixelRatio: 1 },
  // the cap the game always used, so High is the original picture
  { id: 'high', label: 'gfx.high', maxPixelRatio: 2 },
];

export const DEFAULT_PRESET: PresetId = 'balanced';
export const GRAPHICS_KEY = 'srgp.graphics';

const find = (id: unknown): Preset | undefined => PRESETS.find((p) => p.id === id);

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
