// GPU resource disposal: car visuals free every geometry, material and texture (the number roundel's
// CanvasTexture leaked before), shared resources are disposed once, and kept resources are left alone.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { makeCar } from '../src/carModel';
import { disposeObject } from '../src/gfx';

/** a canvas double: makeCar only draws the number roundel on it */
const fakeCanvas = (): unknown => ({
  width: 0, height: 0,
  getContext: () => new Proxy({}, { get: (_t, k) => (k === 'canvas' ? undefined : () => undefined), set: () => true }),
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

interface Res { dispose(): void; addEventListener(t: 'dispose', f: () => void): void; }
/** count dispose events per resource */
function watch<R extends Res>(items: Iterable<R>): Map<R, number> {
  const n = new Map<R, number>();
  for (const r of items) { if (n.has(r)) continue; n.set(r, 0); r.addEventListener('dispose', () => n.set(r, n.get(r)! + 1)); }
  return n;
}
function resources(root: THREE.Object3D): { geos: THREE.BufferGeometry[]; mats: THREE.Material[]; texs: THREE.Texture[] } {
  const geos: THREE.BufferGeometry[] = [], mats: THREE.Material[] = [], texs: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    geos.push(m.geometry);
    for (const x of Array.isArray(m.material) ? m.material : [m.material]) {
      mats.push(x);
      for (const v of Object.values(x)) if ((v as THREE.Texture | null)?.isTexture) texs.push(v as THREE.Texture);
    }
  });
  return { geos, mats, texs };
}

describe('car visual disposal', () => {
  it('disposes every texture created for a car, once, along with its geometries and materials', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas() });
    const spy = vi.spyOn(THREE.Texture.prototype, 'dispose');
    // texture ids are sequential, so the ids between two probes count every texture makeCar created
    const before = new THREE.Texture().id;
    const v = makeCar(0xff0000, 7, true);
    const after = new THREE.Texture().id;
    const { geos, mats, texs } = resources(v.group);
    const created = [...new Set(texs)];
    expect(created.length).toBe(after - before - 1);
    expect(created.length).toBeGreaterThan(0);
    expect(created.some((t) => t instanceof THREE.CanvasTexture)).toBe(true);
    const tn = watch(created), gn = watch(geos), mn = watch(mats);
    disposeObject(v.group);
    expect([...tn.values()].every((c) => c === 1)).toBe(true);
    expect([...gn.values()].every((c) => c === 1)).toBe(true);
    expect([...mn.values()].every((c) => c === 1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(created.length);
  });

  it('owns the roundel geometry, materials and number texture per car, so disposing one car leaves another intact', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas() });
    const a = makeCar(0xff0000, 1, true), b = makeCar(0x0000ff, 2, false);
    const ra = resources(a.group), rb = resources(b.group);
    const shared = (x: unknown[], y: unknown[]): unknown[] => x.filter((r) => y.includes(r));
    expect(shared(ra.geos, rb.geos)).toEqual([]);
    expect(shared(ra.mats, rb.mats)).toEqual([]);
    expect(shared(ra.texs, rb.texs)).toEqual([]);
    const bn = watch<Res>([...rb.geos, ...rb.mats, ...rb.texs]);
    disposeObject(a.group);
    expect([...bn.values()].every((c) => c === 0)).toBe(true);
  });
});

describe('disposeObject', () => {
  it('disposes shared geometry, materials (including material arrays) and textures once, and every texture property', () => {
    const map = new THREE.Texture(), emissive = new THREE.Texture(), alpha = new THREE.Texture(), normal = new THREE.Texture();
    const geo = new THREE.BoxGeometry();
    const m1 = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, alphaMap: alpha });
    const m2 = new THREE.MeshStandardMaterial({ map, normalMap: normal });
    const root = new THREE.Group();
    const a = new THREE.Mesh(geo, m1), b = new THREE.Mesh(geo, [m1, m2]);
    a.add(new THREE.Mesh(geo, m2));
    root.add(a, b);
    const n = watch<Res>([map, emissive, alpha, normal, geo, m1, m2]);
    disposeObject(root);
    expect([...n.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('leaves resources still used outside the subtree intact', () => {
    const sharedTex = new THREE.Texture(), ownTex = new THREE.Texture();
    const sharedGeo = new THREE.PlaneGeometry(), ownGeo = new THREE.PlaneGeometry();
    const sharedMat = new THREE.MeshBasicMaterial({ map: sharedTex }), ownMat = new THREE.MeshBasicMaterial({ map: ownTex });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(sharedGeo, sharedMat), new THREE.Mesh(ownGeo, ownMat));
    const outside = new THREE.Mesh(sharedGeo, sharedMat);
    const n = watch<Res>([sharedTex, sharedGeo, sharedMat, ownTex, ownGeo, ownMat]);
    disposeObject(root, new Set([sharedTex, sharedGeo, sharedMat]));
    expect([...n.values()]).toEqual([0, 0, 0, 1, 1, 1]);
    expect(outside.material.map).toBe(sharedTex);
  });
});
