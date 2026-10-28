import * as THREE from 'three';
import * as T from './track';
import { Y0, std, mesh, canvasTex, noise, ribbon, wall, boxAt, groupAt, figure, textTex, mergeStatic } from './gfx';
import { buildScenery, matTexture, tableTexture, TEAM_COLS } from './scenery';
export { arrowGeometry, ribbon, wall, v3 } from './gfx';

export interface World {
  root: THREE.Group;
  startLights: THREE.MeshStandardMaterial[];
  bayGlow: THREE.MeshBasicMaterial[];
  /** stop-and-go penalty box highlight */
  penGlow: THREE.MeshBasicMaterial;
  crowd: THREE.InstancedMesh[];
  /** materials of everything that sits on bridge decks; faded while the player drives underneath */
  bridgeMats: THREE.Material[];
}

interface Piece { s0: number; s1: number; up: boolean; }

export function buildWorld(): World {
  const root = new THREE.Group();
  const B = T.BOUNDS;
  const side = THREE.DoubleSide;
  const L = T.L;
  const theme = T.DEF.theme;
  const noShadow = { cast: false, receive: false };
  const castRecv = { cast: true, receive: true };

  // ---- bridge material bookkeeping: anything built on a raised stretch gets a
  // private clone of its material so the deck can be faded when a car is beneath it
  const bridgeMats: THREE.Material[] = [];
  const cloneMap = new Map<THREE.Material, THREE.Material>();
  const bm = (m: THREE.Material): THREE.Material => {
    let c = cloneMap.get(m);
    if (!c) { c = m.clone(); c.transparent = true; cloneMap.set(m, c); bridgeMats.push(c); }
    return c;
  };
  /** split [s0, s1] at the edges of raised stretches */
  const pieces = (s0: number, s1: number): Piece[] => {
    const cuts = [s0, s1];
    for (const r of T.RAISED) { if (r.s0 > s0 && r.s0 < s1) cuts.push(r.s0); if (r.s1 > s0 && r.s1 < s1) cuts.push(r.s1); }
    cuts.sort((a, b) => a - b);
    const out: Piece[] = [];
    for (let i = 0; i < cuts.length - 1; i++) { const a = cuts[i], b = cuts[i + 1]; if (b - a < 1e-4) continue; out.push({ s0: a, s1: b, up: T.isRaised((a + b) / 2) }); }
    return out;
  };
  const addRun = (s0: number, s1: number, geo: (a: number, b: number) => THREE.BufferGeometry, m: THREE.Material, shadow = { cast: false, receive: true }): void => {
    for (const p of pieces(s0, s1)) root.add(mesh(geo(p.s0, p.s1), p.up ? bm(m) : m, shadow));
  };
  const matAt = (m: THREE.Material, s: number): THREE.Material => (T.isRaised(s) ? bm(m) : m);

  // ---------------- table + mat
  const woodTex = tableTexture(theme);
  woodTex.repeat.set(6, 6);
  const tableW = B.w + 70, tableH = B.h + 70;
  const table = mesh(new THREE.BoxGeometry(tableW, 2, tableH), std(0xffffff, 0.55, 0, { map: woodTex }));
  table.position.set(B.cx, -1.06, -B.cy);
  root.add(table);

  const matW = B.w + 30, matH = B.h + 30;
  const grassTex = matTexture(theme);
  grassTex.repeat.set(matW / 8, matH / 8);
  const mat = mesh(new THREE.BoxGeometry(matW, 0.06, matH), std(0xffffff, 0.95, 0, { map: grassTex }));
  mat.position.set(B.cx, -0.03, -B.cy);
  root.add(mat);
  const rimCol = theme === 'workshop' ? 0x24333a : theme === 'speedway' ? 0x35483a : 0x2f5f2a;
  const rim = mesh(new THREE.BoxGeometry(matW + 0.6, 0.05, matH + 0.6), std(rimCol, 1));
  rim.position.set(B.cx, -0.045, -B.cy); root.add(rim);

  // ---------------- track surface: individual plastic pieces between the joints
  const plasticTex = canvasTex(256, 256, (g) => {
    noise(g, 256, 256, [44, 45, 49], 16, 12000, 1);
    // faint moulding grain along the track
    for (let i = 0; i < 120; i++) {
      g.strokeStyle = `rgba(${i % 2 ? '255,255,255' : '0,0,0'},${0.03 + Math.random() * 0.04})`;
      g.lineWidth = 1 + Math.random() * 2;
      const x = Math.random() * 256;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 6, 256); g.stroke();
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.03})`;
      g.beginPath(); g.ellipse(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 18, 3 + Math.random() * 8, Math.random() * 3, 0, 7); g.fill();
    }
  });
  plasticTex.repeat.set(1, 0.25);
  const plasticA = std(0x8f9096, 0.58, 0.02, { map: plasticTex, side });
  const plasticB = std(0x85868c, 0.6, 0.02, { map: plasticTex, side });
  const edgeMat = std(0x5c5e64, 0.65, 0.02, { side });
  // joint positions (one every 4 units on straights, every 22.5° on arcs)
  const jointPos: number[] = [];
  for (const g of T.SEGS) {
    const step = g.kind === 'S' ? 4 : (g.R * Math.PI) / 8;
    const n = Math.max(1, Math.round(g.len / step));
    for (let i = 0; i < n; i++) jointPos.push(g.s0 + (g.len * i) / n);
  }
  jointPos.push(L);
  for (let i = 0; i < jointPos.length - 1; i++) {
    const a = jointPos[i], b = jointPos[i + 1];
    addRun(a, b, (x, y) => ribbon(x, y, (s) => -T.trackHalf(s), (s) => T.trackHalf(s), Y0, 0.25), i % 2 ? plasticA : plasticB);
  }
  // visible thickness of the plastic pieces (bridge decks have their own girders)
  for (const p of pieces(0, L)) {
    if (p.up) continue;
    for (const sd of [-1, 1]) root.add(mesh(wall(p.s0, p.s1, (s) => sd * T.trackHalf(s), -Y0, 0, 0.3), edgeMat, castRecv));
  }

  // squeeze plate tint
  const sqMat = std(0x26272c, 0.6, 0.0, { side });
  root.add(mesh(ribbon(T.SQ_Q0, T.SQ_Q3, (s) => -T.trackHalf(s) + 0.12, (s) => T.trackHalf(s) - 0.12, Y0 + 0.001, 0.25), sqMat));

  // switch plates
  const swPlate = std(0x34363c, 0.6, 0.0, { side });
  const yellow = std(0xffc21a, 0.5, 0, { side });
  for (const sw of T.SWITCHES) {
    addRun(sw.s0 - 1, sw.s1 + 1, (a, b) => ribbon(a, b, () => -1.0, () => 1.0, Y0 + 0.001, 0.5), swPlate);
    for (let s = sw.s0 - 1; s < sw.s1 + 1; s += 1.0) {
      for (const sd of [-1, 1]) root.add(mesh(ribbon(s, s + 0.5, () => sd * 0.98, () => sd * 0.86, Y0 + 0.003, 0.5), matAt(yellow, s)));
    }
    for (let s = sw.s0 + 0.5; s < sw.s1; s += 2.2) {
      const shp = new THREE.Shape();
      shp.moveTo(0.25, 0); shp.lineTo(-0.1, 0.18); shp.lineTo(-0.02, 0); shp.lineTo(-0.1, -0.18); shp.closePath();
      const cg = new THREE.ShapeGeometry(shp); cg.rotateX(-Math.PI / 2);
      const p = T.point3(s, 0);
      const ch = mesh(cg, matAt(yellow, s)); ch.position.set(p.x, p.z + Y0 + 0.006, -p.y); ch.rotation.set(T.rollAt(s), p.h, Math.atan(T.slopeZ(s)), 'YXZ'); root.add(ch);
    }
  }

  // white edge lines
  const white = std(0xe9e9e4, 0.6, 0, { side });
  for (const sd of [-1, 1]) {
    addRun(0, L, (a, b) => ribbon(a, b, (s) => sd * (T.trackHalf(s) - 0.05), (s) => sd * (T.trackHalf(s) - 0.1), Y0 + 0.003, 0.25), white);
  }

  // slots and rails
  const slotMat = new THREE.MeshBasicMaterial({ color: 0x050506, side });
  const railMat = std(0xd8dbe0, 0.22, 0.95, { side });
  const grooveMat = std(0x5a5c62, 0.7, 0.1, { side });
  const slotAndRails = (s0: number, s1: number, d: (s: number) => number, step = 0.2): void => {
    addRun(s0, s1, (a, b) => ribbon(a, b, (s) => d(s) - 0.038, (s) => d(s) + 0.038, Y0 + 0.004, step), slotMat, noShadow);
    for (const o of [-1, 1]) {
      addRun(s0, s1, (a, b) => ribbon(a, b, (s) => d(s) + o * 0.062, (s) => d(s) + o * 0.105, Y0 + 0.0045, step), railMat);
      addRun(s0, s1, (a, b) => ribbon(a, b, (s) => d(s) + o * 0.105, (s) => d(s) + o * 0.135, Y0 + 0.0042, step), grooveMat);
    }
  };
  for (const sd of [-1, 1]) slotAndRails(0, L, (s) => sd * T.laneHalf(s));
  for (const sw of T.SWITCHES) {
    const len = sw.s1 - sw.s0;
    for (const sd of [-1, 1]) slotAndRails(sw.s0, sw.s1, (s) => sd * T.LANE_HALF * (1 - 2 * T.smooth((s - sw.s0) / len)), 0.15);
  }

  // section joints: a thin seam plus the clip tabs that hold real pieces together
  const jointMat = std(0x2c2e33, 0.6, 0.1, { side });
  const seamLight = std(0xa7a9ae, 0.5, 0.05, { side });
  const clipMat = std(0x3b3d43, 0.5, 0.2);
  for (const s of jointPos) {
    if (s >= L) continue;
    root.add(mesh(ribbon(s - 0.025, s + 0.025, (q) => -T.trackHalf(q), (q) => T.trackHalf(q), Y0 + 0.003, 0.05), matAt(jointMat, s)));
    root.add(mesh(ribbon(s + 0.025, s + 0.05, (q) => -T.trackHalf(q), (q) => T.trackHalf(q), Y0 + 0.0028, 0.05), matAt(seamLight, s)));
    if (T.isRaised(s)) continue;
    for (const sd of [-1, 1]) root.add(boxAt(s, sd * (T.trackHalf(s) + 0.06), 0.16, 0.045, 0.12, clipMat, -0.03));
  }

  // ---------------- kerbs, borders and barriers
  const kerbTex = canvasTex(64, 64, (g) => {
    g.fillStyle = '#ececea'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#d42a22'; g.fillRect(0, 0, 64, 32);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 30, 64, 3); g.fillRect(0, 62, 64, 2);
  }, true);
  const kerbMat = std(0xffffff, 0.6, 0, { map: kerbTex, side });
  const hazTex = canvasTex(64, 64, (g) => { g.fillStyle = '#ffcc00'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#151515'; g.fillRect(0, 0, 64, 32); }, true);
  const hazMat = std(0xffffff, 0.6, 0, { map: hazTex, side });
  const borderMat = std(0x7b8088, 0.75, 0, { side });
  const barrierTex = canvasTex(128, 32, (g) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 128, 32);
    g.fillStyle = '#d42a22'; for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 16, 32);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 28, 128, 4);
    g.fillStyle = 'rgba(0,0,0,0.3)'; for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 32);
  });
  const barrierMat = std(0xffffff, 0.5, 0, { map: barrierTex, side });
  const blueBarrierTex = canvasTex(128, 32, (g) => {
    g.fillStyle = '#1f4fbf'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffffff'; g.fillRect(0, 12, 128, 6);
    g.fillStyle = 'rgba(0,0,0,0.3)'; for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 32);
  });
  const blueBarrier = std(0xffffff, 0.5, 0, { map: blueBarrierTex, side });
  const skirtMat = std(0x4a4d55, 0.7, 0.05, { side });
  const pierMat = std(0x8d9299, 0.6, 0.2);

  for (let i = 0; i < T.SEGS.length; i++) {
    const g = T.SEGS[i];
    if (g.kind !== 'A') continue;
    const s0 = g.s0, s1 = g.s0 + g.len;
    const isSq = i === T.SQ_SEG;
    const banked = T.BANKS.some((b) => b.s0 === s0);
    for (const sd of [-1, 1]) {
      const outer = sd === -g.sign;
      const kerbW = outer ? 0.35 : 0.22;
      addRun(s0, s1, (a, b) => ribbon(a, b, (s) => sd * T.trackHalf(s), (s) => sd * (T.trackHalf(s) + kerbW), Y0 + 0.0015, 0.2, 2.2), isSq ? hazMat : kerbMat);
      if (outer) {
        const dOut = (s: number): number => sd * (T.trackHalf(s) + kerbW + 0.9);
        root.add(mesh(ribbon(s0 - 1, s1 + 1, (s) => sd * (T.trackHalf(s) + kerbW), dOut, Y0 + 0.001, 0.3), borderMat));
        root.add(mesh(wall(s0 - 1, s1 + 1, dOut, Y0, Y0 + 0.3, 0.3, 0.5), barrierMat, castRecv));
        if (banked) {
          // the raised outer edge of a banked plate stands on a moulded support skirt
          root.add(mesh(wall(s0, s1, dOut, () => 0, Y0 - 0.005, 0.3), skirtMat, castRecv));
          root.add(mesh(wall(s0, s1, (s) => sd * (T.trackHalf(s) + kerbW + 0.02), () => 0, Y0 - 0.01, 0.3), skirtMat, castRecv));
        }
      } else if (banked) {
        // inner kerb support: the plate rises away from the mat on the inside too
        root.add(mesh(wall(s0, s1, (s) => sd * (T.trackHalf(s) + kerbW), () => 0, Y0 - 0.005, 0.3), skirtMat, castRecv));
      }
    }
    if (banked) {
      const bk = T.BANKS.find((b) => b.s0 === s0)!;
      // slope shading: a translucent gradient across the plate, light on the raised outer edge
      const shadeTex = canvasTex(64, 4, (g) => {
        const gr = g.createLinearGradient(0, 0, 64, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0.16)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.34)');
        g.clearRect(0, 0, 64, 4); g.fillStyle = gr; g.fillRect(0, 0, 64, 4);
      }, false);
      const outerSd = -bk.sign;
      root.add(mesh(ribbon(s0, s1, (s) => outerSd * (T.trackHalf(s) + 0.35), (s) => -outerSd * (T.trackHalf(s) + 0.22), Y0 + 0.0022, 0.25), new THREE.MeshBasicMaterial({ map: shadeTex, transparent: true, depthWrite: false, side }), noShadow));
      // banking ribs: vertical fins under the raised edge every few units
      for (let s = s0 + 1.5; s < s1 - 1; s += 2.5) {
        const z = T.surfZ(s, -bk.sign * T.BANK_HALF);
        const d = -bk.sign * (T.trackHalf(s) + 0.6);
        root.add(boxAt(s, d, 0.14, Math.max(0.05, z - 0.02), 1.3, pierMat, -z + 0.0));
      }
    }
  }
  // squeeze side barriers
  for (const sd of [-1, 1]) {
    root.add(mesh(wall(T.SQ_Q0, T.SQ_Q3, (s) => sd * (T.trackHalf(s) + 0.42), Y0, Y0 + 0.22, 0.3, 0.5), blueBarrier, castRecv));
  }
  // straights: low blue barriers
  for (const [si, sd] of T.DEF.barriers) {
    const g = T.SEGS[si];
    addRun(g.s0 + 1, g.s0 + g.len - 1, (a, b) => wall(a, b, () => sd * (T.LANE_HALF + T.TRACK_EDGE + 1.0), Y0, Y0 + 0.22, 1, 0.5), blueBarrier, castRecv);
  }
  // catch fencing along selected straights
  const fenceTex = canvasTex(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(210,214,220,0.85)'; g.lineWidth = 1.5;
    for (let i = 0; i <= 64; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(64, i); g.stroke(); }
  });
  const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, transparent: true, alphaTest: 0.3, side, roughness: 0.6, metalness: 0.4, color: 0xffffff });
  const postMat = std(0x9aa0a8, 0.4, 0.7);
  for (const [si, sd] of T.DEF.fences ?? []) {
    const g = T.SEGS[si];
    const d = sd * (T.LANE_HALF + T.TRACK_EDGE + 1.5);
    const a = g.s0 + 0.5, b = g.s0 + g.len - 0.5;
    root.add(mesh(wall(a, b, () => d, 0.1, 1.0, 1, 1), fenceMat, { cast: false, receive: false }));
    for (let s = a; s <= b + 0.01; s += 2) root.add(boxAt(s, d, 0.06, 1.05, 0.06, postMat, 0, castRecv));
  }
  // distance boards before the listed corners
  for (const si of T.DEF.boards ?? []) {
    const g = T.SEGS[si];
    const out = -g.sign;
    [['100', 9], ['50', 5.5], ['25', 3]].forEach(([txt, dist], k) => {
      const s = g.s0 - (dist as number);
      const d = out * (T.trackHalf(s) + 1.25);
      const gr = groupAt(s, d, true);
      const bd = mesh(new THREE.BoxGeometry(0.06, 0.4, 0.5), std(0xffffff, 0.5, 0, { map: textTex(64, 48, k === 2 ? '#d42a22' : '#1f4fbf', '#fff', txt as string, 'bold 30px Arial') }), castRecv);
      bd.position.y = 0.55; gr.add(bd);
      const post = mesh(new THREE.BoxGeometry(0.04, 0.4, 0.04), postMat, castRecv); post.position.y = 0.2; gr.add(post);
      root.add(gr);
    });
  }

  // ---------------- start / finish
  const checkTex = canvasTex(64, 64, (g) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 8, y * 8, 8, 8); }
  });
  checkTex.repeat.set(1, 4);
  const fs = T.FINISH_S;
  root.add(mesh(ribbon(fs - 0.2, fs + 0.2, () => -T.LANE_HALF - T.TRACK_EDGE, () => T.LANE_HALF + T.TRACK_EDGE, Y0 + 0.0035, 0.4, 1 / 0.4), std(0xffffff, 0.6, 0, { map: checkTex, side })));
  for (const prog of [-1.3, -3.9]) for (const sd of [-1, 1]) {
    const s = fs + prog;
    const gm = std(0xf0f0f0, 0.6, 0, { side });
    root.add(mesh(ribbon(s - 0.05, s + 0.05, () => sd * T.LANE_HALF - 0.38, () => sd * T.LANE_HALF + 0.38, Y0 + 0.0035, 0.1), gm));
    root.add(mesh(ribbon(s - 0.45, s + 0.05, () => sd * T.LANE_HALF + 0.33, () => sd * T.LANE_HALF + 0.38, Y0 + 0.0035, 0.1), gm));
    root.add(mesh(ribbon(s - 0.45, s + 0.05, () => sd * T.LANE_HALF - 0.38, () => sd * T.LANE_HALF - 0.33, Y0 + 0.0035, 0.1), gm));
  }
  // gantry
  const startLights: THREE.MeshStandardMaterial[] = [];
  {
    const gant = groupAt(fs, 0);
    const postM = std(0x30343a, 0.4, 0.6);
    for (const z of [-2.1, 1.6]) {
      const post = mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), postM, castRecv); post.position.set(0, 1.2, z); gant.add(post);
      const foot = mesh(new THREE.BoxGeometry(0.4, 0.08, 0.4), postM, castRecv); foot.position.set(0, 0.04, z); gant.add(foot);
    }
    const beam = mesh(new THREE.BoxGeometry(0.3, 0.42, 3.9), std(0x1a1d22, 0.4, 0.3), castRecv); beam.position.set(0, 2.3, -0.25); gant.add(beam);
    const banner = mesh(new THREE.BoxGeometry(0.02, 0.36, 3.2), std(0xffffff, 0.6, 0, { map: textTex(512, 64, '#1a1d22', '#ffd23f', 'SLOT RUSH GP', 'bold italic 44px Arial') }));
    banner.position.set(-0.17, 2.3, -0.25); banner.rotation.y = Math.PI; gant.add(banner);
    for (let i = 0; i < 5; i++) {
      const lm = std(0x330000, 0.3, 0, { emissive: 0x000000 });
      startLights.push(lm);
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), lm); l.position.set(0, 2.55, -1.05 + i * 0.4); gant.add(l);
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10), postM); cup.position.set(0, 2.52, -1.05 + i * 0.4); gant.add(cup);
    }
    root.add(gant);
  }

  // ---------------- pit lane
  const pitSurf = std(0x2a2b30, 0.68, 0.0, { side, map: plasticTex });
  const ps0 = T.PIT_IN0 - 0.2, ps1 = T.PIT_OUT1 + 0.2;
  root.add(mesh(ribbon(ps0, ps1, (s) => T.pitD(s) - 0.6, (s) => T.pitD(s) + 0.6, Y0 - 0.0015, 0.2), pitSurf));
  root.add(mesh(wall(ps0, ps1, (s) => T.pitD(s) - 0.6, -Y0, -0.0015, 0.3), edgeMat, castRecv));
  slotAndRails(T.PIT_IN0, T.PIT_OUT1, (s) => T.pitD(s), 0.15);
  for (const s of [T.PIT_IN1 + 0.3, T.PIT_OUT0 - 0.3]) {
    root.add(mesh(ribbon(s - 0.06, s + 0.06, () => T.PIT_D - 0.6, () => T.PIT_D + 0.6, Y0 + 0.0035, 0.12), white));
  }
  const cyan = std(0x22d3ee, 0.5, 0, { side, emissive: 0x0a4a55 });
  for (let s = T.PIT_IN0 - 6; s < T.PIT_IN0; s += 1.5) {
    root.add(mesh(ribbon(s, s + 0.7, () => -T.LANE_HALF - T.TRACK_EDGE + 0.12, () => -T.LANE_HALF - T.TRACK_EDGE + 0.04, Y0 + 0.0035, 0.35), cyan));
  }
  // stop-and-go penalty box: hatched yellow/black stretch of pit lane with a STOP board
  const penGlow = new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0, side, depthWrite: false });
  {
    const hatch = canvasTex(128, 32, (g) => { g.fillStyle = '#e8c21a'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#17181c'; for (let x = -32; x < 128; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 48, 0); g.lineTo(x + 32, 0); g.closePath(); g.fill(); } });
    hatch.wrapS = THREE.RepeatWrapping; hatch.repeat.set(3, 1);
    const hm = std(0xffffff, 0.6, 0, { map: hatch, side });
    for (const e of [-1, 1]) root.add(mesh(ribbon(T.PEN_S - T.PEN_HALF, T.PEN_S + T.PEN_HALF, () => T.PIT_D + e * 0.62 - 0.08, () => T.PIT_D + e * 0.62 + 0.08, Y0 + 0.0035, 0.1), hm));
    for (const e of [-1, 1]) root.add(mesh(ribbon(T.PEN_S + e * T.PEN_HALF - 0.08, T.PEN_S + e * T.PEN_HALF + 0.08, () => T.PIT_D - 0.62, () => T.PIT_D + 0.62, Y0 + 0.0035, 0.1), hm));
    root.add(mesh(ribbon(T.PEN_S - T.PEN_HALF + 0.1, T.PEN_S + T.PEN_HALF - 0.1, () => T.PIT_D - 0.54, () => T.PIT_D + 0.54, Y0 + 0.0055, 0.3), penGlow, noShadow));
    const sb = groupAt(T.PEN_S, T.PIT_D - 1.05);
    const sign = mesh(new THREE.BoxGeometry(0.5, 0.26, 0.03), std(0xffffff, 0.5, 0, { map: textTex(128, 64, '#d62828', '#fff', 'STOP', 'bold 40px Arial') }), castRecv);
    sign.position.y = 0.7; sb.add(sign);
    const pole = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 5), postMat); pole.position.y = 0.3; sb.add(pole);
    root.add(sb);
  }
  // service bays
  const bayGlow: THREE.MeshBasicMaterial[] = [];
  for (let j = 0; j < T.BAYS.length; j++) {
    const bs = T.BAYS[j];
    root.add(mesh(ribbon(bs - T.BAY_HALF, bs + T.BAY_HALF, () => T.BAY_D - 0.6, () => T.PIT_D - 0.6, Y0 - 0.0012, 0.3), std(0x4a4d55, 0.6, 0, { side })));
    const tc = std(TEAM_COLS[j], 0.5, 0, { side });
    for (const e of [-1, 1]) root.add(mesh(ribbon(bs + e * T.BAY_HALF - 0.05, bs + e * T.BAY_HALF + 0.05, () => T.BAY_D - 0.6, () => T.PIT_D + 0.6, Y0 + 0.0035, 0.1), tc));
    slotAndRails(bs - 1.2, bs, (s) => T.PIT_D + (T.BAY_D - T.PIT_D) * T.smooth((s - (bs - 1.2)) / 1.2), 0.1);
    const gm = new THREE.MeshBasicMaterial({ color: 0x3cff8a, transparent: true, opacity: 0, side, depthWrite: false });
    bayGlow.push(gm);
    root.add(mesh(ribbon(bs - T.BAY_HALF + 0.08, bs + T.BAY_HALF - 0.08, () => T.BAY_D - 0.52, () => T.PIT_D - 0.5, Y0 + 0.0055, 0.3), gm, noShadow));
    // fuel rig, hose, crew, pit board and a tyre trolley
    const rp = T.point(bs + 0.6, T.BAY_D - 1.0);
    const rig = mesh(new THREE.BoxGeometry(0.25, 0.5, 0.25), std(0xd62828, 0.4, 0.2), castRecv);
    rig.position.set(rp.x, 0.25, -rp.y); root.add(rig);
    const hose = mesh(new THREE.TorusGeometry(0.18, 0.025, 6, 16, Math.PI), std(0x111111, 0.6), { cast: true, receive: false });
    hose.position.set(rp.x, 0.5, -rp.y); hose.rotation.y = rp.h; root.add(hose);
    for (const off of [-0.5, 0.25]) {
      const cp = T.point(bs + off, T.BAY_D - 0.95);
      root.add(figure(TEAM_COLS[j], cp.x, cp.y));
    }
    const pb = groupAt(bs - 0.9, T.PIT_D - 0.95);
    const board = mesh(new THREE.BoxGeometry(0.3, 0.22, 0.03), std(0xffffff, 0.5, 0, { map: textTex(64, 48, '#111', '#fff', String([7, 11, 3, 24][j]), 'bold 34px Arial') }), castRecv);
    board.position.y = 0.62; pb.add(board);
    const pole = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 5), postMat); pole.position.y = 0.27; pb.add(pole);
    root.add(pb);
    const wheelG = new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12); wheelG.rotateZ(Math.PI / 2);
    const tp = T.point(bs + 0.95, T.BAY_D - 0.75);
    for (let k = 0; k < 2; k++) { const w = mesh(wheelG, std(0x151515, 0.8), castRecv); w.position.set(tp.x, 0.11, -tp.y - 0.12 + k * 0.24); root.add(w); }
  }
  // pit wall with team boards
  const pitWallTex = canvasTex(128, 32, (g) => { g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#2a6df0'; g.fillRect(0, 22, 128, 6); g.fillStyle = 'rgba(0,0,0,0.2)'; for (let x = 0; x < 128; x += 64) g.fillRect(x, 0, 2, 32); });
  const pwm = std(0xffffff, 0.7, 0, { map: pitWallTex, side });
  root.add(mesh(wall(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.62, 0, 0.32, 1, 0.25), pwm, castRecv));
  root.add(mesh(wall(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.78, 0, 0.32, 1, 0.25), pwm, castRecv));
  root.add(mesh(ribbon(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.78, () => -1.62, 0.32, 1), std(0xbfbfbf, 0.7, 0, { side })));
  for (let j = 0; j < 4; j++) {
    const s = T.BAYS[j] + 0.3;
    const gr = groupAt(s, -1.7);
    const stool = mesh(new THREE.BoxGeometry(0.5, 0.3, 0.28), std(0x2b2f36, 0.5), castRecv); stool.position.y = 0.47; gr.add(stool);
    const mon = mesh(new THREE.BoxGeometry(0.34, 0.2, 0.03), std(0x0f172a, 0.3, 0.2, { emissive: TEAM_COLS[j], emissiveIntensity: 0.25 })); mon.position.set(0, 0.72, 0.12); gr.add(mon);
    root.add(gr);
    const cp = T.point(s, -1.3);
    root.add(figure(TEAM_COLS[j], cp.x, cp.y));
  }
  // garage building
  {
    const s0 = T.BAYS[0] - 2.2, s1 = T.BAYS[3] + 2.2;
    const mid = (s0 + s1) / 2, len = s1 - s0;
    const gr = groupAt(mid, T.BAY_D - 2.3);
    const body = mesh(new THREE.BoxGeometry(len, 1.5, 1.8), std(0xeeeeee, 0.6), castRecv); body.position.set(0, 0.75, 0); gr.add(body);
    const roof = mesh(new THREE.BoxGeometry(len + 0.6, 0.12, 1.95), std(0x2b2f36, 0.5, 0.2), castRecv); roof.position.set(0, 1.56, 0); gr.add(roof);
    const stripe = mesh(new THREE.BoxGeometry(len + 0.62, 0.14, 0.04), std(0xd42a22, 0.5)); stripe.position.set(0, 1.56, -0.99); gr.add(stripe);
    for (let j = 0; j < 4; j++) {
      const door = mesh(new THREE.BoxGeometry(2.2, 1.0, 0.04), std(0x15171b, 0.6)); door.position.set(T.BAYS[j] - mid, 0.52, -0.92); gr.add(door);
      const band = mesh(new THREE.BoxGeometry(2.2, 0.12, 0.05), std(TEAM_COLS[j], 0.5)); band.position.set(T.BAYS[j] - mid, 1.12, -0.93); gr.add(band);
      const sign = mesh(new THREE.BoxGeometry(0.9, 0.22, 0.03), std(0xffffff, 0.5, 0, { map: textTex(128, 32, '#fff', '#111', ['YOU', 'COMET', 'ARROW', 'VIPER'][j], 'bold 22px Arial') }));
      sign.position.set(T.BAYS[j] - mid, 1.32, -0.93); gr.add(sign);
    }
    const hb = mesh(new THREE.BoxGeometry(len * 0.6, 0.7, 1.2), std(0x9fb7d9, 0.2, 0.4), castRecv); hb.position.set(0, 1.97, 0.1); gr.add(hb);
    for (let k = 0; k < 3; k++) {
      const ac = mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), std(0xb8bcc4, 0.5, 0.3), castRecv); ac.position.set(-len * 0.4 + k * 0.6, 1.74, 0.5); gr.add(ac);
    }
    root.add(gr);
    // tyre racks and drums behind the garage
    const drumG = new THREE.CylinderGeometry(0.16, 0.16, 0.4, 10);
    for (let k = 0; k < 5; k++) {
      const p = T.point(s0 + 1 + k * 1.1, T.BAY_D - 3.6);
      const dr = mesh(drumG, std(k % 2 ? 0x2a6df0 : 0xd42a22, 0.5, 0.2), castRecv); dr.position.set(p.x, 0.2, -p.y); root.add(dr);
    }
  }

  // ---------------- bridges: decks, girders, piers, ramp skirts and railings
  const pts: { x: number; y: number; s: number }[] = [];
  for (let s = 0; s < L; s += 1) { const c = T.center(s); pts.push({ x: c.x, y: c.y, s }); }
  const deckMat = std(0x3a3d44, 0.7, 0.1, { side });
  const girderMat = std(0xc4c7cd, 0.5, 0.3, { side });
  const redMat = std(0xd42a22, 0.5, 0.1, { side });
  const railPostMat = std(0xe6e8eb, 0.4, 0.5);
  const nearLower = (x: number, y: number, s: number): boolean => pts.some((p) => Math.abs(T.gapS(p.s, s)) > 10 && (p.x - x) ** 2 + (p.y - y) ** 2 < 2.4 * 2.4);
  for (const r of T.RAISED) {
    const th = (s: number): number => T.trackHalf(s);
    root.add(mesh(ribbon(r.s0, r.s1, (s) => -(th(s) + 0.2), (s) => th(s) + 0.2, -0.24, 0.3), bm(deckMat), castRecv));
    // ramp shading: a translucent gradient that darkens towards the foot of each ramp
    for (const [a, b, flip] of [[r.s0, r.s0 + 8, false], [r.s1 - 8, r.s1, true]] as [number, number, boolean][]) {
      const tex = canvasTex(4, 64, (g) => { const gr = g.createLinearGradient(0, flip ? 64 : 0, 0, flip ? 0 : 64); gr.addColorStop(0, 'rgba(0,0,0,0.32)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.clearRect(0, 0, 4, 64); g.fillStyle = gr; g.fillRect(0, 0, 4, 64); }, false);
      root.add(mesh(ribbon(a, b, (s) => -th(s), (s) => th(s), Y0 + 0.0012, 0.25, 1 / (b - a)), bm(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side })), noShadow));
    }
    for (const sd of [-1, 1]) {
      root.add(mesh(wall(r.s0, r.s1, (s) => sd * (th(s) + 0.2), -0.24, -0.003, 0.3), bm(girderMat), castRecv));
      root.add(mesh(wall(r.s0, r.s1, (s) => sd * (th(s) + 0.205), -0.14, -0.06, 0.3), bm(redMat), castRecv));
      root.add(mesh(wall(r.s0, r.s1, (s) => sd * (th(s) + 0.1), Y0 + 0.3, Y0 + 0.34, 0.3), bm(white), castRecv));
      for (let s = r.s0 + 0.6; s < r.s1 - 0.3; s += 1.2) root.add(boxAt(s, sd * (th(s) + 0.1), 0.05, 0.32, 0.05, bm(railPostMat), Y0));
      // hazard stripes at both ramp feet
      for (const [a, b] of [[r.s0 + 0.2, r.s0 + 1.8], [r.s1 - 1.8, r.s1 - 0.2]]) {
        root.add(mesh(ribbon(a, b, (s) => sd * (th(s) - 0.3), (s) => sd * (th(s) - 0.1), Y0 + 0.0035, 0.2, 2.5), bm(hazMat)));
      }
    }
    // low parts of the ramps are solid; the high deck stands on piers so the lower track can pass beneath
    let skirt: { s0: number; s1: number } | null = null;
    const flush = (): void => { if (!skirt) return; for (const sd of [-1, 1]) root.add(mesh(wall(skirt.s0, skirt.s1, (s) => sd * (th(s) + 0.2), () => 0, -0.24, 0.3), skirtMat, castRecv)); skirt = null; };
    for (let s = r.s0; s <= r.s1 + 1e-6; s += 0.25) {
      const low = T.elevZ(s) < 0.8;
      if (low) { if (!skirt) skirt = { s0: s, s1: s }; skirt.s1 = Math.min(r.s1, s + 0.25); }
      else flush();
    }
    flush();
    for (let s = r.s0 + 1.6; s < r.s1 - 1; s += 3.2) {
      const z = T.elevZ(s);
      if (z < 0.8) continue;
      const c = T.center(s);
      if (nearLower(c.x, c.y, s)) continue;
      for (const sd of [-1, 1]) root.add(boxAt(s, sd * (th(s) + 0.45), 0.34, z - 0.1, 0.34, pierMat, -z + 0.01));
      root.add(boxAt(s, 0, 2 * (th(s) + 0.45) + 0.34, 0.14, 0.4, pierMat, -0.38));
    }
  }

  // ---------------- grandstands
  const crowd: THREE.InstancedMesh[] = [];
  const stand = (s0: number, s1: number, d0: number, sd: number, rows: number, roofCol: number): void => {
    const mid = (s0 + s1) / 2, len = s1 - s0;
    const gr = groupAt(mid, d0);
    const away = sd > 0 ? -1 : 1; // local z direction away from track
    const stepD = 0.45, stepH = 0.28;
    const seatM = std(0x8a9099, 0.7), seatM2 = std(0x6c737c, 0.7);
    const crowdG = new THREE.BoxGeometry(0.16, 0.24, 0.14);
    const n = rows * Math.floor(len / 0.24);
    const cm = new THREE.InstancedMesh(crowdG, std(0xffffff, 0.8), n);
    cm.castShadow = true;
    const dummy = new THREE.Object3D(); const col = new THREE.Color();
    const palette = [0xe8322a, 0x2a6df0, 0xffcc1a, 0x22b04b, 0xffffff, 0xff7f1a, 0x9b5de5, 0x222222, 0xf15bb5];
    let ci = 0;
    for (let r = 0; r < rows; r++) {
      const step = mesh(new THREE.BoxGeometry(len, stepH * (r + 1), stepD), r % 2 ? seatM : seatM2, castRecv);
      step.position.set(0, (stepH * (r + 1)) / 2, away * (r * stepD + stepD / 2));
      gr.add(step);
      for (let x = -len / 2 + 0.15; x < len / 2 - 0.1 && ci < n; x += 0.24) {
        if (Math.random() < 0.12) continue;
        dummy.position.set(x + (Math.random() - 0.5) * 0.05, stepH * (r + 1) + 0.12, away * (r * stepD + stepD * 0.55));
        dummy.rotation.set(0, (Math.random() - 0.5) * 0.4, 0); dummy.updateMatrix();
        cm.setMatrixAt(ci, dummy.matrix); cm.setColorAt(ci, col.setHex(palette[(Math.random() * palette.length) | 0])); ci++;
      }
    }
    cm.count = ci; gr.add(cm); crowd.push(cm);
    const depth = rows * stepD;
    const backH = stepH * rows + 1.2;
    const back = mesh(new THREE.BoxGeometry(len, backH, 0.1), std(0x3b4048, 0.6), castRecv); back.position.set(0, backH / 2, away * (depth + 0.05)); gr.add(back);
    const roof = mesh(new THREE.BoxGeometry(len + 0.4, 0.08, depth * 0.38), std(roofCol, 0.5, 0.1), castRecv);
    roof.position.set(0, backH, away * (depth * 0.82)); gr.add(roof);
    const roofEdge = mesh(new THREE.BoxGeometry(len + 0.42, 0.1, 0.08), std(0xffffff, 0.5)); roofEdge.position.set(0, backH, away * (depth * 0.63)); gr.add(roofEdge);
    for (let x = -len / 2; x <= len / 2 + 0.01; x += len / 4) {
      const post = mesh(new THREE.CylinderGeometry(0.04, 0.04, backH, 6), std(0xcccccc, 0.3, 0.7), { cast: true, receive: false });
      post.position.set(x, backH / 2, away * 0.02); gr.add(post);
    }
    // a row of flags along the roof
    const flagCols = [0xffffff, roofCol, 0xffcc1a];
    for (let x = -len / 2 + 0.6, k = 0; x < len / 2 - 0.3; x += 1.2, k++) {
      const pole = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 4), postMat); pole.position.set(x, backH + 0.25, away * (depth * 0.95)); gr.add(pole);
      const fl = mesh(new THREE.BoxGeometry(0.22, 0.14, 0.01), std(flagCols[k % 3], 0.6, 0, { side })); fl.position.set(x + 0.12, backH + 0.42, away * (depth * 0.95)); gr.add(fl);
    }
    // front rail with a sponsor banner
    const rail = mesh(new THREE.BoxGeometry(len, 0.22, 0.03), std(0xffffff, 0.6, 0, { map: textTex(512, 32, '#1f4fbf', '#fff', 'SLOT RUSH GP   •   SLOT RUSH GP   •   SLOT RUSH GP', 'bold 20px Arial') }), castRecv);
    rail.position.set(0, 0.36, away * -0.03); gr.add(rail);
    root.add(gr);
  };
  for (const st of T.DEF.stands) stand(T.at(st.s0), T.at(st.s1), st.d, st.sd, st.rows, st.roof);

  // ---------------- scenery placement helpers
  const nearTrack = (x: number, y: number, r: number): boolean => pts.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < r * r);
  const blocked: { x: number; y: number; r: number }[] = [];
  const addBlock = (s: number, d: number, r: number): void => { const p = T.point(s, d); blocked.push({ x: p.x, y: p.y, r }); };
  for (let s = 6; s <= 31; s += 3) addBlock(s, -5.5, 3.4); // garage / pit side of the main straight
  for (const st of T.DEF.stands) {
    const s0 = T.at(st.s0), s1 = T.at(st.s1);
    for (let s = s0; s <= s1 + 0.01; s += 3) addBlock(s, st.d + st.sd * 2.2, 3.6);
  }
  for (const si of T.DEF.boards ?? []) { const g = T.SEGS[si]; addBlock(g.s0 - 6, -g.sign * 2.4, 2.2); }
  const isBlocked = (x: number, y: number): boolean => blocked.some((b) => (b.x - x) ** 2 + (b.y - y) ** 2 < b.r * b.r);

  // tyre stacks outside tight corners
  const tyreG = new THREE.TorusGeometry(0.17, 0.08, 6, 12); tyreG.rotateX(Math.PI / 2);
  const tyreSpots: { x: number; y: number; z: number }[] = [];
  for (const si of T.DEF.tyreSegs) {
    const g = T.SEGS[si];
    for (let s = g.s0 + 0.5; s < g.s0 + g.len; s += 0.75) {
      const out = -g.sign;
      const p = T.point3(s, out * (T.trackHalf(s) + 1.75));
      tyreSpots.push({ x: p.x, y: p.y, z: T.isRaised(s) ? p.z : 0 });
    }
  }
  const dm = new THREE.Object3D(); const cc = new THREE.Color();
  const tyres = new THREE.InstancedMesh(tyreG, std(0xffffff, 0.8), Math.max(1, tyreSpots.length * 3));
  let ti = 0;
  tyreSpots.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      dm.position.set(p.x, p.z + 0.08 + k * 0.15, -p.y); dm.scale.setScalar(1); dm.rotation.set(0, Math.random() * 0.5, 0); dm.updateMatrix();
      tyres.setMatrixAt(ti, dm.matrix);
      tyres.setColorAt(ti, cc.setHex(k === 1 ? (i % 2 ? 0xd42a22 : 0xf0f0f0) : 0x181818)); ti++;
    }
  });
  tyres.count = ti; tyres.castShadow = true; root.add(tyres);

  // ad boards
  const adCols = [0xd42a22, 0x1f4fbf, 0xffcc1a, 0x111111, 0x22b04b];
  const adWords = ['TURBO OIL', 'SLOT RUSH', 'RAIL KING', 'VOLT', 'GRIP+'];
  const adTexes = adWords.map((w, i) => textTex(256, 56, '#' + adCols[i].toString(16).padStart(6, '0'), i === 2 ? '#111' : '#fff', w, 'bold italic 34px Arial'));
  const ad = (s: number, d: number, i: number): void => {
    const b = groupAt(s, d);
    const panel = mesh(new THREE.BoxGeometry(2.2, 0.45, 0.06), std(0xffffff, 0.5, 0, { map: adTexes[i % adTexes.length] }), castRecv); panel.position.y = 0.3; b.add(panel);
    for (const x of [-0.9, 0.9]) { const leg = mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), postMat); leg.position.set(x, 0.06, 0); b.add(leg); }
    root.add(b);
  };
  let ai = 0;
  for (const run of T.DEF.ads) {
    const s0 = T.at(run.s0), s1 = T.at(run.s1);
    for (let s = s0; s < s1; s += 2.6) ad(s, run.d, ai++);
  }

  // marshal posts: hut, flag and a marshal in orange
  for (const m of T.DEF.marshals) {
    const s = T.at(m.at);
    const gr = groupAt(s, m.d);
    const hut = mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), std(0xf5f5f5, 0.6), castRecv); hut.position.y = 0.25; gr.add(hut);
    const hr = mesh(new THREE.BoxGeometry(0.7, 0.06, 0.7), std(0xff7f1a, 0.6), castRecv); hr.position.y = 0.53; gr.add(hr);
    const pole = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5), std(0x999999, 0.4, 0.6)); pole.position.set(0.35, 0.45, 0); gr.add(pole);
    const flag = mesh(new THREE.PlaneGeometry(0.3, 0.2), std(0xffcc00, 0.6, 0, { side })); flag.position.set(0.5, 0.78, 0); gr.add(flag);
    root.add(gr);
    const mp = T.point(s + 0.9, m.d - Math.sign(m.d) * 0.5);
    root.add(figure(0xff7f1a, mp.x, mp.y, 0, 0xffffff));
  }

  buildScenery(root, { theme, B, nearTrack, isBlocked, blocked, L });
  mergeStatic(root);

  return { root, startLights, bayGlow, penGlow, crowd, bridgeMats };
}

/** Free GPU resources of a world built by buildWorld (geometries, materials, textures). */
export function disposeWorld(w: World): void {
  const mats = new Set<THREE.Material>();
  w.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
  });
  for (const m of mats) {
    const sm = m as THREE.MeshStandardMaterial;
    if (sm.map) sm.map.dispose();
    m.dispose();
  }
  w.root.removeFromParent();
}
