import { ONLINE_ENABLED, afterProtocolRefusal, afterRetry, behindHtml, outdatedHtml, probeOnline, startRecheck, type OnlineStatus } from './online';
import * as T from './track';
import { Race, Car, RaceEvent, DRIVERS, PEN, SOLO_ID, DriverId, RosterEntry } from './race';
import { lengthOr, type RaceLengthId } from './raceLength';
import { DEFAULT_SETUP, setupOr, type SetupId } from './carSetup';
import { bayPaints, type BayPaint } from './bays';
// the 3D view and Three.js are a separate chunk (#147): type-only here, loaded with import() by loadView below
import type { View3D } from './view3d';
import { Hud, fmt, carLabel, escHtml, type SpecView } from './hud';
import { Spectator, shouldSpectate } from './spectate';
import { Sfx } from './audio';
import { t } from './i18n';
import * as R from './records';
import { GhostRecorder, GhostPlayer } from './ghost';
import { FixedStepper, STEP, MAX_GAP, Pose, blendPose } from './timing';
import { PresetId, pixelRatioFor, savedPreset, savePreset } from './graphics';
import { AutoQuality } from './autoQuality';
import { NetSession, loadSeat, refusalText, type Conn, type ResultView, type EndReason } from './net/session';
import { AccountClient, accountKey, type AuthState } from './net/account';
import { SnapBuffer, applySnapshot, localEvent, mirrorRace } from './net/mirror';
import { LIVERIES as NET_LIVERIES, type AwardsView, type CareerStats, type ChampionshipTag, type LiveryId, type PublicRoom, type ServerMsg } from './net/protocol';
import type { RaceSnapshot, WireEvent } from './race';
import type { SocketCtor } from './net/client';
import { NetWaitGuard } from './net/netwait';
import { bannerOnCard, reconnectTextId } from './net/banner';
import { COARSE_QUERY, ControlsAnchor, DrivingInput, KEY_HOLDS, KEY_TAPS, PadButton, TouchMode, TouchPad, savedTouchMode, saveTouchMode, touchActive } from './input';
import { hookLevel, installGameHook } from './qaHook';
import { createControls, howToHtml } from './menu/controls';
import { createAccount } from './menu/account';
import { createOnline } from './menu/online';
import { createResults } from './menu/results';
import { createTitle } from './menu/title';
import type { Mode, Screen } from './menu/types';

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
let preset = savedPreset();
// watches the first seconds of each race and drops to Low once on a device that cannot keep up (#66, src/autoQuality.ts)
const autoQuality = new AutoQuality((() => { try { return window.localStorage; } catch { return null; } })());
let dpr = window.devicePixelRatio;

/**
 * The 3D view (#147, src/view3d.ts): the renderer, scene, circuit, car models, arrows and marker, with Three.js, in a chunk of
 * its own. null until that chunk has loaded and the view is built: the title and every menu work without it, the frame loop
 * draws nothing 3D, and a race or practice start waits for it (startSession). Fetched as soon as the title is up (loadView).
 */
let view: View3D | null = null;
/** where the 3D view is: 'loading' (fetching or building), 'ready', 'failed' (the chunk did not load), 'nogl' (no WebGL) */
let viewState: 'loading' | 'ready' | 'failed' | 'nogl' = 'loading';
let viewLoading: Promise<void> | null = null;

// ------------------------------------------------------------ cars
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
/**
 * The race length chosen for new local races and new online rooms (#132): remembered on this device (srgp.raceLength). A
 * championship races the length it was started with (champ.length), never this; practice has no lap target at all.
 */
let raceLen: RaceLengthId = R.savedLength();
/**
 * The car setup chosen for local races, practice and new online seats (#133): remembered on this device (srgp.setup). A
 * championship races the setup in its save (champ.setup), which can be changed between rounds, never during one.
 */
let carSetupId: SetupId = R.savedSetup();
function newRace(): Race {
  const practice = mode === 'practice';
  const slot = mode === 'champ' ? 0 : localSlot;
  // the setup is fixed for this race when it is built: a later change only affects the next race (restart takes it)
  const setup = mode === 'champ' && champ ? champ.setup : carSetupId;
  const roster: RosterEntry[] = [{ id: localId, control: 'human', slot, name: DRIVERS[0].name, color: R.livery(carId).color, setup }];
  if (practice) return new Race({ practice, roster: [{ ...roster[0], slot: 0 }], track: T.DEF.id });
  for (let k = 1; k < DRIVERS.length; k++) {
    const D = DRIVERS[k];
    // the AI rivals carry an explicit setup (Balanced), separate from their personality
    roster.push({ id: `ai${k}`, control: 'ai', slot: k === slot ? 0 : k, name: D.name, color: D.color, persona: D.persona, setup: DEFAULT_SETUP });
  }
  // the lap target is fixed for this race when it is built: a later change of the setting only affects the next race.
  // runOn 'watch' (#135): once the player is done the field races on live so it can be watched (Skip to results finishes it
  // through the same synchronous run-on as before, with the same result)
  return new Race({ roster, track: T.DEF.id, length: mode === 'champ' && champ ? champ.length : raceLen, runOn: 'watch' });
}
let race = newRace();
const me = (): Car => race.car(localId) ?? race.cars[0];
/**
 * Post-finish spectating (#135, src/spectate.ts): a camera/view target of its own. Following another car never changes
 * localId, the seat, the results or the debrief: those stay the local driver's.
 */
const spec = new Spectator();
/** race time the local driver's race ended (flag, DQ or DNF) as this page saw it: the HUD's personal clock stops there (#135) */
let myDoneT: number | null = null;
const isMe = (c: Car): boolean => c.id === localId;
const stepper = new FixedStepper();
const poseOf = ({ x, y, z, h, roll, pitch }: Car): Pose => ({ x, y, z, h, roll, pitch });
/** each car's placement before the latest simulation step; drawing blends from here to the live state */
let prevPoses = race.cars.map(poseOf);
/** Bays are painted from the race's owners (Car.bayHome): the player's in the chosen livery, with its number and tag. */
let bayPaint: BayPaint[] = [];
/** The car models and bay paint for the current race (models only once the 3D view is there: it builds them itself then). */
function rebuildVisuals(): void {
  bayPaint = bayPaints(race, localId);
  view?.rebuildCars(race, isMe, bayPaint);
}
rebuildVisuals();
function setRace(r: Race): void { endSpectate(); myDoneT = null; race = r; autoQuality.beginRace(); view?.resetArrows(); lastCrossed = 0; prevPoses = race.cars.map(poseOf); stepper.rebase(); rebuildVisuals(); }

// practice ghost + records
const recorder = new GhostRecorder();
const ghost = new GhostPlayer();
let pbMs = 0;
/**
 * The local driver's compatible personal best (ms) read when this race started (#134): their own fastest lap on this device's
 * race board for this circuit and setup (current tuning), before any lap of this race could change it; null when none.
 */
let pbBefore: number | null = null;
let lastCrossed = 0;
let pendingLap: Extract<RaceEvent, { type: 'lap' }> | null = null;
const freshIds = new Set<string>();
let champ: R.Championship | null = R.loadChamp();
let champRoundSaved = false;

/** true while the player's car is on the lower level of a crossing */
function playerUnderBridge(): boolean {
  const p = me();
  return T.CROSSINGS.some((c) => p.z < c.zHi - 1 && (c.x - p.x) ** 2 + (c.y - p.y) ** 2 < 4.2 * 4.2);
}

// ------------------------------------------------------------ HUD / overlays
const hud = new Hud(app);
const sfx = new Sfx();
/**
 * The menu layer: the connection banner (added below, before the overlay) and the overlay, stacked in a column. On a race the
 * banner floats out of flow below the HUD; on a menu card it is in flow above the overlay, so its wrapped height pushes the card
 * down by exactly as much as it needs (#64, #121).
 */
const menuLayer = document.createElement('div');
menuLayer.id = 'menu-layer';
app.appendChild(menuLayer);
const overlay = document.createElement('div');
overlay.className = 'overlay';
menuLayer.appendChild(overlay);
/**
 * The 3D view's status line (#147): "Loading the race view…" while a start waits for it (or a race is up without it), and a
 * short error with Reload / Try again if its chunk could not be loaded (an old tab after a deploy, or a dropped connection),
 * so the page is never left blank or stuck. Outside the overlay, so redrawing a card never removes it.
 */
const viewNote = document.createElement('div');
viewNote.id = 'view-note';
viewNote.hidden = true;
app.appendChild(viewNote);
/**
 * The How to play sheet (#151): the controls, pit and service rules that used to fill the title card. A modal <dialog>, a
 * bottom sheet on a phone and a centred card from 900 px wide (style.css), opened from the title and the race menu. Outside
 * the overlay, so a card redrawn behind it (the online status arriving) leaves it open; changing screen closes it.
 */
const howTo = document.createElement('dialog');
howTo.id = 'howto';
howTo.className = 'howto';
howTo.setAttribute('aria-labelledby', 'howto-h');
app.appendChild(howTo);
/** the control that opened the sheet: focus goes back to it, or to the redrawn card's How to play, when the sheet closes */
let howToOpener: HTMLElement | null = null;
/** false when a change of screen closed the sheet: the card it was opened from is gone, so focus is left to the new screen */
let howToRestore = true;
/** a press that starts on the dimmed backdrop: only a press and release both there closes the sheet, not a text selection */
let howToBackdropDown = false;
howTo.addEventListener('pointerdown', (e) => { howToBackdropDown = e.target === howTo; });
howTo.addEventListener('click', (e) => { if (e.target === howTo && howToBackdropDown) closeHowTo(); howToBackdropDown = false; });
howTo.addEventListener('close', () => {
  const back = howToOpener?.isConnected ? howToOpener : overlay.querySelector<HTMLElement>('#o-help');
  howToOpener = null;
  if (howToRestore) back?.focus({ preventScroll: true });
  howToRestore = true;
});
/** a race, practice or championship round asked for before the 3D view was ready, and the screen it was asked from */
let pendingStart: { m: Mode; from: Screen } | null = null;

let online: OnlineStatus = ONLINE_ENABLED ? { state: 'checking' } : { state: 'off' };

let screen: Screen = 'title';
let lbTrack = T.DEF.id;
let lbKind: R.BoardKind = 'practice';
/** the setup whose laps the leaderboards show (#133): every board holds one setup's laps only, labelled */
let lbSetup: SetupId = carSetupId;
/**
 * The pending card's safety net (src/net/netwait.ts): 30 s with no state or result asks the session to resume through
 * the watchdog's drop path, and a refused resume replaces the card with a plain explanation. Declared before enter(),
 * which stops it; its callbacks only run once a pending card is up.
 */
const netGuard = new NetWaitGuard({
  conn: () => net?.conn ?? 'offline',
  reconnect: () => net?.reconnectNow(),
  render: (v) => renderNetWaitView(v),
  now: () => performance.now(),
});
/** Every change of screen ends the current hold, including restarting into the same one: what is still down needs pressing again. */
function enter(s: Screen): void {
  // spectating (#135) carries on through the race view, the standings card and the race menu; any other screen ends it
  const watching = spec.active && (s === 'race' || s === 'netwait' || s === 'pause');
  if (!watching) endSpectate();
  // the pending card's lost-contact timer lives only while that card shows, or while a finished driver watches the race
  // online: any other screen ends it (#43)
  if (s !== 'netwait' && !(watching && net)) netGuard.stop();
  // the How to play sheet belongs to the screen it was opened on; the same screen redrawn keeps it open
  if (s !== screen && howTo.open) { howToRestore = false; closeHowTo(); }
  screen = s;
  // leaving the screen a start was asked from cancels that start (a session starting goes to the race screen itself)
  if (pendingStart && s !== pendingStart.from) pendingStart = null;
  syncViewNote();
  releaseDriving();
  hud.setMore(false);
  syncPad();
}

function openHowTo(opener: HTMLElement | null): void {
  if (howTo.open) return;
  howToOpener = opener;
  howToRestore = true;
  howTo.innerHTML = `<div class="howto-head"><h2 id="howto-h">${t('how.title')}</h2><button type="button" class="howto-x" id="howto-close">${t('how.close')}</button></div>
    <div class="howto-body" role="region" tabindex="0" aria-labelledby="howto-h"><p class="how-goal">${t('how.goal')}</p>${howToHtml(document.body.classList.contains('touch'))}</div>`;
  howTo.querySelector('#howto-close')!.addEventListener('click', closeHowTo);
  releaseDriving();
  if (typeof howTo.showModal === 'function') howTo.showModal(); else howTo.setAttribute('open', '');
  howTo.querySelector<HTMLElement>('.howto-body')!.scrollTop = 0;
  howTo.querySelector<HTMLElement>('#howto-close')!.focus({ preventScroll: true });
}
function closeHowTo(): void {
  if (!howTo.open) return;
  if (typeof howTo.close === 'function') howTo.close();
  else { howTo.removeAttribute('open'); howTo.dispatchEvent(new Event('close')); }
}

// the menu controls (#141, src/menu/controls.ts): bound to this overlay and to the settings state below
const { bindHowTo, bindTips, bindRadios, chooseLength, syncSetupDesc, chooseSetup, settingsHtml, bindSettings } = createControls({
  overlay, autoQuality,
  get preset() { return preset; },
  get touchMode() { return touchMode; },
  get raceLen() { return raceLen; }, set raceLen(v) { raceLen = v; },
  get carSetupId() { return carSetupId; }, set carSetupId(v) { carSetupId = v; },
  setPreset, setTouchMode, openHowTo,
});

/** Switch the active circuit: rebuild the world, arrows, minimap and a fresh race. */
function applyTrack(id: string): void {
  if (T.DEF.id === id) return;
  T.setTrack(id);
  try { localStorage.setItem(TRACK_KEY, id); } catch { /* ignore */ }
  view?.setTrack();
  hud.rebuildMini();
  setRace(newRace());
  camTarget.set(T.BOUNDS.cx, 0, -T.BOUNDS.cy - 2);
  curSpan = fullSpan();
}

// a rotation or a resized window keeps the chosen circuit in the middle of the strip
window.addEventListener('resize', () => { if (screen === 'title') requestAnimationFrame(() => centreTrack()); });

function resume(): void { enter('race'); overlay.className = 'overlay'; overlay.innerHTML = ''; stepper.rebase(); }

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;

/** Back to the title screen with a fresh grid on the current circuit. */
function toMenu(): void {
  mode = 'race';
  recorder.stop(); ghost.setData(null);
  setRace(newRace());
  showTitle();
}

/**
 * Start a local race, practice or championship round. Before the 3D view has loaded (#147) the start waits for it, from the
 * same screen, and then goes ahead exactly as below; a failed load is retried by asking again.
 */
function startSession(m: Mode): void {
  if (view) { pendingStart = null; startSessionNow(m); return; }
  if (viewState === 'nogl') return;
  pendingStart = { m, from: screen };
  syncViewNote();
  void loadView();
}
function startSessionNow(m: Mode): void {
  mode = m;
  setRace(newRace());
  camMode = 'follow';
  recorder.stop(); pendingLap = null;
  if (mode === 'practice') {
    // only a ghost driven with this setup at its current tuning is challenged (#133); the personal best is that setup's own
    const g = R.loadGhost(T.DEF.id, carId, R.currentInitials(), me().setup.id);
    ghost.setData(g); pbMs = g ? g.ms : 0;
  } else { ghost.setData(null); pbMs = 0; }
  // the debrief's baseline (#134), read before this race can add a lap to the board; a restart reads it afresh
  pbBefore = mode === 'practice' ? null : R.personalBest('race', T.DEF.id, me().setup.id, R.currentInitials());
  resume();
  camLead.set(0, 0);
  const p = me();
  camTarget.set(p.x, 0, -p.y);
}
/** restart the current session (race, practice or championship round) */
function restartSession(): void { startSession(mode); }

/** timing-line crossing by the player: finish the recording of the lap just done, start the next */
function onPlayerCross(): void {
  const p = me();
  if (mode !== 'practice' || net) return;
  const lap = pendingLap;
  if (recorder.active && lap) {
    if (lap.valid) {
      const ms = lap.time * 1000;
      const data = recorder.finish(p, race.raceTime, T.DEF.id, carId, R.currentInitials(), ms);
      const rec = R.submitLap('practice', T.DEF.id, R.currentInitials(), carId, ms, p.setup.id);
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
  lane: () => { if (driving()) { if (net) net.action('lane'); else race.requestLane(localId); } },
  pit: () => { if (driving()) { if (net) net.action('pit'); else race.requestPit(localId); } },
  defer: () => { if (driving()) { if (net) net.action('defer'); else race.requestDefer(localId); } },
  view: () => toggleView(),
  pause: () => { if (screen === 'race') showPause(); else if (screen === 'pause') resume(); },
});
const pad = new TouchPad([...hud.root.querySelectorAll<HTMLButtonElement>('[data-hold], [data-tap]')] as PadButton[], input, () => sfx.init());
const anchor = new ControlsAnchor(vp);
/** The local driver is driving: the race view, not spectating (#135). Holds, taps and sent controls need this. */
function driving(): boolean { return screen === 'race' && !spec.active; }
/** Let go of every hold, and of the reverse gear and Brake hold they built up: resuming never restores a reverse command. */
function releaseDriving(): void { pad.reset(); input.clear(); race.clearReverse(); net?.release(); }

let touchMode = savedTouchMode();
const coarsePointer = window.matchMedia(COARSE_QUERY);
/** Apply the touch setting and the current screen. Touches layout only, so a race in progress carries on untouched. */
function syncPad(): void {
  const on = touchActive(touchMode, { coarse: coarsePointer.matches, maxTouchPoints: navigator.maxTouchPoints });
  document.body.classList.toggle('touch', on);
  // the driving pad goes with spectating (#135): a finger still on it is let go and needs a fresh press in the next race
  const show = on && screen === 'race' && !spec.active;
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
  return !!el?.closest('input, textarea, select, [contenteditable]') || ((code === 'Space' || code === 'Enter') && !!el?.closest('.overlay button, #view-note button'));
}
window.addEventListener('keydown', (e) => {
  // the How to play sheet is modal: its own keys (Tab, the arrows to scroll it, Escape to close it) never reach the game
  if (howTo.open) return;
  const k = e.code;
  if (ownedByWidget(e.target, k)) return;
  if (NON_SCROLL.includes(k)) e.preventDefault();
  // auto-repeat is not a press: a key held across a pause stays released until it is pressed again
  if (e.repeat) return;
  sfx.init();
  if (driving() && KEY_HOLDS[k]) input.press(`key:${k}`, KEY_HOLDS[k]);
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
  // spectating (#135): Previous / Next driver, the standings card (and back); C is the Whole track toggle (toggleView)
  if (spec.active && screen === 'race') {
    if (k === 'ArrowLeft') { specStep(-1); return; }
    if (k === 'ArrowRight') { specStep(1); return; }
    if (k === 'KeyT') { showStandings(); return; }
  }
  if (spec.active && screen === 'netwait' && k === 'KeyT') { closeNetWait(); return; }
  if (screen === 'pause' && k === 'Enter') { resume(); return; }
  if (screen === 'results' && k === 'Enter') { restartSession(); return; }
  if (KEY_TAPS[k]) input.tap(KEY_TAPS[k]);
});
window.addEventListener('keyup', (e) => input.release(`key:${e.code}`));
/** The player has left: a key released while away never reports its keyup, and a race does not run unattended. */
function suspend(): void { releaseDriving(); if (screen === 'race') showPause(); }
window.addEventListener('blur', suspend);
// the results screen keeps simulating when unfocused, so the rebase matters there too: time spent hidden is never replayed
// back from hidden: the online keepalive gives the socket a fresh silence window (src/net/client.ts) instead of counting time
// this page was frozen or throttled against it; a socket that really died is then caught by the watchdog and resumed
document.addEventListener('visibilitychange', () => { autoQuality.interrupt(); if (document.hidden) suspend(); else { net?.client.wake(); netGuard.wake(); } stepper.rebase(); });

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
// the spectator panel (#135): mouse, keyboard and touch alike; none of them reaches a car
hudButton('s-prev', () => specStep(-1));
hudButton('s-next', () => specStep(1));
hudButton('s-whole', () => toggleView());
hudButton('s-stand', () => showStandings());
hudButton('s-skip', () => skipToResults());
hudButton('s-leave', () => net?.leave());
function toggleGhost(): void {
  ghost.shown = !ghost.shown;
  hud.el['b-ghost'].classList.toggle('off', !ghost.shown);
  hud.el['b-ghost'].setAttribute('aria-pressed', String(ghost.shown));
}

// ------------------------------------------------------------ camera
let camMode: 'follow' | 'full' = 'full';
let followSpan = 20;
/** the point the camera looks at (world x, z; y is always 0) and its smoothed look-ahead: plain numbers, the view places the camera */
const camTarget = { x: 0, z: 0, set(x: number, _y: number, z: number): void { this.x = x; this.z = z; } };
const camLead = { x: 0, y: 0, set(x: number, y: number): void { this.x = x; this.y = y; } };
let curSpan = 20;
function fullSpan(): number {
  return Math.max(T.BOUNDS.h + 11, (T.BOUNDS.w + 13) / (vp.w / vp.h));
}
/** Spans are view heights, so a portrait screen widens the view until a follow span covers the same width as it does on a square one. */
const portraitFit = (): number => Math.min(1, vp.w / vp.h);
function toggleView(): void { if (spec.active) { spec.whole = !spec.whole; return; } camMode = camMode === 'follow' ? 'full' : 'follow'; }
function zoomBy(f: number): void {
  if (spec.active) spec.whole = false;
  else if (camMode === 'full') { camMode = 'follow'; }
  followSpan = Math.max(10, Math.min(70, followSpan * f));
}
/** `look`: follow `p` (a car moving at `v`) or show the whole track. Spectating (#135) passes the watched car and its view. */
function updateCamera(dt: number, p: Pose, look: 'follow' | 'full' = camMode, v = me().v): void {
  const desired = { x: 0, z: 0 };
  let span: number;
  if (look === 'follow') {
    const lead = Math.min(followSpan * 0.28, v * 0.3);
    const lx = Math.cos(p.h) * lead, ly = Math.sin(p.h) * lead;
    const kl = 1 - Math.exp(-2.2 * dt);
    camLead.x += (lx - camLead.x) * kl; camLead.y += (ly - camLead.y) * kl;
    desired.x = p.x + camLead.x; desired.z = -(p.y + camLead.y);
    span = followSpan / portraitFit();
  } else {
    desired.x = T.BOUNDS.cx; desired.z = -T.BOUNDS.cy - 2;
    span = fullSpan();
  }
  const k = 1 - Math.exp(-(look === 'follow' ? 7 : 3) * dt);
  camTarget.x += (desired.x - camTarget.x) * k; camTarget.z += (desired.z - camTarget.z) * k;
  curSpan += (span - curSpan) * (1 - Math.exp(-4 * dt));
  // the camera itself, and the shadows that follow the view, are the 3D view's
  view?.placeCamera(camTarget, curSpan, vp.w / vp.h);
}

/**
 * Size everything to the game's box, display and preset. Only the drawing buffer and the shadows vary by preset (MSAA is fixed at load, #167): CSS size, aspect and HUD do not.
 * The race carries on.
 */
function fitRenderer(): void {
  vp = viewSize();
  dpr = window.devicePixelRatio;
  view?.fit(vp, pixelRatioFor(preset, dpr), preset);
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
        const late = e.car.sgDue > race.targetLaps;
        // a late award's consequence arrives as its own race message
        if (!late) hud.toast(t('pen.stop', { reason, due: t(e.car.sgDue >= race.targetLaps ? 'pen.due.final' : e.car.sgDue > race.apprLap(e.car) ? 'pen.due.next' : 'pen.due.due') }), 'bad');
        hud.goFlash(t('pen.flashStop')); sfx.bad();
      }
      else { hud.toast(t('pen.stopAdd', { n: PEN.stopSeconds, reason }), 'bad'); sfx.bad(); }
      break;
    }
    case 'served': if (!isMe(e.car)) hud.toast(t('pen.aiServed', { name: e.car.name }), 'info'); break;
    // the recovered driver gets its own message (msg.stallRecovered); everyone else is told whose car left the track
    case 'recover': if (!isMe(e.car)) hud.toast(t('msg.stallOther', { name: e.car.name }), 'info'); break;
    case 'dq':
      if (e.car === p) { sfx.bad(); hud.goFlash(t('res.dq')); } else hud.toast(t('pen.aiDq', { name: e.car.name }), 'info');
      break;
    case 'breach': if (e.car === p) hud.goFlash(t('pen.flashBreach')); break;
    case 'lap':
      if (e.car !== p) break;
      if (mode === 'practice') { pendingLap = e; break; }
      // online laps never enter this device's leaderboards: network results are kept apart from local records
      // every valid completed lap counts, the final race lap included: this event is handled after the step that also
      // classified the finish, so the car already reads as finished here (a race core lap event is never sent after it)
      if (e.valid && mode !== 'online' && !net) {
        // the lap goes on its own setup's board (#133), never on another setup's
        const rec = R.submitLap('race', T.DEF.id, R.currentInitials(), carId, e.time * 1000, p.setup.id);
        if (rec) { freshIds.add(rec.id); const rank = R.board('race', T.DEF.id, p.setup.id).findIndex((r) => r.id === rec.id) + 1; hud.toast(t('msg.boardEntry', { n: rank, time: R.fmtMs(e.time * 1000) }), 'good'); break; }
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
/** The cars, the bridge decks and the player marker (src/view3d.ts draws them): which view wants the marker is decided here. */
function syncCars(dt: number, time: number, poses: Pose[]): void {
  if (!view) return;
  const under = playerUnderBridge();
  const p = me();
  const inSession = screen === 'race' || screen === 'pause' || screen === 'results' || screen === 'netwait';
  const markerWanted = inSession && ((spec.active ? !spec.focus(race) : camMode === 'full') || curSpan * portraitFit() > 34 || (under && p.mode !== 'off'));
  view.syncCars({ race, poses, dt, time, meIdx: Math.max(0, race.cars.indexOf(p)), under, markerWanted, span: curSpan, vpH: vp.h });
}

/** motor volume per car from the last audio sync: the local driver's car at full volume, the rest by distance */
let motorMix: number[] = [];
function syncAudio(): void {
  const playing = screen === 'race' || screen === 'results' || screen === 'netwait';
  // spectating (#135): the watched car is heard at full volume too
  motorMix = race.cars.map((c) => (!playing || c.mode === 'off' || c.mode === 'tow' ? 0 : isMe(c) || (spec.active && c.id === spec.target) ? 1 : Math.max(0, 1 - Math.sqrt(dist2(c)) / 28) * 0.55));
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
/**
 * #134: the signed-in driver's server bests as read when this race started, before its result could be stored (the
 * debrief's personal-best baseline); null for a guest, before the read returns, or if it failed.
 */
let netPbBase: { raceId: string; account: string; bests: CareerStats['bests'] } | null = null;
/** best laps of results already shown in this tab, per account and record key: a baseline never misses one still being stored */
const netSeenBests: { raceId: string; account: string; key: string; ms: number }[] = [];
/** each race's baseline, fixed when its result is first shown, so a resend or reconnect never compares a race with itself */
const netPbFixed = new Map<string, number | null>();
/** diagnostics only (qaNetResult): the pretend signed-in account of a result card shown without a server */
let qaAccount: string | null = null;
const pbAccount = (): string | null => accounts.account?.id ?? qaAccount;
/** the latest server time seen (ms) and its lag, for the diagnostics hook */
let netTick = -1, netLag = 0;
const NAME_KEY = 'srgp.netName', NLIV_KEY = 'srgp.netLivery';
/** the local car choice's nearest online livery, until one is picked here */
const LOCAL_TO_NET: Record<string, LiveryId> = { sunburst: 'yellow', blaze: 'orange', frost: 'white', violet: 'purple' };
const netName = (): string => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const netLivery = (): LiveryId => { let v: string | null = null; try { v = localStorage.getItem(NLIV_KEY); } catch { /* ignore */ } return NET_LIVERIES.find((l) => l.id === v)?.id ?? LOCAL_TO_NET[carId] ?? 'yellow'; };
const seatStore = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };

/** The title's online links (#153): Online, Rejoin a held seat and Sign in (or the driver's profile), among the text links. */
function onlineLinksHtml(): string {
  if (online.state !== 'available') return '';
  const seat = loadSeat(seatStore());
  // its note is folded in with the local one, behind "Local or online?" on the title (#152)
  return `<button class="linkbtn" id="o-online">${t('net.online')}</button>${seat ? `<button class="linkbtn" id="o-rejoin">${t('net.rejoin', { code: esc(seat.code) })}</button>` : ''}${accountEntryHtml()}`;
}
/** Under the title's links: why online play is not offered, with Reload or Retry where one helps. */
function onlineNoticeHtml(): string {
  if (online.state === 'unavailable') return `<p class="modes net-off">${t('net.unavailable')}</p>`;
  if (online.state === 'outdated') return outdatedHtml();
  if (online.state === 'behind') return behindHtml();
  return '';
}

/** The same-origin health probe (src/online.ts), for the first check, Retry and the title's re-check. */
function probeHealth(): Promise<OnlineStatus> { return probeOnline(true, fetch.bind(window), location.origin, 10000); }

/**
 * Take a health answer. The title is redrawn when it is shown and the answer changed what it offers (or `redraw`: a Retry
 * press, whose button must come back); a periodic re-check that still says `behind` leaves the title alone, so a name being
 * typed is not lost. Becoming available with accounts restores the sign-in, as the first probe does.
 */
function applyOnline(st: OnlineStatus, redraw = false): void {
  const was = online;
  online = st;
  if (screen === 'title' && (redraw || JSON.stringify(was) !== JSON.stringify(st))) showTitle();
  if (st.state === 'available' && st.accounts && was.state !== 'available') void accounts.restore();
}

/** While the title shows the older-server notice, re-probe health now and then so the page recovers without a reload (#80). */
let recheckStop: (() => void) | null = null;
function syncRecheck(): void {
  if (recheckStop || screen !== 'title' || online.state !== 'behind') return;
  recheckStop = startRecheck(() => probeHealth().then(afterRetry), (st) => applyOnline(st), () => screen === 'title' && online.state === 'behind', () => { recheckStop = null; });
}

/**
 * A hello refused for its protocol, or a welcome on other rules (#142): ask /api/health which side is newer. Only a newer
 * server (protocol or rules) makes this page outdated (Reload); an older one (a rollback) is the Retry notice (#80).
 */
function onProtocolRefused(): void {
  online = { state: 'checking' };
  netNotice = '';
  showTitle();
  void probeHealth().then((st) => applyOnline(afterProtocolRefusal(st), true));
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
    awards: own((a) => onNetAwards(a)),
    end: own((why, detail) => onNetEnd(why, detail)),
    nack: own((m) => onNetNack(m)),
    // a dropped link lets go of everything here as well as on the server: after a reconnect a key or finger must press again
    conn: own((c) => { if (c === 'reconnecting') { pad.reset(); input.clear(); } netGuard.conn(c); syncBanner(); }),
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
    // the server refused this page's protocol, or races other rules (#142): newer → Reload (#67); older → Retry (#80)
    if (r.code === 'protocol' || r.code === 'rules') { onProtocolRefused(); return; }
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
  netRaceId = null; netResult = null; netBuf.reset(); netTick = -1;
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
    if (netRaceId) readNetPbBase(netRaceId);
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
  netGuard.news();
  for (const w of m.ev as WireEvent[]) { const e = localEvent(race, w); if (e) handle(e); }
  // a driver whose own race is over switches to the spectator view (#135, syncSpectate), not a card over the action
  noteDone();
  syncSpectate();
  if (screen === 'netwait') renderNetWait();
}

/**
 * The debrief's personal-best baseline (#134) for a server race: a signed-in driver's career bests, read as the race starts.
 * Kept only if it arrives before this race's result (so it can never already hold this race's own laps).
 */
function readNetPbBase(raceId: string): void {
  netPbBase = null;
  const account = accounts.account?.id;
  if (!account) return;
  void accounts.stats().then((r) => {
    if (r.ok && netRaceId === raceId && netResult?.raceId !== raceId && accounts.account?.id === account) netPbBase = { raceId, account, bests: r.stats.bests };
  });
}
/** A record's compatibility key: circuit and layout version, mode, rules, setup and its tuning (docs/race-debrief.md). */
const pbKey = (r: ResultView, setup: SetupId, tuning: number): string | null => (r.track.version && r.rules?.version ? [r.track.id, r.track.version, r.mode, r.rules.version, setup, tuning].join('|') : null);
/**
 * The compatible personal best from before this race (ms), or null: no baseline means no comparison. Only for a signed-in
 * driver whose bests were read at the start of this race; earlier results shown in this tab for the same account and key count
 * too (their storage may still be pending). Fixed at the first showing of the race.
 */
function netPbBefore(r: ResultView): number | null {
  if (netPbFixed.has(r.raceId)) return netPbFixed.get(r.raceId)!;
  const mine = r.participants.find((x) => x.id === localId);
  const setup = setupOr(mine?.setup), tuning = mine?.tuning ?? 0;
  const key = pbKey(r, setup, tuning);
  let before: number | null = null;
  if (key && netPbBase && netPbBase.raceId === r.raceId && netPbBase.account === pbAccount()) {
    const ms = [
      // a best set by this very race (a reloaded tab whose career read beat the result) is never its own baseline
      ...netPbBase.bests.filter((b) => b.raceId !== r.raceId && [b.track, b.trackVersion, b.mode, b.rules, setupOr(b.setup), b.tuning].join('|') === key).map((b) => b.lapMs),
      ...netSeenBests.filter((x) => x.key === key && x.account === netPbBase!.account && x.raceId !== r.raceId).map((x) => x.ms),
    ].filter((x) => x > 0);
    before = ms.length ? Math.min(...ms) : null;
  }
  netPbFixed.set(r.raceId, before);
  while (netPbFixed.size > 32) netPbFixed.delete(netPbFixed.keys().next().value!);
  // this race's own best now counts for the next race's baseline (once, whatever the resends)
  const best = r.classification?.find((x) => x.id === localId)?.bestLap ?? 0;
  const account = pbAccount();
  if (key && account && best > 0 && r.outcome === 'completed' && !netSeenBests.some((x) => x.raceId === r.raceId)) {
    netSeenBests.push({ raceId: r.raceId, account, key, ms: Math.round(best * 1000) });
    if (netSeenBests.length > 32) netSeenBests.shift();
  }
  return before;
}

/** Results are the server's alone. Shown as often as asked; nothing is recorded locally, so a repeat changes nothing. */
function onNetResult(r: ResultView, fresh: boolean): void {
  netResult = r;
  if (fresh) advanceConnectedChamp(r);
  if (fresh && r.outcome === 'completed') {
    const mine = r.classification?.find((x) => x.id === localId);
    if (mine?.pos === 1) sfx.fanfare();
  }
  // shown even over the race menu: once the server has classified the race there is nothing left to drive
  showNetResults(r);
}

// ------------------------------------------------------------ career (docs/career.md)

/** The race lengths the connected server runs (#132): none from a server older than presets, which races Standard only. */
const netLengths = (): readonly RaceLengthId[] => (online.state === 'available' ? online.lengths : []);
/** The length a new online room asks for: the remembered choice when this server runs it, else Standard. */
const netLength = (): RaceLengthId => (netLengths().includes(raceLen) ? raceLen : 'standard');
/** The car setups the connected server accepts (#133): none from a server older than setups, whose cars are all Balanced. */
const netSetups = (): readonly SetupId[] => (online.state === 'available' ? online.setups : []);
/** The setup a new online seat asks for: the remembered choice when this server runs it, else Balanced. */
const netSetup = (): SetupId => (netSetups().includes(carSetupId) ? carSetupId : DEFAULT_SETUP);

/** This account's stored connected championship: its tag (round 1-4) and, once its first round started, its length (#132). */
function readConnectedChamp(): { tag: ChampionshipTag; length: RaceLengthId | null } | null {
  const id = accounts.account?.id;
  if (!id) return null;
  try {
    const v = JSON.parse(localStorage.getItem(accountKey(id, 'cchamp')) ?? 'null') as (ChampionshipTag & { length?: unknown }) | null;
    if (v && typeof v.id === 'string' && v.id.length <= 64 && Number.isInteger(v.round) && v.round >= 1 && v.round <= R.CHAMP_TRACKS.length) {
      // a championship stored before presets has no length: it was raced at Standard, so it continues at Standard
      return { tag: { id: v.id, round: v.round }, length: v.length === undefined ? (v.round > 1 ? 'standard' : null) : lengthOr(v.length) };
    }
  } catch { /* ignore */ }
  return null;
}
function writeConnectedChamp(tag: ChampionshipTag, length: RaceLengthId | null): void {
  const id = accounts.account?.id;
  if (!id) return;
  try { localStorage.setItem(accountKey(id, 'cchamp'), JSON.stringify(length ? { ...tag, length } : tag)); } catch { /* ignore */ }
}
/** This account's connected championship (round 1-4), kept per account in account-scoped storage. Only `id` and `round` go to the server. */
function connectedChamp(): ChampionshipTag {
  const had = readConnectedChamp();
  if (had) return had.tag;
  const c: ChampionshipTag = { id: `cc-${Date.now().toString(36)}`, round: 1 };
  writeConnectedChamp(c, null);
  return c;
}
/** The length this account's connected championship is racing, or null before its first round has been started. */
const connectedChampLength = (): RaceLengthId | null => readConnectedChamp()?.length ?? null;
/** Fix the championship's length as its first round is started; later rounds and resumes keep it. */
function keepConnectedChampLength(c: ChampionshipTag, length: RaceLengthId): RaceLengthId {
  writeConnectedChamp(c, length);
  return length;
}
/** A connected championship round the server classified: the next one is offered (after round 4, a new championship). */
function advanceConnectedChamp(r: ResultView): void {
  const id = accounts.account?.id;
  const c = r.championship;
  if (!id || !c || r.outcome !== 'completed') return;
  const cur = readConnectedChamp();
  if (!cur || cur.tag.id !== c.id || cur.tag.round !== c.round) return;
  // the next round keeps the length this one was raced at (the server's own record of it, else the stored choice)
  const length = r.settings?.length ? lengthOr(r.settings.length) : cur.length ?? 'standard';
  if (c.round >= R.CHAMP_TRACKS.length) { try { localStorage.removeItem(accountKey(id, 'cchamp')); } catch { /* ignore */ } }
  else writeConnectedChamp({ id: c.id, round: c.round + 1 }, length);
}

function onNetAwards(a: AwardsView): void {
  if (screen === 'netres' && netResult && netResult.raceId === a.raceId) {
    const el = overlay.querySelector('#r-awards');
    if (el) el.innerHTML = awardsHtml(netResult, a);
  }
}

function onNetNack(m: Extract<ServerMsg, { t: 'nack' }>): void {
  // a refused settings change (say, a length a seated older page cannot show, #132) leaves the room as it was: redraw the
  // lobby so its selectors show the room's real settings again, then say why
  if (m.ref === 'settings' && screen === 'lobby') showLobby();
  if (['start', 'settings', 'rematch', 'ready', 'livery'].includes(m.ref)) {
    const el = overlay.querySelector('#l-msg');
    if (el) el.textContent = t(m.code === 'not_ready' ? 'net.err.notReady' : refusalText(m.code)) + (m.detail ? ` (${m.detail})` : '');
  }
}

function onNetEnd(why: EndReason, detail?: string): void {
  void detail;
  if (why === 'expired' && accounts.account) void accounts.restore();
  // a resume refused after a dropped link names the room, so a driver who never saw the banner knows what happened
  const code = why === 'expired' && net?.room?.mode === 'multiplayer' ? net.room.code : undefined;
  // a car still out on track when its seat expired was retired by the server: the driver is told that too, as before #42
  const retired = !!netRaceId && net?.room?.state === 'race' && me().status === 'running';
  net = null;
  leaveNetRace();
  localId = SOLO_ID;
  mode = 'race';
  setRace(newRace());
  // on the pending card a refused resume means no result is coming: that card says so itself, with its way back (#43)
  if (netGuard.ended(why)) { netNotice = ''; return; }
  // a reconnect refused for its protocol: the server changed mid-session (upgraded → Reload, rolled back → Retry)
  if (why === 'outdated') { onProtocolRefused(); return; }
  netNotice = why === 'left' ? '' : code ? t(retired ? 'net.end.disconnectedRace' : 'net.end.disconnected', { code }) : t(`net.end.${why}`);
  if (why === 'left' || online.state !== 'available') showTitle(); else showOnline();
}

/** Back to watching (#135): the spectator view, with the target kept (or the one picked from the standings). */
function closeNetWait(): void { if (!spec.active && me().status !== 'running') enterSpectate(); resume(); }

/** Connection state, always visible while online: connecting, reconnecting (with how long the seat is held), retired. */
const banner = document.createElement('div');
banner.id = 'net-banner';
banner.setAttribute('role', 'status');
menuLayer.insertBefore(banner, overlay);
let bannerMemo = '';
/** This browser's held pedals for its own seat: sent the moment they change (and checked every frame), never another seat's. */
function sendHeld(): void {
  if (!net || !netRaceId) return;
  // spectating (#135) sends nothing held: the heartbeat keeps the seat, with neutral pedals for the driver's own finished car
  const drive = driving();
  net.setHeld(drive && input.held('throttle'), drive && input.held('brake'));
}
input.onChange = sendHeld;

function syncBanner(): void {
  let key = '', text = '';
  // a race holds the car; the lobby, online menu and final standings hold the seat (no car is on track there)
  if (net && net.conn === 'reconnecting') { key = 'rec'; text = t(reconnectTextId(screen), { n: net.room?.graceS ?? 20 }); }
  else if (net && net.conn === 'connecting') { key = 'con'; text = t('net.connecting'); }
  else if (net && netRaceId && (screen === 'race' || screen === 'netwait')) {
    const p = me();
    if (p.status === 'dnf' && p.dnfReason === 'retired') { key = 'ret'; text = t('net.retired'); }
    else if (netLag > 500) { key = 'lag'; text = t('net.lagging'); }
  }
  // runs every frame: the DOM is touched only when the text, its kind or the card placement changes
  const card = bannerOnCard(screen);
  const memo = `${key}|${card}|${text}`;
  if (memo === bannerMemo) return;
  bannerMemo = memo;
  banner.textContent = text;
  banner.className = key ? `show ${key}` : '';
  // on a menu card the banner joins the layout above the card (style.css); elsewhere it floats below the HUD
  app.classList.toggle('banner-card', !!key && card);
}

// mobile backgrounding and page teardown: controls were already released (suspend); the socket may be dropped by the browser,
// in which case the session resumes the same seat on return
window.addEventListener('pagehide', () => { net?.release(); });

// ------------------------------------------------------------ spectating (#135, docs/spectating.md)
/** Remember when the local driver's own race ended, once per race: the HUD's personal clock stops there. */
function noteDone(): void {
  const p = race.car(localId);
  if (myDoneT === null && p && p.status !== 'running' && race.phase !== 'countdown') myDoneT = p.status === 'finished' ? p.finishTime : race.raceTime;
}
/** Enter the spectator view when the local driver's race is over, and keep its target valid while it lasts. Every frame. */
function syncSpectate(): void {
  if (spec.active) { spec.ensure(race); return; }
  if (screen !== 'race' || (net && !netRaceId)) return;
  if (shouldSpectate(race, race.car(localId), !net)) enterSpectate();
}
/**
 * The spectator view: everything held is let go (keys, fingers, reverse, and the server's held pedals) and the driving pad is
 * hidden; the camera follows the leading car still running. Online the lost-contact safety net (#43) runs while watching, so a
 * dead link never leaves a silently frozen scene.
 */
function enterSpectate(): void {
  releaseDriving();
  noteDone();
  spec.enter(race);
  hud.setMore(false);
  syncPad();
  hud.toast(meLine(), me().status === 'finished' ? 'good' : 'warn');
  if (net && !netGuard.active) netGuard.start();
}
/** Leave the spectator view (results, leave, restart, a new race): the next race starts in driving mode. */
function endSpectate(): void {
  if (!spec.active) return;
  spec.reset();
  hud.spectate(null);
  // the pad and the held-input state come back with the race view; anything held needs a fresh press
  syncPad();
}
function specStep(dir: -1 | 1): void { if (spec.active) spec.step(race, dir); }
/** Standings / My result: the live standings card; Escape, T or Watch the race comes back. */
function showStandings(): void { if (spec.active) showNetWait(); }
/** Local only: finish the rest of the field now through the race's own run-on (a valid final classification), then results. */
function skipToResults(): void {
  if (net || !spec.active || !race.skipRunOut()) return;
  for (const e of race.events) handle(e);
  race.events.length = 0;
  showResults();
}
/** The local driver's own result line: always theirs, never the watched car's. */
function meLine(): string {
  const p = me();
  if (p.status === 'dq') return `${t('spec.youDq')} · ${t(`res.dqReason.${p.dqReason}`)}`;
  if (p.status === 'dnf') return t('spec.youDnf');
  return t('spec.youFinished', { n: race.order().filter((c) => c.status === 'finished').indexOf(p) + 1 });
}
function specView(): SpecView {
  const c = spec.target ? race.car(spec.target) : undefined;
  return {
    target: c ? { id: c.id, name: c.name, num: c.num, lap: c.lapsDone + 1, laps: race.targetLaps } : null,
    whole: spec.whole || !c, me: meLine(),
    lost: !!net && (net.conn === 'reconnecting' || (netGuard.active && netGuard.view === 'lost')),
    skip: !net, leave: !!net,
  };
}

// ------------------------------------------------------------ loop
/** one simulation step: physics, events, timing-line bookkeeping and ghost recording */
function tick(dt: number): void {
  prevPoses = race.cars.map(poseOf);
  // single-player adapter: this browser's held keys and touch pedals drive the local driver only
  // a spectating driver (#135) drives nothing: their own finished car gets neutral pedals, as the run-on would give it
  const drive = driving();
  race.update(dt, { [localId]: { up: drive && input.held('throttle'), down: drive && input.held('brake') } });
  for (const e of race.events) handle(e);
  race.events.length = 0;
  const p = me();
  if (p.crossed !== lastCrossed) { lastCrossed = p.crossed; onPlayerCross(); }
  recorder.sample(p, race.raceTime);
  noteDone();
  if (race.phase === 'done' && (screen === 'race' || screen === 'netwait')) showResults();
}
// ------------------------------------------------------------ client shell (#141, src/menu/*)
// The screens live in their own modules. Each is built once, here, with the overlay, the state above (read and written
// through accessors: it stays owned by this file) and the actions it calls; nothing runs until the title is shown below.
const { showOnline, awardsHtml, showLobby, showNetMenu, showNetWait, renderNetWaitView, renderNetWait, showNetResults } = createOnline({
  overlay, accounts, spec, netGuard, NAME_KEY, NLIV_KEY,
  get online() { return online; },
  get screen() { return screen; },
  get net() { return net; },
  get netRaceId() { return netRaceId; },
  get netResult() { return netResult; },
  get netNotice() { return netNotice; }, set netNotice(v) { netNotice = v; },
  get onlinePending() { return onlinePending; }, set onlinePending(v) { onlinePending = v; },
  get race() { return race; },
  get localId() { return localId; },
  me, enter, resume, toMenu, showTitle: () => showTitle(), closeNetWait, skipToResults, netName, netLivery, netLengths, netLength, netSetups, netSetup,
  connectedChamp, connectedChampLength, keepConnectedChampLength, accountsOn, entryIdentity, say, netBegin, netPbBefore,
  bindHowTo, bindRadios, chooseLength, syncSetupDesc, chooseSetup, settingsHtml, bindSettings,
});
const { accountEntryHtml, showAccount, localCareerNote } = createAccount({
  overlay, accounts,
  get screen() { return screen; },
  get net() { return net; },
  get acctNotice() { return acctNotice; }, set acctNotice(v) { acctNotice = v; },
  accountsOn, enter, showTitle: () => showTitle(), onIdentityChanged,
});
const { showResults, startChampRound, showChamp, showBoards } = createResults({
  overlay, sfx, freshIds,
  get mode() { return mode; },
  get camMode() { return camMode; }, set camMode(v) { camMode = v; },
  get race() { return race; },
  get localId() { return localId; },
  get pbBefore() { return pbBefore; },
  get champ() { return champ; },
  get champRoundSaved() { return champRoundSaved; }, set champRoundSaved(v) { champRoundSaved = v; },
  get carId() { return carId; }, set carId(v) { carId = v; },
  get lbTrack() { return lbTrack; }, set lbTrack(v) { lbTrack = v; },
  get lbKind() { return lbKind; }, set lbKind(v) { lbKind = v; },
  get lbSetup() { return lbSetup; }, set lbSetup(v) { lbSetup = v; },
  me, isMe, enter, applyTrack, startSession, restartSession, toMenu, showTitle: () => showTitle(), localCareerNote,
  bindRadios, syncSetupDesc, chooseSetup,
});
const { centreTrack, showTitle, showPause } = createTitle({
  overlay, sfx, autoQuality,
  get screen() { return screen; },
  get mode() { return mode; }, set mode(v) { mode = v; },
  get camMode() { return camMode; }, set camMode(v) { camMode = v; },
  get champ() { return champ; }, set champ(v) { champ = v; },
  get carId() { return carId; }, set carId(v) { carId = v; },
  get preset() { return preset; },
  get raceLen() { return raceLen; },
  get carSetupId() { return carSetupId; },
  get online() { return online; },
  get lbSetup() { return lbSetup; }, set lbSetup(v) { lbSetup = v; },
  get net() { return net; },
  enter, setRace, newRace, applyTrack, startSession, restartSession, resume, toMenu, startChampRound, showChamp, showBoards, showOnline, showAccount, showNetMenu,
  onlineLinksHtml, onlineNoticeHtml, syncRecheck, probeHealth, applyOnline, seatStore, netBegin,
  bindHowTo, bindTips, bindRadios, chooseLength, syncSetupDesc, chooseSetup, settingsHtml, bindSettings,
});

let last = performance.now();
let time = 0;
showTitle();
// the local standings card (#135) keeps the race running behind it, as the race view does
const simulating = (): boolean => !net && (screen === 'race' || screen === 'results' || screen === 'netwait');
function frame(now: number): void {
  // no WebGL: the page is the readable message (noWebgl), as it was before the view was split out
  if (viewState === 'nogl') return;
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
  // raw rAF timestamps, not the clamped dt: a 150 ms frame must read as 150 ms. Only a race on a visible page counts
  // (offline and online alike), so menus, pause, results and hidden-tab gaps never look like slow frames
  if (autoQuality.frame(now, screen === 'race' && !document.hidden, preset)) {
    setPreset('low');
    hud.toast(t('gfx.autoLow'), 'info');
  }
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
  syncSpectate();
  // spectating (#135): the camera follows the watched car, or shows the whole track; the local driver's own car otherwise
  const focus = spec.active ? spec.focus(race) : null;
  if (spec.active) updateCamera(dt, poses[Math.max(0, race.cars.indexOf(focus ?? me()))], focus ? 'follow' : 'full', focus?.v ?? 0);
  else updateCamera(dt, poses[Math.max(0, race.cars.indexOf(me()))]);
  syncCars(dt, time, poses);
  // the blended cars trail the live state by up to a step; the ghost must trail with them to line up
  ghost.update(race.raceTime - (1 - alpha) * STEP, screen === 'race' ? dt : 0);
  view?.syncArrows(race, me(), time);
  syncAudio();
  const hudShown = screen === 'race' || screen === 'pause' || screen === 'results' || screen === 'netwait';
  syncBanner();
  if (screen === 'netwait' && !net) renderNetWait();
  hud.frame(hudShown, race, dt, time, { mode: mode === 'online' ? 'race' : mode, me: localId, pbMs, doneT: myDoneT, spec: spec.active ? specView() : null, round: mode === 'champ' && champ ? `${champ.rounds.length + (champRoundSaved ? 0 : 1)}/${R.CHAMP_TRACKS.length}` : '' });
  view?.render();
}
requestAnimationFrame(frame);

// ------------------------------------------------------------ 3D view (#147)
/**
 * Fetch and build the 3D view (src/view3d.ts and Three.js, a chunk of their own). Called as soon as the title is up, so it is
 * normally there before Start is pressed; a start before then waits for it (startSession). Once only, unless it failed.
 */
function loadView(): Promise<void> {
  if (view || viewState === 'nogl') return Promise.resolve();
  if (viewLoading) return viewLoading;
  viewState = 'loading';
  syncViewNote();
  viewLoading = import('./view3d').then((m) => {
    let v: View3D;
    try {
      v = new m.View3D(app, vp, pixelRatioFor(preset, dpr), preset);
    } catch (err) {
      if (err instanceof m.NoWebglError) { noWebgl(); return; }
      viewState = 'failed'; viewLoading = null; pendingStart = null; syncViewNote();
      throw err;
    }
    attachView(v);
  }, (err: unknown) => {
    // the chunk did not arrive: offline, or an old tab whose build a deploy has replaced (the old chunk is gone)
    console.warn('3D view failed to load:', err);
    // a start that was waiting is dropped: the note says what happened, and Start works again once Try again has loaded it
    viewState = 'failed'; viewLoading = null; pendingStart = null;
    syncViewNote();
  });
  return viewLoading;
}
/** The 3D view is built: it draws the current circuit, race, ghost and camera from now on, and a waiting start goes ahead. */
function attachView(v: View3D): void {
  view = v;
  viewState = 'ready';
  v.canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });
  fitRenderer();
  rebuildVisuals();
  ghost.attach(v.ghostCar);
  syncViewNote();
  const p = pendingStart;
  pendingStart = null;
  if (p && screen === p.from) startSessionNow(p.m);
}
/** No WebGL: the same readable message the page showed before the view was split out, in place of the game. */
function noWebgl(): void {
  viewState = 'nogl';
  pendingStart = null;
  app.innerHTML = `<div class="fatal"><h1>${t('title.name')}</h1><p>${t('ui.noWebgl')}</p><p><small>${t('ui.noWebglHint')}</small></p></div>`;
}
function syncViewNote(): void {
  const raceUp = screen === 'race' || screen === 'pause' || screen === 'results' || screen === 'netwait';
  const show = viewState === 'failed' ? 'failed' : !view && viewState === 'loading' && (pendingStart || raceUp) ? 'loading' : '';
  if (viewNote.dataset.show === show) return;
  viewNote.dataset.show = show;
  viewNote.hidden = !show;
  viewNote.setAttribute('role', show === 'failed' ? 'alert' : 'status');
  if (show === 'loading') viewNote.innerHTML = `<p>${t('ui.viewLoading')}</p>`;
  else if (show === 'failed') {
    viewNote.innerHTML = `<p>${t('ui.viewFailed')}</p><div class="row"><button class="cta" id="v-reload">${t('ui.viewReload')}</button><button class="cta alt" id="v-retry">${t('ui.viewRetry')}</button></div>`;
    viewNote.querySelector('#v-reload')!.addEventListener('click', () => location.reload());
    viewNote.querySelector('#v-retry')!.addEventListener('click', () => { void loadView(); });
  } else viewNote.innerHTML = '';
}
void loadView();

// probed once the page has loaded, so scene building on a slow device cannot eat the probe's time budget
if (ONLINE_ENABLED) {
  const probe = (): void => {
    // session restoration only against a healthy server with accounts: a static or guest-only deploy never asks
    void probeHealth().then((st) => applyOnline(st, true));
  };
  if (document.readyState === 'complete') setTimeout(probe, 0); else window.addEventListener('load', () => setTimeout(probe, 0), { once: true });
}

// debug/test hooks
/**
 * Diagnostics only (scripts/browser-check.mjs `netbanner`, #64): show the lobby of a given room in a given connection state
 * without a server, so the banner layout can be checked in the default build, where online play is off. The session has no
 * socket and never opens one (its constructor throws); calling again with another state re-renders the same room.
 */
/** QA (#153): show the title as a given online status would, without a server (the Online and Sign in links, or a notice). */
function qaOnline(st: OnlineStatus): void {
  online = st;
  if (screen === 'title') showTitle();
}
function qaNetLobby(room: PublicRoom, meId: string, conn: Conn, lengths?: RaceLengthId[], setups?: SetupId[]): void {
  if (!net) {
    const NoSocket = function () { throw new Error('qa lobby: no socket'); } as unknown as SocketCtor;
    net = new NetSession('', NoSocket, {}, null);
    mode = 'online';
  }
  // `lengths`: the race-length presets the pretend server's welcome lists (#132); omitted, a server older than presets
  // `setups`: the car setups it lists (#133); omitted, a server older than setups
  net.client.welcome = lengths || setups ? { t: 'welcome', v: 0, server: 'qa', rules: 'qa', now: 0, ...(lengths ? { lengths } : {}), ...(setups ? { setups } : {}) } : null;
  net.room = room; net.me = meId; net.conn = conn;
  showLobby();
  syncBanner();
}

/**
 * Diagnostics only (scripts/browser-check.mjs `debrief`, #134): show a server result card for a given result without a
 * server (default build). `pbBests` stands in for the career bests a signed-in driver's page read at the race's start.
 */
function qaNetResult(r: ResultView, meId: string, pbBests?: CareerStats['bests']): void {
  if (!net) {
    const NoSocket = function () { throw new Error('qa result: no socket'); } as unknown as SocketCtor;
    net = new NetSession('', NoSocket, {}, null);
    mode = 'online';
  }
  net.me = meId; net.result = r;
  qaAccount = pbBests ? 'qa' : null;
  netPbBase = pbBests ? { raceId: r.raceId, account: 'qa', bests: pbBests } : null;
  netResult = r;
  // the card is drawn for that seat; the local race behind it (which has no such driver) keeps its own driver
  const keep = localId;
  localId = meId;
  try { showNetResults(r); } finally { localId = keep; }
}

// the full hook only in a dev server, a VITE_QA build or with ?qa=1; a default (production) build gets a minimal read-only one (#146)
installGameHook(window, hookLevel(import.meta.env, location.search), () => ({ get online() { return online; }, get auth() { return { state: accounts.auth.state, busy: accounts.busy, displayName: accounts.account?.displayName ?? null }; }, get net() { return net && { conn: net.conn, me: net.me, room: net.room, result: net.result, reconnects: net.reconnects, tick: netTick, lagMs: netLag, buf: netBuf.stats, raceId: netRaceId, held: net.client.held, ctlSeq: net.client.ctlSeq, actSeq: net.client.actSeq }; }, netDrop: () => net?.client.ws?.close(4000, 'qa drop'), qaNetLobby, qaNetResult, qaOnline, get race() { return race; }, T, R, applyTrack, startSession, showTitle, get mode() { return mode; }, get preset() { return preset; }, get touchMode() { return touchMode; }, setTouchMode, input, get audio() { return sfx.ctx?.state ?? null; }, get muted() { return sfx.muted; }, suspendAudio: () => sfx.ctx?.suspend(), get champ() { return champ; }, get raceLen() { return raceLen; }, get carSetup() { return carSetupId; }, get bays() { return bayPaint; }, get ghost() { return ghost; }, get pbMs() { return pbMs; }, get screen() { return screen; }, get view() { return camMode; }, get aspect() { return view ? view.camera.aspect : vp.w / vp.h; }, get mini() { return { w: hud.mW, h: hud.mH }; }, stepper, advance: (sec: number) => { for (let t = 0; t < sec && simulating(); t += STEP) tick(STEP); }, setView: (m: 'follow' | 'full') => { camMode = m; }, zoom: (span: number) => { camMode = 'follow'; followSpan = span; curSpan = span; }, snapCam: () => { const p = me(); camLead.set(0, 0); camTarget.set(p.x, 0, -p.y); }, get marker() { return view?.marker ?? null; }, get localId() { return localId; }, get spec() { return { active: spec.active, target: spec.target, whole: spec.whole, doneT: myDoneT }; }, setLocalSlot: (n: number) => { localSlot = Math.max(0, Math.min(DRIVERS.length - 1, Math.floor(n))); }, get camTarget() { return { x: camTarget.x, z: camTarget.z }; }, get motorMix() { return motorMix; }, get arrows() { return view && { lane: view.laneArrow, pit: view.pitArrow }; }, info: () => view?.info() ?? null, get view3d() { return viewState; }, loadView }), { screen: () => screen, online: () => online, preset: () => preset, mode: () => mode });
