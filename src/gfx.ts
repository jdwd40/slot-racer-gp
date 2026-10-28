// Shared drawing helpers: materials, canvas textures and track-following geometry.
// Every piece of geometry built here follows the active circuit's surface, so
// ramps, bridges and banked plates come out of the same ribbon/wall functions
// as flat track.
import * as THREE from 'three';
import * as T from './track';

/** top of the plastic track pieces above the mat */
export const Y0 = 0.05;

// 2D (x, y-north) -> three (x, h, -y)
export function v3(x: number, y: number, h = 0): THREE.Vector3 { return new THREE.Vector3(x, h, -y); }

export function std(color: number, rough = 0.7, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

export function mesh(g: THREE.BufferGeometry, m: THREE.Material, shadow = { cast: false, receive: true }): THREE.Mesh {
  const me = new THREE.Mesh(g, m); me.castShadow = shadow.cast; me.receiveShadow = shadow.receive; return me;
}

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

export function noise(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, n: number, size = 2): void {
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const k = (Math.random() - 0.5) * amp;
    g.fillStyle = `rgba(${base[0] + k | 0},${base[1] + k * 1.2 | 0},${base[2] + k * 0.6 | 0},0.6)`;
    g.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

/** text label texture (for signs, boards and pit boards) */
export function textTex(w: number, h: number, bg: string, fg: string, text: string, font = 'bold 48px Arial, sans-serif'): THREE.CanvasTexture {
  return canvasTex(w, h, (g) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2);
  }, false);
}

function finish(pos: number[], uv: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Ribbon between two lateral offset functions along the track, lying `yOff`
 * above the track surface (so it climbs ramps and tilts with banking).
 */
export function ribbon(s0: number, s1: number, dA: (s: number) => number, dB: (s: number) => number, yOff: number, step = 0.25, vScale = 1): THREE.BufferGeometry {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = T.point3(s, dA(s)), b = T.point3(s, dB(s));
    pos.push(a.x, a.z + yOff, -a.y, b.x, b.z + yOff, -b.y);
    const v = (s - s0) * vScale;
    uv.push(0, v, 1, v);
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  return finish(pos, uv, idx);
}

/** Height spec for walls: a number is relative to the track surface, a function gives an absolute height. */
export type H = number | ((s: number) => number);

/** Vertical wall following d(s), from y0 to y1 (see H). */
export function wall(s0: number, s1: number, d: (s: number) => number, y0: H, y1: H, step = 0.4, vScale = 1): THREE.BufferGeometry {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = T.point3(s, d(s));
    const ya = typeof y0 === 'number' ? a.z + y0 : y0(s);
    const yb = typeof y1 === 'number' ? a.z + y1 : y1(s);
    pos.push(a.x, ya, -a.y, a.x, yb, -a.y);
    const u = (s - s0) * vScale;
    uv.push(u, 0, u, 1);
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  return finish(pos, uv, idx);
}

/** Box placed on the track surface at (s, d), rotated with the heading. */
export function boxAt(s: number, d: number, w: number, h: number, depth: number, m: THREE.Material, yOff = 0, shadow = { cast: true, receive: true }): THREE.Mesh {
  const p = T.point3(s, d);
  const b = mesh(new THREE.BoxGeometry(w, h, depth), m, shadow);
  b.position.set(p.x, p.z + yOff + h / 2, -p.y); b.rotation.y = p.h;
  return b;
}

/** Group anchored on the ground (z = 0) at track position (s, d), local x along the heading. */
export function groupAt(s: number, d: number, onSurface = false): THREE.Group {
  const p = T.point3(s, d);
  const g = new THREE.Group(); g.position.set(p.x, onSurface ? p.z : 0, -p.y); g.rotation.y = p.h;
  return g;
}

export function mergeSimple(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g of gs) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    const ix = g.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    off += p.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** flat arrow following a lateral path along the track (hovers just above the surface) */
export function arrowGeometry(s0: number, s1: number, d: (s: number) => number, width = 0.16): THREE.BufferGeometry {
  const shaftEnd = s1 - 0.6;
  const body = ribbon(s0, shaftEnd, (s) => d(s) - width / 2, (s) => d(s) + width / 2, Y0 + 0.03, 0.15);
  const tip = T.point3(s1, d(s1));
  const bl = T.point3(shaftEnd, d(shaftEnd) - width * 1.9), br = T.point3(shaftEnd, d(shaftEnd) + width * 1.9);
  const y = Y0 + 0.03;
  const head = new THREE.BufferGeometry();
  head.setAttribute('position', new THREE.Float32BufferAttribute([bl.x, bl.z + y, -bl.y, br.x, br.z + y, -br.y, tip.x, tip.z + y, -tip.y], 3));
  head.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  head.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  head.setIndex([0, 1, 2]);
  return mergeSimple([body, head]);
}

/** small person: capsule body + head, standing at ground level */
export function figure(color: number, x: number, y: number, z = 0, helmet = 0xf2f2f2): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 8), std(color, 0.6));
  body.position.y = 0.2; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), std(helmet, 0.4));
  head.position.y = 0.42; head.castShadow = true; g.add(head);
  g.position.set(x, z, -y);
  return g;
}

/**
 * Merge the static meshes directly under `root` that share a material (and
 * shadow flags) into single draws. Instanced meshes and groups are left alone.
 */
export function mergeStatic(root: THREE.Group): void {
  const buckets = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; meshes: THREE.Mesh[] }>();
  for (const o of root.children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh || Array.isArray(m.material)) continue;
    const key = `${m.material.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) { b = { mat: m.material, cast: m.castShadow, recv: m.receiveShadow, meshes: [] }; buckets.set(key, b); }
    b.meshes.push(m);
  }
  for (const b of buckets.values()) {
    if (b.meshes.length < 2) continue;
    const parts: THREE.BufferGeometry[] = [];
    for (const m of b.meshes) {
      let g = m.geometry.clone();
      if (!g.getIndex()) {
        const n = g.getAttribute('position').count; const idx: number[] = []; for (let i = 0; i < n; i++) idx.push(i); g.setIndex(idx);
      }
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      m.updateMatrix();
      g = g.applyMatrix4(m.matrix);
      parts.push(g);
      root.remove(m);
      m.geometry.dispose();
    }
    const merged = new THREE.Mesh(mergeSimple(parts), b.mat);
    merged.castShadow = b.cast; merged.receiveShadow = b.recv;
    for (const p of parts) p.dispose();
    root.add(merged);
  }
}
