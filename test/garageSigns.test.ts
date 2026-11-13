// Garage signs and door bands over the four bays follow each bay's owner (#101): the local driver's garage reads YOU
// whatever slot it races in, rivals' garages carry their names, bands their colours, and repainting replaces the sign
// textures without leaking the old ones.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import * as T from '../src/track';
import { Race, DRIVERS, SOLO_ID, RosterEntry } from '../src/race';
import { buildWorld, bayPaints, disposeWorld, World } from '../src/world';
import { TEAM_COLS } from '../src/scenery';
import strings from '../assets/ui/strings.json';

const STR: Record<string, string> = Object.fromEntries((strings as { strings: { id: string; text: string }[] }).strings.map((s) => [s.id, s.text]));

/** a canvas double that remembers the text drawn on it */
const fakeCanvas = (): unknown => {
  const texts: string[] = [];
  const ctx = new Proxy({}, {
    get: (_t, k) => (k === 'fillText' ? (s: string) => texts.push(s) : k === 'canvas' ? undefined : k === 'getImageData' || k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4 * 512 * 512) }) : () => undefined),
    set: () => true,
  });
  return { width: 0, height: 0, texts, getContext: () => ctx };
};
beforeEach(() => { T.setTrack('circuit-1'); vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** the solo grid as main.ts builds it, with the local driver in `slot` (the displaced rival moves to slot 0) */
function soloRace(slot: number, color = DRIVERS[0].color): Race {
  const roster: RosterEntry[] = [{ id: SOLO_ID, control: 'human', slot, name: DRIVERS[0].name, color }];
  for (let k = 1; k < DRIVERS.length; k++) {
    const D = DRIVERS[k];
    roster.push({ id: `ai${k}`, control: 'ai', slot: k === slot ? 0 : k, name: D.name, color: D.color, persona: D.persona });
  }
  return new Race({ roster, seed: 1, track: 'circuit-1' });
}

const isBox = (m: THREE.Mesh, w: number, h: number): boolean => {
  const p = (m.geometry as THREE.BoxGeometry).parameters as { width?: number; height?: number } | undefined;
  return !!p && p.width === w && p.height === h;
};
/** the garage's per-bay sign and band materials, in bay order */
function garage(w: World): { signs: THREE.MeshStandardMaterial[]; bands: THREE.MeshStandardMaterial[] } {
  const signs: THREE.MeshStandardMaterial[] = [], bands: THREE.MeshStandardMaterial[] = [];
  w.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (isBox(m, 0.9, 0.22)) signs.push(m.material as THREE.MeshStandardMaterial);
    if (isBox(m, 2.2, 0.12)) bands.push(m.material as THREE.MeshStandardMaterial);
  });
  return { signs, bands };
}
const signText = (m: THREE.MeshStandardMaterial): string => ((m.map!.image as { texts: string[] }).texts).join('');

describe('garage signs and door bands', () => {
  it('offline solo (slot 0) reads YOU, COMET, ARROW, VIPER in the team colours, as before', () => {
    const w = buildWorld();
    const g = garage(w);
    expect(g.signs).toHaveLength(4);
    expect(g.bands).toHaveLength(4);
    const built = { signs: g.signs.map(signText), bands: g.bands.map((m) => m.color.getHex()) };
    expect(built.signs).toEqual([STR['hud.you'], 'COMET', 'ARROW', 'VIPER']);
    expect(built.bands).toEqual(TEAM_COLS);
    w.paintBays(bayPaints(soloRace(0), SOLO_ID));
    expect(g.signs.map(signText)).toEqual(built.signs);
    expect(g.bands.map((m) => m.color.getHex())).toEqual(built.bands);
    disposeWorld(w);
  });

  it('a local driver in slot 2 sees YOU over bay 3 and the rival moved to slot 0 over bay 1', () => {
    const w = buildWorld();
    const race = soloRace(2, 0x123456);
    const paint = bayPaints(race, SOLO_ID);
    expect(paint.map((b) => b.tag)).toEqual(['BLUE', 'RED', STR['hud.you'], 'GREEN']);
    expect(paint.map((b) => b.mine)).toEqual([false, false, true, false]);
    w.paintBays(paint);
    const g = garage(w);
    expect(g.signs.map(signText)).toEqual(['ARROW', 'COMET', STR['hud.you'], 'VIPER']);
    expect(g.bands.map((m) => m.color.getHex())).toEqual([DRIVERS[2].color, DRIVERS[1].color, 0x123456, DRIVERS[3].color]);
    disposeWorld(w);
  });

  it('an online driver with their own name gets their tag on the sign; an empty bay is neutral and blank', () => {
    const w = buildWorld();
    const race = new Race({ roster: [{ id: 'h0', control: 'human', slot: 0, name: 'Alice' }, { id: 'h1', control: 'human', slot: 1, name: 'Bob' }], seed: 1, track: 'circuit-1' });
    w.paintBays(bayPaints(race, 'h1'));
    const g = garage(w);
    expect(g.signs.map(signText)).toEqual(['ALICE', STR['hud.you'], '', '']);
    expect(g.bands[2].color.getHex()).toBe(0x6b7280);
    disposeWorld(w);
  });

  it('repainting replaces sign textures without growing the set of live textures', () => {
    const w = buildWorld();
    const g = garage(w);
    // live textures as renderer.info counts them: created minus disposed (texture ids are sequential)
    const disposed = vi.spyOn(THREE.Texture.prototype, 'dispose');
    const before = new THREE.Texture().id;
    const old = g.signs.map((m) => m.map!);
    for (let i = 0; i < 6; i++) w.paintBays(bayPaints(soloRace(i % 2 ? 2 : 0), SOLO_ID));
    const created = new THREE.Texture().id - before - 1;
    expect(created).toBeGreaterThan(0);
    expect(disposed).toHaveBeenCalledTimes(created);
    for (const t of old) expect(g.signs.some((m) => m.map === t)).toBe(false);
    disposeWorld(w);
  });
});
