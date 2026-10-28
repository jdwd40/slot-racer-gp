import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as T from './track';
import { Race, LAPS, RaceEvent, DRIVERS, PERSONAS, PEN, DEF } from './race';
import { buildWorld, disposeWorld, arrowGeometry, World } from './world';
import { Y0 } from './gfx';
import { makeCar, CarVisual } from './carModel';
import { Hud, fmt, carLabel, flags } from './hud';
import { Sfx } from './audio';
import { t, onLangChange } from './i18n';
import * as R from './records';
import { GhostRecorder, GhostPlayer } from './ghost';

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
type Mode = 'race' | 'practice' | 'champ';
let mode: Mode = 'race';
let carId = R.savedCar();
function newRace(): Race { return new Race({ practice: mode === 'practice', playerColor: R.livery(carId).color }); }
let race = newRace();
let visuals: CarVisual[] = [];
function disposeVisual(v: CarVisual): void {
  v.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); } });
  v.group.removeFromParent();
}
/** (re)create car visuals for the cars of the current race */
function rebuildVisuals(): void {
  visuals.forEach(disposeVisual);
  visuals = race.cars.map((c) => { const v = makeCar(c.color, [7, 11, 3, 24][c.idx], c.isPlayer); scene.add(v.group); return v; });
}
rebuildVisuals();
function setRace(r: Race): void { race = r; laneArrowKey = ''; lastCrossed = 0; rebuildVisuals(); }

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

type Screen = 'title' | 'race' | 'pause' | 'results' | 'boards' | 'champ';
let screen: Screen = 'title';
let lbTrack = T.DEF.id;
let lbKind: R.BoardKind = 'practice';

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
    ${row('<kbd>G</kbd>', 'ctl.ghost')}
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

function showTitle(): void {
  screen = 'title';
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
      <label class="ini"><span class="lbl2">${t('title.initials')}</span><input id="o-ini" maxlength="${R.MAX_INITIALS}" placeholder="${R.ANON}" value="${R.savedInitialsRaw().replace(/"/g, '')}" autocomplete="off" spellcheck="false"></label>
      <div><span class="lbl2">${t('title.car')}</span>${carPickerHtml()}</div>
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
  screen = 'pause';
  overlay.className = 'overlay show';
  const title = mode === 'practice' ? t('prac.title') : mode === 'champ' && champ ? t('champ.round', { n: champ.rounds.length + 1, m: R.CHAMP_TRACKS.length }) : t('pause.title');
  overlay.innerHTML = `<div class="card">
    <h2>${title}</h2>
    ${mode === 'practice' ? `<p>${t('prac.hint')}</p>` : ''}
    ${controlsHtml()}
    <div class="row"><button class="cta" id="o-resume">${t('pause.resume')}</button><button class="cta alt" id="o-restart">${t('pause.restart')}</button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-resume')!.addEventListener('click', resume);
  overlay.querySelector('#o-restart')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

function resume(): void { screen = 'race'; overlay.className = 'overlay'; overlay.innerHTML = ''; }

function colorDot(c: number): string { return `<i style="background:#${c.toString(16).padStart(6, '0')}"></i>`; }

function showResults(): void {
  if (mode === 'champ') { recordChampRound(); showChamp(race); return; }
  screen = 'results';
  const res = race.results();
  const pos = res.findIndex((r) => r.car.isPlayer) + 1;
  const winner = res[0].time;
  const rows = res.map((r, i) => `<tr class="${r.car.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${colorDot(r.car.color)}${carLabel(r.car)}</td>
    <td class="mono">${i === 0 ? fmt(r.time) : '+' + (r.time - winner).toFixed(1) + 's'}${r.est ? ` <small>(${t('res.est')})</small>` : ''}</td>
    <td class="mono">${fmt(r.car.bestLap)}</td><td>${r.car.pitStops}</td><td>${flags(r.car) || '–'}</td></tr>`).join('');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results">
    <h2>${pos === 1 ? '🏆 ' + t('res.win') : t('res.title')}</h2>
    <div class="place">${t('res.youPlace', { n: pos })}</div>
    <table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row"><button class="cta" id="o-again">${t('res.again')} <small>(R)</small></button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-again')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
  tesana()?.track('race_finished', { position: pos, value: Math.round(race.player.finishTime * 10) / 10, track: levelId() });
}

// ---- championship
const driverName = (idx: number): string => (idx === 0 ? t('hud.you') : ['', 'Red Comet', 'Blue Arrow', 'Green Viper'][idx]);
const driverColor = (idx: number): number => (idx === 0 ? R.livery(champ?.car ?? carId).color : [0, 0xe8322a, 0x2a6df0, 0x22b04b][idx]);

/** Store the finished round's result once (points are never awarded twice). */
function recordChampRound(): void {
  if (!champ || champRoundSaved || R.champDone(champ) || race.phase !== 'done') return;
  const order = race.results().map((r) => ({ idx: r.car.idx, dnf: !r.car.finished && (r.car.mode === 'tow' || r.car.fuel <= 0), time: Math.round(r.time * 10) / 10 }));
  champ.rounds.push({ track: T.DEF.id, order });
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
  screen = 'champ';
  camMode = 'full';
  const c = champ;
  const nR = R.CHAMP_TRACKS.length;
  const done = R.champDone(c);
  const last = c.rounds[c.rounds.length - 1];
  let roundHtml = '';
  if (finished && last) {
    const rows = last.order.map((o, i) => `<tr class="${o.idx === 0 ? 'me' : ''}"><td>${i + 1}</td><td>${colorDot(driverColor(o.idx))}${driverName(o.idx)}</td><td class="mono">${o.dnf ? t('champ.dnf') : fmt(o.time)}</td><td class="mono">${o.dnf ? 0 : R.CHAMP_POINTS[i]}</td></tr>`).join('');
    roundHtml = `<h3>${t('champ.roundResults')} · ${t(`track.${last.track}.name`)}</h3>
      <table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('champ.points')}</th></tr></thead><tbody>${rows}</tbody></table>`;
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
    <table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('champ.points')}</th><th>${t('champ.wins')}</th><th>${t('champ.seconds')}</th></tr></thead><tbody>${stRows}</tbody></table>
    <div class="row">${done ? '' : `<button class="cta" id="o-next">${t('champ.continue', { n: c.rounds.length + 1 })}</button>`}<button class="cta alt" id="o-menu">${t('champ.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-next')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

// ---- leaderboards
function showBoards(): void {
  screen = 'boards';
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
    <table><thead><tr><th>${t('boards.rank')}</th><th>${t('boards.initials')}</th><th>${t('boards.car')}</th><th>${t('boards.time')}</th><th></th></tr></thead><tbody>${body}</tbody></table>
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
  tesana()?.gameplay.levelStart({ levelId: levelId(), levelIndex: levelIndex(), mode });
  camLead.set(0, 0);
  const p = race.player;
  camTarget.set(p.x, 0, -p.y);
}
/** restart the current session (race, practice or championship round) */
function restartSession(): void { startSession(mode); }
function startRace(): void { startSession(mode === 'practice' ? 'practice' : mode); }

/** timing-line crossing by the player: finish the recording of the lap just done, start the next */
function onPlayerCross(): void {
  const p = race.player;
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

onLangChange(() => {
  hud.relabel();
  if (screen === 'title') showTitle(); else if (screen === 'pause') showPause(); else if (screen === 'results') showResults(); else if (screen === 'boards') showBoards(); else if (screen === 'champ') showChamp(null);
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
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (k === 'Enter' || k === 'Space') startSession('race');
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(k);
    if (n >= 0 && n < T.TRACKS.length) { applyTrack(T.TRACKS[n].id); showTitle(); }
    return;
  }
  if (screen === 'boards' || screen === 'champ') { if (k === 'Escape') showTitle(); return; }
  if (k === 'KeyR') { restartSession(); return; }
  if (k === 'KeyG') toggleGhost();
  if (k === 'KeyC') toggleView();
  if (k === 'Equal' || k === 'NumpadAdd') zoomBy(0.8);
  if (k === 'Minus' || k === 'NumpadSubtract') zoomBy(1.25);
  if (k === 'KeyM') toggleSound();
  if (k === 'Escape') { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); return; }
  if (screen === 'pause' && k === 'Enter') { resume(); return; }
  if (screen === 'results' && k === 'Enter') { restartSession(); return; }
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
hud.el['b-ghost'].addEventListener('click', () => { sfx.init(); toggleGhost(); });
function toggleGhost(): void { ghost.shown = !ghost.shown; hud.el['b-ghost'].classList.toggle('off', !ghost.shown); }

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
    case 'offence': {
      if (!e.car.isPlayer) { if (e.stop) hud.toast(t('pen.aiStop', { name: e.car.name }), 'info'); break; }
      const reason = t(e.cause === 'cut' ? 'pen.reasonCut' : 'pen.reasonRear', { name: carLabel(e.other) });
      if (e.n === 1) { hud.toast(t('pen.warn1', { reason }), 'warn'); sfx.beep(); }
      else if (e.n === 2) { hud.toast(t('pen.warn2', { reason }), 'bad'); hud.goFlash(t('pen.flashFinal')); sfx.bad(); }
      else if (e.n === 3 || e.car.sgOwed <= PEN.stopSeconds) { hud.toast(t('pen.stop', { reason, k: e.car.sgChances }), 'bad'); hud.goFlash(t('pen.flashStop')); sfx.bad(); }
      else { hud.toast(t('pen.stopAdd', { n: PEN.stopSeconds, reason }), 'bad'); sfx.bad(); }
      break;
    }
    case 'served': if (!e.car.isPlayer) hud.toast(t('pen.aiServed', { name: e.car.name }), 'info'); break;
    case 'timePen': if (!e.car.isPlayer) hud.toast(t('pen.aiTime', { name: e.car.name, n: e.secs }), 'info'); break;
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
/** one simulation step: physics, events, timing-line bookkeeping and ghost recording */
function tick(dt: number): void {
  race.update(dt, { up: keys.has('KeyW') || keys.has('ArrowUp'), down: keys.has('KeyS') || keys.has('ArrowDown') });
  for (const e of race.events) handle(e);
  race.events.length = 0;
  const p = race.player;
  if (p.crossed !== lastCrossed) { lastCrossed = p.crossed; onPlayerCross(); }
  recorder.sample(p, race.raceTime);
  if (race.phase === 'done' && screen === 'race') showResults();
}
let last = performance.now();
let time = 0;
showTitle();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now; time += dt;
  if (screen === 'race' || screen === 'results') {
    tick(dt);
  } else if (screen === 'title') {
    // idle: slow orbit-free pan over the grid
  }
  updateCamera(dt);
  syncCars(dt, time);
  ghost.update(race.raceTime, screen === 'race' ? dt : 0);
  syncArrows(time);
  syncAudio();
  hud.root.style.display = screen === 'race' || screen === 'pause' || screen === 'results' ? '' : 'none';
  hud.update(race, dt, time, { mode, pbMs, round: mode === 'champ' && champ ? `${champ.rounds.length + (champRoundSaved ? 0 : 1)}/${R.CHAMP_TRACKS.length}` : '' });
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// debug/test hooks
(window as unknown as { __game: unknown }).__game = { get race() { return race; }, T, R, PEN, DEF, PERSONAS, startRace, applyTrack, startSession, showTitle, showBoards, get mode() { return mode; }, get champ() { return champ; }, get ghost() { return ghost; }, get recorder() { return recorder; }, get pbMs() { return pbMs; }, get screen() { return screen; }, advance: (sec: number) => { for (let t = 0; t < sec && (screen === 'race' || screen === 'results'); t += 1 / 60) tick(1 / 60); }, setView: (m: 'follow' | 'full') => { camMode = m; }, zoom: (span: number) => { camMode = 'follow'; followSpan = span; curSpan = span; }, snapCam: () => { const p = race.player; camLead.set(0, 0); camTarget.set(p.x, 0, -p.y); }, info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, objects: world.root.children.length }) };
