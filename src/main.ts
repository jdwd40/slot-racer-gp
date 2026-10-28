import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as T from './track';
import { Race, LAPS, RaceEvent } from './race';
import { buildWorld, disposeWorld, arrowGeometry, World } from './world';
import { Y0 } from './gfx';
import { makeCar, CarVisual } from './carModel';
import { Hud, fmt, carLabel } from './hud';
import { Sfx } from './audio';
import { t, onLangChange } from './i18n';

interface TesanaLike { gameplay: { levelStart: (o: object) => boolean; death: (o: object) => boolean; levelComplete: (o: object) => boolean; }; track: (n: string, o: object) => boolean; }
const tesana = (): TesanaLike | undefined => (window as unknown as { Tesana?: TesanaLike }).Tesana;
const TRACK_KEY = 'srgp.track';
function savedTrack(): string {
  try { return localStorage.getItem(TRACK_KEY) ?? T.TRACKS[0].id; } catch { return T.TRACKS[0].id; }
}
T.setTrack(savedTrack());
const levelId = (): string => T.DEF.id;
const levelIndex = (): number => T.TRACKS.indexOf(T.DEF);

// ------------------------------------------------------------ renderer / scene
const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2420);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.5, 600);
scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x4d6b3a, 0.7));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

let world: World = buildWorld();
scene.add(world.root);

// ------------------------------------------------------------ cars
let race = new Race();
const visuals: CarVisual[] = race.cars.map((c, i) => {
  const v = makeCar(c.color, [7, 11, 3, 24][i], c.isPlayer);
  scene.add(v.group);
  return v;
});

// lane-change / pit arrows
const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
const laneArrow = new THREE.Mesh(new THREE.BufferGeometry(), arrowMat);
laneArrow.visible = false; laneArrow.renderOrder = 5; scene.add(laneArrow);
let laneArrowKey = '';
const pitArrowMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
const pitArrowGeo = (): THREE.BufferGeometry => arrowGeometry(T.PIT_IN0 - 3.5, T.PIT_IN1 + 1.5, (s) => (s < T.PIT_IN0 ? -T.LANE_HALF : T.pitD(s)), 0.2);
const pitArrow = new THREE.Mesh(pitArrowGeo(), pitArrowMat);
pitArrow.visible = false; pitArrow.renderOrder = 5; scene.add(pitArrow);

// x-ray marker: a ring drawn through the deck while the player is beneath a bridge
const underRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 36), new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
underRing.rotation.x = -Math.PI / 2; underRing.renderOrder = 20; underRing.visible = false; scene.add(underRing);
let bridgeFade = 1;
/** true while the player's car is on the lower level of a crossing */
function playerUnderBridge(): boolean {
  const p = race.player;
  return T.CROSSINGS.some((c) => p.z < c.zHi - 1 && (c.x - p.x) ** 2 + (c.y - p.y) ** 2 < 4.2 * 4.2);
}

// ------------------------------------------------------------ HUD / overlays
const hud = new Hud(app);
const sfx = new Sfx();
const overlay = document.createElement('div');
overlay.className = 'overlay';
app.appendChild(overlay);

type Screen = 'title' | 'race' | 'pause' | 'results';
let screen: Screen = 'title';

function controlsHtml(): string {
  const row = (k: string, id: string): string => `<div class="krow"><span class="keys">${k}</span><span>${t(id)}</span></div>`;
  return `<div class="controls">
    ${row('<kbd>W</kbd><kbd>↑</kbd>', 'ctl.throttle')}
    ${row('<kbd>S</kbd><kbd>↓</kbd>', 'ctl.brake')}
    ${row('<kbd>Space</kbd>', 'ctl.lane')}
    ${row('<kbd>P</kbd>', 'ctl.pit')}
    ${row('<kbd>C</kbd>', 'ctl.view')}
    ${row('<kbd>+</kbd><kbd>−</kbd> / 🖱', 'ctl.zoom')}
    ${row('<kbd>Esc</kbd>', 'ctl.pause')}
    ${row('<kbd>R</kbd>', 'ctl.restart')}
  </div>`;
}

/** Small SVG map of a circuit for the track picker. */
function trackSvg(def: T.TrackDef): string {
  const lay = T.layout(def, 1);
  const W = 150, H = 96, pad = 10;
  const sc = Math.min((W - pad * 2) / lay.bounds.w, (H - pad * 2) / lay.bounds.h);
  const px = (p: { x: number; y: number }): string => `${(W / 2 + (p.x - lay.bounds.cx) * sc).toFixed(1)},${(H / 2 - (p.y - lay.bounds.cy) * sc).toFixed(1)}`;
  const d = lay.pts.map((p, i) => (i ? 'L' : 'M') + px(p)).join('') + 'Z';
  // raised stretches (bridges) drawn on top so the crossing reads correctly
  let bridges = '';
  let run: string[] = [];
  const flush = (): void => { if (run.length > 1) bridges += `<path d="M${run.join('L')}" fill="none" stroke="#1b1e24" stroke-width="9" stroke-linecap="round"/><path d="M${run.join('L')}" fill="none" stroke="#8b94a3" stroke-width="5" stroke-linecap="round"/>`; run = []; };
  for (const p of lay.pts) { if (p.z > 0.05) run.push(px(p)); else flush(); }
  flush();
  const fin = px({ x: T.FINISH_S, y: 0 });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <path d="${d}" fill="none" stroke="#5b6270" stroke-width="7" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#2a2e36" stroke-width="4" stroke-linejoin="round"/>
    ${bridges}
    <circle cx="${fin.split(',')[0]}" cy="${fin.split(',')[1]}" r="3" fill="#fff"/>
  </svg>`;
}

/** Switch the active circuit: rebuild the world, arrows, minimap and a fresh race. */
function applyTrack(id: string): void {
  if (T.DEF.id === id && world) return;
  T.setTrack(id);
  try { localStorage.setItem(TRACK_KEY, id); } catch { /* ignore */ }
  disposeWorld(world);
  world = buildWorld();
  scene.add(world.root);
  pitArrow.geometry.dispose();
  pitArrow.geometry = pitArrowGeo();
  laneArrow.visible = false; laneArrowKey = '';
  hud.rebuildMini();
  race = new Race();
  camTarget.set(T.BOUNDS.cx, 0, -T.BOUNDS.cy - 2);
  curSpan = fullSpan();
}

function showTitle(): void {
  screen = 'title';
  camMode = 'full';
  overlay.className = 'overlay show';
  const cards = T.TRACKS.map((d) => `<button class="track ${d.id === T.DEF.id ? 'sel' : ''}" data-id="${d.id}">
      ${trackSvg(d)}
      <b>${t(`track.${d.id}.name`)}</b>
      <small>${t(`track.${d.id}.desc`)}</small>
      <em>${t('title.len', { n: Math.round(T.layout(d, 4).L) })}</em>
    </button>`).join('');
  overlay.innerHTML = `<div class="card title">
    <div class="logo">${t('title.name')}</div>
    <div class="tag">${t('title.tag')}</div>
    <p>${t('title.goal', { n: LAPS })}</p>
    <div class="lbl2">${t('title.track')}</div>
    <div class="tracks">${cards}</div>
    ${controlsHtml()}
    <button class="cta" id="o-start">${t('title.start')}</button>
  </div>`;
  overlay.querySelectorAll<HTMLElement>('.track').forEach((b) => b.addEventListener('click', () => {
    sfx.init();
    applyTrack(b.dataset.id!);
    overlay.querySelectorAll('.track').forEach((x) => x.classList.toggle('sel', x === b));
  }));
  overlay.querySelector('#o-start')!.addEventListener('click', () => { sfx.init(); startRace(); });
}

function showPause(): void {
  screen = 'pause';
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card">
    <h2>${t('pause.title')}</h2>
    ${controlsHtml()}
    <div class="row"><button class="cta" id="o-resume">${t('pause.resume')}</button><button class="cta alt" id="o-restart">${t('pause.restart')}</button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-resume')!.addEventListener('click', resume);
  overlay.querySelector('#o-restart')!.addEventListener('click', startRace);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

function resume(): void { screen = 'race'; overlay.className = 'overlay'; overlay.innerHTML = ''; }

function showResults(): void {
  screen = 'results';
  const res = race.results();
  const pos = res.findIndex((r) => r.car.isPlayer) + 1;
  const winner = res[0].time;
  const rows = res.map((r, i) => `<tr class="${r.car.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:#${r.car.color.toString(16).padStart(6, '0')}"></i>${carLabel(r.car)}</td>
    <td class="mono">${i === 0 ? fmt(r.time) : '+' + (r.time - winner).toFixed(1) + 's'}${r.est ? ` <small>(${t('res.est')})</small>` : ''}</td>
    <td class="mono">${fmt(r.car.bestLap)}</td><td>${r.car.pitStops}</td></tr>`).join('');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results">
    <h2>${pos === 1 ? '🏆 ' + t('res.win') : t('res.title')}</h2>
    <div class="place">${t('res.youPlace', { n: pos })}</div>
    <table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row"><button class="cta" id="o-again">${t('res.again')} <small>(R)</small></button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-again')!.addEventListener('click', startRace);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
  tesana()?.track('race_finished', { position: pos, value: Math.round(race.player.finishTime * 10) / 10, track: levelId() });
}

/** Back to the title screen with a fresh grid on the current circuit. */
function toMenu(): void {
  race = new Race();
  laneArrowKey = '';
  showTitle();
}

function startRace(): void {
  race = new Race();
  laneArrowKey = '';
  camMode = 'follow';
  resume();
  tesana()?.gameplay.levelStart({ levelId: levelId(), levelIndex: levelIndex() });
  camLead.set(0, 0);
  const p = race.player;
  camTarget.set(p.x, 0, -p.y);
}

onLangChange(() => {
  hud.relabel();
  if (screen === 'title') showTitle(); else if (screen === 'pause') showPause(); else if (screen === 'results') showResults();
});

// ------------------------------------------------------------ input
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const k = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (e.repeat) { keys.add(k); return; }
  keys.add(k);
  sfx.init();
  if (screen === 'title') {
    if (k === 'Enter' || k === 'Space') startRace();
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(k);
    if (n >= 0 && n < T.TRACKS.length) { applyTrack(T.TRACKS[n].id); showTitle(); }
    return;
  }
  if (k === 'KeyR') { startRace(); return; }
  if (k === 'KeyC') toggleView();
  if (k === 'Equal' || k === 'NumpadAdd') zoomBy(0.8);
  if (k === 'Minus' || k === 'NumpadSubtract') zoomBy(1.25);
  if (k === 'KeyM') toggleSound();
  if (k === 'Escape') { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); return; }
  if (screen === 'pause' && k === 'Enter') { resume(); return; }
  if (screen === 'results' && k === 'Enter') { startRace(); return; }
  if (screen !== 'race') return;
  if (k === 'Space') race.requestLane();
  if (k === 'KeyP') race.requestPit();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); if (screen === 'race') showPause(); });
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });

hud.el['b-view'].addEventListener('click', () => { sfx.init(); toggleView(); });
hud.el['b-zin'].addEventListener('click', () => zoomBy(0.8));
hud.el['b-zout'].addEventListener('click', () => zoomBy(1.25));
hud.el['b-snd'].addEventListener('click', () => { sfx.init(); toggleSound(); });
hud.el['b-pause'].addEventListener('click', () => { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); });
function toggleSound(): void { sfx.setMuted(!sfx.muted); hud.el['b-snd'].textContent = sfx.muted ? '🔇' : '🔊'; }

// ------------------------------------------------------------ camera
let camMode: 'follow' | 'full' = 'full';
let followSpan = 20;
const camTarget = new THREE.Vector3();
const camLead = new THREE.Vector2();
let curSpan = 20;
const TILT = THREE.MathUtils.degToRad(13);
function fullSpan(): number {
  const aspect = window.innerWidth / window.innerHeight;
  return Math.max(T.BOUNDS.h + 11, (T.BOUNDS.w + 13) / aspect);
}
function toggleView(): void { camMode = camMode === 'follow' ? 'full' : 'follow'; }
function zoomBy(f: number): void {
  if (camMode === 'full') { camMode = 'follow'; }
  followSpan = THREE.MathUtils.clamp(followSpan * f, 10, 70);
}
let shadowSpan = 0;
function updateCamera(dt: number): void {
  const p = race.player;
  const desired = new THREE.Vector3();
  let span: number;
  if (camMode === 'follow') {
    const lead = Math.min(followSpan * 0.28, p.v * 0.3);
    const lx = Math.cos(p.h) * lead, ly = Math.sin(p.h) * lead;
    const kl = 1 - Math.exp(-2.2 * dt);
    camLead.x += (lx - camLead.x) * kl; camLead.y += (ly - camLead.y) * kl;
    desired.set(p.x + camLead.x, 0, -(p.y + camLead.y));
    span = followSpan;
  } else {
    desired.set(T.BOUNDS.cx, 0, -T.BOUNDS.cy - 2);
    span = fullSpan();
  }
  const k = 1 - Math.exp(-(camMode === 'follow' ? 7 : 3) * dt);
  camTarget.lerp(desired, k);
  curSpan += (span - curSpan) * (1 - Math.exp(-4 * dt));
  const dist = curSpan / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(camTarget.x, Math.cos(TILT) * dist, camTarget.z + Math.sin(TILT) * dist);
  camera.lookAt(camTarget);
  // shadows follow the view
  const aspect = window.innerWidth / window.innerHeight;
  const sh = curSpan * Math.max(1, aspect) * 0.62 + 4;
  if (Math.abs(sh - shadowSpan) > shadowSpan * 0.08) {
    shadowSpan = sh;
    const c = sun.shadow.camera;
    c.left = -sh; c.right = sh; c.top = sh; c.bottom = -sh; c.near = 1; c.far = 160;
    c.updateProjectionMatrix();
  }
  sun.position.set(camTarget.x - 22, 45, camTarget.z + 14);
  sun.target.position.copy(camTarget);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------ events
function handle(e: RaceEvent): void {
  const p = race.player;
  switch (e.type) {
    case 'msg':
      hud.toast(t(e.text, e.vars), e.kind);
      if (e.kind === 'bad') sfx.bad(); else if (e.kind === 'good') sfx.good(); else sfx.beep();
      break;
    case 'light': if (e.n > 0) sfx.light(); break;
    case 'go': sfx.go(); hud.goFlash(t('msg.go')); break;
    case 'bump': if (e.car.isPlayer || dist2(e.car) < 400) sfx.bump(e.power); break;
    case 'deslot':
      if (e.car.isPlayer || dist2(e.car) < 600) sfx.crash();
      if (e.car.isPlayer) tesana()?.gameplay.death({ levelId: levelId(), x: e.car.x, y: e.car.y, name: 'deslot' });
      break;
    case 'switch': if (e.car.isPlayer || dist2(e.car) < 200) sfx.click(); break;
    case 'tow': if (e.car.isPlayer) tesana()?.gameplay.death({ levelId: levelId(), x: e.car.x, y: e.car.y, name: 'out_of_fuel' }); break;
    case 'lap':
      if (e.car === p && e.best && p.lapsDone > 1 && !p.finished) hud.toast(t('msg.bestLap', { time: fmt(e.time) }), 'good');
      break;
    case 'finish':
      if (e.car === p) { sfx.fanfare(); hud.goFlash(`P${e.pos}`); tesana()?.gameplay.levelComplete({ levelId: levelId() }); }
      break;
  }
}
function dist2(c: { x: number; y: number }): number { const dx = c.x - camTarget.x, dy = -c.y - camTarget.z; return dx * dx + dy * dy; }

// ------------------------------------------------------------ visuals sync
function syncCars(dt: number, time: number): void {
  race.cars.forEach((c, i) => {
    const v = visuals[i];
    v.group.position.set(c.x, c.z, -c.y);
    v.group.rotation.set(c.roll, c.h, c.pitch, 'YXZ');
    // body roll from wobble / crash tumble
    if (c.mode === 'off' && c.off) {
      v.body.rotation.x = Math.sin(c.off.t * 9) * 0.25 * Math.max(0, 1 - c.off.t);
      v.body.rotation.z = Math.sin(c.off.t * 7) * 0.15 * Math.max(0, 1 - c.off.t);
    } else {
      v.body.rotation.x = c.wobble * Math.sin(time * 31 + i) * 0.12;
      v.body.rotation.z = -Math.min(0.06, c.v * 0.004) * (c.throttle - c.brake * 0.6);
    }
    for (const w of v.wheels) w.rotation.z -= (c.v * dt) / 0.12;
    const blink = c.mode === 'tow' ? Math.floor(time * 8) % 2 === 0 && c.towT < 0.9 : c.recoverT > 0 ? Math.floor(time * 12) % 2 === 0 : true;
    v.group.visible = blink;
    v.ring.visible = c.isPlayer && (camMode === 'full' || curSpan > 34);
    if (v.ring.visible) { const sc = 1 + Math.sin(time * 5) * 0.12; v.ring.scale.setScalar(sc * Math.max(1, curSpan / 40)); }
  });
  // bridge decks turn translucent while the player drives beneath them
  const under = playerUnderBridge();
  const target = under ? 0.28 : 1;
  bridgeFade += (target - bridgeFade) * Math.min(1, dt * 8);
  for (const m of world.bridgeMats) m.opacity = bridgeFade;
  const p = race.player;
  underRing.visible = bridgeFade < 0.97 && p.mode !== 'off';
  if (underRing.visible) {
    underRing.position.set(p.x, p.z + Y0 + 0.05, -p.y);
    (underRing.material as THREE.MeshBasicMaterial).opacity = (1 - bridgeFade) * (0.6 + Math.sin(time * 6) * 0.25);
  }
}

function syncArrows(time: number): void {
  const p = race.player;
  // lane change arrow
  if (p.laneReq || p.change) {
    const sw = p.change ? { s0: p.change.s0, s1: p.change.s1 } : race.nextSwitch(p);
    const from = p.change ? p.change.from : Math.sign(p.laneSide) || 1;
    const to = -from;
    const key = `${sw.s0}:${from}`;
    if (key !== laneArrowKey) {
      laneArrowKey = key;
      laneArrow.geometry.dispose();
      const len = sw.s1 - sw.s0;
      laneArrow.geometry = arrowGeometry(sw.s0 - 2.5, sw.s1 + 1.2, (s) => T.LANE_HALF * (from + (to - from) * T.smooth((s - sw.s0) / len)), 0.16);
    }
    laneArrow.visible = true;
    arrowMat.opacity = p.change ? 0.35 : 0.55 + Math.sin(time * 8) * 0.3;
  } else laneArrow.visible = false;
  pitArrow.visible = p.pitReq;
  pitArrowMat.opacity = 0.55 + Math.sin(time * 8) * 0.3;
  pitArrowMat.color.setHex(p.laneSide < 0 || (p.change && p.change.to < 0) ? 0x22d3ee : 0xff6b6b);
  // service bay glow when the player is in the pit lane
  const inPit = p.mode === 'pitlane' || p.mode === 'bayIn' || p.mode === 'service';
  world.bayGlow.forEach((m, j) => {
    const free = race.bayFree(j, p);
    const mine = (p.mode === 'service' || p.mode === 'bayIn') && p.bay === j;
    m.color.setHex(mine ? 0x3cff8a : 0x7dd3fc);
    m.opacity = inPit && (free || mine) ? (mine ? 0.45 : 0.25 + Math.sin(time * 7) * 0.15) : 0;
  });
  // gantry lights
  world.startLights.forEach((m, i) => {
    const on = race.phase === 'countdown' && i < race.lights;
    m.emissive.setHex(on ? 0xff1a1a : 0x000000);
    m.emissiveIntensity = on ? 3 : 0;
    m.color.setHex(on ? 0xff3333 : 0x330000);
  });
}

function syncAudio(): void {
  if (!sfx.ctx) return;
  const playing = screen === 'race' || screen === 'results';
  race.cars.forEach((c, i) => {
    let vol = c.isPlayer ? 1 : Math.max(0, 1 - Math.sqrt(dist2(c)) / 28) * 0.55;
    if (!playing || c.mode === 'off' || c.mode === 'tow') vol = 0;
    sfx.motor(i, c.v, c.throttle, vol);
  });
  const p = race.player;
  let sq = playing && p.mode === 'race' ? Math.max(0, (p.latRatio - 0.75) / 0.25) : 0;
  if (p.mode === 'off' && p.off && p.off.t < 0.6) sq = 0.8;
  sfx.tyre(Math.min(1, sq));
  sfx.refuelling(playing && p.mode === 'service' && p.fuel < 1 && p.serviceT > 0.4);
}

// ------------------------------------------------------------ loop
let last = performance.now();
let time = 0;
showTitle();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; time += dt;
  if (screen === 'race' || screen === 'results') {
    race.update(dt, { up: keys.has('KeyW') || keys.has('ArrowUp'), down: keys.has('KeyS') || keys.has('ArrowDown') });
    for (const e of race.events) handle(e);
    race.events.length = 0;
    if (race.phase === 'done' && screen === 'race') showResults();
  } else if (screen === 'title') {
    // idle: slow orbit-free pan over the grid
  }
  updateCamera(dt);
  syncCars(dt, time);
  syncArrows(time);
  syncAudio();
  hud.root.style.display = screen === 'title' ? 'none' : '';
  hud.update(race, dt, time);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// debug/test hooks
(window as unknown as { __game: unknown }).__game = { get race() { return race; }, T, startRace, applyTrack, setView: (m: 'follow' | 'full') => { camMode = m; }, zoom: (span: number) => { camMode = 'follow'; followSpan = span; curSpan = span; }, snapCam: () => { const p = race.player; camLead.set(0, 0); camTarget.set(p.x, 0, -p.y); }, info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, objects: world.root.children.length }) };
