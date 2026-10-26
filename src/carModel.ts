import * as THREE from 'three';

function std(color: number, rough = 0.5, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

export interface CarVisual { group: THREE.Group; body: THREE.Group; ring: THREE.Mesh; wheels: THREE.Mesh[]; }

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

  // highlight ring (shown in overview mode for the player)
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.25, 40), new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.85, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; ring.visible = false;
  group.add(ring);

  return { group, body, ring, wheels };
}
