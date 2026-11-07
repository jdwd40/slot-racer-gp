// Graphics preset resolution and persistence (localStorage replaced by a double).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_PRESET, GRAPHICS_KEY, PRESETS, PresetId, pixelRatioFor, savedPreset, savePreset } from '../src/graphics';
import { memStorage } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); });

/** drawing-buffer pixels for a viewport, floored per axis as WebGLRenderer.setSize does */
const pixels = (id: PresetId, dpr: number, w = 1280, h = 720): number => {
  const r = pixelRatioFor(id, dpr);
  return Math.floor(w * r) * Math.floor(h * r);
};

describe('preset resolution', () => {
  it('caps at the preset and never exceeds the device ratio', () => {
    expect(pixelRatioFor('low', 1)).toBe(0.5);
    expect(pixelRatioFor('balanced', 1)).toBe(1);
    expect(pixelRatioFor('high', 1)).toBe(1);
    expect(pixelRatioFor('low', 2)).toBe(0.5);
    expect(pixelRatioFor('balanced', 2)).toBe(1);
    expect(pixelRatioFor('high', 2)).toBe(2);
    expect(pixelRatioFor('high', 1.25)).toBe(1.25);
    expect(pixelRatioFor('high', 3)).toBe(2);
  });
  it('makes Low draw fewer pixels than High at DPR 1 and 2', () => {
    expect(pixels('low', 1)).toBe(640 * 360);
    expect(pixels('high', 1)).toBe(1280 * 720);
    expect(pixels('low', 2)).toBe(640 * 360);
    expect(pixels('high', 2)).toBe(2560 * 1440);
  });
  it('keeps High at the original min(2, DPR) policy', () => {
    for (const dpr of [0.75, 1, 1.5, 2, 3]) expect(pixelRatioFor('high', dpr)).toBe(Math.min(2, dpr));
  });
  it('treats a missing or nonsensical device ratio as 1', () => {
    for (const dpr of [0, -1, NaN, Infinity, undefined as unknown as number]) expect(pixelRatioFor('high', dpr)).toBe(1);
  });
});

describe('preset persistence', () => {
  it('defaults to Balanced when nothing is stored', () => {
    vi.stubGlobal('localStorage', memStorage());
    expect(DEFAULT_PRESET).toBe('balanced');
    expect(savedPreset()).toBe('balanced');
  });
  it('round-trips every preset under the dedicated key and leaves other saves alone', () => {
    const store = memStorage({ 'srgp.track': 'circuit-2', 'srgp.initials': '"JD"' });
    vi.stubGlobal('localStorage', store);
    for (const { id } of PRESETS) {
      savePreset(id);
      expect(store.getItem(GRAPHICS_KEY)).toBe(id);
      expect(savedPreset()).toBe(id);
    }
    expect(GRAPHICS_KEY).toBe('srgp.graphics');
    expect(store.getItem('srgp.track')).toBe('circuit-2');
    expect(store.getItem('srgp.initials')).toBe('"JD"');
    expect(store.length).toBe(3);
  });
  it('falls back to Balanced on invalid values', () => {
    for (const bad of ['', 'ultra', 'HIGH', '"high"', '2', 'constructor', '__proto__']) {
      vi.stubGlobal('localStorage', memStorage({ [GRAPHICS_KEY]: bad }));
      expect(savedPreset()).toBe('balanced');
    }
  });
  it('survives blocked storage', () => {
    const blocked = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(savedPreset()).toBe('balanced');
    expect(() => savePreset('low')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(savedPreset()).toBe('balanced');
    expect(() => savePreset('high')).not.toThrow();
  });
});
