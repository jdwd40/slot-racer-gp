import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as T from './track';
import { Race, Car, LAPS, RaceEvent, DRIVERS, PERSONAS, PEN, DEF, SOLO_ID, DriverId, RosterEntry } from './race';
import { buildWorld, disposeWorld, arrowGeometry, BayPaint, World } from './world';
import { Y0 } from './gfx';
import { makeCar, makePlayerMarker, CarVisual } from './carModel';
import { Hud, fmt, carLabel, flags } from './hud';
import { Sfx } from './audio';
import { t } from './i18n';
import * as R from './records';
import { GhostRecorder, GhostPlayer } from './ghost';
import { FixedStepper, STEP, MAX_GAP, Pose, blendPose } from './timing';
import { PRESETS, PresetId, pixelRatioFor, savedPreset, savePreset } from './graphics';
import { COARSE_QUERY, ControlsAnchor, DrivingInput, KEY_HOLDS, KEY_TAPS, PadButton, TOUCH_MODES, TouchMode, TouchPad, savedTouchMode, saveTouchMode, touchActive } from './input';

const TRACK_KEY = 'srgp.track';
function savedTrack(): string {
  try { return localStorage.getItem(TRACK_KEY) ?? T.TRACKS[0].id; } catch { return T.TRACKS[0].id; }
}
T.setTrack(savedTrack());

// ------------------------------------------------------------ renderer / scene
const app = document.getElementById('app')!;
/** The game's box: the canvas, HUD and menus all fill it, so they cannot drift apart. CSS sizes it to the dynamic viewport. */
const viewSize = (): { w: number; h: number } => ({ w: app.clientWidth || window.innerWidth, h: app.clientHeight || window.innerHeight });
let vp = viewSize();
/** Create the renderer, or show a readable message and stop if WebGL cannot initialise. */
function createRenderer(): THREE.WebGLRenderer {
  try {
    return new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    app.innerHTML = `<div class="fatal"><h1>${t('title.name')}</h1><p>${t('ui.noWebgl')}</p><p><small>${t('ui.noWebglHint')}</small></p></div>`;
    throw err;
  }
}
const renderer = createRenderer();
let preset = savedPreset();
let dpr = window.devicePixelRatio;
renderer.setPixelRatio(pixelRatioFor(preset, dpr));
renderer.setSize(vp.w, vp.h, false);
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

const camera = new THREE.PerspectiveCamera(38, vp.w / vp.h, 0.5, 600);
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
type Mode = 'race' | 'practice' | 'champ';
let mode: Mode = 'race';
let carId = R.savedCar();
/** The local driver: camera, marker, HUD, audio emphasis, personal messages, records and the ghost all follow this ID. */
const localId: DriverId = SOLO_ID;
/**
 * Grid slot of the local driver (diagnostics only, via __game.setLocalSlot). Championships always use slot 0, which their
 * saved results are keyed by. In another slot the local car takes that slot's grid place, number and bay, and the rival
 * from that slot moves to slot 0 with its name, colour and persona.
 */
let localSlot = 0;
function newRace(): Race {
  const practice = mode === 'practice';
  const slot = mode === 'champ' ? 0 : localSlot;
  const roster: RosterEntry[] = [{ id: localId, control: 'human', slot, name: DRIVERS[0].name, color: R.livery(carId).color }];
  if (practice) return new Race({ practice, roster: [{ ...roster[0], slot: 0 }], track: T.DEF.id });
  for (let k = 1; k < DRIVERS.length; k++) {
    const D = DRIVERS[k];
    roster.push({ id: `ai${k}`, control: 'ai', slot: k === slot ? 0 : k, name: D.name, color: D.color, persona: D.persona });
  }
  return new Race({ roster, track: T.DEF.id });
}
let race = newRace();
/** the local driver's car */
const me = (): Car => race.car(localId) ?? race.cars[0];
const isMe = (c: Car): boolean => c.id === localId;
const stepper = new FixedStepper();
const poseOf = ({ x, y, z, h, roll, pitch }: Car): Pose => ({ x, y, z, h, roll, pitch });
/** each car's placement before the latest simulation step; drawing blends from here to the live state */
let prevPoses = race.cars.map(poseOf);
let visuals: CarVisual[] = [];
function disposeVisual(v: CarVisual): void {
  v.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); } });
  v.group.removeFromParent();
}
/** (re)create car visuals for the cars of the current race */
function rebuildVisuals(): void {
  visuals.forEach(disposeVisual);
  visuals = race.cars.map((c) => { const v = makeCar(c.color, c.num, isMe(c)); scene.add(v.group); return v; });
  paintBays();
}
/** Bays are painted from the race's owners (Car.bayHome): the player's in the chosen livery, with its number and tag. */
let bayPaint: BayPaint[] = [];
function paintBays(): void {
  world.paintBays(bayPaint = T.BAYS.map((_, j) => {
    const o = race.bayOwner(j);
    const tag = (c: Car): string => (isMe(c) ? t('hud.you') : DRIVERS.find((d) => d.name === c.name)?.tag ?? c.name.slice(0, 5).toUpperCase());
    return o ? { color: o.color, num: o.num, tag: tag(o), mine: isMe(o) } : { color: 0, num: null, tag: '', mine: false };
  }));
}
rebuildVisuals();
function setRace(r: Race): void { race = r; laneArrowKey = ''; lastCrossed = 0; prevPoses = race.cars.map(poseOf); stepper.rebase(); rebuildVisuals(); }

// practice ghost + records
const recorder = new GhostRecorder();
const ghost = new GhostPlayer(scene);
let pbMs = 0;
let lastCrossed = 0;
let pendingLap: Extract<RaceEvent, { type: 'lap' }> | null = null;
const freshIds = new Set<string>();
let champ: R.Championship | null = R.loadChamp();
let champRoundSaved = false;

// lane-change / pit arrows
const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
const laneArrow = new THREE.Mesh(new THREE.BufferGeometry(), arrowMat);
laneArrow.visible = false; laneArrow.renderOrder = 5; scene.add(laneArrow);
let laneArrowKey = '';
const pitArrowMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
const pitArrowGeo = (): THREE.BufferGeometry => arrowGeometry(T.PIT_IN0 - 3.5, T.PIT_IN1 + 1.5, (s) => (s < T.PIT_IN0 ? -T.LANE_HALF : T.pitD(s)), 0.2);
const pitArrow = new THREE.Mesh(pitArrowGeo(), pitArrowMat);
pitArrow.visible = false; pitArrow.renderOrder = 5; scene.add(pitArrow);

// the player marker: shown in overview views and, through the deck, beneath a bridge.
// It sits outside the car's group so the tow and recovery blinks leave it steady, and it draws over everything so decks can't hide it.
const playerMarker = makePlayerMarker();
scene.add(playerMarker);
const MARKER_PX = 20;      // ring radius in CSS pixels once zoomed out, whatever the viewport or preset
const MARKER_MIN = 1.25;   // world units: never tighter than the car in close views
let markerFade = 0;
let bridgeFade = 1;
/** true while the player's car is on the lower level of a crossing */
function playerUnderBridge(): boolean {
  const p = me();
  return T.CROSSINGS.some((c) => p.z < c.zHi - 1 && (c.x - p.x) ** 2 + (c.y - p.y) ** 2 < 4.2 * 4.2);
}

// ------------------------------------------------------------ HUD / overlays
const hud = new Hud(app);
const sfx = new Sfx();
const overlay = document.createElement('div');
overlay.className = 'overlay';
app.appendChild(overlay);

type Screen = 'title' | 'race' | 'pause' | 'results' | 'boards' | 'champ';
let screen: Screen = 'title';
let lbTrack = T.DEF.id;
let lbKind: R.BoardKind = 'practice';
/** Every change of screen ends the current hold, including restarting into the same one: what is still down needs pressing again. */
function enter(s: Screen): void {
  screen = s;
  releaseDriving();
  hud.setMore(false);
  syncPad();
}

function controlsHtml(): string {
  const row = (k: string, id: string): string => `<div class="krow"><span class="keys">${k}</span><span>${t(id)}</span></div>`;
  return `<p class="touch-hint">${t('touch.hint')}</p><div class="controls">
    ${row('<kbd>W</kbd><kbd>↑</kbd>', 'ctl.throttle')}
    ${row('<kbd>S</kbd><kbd>↓</kbd>', 'ctl.brake')}
    ${row('<kbd>Space</kbd>', 'ctl.lane')}
    ${row('<kbd>P</kbd>', 'ctl.pit')}
    ${row('<kbd>N</kbd>', 'ctl.defer')}
    ${row('<kbd>C</kbd>', 'ctl.view')}
    ${row('<kbd>+</kbd><kbd>−</kbd> / 🖱', 'ctl.zoom')}
    ${row('<kbd>Esc</kbd>', 'ctl.pause')}
    ${row('<kbd>R</kbd>', 'ctl.restart')}
    ${row('<kbd>G</kbd>', 'ctl.ghost')}
  </div><p class="rules"><small>${t('ctl.rules')}</small></p>`;
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
  setRace(newRace());
  camTarget.set(T.BOUNDS.cx, 0, -T.BOUNDS.cy - 2);
  curSpan = fullSpan();
}

/** pre-race lineup: the three rivals and their driving styles */
function lineupHtml(): string {
  return `<div class="lineup">${DRIVERS.slice(1).map((d) => `<div class="rival">${colorDot(d.color)}<div><b>${d.name}</b><em>${t(`persona.${d.persona}.name`)}</em><small>${t(`persona.${d.persona}.desc`)}</small></div></div>`).join('')}</div>`;
}

function carPickerHtml(): string {
  return `<div class="cars">${R.LIVERIES.map((l) => `<button class="car ${l.id === carId ? 'sel' : ''}" data-car="${l.id}" title="${l.name}"><i style="background:#${l.color.toString(16).padStart(6, '0')}"></i>${l.name}</button>`).join('')}</div>`;
}

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
/** A settings radio group for the title and pause cards, named by the data attribute its buttons carry; wire it up with bindRadios. */
function radiosHtml(name: string, label: string, opts: readonly { id: string; label: string }[], current: string): string {
  const btns = opts.map((o) => {
    const on = o.id === current;
    return `<button class="tab ${on ? 'sel' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-${name}="${o.id}">${t(o.label)}</button>`;
  }).join('');
  return `<div class="gfx"><div class="lbl2" id="o-${name}">${t(label)}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div></div>`;
}

function bindRadios(name: string, choose: (id: string) => void): void {
  const btns = [...overlay.querySelectorAll<HTMLButtonElement>(`[data-${name}]`)];
  const pick = (b: HTMLButtonElement): void => {
    choose(b.dataset[name]!);
    btns.forEach((x) => {
      x.classList.toggle('sel', x === b);
      x.setAttribute('aria-checked', String(x === b));
      x.tabIndex = x === b ? 0 : -1;
    });
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => pick(b));
    b.addEventListener('keydown', (e) => {
      const step = ARROW_STEP[e.code];
      // these keys belong to the selector here, not to the game; everything else (Esc, R…) still reaches it
      if (step || e.code === 'Space' || e.code === 'Enter') e.stopPropagation();
      if (!step) return;
      e.preventDefault();
      const next = btns[(i + step + btns.length) % btns.length];
      pick(next);
      next.focus();
    });
  });
}

const TOUCH_OPTS = TOUCH_MODES.map((id) => ({ id, label: `touch.${id}` }));
function settingsHtml(): string {
  return radiosHtml('preset', 'gfx.label', PRESETS, preset) + radiosHtml('touch', 'touch.label', TOUCH_OPTS, touchMode);
}
function bindSettings(): void {
  bindRadios('preset', (id) => setPreset(id as PresetId));
  bindRadios('touch', (id) => setTouchMode(id as TouchMode));
}

function showTitle(): void {
  enter('title');
  camMode = 'full';
  mode = 'race';
  overlay.className = 'overlay show';
  const cards = T.TRACKS.map((d) => `<button class="track ${d.id === T.DEF.id ? 'sel' : ''}" data-id="${d.id}">
      ${trackSvg(d)}
      <b>${t(`track.${d.id}.name`)}</b>
      <small>${t(`track.${d.id}.desc`)}</small>
      <em>${t('title.len', { n: Math.round(T.layout(d, 4).L) })}</em>
    </button>`).join('');
  const nRounds = R.CHAMP_TRACKS.length;
  let champBtns = `<button class="cta alt" id="o-champ">${t('title.champ')}</button>`;
  if (champ && !R.champDone(champ)) champBtns = `<button class="cta alt" id="o-champ-cont">${t('title.champContinue', { n: champ.rounds.length + 1, m: nRounds })}</button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
  else if (champ) champBtns = `<button class="cta alt" id="o-champ-view">${t('title.champView')}</button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
  overlay.innerHTML = `<div class="card title">
    <div class="logo">${t('title.name')}</div>
    <div class="tag">${t('title.tag')}</div>
    <p>${t('title.goal', { n: LAPS })}</p>
    <div class="setup">
      <label class="ini"><span class="lbl2">${t('title.initials')}</span><input id="o-ini" maxlength="${R.MAX_INITIALS}" placeholder="${R.ANON}" value="${R.savedInitialsRaw().replace(/"/g, '')}" autocomplete="off" autocapitalize="characters" enterkeyhint="done" spellcheck="false"></label>
      <div><span class="lbl2">${t('title.car')}</span>${carPickerHtml()}</div>
      ${settingsHtml()}
    </div>
    <div class="lbl2">${t('title.rivals')}</div>
    ${lineupHtml()}
    <div class="lbl2">${t('title.track')}</div>
    <div class="tracks">${cards}</div>
    ${controlsHtml()}
    <div class="row wrap">
      <button class="cta" id="o-start">${t('title.start')}</button>
      <button class="cta alt" id="o-practice">${t('title.practice')}</button>
      ${champBtns}
      <button class="cta alt" id="o-boards">${t('title.boards')}</button>
    </div>
  </div>`;
  overlay.querySelectorAll<HTMLElement>('.track').forEach((b) => b.addEventListener('click', () => {
    sfx.init();
    applyTrack(b.dataset.id!);
    overlay.querySelectorAll('.track').forEach((x) => x.classList.toggle('sel', x === b));
  }));
  overlay.querySelectorAll<HTMLElement>('.car').forEach((b) => b.addEventListener('click', () => {
    carId = b.dataset.car!; R.saveCar(carId);
    overlay.querySelectorAll('.car').forEach((x) => x.classList.toggle('sel', x === b));
    setRace(newRace());
  }));
  bindSettings();
  const ini = overlay.querySelector<HTMLInputElement>('#o-ini')!;
  ini.addEventListener('input', () => R.saveInitialsRaw(ini.value));
  ini.addEventListener('keydown', (e) => { if (e.key === 'Enter') ini.blur(); e.stopPropagation(); });
  overlay.querySelector('#o-start')!.addEventListener('click', () => { sfx.init(); startSession('race'); });
  overlay.querySelector('#o-practice')!.addEventListener('click', () => { sfx.init(); startSession('practice'); });
  overlay.querySelector('#o-champ')!.addEventListener('click', () => { sfx.init(); champ = R.newChamp(carId, R.currentInitials()); startChampRound(); });
  overlay.querySelector('#o-champ-cont')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
  overlay.querySelector('#o-champ-view')?.addEventListener('click', () => { sfx.init(); showChamp(null); });
  overlay.querySelector('#o-boards')!.addEventListener('click', () => { sfx.init(); showBoards(); });
}

function showPause(): void {
  enter('pause');
  overlay.className = 'overlay show';
  const title = mode === 'practice' ? t('prac.title') : mode === 'champ' && champ ? t('champ.round', { n: champ.rounds.length + 1, m: R.CHAMP_TRACKS.length }) : t('pause.title');
  overlay.innerHTML = `<div class="card">
    <h2>${title}</h2>
    ${mode === 'practice' ? `<p>${t('prac.hint')}</p>` : ''}
    ${controlsHtml()}
    ${settingsHtml()}
    <div class="row"><button class="cta" id="o-resume">${t('pause.resume')}</button><button class="cta alt" id="o-restart">${t('pause.restart')}</button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  bindSettings();
  overlay.querySelector('#o-resume')!.addEventListener('click', resume);
  overlay.querySelector('#o-restart')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

function resume(): void { enter('race'); overlay.className = 'overlay'; overlay.innerHTML = ''; stepper.rebase(); }

function colorDot(c: number): string { return `<i style="background:#${c.toString(16).padStart(6, '0')}"></i>`; }

function showResults(): void {
  if (mode === 'champ') { recordChampRound(); showChamp(race); return; }
  enter('results');
  const res = race.results();
  const mine = me();
  const pos = res.findIndex((r) => isMe(r.car)) + 1;
  // classified rows only get a position and a time; DQ and DNF rows say so instead and never inherit a place
  const winner = res[0].status === 'finished' ? res[0].time : NaN;
  const timeCell = (r: (typeof res)[number], i: number): string => {
    if (r.status === 'dq') return `<td class="mono dq">${t('res.dq')}</td>`;
    if (r.status === 'dnf') return `<td class="mono">${t('res.dnf')}</td>`;
    return `<td class="mono">${i === 0 ? fmt(r.time) : '+' + (r.time - winner).toFixed(1) + 's'}${r.est ? ` <small>(${t('res.est')})</small>` : ''}</td>`;
  };
  const rows = res.map((r, i) => `<tr class="${isMe(r.car) ? 'me' : ''}"><td>${r.status === 'finished' ? i + 1 : '–'}</td><td>${colorDot(r.car.color)}${carLabel(r.car, localId)}</td>
    ${timeCell(r, i)}
    <td class="mono">${fmt(r.car.bestLap)}</td><td>${r.car.pitStops}</td><td>${flags(r.car) || '–'}${r.status === 'dq' ? ` <small>${t(`res.dqReason.${r.car.dqReason}`)}</small>` : ''}</td></tr>`).join('');
  const place = mine.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${mine.dqReason}`)}` : mine.status === 'finished' ? t('res.youPlace', { n: pos }) : t('res.youDnf');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results">
    <h2>${pos === 1 && mine.status === 'finished' ? '🏆 ' + t('res.win') : t('res.title')}</h2>
    <div class="place">${place}</div>
    <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row"><button class="cta" id="o-again">${t('res.again')} <small>(R)</small></button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-again')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

// ---- championship
const driverName = (idx: number): string => (idx === 0 ? t('hud.you') : ['', 'Red Comet', 'Blue Arrow', 'Green Viper'][idx]);
const driverColor = (idx: number): number => (idx === 0 ? R.livery(champ?.car ?? carId).color : [0, 0xe8322a, 0x2a6df0, 0x22b04b][idx]);

/** Store the finished round's result once (points are never awarded twice). */
function recordChampRound(): void {
  // only the race's final standings (every car terminal) are recorded: never a live or estimated order
  if (!champ || champRoundSaved || R.champDone(champ) || race.phase !== 'done' || !race.final) return;
  champ.rounds.push(R.roundRecord(T.DEF.id, race.final.map((x) => ({ car: { idx: x.slot }, status: x.status, time: x.time ?? 0 }))));
  R.saveChamp(champ);
  champRoundSaved = true;
}

function startChampRound(): void {
  if (!champ || R.champDone(champ)) { showTitle(); return; }
  carId = champ.car;
  applyTrack(R.CHAMP_TRACKS[champ.rounds.length]);
  champRoundSaved = false;
  startSession('champ');
}

/** Round results + cumulative standings (after a race), or the final table. */
function showChamp(finished: Race | null): void {
  if (!champ) { showTitle(); return; }
  enter('champ');
  camMode = 'full';
  const c = champ;
  const nR = R.CHAMP_TRACKS.length;
  const done = R.champDone(c);
  const last = c.rounds[c.rounds.length - 1];
  let roundHtml = '';
  if (finished && last) {
    const rows = last.order.map((o, i) => `<tr class="${o.idx === 0 ? 'me' : ''}"><td>${o.dq || o.dnf ? '–' : i + 1}</td><td>${colorDot(driverColor(o.idx))}${driverName(o.idx)}</td><td class="mono">${o.dq ? t('champ.dq') : o.dnf ? t('champ.dnf') : fmt(o.time)}</td><td class="mono">${R.roundPoints(last, i)}</td></tr>`).join('');
    roundHtml = `<h3>${t('champ.roundResults')} · ${t(`track.${last.track}.name`)}</h3>
      <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('champ.points')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const st = R.standings(c, 4);
  const stRows = st.map((x, i) => `<tr class="${x.idx === 0 ? 'me' : ''}"><td>${i + 1}</td><td>${colorDot(driverColor(x.idx))}${driverName(x.idx)}</td><td class="mono">${x.points}</td><td class="mono">${x.wins}</td><td class="mono">${x.seconds}</td></tr>`).join('');
  const roundsLine = R.CHAMP_TRACKS.map((id, i) => `<span class="rchip ${i < c.rounds.length ? 'done' : ''} ${i === c.rounds.length && !done ? 'next' : ''}">${i + 1}. ${t(`track.${id}.name`)}</span>`).join('');
  const champion = st[0];
  const head = done ? `<h2>🏆 ${t('champ.final')}</h2><div class="place">${champion.idx === 0 ? t('champ.youChampion') : t('champ.champion', { name: driverName(champion.idx) })}</div>` : `<h2>${t('champ.title')}</h2><div class="place">${t('champ.round', { n: c.rounds.length, m: nR })}</div>`;
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results champ">
    ${head}
    <div class="rounds">${roundsLine}</div>
    ${roundHtml}
    <h3>${done ? t('champ.final') : t('champ.standings')}</h3>
    <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('champ.points')}</th><th>${t('champ.wins')}</th><th>${t('champ.seconds')}</th></tr></thead><tbody>${stRows}</tbody></table></div>
    <div class="row">${done ? '' : `<button class="cta" id="o-next">${t('champ.continue', { n: c.rounds.length + 1 })}</button>`}<button class="cta alt" id="o-menu">${t('champ.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-next')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

// ---- leaderboards
function showBoards(): void {
  enter('boards');
  overlay.className = 'overlay show';
  const tabs = T.TRACKS.map((d) => `<button class="tab ${d.id === lbTrack ? 'sel' : ''}" data-id="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('');
  const kinds = (['practice', 'race'] as R.BoardKind[]).map((k) => `<button class="tab kind ${k === lbKind ? 'sel' : ''}" data-kind="${k}">${t(`boards.${k}`)}</button>`).join('');
  const rows = R.board(lbKind, lbTrack);
  const body = rows.length ? rows.map((r, i) => `<tr class="${freshIds.has(r.id) ? 'fresh' : ''}"><td>${i + 1}</td><td>${r.initials}</td><td>${colorDot(R.livery(r.car).color)}${R.livery(r.car).name}</td><td class="mono">${R.fmtMs(r.ms)}</td><td>${freshIds.has(r.id) ? `<span class="chip yel">${t('boards.new')}</span>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">${t('boards.empty')}</td></tr>`;
  overlay.innerHTML = `<div class="card results boards">
    <h2>${t('boards.title')}</h2>
    <p>${t('boards.hint')}</p>
    <div class="tabs">${tabs}</div>
    <div class="tabs">${kinds}</div>
    <div class="tscroll"><table><thead><tr><th>${t('boards.rank')}</th><th>${t('boards.initials')}</th><th>${t('boards.car')}</th><th>${t('boards.time')}</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="row"><button class="cta alt" id="o-back">${t('boards.back')}</button></div>
  </div>`;
  overlay.querySelectorAll<HTMLElement>('.tab[data-id]').forEach((b) => b.addEventListener('click', () => { lbTrack = b.dataset.id!; showBoards(); }));
  overlay.querySelectorAll<HTMLElement>('.tab[data-kind]').forEach((b) => b.addEventListener('click', () => { lbKind = b.dataset.kind as R.BoardKind; showBoards(); }));
  overlay.querySelector('#o-back')!.addEventListener('click', showTitle);
}

/** Back to the title screen with a fresh grid on the current circuit. */
function toMenu(): void {
  mode = 'race';
  recorder.stop(); ghost.setData(null);
  setRace(newRace());
  showTitle();
}

function startSession(m: Mode): void {
  mode = m;
  setRace(newRace());
  camMode = 'follow';
  recorder.stop(); pendingLap = null;
  if (mode === 'practice') {
    const g = R.loadGhost(T.DEF.id, carId, R.currentInitials());
    ghost.setData(g); pbMs = g ? g.ms : 0;
  } else { ghost.setData(null); pbMs = 0; }
  resume();
  camLead.set(0, 0);
  const p = me();
  camTarget.set(p.x, 0, -p.y);
}
/** restart the current session (race, practice or championship round) */
function restartSession(): void { startSession(mode); }
function startRace(): void { startSession(mode === 'practice' ? 'practice' : mode); }

/** timing-line crossing by the player: finish the recording of the lap just done, start the next */
function onPlayerCross(): void {
  const p = me();
  if (mode !== 'practice') return;
  const lap = pendingLap;
  if (recorder.active && lap) {
    if (lap.valid) {
      const ms = lap.time * 1000;
      const data = recorder.finish(p, race.raceTime, T.DEF.id, carId, R.currentInitials(), ms);
      const rec = R.submitLap('practice', T.DEF.id, R.currentInitials(), carId, ms);
      if (rec) freshIds.add(rec.id);
      if (pbMs === 0 || ms < pbMs) {
        const first = pbMs === 0;
        pbMs = Math.round(ms);
        R.saveGhost(data); ghost.setData(data);
        hud.toast(t(first ? 'msg.pbFirst' : 'msg.newPb', { time: R.fmtMs(ms) }), 'good'); sfx.good(); hud.goFlash(t('msg.pbFlash'));
      }
    } else { hud.toast(t('msg.lapInvalid'), 'warn'); }
  }
  pendingLap = null;
  recorder.start(p);
  if (ghost.data) ghost.launch(p.lapStartT);
}

// ------------------------------------------------------------ input
const input = new DrivingInput({
  lane: () => { if (screen === 'race') race.requestLane(localId); },
  pit: () => { if (screen === 'race') race.requestPit(localId); },
  defer: () => { if (screen === 'race') race.requestDefer(localId); },
  view: () => toggleView(),
  pause: () => { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); },
});
const pad = new TouchPad([...hud.root.querySelectorAll<HTMLButtonElement>('[data-hold], [data-tap]')] as PadButton[], input, () => sfx.init());
const anchor = new ControlsAnchor(vp);
/** Let go of every hold, and of the reverse gear and Brake hold they built up: resuming never restores a reverse command. */
function releaseDriving(): void { pad.reset(); input.clear(); race.clearReverse(); }

let touchMode = savedTouchMode();
const coarsePointer = window.matchMedia(COARSE_QUERY);
/** Apply the touch setting and the current screen. Touches layout only, so a race in progress carries on untouched. */
function syncPad(): void {
  const on = touchActive(touchMode, { coarse: coarsePointer.matches, maxTouchPoints: navigator.maxTouchPoints });
  document.body.classList.toggle('touch', on);
  const show = on && screen === 'race';
  if (!show) pad.reset();
  hud.el['t-pad'].hidden = !show;
  hud.fitMini();
}
coarsePointer.addEventListener('change', syncPad);
function setTouchMode(m: TouchMode): void {
  touchMode = m;
  saveTouchMode(m);
  syncPad();
}
// every menu button counts as the interaction that lets audio start or resume
overlay.addEventListener('click', () => sfx.init());

/**
 * iOS Safari, and Chrome by default, lay an on-screen keyboard over the page and shrink only the visual viewport.
 * The overlay gives that space up while a field has focus and keeps the field in view. The canvas, and any race behind the menu, keep their size.
 */
function fitKeyboard(): void {
  const vv = window.visualViewport;
  const field = document.activeElement instanceof HTMLInputElement && overlay.contains(document.activeElement) ? document.activeElement : null;
  const covered = vv && field ? Math.max(0, Math.round(vp.h - vv.height - vv.offsetTop)) : 0;
  overlay.style.setProperty('--kb', `${covered}px`);
  if (covered && field) field.scrollIntoView({ block: 'center' });
}
window.visualViewport?.addEventListener('resize', fitKeyboard);
overlay.addEventListener('focusin', fitKeyboard);
overlay.addEventListener('focusout', fitKeyboard);

const NON_SCROLL = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
/** This key belongs to what has focus: text fields take everything, and a focused menu button keeps Space and Enter. */
function ownedByWidget(target: EventTarget | null, code: string): boolean {
  const el = target instanceof Element ? target : null;
  return !!el?.closest('input, textarea, select, [contenteditable]') || ((code === 'Space' || code === 'Enter') && !!el?.closest('.overlay button'));
}
window.addEventListener('keydown', (e) => {
  const k = e.code;
  if (ownedByWidget(e.target, k)) return;
  if (NON_SCROLL.includes(k)) e.preventDefault();
  // auto-repeat is not a press: a key held across a pause stays released until it is pressed again
  if (e.repeat) return;
  sfx.init();
  if (screen === 'race' && KEY_HOLDS[k]) input.press(`key:${k}`, KEY_HOLDS[k]);
  if (screen === 'title') {
    if (k === 'Enter' || k === 'Space') startSession('race');
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(k);
    if (n >= 0 && n < T.TRACKS.length) { applyTrack(T.TRACKS[n].id); showTitle(); }
    return;
  }
  if (screen === 'boards' || screen === 'champ') { if (k === 'Escape') showTitle(); return; }
  if (k === 'KeyR') { restartSession(); return; }
  if (k === 'KeyG') toggleGhost();
  if (k === 'KeyC') input.tap('view');
  if (k === 'Equal' || k === 'NumpadAdd') zoomBy(0.8);
  if (k === 'Minus' || k === 'NumpadSubtract') zoomBy(1.25);
  if (k === 'KeyM') toggleSound();
  if (k === 'Escape') { input.tap('pause'); return; }
  if (screen === 'pause' && k === 'Enter') { resume(); return; }
  if (screen === 'results' && k === 'Enter') { restartSession(); return; }
  if (KEY_TAPS[k]) input.tap(KEY_TAPS[k]);
});
window.addEventListener('keyup', (e) => input.release(`key:${e.code}`));
/** The player has left: a key released while away never reports its keyup, and a race does not run unattended. */
function suspend(): void { releaseDriving(); if (screen === 'race') showPause(); }
window.addEventListener('blur', suspend);
// the results screen keeps simulating when unfocused, so the rebase matters there too: time spent hidden is never replayed
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); stepper.rebase(); });
renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });

/**
 * A HUD button for mouse, keyboard and touch alike. A finger acts on touchstart, because a second finger gets no click while the first holds Throttle;
 * cancelling it means no click follows, so nothing fires twice. Audio unlocks on the release, as on the pad.
 */
function hudButton(id: string, act: () => void): void {
  const b = hud.el[id];
  b.addEventListener('click', () => { sfx.init(); act(); });
  b.addEventListener('touchstart', (e) => { e.preventDefault(); act(); }, { passive: false });
  b.addEventListener('touchend', () => sfx.init());
}
hud.el['b-view'].addEventListener('click', () => { sfx.init(); input.tap('view'); });
hudButton('b-more', () => hud.setMore(!hud.moreOpen));
hudButton('b-zin', () => zoomBy(0.8));
hudButton('b-zout', () => zoomBy(1.25));
hudButton('b-snd', toggleSound);
hud.el['b-pause'].addEventListener('click', () => input.tap('pause'));
function toggleSound(): void {
  sfx.setMuted(!sfx.muted);
  hud.el['b-snd'].textContent = sfx.muted ? '🔇' : '🔊';
  hud.el['b-snd'].setAttribute('aria-pressed', String(!sfx.muted));
}
hudButton('b-ghost', toggleGhost);
function toggleGhost(): void {
  ghost.shown = !ghost.shown;
  hud.el['b-ghost'].classList.toggle('off', !ghost.shown);
  hud.el['b-ghost'].setAttribute('aria-pressed', String(ghost.shown));
}

// ------------------------------------------------------------ camera
let camMode: 'follow' | 'full' = 'full';
let followSpan = 20;
const camTarget = new THREE.Vector3();
const camLead = new THREE.Vector2();
let curSpan = 20;
const TILT = THREE.MathUtils.degToRad(13);
function fullSpan(): number {
  return Math.max(T.BOUNDS.h + 11, (T.BOUNDS.w + 13) / (vp.w / vp.h));
}
/** Spans are view heights, so a portrait screen widens the view until a follow span covers the same width as it does on a square one. */
const portraitFit = (): number => Math.min(1, vp.w / vp.h);
function toggleView(): void { camMode = camMode === 'follow' ? 'full' : 'follow'; }
function zoomBy(f: number): void {
  if (camMode === 'full') { camMode = 'follow'; }
  followSpan = THREE.MathUtils.clamp(followSpan * f, 10, 70);
}
let shadowSpan = 0;
function updateCamera(dt: number, p: Pose): void {
  const desired = new THREE.Vector3();
  let span: number;
  if (camMode === 'follow') {
    const lead = Math.min(followSpan * 0.28, me().v * 0.3);
    const lx = Math.cos(p.h) * lead, ly = Math.sin(p.h) * lead;
    const kl = 1 - Math.exp(-2.2 * dt);
    camLead.x += (lx - camLead.x) * kl; camLead.y += (ly - camLead.y) * kl;
    desired.set(p.x + camLead.x, 0, -(p.y + camLead.y));
    span = followSpan / portraitFit();
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
  const sh = curSpan * Math.max(1, vp.w / vp.h) * 0.62 + 4;
  if (Math.abs(sh - shadowSpan) > shadowSpan * 0.08) {
    shadowSpan = sh;
    const c = sun.shadow.camera;
    c.left = -sh; c.right = sh; c.top = sh; c.bottom = -sh; c.near = 1; c.far = 160;
    c.updateProjectionMatrix();
  }
  sun.position.set(camTarget.x - 22, 45, camTarget.z + 14);
  sun.target.position.copy(camTarget);
}

/**
 * Size everything to the game's box, display and preset. Only the drawing buffer varies by preset: the canvas CSS size, aspect ratio and DOM HUD do not.
 * The race carries on.
 */
function fitRenderer(): void {
  vp = viewSize();
  dpr = window.devicePixelRatio;
  camera.aspect = vp.w / vp.h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatioFor(preset, dpr));
  renderer.setSize(vp.w, vp.h, false);
  hud.fitMini();
}

/** Takes effect at once and touches only the renderer, so a race in progress carries on untouched. */
function setPreset(id: PresetId): void {
  preset = id;
  savePreset(id);
  fitRenderer();
}

// ------------------------------------------------------------ events
function handle(e: RaceEvent): void {
  const p = me();
  switch (e.type) {
    case 'msg':
      // personal messages are for their own driver's view only
      if (e.to !== localId) break;
      hud.toast(t(e.text, e.vars), e.kind);
      if (e.kind === 'bad') sfx.bad(); else if (e.kind === 'good') sfx.good(); else sfx.beep();
      break;
    case 'light': if (e.n > 0) sfx.light(); break;
    case 'go': sfx.go(); hud.goFlash(t('msg.go')); break;
    case 'bump': if (isMe(e.car) || isMe(e.other) || dist2(e.car) < 400) sfx.bump(e.power); break;
    case 'deslot': if (isMe(e.car) || dist2(e.car) < 600) sfx.crash(); break;
    case 'switch': if (isMe(e.car) || dist2(e.car) < 200) sfx.click(); break;
    case 'offence': {
      if (!isMe(e.car)) { if (e.stop) hud.toast(t('pen.aiStop', { name: e.car.name }), 'info'); break; }
      const reason = t(e.cause === 'cut' ? 'pen.reasonCut' : 'pen.reasonRear', { name: carLabel(e.other, localId) });
      if (e.n === 1) { hud.toast(t('pen.warn1', { reason }), 'warn'); sfx.beep(); }
      else if (e.n === 2) { hud.toast(t('pen.warn2', { reason }), 'bad'); hud.goFlash(t('pen.flashFinal')); sfx.bad(); }
      else if (e.n === 3 || e.car.sgOwed <= PEN.stopSeconds) {
        const late = e.car.sgDue > LAPS;
        // a late award's consequence arrives as its own race message
        if (!late) hud.toast(t('pen.stop', { reason, due: t(e.car.sgDue >= LAPS ? 'pen.due.final' : e.car.sgDue > race.apprLap(e.car) ? 'pen.due.next' : 'pen.due.due') }), 'bad');
        hud.goFlash(t('pen.flashStop')); sfx.bad();
      }
      else { hud.toast(t('pen.stopAdd', { n: PEN.stopSeconds, reason }), 'bad'); sfx.bad(); }
      break;
    }
    case 'served': if (!isMe(e.car)) hud.toast(t('pen.aiServed', { name: e.car.name }), 'info'); break;
    case 'dq':
      if (e.car === p) { sfx.bad(); hud.goFlash(t('res.dq')); } else hud.toast(t('pen.aiDq', { name: e.car.name }), 'info');
      break;
    case 'breach': if (e.car === p) hud.goFlash(t('pen.flashBreach')); break;
    case 'lap':
      if (e.car !== p) break;
      if (mode === 'practice') { pendingLap = e; break; }
      if (e.valid && !p.finished) {
        const rec = R.submitLap('race', T.DEF.id, R.currentInitials(), carId, e.time * 1000);
        if (rec) { freshIds.add(rec.id); const rank = R.board('race', T.DEF.id).findIndex((r) => r.id === rec.id) + 1; hud.toast(t('msg.boardEntry', { n: rank, time: R.fmtMs(e.time * 1000) }), 'good'); break; }
      }
      if (e.best && p.lapsDone > 1 && !p.finished) hud.toast(t('msg.bestLap', { time: fmt(e.time) }), 'good');
      break;
    case 'finish':
      if (e.car === p) { sfx.fanfare(); hud.goFlash(`P${e.pos}`); }
      break;
  }
}
function dist2(c: { x: number; y: number }): number { const dx = c.x - camTarget.x, dy = -c.y - camTarget.z; return dx * dx + dy * dy; }

// ------------------------------------------------------------ visuals sync
function syncCars(dt: number, time: number, poses: Pose[]): void {
  race.cars.forEach((c, i) => {
    const v = visuals[i];
    const pose = poses[i];
    v.group.position.set(pose.x, pose.z, -pose.y);
    v.group.rotation.set(pose.roll, pose.h, pose.pitch, 'YXZ');
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
  });
  // bridge decks turn translucent while the player drives beneath them
  const under = playerUnderBridge();
  const target = under ? 0.28 : 1;
  bridgeFade += (target - bridgeFade) * Math.min(1, dt * 8);
  for (const m of world.bridgeMats) m.opacity = bridgeFade;
  const p = me();
  const inSession = screen === 'race' || screen === 'pause' || screen === 'results';
  const wanted = inSession && (camMode === 'full' || curSpan * portraitFit() > 34 || (under && p.mode !== 'off'));
  markerFade += ((wanted ? 1 : 0) - markerFade) * Math.min(1, dt * 8);
  playerMarker.visible = markerFade > 0.02;
  if (playerMarker.visible) {
    const mp = poses[Math.max(0, race.cars.indexOf(p))];
    playerMarker.position.set(mp.x, mp.z + Y0 + 0.05, -mp.y);
    playerMarker.quaternion.copy(camera.quaternion);
    // curSpan is the world height of the view, so this holds a constant on-screen size
    playerMarker.scale.setScalar(Math.max(MARKER_MIN, (MARKER_PX * curSpan) / vp.h) * (1 + Math.sin(time * 3) * 0.04));
    for (const m of playerMarker.children) ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = markerFade;
  }
}

function syncArrows(time: number): void {
  const p = me();
  // lane change arrow: a pit route draws its choice for the next switch, straight when that means staying in lane
  const route = race.nextRoute(p);
  if (p.laneReq || p.change || route) {
    const sw = p.change ? { s0: p.change.s0, s1: p.change.s1 } : race.nextSwitch(p);
    const from = p.change ? p.change.from : Math.sign(p.laneSide) || 1;
    const to = p.change ? p.change.to : route ? route.to : -from;
    const key = `${sw.s0}:${from}:${to}`;
    if (key !== laneArrowKey) {
      laneArrowKey = key;
      laneArrow.geometry.dispose();
      const len = sw.s1 - sw.s0;
      laneArrow.geometry = arrowGeometry(sw.s0 - 2.5, sw.s1 + 1.2, (s) => T.LANE_HALF * (from + (to - from) * T.smooth((s - sw.s0) / len)), 0.16);
    }
    laneArrow.visible = true;
    arrowMat.opacity = p.change ? 0.35 : 0.55 + Math.sin(time * 8) * 0.3;
    arrowMat.color.setHex(route && !route.override ? 0x22d3ee : 0xffd23f);
  } else laneArrow.visible = false;
  pitArrow.visible = route !== null;
  pitArrowMat.opacity = 0.55 + Math.sin(time * 8) * 0.3;
  if (route) {
    // cyan when the car will reach the entrance in the outside lane: the next switch only counts if it comes first
    const s = race.s(p);
    const side = T.ahead(s, race.nextSwitch(p).s0) < T.ahead(s, T.PIT_IN0) ? route.to : p.change ? p.change.to : p.laneSide;
    pitArrowMat.color.setHex(side < 0 ? 0x22d3ee : 0xff6b6b);
  }
  // the player's own bay glows while the car is heading for it (cyan, pulsing) and while it stands in it (green); no other bay is offered
  const bound = (p.mode === 'pitlane' && p.pitFuel && !p.serviced) || ((p.mode === 'race') && p.sgCtl && p.sgOwed <= 0);
  world.bayGlow.forEach((m, j) => {
    const own = j === p.bayHome;
    const inIt = (p.mode === 'service' || p.mode === 'bayIn') && p.bay === j;
    m.color.setHex(inIt ? 0x3cff8a : 0x7dd3fc);
    m.opacity = inIt ? 0.45 : own && bound && race.bayFree(j, p) ? 0.25 + Math.sin(time * 7) * 0.15 : 0;
  });
  // penalty box: pulses red while the player owes a stop-and-go, solid while serving
  const owes = p.sgOwed > 0 && !p.finished;
  world.penGlow.opacity = !owes ? 0 : p.sgServing ? 0.5 : 0.25 + Math.sin(time * 7) * 0.15;
  world.penGlow.color.setHex(p.sgServing ? 0x3cff8a : 0xff4444);
  // gantry lights
  world.startLights.forEach((m, i) => {
    const on = race.phase === 'countdown' && i < race.lights;
    m.emissive.setHex(on ? 0xff1a1a : 0x000000);
    m.emissiveIntensity = on ? 3 : 0;
    m.color.setHex(on ? 0xff3333 : 0x330000);
  });
}

/** motor volume per car from the last audio sync: the local driver's car at full volume, the rest by distance */
let motorMix: number[] = [];
function syncAudio(): void {
  const playing = screen === 'race' || screen === 'results';
  motorMix = race.cars.map((c) => (!playing || c.mode === 'off' || c.mode === 'tow' ? 0 : isMe(c) ? 1 : Math.max(0, 1 - Math.sqrt(dist2(c)) / 28) * 0.55));
  if (!sfx.ctx) return;
  race.cars.forEach((c, i) => {
    // backing up runs the motor too: pitch follows speed by magnitude
    sfx.motor(i, Math.abs(c.v), c.v < 0 ? Math.max(c.throttle, 0.3) : c.throttle, motorMix[i]);
  });
  const p = me();
  let sq = playing && p.mode === 'race' ? Math.max(0, (p.latRatio - 0.75) / 0.25) : 0;
  if (p.mode === 'off' && p.off && p.off.t < 0.6) sq = 0.8;
  sfx.tyre(Math.min(1, sq));
  sfx.refuelling(playing && p.mode === 'service' && p.fuel < 1 && p.serviceT > 0.4);
}

// ------------------------------------------------------------ loop
/** one simulation step: physics, events, timing-line bookkeeping and ghost recording */
function tick(dt: number): void {
  prevPoses = race.cars.map(poseOf);
  // single-player adapter: this browser's held keys and touch pedals drive the local driver only
  race.update(dt, { [localId]: { up: input.held('throttle'), down: input.held('brake') } });
  for (const e of race.events) handle(e);
  race.events.length = 0;
  const p = me();
  if (p.crossed !== lastCrossed) { lastCrossed = p.crossed; onPlayerCross(); }
  recorder.sample(p, race.raceTime);
  if (race.phase === 'done' && screen === 'race') showResults();
}
let last = performance.now();
let time = 0;
showTitle();
const simulating = (): boolean => screen === 'race' || screen === 'results';
function frame(now: number): void {
  requestAnimationFrame(frame);
  // checked here, not on resize: browser bars and moving to another display do not always send that event, and the canvas is redrawn in this same frame
  const size = viewSize();
  // Every frame, so the anchor follows the viewport while nothing is in use and each hold is measured from where it began.
  // Fingers are let go if the controls moved from under them, and keep needing a fresh press; held keys are not affected.
  if (anchor.update(size, pad.holding || hud.moreOpen)) { pad.reset(); hud.setMore(false); }
  if (window.devicePixelRatio !== dpr || size.w !== vp.w || size.h !== vp.h) fitRenderer();
  // dt paces presentation only (camera, wheels, toasts) and keeps running on menus; race time comes from the stepper
  const dt = Math.min(MAX_GAP, Math.max(0, (now - last) / 1000));
  last = now; time += dt;
  stepper.frame(now, simulating, tick);
  const alpha = stepper.alpha;
  const poses = race.cars.map((c, i) => blendPose(prevPoses[i], c, alpha));
  updateCamera(dt, poses[Math.max(0, race.cars.indexOf(me()))]);
  syncCars(dt, time, poses);
  // the blended cars trail the live state by up to a step; the ghost must trail with them to line up
  ghost.update(race.raceTime - (1 - alpha) * STEP, screen === 'race' ? dt : 0);
  syncArrows(time);
  syncAudio();
  hud.root.style.display = screen === 'race' || screen === 'pause' || screen === 'results' ? '' : 'none';
  hud.update(race, dt, time, { mode, me: localId, pbMs, round: mode === 'champ' && champ ? `${champ.rounds.length + (champRoundSaved ? 0 : 1)}/${R.CHAMP_TRACKS.length}` : '' });
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// debug/test hooks
(window as unknown as { __game: unknown }).__game = { get race() { return race; }, T, R, PEN, DEF, PERSONAS, startRace, applyTrack, startSession, showTitle, showBoards, get mode() { return mode; }, get preset() { return preset; }, get touchMode() { return touchMode; }, setTouchMode, input, get audio() { return sfx.ctx?.state ?? null; }, get muted() { return sfx.muted; }, suspendAudio: () => sfx.ctx?.suspend(), get champ() { return champ; }, get bays() { return bayPaint; }, get ghost() { return ghost; }, get recorder() { return recorder; }, get pbMs() { return pbMs; }, get screen() { return screen; }, get view() { return camMode; }, get aspect() { return camera.aspect; }, get mini() { return { w: hud.mW, h: hud.mH }; }, stepper, advance: (sec: number) => { for (let t = 0; t < sec && simulating(); t += STEP) tick(STEP); }, setView: (m: 'follow' | 'full') => { camMode = m; }, zoom: (span: number) => { camMode = 'follow'; followSpan = span; curSpan = span; }, snapCam: () => { const p = me(); camLead.set(0, 0); camTarget.set(p.x, 0, -p.y); }, get marker() { return playerMarker; }, get localId() { return localId; }, get localSlot() { return localSlot; }, setLocalSlot: (n: number) => { localSlot = Math.max(0, Math.min(DRIVERS.length - 1, Math.floor(n))); }, get camTarget() { return { x: camTarget.x, z: camTarget.z }; }, get motorMix() { return motorMix; }, arrows: { lane: laneArrow, pit: pitArrow }, info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, objects: world.root.children.length, frames: renderer.info.render.frame, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }) };
