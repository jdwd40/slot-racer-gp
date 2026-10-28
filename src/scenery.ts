// Per-circuit setting: mat and table finishes, trees, miniature buildings and the
// occasional full-size object (mug, tools, desk lamp) that sells the tabletop scale.
import * as THREE from 'three';
import * as T from './track';
import { std, mesh, canvasTex, noise, textTex, figure } from './gfx';

export const TEAM_COLS = [0xffcc1a, 0xe8322a, 0x2a6df0, 0x22b04b];

export interface SceneryCtx {
  theme: T.Theme;
  B: T.Bounds;
  L: number;
  nearTrack: (x: number, y: number, r: number) => boolean;
  isBlocked: (x: number, y: number) => boolean;
  blocked: { x: number; y: number; r: number }[];
}

const castRecv = { cast: true, receive: true };
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

// ------------------------------------------------------------------ textures
export function matTexture(theme: T.Theme): THREE.CanvasTexture {
  return canvasTex(512, 512, (g) => {
    if (theme === 'workshop') {
      // self-healing cutting mat with its grid
      noise(g, 512, 512, [52, 96, 82], 14, 14000, 2);
      g.strokeStyle = 'rgba(190,220,200,0.22)'; g.lineWidth = 1;
      for (let i = 0; i <= 512; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
      g.strokeStyle = 'rgba(210,235,220,0.45)'; g.lineWidth = 2;
      for (let i = 0; i <= 512; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
      for (let i = 0; i < 40; i++) { g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1; const x = Math.random() * 512, y = Math.random() * 512; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd(-40, 40), y + rnd(-40, 40)); g.stroke(); }
      return;
    }
    const base: [number, number, number] = theme === 'alpine' ? [62, 128, 70] : theme === 'harbour' ? [110, 158, 66] : theme === 'speedway' ? [78, 150, 58] : [84, 150, 62];
    noise(g, 512, 512, base, 40, 26000, 2);
    for (let i = 0; i < 2500; i++) {
      g.strokeStyle = `rgba(${40 + Math.random() * 60 | 0},${110 + Math.random() * 80 | 0},40,0.5)`;
      const x = Math.random() * 512, y = Math.random() * 512;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.random() * 2 - 1, y - 3 - Math.random() * 3); g.stroke();
    }
    if (theme === 'park' || theme === 'speedway') {
      // mowing stripes
      for (let i = 0; i < 512; i += 128) { g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(i, 0, 64, 512); }
    }
    if (theme === 'alpine') {
      for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(150,150,140,${0.25 + Math.random() * 0.3})`; g.beginPath(); g.ellipse(Math.random() * 512, Math.random() * 512, rnd(3, 9), rnd(2, 5), Math.random() * 3, 0, 7); g.fill(); }
    }
    if (theme === 'harbour') {
      for (let i = 0; i < 50; i++) { g.fillStyle = `rgba(214,196,140,${0.2 + Math.random() * 0.25})`; g.beginPath(); g.ellipse(Math.random() * 512, Math.random() * 512, rnd(6, 16), rnd(3, 8), Math.random() * 3, 0, 7); g.fill(); }
    }
  });
}

export function tableTexture(theme: T.Theme): THREE.CanvasTexture {
  return canvasTex(512, 512, (g) => {
    const bench = theme === 'workshop';
    g.fillStyle = bench ? '#a8824f' : theme === 'speedway' ? '#5d3f27' : '#7a4a26'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 160; i++) {
      const y = Math.random() * 512, a = Math.random() * 0.25;
      g.strokeStyle = `rgba(${Math.random() < 0.5 ? '40,20,8' : '160,110,60'},${a})`;
      g.lineWidth = 1 + Math.random() * 3;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 4);
      g.stroke();
    }
    if (bench) {
      for (let i = 0; i < 70; i++) { g.strokeStyle = `rgba(30,20,10,${0.15 + Math.random() * 0.25})`; g.lineWidth = 1; const x = Math.random() * 512, y = Math.random() * 512; g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd(-60, 60), y + rnd(-20, 20)); g.stroke(); }
      for (let i = 0; i < 12; i++) { g.fillStyle = `rgba(40,30,20,${0.08 + Math.random() * 0.12})`; g.beginPath(); g.arc(Math.random() * 512, Math.random() * 512, rnd(8, 26), 0, 7); g.fill(); }
    }
  });
}

// ------------------------------------------------------------------ pieces

function buildTrees(root: THREE.Group, c: SceneryCtx, count: number, pineShare: number, margin = 13): void {
  const B = c.B;
  const treePos: { x: number; y: number; s: number }[] = [];
  let tries = 0;
  while (treePos.length < count && tries++ < count * 50) {
    const x = B.mnx - margin + Math.random() * (B.w + margin * 2), y = B.mny - margin + Math.random() * (B.h + margin * 2);
    if (c.nearTrack(x, y, 4.2) || c.isBlocked(x, y)) continue;
    if (treePos.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < 2.2)) continue;
    treePos.push({ x, y, s: 0.7 + Math.random() * 0.8 });
  }
  if (!treePos.length) return;
  const trunkG = new THREE.CylinderGeometry(0.1, 0.14, 0.7, 6); trunkG.translate(0, 0.35, 0);
  const coneG = new THREE.ConeGeometry(0.75, 1.5, 8); coneG.translate(0, 1.35, 0);
  const cone2G = new THREE.ConeGeometry(0.55, 1.1, 8); cone2G.translate(0, 2.0, 0);
  const ballG = new THREE.IcosahedronGeometry(0.85, 1); ballG.translate(0, 1.45, 0);
  const trunks = new THREE.InstancedMesh(trunkG, std(0x6b4423, 0.9), treePos.length);
  const pines = new THREE.InstancedMesh(coneG, std(0xffffff, 0.85, 0, { flatShading: true }), treePos.length);
  const pines2 = new THREE.InstancedMesh(cone2G, std(0xffffff, 0.85, 0, { flatShading: true }), treePos.length);
  const balls = new THREE.InstancedMesh(ballG, std(0xffffff, 0.85, 0, { flatShading: true }), treePos.length);
  let np = 0, nb = 0;
  const dm = new THREE.Object3D(); const cc = new THREE.Color();
  const alpine = c.theme === 'alpine';
  treePos.forEach((t, i) => {
    dm.position.set(t.x, 0, -t.y); dm.scale.setScalar(t.s); dm.rotation.set(0, Math.random() * 6, 0); dm.updateMatrix();
    trunks.setMatrixAt(i, dm.matrix);
    if (Math.random() < pineShare) {
      pines.setMatrixAt(np, dm.matrix); pines2.setMatrixAt(np, dm.matrix);
      cc.setHSL(alpine ? 0.36 + Math.random() * 0.05 : 0.3 + Math.random() * 0.06, 0.5, 0.11 + Math.random() * 0.06);
      pines.setColorAt(np, cc); pines2.setColorAt(np, cc); np++;
    } else {
      balls.setMatrixAt(nb, dm.matrix);
      cc.setHSL(c.theme === 'harbour' ? 0.22 + Math.random() * 0.08 : 0.27 + Math.random() * 0.08, 0.6, 0.1 + Math.random() * 0.07); balls.setColorAt(nb, cc); nb++;
    }
  });
  pines.count = np; pines2.count = np; balls.count = nb;
  for (const im of [trunks, pines, pines2, balls]) { im.castShadow = true; im.receiveShadow = true; root.add(im); }
}

function buildBushes(root: THREE.Group, c: SceneryCtx, count: number): void {
  const B = c.B;
  const g = new THREE.IcosahedronGeometry(0.35, 1); g.translate(0, 0.28, 0);
  const im = new THREE.InstancedMesh(g, std(0xffffff, 0.9, 0, { flatShading: true }), count);
  const dm = new THREE.Object3D(); const cc = new THREE.Color();
  let n = 0, tries = 0;
  while (n < count && tries++ < count * 40) {
    const x = B.mnx - 8 + Math.random() * (B.w + 16), y = B.mny - 8 + Math.random() * (B.h + 16);
    if (c.nearTrack(x, y, 2.6) || !c.nearTrack(x, y, 5) || c.isBlocked(x, y)) continue;
    dm.position.set(x, 0, -y); dm.scale.set(rnd(0.7, 1.4), rnd(0.6, 1.1), rnd(0.7, 1.4)); dm.rotation.set(0, Math.random() * 6, 0); dm.updateMatrix();
    im.setMatrixAt(n, dm.matrix); im.setColorAt(n, cc.setHSL(0.26 + Math.random() * 0.1, 0.55, 0.14 + Math.random() * 0.08)); n++;
  }
  im.count = n; im.castShadow = true; im.receiveShadow = true; root.add(im);
}

/** random clear patch of mat with radius r (inside the track's bounds, away from the slot) */
function freeSpot(c: SceneryCtx, r: number, inside = true): { x: number; y: number } | null {
  const B = c.B;
  for (let i = 0; i < 400; i++) {
    const m = inside ? 0 : 10;
    const x = B.mnx - m + Math.random() * (B.w + m * 2), y = B.mny - m + Math.random() * (B.h + m * 2);
    if (c.nearTrack(x, y, r + 2.2) || c.isBlocked(x, y)) continue;
    if (c.blocked.some((b) => (b.x - x) ** 2 + (b.y - y) ** 2 < (b.r + r) ** 2)) continue;
    c.blocked.push({ x, y, r: r + 0.5 });
    return { x, y };
  }
  return null;
}

function house(w: number, d: number, h: number, wallCol: number, roofCol: number, roofPitch = 0.5): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(w, h, d), std(wallCol, 0.7), castRecv); body.position.y = h / 2; g.add(body);
  const shp = new THREE.Shape(); shp.moveTo(-d / 2 - 0.15, 0); shp.lineTo(d / 2 + 0.15, 0); shp.lineTo(0, roofPitch * d); shp.closePath();
  const rg = new THREE.ExtrudeGeometry(shp, { depth: w + 0.3, bevelEnabled: false }); rg.rotateY(Math.PI / 2); rg.translate(-w / 2 - 0.15, h, 0);
  const roof = mesh(rg, std(roofCol, 0.6), castRecv); g.add(roof);
  const door = mesh(new THREE.BoxGeometry(0.3, 0.45, 0.03), std(0x2b2f36, 0.5)); door.position.set(0, 0.22, d / 2 + 0.01); g.add(door);
  for (const x of [-w * 0.3, w * 0.3]) { const win = mesh(new THREE.BoxGeometry(0.26, 0.22, 0.03), std(0x9fd3ff, 0.2, 0.3)); win.position.set(x, h * 0.6, d / 2 + 0.01); g.add(win); }
  return g;
}

function placeAt(root: THREE.Group, obj: THREE.Object3D, x: number, y: number, rot = 0, z = 0): void {
  obj.position.set(x, z, -y); obj.rotation.y = rot; root.add(obj);
}

// ------------------------------------------------------------------ full-size tabletop objects
function mug(color: number): THREE.Group {
  const g = new THREE.Group();
  const m = std(color, 0.35, 0.05);
  const body = mesh(new THREE.CylinderGeometry(3.1, 2.8, 4.4, 32, 1, true), m, castRecv); body.position.y = 2.2; g.add(body);
  const bottom = mesh(new THREE.CylinderGeometry(2.8, 2.8, 0.2, 32), m, castRecv); bottom.position.y = 0.1; g.add(bottom);
  const inner = mesh(new THREE.CylinderGeometry(2.9, 2.6, 4.2, 32, 1, true), std(0xf4efe6, 0.5, 0, { side: THREE.BackSide }), castRecv); inner.position.y = 2.3; g.add(inner);
  const coffee = mesh(new THREE.CylinderGeometry(2.85, 2.85, 0.1, 32), std(0x2a160c, 0.15, 0.1), { cast: false, receive: true }); coffee.position.y = 3.6; g.add(coffee);
  const lip = mesh(new THREE.TorusGeometry(3.0, 0.16, 8, 40), m, castRecv); lip.rotation.x = Math.PI / 2; lip.position.y = 4.4; g.add(lip);
  const handle = mesh(new THREE.TorusGeometry(1.4, 0.38, 10, 24, Math.PI), m, castRecv); handle.position.set(3.0, 2.3, 0); handle.rotation.z = -Math.PI / 2; g.add(handle);
  return g;
}

function pencil(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(new THREE.CylinderGeometry(0.45, 0.45, 15, 6), std(0xf5c518, 0.5), castRecv); body.rotation.z = Math.PI / 2; body.position.y = 0.45; g.add(body);
  const wood = mesh(new THREE.ConeGeometry(0.45, 1.4, 6), std(0xe7c9a0, 0.8), castRecv); wood.rotation.z = -Math.PI / 2; wood.position.set(8.2, 0.45, 0); g.add(wood);
  const tip = mesh(new THREE.ConeGeometry(0.14, 0.45, 6), std(0x222222, 0.5), castRecv); tip.rotation.z = -Math.PI / 2; tip.position.set(9.1, 0.45, 0); g.add(tip);
  const ferrule = mesh(new THREE.CylinderGeometry(0.47, 0.47, 1.0, 12), std(0xd0d4da, 0.3, 0.9), castRecv); ferrule.rotation.z = Math.PI / 2; ferrule.position.set(-7.9, 0.45, 0); g.add(ferrule);
  const eraser = mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.9, 12), std(0xf0a0b0, 0.8), castRecv); eraser.rotation.z = Math.PI / 2; eraser.position.set(-8.8, 0.45, 0); g.add(eraser);
  return g;
}

function screwdriver(color: number): THREE.Group {
  const g = new THREE.Group();
  const handle = mesh(new THREE.CylinderGeometry(0.95, 0.8, 6.5, 14), std(color, 0.35, 0, { transparent: true, opacity: 0.9 }), castRecv); handle.rotation.z = Math.PI / 2; handle.position.set(-3.2, 0.95, 0); g.add(handle);
  const cap = mesh(new THREE.CylinderGeometry(0.6, 0.95, 0.9, 14), std(0x222222, 0.5), castRecv); cap.rotation.z = Math.PI / 2; cap.position.set(-6.9, 0.95, 0); g.add(cap);
  const shaft = mesh(new THREE.CylinderGeometry(0.22, 0.22, 8, 10), std(0xc8ccd2, 0.25, 0.95), castRecv); shaft.rotation.z = Math.PI / 2; shaft.position.set(4.0, 0.95, 0); g.add(shaft);
  const tip = mesh(new THREE.BoxGeometry(1.0, 0.16, 0.5), std(0xc8ccd2, 0.25, 0.95), castRecv); tip.position.set(8.4, 0.95, 0); g.add(tip);
  return g;
}

function spanner(): THREE.Group {
  const g = new THREE.Group();
  const m = std(0xb9bec6, 0.3, 0.9);
  const shp = new THREE.Shape();
  shp.moveTo(-5.5, -0.7); shp.lineTo(5.5, -0.7); shp.lineTo(5.5, 0.7); shp.lineTo(-5.5, 0.7); shp.closePath();
  const bar = mesh(new THREE.ExtrudeGeometry(shp, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 }), m, castRecv);
  bar.rotation.x = Math.PI / 2; bar.position.y = 0.55; g.add(bar);
  for (const e of [-1, 1]) {
    const head = new THREE.Shape(); head.absarc(0, 0, 2.0, 0, Math.PI * 2, false);
    const jaw = new THREE.Path(); jaw.moveTo(e * 0.4, -0.9); jaw.lineTo(e * 2.4, -0.9); jaw.lineTo(e * 2.4, 0.9); jaw.lineTo(e * 0.4, 0.9); jaw.closePath();
    head.holes.push(jaw);
    const hm = mesh(new THREE.ExtrudeGeometry(head, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 }), m, castRecv);
    hm.rotation.x = Math.PI / 2; hm.position.set(e * 6.3, 0.55, 0); hm.rotation.z = e * 0.3; g.add(hm);
  }
  return g;
}

function deskLamp(): THREE.Group {
  const g = new THREE.Group();
  const m = std(0x2b2f36, 0.4, 0.5);
  const base = mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.7, 32), m, castRecv); base.position.y = 0.35; g.add(base);
  const arm1 = mesh(new THREE.CylinderGeometry(0.28, 0.28, 11, 10), m, castRecv); arm1.position.set(0, 5.8, -2.2); arm1.rotation.x = 0.4; g.add(arm1);
  const joint = mesh(new THREE.SphereGeometry(0.5, 12, 10), m, castRecv); joint.position.set(0, 10.9, -4.3); g.add(joint);
  const arm2 = mesh(new THREE.CylinderGeometry(0.26, 0.26, 8, 10), m, castRecv); arm2.position.set(0, 12.4, -7.8); arm2.rotation.x = 1.25; g.add(arm2);
  const shade = mesh(new THREE.ConeGeometry(3.2, 3.6, 28, 1, true), std(0xd42a22, 0.45, 0.1, { side: THREE.DoubleSide }), castRecv);
  shade.position.set(0, 12.5, -11.6); shade.rotation.x = 2.5; g.add(shade);
  const bulb = mesh(new THREE.SphereGeometry(0.9, 14, 10), std(0xfff3c4, 0.2, 0, { emissive: 0xffe9a8, emissiveIntensity: 1.6 }), { cast: false, receive: false });
  bulb.position.set(0, 12.0, -12.4); g.add(bulb);
  return g;
}

function tapeMeasure(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(4.2, 3.6, 4.0), std(0xf5c518, 0.45), castRecv); body.position.y = 1.8; g.add(body);
  const band = mesh(new THREE.BoxGeometry(4.3, 1.1, 4.1), std(0x16181c, 0.6), castRecv); band.position.y = 1.8; g.add(band);
  const tab = mesh(new THREE.BoxGeometry(0.5, 0.2, 1.4), std(0xd0d4da, 0.3, 0.9), castRecv); tab.position.set(2.4, 0.12, 0); g.add(tab);
  const strip = mesh(new THREE.BoxGeometry(2.3, 0.04, 1.2), std(0xfff4b0, 0.6), castRecv); strip.position.set(3.3, 0.05, 0); g.add(strip);
  return g;
}

function tapeRoll(): THREE.Group {
  const g = new THREE.Group();
  const roll = mesh(new THREE.TorusGeometry(2.5, 1.0, 12, 40), std(0xe8d8b0, 0.8), castRecv); roll.rotation.x = Math.PI / 2; roll.position.y = 1.0; g.add(roll);
  return g;
}

function paintTin(label: number): THREE.Group {
  const g = new THREE.Group();
  const tin = mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.0, 24), std(0xc8ccd2, 0.35, 0.85), castRecv); tin.position.y = 1.0; g.add(tin);
  const band = mesh(new THREE.CylinderGeometry(1.52, 1.52, 1.1, 24, 1, true), std(label, 0.5), castRecv); band.position.y = 0.95; g.add(band);
  const lid = mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.18, 24), std(0x9aa0a8, 0.3, 0.8), castRecv); lid.position.y = 2.08; g.add(lid);
  return g;
}

// ------------------------------------------------------------------ theme builders
function parkScenery(root: THREE.Group, c: SceneryCtx): void {
  buildTrees(root, c, 200, 0.5);
  buildBushes(root, c, 70);
  // clubhouse with a terrace
  const sp = freeSpot(c, 4);
  if (sp) {
    const h = house(5.5, 3.2, 1.6, 0xf3ead6, 0x6b3b2a, 0.45);
    placeAt(root, h, sp.x, sp.y, Math.random() * 6);
    for (let i = 0; i < 4; i++) {
      const tbl = mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.05, 12), std(0xffffff, 0.6), castRecv);
      const a = i * 1.6 + 0.8; tbl.position.set(sp.x + Math.cos(a) * 3.2, 0.3, -(sp.y + Math.sin(a) * 3.2)); root.add(tbl);
      const leg = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 5), std(0x999999, 0.4)); leg.position.copy(tbl.position); leg.position.y = 0.15; root.add(leg);
      const um = mesh(new THREE.ConeGeometry(0.6, 0.3, 8), std(i % 2 ? 0xd42a22 : 0x2a6df0, 0.6), castRecv); um.position.copy(tbl.position); um.position.y = 0.95; root.add(um);
      const pole = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5), std(0xdddddd, 0.4)); pole.position.copy(tbl.position); pole.position.y = 0.6; root.add(pole);
    }
  }
  // duck pond
  const pond = freeSpot(c, 3.5);
  if (pond) {
    const w = mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.03, 28), std(0x3f8fcf, 0.15, 0.2), { cast: false, receive: true }); w.scale.z = 0.7; w.position.set(pond.x, 0.015, -pond.y); w.rotation.y = Math.random() * 3; root.add(w);
    const bank = mesh(new THREE.TorusGeometry(3.25, 0.18, 6, 28), std(0xc9b58a, 0.9), castRecv); bank.rotation.x = Math.PI / 2; bank.scale.set(1, 0.7, 1); bank.rotation.z = w.rotation.y; bank.position.set(pond.x, 0.05, -pond.y); root.add(bank);
  }
  const hw = c.B.w / 2 + 15, hh = c.B.h / 2 + 15;
  placeAt(root, mug(0xf3f3f1), c.B.cx + hw + 5.5, c.B.cy - hh + 10, 0.6);
  placeAt(root, pencil(), c.B.cx - hw * 0.5, c.B.cy - hh - 2.5, 0.08);
}

function harbourScenery(root: THREE.Group, c: SceneryCtx): void {
  buildTrees(root, c, 110, 0.25);
  buildBushes(root, c, 50);
  const B = c.B;
  // harbour water along the west edge of the mat, with a quay wall
  const wx0 = B.mnx - 15, wx1 = B.mnx - 7.5;
  const water = mesh(new THREE.BoxGeometry(wx1 - wx0, 0.05, B.h + 30), std(0x2f7fb8, 0.12, 0.3), { cast: false, receive: true });
  water.position.set((wx0 + wx1) / 2, 0.005, -B.cy); root.add(water);
  const quay = mesh(new THREE.BoxGeometry(0.5, 0.25, B.h + 30), std(0x8f8a80, 0.8), castRecv); quay.position.set(wx1 + 0.25, 0.125, -B.cy); root.add(quay);
  for (let y = B.mny - 13; y < B.mxy + 13; y += 2.2) {
    const b = mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 6), std(0x3b3b3b, 0.6), castRecv); b.position.set(wx1 + 0.25, 0.45, -y); root.add(b);
  }
  // boats
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    const hull = mesh(new THREE.BoxGeometry(2.2, 0.35, 0.9), std([0xd42a22, 0xffffff, 0x1f4fbf, 0xf5c518][i], 0.5), castRecv); hull.position.y = 0.2; g.add(hull);
    const cabin = mesh(new THREE.BoxGeometry(0.7, 0.4, 0.6), std(0xf0ede6, 0.6), castRecv); cabin.position.set(-0.2, 0.55, 0); g.add(cabin);
    const mast = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5), std(0x777777, 0.4)); mast.position.set(0.5, 1.0, 0); g.add(mast);
    placeAt(root, g, wx0 + 2 + Math.random() * 4, B.mny - 8 + i * (B.h + 16) / 4 + rnd(-2, 2), rnd(-0.5, 0.5));
  }
  // lighthouse inside the wide hairpin (segment 3 of the harbour loop)
  const hp = T.SEGS[3];
  const cx = hp.x0 - hp.sign * hp.R * Math.sin(hp.h0), cy = hp.y0 + hp.sign * hp.R * Math.cos(hp.h0);
  {
    const g = new THREE.Group();
    const tower = mesh(new THREE.CylinderGeometry(0.55, 0.8, 3.4, 16), std(0xffffff, 0.6), castRecv); tower.position.y = 1.7; g.add(tower);
    for (const y of [0.9, 2.1]) { const band = mesh(new THREE.CylinderGeometry(0.72 - y * 0.06, 0.74 - y * 0.06, 0.4, 16), std(0xd42a22, 0.6), castRecv); band.position.y = y; g.add(band); }
    const lamp = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.5, 12), std(0xfff3c4, 0.1, 0.2, { emissive: 0xffe08a, emissiveIntensity: 0.8 }), castRecv); lamp.position.y = 3.65; g.add(lamp);
    const cap = mesh(new THREE.ConeGeometry(0.6, 0.5, 12), std(0x2b2f36, 0.5), castRecv); cap.position.y = 4.15; g.add(cap);
    const keeper = house(1.6, 1.2, 0.8, 0xf6f1e8, 0x9a3b2a); keeper.position.set(1.4, 0, 0.2); g.add(keeper);
    placeAt(root, g, cx, cy, 0.3);
    c.blocked.push({ x: cx, y: cy, r: 3 });
  }
  // harbour buildings behind the seafront straight
  const sp = freeSpot(c, 3);
  if (sp) placeAt(root, house(4, 2.6, 1.5, 0xe9dcc5, 0x7a3b2b), sp.x, sp.y, Math.random() * 6);
  const sp2 = freeSpot(c, 2.5);
  if (sp2) placeAt(root, house(3, 2.2, 1.2, 0xcfe3ef, 0x44546a), sp2.x, sp2.y, Math.random() * 6);
  const hw = B.w / 2 + 15, hh = B.h / 2 + 15;
  placeAt(root, mug(0x2a6df0), B.cx + hw + 6, B.cy + hh - 8, -0.4);
  placeAt(root, tapeMeasure(), B.cx + hw * 0.55, B.cy + hh + 4, 0.5);
}

function alpineScenery(root: THREE.Group, c: SceneryCtx): void {
  buildTrees(root, c, 260, 0.9);
  const B = c.B;
  // peaks along the north edge of the table
  for (let i = 0; i < 6; i++) {
    const x = B.mnx - 10 + (i + 0.5) * ((B.w + 20) / 6) + rnd(-3, 3), y = B.mxy + 20 + rnd(-2, 6);
    const r = rnd(7, 11), h = rnd(9, 15);
    const rock = mesh(new THREE.ConeGeometry(r, h, 7 + (i % 3)), std(0x6f7278, 0.95, 0, { flatShading: true }), castRecv); rock.position.set(x, h / 2, -y); rock.rotation.y = Math.random() * 3; root.add(rock);
    const snow = mesh(new THREE.ConeGeometry(r * 0.42, h * 0.42, 7 + (i % 3)), std(0xf4f7fb, 0.9, 0, { flatShading: true }), castRecv); snow.position.set(x, h * 0.79, -y); snow.rotation.y = rock.rotation.y; root.add(snow);
  }
  // chalets and boulders
  for (let i = 0; i < 3; i++) {
    const sp = freeSpot(c, 2.4);
    if (sp) placeAt(root, house(2.6, 2.0, 1.0, 0xc89a68, 0x5b3a26, 0.7), sp.x, sp.y, Math.random() * 6);
  }
  const rockG = new THREE.IcosahedronGeometry(0.5, 0);
  const rocks = new THREE.InstancedMesh(rockG, std(0x8a8d92, 0.95, 0, { flatShading: true }), 60);
  const dm = new THREE.Object3D(); let n = 0, tries = 0;
  while (n < 60 && tries++ < 2000) {
    const x = B.mnx - 10 + Math.random() * (B.w + 20), y = B.mny - 10 + Math.random() * (B.h + 20);
    if (c.nearTrack(x, y, 3.2) || c.isBlocked(x, y)) continue;
    dm.position.set(x, 0.1, -y); dm.scale.set(rnd(0.5, 1.6), rnd(0.4, 1.0), rnd(0.5, 1.6)); dm.rotation.set(Math.random(), Math.random() * 6, 0); dm.updateMatrix();
    rocks.setMatrixAt(n++, dm.matrix);
  }
  rocks.count = n; rocks.castShadow = true; rocks.receiveShadow = true; root.add(rocks);
  // a cable car pylon pair for fun
  const sp = freeSpot(c, 1.5);
  if (sp) {
    const py = mesh(new THREE.BoxGeometry(0.25, 3.0, 0.25), std(0x5c6066, 0.5, 0.4), castRecv); py.position.set(sp.x, 1.5, -sp.y); root.add(py);
    const cab = mesh(new THREE.BoxGeometry(0.5, 0.4, 0.4), std(0xd42a22, 0.5), castRecv); cab.position.set(sp.x + 1.2, 2.5, -sp.y); root.add(cab);
  }
  const hw = B.w / 2 + 15, hh = B.h / 2 + 15;
  placeAt(root, deskLamp(), B.cx - hw - 9, B.cy - hh + 6, 2.4);
  placeAt(root, mug(0xd42a22), B.cx + hw + 6, B.cy - hh + 12, 0.2);
}

function workshopScenery(root: THREE.Group, c: SceneryCtx): void {
  buildTrees(root, c, 36, 0.6, 8);
  const B = c.B;
  // tool chest, drums, paint tins and a parts shelf inside the circuit
  const sp = freeSpot(c, 2.6);
  if (sp) {
    const g = new THREE.Group();
    const chest = mesh(new THREE.BoxGeometry(3.0, 1.9, 1.5), std(0xd42a22, 0.4, 0.2), castRecv); chest.position.y = 0.95; g.add(chest);
    for (let i = 0; i < 4; i++) { const dr = mesh(new THREE.BoxGeometry(2.7, 0.3, 0.05), std(0xb81f18, 0.4, 0.2)); dr.position.set(0, 0.35 + i * 0.4, 0.77); g.add(dr); const hd = mesh(new THREE.BoxGeometry(0.6, 0.06, 0.06), std(0xd0d4da, 0.3, 0.9)); hd.position.set(0, 0.35 + i * 0.4, 0.82); g.add(hd); }
    const top = mesh(new THREE.BoxGeometry(3.1, 0.08, 1.6), std(0x2b2f36, 0.5)); top.position.y = 1.94; g.add(top);
    placeAt(root, g, sp.x, sp.y, Math.random() * 6);
  }
  const sp2 = freeSpot(c, 2.6);
  if (sp2) {
    const shed = house(4.2, 2.8, 1.6, 0x9aa3ad, 0x4a4f57, 0.3);
    const sign = mesh(new THREE.BoxGeometry(2.4, 0.4, 0.04), std(0xffffff, 0.5, 0, { map: textTex(256, 48, '#1f4fbf', '#fff', 'PARTS & SERVICE', 'bold 28px Arial') })); sign.position.set(0, 1.95, 1.42); shed.add(sign);
    placeAt(root, shed, sp2.x, sp2.y, Math.random() * 6);
  }
  for (let i = 0; i < 3; i++) {
    const sp3 = freeSpot(c, 1.2);
    if (!sp3) break;
    for (let k = 0; k < 3; k++) {
      const dr = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.8, 12), std([0x2a6df0, 0xf5c518, 0x4b5563][k], 0.5, 0.3), castRecv);
      dr.position.set(sp3.x + k * 0.7 - 0.7, 0.4, -sp3.y); root.add(dr);
    }
  }
  // miniature trackside sheds and a tiny workbench with a mechanic
  for (let i = 0; i < 2; i++) {
    const sp4 = freeSpot(c, 1.6);
    if (sp4) {
      const bench = mesh(new THREE.BoxGeometry(1.8, 0.1, 0.7), std(0xa8824f, 0.7), castRecv); bench.position.set(sp4.x, 0.65, -sp4.y); root.add(bench);
      for (const [dx, dz] of [[-0.8, -0.3], [0.8, -0.3], [-0.8, 0.3], [0.8, 0.3]]) { const leg = mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), std(0x4a4f57, 0.5)); leg.position.set(sp4.x + dx, 0.3, -sp4.y + dz); root.add(leg); }
      root.add(figure(0x1f4fbf, sp4.x, sp4.y + 0.7));
    }
  }
  // full-size tools on the bench
  const hw = B.w / 2 + 15, hh = B.h / 2 + 15;
  placeAt(root, spanner(), B.cx + hw * 0.1, B.cy - hh - 3.5, 0.12);
  placeAt(root, screwdriver(0xd42a22), B.cx + hw + 6, B.cy + hh * 0.3, 1.35);
  placeAt(root, tapeRoll(), B.cx - hw - 6, B.cy + hh - 6, 0);
  placeAt(root, paintTin(0x2a6df0), B.cx - hw - 7, B.cy - hh + 8, 0);
  placeAt(root, paintTin(0xf5c518), B.cx - hw - 4.2, B.cy - hh + 10.5, 0);
  placeAt(root, mug(0xffffff), B.cx + hw + 7, B.cy + hh - 7, -0.8);
}

function speedwayScenery(root: THREE.Group, c: SceneryCtx): void {
  buildTrees(root, c, 120, 0.4);
  buildBushes(root, c, 40);
  const B = c.B;
  // floodlight towers at the four corners of the circuit
  for (const [x, y] of [[B.mnx - 4, B.mny - 4], [B.mxx + 4, B.mny - 4], [B.mnx - 4, B.mxy + 4], [B.mxx + 4, B.mxy + 4]]) {
    if (c.nearTrack(x, y, 3)) continue;
    const g = new THREE.Group();
    const mast = mesh(new THREE.CylinderGeometry(0.12, 0.2, 6.5, 8), std(0x9aa0a8, 0.4, 0.7), castRecv); mast.position.y = 3.25; g.add(mast);
    const head = mesh(new THREE.BoxGeometry(1.6, 0.9, 0.3), std(0x30343a, 0.4, 0.4), castRecv); head.position.y = 6.6; g.add(head);
    for (let i = 0; i < 6; i++) {
      const l = mesh(new THREE.BoxGeometry(0.22, 0.22, 0.05), std(0xfff6d0, 0.2, 0, { emissive: 0xfff1b0, emissiveIntensity: 1.2 })); l.position.set(-0.6 + (i % 3) * 0.6, 6.4 + Math.floor(i / 3) * 0.35, 0.17); g.add(l);
    }
    placeAt(root, g, x, y, Math.atan2(B.cy - y, B.cx - x) - Math.PI / 2 + Math.PI);
    c.blocked.push({ x, y, r: 1.5 });
  }
  // scoreboard tower and a hospitality marquee
  const sp = freeSpot(c, 2.2);
  if (sp) {
    const g = new THREE.Group();
    for (const dx of [-0.9, 0.9]) { const leg = mesh(new THREE.BoxGeometry(0.12, 3.0, 0.12), std(0x4a4f57, 0.5), castRecv); leg.position.set(dx, 1.5, 0); g.add(leg); }
    const board = mesh(new THREE.BoxGeometry(2.6, 1.4, 0.15), std(0xffffff, 0.5, 0, { map: textTex(256, 128, '#101418', '#ffd23f', 'LAP  TIMES', 'bold 40px Arial') }), castRecv); board.position.y = 3.6; g.add(board);
    placeAt(root, g, sp.x, sp.y, Math.random() * 6);
  }
  const sp2 = freeSpot(c, 3);
  if (sp2) {
    const g = new THREE.Group();
    const tent = mesh(new THREE.ConeGeometry(3.0, 1.6, 8), std(0xffffff, 0.7), castRecv); tent.position.y = 2.0; g.add(tent);
    const wallM = mesh(new THREE.CylinderGeometry(2.6, 2.6, 1.3, 8, 1, true), std(0x1f4fbf, 0.7, 0, { side: THREE.DoubleSide }), castRecv); wallM.position.y = 0.65; g.add(wallM);
    placeAt(root, g, sp2.x, sp2.y, Math.random() * 6);
  }
  // flag row along the outside of the highbank
  const hw = B.w / 2 + 15, hh = B.h / 2 + 15;
  placeAt(root, deskLamp(), B.cx + hw + 9, B.cy + hh - 4, -2.2);
  placeAt(root, mug(0x22b04b), B.cx - hw - 6, B.cy - hh + 9, 0.9);
  placeAt(root, screwdriver(0x2a6df0), B.cx - hw * 0.6, B.cy - hh - 3.5, -0.1);
}

export function buildScenery(root: THREE.Group, c: SceneryCtx): void {
  switch (c.theme) {
    case 'park': parkScenery(root, c); break;
    case 'harbour': harbourScenery(root, c); break;
    case 'alpine': alpineScenery(root, c); break;
    case 'workshop': workshopScenery(root, c); break;
    case 'speedway': speedwayScenery(root, c); break;
  }
}
