import * as THREE from 'three';
import * as T from './track';

// 2D (x, y-north) -> three (x, h, -y)
export function v3(x: number, y: number, h = 0): THREE.Vector3 { return new THREE.Vector3(x, h, -y); }

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, n: number, size = 2): void {
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const k = (Math.random() - 0.5) * amp;
    g.fillStyle = `rgba(${base[0] + k | 0},${base[1] + k * 1.2 | 0},${base[2] + k * 0.6 | 0},0.6)`;
    g.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

/** Ribbon between two lateral offset functions along the track. */
export function ribbon(s0: number, s1: number, dA: (s: number) => number, dB: (s: number) => number, y: number, step = 0.25, vScale = 1): THREE.BufferGeometry {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = T.point(s, dA(s)), b = T.point(s, dB(s));
    pos.push(a.x, y, -a.y, b.x, y, -b.y);
    const v = (s - s0) * vScale;
    uv.push(0, v, 1, v);
    nor.push(0, 1, 0, 0, 1, 0);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Vertical wall following d(s) */
export function wall(s0: number, s1: number, d: (s: number) => number, y0: number, y1: number, step = 0.4, vScale = 1): THREE.BufferGeometry {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = T.point(s, d(s));
    pos.push(a.x, y0, -a.y, a.x, y1, -a.y);
    const u = (s - s0) * vScale;
    uv.push(u, 0, u, 1);
    if (i < n) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, shadow = { cast: false, receive: true }): THREE.Mesh {
  const me = new THREE.Mesh(g, m); me.castShadow = shadow.cast; me.receiveShadow = shadow.receive; return me;
}

export interface World {
  root: THREE.Group;
  startLights: THREE.MeshStandardMaterial[];
  bayGlow: THREE.MeshBasicMaterial[];
  crowd: THREE.InstancedMesh[];
}

function std(color: number, rough = 0.7, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

export function buildWorld(): World {
  const root = new THREE.Group();
  const B = T.BOUNDS;
  const side = THREE.DoubleSide;

  // ---------------- table + grass mat
  const woodTex = canvasTex(512, 512, (g) => {
    g.fillStyle = '#7a4a26'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 160; i++) {
      const y = Math.random() * 512, a = Math.random() * 0.25;
      g.strokeStyle = `rgba(${Math.random() < 0.5 ? '40,20,8' : '160,110,60'},${a})`;
      g.lineWidth = 1 + Math.random() * 3;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 4);
      g.stroke();
    }
  });
  woodTex.repeat.set(6, 6);
  const tableW = B.w + 70, tableH = B.h + 70;
  const table = mesh(new THREE.BoxGeometry(tableW, 2, tableH), std(0xffffff, 0.6, 0, { map: woodTex }));
  table.position.set(B.cx, -1.06, -B.cy);
  root.add(table);

  const grassTex = canvasTex(512, 512, (g) => {
    noise(g, 512, 512, [84, 150, 62], 40, 26000, 2);
    for (let i = 0; i < 2500; i++) {
      g.strokeStyle = `rgba(${40 + Math.random() * 60 | 0},${110 + Math.random() * 80 | 0},40,0.5)`;
      const x = Math.random() * 512, y = Math.random() * 512;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.random() * 2 - 1, y - 3 - Math.random() * 3); g.stroke();
    }
  });
  grassTex.repeat.set((B.w + 30) / 8, (B.h + 30) / 8);
  const matW = B.w + 30, matH = B.h + 30;
  const mat = mesh(new THREE.BoxGeometry(matW, 0.06, matH), std(0xffffff, 0.95, 0, { map: grassTex }));
  mat.position.set(B.cx, -0.03, -B.cy);
  root.add(mat);
  // mat rim (felt edge)
  const rim = mesh(new THREE.BoxGeometry(matW + 0.6, 0.05, matH + 0.6), std(0x2f5f2a, 1));
  rim.position.set(B.cx, -0.045, -B.cy); root.add(rim);

  // ---------------- track surface
  const plasticTex = canvasTex(256, 256, (g) => noise(g, 256, 256, [30, 31, 35], 14, 9000, 1));
  plasticTex.repeat.set(1, 0.25);
  const plastic = std(0x9a9a9a, 0.62, 0.0, { map: plasticTex, side });
  const L = T.L;
  root.add(mesh(ribbon(0, L, (s) => -T.trackHalf(s), (s) => T.trackHalf(s), 0.02, 0.25), plastic));

  // squeeze plate tint
  const sqMat = std(0x1d1e22, 0.6, 0.0, { side });
  root.add(mesh(ribbon(T.SQ_Q0, T.SQ_Q3, (s) => -T.trackHalf(s) + 0.12, (s) => T.trackHalf(s) - 0.12, 0.021, 0.25), sqMat));

  // switch plates
  const swPlate = std(0x2a2c32, 0.6, 0.0, { side });
  const yellow = std(0xffc21a, 0.5, 0, { side });
  for (const sw of T.SWITCHES) {
    root.add(mesh(ribbon(sw.s0 - 1, sw.s1 + 1, () => -1.0, () => 1.0, 0.021, 0.5), swPlate));
    // yellow dashed edge markers
    for (let s = sw.s0 - 1; s < sw.s1 + 1; s += 1.0) {
      for (const sd of [-1, 1]) {
        root.add(mesh(ribbon(s, s + 0.5, () => sd * 0.98, () => sd * 0.86, 0.023, 0.5), yellow));
      }
    }
    // chevrons pointing in the race direction between the lanes
    for (let s = sw.s0 + 0.5; s < sw.s1; s += 2.2) {
      const shp = new THREE.Shape();
      shp.moveTo(0.25, 0); shp.lineTo(-0.1, 0.18); shp.lineTo(-0.02, 0); shp.lineTo(-0.1, -0.18); shp.closePath();
      const cg = new THREE.ShapeGeometry(shp); cg.rotateX(-Math.PI / 2);
      const p = T.point(s, 0);
      const ch = mesh(cg, yellow); ch.position.set(p.x, 0.024, -p.y); ch.rotation.y = p.h; root.add(ch);
    }
  }

  // white edge lines
  const white = std(0xe9e9e4, 0.6, 0, { side });
  for (const sd of [-1, 1]) {
    root.add(mesh(ribbon(0, L, (s) => sd * (T.trackHalf(s) - 0.05), (s) => sd * (T.trackHalf(s) - 0.1), 0.023, 0.25), white));
  }

  // slots and rails
  const slotMat = new THREE.MeshBasicMaterial({ color: 0x020202, side });
  const railMat = std(0xc9ccd2, 0.25, 0.95, { side });
  const slotAndRails = (s0: number, s1: number, d: (s: number) => number, step = 0.2): void => {
    root.add(mesh(ribbon(s0, s1, (s) => d(s) - 0.035, (s) => d(s) + 0.035, 0.026, step), slotMat, { cast: false, receive: false }));
    for (const o of [-1, 1]) {
      root.add(mesh(ribbon(s0, s1, (s) => d(s) + o * 0.06, (s) => d(s) + o * 0.1, 0.0265, step), railMat));
    }
  };
  for (const sd of [-1, 1]) slotAndRails(0, L, (s) => sd * T.laneHalf(s));
  for (const sw of T.SWITCHES) {
    const len = sw.s1 - sw.s0;
    for (const sd of [-1, 1]) slotAndRails(sw.s0, sw.s1, (s) => sd * T.LANE_HALF * (1 - 2 * T.smooth((s - sw.s0) / len)), 0.15);
  }

  // section joints
  const jointPos: number[] = [];
  for (const g of T.SEGS) {
    const step = g.kind === 'S' ? 4 : (g.R * Math.PI) / 8;
    const n = Math.max(1, Math.round(g.len / step));
    for (let i = 0; i < n; i++) jointPos.push(g.s0 + (g.len * i) / n);
  }
  const jointMat = std(0x55585e, 0.5, 0.2, { side });
  for (const s of jointPos) root.add(mesh(ribbon(s - 0.02, s + 0.02, (q) => -T.trackHalf(q), (q) => T.trackHalf(q), 0.0235, 0.04), jointMat));

  // kerbs, borders and barriers on corners
  const kerbTex = canvasTex(64, 64, (g) => { g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#d42a22'; g.fillRect(0, 0, 64, 32); }, true);
  const kerbMat = std(0xffffff, 0.6, 0, { map: kerbTex, side });
  const hazTex = canvasTex(64, 64, (g) => { g.fillStyle = '#ffcc00'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#111'; g.fillRect(0, 0, 64, 32); }, true);
  const hazMat = std(0xffffff, 0.6, 0, { map: hazTex, side });
  const borderMat = std(0x7b8088, 0.7, 0, { side });
  const barrierTex = canvasTex(128, 32, (g) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 128, 32);
    g.fillStyle = '#d42a22'; for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 16, 32);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 28, 128, 4);
  });
  const barrierMat = std(0xffffff, 0.5, 0, { map: barrierTex, side });
  const blueBarrierTex = canvasTex(128, 32, (g) => {
    g.fillStyle = '#1f4fbf'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#ffffff'; g.fillRect(0, 12, 128, 6);
  });
  const blueBarrier = std(0xffffff, 0.5, 0, { map: blueBarrierTex, side });

  for (let i = 0; i < T.SEGS.length; i++) {
    const g = T.SEGS[i];
    if (g.kind !== 'A') continue;
    const s0 = g.s0, s1 = g.s0 + g.len;
    const isSq = i === 1;
    for (const sd of [-1, 1]) {
      const outer = sd === -g.sign;
      const kerbW = outer ? 0.35 : 0.22;
      root.add(mesh(ribbon(s0, s1, (s) => sd * T.trackHalf(s), (s) => sd * (T.trackHalf(s) + kerbW), 0.022, 0.2, 2.2), isSq ? hazMat : kerbMat));
      if (outer) {
        root.add(mesh(ribbon(s0 - 1, s1 + 1, (s) => sd * (T.trackHalf(s) + kerbW), (s) => sd * (T.trackHalf(s) + kerbW + 0.9), 0.021, 0.3), borderMat));
        root.add(mesh(wall(s0 - 1, s1 + 1, (s) => sd * (T.trackHalf(s) + kerbW + 0.9), 0, 0.3, 0.3, 0.5), barrierMat, { cast: true, receive: true }));
      }
    }
  }
  // squeeze side barriers
  for (const sd of [-1, 1]) {
    root.add(mesh(wall(T.SQ_Q0, T.SQ_Q3, (s) => sd * (T.trackHalf(s) + 0.42), 0, 0.22, 0.3, 0.5), blueBarrier, { cast: true, receive: true }));
  }
  // straights: low blue barriers on the infield of back straight & north straight
  for (const [si, sd] of [[2, -1], [6, 1], [4, -1]] as [number, number][]) {
    const g = T.SEGS[si];
    root.add(mesh(wall(g.s0 + 1, g.s0 + g.len - 1, () => sd * (T.LANE_HALF + T.TRACK_EDGE + 1.0), 0, 0.22, 1, 0.5), blueBarrier, { cast: true, receive: true }));
  }

  // ---------------- start / finish
  const checkTex = canvasTex(64, 64, (g) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 8, y * 8, 8, 8); }
  });
  checkTex.repeat.set(1, 4);
  const fs = T.FINISH_S;
  root.add(mesh(ribbon(fs - 0.2, fs + 0.2, () => -T.LANE_HALF - T.TRACK_EDGE, () => T.LANE_HALF + T.TRACK_EDGE, 0.0245, 0.4, 1 / 0.4), std(0xffffff, 0.6, 0, { map: checkTex, side })));
  // grid boxes
  for (const prog of [-1.3, -3.9]) for (const sd of [-1, 1]) {
    const s = fs + prog;
    const gm = std(0xf0f0f0, 0.6, 0, { side });
    root.add(mesh(ribbon(s - 0.05, s + 0.05, () => sd * T.LANE_HALF - 0.38, () => sd * T.LANE_HALF + 0.38, 0.0245, 0.1), gm));
  }
  // gantry
  const startLights: THREE.MeshStandardMaterial[] = [];
  {
    const gp = T.point(fs, 0);
    const gant = new THREE.Group(); gant.position.set(gp.x, 0, -gp.y); gant.rotation.y = gp.h;
    const postM = std(0x30343a, 0.4, 0.6);
    for (const z of [-2.1, 1.6]) {
      const post = mesh(new THREE.BoxGeometry(0.16, 2.4, 0.16), postM, { cast: true, receive: true }); post.position.set(0, 1.2, z); gant.add(post);
    }
    const beam = mesh(new THREE.BoxGeometry(0.3, 0.42, 3.9), std(0x1a1d22, 0.4, 0.3), { cast: true, receive: true }); beam.position.set(0, 2.3, -0.25); gant.add(beam);
    for (let i = 0; i < 5; i++) {
      const lm = std(0x330000, 0.3, 0, { emissive: 0x000000 });
      startLights.push(lm);
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), lm); l.position.set(0, 2.55, -1.05 + i * 0.4); gant.add(l);
    }
    root.add(gant);
  }

  // ---------------- pit lane
  const pitSurf = std(0x24252a, 0.65, 0.0, { side });
  const ps0 = T.PIT_IN0 - 0.2, ps1 = T.PIT_OUT1 + 0.2;
  root.add(mesh(ribbon(ps0, ps1, (s) => T.pitD(s) - 0.6, (s) => T.pitD(s) + 0.6, 0.0185, 0.2), pitSurf));
  slotAndRails(T.PIT_IN0, T.PIT_OUT1, (s) => T.pitD(s), 0.15);
  // pit lane speed-limit stripes at entry/exit
  for (const s of [T.PIT_IN1 + 0.3, T.PIT_OUT0 - 0.3]) {
    root.add(mesh(ribbon(s - 0.06, s + 0.06, () => T.PIT_D - 0.6, () => T.PIT_D + 0.6, 0.024, 0.12), white));
  }
  // pit entry chevrons (cyan) on the outside lane approaching pit entry
  const cyan = std(0x22d3ee, 0.5, 0, { side, emissive: 0x0a4a55 });
  for (let s = T.PIT_IN0 - 6; s < T.PIT_IN0; s += 1.5) {
    root.add(mesh(ribbon(s, s + 0.7, () => -T.LANE_HALF - T.TRACK_EDGE + 0.12, () => -T.LANE_HALF - T.TRACK_EDGE + 0.04, 0.024, 0.35), cyan));
  }
  // service bays
  const bayGlow: THREE.MeshBasicMaterial[] = [];
  const teamCols = [0xffcc1a, 0xe8322a, 0x2a6df0, 0x22b04b];
  for (let j = 0; j < T.BAYS.length; j++) {
    const bs = T.BAYS[j];
    root.add(mesh(ribbon(bs - T.BAY_HALF, bs + T.BAY_HALF, () => T.BAY_D - 0.6, () => T.PIT_D - 0.6, 0.0188, 0.3), std(0x4a4d55, 0.6, 0, { side })));
    const tc = std(teamCols[j], 0.5, 0, { side });
    for (const e of [-1, 1]) root.add(mesh(ribbon(bs + e * T.BAY_HALF - 0.05, bs + e * T.BAY_HALF + 0.05, () => T.BAY_D - 0.6, () => T.PIT_D + 0.6, 0.0245, 0.1), tc));
    // bay spur slot
    slotAndRails(bs - 1.2, bs, (s) => T.PIT_D + (T.BAY_D - T.PIT_D) * T.smooth((s - (bs - 1.2)) / 1.2), 0.1);
    const gm = new THREE.MeshBasicMaterial({ color: 0x3cff8a, transparent: true, opacity: 0, side, depthWrite: false });
    bayGlow.push(gm);
    root.add(mesh(ribbon(bs - T.BAY_HALF + 0.08, bs + T.BAY_HALF - 0.08, () => T.BAY_D - 0.52, () => T.PIT_D - 0.5, 0.0255, 0.3), gm, { cast: false, receive: false }));
    // fuel rig + crew
    const rp = T.point(bs + 0.6, T.BAY_D - 1.0);
    const rig = mesh(new THREE.BoxGeometry(0.25, 0.5, 0.25), std(0xd62828, 0.4, 0.2), { cast: true, receive: true });
    rig.position.set(rp.x, 0.25, -rp.y); root.add(rig);
    const hose = mesh(new THREE.TorusGeometry(0.18, 0.025, 6, 16, Math.PI), std(0x111111, 0.6), { cast: true, receive: false });
    hose.position.set(rp.x, 0.5, -rp.y); hose.rotation.y = rp.h; root.add(hose);
    for (const off of [-0.5, 0.25]) {
      const cp = T.point(bs + off, T.BAY_D - 0.95);
      root.add(crewFigure(teamCols[j], cp.x, cp.y));
    }
  }
  // pit wall
  const pitWallTex = canvasTex(128, 32, (g) => { g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 128, 32); g.fillStyle = '#2a6df0'; g.fillRect(0, 22, 128, 6); });
  const pwm = std(0xffffff, 0.7, 0, { map: pitWallTex, side });
  root.add(mesh(wall(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.62, 0, 0.32, 1, 0.25), pwm, { cast: true, receive: true }));
  root.add(mesh(wall(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.78, 0, 0.32, 1, 0.25), pwm, { cast: true, receive: true }));
  root.add(mesh(ribbon(T.PIT_IN1 + 0.4, T.PIT_OUT0 - 0.4, () => -1.78, () => -1.62, 0.32, 1), std(0xbfbfbf, 0.7, 0, { side })));
  // garage building
  {
    const s0 = T.BAYS[0] - 2.2, s1 = T.BAYS[3] + 2.2;
    const mid = (s0 + s1) / 2, len = s1 - s0;
    const p = T.point(mid, T.BAY_D - 2.3);
    const gr = new THREE.Group(); gr.position.set(p.x, 0, -p.y); gr.rotation.y = p.h;
    const body = mesh(new THREE.BoxGeometry(len, 1.5, 1.8), std(0xeeeeee, 0.6), { cast: true, receive: true }); body.position.set(0, 0.75, 0); gr.add(body);
    const roof = mesh(new THREE.BoxGeometry(len + 0.6, 0.12, 1.95), std(0x2b2f36, 0.5, 0.2), { cast: true, receive: true }); roof.position.set(0, 1.56, 0); gr.add(roof);
    const stripe = mesh(new THREE.BoxGeometry(len + 0.62, 0.14, 0.04), std(0xd42a22, 0.5)); stripe.position.set(0, 1.56, -0.99); gr.add(stripe);
    for (let j = 0; j < 4; j++) {
      const door = mesh(new THREE.BoxGeometry(2.2, 1.0, 0.04), std(0x15171b, 0.6)); door.position.set(T.BAYS[j] - mid, 0.52, -0.92); gr.add(door);
      const band = mesh(new THREE.BoxGeometry(2.2, 0.12, 0.05), std(teamCols[j], 0.5)); band.position.set(T.BAYS[j] - mid, 1.12, -0.93); gr.add(band);
    }
    // rooftop hospitality boxes
    const hb = mesh(new THREE.BoxGeometry(len * 0.6, 0.7, 1.2), std(0x9fb7d9, 0.2, 0.4), { cast: true, receive: true }); hb.position.set(0, 1.97, 0.1); gr.add(hb);
    root.add(gr);
  }

  // ---------------- grandstands
  const crowd: THREE.InstancedMesh[] = [];
  const stand = (s0: number, s1: number, d0: number, sd: number, rows: number, roofCol: number): void => {
    const mid = (s0 + s1) / 2, len = s1 - s0;
    const p = T.point(mid, d0);
    const gr = new THREE.Group(); gr.position.set(p.x, 0, -p.y); gr.rotation.y = p.h;
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
      const step = mesh(new THREE.BoxGeometry(len, stepH * (r + 1), stepD), r % 2 ? seatM : seatM2, { cast: true, receive: true });
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
    const back = mesh(new THREE.BoxGeometry(len, backH, 0.1), std(0x3b4048, 0.6), { cast: true, receive: true }); back.position.set(0, backH / 2, away * (depth + 0.05)); gr.add(back);
    const roof = mesh(new THREE.BoxGeometry(len + 0.4, 0.08, depth * 0.38), std(roofCol, 0.5, 0.1), { cast: true, receive: true });
    roof.position.set(0, backH, away * (depth * 0.82)); gr.add(roof);
    const roofEdge = mesh(new THREE.BoxGeometry(len + 0.42, 0.1, 0.08), std(0xffffff, 0.5)); roofEdge.position.set(0, backH, away * (depth * 0.63)); gr.add(roofEdge);
    for (let x = -len / 2; x <= len / 2 + 0.01; x += len / 4) {
      const post = mesh(new THREE.CylinderGeometry(0.04, 0.04, backH, 6), std(0xcccccc, 0.3, 0.7), { cast: true, receive: false });
      post.position.set(x, backH / 2, away * 0.02); gr.add(post);
    }
    root.add(gr);
  };
  stand(6, 31, 3.0, 1, 6, 0xd42a22);                         // main grandstand, infield of main straight
  stand(T.SEGS[2].s0 + 6, T.SEGS[2].s0 + 22, -3.4, -1, 5, 0x2a6df0); // outside north straight
  stand(T.SEGS[6].s0 + 22, T.SEGS[6].s0 + 36, 3.4, 1, 5, 0x22b04b); // north of back straight

  // ---------------- scenery: trees, tyre stacks, ad boards
  const pts: { x: number; y: number }[] = [];
  for (let s = 0; s < L; s += 1) { const c = T.center(s); pts.push({ x: c.x, y: c.y }); }
  const nearTrack = (x: number, y: number, r: number): boolean => pts.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < r * r);
  const blocked: { x: number; y: number; r: number }[] = [];
  const addBlock = (s: number, d: number, r: number): void => { const p = T.point(s, d); blocked.push({ x: p.x, y: p.y, r }); };
  for (let s = 6; s <= 31; s += 3) { addBlock(s, 5, 3.4); addBlock(s, -5.5, 3.4); }
  for (let s = T.SEGS[2].s0 + 4; s <= T.SEGS[2].s0 + 24; s += 3) addBlock(s, -5.5, 3);
  for (let s = T.SEGS[6].s0 + 20; s <= T.SEGS[6].s0 + 38; s += 3) addBlock(s, 5.5, 3);
  const isBlocked = (x: number, y: number): boolean => blocked.some((b) => (b.x - x) ** 2 + (b.y - y) ** 2 < b.r * b.r);

  const treePos: { x: number; y: number; s: number }[] = [];
  let tries = 0;
  while (treePos.length < 200 && tries++ < 8000) {
    const x = B.mnx - 13 + Math.random() * (B.w + 26), y = B.mny - 13 + Math.random() * (B.h + 26);
    if (nearTrack(x, y, 4.2) || isBlocked(x, y)) continue;
    if (treePos.some((t) => (t.x - x) ** 2 + (t.y - y) ** 2 < 2.2)) continue;
    treePos.push({ x, y, s: 0.7 + Math.random() * 0.8 });
  }
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
  treePos.forEach((t, i) => {
    dm.position.set(t.x, 0, -t.y); dm.scale.setScalar(t.s); dm.rotation.set(0, Math.random() * 6, 0); dm.updateMatrix();
    trunks.setMatrixAt(i, dm.matrix);
    if (Math.random() < 0.5) {
      pines.setMatrixAt(np, dm.matrix); pines2.setMatrixAt(np, dm.matrix);
      cc.setHSL(0.3 + Math.random() * 0.06, 0.55, 0.12 + Math.random() * 0.06);
      pines.setColorAt(np, cc); pines2.setColorAt(np, cc); np++;
    } else {
      balls.setMatrixAt(nb, dm.matrix);
      cc.setHSL(0.27 + Math.random() * 0.08, 0.6, 0.1 + Math.random() * 0.06); balls.setColorAt(nb, cc); nb++;
    }
  });
  pines.count = np; pines2.count = np; balls.count = nb;
  for (const im of [trunks, pines, pines2, balls]) { im.castShadow = true; im.receiveShadow = true; root.add(im); }

  // tyre stacks outside tight corners
  const tyreG = new THREE.TorusGeometry(0.17, 0.08, 6, 12); tyreG.rotateX(Math.PI / 2);
  const tyreSpots: { x: number; y: number }[] = [];
  for (const si of [3, 5, 10, 12, 13]) {
    const g = T.SEGS[si];
    for (let s = g.s0 + 0.5; s < g.s0 + g.len; s += 0.75) {
      const out = -g.sign;
      const p = T.point(s, out * (T.trackHalf(s) + 1.75));
      tyreSpots.push(p);
    }
  }
  const tyres = new THREE.InstancedMesh(tyreG, std(0xffffff, 0.8), tyreSpots.length * 3);
  let ti = 0;
  tyreSpots.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      dm.position.set(p.x, 0.08 + k * 0.15, -p.y); dm.scale.setScalar(1); dm.rotation.set(0, 0, 0); dm.updateMatrix();
      tyres.setMatrixAt(ti, dm.matrix);
      tyres.setColorAt(ti, cc.setHex(k === 1 ? (i % 2 ? 0xd42a22 : 0xf0f0f0) : 0x181818)); ti++;
    }
  });
  tyres.castShadow = true; root.add(tyres);

  // ad boards along the back straight & north straight
  const adCols = [0xd42a22, 0x1f4fbf, 0xffcc1a, 0x111111, 0x22b04b];
  const ad = (s: number, d: number, i: number): void => {
    const p = T.point(s, d);
    const b = new THREE.Group(); b.position.set(p.x, 0, -p.y); b.rotation.y = p.h;
    const panel = mesh(new THREE.BoxGeometry(2.2, 0.45, 0.06), std(adCols[i % adCols.length], 0.5), { cast: true, receive: true }); panel.position.y = 0.3; b.add(panel);
    const stripe = mesh(new THREE.BoxGeometry(1.4, 0.1, 0.065), std(0xffffff, 0.5)); stripe.position.set(-0.2 + (i % 3) * 0.2, 0.3, 0); b.add(stripe);
    root.add(b);
  };
  let ai = 0;
  for (let s = T.SEGS[6].s0 + 2; s < T.SEGS[6].s0 + 20; s += 2.6) ad(s, -2.7, ai++);
  for (let s = T.SEGS[2].s0 + 25; s < T.SEGS[2].s0 + 46; s += 2.6) ad(s, -2.7, ai++);
  for (let s = 33; s < T.MAIN_LEN - 2; s += 2.6) ad(s, -2.7, ai++);

  // marshal posts with flags near the squeeze and hairpin
  for (const [s, d] of [[T.SQ_Q1 + 3, 3.2], [T.SQ_Q2 - 2, 3.2], [T.SEGS[3].s0 + 6, 6.6], [T.SEGS[12].s0 + 3, -3.6]] as [number, number][]) {
    const p = T.point(s, d);
    const hut = mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), std(0xf5f5f5, 0.6), { cast: true, receive: true }); hut.position.set(p.x, 0.25, -p.y); root.add(hut);
    const pole = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5), std(0x999999, 0.4, 0.6)); pole.position.set(p.x + 0.35, 0.45, -p.y); root.add(pole);
    const flag = mesh(new THREE.PlaneGeometry(0.3, 0.2), std(0xffcc00, 0.6, 0, { side })); flag.position.set(p.x + 0.5, 0.78, -p.y); root.add(flag);
  }

  return { root, startLights, bayGlow, crowd };
}

function crewFigure(color: number, x: number, y: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 8), std(color, 0.6));
  body.position.y = 0.2; body.castShadow = true; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), std(0xf2f2f2, 0.4));
  head.position.y = 0.42; head.castShadow = true; g.add(head);
  g.position.set(x, 0, -y);
  return g;
}

/** flat arrow following a lateral path along the track */
export function arrowGeometry(s0: number, s1: number, d: (s: number) => number, width = 0.16): THREE.BufferGeometry {
  const shaftEnd = s1 - 0.6;
  const body = ribbon(s0, shaftEnd, (s) => d(s) - width / 2, (s) => d(s) + width / 2, 0.03, 0.15);
  const tip = T.point(s1, d(s1));
  const bl = T.point(shaftEnd, d(shaftEnd) - width * 1.9), br = T.point(shaftEnd, d(shaftEnd) + width * 1.9);
  const head = new THREE.BufferGeometry();
  head.setAttribute('position', new THREE.Float32BufferAttribute([bl.x, 0.03, -bl.y, br.x, 0.03, -br.y, tip.x, 0.03, -tip.y], 3));
  head.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  head.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
  head.setIndex([0, 1, 2]);
  const g = mergeSimple([body, head]);
  return g;
}

function mergeSimple(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
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
