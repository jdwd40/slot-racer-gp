import * as THREE from 'three';
import { mergeSimple } from './gfx';

function std(color: number, rough = 0.5, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

export interface CarVisual { group: THREE.Group; body: THREE.Group; wheels: THREE.Mesh[]; dimmed?: boolean; }

/** Opacity of a car drawn as held (#74): clearly there, clearly not racing, like the personal-best ghost (0.42) but firmer. */
export const HELD_OPACITY = 0.45;

/**
 * Draw a car dimmed (translucent) or normally. Used for a car the server holds for an away driver (#74): it is out of traffic
 * and the others drive through its spot, so it must read as not solid. Each car has its own materials (makeCar), so this never
 * touches another car; the original transparency is kept on the material and restored exactly. Only a change does any work.
 */
export function dimCar(v: CarVisual, on: boolean): void {
  if (!!v.dimmed === on) return;
  v.dimmed = on;
  v.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const ud = mat.userData as { solid?: { transparent: boolean; opacity: number; depthWrite: boolean } };
      if (on) {
        ud.solid ??= { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
        mat.transparent = true; mat.opacity = ud.solid.opacity * HELD_OPACITY; mat.depthWrite = false;
      } else if (ud.solid) {
        mat.transparent = ud.solid.transparent; mat.opacity = ud.solid.opacity; mat.depthWrite = ud.solid.depthWrite;
      }
      mat.needsUpdate = true;
    }
    // a see-through car casting a solid shadow would still look solid: its own shadow goes while it is held
    const mu = m.userData as { cast?: boolean };
    if (on) { mu.cast ??= m.castShadow; m.castShadow = false; } else if (mu.cast !== undefined) m.castShadow = mu.cast;
  });
}

/** Slot car facing +X, ~1.4 long, 0.6 wide. */
export function makeCar(color: number, num: number, isPlayer: boolean): CarVisual {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = std(color, 0.28, 0.35, { envMapIntensity: 1.2 });
  const dark = std(0x16181c, 0.5, 0.3);

  // chassis outline (x forward, y lateral)
  const half: [number, number][] = [[0.7, 0.1], [0.62, 0.2], [0.5, 0.25], [0.3, 0.26], [0.16, 0.21], [-0.2, 0.22], [-0.32, 0.28], [-0.62, 0.28], [-0.7, 0.22]];
  const shp = new THREE.Shape();
  shp.moveTo(half[0][0], -half[0][1]);
  for (const [x, y] of half) shp.lineTo(x, -y);
  for (let i = half.length - 1; i >= 0; i--) shp.lineTo(half[i][0], half[i][1]);
  shp.closePath();
  const cg = new THREE.ExtrudeGeometry(shp, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 3 });
  cg.rotateX(-Math.PI / 2);
  const chassis = new THREE.Mesh(cg, paint); chassis.position.y = 0.06; chassis.castShadow = true; body.add(chassis);

  // engine cover / sidepods hump
  const hump = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), paint);
  hump.scale.set(0.42, 0.1, 0.19); hump.position.set(-0.18, 0.19, 0); hump.castShadow = true; body.add(hump);
  // canopy
  const glass = std(0x0e1626, 0.08, 0.6, { envMapIntensity: 1.5 });
  const can = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  can.scale.set(0.24, 0.11, 0.14); can.position.set(0.08, 0.2, 0); body.add(can);
  // helmet
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), std(isPlayer ? 0xffffff : 0xf2f2f2, 0.3));
  helmet.position.set(-0.02, 0.27, 0); body.add(helmet);
  // stripes
  const stripeM = std(0xffffff, 0.35);
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.006, 0.05), stripeM); s1.position.set(0.47, 0.185, 0); body.add(s1);
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.006, 0.05), stripeM); s2.position.set(-0.52, 0.185, 0); body.add(s2);
  // number roundel
  const nc = document.createElement('canvas'); nc.width = nc.height = 64;
  const g = nc.getContext('2d')!;
  g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 40px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(num), 32, 34);
  const nt = new THREE.CanvasTexture(nc); nt.colorSpace = THREE.SRGBColorSpace;
  const rg = new THREE.CircleGeometry(0.085, 20); rg.rotateX(-Math.PI / 2); rg.rotateY(-Math.PI / 2);
  for (const side of [-1, 1]) {
    const r = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ map: nt, roughness: 0.4, transparent: true }));
    r.position.set(-0.38, 0.188, side * 0.15); body.add(r);
  }
  // rear wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.025, 0.62), paint); wing.position.set(-0.62, 0.32, 0); wing.castShadow = true; body.add(wing);
  for (const z of [-0.31, 0.31]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.02), dark); ep.position.set(-0.62, 0.28, z); body.add(ep);
  }
  for (const z of [-0.12, 0.12]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.02), dark); post.position.set(-0.6, 0.24, z); body.add(post);
  }
  // front splitter
  const spl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.56), dark); spl.position.set(0.66, 0.05, 0); body.add(spl);
  // headlights
  const hl = std(0xfff6c8, 0.2, 0, { emissive: 0xfff2b0, emissiveIntensity: 0.6 });
  for (const z of [-0.13, 0.13]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.08), hl); h.position.set(0.66, 0.13, z); body.add(h); }
  const tl = std(0xff2020, 0.3, 0, { emissive: 0xff0000, emissiveIntensity: 0.5 });
  for (const z of [-0.2, 0.2]) { const h = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.08), tl); h.position.set(-0.71, 0.12, z); body.add(h); }

  // wheels
  const wheels: THREE.Mesh[] = [];
  const rubber = std(0x101010, 0.85);
  const hub = std(0xd0d4da, 0.25, 0.9);
  for (const [x, r, w] of [[0.42, 0.11, 0.1], [-0.42, 0.125, 0.13]] as [number, number, number][]) {
    for (const z of [-1, 1]) {
      const wg = new THREE.CylinderGeometry(r, r, w, 16); wg.rotateX(Math.PI / 2);
      const wh = new THREE.Mesh(wg, rubber); wh.position.set(x, r, z * (0.28 + w / 2 - 0.04)); wh.castShadow = true; group.add(wh);
      const hg = new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.005, 10); hg.rotateX(Math.PI / 2);
      const hb = new THREE.Mesh(hg, hub); wh.add(hb);
      wheels.push(wh);
    }
  }

  return { group, body, wheels };
}

/**
 * The one player marker: a hollow ring with a pointer on top, unit ring radius, facing +Z.
 * The dark outline keeps the shape readable on any surface or livery, and the open centre leaves the car and its neighbours visible.
 */
export function makePlayerMarker(): THREE.Group {
  const marker = new THREE.Group();
  const layer = (color: number, inner: number, outer: number, halfBase: number, tipY: number, topY: number, order: number): void => {
    const pointer = new THREE.Shape([new THREE.Vector2(0, tipY), new THREE.Vector2(halfBase, topY), new THREE.Vector2(-halfBase, topY)]);
    const m = new THREE.Mesh(
      mergeSimple([new THREE.RingGeometry(inner, outer, 40), new THREE.ShapeGeometry(pointer)]),
      new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    m.renderOrder = order;
    marker.add(m);
  };
  layer(0x14110c, 0.7, 1.1, 0.6, 0.82, 1.85, 20);
  layer(0xffe066, 0.8, 1, 0.4, 1, 1.72, 21);
  marker.visible = false;
  return marker;
}
