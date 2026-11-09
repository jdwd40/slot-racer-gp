import * as THREE from 'three';
import { ONLINE_ENABLED, probeOnline, type OnlineStatus } from './online';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as T from './track';
import { Race, Car, LAPS, RaceEvent, DRIVERS, PERSONAS, PEN, DEF, SOLO_ID, DriverId, RosterEntry } from './race';
import { buildWorld, disposeWorld, arrowGeometry, BayPaint, World } from './world';
import { Y0 } from './gfx';
import { makeCar, makePlayerMarker, CarVisual } from './carModel';
import { Hud, fmt, carLabel, flags, escHtml } from './hud';
import { Sfx } from './audio';
import { t } from './i18n';
import * as R from './records';
import { GhostRecorder, GhostPlayer } from './ghost';
import { FixedStepper, STEP, MAX_GAP, Pose, blendPose } from './timing';
import { PRESETS, PresetId, pixelRatioFor, savedPreset, savePreset } from './graphics';
import { NetSession, loadSeat, refusalText, type ResultView, type Seat, type EndReason } from './net/session';
import { AccountClient, type AuthError, type AuthState } from './net/account';
import { SnapBuffer, applySnapshot, localEvent, mirrorRace } from './net/mirror';
import { LIVERIES as NET_LIVERIES, LIMITS, type LiveryId, type PublicRoom, type ServerMsg } from './net/protocol';
import type { RaceSnapshot, WireEvent } from './race';
import type { SocketCtor } from './net/client';
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
/** local race / practice / championship run on this device; 'online' is a server race (connected solo or multiplayer) */
type Mode = 'race' | 'practice' | 'champ' | 'online';
let mode: Mode = 'race';
let carId = R.savedCar();
/** The local driver: camera, marker, HUD, audio emphasis, personal messages, records and the ghost all follow this ID. */
let localId: DriverId = SOLO_ID;
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

// online play stays off unless this build enables it AND the same-origin service passes its health/protocol check
// (src/online.ts). Nothing online is offered on the menus before that check has passed.
let online: OnlineStatus = ONLINE_ENABLED ? { state: 'checking' } : { state: 'off' };

type Screen = 'title' | 'race' | 'pause' | 'results' | 'boards' | 'champ' | 'online' | 'lobby' | 'netwait' | 'netres' | 'account';
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
    <p class="modes"><small>${t('net.localNote')}</small></p>
    ${onlineEntryHtml()}
  </div>`;
  overlay.querySelector('#o-online')?.addEventListener('click', () => { sfx.init(); showOnline(); });
  overlay.querySelector('#o-account')?.addEventListener('click', () => { sfx.init(); showAccount(); });
  overlay.querySelector('#o-rejoin')?.addEventListener('click', () => { sfx.init(); const st = loadSeat(seatStore()); if (st) void netBegin((n) => n.resume(st)); });
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
  if (net) { showNetMenu(); return; }
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

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;

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
  const rows = res.map((r, i) => `<tr class="${isMe(r.car) ? 'me' : ''}"><td>${r.status === 'finished' ? i + 1 : '–'}</td><td>${colorDot(r.car.color)}${esc(carLabel(r.car, localId))}</td>
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
  if (mode !== 'practice' || net) return;
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
  // online, a tap is a numbered action for this browser's own seat; the server decides what it does
  lane: () => { if (screen === 'race') { if (net) net.action('lane'); else race.requestLane(localId); } },
  pit: () => { if (screen === 'race') { if (net) net.action('pit'); else race.requestPit(localId); } },
  defer: () => { if (screen === 'race') { if (net) net.action('defer'); else race.requestDefer(localId); } },
  view: () => toggleView(),
  pause: () => { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); },
});
const pad = new TouchPad([...hud.root.querySelectorAll<HTMLButtonElement>('[data-hold], [data-tap]')] as PadButton[], input, () => sfx.init());
const anchor = new ControlsAnchor(vp);
/** Let go of every hold, and of the reverse gear and Brake hold they built up: resuming never restores a reverse command. */
function releaseDriving(): void { pad.reset(); input.clear(); race.clearReverse(); net?.release(); }

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
  if (screen === 'online') { if (k === 'Escape') { cancelNetBegin(); showTitle(); } return; }
  if (screen === 'account') { if (k === 'Escape' && !accounts.busy) showTitle(); return; }
  if (screen === 'lobby' || screen === 'netres') return;
  // a shared race cannot be restarted from one browser
  if (k === 'KeyR') { if (!net) restartSession(); return; }
  if (k === 'KeyG') toggleGhost();
  if (k === 'KeyC') input.tap('view');
  if (k === 'Equal' || k === 'NumpadAdd') zoomBy(0.8);
  if (k === 'Minus' || k === 'NumpadSubtract') zoomBy(1.25);
  if (k === 'KeyM') toggleSound();
  if (k === 'Escape') { if (screen === 'netwait') { closeNetWait(); return; } input.tap('pause'); return; }
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
      // online laps never enter this device's leaderboards: network results are kept apart from local records
      if (e.valid && !p.finished && mode !== 'online' && !net) {
        const rec = R.submitLap('race', T.DEF.id, R.currentInitials(), carId, e.time * 1000);
        if (rec) { freshIds.add(rec.id); const rank = R.board('race', T.DEF.id).findIndex((r) => r.id === rec.id) + 1; hud.toast(t('msg.boardEntry', { n: rank, time: R.fmtMs(e.time * 1000) }), 'good'); break; }
      }
      if (e.best && p.lapsDone > 1 && !p.finished) hud.toast(t('msg.bestLap', { time: fmt(e.time) }), 'good');
      break;
    case 'finish':
      // online, the order at the flag is not the classification (penalties and DQs are settled by the server at the end)
      if (e.car === p) { sfx.fanfare(); hud.goFlash(mode === 'online' ? '🏁' : `P${e.pos}`); }
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
  const inSession = screen === 'race' || screen === 'pause' || screen === 'results' || screen === 'netwait';
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
  const playing = screen === 'race' || screen === 'results' || screen === 'netwait';
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

// ------------------------------------------------------------ online (docs/online-client.md)
/** How far behind the newest server snapshot cars are drawn: two snapshot intervals at the default 20 Hz. */
const NET_DELAY_MS = 100;
let net: NetSession | null = null;
/** the server race the mirror was built for (null in the lobby or offline) */
let netRaceId: string | null = null;
const netBuf = new SnapBuffer(NET_DELAY_MS);
let netNotice = '';
let netResult: ResultView | null = null;
/** the local driver's car became terminal and the pending card was dismissed to watch the race */
let netWatch = false;
/** the latest server time seen (ms) and its lag, for the diagnostics hook */
let netTick = -1, netLag = 0;
const NAME_KEY = 'srgp.netName', NLIV_KEY = 'srgp.netLivery';
/** the local car choice's nearest online livery, until one is picked here */
const LOCAL_TO_NET: Record<string, LiveryId> = { sunburst: 'yellow', blaze: 'orange', frost: 'white', violet: 'purple' };
const netName = (): string => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const netLivery = (): LiveryId => { let v: string | null = null; try { v = localStorage.getItem(NLIV_KEY); } catch { /* ignore */ } return NET_LIVERIES.find((l) => l.id === v)?.id ?? LOCAL_TO_NET[carId] ?? 'yellow'; };
const seatStore = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };
const hashCode = (): string => /^#room=([A-Za-z0-9]{6})$/.exec(location.hash)?.[1]?.toUpperCase() ?? '';
const modeLabel = (m: string): string => t(m === 'multiplayer' ? 'net.modeMulti' : m === 'solo' ? 'net.modeSolo' : 'net.modeOther');
const hexc = (c: number): string => '#' + c.toString(16).padStart(6, '0');

function onlineEntryHtml(): string {
  if (online.state === 'available') {
    const seat = loadSeat(seatStore());
    return `<div class="row net-entry"><button class="cta" id="o-online">${t('net.online')}</button>${seat ? `<button class="cta alt" id="o-rejoin">${t('net.rejoin', { code: esc(seat.code) })}</button>` : ''}${accountEntryHtml()}</div><p class="modes"><small>${t('net.onlineNote')}</small></p>`;
  }
  if (online.state === 'unavailable') return `<p class="modes net-off"><small>${t('net.unavailable')}</small></p>`;
  return '';
}

/** The online menu: create a multiplayer room, join one by code, or start a connected solo race with AI. */
function showOnline(): void {
  if (online.state !== 'available') { showTitle(); return; }
  // a re-render of this menu (the sign-in check answered, another tab switched identity) keeps a room code being typed
  const typedCode = screen === 'online' ? overlay.querySelector<HTMLInputElement>('#n-code')?.value : undefined;
  enter('online');
  overlay.className = 'overlay show';
  const liv = netLivery();
  const livs = NET_LIVERIES.map((l) => `<button class="car ${l.id === liv ? 'sel' : ''}" data-nlivery="${l.id}" aria-label="${l.id}"><i style="background:${hexc(l.color)}"></i>${t(`net.liv.${l.id}`)}</button>`).join('');
  overlay.innerHTML = `<div class="card online">
    <h2>${t('net.online')}</h2>
    <div class="setup">
      <label class="ini nm"><span class="lbl2">${t('net.name')}</span><input id="n-name" maxlength="${LIMITS.nameMax}" placeholder="${t('net.namePh')}" autocomplete="nickname" enterkeyhint="done" spellcheck="false"></label>
      <div><span class="lbl2">${t('net.livery')}</span><div class="cars">${livs}</div></div>
    </div>
    <p><small>${t('net.trackNote', { track: t(`track.${T.DEF.id}.name`) })}</small></p>
    <div class="modes-grid">
      <div class="mode-box"><b>${t('net.modeMulti')}</b><small>${t('net.multiDesc')}</small>
        <label class="chk"><input type="checkbox" id="n-ai"> ${t('net.aiFill')}</label>
        <button class="cta" id="n-create">${t('net.create')}</button>
        <div class="join"><input id="n-code" maxlength="${LIMITS.codeLength}" placeholder="${t('net.codePh')}" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go"><button class="cta alt" id="n-join">${t('net.join')}</button></div>
      </div>
      <div class="mode-box"><b>${t('net.modeSolo')}</b><small>${t('net.soloDesc')}</small><button class="cta alt" id="n-solo">${t('net.startSolo')}</button></div>
    </div>
    <p id="n-msg" class="net-msg" role="status" aria-live="polite"></p>
    <div class="row"><button class="cta alt" id="n-back">${t('boards.back')}</button></div>
  </div>`;
  const name = overlay.querySelector<HTMLInputElement>('#n-name')!;
  const signed = accounts.account;
  if (signed) {
    // a signed-in driver races under the saved profile name (the server uses it whatever is sent); it is edited in Account
    name.value = signed.displayName; name.readOnly = true;
    name.closest('label')!.insertAdjacentHTML('beforeend', `<small class="acct-note">${t('acct.nameFromProfile')}</small>`);
  } else {
    name.value = netName() || (R.currentInitials() === R.ANON ? '' : R.currentInitials());
    name.addEventListener('input', () => { try { localStorage.setItem(NAME_KEY, name.value); } catch { /* ignore */ } });
  }
  const code = overlay.querySelector<HTMLInputElement>('#n-code')!;
  code.value = typedCode ?? hashCode();
  for (const f of [name, code]) f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { f.blur(); if (f === code) join(); } });
  overlay.querySelector('#n-msg')!.textContent = netNotice;
  // until the sign-in check answers, the page cannot say who would take the seat: room entry waits for it
  onlinePending = entryIdentity() === null;
  if (onlinePending) {
    for (const id of ['#n-create', '#n-join', '#n-solo']) overlay.querySelector<HTMLButtonElement>(id)!.disabled = true;
    if (!netNotice) overlay.querySelector('#n-msg')!.textContent = t('acct.loading');
  }
  overlay.querySelectorAll<HTMLElement>('[data-nlivery]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(NLIV_KEY, b.dataset.nlivery!); } catch { /* ignore */ }
    overlay.querySelectorAll('[data-nlivery]').forEach((x) => x.classList.toggle('sel', x === b));
  }));
  /** The name and identity a room is entered under, both as the page shows them now; null when entry must wait. */
  const who = (): { n: string; expect: string | undefined } | null => {
    const expect = entryIdentity();
    if (expect === null) { say(t('acct.loading')); return null; }
    if (accounts.account) return { n: accounts.account.displayName, expect };
    const n = name.value.trim();
    if (!n) { say(t('net.err.name')); name.focus(); return null; }
    return { n, expect };
  };
  const join = (): void => {
    const w = who(); if (!w) return;
    const c = code.value.trim().toUpperCase();
    if (c.length !== LIMITS.codeLength) { say(t('net.err.code')); code.focus(); return; }
    void netBegin((s) => s.join(c, w.n, netLivery(), w.expect));
  };
  overlay.querySelector('#n-create')!.addEventListener('click', () => { const w = who(); if (w) void netBegin((s) => s.create(w.n, 'multiplayer', { track: T.DEF.id, aiFill: overlay.querySelector<HTMLInputElement>('#n-ai')!.checked }, netLivery(), w.expect)); });
  overlay.querySelector('#n-join')!.addEventListener('click', join);
  overlay.querySelector('#n-solo')!.addEventListener('click', () => { const w = who(); if (w) void netBegin((s) => s.create(w.n, 'solo', { track: T.DEF.id }, netLivery(), w.expect)); });
  overlay.querySelector('#n-back')!.addEventListener('click', () => { netNotice = ''; showTitle(); });
}
// ------------------------------------------------------------ accounts (docs/accounts.md)
const localStore = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
/** Sign-in and driver profiles: offered only when the same-origin server passes its health check and has accounts. */
const accounts = new AccountClient(fetch.bind(window), location.origin, localStore(), seatStore());
let acctNotice = '';
accounts.onChange = (a: AuthState) => {
  if (a.state === 'guest' && a.expired) acctNotice = t('acct.expired');
  if (screen === 'title' && !accounts.busy) showTitle();
  // the online menu was waiting for the sign-in check: show the identity it found and open room entry
  else if (screen === 'online' && !net && onlinePending && entryIdentity() !== null) showOnline();
};
const accountsOn = (): boolean => online.state === 'available' && online.accounts;
/** the online menu on screen was drawn with room entry held back until the sign-in check answers */
let onlinePending = false;
/**
 * The identity a room is entered under, sent so the server refuses a socket that holds another (server/app.ts):
 * undefined when the server has no accounts; null while the sign-in check has not answered (the page shows a guest name
 * it cannot vouch for, and the browser may hold a live session), so entry waits; and when the account service could not
 * be reached, '' for the guest the page shows, so a signed-in socket is refused rather than seated under its account.
 */
function entryIdentity(): string | undefined | null {
  if (!accountsOn()) return undefined;
  if (accounts.auth.state === 'off' || accounts.auth.state === 'loading') return null;
  return accounts.expected ?? '';
}
// another tab signed in, out or switched: the cookie is shared, so this tab follows rather than keep showing the old identity
window.addEventListener('storage', (e) => {
  if (e.storageArea && e.storageArea !== localStore()) return;
  const before = accounts.expected;
  void accounts.syncFromOtherTab(e.key).then((a) => {
    if (!a || accounts.expected === before) return;
    onIdentityChanged();
    if (screen === 'account') showAccount();
    else if (screen === 'online' && !net) showOnline();
  });
});

function accountEntryHtml(): string {
  if (!accountsOn()) return '';
  const a = accounts.auth;
  if (a.state === 'loading') return `<button class="cta alt" id="o-account" disabled aria-busy="true">${t('acct.loading')}</button>`;
  if (a.state === 'unavailable') return `<button class="cta alt" id="o-account">${t('acct.unavailableShort')}</button>`;
  // the display name is the driver's own public name; other people's text is always escaped
  if (a.state === 'signed-in') return `<button class="cta alt" id="o-account" aria-label="${t('acct.profile')}">👤 <span class="nm">${esc(a.account.displayName)}</span></button>`;
  return `<button class="cta alt" id="o-account">${t('acct.signIn')}</button>`;
}

function acctErrorText(e: AuthError, detail?: string): string {
  if (e === 'invalid_name') return t(`acct.err.name.${detail === 'too_long' || detail === 'reserved' || detail === 'blank' ? detail : 'other'}`);
  return t(`acct.err.${e}`);
}

/** Sign in, create an account, or (signed in) edit the driver name and sign out. Built for phone keyboards: real forms, Enter submits. */
function showAccount(tab: 'login' | 'register' = 'login'): void {
  if (!accountsOn() || net) { showTitle(); return; }
  enter('account');
  overlay.className = 'overlay show';
  const a = accounts.auth;
  const field = (id: string, label: string, attrs: string): string =>
    `<label class="acct-field" for="${id}"><span class="lbl2">${t(label)}</span><input id="${id}" ${attrs} spellcheck="false" autocorrect="off"></label>`;
  let body: string;
  if (a.state === 'signed-in') {
    body = `<h2>${t('acct.profile')}</h2>
      <p class="acct-who">${t('acct.signedInAs')} <b class="mono" id="a-user"></b></p>
      <p><small>${t('acct.privateNote')}</small></p>
      <form id="a-form" class="acct-form" novalidate>
        ${field('a-name', 'acct.driverName', `maxlength="${LIMITS.nameMax * 2}" autocomplete="nickname" enterkeyhint="done" required`)}
        <small>${t('acct.nameRules', { n: LIMITS.nameMax })}</small>
        <button class="cta" type="submit" id="a-submit">${t('acct.save')}</button>
      </form>
      <p id="a-msg" class="net-msg" role="status" aria-live="polite"></p>
      <div class="row"><button class="cta alt" id="a-logout" type="button">${t('acct.signOut')}</button><button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
  } else if (a.state === 'loading' || a.state === 'unavailable') {
    body = `<h2>${t('acct.title')}</h2><p id="a-msg" class="net-msg" role="status" aria-live="polite">${t(a.state === 'loading' ? 'acct.loading' : 'acct.unavailable')}</p>
      <div class="row">${a.state === 'unavailable' ? `<button class="cta" id="a-retry" type="button">${t('acct.retry')}</button>` : ''}<button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
  } else {
    const reg = tab === 'register';
    body = `<h2>${t('acct.title')}</h2>
      <div class="tabs" role="tablist"><button class="tab ${reg ? '' : 'sel'}" role="tab" aria-selected="${!reg}" id="a-tab-login" type="button">${t('acct.signIn')}</button><button class="tab ${reg ? 'sel' : ''}" role="tab" aria-selected="${reg}" id="a-tab-register" type="button">${t('acct.create')}</button></div>
      <form id="a-form" class="acct-form" novalidate data-kind="${reg ? 'register' : 'login'}">
        ${field('a-user-in', 'acct.username', `maxlength="20" autocomplete="username" autocapitalize="none" enterkeyhint="next" required`)}
        ${reg ? `<small>${t('acct.userRules')}</small>` : ''}
        ${field('a-pass', 'acct.password', `type="password" maxlength="128" autocomplete="${reg ? 'new-password' : 'current-password'}" enterkeyhint="${reg ? 'next' : 'go'}" required`)}
        ${reg ? `<small>${t('acct.passRules')}</small>${field('a-name', 'acct.driverNameOpt', `maxlength="${LIMITS.nameMax * 2}" autocomplete="nickname" enterkeyhint="go"`)}<small>${t('acct.nameRules', { n: LIMITS.nameMax })}</small>` : ''}
        <button class="cta" type="submit" id="a-submit">${t(reg ? 'acct.create' : 'acct.signIn')}</button>
      </form>
      <p id="a-msg" class="net-msg" role="status" aria-live="polite"></p>
      <p><small>${t('acct.noEmail')}</small></p>
      <div class="row"><button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
  }
  overlay.innerHTML = `<div class="card account">${body}</div>`;
  const msg = overlay.querySelector<HTMLElement>('#a-msg')!;
  msg.textContent = acctNotice || msg.textContent;
  acctNotice = '';
  const say2 = (text: string, kind: 'err' | 'ok' | 'busy'): void => { msg.textContent = text; msg.dataset.kind = kind; };
  overlay.querySelector('#a-back')!.addEventListener('click', () => { if (!accounts.busy) showTitle(); });
  overlay.querySelector('#a-retry')?.addEventListener('click', () => { void accounts.restore().then(() => { if (screen === 'account') showAccount(); }); showAccount(); });
  overlay.querySelector('#a-tab-login')?.addEventListener('click', () => showAccount('login'));
  overlay.querySelector('#a-tab-register')?.addEventListener('click', () => showAccount('register'));
  const form = overlay.querySelector<HTMLFormElement>('#a-form');
  const inputs = [...overlay.querySelectorAll<HTMLInputElement>('#a-form input')];
  const setBusy = (on: boolean, label: string): void => {
    overlay.querySelectorAll<HTMLButtonElement>('.account button').forEach((b) => { b.disabled = on; });
    inputs.forEach((i) => { i.readOnly = on; });
    form?.setAttribute('aria-busy', String(on));
    if (on) say2(label, 'busy');
  };
  const invalid = (el: HTMLInputElement | null, text: string): void => { say2(text, 'err'); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };
  inputs.forEach((i) => i.addEventListener('input', () => i.removeAttribute('aria-invalid')));
  if (a.state === 'signed-in') {
    overlay.querySelector('#a-user')!.textContent = a.account.username;
    const nameEl = overlay.querySelector<HTMLInputElement>('#a-name')!;
    nameEl.value = a.account.displayName;
    form!.addEventListener('submit', (e) => {
      e.preventDefault();
      if (accounts.busy) return;
      setBusy(true, t('acct.saving'));
      void accounts.rename(nameEl.value).then((r) => {
        if (screen !== 'account') return;
        if (r.ok) { showAccount(); say2(t('acct.saved'), 'ok'); return; }
        if (r.error === 'session_expired' || r.error === 'signed_out') { showAccount(); return; }
        // signed out and in again in another tab: nothing was saved, and the screen now shows who this browser really is
        if (r.error === 'identity_changed') { onIdentityChanged(); acctNotice = t('acct.err.identity_changed'); showAccount(); return; }
        setBusy(false, '');
        invalid(nameEl, acctErrorText(r.error, r.detail));
      });
    });
    overlay.querySelector('#a-logout')!.addEventListener('click', () => {
      if (accounts.busy) return;
      setBusy(true, t('acct.signingOut'));
      void accounts.logout().then((r) => {
        onIdentityChanged();
        if (screen !== 'account') return;
        if (r.ok) { acctNotice = t('acct.signedOut'); showAccount(); return; }
        // the server has not revoked the session: this device is still signed in
        setBusy(false, '');
        say2(t(r.error === 'unreachable' ? 'acct.err.signOutUnreachable' : 'acct.err.signOutFailed'), 'err');
      });
    });
  } else if (form) {
    const reg = form.dataset.kind === 'register';
    const user = overlay.querySelector<HTMLInputElement>('#a-user-in')!, pass = overlay.querySelector<HTMLInputElement>('#a-pass')!;
    const nameEl = overlay.querySelector<HTMLInputElement>('#a-name');
    user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pass.focus(); } });
    if (reg) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl?.focus(); } });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (accounts.busy) return;
      if (!/^[A-Za-z0-9_-]{3,20}$/.test(user.value.trim())) { invalid(user, t('acct.err.invalid_username')); return; }
      const n = [...pass.value].length;
      if (reg ? n < 10 || n > 128 : !n) { invalid(pass, t(reg ? 'acct.err.invalid_password' : 'acct.err.passwordRequired')); return; }
      setBusy(true, t(reg ? 'acct.creating' : 'acct.signingIn'));
      const go = reg ? accounts.register(user.value, pass.value, nameEl?.value ?? '') : accounts.login(user.value, pass.value);
      void go.then((r) => {
        if (screen !== 'account') return;
        if (r.ok) { onIdentityChanged(); acctNotice = t(reg ? 'acct.created' : 'acct.welcome', { name: r.account.displayName }); showAccount(); return; }
        setBusy(false, '');
        pass.value = '';
        invalid(r.error === 'invalid_name' ? nameEl : r.error === 'username_taken' || r.error === 'invalid_username' ? user : pass, acctErrorText(r.error, r.detail));
      });
    });
    if (!('ontouchstart' in window)) user.focus({ preventScroll: true });
  }
}

/** A sign-in, sign-out or switch: nothing this page holds for the previous identity survives it. */
function onIdentityChanged(): void {
  netResult = null; netNotice = '';
}

/** Give up a create, join or resume that has not been answered yet (Escape on the online menu while connecting). */
function cancelNetBegin(): void {
  if (!net || net.conn !== 'connecting') return;
  const s = net;
  net = null;
  mode = 'race';
  netNotice = '';
  s.close();
  syncBanner();
}
function say(msg: string): void { netNotice = msg; const el = overlay.querySelector('#n-msg'); if (el) el.textContent = msg; }

/** Open a session and make one request (create, join or resume). A refusal is explained on the online menu. */
async function netBegin(req: (s: NetSession) => Promise<{ ok: true } | { ok: false; code: string; detail?: string }>): Promise<void> {
  if (net) return;
  if (screen !== 'online') showOnline();
  say(t('net.connecting'));
  overlay.querySelectorAll<HTMLButtonElement>('.online button').forEach((b) => (b.disabled = true));
  // a session reports to this page only while it is the page's session: one cancelled while connecting stays silent
  const own = <A extends unknown[]>(f: (...a: A) => void) => (...a: A): void => { if (net === s) f(...a); };
  const s: NetSession = new NetSession(online.state === 'available' ? online.wsUrl : '', WebSocket as unknown as SocketCtor, {
    room: own((r) => onNetRoom(r)),
    state: own((m, at) => onNetState(m, at)),
    result: own((r, fresh) => onNetResult(r, fresh)),
    end: own((why, detail) => onNetEnd(why, detail)),
    nack: own((m) => onNetNack(m)),
    // a dropped link lets go of everything here as well as on the server: after a reconnect a key or finger must press again
    conn: own((c) => { if (c === 'reconnecting') { pad.reset(); input.clear(); } syncBanner(); }),
  }, seatStore(), undefined, () => performance.now());
  net = s;
  mode = 'online';
  const r = await req(s);
  if (net !== s) {
    // cancelled while connecting: a seat that was granted meanwhile is given back at once
    if (r.ok) s.leave(); else s.close();
    return;
  }
  if (!r.ok) {
    net = null;
    mode = 'race';
    // the sign-in this page shows is not the browser's any more (expired, signed out elsewhere, reset, switched in another
    // tab): nothing was entered; find out who this browser is now and let the driver choose again
    const session = r.code === 'expired' && r.detail === 'session';
    if (session && accountsOn()) void accounts.restore().then(() => { if (screen === 'online' && !net) showOnline(); });
    showOnline();
    say(session ? t('net.err.session') : t(refusalText(r.code)) + (r.detail && r.code === 'not_ready' ? ` (${r.detail})` : ''));
    return;
  }
  netNotice = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function onNetRoom(r: PublicRoom): void {
  if (r.state === 'lobby') {
    if (netRaceId) leaveNetRace();
    if (screen !== 'pause') showLobby();
  } else if (r.state === 'race') {
    // the race screen opens with the first snapshot of the new race
    if (screen === 'lobby') showLobby();
  } else if (r.state === 'results' && netResult && netResult.raceId === r.raceId) {
    if (screen === 'netres') showNetResults(netResult);
  }
}

/** Back from a race to the room: local view state only. */
function leaveNetRace(): void {
  netRaceId = null; netResult = null; netWatch = false; netBuf.reset(); netTick = -1;
}

function onNetState(m: Extract<ServerMsg, { t: 'state' }>, at: number): void {
  if (!net || !net.room || !net.me) return;
  const snap = m.snap as RaceSnapshot;
  if (netRaceId !== net.room.raceId) {
    // a new race: a mirror of the server's roster on the server's circuit, viewed from this browser's own seat
    leaveNetRace();
    netRaceId = net.room.raceId;
    localId = net.me;
    if (T.DEF.id !== snap.track) applyTrack(snap.track);
    setRace(mirrorRace(snap));
    netBuf.push(m.tick, at, snap);
    netTick = m.tick;
    recorder.stop(); ghost.setData(null); pbMs = 0;
    camMode = 'follow'; camLead.set(0, 0);
    const p = me(); camTarget.set(p.x, 0, -p.y);
    resume();
  } else {
    // stale or repeated snapshots are dropped whole: nothing from them is applied twice
    if (!netBuf.push(m.tick, at, snap)) return;
    applySnapshot(race, snap);
    netTick = m.tick;
  }
  netLag = m.lagMs;
  for (const w of m.ev as WireEvent[]) { const e = localEvent(race, w); if (e) handle(e); }
  const p = me();
  if (p.status !== 'running' && !netWatch && screen === 'race') showNetWait();
  else if (screen === 'netwait') renderNetWait();
}

/** Results are the server's alone. Shown as often as asked; nothing is recorded locally, so a repeat changes nothing. */
function onNetResult(r: ResultView, fresh: boolean): void {
  netResult = r;
  if (fresh && r.outcome === 'completed') {
    const mine = r.classification?.find((x) => x.id === localId);
    if (mine?.pos === 1) sfx.fanfare();
  }
  // shown even over the race menu: once the server has classified the race there is nothing left to drive
  showNetResults(r);
}

function onNetNack(m: Extract<ServerMsg, { t: 'nack' }>): void {
  if (['start', 'settings', 'rematch', 'ready', 'livery'].includes(m.ref)) {
    const el = overlay.querySelector('#l-msg');
    if (el) el.textContent = t(m.code === 'not_ready' ? 'net.err.notReady' : refusalText(m.code)) + (m.detail ? ` (${m.detail})` : '');
  }
}

function onNetEnd(why: EndReason, detail?: string): void {
  void detail;
  if (why === 'expired' && accounts.account) void accounts.restore();
  net = null;
  leaveNetRace();
  localId = SOLO_ID;
  mode = 'race';
  setRace(newRace());
  netNotice = why === 'left' ? '' : t(`net.end.${why}`);
  if (why === 'left' || online.state !== 'available') showTitle(); else showOnline();
}

function seatRow(p: PublicRoom['participants'][number], hostId: string | null): string {
  const tags: string[] = [];
  if (p.id === net?.me) tags.push(`<span class="chip yel">${t('hud.you')}</span>`);
  if (p.id === hostId) tags.push(`<span class="chip cyan">${t('net.host')}</span>`);
  if (p.left) tags.push(`<span class="chip red">${t('net.left')}</span>`);
  else if (!p.connected) tags.push(`<span class="chip org">${t('net.disconnected')}</span>`);
  if (!p.left && p.id !== hostId) tags.push(p.ready ? `<span class="chip grn">${t('net.ready')}</span>` : `<span class="chip dim">${t('net.notReady')}</span>`);
  const asked = p.liveryRequested ? ` <small>${t('net.asked', { c: t(`net.liv.${p.liveryRequested}`) })}</small>` : '';
  return `<tr class="${p.id === net?.me ? 'me' : ''}" data-pid="${esc(p.id)}"><td class="mono">#${p.num}</td><td>${colorDot(p.color)}<span class="nm">${esc(p.name)}</span>${asked}</td><td>${tags.join(' ')}</td></tr>`;
}

/** The room: code to share, track, every driver's identity and state, AI slots, and what this browser may do. */
function showLobby(): void {
  const r = net?.room;
  if (!net || !r) return;
  const first = screen !== 'lobby';
  enter('lobby');
  overlay.className = 'overlay show';
  const host = net.host;
  const meP = r.participants.find((p) => p.id === net!.me);
  const others = r.participants.filter((p) => p.id !== r.hostId && !p.left);
  const waitingFor = r.participants.length < r.minHumans ? t('net.needMore', { n: r.minHumans }) : r.participants.some((p) => !p.connected) ? t('net.waitConn') : others.some((p) => !p.ready) ? t('net.waitReady') : '';
  const trackTabs = host ? `<div class="tabs" role="radiogroup">${T.TRACKS.map((d) => `<button class="tab ${d.id === r.settings.track ? 'sel' : ''}" data-ntrack="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('')}</div>` : `<div class="lobby-track">${t(`track.${r.settings.track}.name`)}</div>`;
  const aiRow = r.mode === 'multiplayer' ? (host ? `<label class="chk"><input type="checkbox" id="l-ai" ${r.settings.aiFill ? 'checked' : ''}> ${t('net.aiFill')}</label>` : `<small>${t(r.settings.aiFill ? 'net.aiOn' : 'net.aiOff')}</small>`) : '';
  const aiRows = r.ai.map((a) => `<tr class="ai"><td class="mono">#${a.num}</td><td>${colorDot(a.color)}<span class="nm">${esc(a.name)}</span></td><td><span class="chip dim">${t('net.aiSlot')}</span></td></tr>`).join('');
  const free = r.maxHumans - r.participants.filter((p) => !p.left).length;
  const livs = NET_LIVERIES.map((l) => `<button class="car sq ${meP?.livery === l.id ? 'sel' : ''}" data-mylivery="${l.id}" aria-label="${t(`net.liv.${l.id}`)}" title="${t(`net.liv.${l.id}`)}"><i style="background:${hexc(l.color)}"></i></button>`).join('');
  overlay.innerHTML = `<div class="card results lobby">
    <div class="lbl2">${modeLabel(r.mode)}</div>
    ${r.mode === 'multiplayer' ? `<h2>${t('net.room')} <span class="code mono" id="l-code"></span></h2>
    <div class="row"><button class="cta alt small" id="l-copy">${t('net.copy')}</button>${typeof navigator.share === 'function' ? `<button class="cta alt small" id="l-share">${t('net.share')}</button>` : ''}</div>` : `<h2>${t('net.modeSolo')}</h2>`}
    <div class="lbl2">${t('title.track')}</div>
    ${trackTabs}
    ${aiRow}
    <div class="tscroll"><table><thead><tr><th>${t('net.num')}</th><th>${t('res.driver')}</th><th>${t('net.state')}</th></tr></thead><tbody>${r.participants.map((p) => seatRow(p, r.hostId)).join('')}${aiRows}</tbody></table></div>
    ${r.mode === 'multiplayer' ? `<p><small>${t('net.seats', { n: Math.max(0, free), m: r.maxHumans })}</small></p>` : ''}
    <div class="lbl2">${t('net.yourColour')}</div><div class="cars">${livs}</div>
    <p id="l-msg" class="net-msg" role="status" aria-live="polite">${esc(host ? waitingFor : t('net.hostStarts'))}</p>
    <div class="row">
      ${host ? `<button class="cta" id="l-start" ${waitingFor && r.mode === 'multiplayer' ? 'aria-disabled="true"' : ''}>${t('net.start')}</button>` : `<button class="cta" id="l-ready">${t(meP?.ready ? 'net.unready' : 'net.readyBtn')}</button>`}
      <button class="cta alt" id="l-leave">${t('net.leave')}</button>
    </div>
  </div>`;
  const codeEl = overlay.querySelector('#l-code');
  if (codeEl) codeEl.textContent = r.code;
  const shareText = (): string => t('net.shareText', { code: r.code });
  overlay.querySelector('#l-copy')?.addEventListener('click', () => {
    const msg = overlay.querySelector('#l-msg')!;
    navigator.clipboard?.writeText(r.code).then(() => { msg.textContent = t('net.copied'); }, () => { msg.textContent = t('net.copyFail', { code: r.code }); });
  });
  overlay.querySelector('#l-share')?.addEventListener('click', () => { void navigator.share({ title: t('title.name'), text: shareText(), url: `${location.origin}${location.pathname}#room=${r.code}` }).catch(() => undefined); });
  overlay.querySelectorAll<HTMLElement>('[data-ntrack]').forEach((b) => b.addEventListener('click', () => net?.settings({ track: b.dataset.ntrack! })));
  overlay.querySelector<HTMLInputElement>('#l-ai')?.addEventListener('change', (e) => net?.settings({ aiFill: (e.target as HTMLInputElement).checked }));
  overlay.querySelectorAll<HTMLElement>('[data-mylivery]').forEach((b) => b.addEventListener('click', () => { try { localStorage.setItem(NLIV_KEY, b.dataset.mylivery!); } catch { /* ignore */ } net?.livery(b.dataset.mylivery as LiveryId); }));
  overlay.querySelector('#l-start')?.addEventListener('click', () => net?.start());
  overlay.querySelector('#l-ready')?.addEventListener('click', () => net?.ready(!meP?.ready));
  overlay.querySelector('#l-leave')!.addEventListener('click', () => net?.leave());
  if (first) (overlay.querySelector('#l-start, #l-ready') as HTMLElement | null)?.focus({ preventScroll: true });
}

/** The race menu online: the shared race keeps running behind it, and this browser's controls are released. */
function showNetMenu(): void {
  enter('pause');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card">
    <h2>${t('net.menuTitle')}</h2>
    <p>${t('net.menuNote')}</p>
    ${controlsHtml()}
    ${settingsHtml()}
    <div class="row"><button class="cta" id="o-resume">${t('pause.resume')}</button><button class="cta alt" id="o-leave">${t('net.leaveRace')}</button></div>
  </div>`;
  bindSettings();
  overlay.querySelector('#o-resume')!.addEventListener('click', () => {
    if (netResult && netResult.raceId === netRaceId) showNetResults(netResult);
    else if (me().status !== 'running' && !netWatch) showNetWait();
    else resume();
  });
  overlay.querySelector('#o-leave')!.addEventListener('click', () => net?.leave());
}

/** Standings rows from the server: positions only for classified finishers, explicit DQ and DNF, nothing estimated. */
function standingRows(rows: { id: string; name: string; color: number; num: number; pos: number | null; status: string; time: number | null; best: number; pits: number; reason: string; lap?: string }[]): string {
  return rows.map((x) => {
    const cell = x.status === 'dq' ? `<td class="mono dq">${t('res.dq')}</td>` : x.status === 'dnf' ? `<td class="mono">${t('res.dnf')}</td>` : x.status === 'running' ? `<td class="mono"><small>${t('net.stillRacing')}${x.lap ? ` · ${x.lap}` : ''}</small></td>` : `<td class="mono">${fmt(x.time ?? NaN)}</td>`;
    return `<tr class="${x.id === localId ? 'me' : ''}" data-status="${x.status}"><td>${x.pos ?? '–'}</td><td>${colorDot(x.color)}#${x.num} ${esc(x.id === localId ? t('hud.you') : x.name)}</td>${cell}<td class="mono">${fmt(x.best)}</td><td>${x.pits}</td><td>${x.reason}</td></tr>`;
  }).join('');
}
const STAND_HEAD = (): string => `<thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead>`;

/** what the pending card last showed: unchanged content is left alone, so a selection or a screen reader's place in the table is not reset for nothing */
let netWaitShown = { head: '', rows: '' };
/** This driver is done but the race is not: live state with no positions invented for anyone still running. */
function showNetWait(): void {
  enter('netwait');
  netWaitShown = { head: '', rows: '' };
  overlay.className = 'overlay show see';
  // the card and its buttons are built once; each snapshot updates only the heading and the standings, so a press or the
  // keyboard focus on Watch or Leave survives the 20 Hz updates
  overlay.innerHTML = `<div class="card results netwait">
    <h2>${t('net.pendingTitle')}</h2>
    <div class="place" id="w-head"></div>
    <p><small>${t('net.pendingNote')}</small></p>
    <div class="tscroll"><table>${STAND_HEAD()}<tbody id="w-rows"></tbody></table></div>
    <div class="row"><button class="cta" id="w-watch">${t('net.watch')}</button><button class="cta alt" id="w-leave">${t('net.leave')}</button></div>
  </div>`;
  overlay.querySelector('#w-watch')!.addEventListener('click', closeNetWait);
  overlay.querySelector('#w-leave')!.addEventListener('click', () => net?.leave());
  renderNetWait();
}
function closeNetWait(): void { netWatch = true; resume(); }
function renderNetWait(): void {
  const headEl = overlay.querySelector('#w-head'), rowsEl = overlay.querySelector('#w-rows');
  if (!headEl || !rowsEl) return;
  const p = me();
  const rows = race.order().map((c) => ({
    id: c.id, name: c.name, color: c.color, num: c.num, pos: null, status: c.status, time: c.status === 'finished' ? c.finishTime + c.timePen : null,
    best: c.bestLap, pits: c.pitStops, reason: c.status === 'dq' ? t(`res.dqReason.${c.dqReason}`) : c.status === 'dnf' ? t(`net.dnf.${c.dnfReason}`) : flags(c), lap: `${Math.min(LAPS, c.lapsDone + 1)}/${LAPS}`,
  }));
  const head = p.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${p.dqReason}`)}` : p.status === 'dnf' ? t('res.youDnf') : t('net.youFinished');
  const body = standingRows(rows);
  if (netWaitShown.head !== head) { headEl.innerHTML = head; netWaitShown.head = head; }
  if (netWaitShown.rows !== body) { rowsEl.innerHTML = body; netWaitShown.rows = body; }
}

/** The server's final standings, identical for every member of the room. */
function showNetResults(r: ResultView): void {
  enter('netres');
  overlay.className = 'overlay show';
  const room = net?.room;
  const host = !!net?.host;
  const byId = new Map(r.participants.map((x) => [x.id, x]));
  const liv = (id: string): number => NET_LIVERIES.find((l) => l.id === byId.get(id)?.livery)?.color ?? 0x888888;
  let body: string, head: string;
  if (r.classification) {
    const rows = r.classification.map((x) => ({
      id: x.id, name: byId.get(x.id)?.name ?? x.id, color: liv(x.id), num: byId.get(x.id)?.num ?? 0, pos: x.pos, status: x.status, time: x.time,
      best: x.bestLap, pits: x.pitStops, reason: x.status === 'dq' ? `<span class="flag sg">${t('hud.flagDq')}</span> <small>${t(`res.dqReason.${x.dqReason}`)}</small>` : x.status === 'dnf' ? `<small>${t(`net.dnf.${x.dnfReason}`)}</small>` : x.timePen > 0 ? `<span class="flag tp">+${x.timePen}s</span>` : '–',
    }));
    const mine = r.classification.find((x) => x.id === localId);
    head = !mine ? '' : mine.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${mine.dqReason}`)}` : mine.status === 'dnf' ? t('res.youDnf') : t('res.youPlace', { n: mine.pos ?? 0 });
    body = `<div class="tscroll"><table>${STAND_HEAD()}<tbody>${standingRows(rows)}</tbody></table></div>`;
  } else {
    head = t('net.noResult');
    body = `<p>${t(r.outcome === 'aborted' ? 'net.aborted' : 'net.ended', { why: esc(r.abortReason ?? '') })}</p>`;
  }
  const canRematch = room?.state === 'results' && room.raceId === r.raceId;
  overlay.innerHTML = `<div class="card results netres" data-race="${esc(r.raceId)}">
    <div class="lbl2">${modeLabel(r.mode)} · ${t(`track.${r.track.id}.name`)}</div>
    <h2>${t('net.finalTitle')}</h2>
    <div class="place">${head}</div>
    ${body}
    <p><small>${t('net.resultNote')}</small></p>
    <div class="row">${canRematch ? (host ? `<button class="cta" id="r-rematch">${t('net.rematch')}</button>` : `<span class="net-msg">${t('net.waitRematch')}</span>`) : ''}<button class="cta alt" id="r-leave">${t('net.leave')}</button></div>
  </div>`;
  overlay.querySelector('#r-rematch')?.addEventListener('click', () => net?.rematch());
  overlay.querySelector('#r-leave')!.addEventListener('click', () => { if (net) net.leave(); else showTitle(); });
}

/** Connection state, always visible while online: connecting, reconnecting (with how long the seat is held), retired. */
const banner = document.createElement('div');
banner.id = 'net-banner';
banner.setAttribute('role', 'status');
app.appendChild(banner);
let bannerKey = '';
/** This browser's held pedals for its own seat: sent the moment they change (and checked every frame), never another seat's. */
function sendHeld(): void {
  if (!net || !netRaceId) return;
  const driving = screen === 'race';
  net.setHeld(driving && input.held('throttle'), driving && input.held('brake'));
}
input.onChange = sendHeld;

function syncBanner(): void {
  let key = '', text = '';
  if (net && net.conn === 'reconnecting') { key = 'rec'; text = t('net.reconnecting', { n: net.room?.graceS ?? 20 }); }
  else if (net && net.conn === 'connecting') { key = 'con'; text = t('net.connecting'); }
  else if (net && netRaceId && (screen === 'race' || screen === 'netwait')) {
    const p = me();
    if (p.status === 'dnf' && p.dnfReason === 'retired') { key = 'ret'; text = t('net.retired'); }
    else if (netLag > 500) { key = 'lag'; text = t('net.lagging'); }
  }
  if (key === bannerKey) return;
  bannerKey = key;
  banner.textContent = text;
  banner.className = key ? `show ${key}` : '';
}

// mobile backgrounding and page teardown: controls were already released (suspend); the socket may be dropped by the browser,
// in which case the session resumes the same seat on return
window.addEventListener('pagehide', () => { net?.release(); });

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
const simulating = (): boolean => !net && (screen === 'race' || screen === 'results');
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
  let poses: Pose[];
  let alpha = 1;
  if (net && netRaceId) {
    // online: never simulated here. This browser's pedals go to the server (sendHeld); cars are drawn from buffered snapshots
    sendHeld();
    const at = netBuf.sample(performance.now());
    poses = race.cars.map((c) => at?.get(c.id) ?? poseOf(c));
  } else {
    stepper.frame(now, simulating, tick);
    alpha = stepper.alpha;
    poses = race.cars.map((c, i) => blendPose(prevPoses[i], c, alpha));
  }
  updateCamera(dt, poses[Math.max(0, race.cars.indexOf(me()))]);
  syncCars(dt, time, poses);
  // the blended cars trail the live state by up to a step; the ghost must trail with them to line up
  ghost.update(race.raceTime - (1 - alpha) * STEP, screen === 'race' ? dt : 0);
  syncArrows(time);
  syncAudio();
  hud.root.style.display = screen === 'race' || screen === 'pause' || screen === 'results' || screen === 'netwait' ? '' : 'none';
  syncBanner();
  hud.update(race, dt, time, { mode: mode === 'online' ? 'race' : mode, me: localId, pbMs, round: mode === 'champ' && champ ? `${champ.rounds.length + (champRoundSaved ? 0 : 1)}/${R.CHAMP_TRACKS.length}` : '' });
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// probed once the page has loaded, so scene building on a slow device cannot eat the probe's time budget
if (ONLINE_ENABLED) {
  const probe = (): void => {
    void probeOnline(true, fetch.bind(window), location.origin, 10000).then((st) => {
      online = st;
      if (screen === 'title') showTitle();
      // session restoration only against a healthy server with accounts: a static or guest-only deploy never asks
      if (st.state === 'available' && st.accounts) void accounts.restore();
    });
  };
  if (document.readyState === 'complete') setTimeout(probe, 0); else window.addEventListener('load', () => setTimeout(probe, 0), { once: true });
}

// debug/test hooks

(window as unknown as { __game: unknown }).__game = { get online() { return online; }, get auth() { return { state: accounts.auth.state, busy: accounts.busy, displayName: accounts.account?.displayName ?? null }; }, showAccount, get net() { return net && { conn: net.conn, me: net.me, room: net.room, result: net.result, reconnects: net.reconnects, tick: netTick, lagMs: netLag, buf: netBuf.stats, raceId: netRaceId, held: net.client.held, ctlSeq: net.client.ctlSeq, actSeq: net.client.actSeq }; }, netDrop: () => net?.client.ws?.close(4000, 'qa drop'), get race() { return race; }, T, R, PEN, DEF, PERSONAS, startRace, applyTrack, startSession, showTitle, showBoards, get mode() { return mode; }, get preset() { return preset; }, get touchMode() { return touchMode; }, setTouchMode, input, get audio() { return sfx.ctx?.state ?? null; }, get muted() { return sfx.muted; }, suspendAudio: () => sfx.ctx?.suspend(), get champ() { return champ; }, get bays() { return bayPaint; }, get ghost() { return ghost; }, get recorder() { return recorder; }, get pbMs() { return pbMs; }, get screen() { return screen; }, get view() { return camMode; }, get aspect() { return camera.aspect; }, get mini() { return { w: hud.mW, h: hud.mH }; }, stepper, advance: (sec: number) => { for (let t = 0; t < sec && simulating(); t += STEP) tick(STEP); }, setView: (m: 'follow' | 'full') => { camMode = m; }, zoom: (span: number) => { camMode = 'follow'; followSpan = span; curSpan = span; }, snapCam: () => { const p = me(); camLead.set(0, 0); camTarget.set(p.x, 0, -p.y); }, get marker() { return playerMarker; }, get localId() { return localId; }, get localSlot() { return localSlot; }, setLocalSlot: (n: number) => { localSlot = Math.max(0, Math.min(DRIVERS.length - 1, Math.floor(n))); }, get camTarget() { return { x: camTarget.x, z: camTarget.z }; }, get motorMix() { return motorMix; }, arrows: { lane: laneArrow, pit: pitArrow }, info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, objects: world.root.children.length, frames: renderer.info.render.frame, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }) };
