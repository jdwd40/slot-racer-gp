import { ONLINE_ENABLED, afterProtocolRefusal, afterRetry, behindHtml, outdatedHtml, probeOnline, startRecheck, type OnlineStatus } from './online';
import * as T from './track';
import { Race, Car, RaceEvent, DRIVERS, PEN, SOLO_ID, DriverId, RosterEntry } from './race';
import { LENGTH_IDS, lengthOr, raceLength, type RaceLengthId } from './raceLength';
import { DEFAULT_SETUP, SETUP_IDS, setupOr, type SetupId } from './carSetup';
import { comparePb, readDebrief, type PbCompare } from './debrief';
import { debriefHtml, debriefOpen } from './debriefView';
import { bayPaints, type BayPaint } from './bays';
// the 3D view and Three.js are a separate chunk (#147): type-only here, loaded with import() by loadView below
import type { View3D } from './view3d';
import { Hud, fmt, carLabel, flags, escHtml, type SpecView } from './hud';
import { Spectator, shouldSpectate } from './spectate';
import { Sfx } from './audio';
import { t } from './i18n';
import * as R from './records';
import { GhostRecorder, GhostPlayer } from './ghost';
import { FixedStepper, STEP, MAX_GAP, Pose, blendPose } from './timing';
import { PresetId, pixelRatioFor, savedPreset, savePreset } from './graphics';
import { AutoQuality } from './autoQuality';
import { NetSession, loadSeat, refusalText, type Conn, type ResultView, type EndReason } from './net/session';
import { AccountClient, accountKey, type AuthError, type AuthState } from './net/account';
import { SnapBuffer, applySnapshot, localEvent, mirrorRace } from './net/mirror';
import { LIVERIES as NET_LIVERIES, LIMITS, cleanName, type AwardsView, type CareerStats, type ChampionshipTag, type LiveryId, type PublicRoom, type ServerMsg } from './net/protocol';
import type { RaceSnapshot, WireEvent } from './race';
import type { SocketCtor } from './net/client';
import { NetWaitGuard, type NetWaitView } from './net/netwait';
import { bannerOnCard, reconnectTextId } from './net/banner';
import { COARSE_QUERY, ControlsAnchor, DrivingInput, KEY_HOLDS, KEY_TAPS, PadButton, TouchMode, TouchPad, savedTouchMode, saveTouchMode, touchActive } from './input';
import { hookLevel, installGameHook } from './qaHook';
import { carName, colorDot, controlsHtml, createControls, howToButtonHtml, howToHtml, lengthName, lengthRadiosHtml, lengthTag, setupChip, setupName, setupRadiosHtml, setupTag, tipHtml, tipToggleHtml, titleOpen, trackSvg } from './menu/controls';

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

type Screen = 'title' | 'race' | 'pause' | 'results' | 'boards' | 'champ' | 'online' | 'lobby' | 'netwait' | 'netres' | 'account';
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

/** pre-race lineup: the three rivals and their driving styles */
function lineupHtml(): string {
  return `<div class="lineup">${DRIVERS.slice(1).map((d, i) => `<div class="rival">${colorDot(d.color)}<div><b>${d.name}</b><em>${t(`persona.${d.persona}.name`)}</em>${tipHtml('rivals', `<span class="blurb">${t(`persona.${d.persona}.desc`)}</span>`, 'span', i)}</div></div>`).join('')}</div>`;
}
/** The title's rivals (#153): one short line, the three names and styles, their blurbs behind the "i" at its end. */
function rivalsHtml(): string {
  return `<div class="rivals"><div class="lbl2 has-info"><span>${t('title.rivals')}</span>${tipToggleHtml('rivals', t('info.rivals'), DRIVERS.length - 1)}</div>${lineupHtml()}</div>`;
}

/** the title has opened Settings by itself once for the automatic-Low notice */
let autoNoteShown = false;

/** The title's cars (#153): a colour and a name each; on a phone the name is read out but not shown, so the four fit beside the initials. */
function carPickerHtml(): string {
  return `<div class="cars" role="group" aria-labelledby="o-car-lbl">${R.LIVERIES.map((l) => `<button class="car ${l.id === carId ? 'sel' : ''}" data-car="${l.id}" title="${l.name}" aria-pressed="${l.id === carId}"><i style="background:#${l.color.toString(16).padStart(6, '0')}"></i><span class="cname">${l.name}</span></button>`).join('')}</div>`;
}

/**
 * The title's circuit picker (#153). On a desktop the five circuits sit in one compact row (map, name, lap length) with the
 * chosen one's description once under it. On a phone, or a phone on its side, the row is a snap-scrolling strip that shows
 * one circuit at a time, with Previous / Next either side and a dot per circuit: Previous, Next, a swipe or a tap on a card
 * chooses; a tap on the chosen card shows or hides its description, which starts hidden there.
 */
let trackDescOpen = false;
function trackPickerHtml(): string {
  const cards = T.TRACKS.map((d) => `<button class="track ${d.id === T.DEF.id ? 'sel' : ''}" data-id="${d.id}" aria-pressed="${d.id === T.DEF.id}" aria-describedby="o-track-desc">
      ${trackSvg(d)}
      <span class="tname"><b>${t(`track.${d.id}.name`)}</b><em>${t('title.len', { n: Math.round(T.layout(d, 4).L) })}</em></span>
    </button>`).join('');
  const dots = T.TRACKS.map((d) => `<i class="${d.id === T.DEF.id ? 'sel' : ''}" data-dot="${d.id}"></i>`).join('');
  return `<div class="picker" role="group" aria-labelledby="o-track-lbl">
    <div class="lbl2" id="o-track-lbl">${t('title.track')}</div>
    <div class="pick-row">
      <button type="button" class="pick-nav" id="o-track-prev" aria-label="${t('title.trackPrev')}"><span aria-hidden="true">‹</span></button>
      <div class="tracks" id="o-tracks">${cards}</div>
      <button type="button" class="pick-nav" id="o-track-next" aria-label="${t('title.trackNext')}"><span aria-hidden="true">›</span></button>
    </div>
    <div class="dots" aria-hidden="true">${dots}</div>
    <p class="track-desc" id="o-track-desc">${t(`track.${T.DEF.id}.desc`)}</p>
  </div>`;
}
/** Centre the chosen circuit in the picker's strip (it only scrolls on a phone); `smooth` for Previous / Next. */
function centreTrack(smooth = false): void {
  const strip = overlay.querySelector<HTMLElement>('#o-tracks');
  const card = strip?.querySelector<HTMLElement>('.track.sel');
  if (!strip || !card || strip.scrollWidth <= strip.clientWidth + 1) return;
  const left = card.offsetLeft - strip.offsetLeft - (strip.clientWidth - card.offsetWidth) / 2;
  strip.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
}
/** Choose a circuit on the title: the world, the cards, the dots and the description follow. */
function pickTrack(id: string, scroll: 'smooth' | 'jump' | false = false): void {
  sfx.init();
  applyTrack(id);
  overlay.querySelectorAll<HTMLElement>('.track').forEach((x) => { const on = x.dataset.id === T.DEF.id; x.classList.toggle('sel', on); x.setAttribute('aria-pressed', String(on)); });
  overlay.querySelectorAll<HTMLElement>('[data-dot]').forEach((x) => x.classList.toggle('sel', x.dataset.dot === T.DEF.id));
  const desc = overlay.querySelector('#o-track-desc');
  if (desc) desc.textContent = t(`track.${T.DEF.id}.desc`);
  if (scroll) centreTrack(scroll === 'smooth');
}
function bindTrackPicker(): void {
  const strip = overlay.querySelector<HTMLElement>('#o-tracks')!;
  const card = overlay.querySelector<HTMLElement>('.card.title')!;
  const step = (k: number): void => {
    const i = T.TRACKS.findIndex((d) => d.id === T.DEF.id);
    const j = i + k;
    // a step past either end wraps round, at once rather than sliding across every circuit between
    pickTrack(T.TRACKS[(j + T.TRACKS.length) % T.TRACKS.length].id, j >= 0 && j < T.TRACKS.length ? 'smooth' : 'jump');
  };
  overlay.querySelector('#o-track-prev')!.addEventListener('click', () => step(-1));
  overlay.querySelector('#o-track-next')!.addEventListener('click', () => step(1));
  overlay.querySelectorAll<HTMLElement>('.track').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.id === T.DEF.id) { trackDescOpen = !trackDescOpen; card.classList.toggle('desc-open', trackDescOpen); return; }
    pickTrack(b.dataset.id!);
  }));
  // a swipe chooses the circuit it comes to rest on. Only a scroll the player makes (a finger or the wheel on the strip) does:
  // the strip re-centred after a resize, or scrolled to bring a card into view, leaves the choice alone
  let down = false, lastUser = -1e9, settle = 0;
  const user = (): void => { lastUser = performance.now(); };
  strip.addEventListener('pointerdown', () => { down = true; user(); });
  for (const ev of ['pointerup', 'pointercancel']) strip.addEventListener(ev, () => { down = false; user(); });
  strip.addEventListener('wheel', user, { passive: true });
  strip.addEventListener('touchmove', user, { passive: true });
  strip.addEventListener('scroll', () => {
    if (!down && performance.now() - lastUser > 700) return;
    window.clearTimeout(settle);
    const done = (): void => {
      if (down) { settle = window.setTimeout(done, 120); return; }
      const mid = strip.getBoundingClientRect().left + strip.clientWidth / 2;
      let best: HTMLElement | null = null, gap = 1e9;
      strip.querySelectorAll<HTMLElement>('.track').forEach((x) => { const r = x.getBoundingClientRect(), g = Math.abs(r.left + r.width / 2 - mid); if (g < gap) { gap = g; best = x; } });
      const id = (best as HTMLElement | null)?.dataset.id;
      if (id && id !== T.DEF.id && screen === 'title') pickTrack(id);
    };
    settle = window.setTimeout(done, 140);
  }, { passive: true });
}
// a rotation or a resized window keeps the chosen circuit in the middle of the strip
window.addEventListener('resize', () => { if (screen === 'title') requestAnimationFrame(() => centreTrack()); });

function showTitle(): void {
  enter('title');
  camMode = 'full';
  mode = 'race';
  overlay.className = 'overlay show';
  const nRounds = R.CHAMP_TRACKS.length;
  let champBtns = `<button class="cta alt" id="o-champ">${t('title.champ')}</button>`;
  // a championship in progress keeps its own length (#132), so the button says which one it is
  // (a phone on its side shows the shorter label, so Practice, Continue and New share one row beside the circuit)
  if (champ && !R.champDone(champ)) champBtns = `<button class="cta alt" id="o-champ-cont"><span class="cc-long">${t('title.champContinue', { n: champ.rounds.length + 1, m: nRounds })}</span><span class="cc-short">${t('title.champContinueShort', { n: champ.rounds.length + 1, m: nRounds })}</span> <span class="sub">${lengthTag(champ.length)} · ${setupTag(champ.setup)}</span></button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
  else if (champ) champBtns = `<button class="cta alt" id="o-champ-view">${t('title.champView')}</button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
  // the automatic switch to Low (#66) says so in the graphics group: Settings opens by itself the first time that notice is due
  let autoOpened = false;
  if (autoQuality.undoTarget(preset) && !autoNoteShown) { autoNoteShown = true; autoOpened = true; titleOpen.add('settings'); }
  // #152: body copy is 16 px and every control 44 px; the notes, the setup description, the rival blurbs, the play-mode notes
  // and the graphics / touch settings are folded behind a toggle each (one tap), still all on the card.
  // #153: mobile first, in the order a player needs: the circuit, the race options, Start Race (full width, never under
  // anything), Practice and Championship, then text links for the rest. No row of it is sticky, so nothing can cover Start.
  // A phone on its side puts the logo, circuit and links in a column left of the options and Start (style.css)
  overlay.innerHTML = `<div class="card title${trackDescOpen ? ' desc-open' : ''}">
    <div class="t-side">
      <div class="t-head">
        <div class="logo">${t('title.name')}</div>
        <div class="tag">${t('title.tag')}</div>
        <p id="o-goal">${t('title.goalShort', { n: raceLength(raceLen).laps })}</p>
      </div>
      ${trackPickerHtml()}
    </div>
    <div class="t-main">
      <div class="setup">
        ${lengthRadiosHtml('rlen', raceLen, LENGTH_IDS, t('len.note'), true)}
        ${setupRadiosHtml('rsetup', carSetupId, SETUP_IDS, t('setup.note'), SETUP_IDS, true)}
        <div class="who">
          <label class="ini"><span class="lbl2">${t('title.initials')}</span><input id="o-ini" maxlength="${R.MAX_INITIALS}" placeholder="${R.ANON}" value="${R.savedInitialsRaw().replace(/"/g, '')}" autocomplete="off" autocapitalize="characters" enterkeyhint="done" spellcheck="false"></label>
          <div class="carpick"><span class="lbl2" id="o-car-lbl">${t('title.car')}<span class="car-now"> · <span id="o-car-name">${carName(carId)}</span></span></span>${carPickerHtml()}</div>
        </div>
      </div>
      <div class="t-go">
        <button class="cta" id="o-start">${t('title.start')}</button>
        <div class="t-modes">
          <button class="cta alt" id="o-practice">${t('title.practice')}</button>
          ${champBtns}
        </div>
      </div>
    </div>
    <div class="t-more">
      <div class="t-links">
        <button class="linkbtn" id="o-boards">${t('title.boards')}</button>
        ${onlineLinksHtml()}
        ${howToButtonHtml(false)}
        ${tipToggleHtml('settings', t('title.settings'), 1, 'linkbtn', 'o-settings')}
        ${tipToggleHtml('modes', t('title.modesInfo'), 1, 'linkbtn', 'o-modes')}
      </div>
      ${onlineNoticeHtml()}
      ${tipHtml('settings', settingsHtml())}
      ${tipHtml('modes', `<p class="modes">${t('net.localNote')}</p>${online.state === 'available' ? `<p class="modes">${t('net.onlineNote')}</p>` : ''}`)}
      ${rivalsHtml()}
    </div>
  </div>`;
  syncRecheck();
  bindHowTo();
  bindTips();
  bindTrackPicker();
  centreTrack();
  overlay.querySelector('#o-online')?.addEventListener('click', () => { sfx.init(); showOnline(); });
  overlay.querySelector('#o-reload')?.addEventListener('click', () => location.reload());
  overlay.querySelector<HTMLButtonElement>('#o-retry')?.addEventListener('click', (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    void probeHealth().then((st) => applyOnline(afterRetry(st), true));
  });
  overlay.querySelector('#o-account')?.addEventListener('click', () => { sfx.init(); showAccount(); });
  overlay.querySelector('#o-rejoin')?.addEventListener('click', () => { sfx.init(); const st = loadSeat(seatStore()); if (st) void netBegin((n) => n.resume(st)); });
  overlay.querySelectorAll<HTMLElement>('.car').forEach((b) => b.addEventListener('click', () => {
    carId = b.dataset.car!; R.saveCar(carId);
    overlay.querySelectorAll('.car').forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    overlay.querySelector('#o-car-name')!.textContent = carName(carId);
    setRace(newRace());
  }));
  bindSettings();
  bindRadios('rlen', (id) => {
    chooseLength(id);
    overlay.querySelector('#o-goal')!.textContent = t('title.goalShort', { n: raceLength(raceLen).laps });
    setRace(newRace());
  });
  // the setup is the next race's (#133): the grid shown behind the menu is rebuilt with it, nothing running is changed
  bindRadios('rsetup', (id) => { chooseSetup(id); syncSetupDesc('rsetup', carSetupId); setRace(newRace()); });
  const ini = overlay.querySelector<HTMLInputElement>('#o-ini')!;
  ini.addEventListener('input', () => R.saveInitialsRaw(ini.value));
  ini.addEventListener('keydown', (e) => { if (e.key === 'Enter') ini.blur(); e.stopPropagation(); });
  overlay.querySelector('#o-start')!.addEventListener('click', () => { sfx.init(); startSession('race'); });
  overlay.querySelector('#o-practice')!.addEventListener('click', () => { sfx.init(); startSession('practice'); });
  // a new championship takes the length chosen now and keeps it for every round (#132)
  // ...and the setup chosen now for its first round (#133); it can be changed between rounds
  overlay.querySelector('#o-champ')!.addEventListener('click', () => { sfx.init(); champ = R.newChamp(carId, R.currentInitials(), raceLen, carSetupId); startChampRound(); });
  overlay.querySelector('#o-champ-cont')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
  overlay.querySelector('#o-champ-view')?.addEventListener('click', () => { sfx.init(); showChamp(null); });
  overlay.querySelector('#o-boards')!.addEventListener('click', () => { sfx.init(); lbSetup = carSetupId; showBoards(); });
  // Settings opened by itself for the automatic-Low notice (#66, #152): the card scrolls just far enough to show it and its
  // Undo, which on a short screen would otherwise sit below the fold (Start Race stays in view: it is near the top)
  if (autoOpened) overlay.querySelector('#o-gfx-auto')?.scrollIntoView({ block: 'nearest' });
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
  bindHowTo();
  overlay.querySelector('#o-resume')!.addEventListener('click', resume);
  overlay.querySelector('#o-restart')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

function resume(): void { enter('race'); overlay.className = 'overlay'; overlay.innerHTML = ''; stepper.rebase(); }

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;

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
  const rows = res.map((r, i) => `<tr class="${isMe(r.car) ? 'me' : ''}"><td>${r.status === 'finished' ? i + 1 : '–'}</td><td>${colorDot(r.car.color)}${esc(carLabel(r.car, localId))} ${setupChip(r.car.setup.id)}</td>
    ${timeCell(r, i)}
    <td class="mono">${fmt(r.car.bestLap)}</td><td>${r.car.pitStops}</td><td>${flags(r.car) || '–'}${r.status === 'dq' ? ` <small>${t(`res.dqReason.${r.car.dqReason}`)}</small>` : ''}</td></tr>`).join('');
  const place = mine.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${mine.dqReason}`)}` : mine.status === 'finished' ? t('res.youPlace', { n: pos }) : t('res.youDnf');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results">
    <div class="lbl2 res-len">${t(`track.${T.DEF.id}.name`)} · ${lengthTag(race.length.id)} · <span class="res-setup">${setupTag(mine.setup.id)}</span></div>
    <h2>${pos === 1 && mine.status === 'finished' ? '🏆 ' + t('res.win') : t('res.title')}</h2>
    <div class="place">${place}</div>
    <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${localDebrief(mine.status === 'finished' ? pos : null)}
    ${localCareerNote()}
    <div class="row"><button class="cta" id="o-again">${t('res.again')} <small>(R)</small></button><button class="cta alt" id="o-menu">${t('pause.menu')}</button></div>
  </div>`;
  overlay.querySelector('#o-again')!.addEventListener('click', restartSession);
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

/**
 * The local driver's debrief (#134) from this device's own race: frozen at the driver's finish, DQ or DNF, so the AI run-on
 * and the cool-down lap add nothing, and computed again identically however often the card is drawn.
 */
function localDebrief(pos: number | null): string {
  const p = me();
  if (race.phase !== 'done') return '';
  const d = race.debrief(p.id);
  return debriefHtml({
    d, pb: comparePb(pbBefore, p.bestLap > 0 ? p.bestLap : null), open: debriefOpen(),
    facts: { status: p.status, dqReason: p.dqReason, dnfReason: p.dnfReason, timePen: p.timePen, pos },
    where: `${t(`track.${race.T.DEF.id}.name`)} · ${lengthTag(race.length.id)} · ${setupTag(p.setup.id)}`,
  });
}

// ---- championship
const driverName = (idx: number): string => (idx === 0 ? t('hud.you') : ['', 'Red Comet', 'Blue Arrow', 'Green Viper'][idx]);
const driverColor = (idx: number): number => (idx === 0 ? R.livery(champ?.car ?? carId).color : [0, 0xe8322a, 0x2a6df0, 0x22b04b][idx]);

/** Store the finished round's result once (points are never awarded twice). */
function recordChampRound(): void {
  // only the race's final standings (every car terminal) are recorded: never a live or estimated order
  if (!champ || champRoundSaved || R.champDone(champ) || race.phase !== 'done' || !race.final) return;
  champ.rounds.push(R.roundRecord(T.DEF.id, race.final.map((x) => ({ car: { idx: x.slot }, status: x.status, time: x.time ?? 0 })), me().setup.id));
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
    // the round's own race (#134): the player's debrief under the round's classification (slot 0 is the player in a championship)
    if (finished === race && race.final) {
      const i = last.order.findIndex((o) => o.idx === 0);
      roundHtml += localDebrief(i >= 0 && !last.order[i].dnf && !last.order[i].dq ? i + 1 : null);
    }
  }
  const st = R.standings(c, 4);
  const stRows = st.map((x, i) => `<tr class="${x.idx === 0 ? 'me' : ''}"><td>${i + 1}</td><td>${colorDot(driverColor(x.idx))}${driverName(x.idx)}</td><td class="mono">${x.points}</td><td class="mono">${x.wins}</td><td class="mono">${x.seconds}</td></tr>`).join('');
  const roundsLine = R.CHAMP_TRACKS.map((id, i) => `<span class="rchip ${i < c.rounds.length ? 'done' : ''} ${i === c.rounds.length && !done ? 'next' : ''}">${i + 1}. ${t(`track.${id}.name`)}</span>`).join('');
  const champion = st[0];
  const head = done ? `<h2>🏆 ${t('champ.final')}</h2><div class="place">${champion.idx === 0 ? t('champ.youChampion') : t('champ.champion', { name: driverName(champion.idx) })}</div>` : `<h2>${t('champ.title')}</h2><div class="place">${t('champ.round', { n: c.rounds.length, m: nR })}</div>`;
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results champ">
    <div class="lbl2 res-len">${lengthTag(c.length)}</div>
    ${head}
    <div class="rounds">${roundsLine}</div>
    ${roundHtml}
    <h3>${done ? t('champ.final') : t('champ.standings')}</h3>
    <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('champ.points')}</th><th>${t('champ.wins')}</th><th>${t('champ.seconds')}</th></tr></thead><tbody>${stRows}</tbody></table></div>
    ${localCareerNote()}
    ${done ? '' : setupRadiosHtml('csetup', c.setup, SETUP_IDS, t('setup.champNote'))}
    <div class="row">${done ? '' : `<button class="cta" id="o-next">${t('champ.continue', { n: c.rounds.length + 1 })}</button>`}<button class="cta alt" id="o-menu">${t('champ.menu')}</button></div>
  </div>`;
  // between rounds only (#133): the next round races the setup chosen here; a round under way never changes
  bindRadios('csetup', (id) => { c.setup = setupOr(id); R.saveChamp(c); chooseSetup(id); syncSetupDesc('csetup', c.setup); });
  overlay.querySelector('#o-next')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
  overlay.querySelector('#o-menu')!.addEventListener('click', toMenu);
}

// ---- leaderboards
function showBoards(): void {
  enter('boards');
  overlay.className = 'overlay show';
  const tabs = T.TRACKS.map((d) => `<button class="tab ${d.id === lbTrack ? 'sel' : ''}" data-id="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('');
  const kinds = (['practice', 'race'] as R.BoardKind[]).map((k) => `<button class="tab kind ${k === lbKind ? 'sel' : ''}" data-kind="${k}">${t(`boards.${k}`)}</button>`).join('');
  const rows = R.board(lbKind, lbTrack, lbSetup);
  const body = rows.length ? rows.map((r, i) => `<tr class="${freshIds.has(r.id) ? 'fresh' : ''}"><td>${i + 1}</td><td>${r.initials}</td><td>${colorDot(R.livery(r.car).color)}${R.livery(r.car).name}</td><td class="mono">${R.fmtMs(r.ms)}</td><td>${freshIds.has(r.id) ? `<span class="chip yel">${t('boards.new')}</span>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">${t('boards.empty')}</td></tr>`;
  overlay.innerHTML = `<div class="card results boards">
    <h2>${t('boards.title')}</h2>
    <p>${t('boards.hint')} ${t('boards.setupHint')}</p>
    <div class="tabs">${tabs}</div>
    <div class="tabs">${kinds}</div>
    <div class="tabs" role="radiogroup" aria-label="${t('setup.label')}">${SETUP_IDS.map((id) => `<button class="tab setupf ${id === lbSetup ? 'sel' : ''}" role="radio" aria-checked="${id === lbSetup}" data-lbsetup="${id}">${setupName(id)}</button>`).join('')}</div>
    <div class="lbl2 lb-setup">${t(`track.${lbTrack}.name`)} · ${t(`boards.${lbKind}`)} · ${setupTag(lbSetup)}</div>
    <div class="tscroll"><table><thead><tr><th>${t('boards.rank')}</th><th>${t('boards.initials')}</th><th>${t('boards.car')}</th><th>${t('boards.time')}</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="row"><button class="cta alt" id="o-back">${t('boards.back')}</button></div>
  </div>`;
  overlay.querySelectorAll<HTMLElement>('.tab[data-id]').forEach((b) => b.addEventListener('click', () => { lbTrack = b.dataset.id!; showBoards(); }));
  overlay.querySelectorAll<HTMLElement>('.tab[data-kind]').forEach((b) => b.addEventListener('click', () => { lbKind = b.dataset.kind as R.BoardKind; showBoards(); }));
  overlay.querySelectorAll<HTMLElement>('.tab[data-lbsetup]').forEach((b) => b.addEventListener('click', () => { lbSetup = setupOr(b.dataset.lbsetup); showBoards(); (overlay.querySelector(`[data-lbsetup="${lbSetup}"]`) as HTMLElement | null)?.focus(); }));
  overlay.querySelector('#o-back')!.addEventListener('click', showTitle);
}

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
 * Size everything to the game's box, display and preset. Only the drawing buffer varies by preset: the canvas CSS size, aspect ratio and DOM HUD do not.
 * The race carries on.
 */
function fitRenderer(): void {
  vp = viewSize();
  dpr = window.devicePixelRatio;
  view?.fit(vp, pixelRatioFor(preset, dpr));
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
const hashCode = (): string => /^#room=([A-Za-z0-9]{6})$/.exec(location.hash)?.[1]?.toUpperCase() ?? '';
const modeLabel = (m: string): string => t(m === 'multiplayer' ? 'net.modeMulti' : m === 'solo' ? 'net.modeSolo' : m === 'championship' ? 'net.modeChamp' : m === 'practice' ? 'career.mode.practice' : 'net.modeOther');
const hexc = (c: number): string => '#' + c.toString(16).padStart(6, '0');

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
 * A hello refused for its protocol: the refusal does not carry the server's protocol, so ask /api/health which side is
 * newer. Only a newer server makes this page outdated (Reload); an older one (a rollback) is the Retry notice (#80).
 */
function onProtocolRefused(): void {
  online = { state: 'checking' };
  netNotice = '';
  showTitle();
  void probeHealth().then((st) => applyOnline(afterProtocolRefusal(st), true));
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
    ${netLengths().length > 1 ? lengthRadiosHtml('nrlen', netLength(), netLengths(), t('net.lengthNote', { len: lengthTag(netLength()) })) : `<p class="len-old"><small>${t('net.lengthOld')}</small></p>`}
    ${netSetups().length > 1 ? setupRadiosHtml('nrsetup', netSetup(), netSetups()) : `<p class="setup-old"><small>${t('setup.oldServer')}</small></p>`}
    <div class="modes-grid">
      <div class="mode-box"><b>${t('net.modeMulti')}</b><small>${t('net.multiDesc')}</small>
        <label class="chk"><input type="checkbox" id="n-ai"> ${t('net.aiFill')}</label>
        <button class="cta" id="n-create">${t('net.create')}</button>
        <div class="join"><input id="n-code" maxlength="${LIMITS.codeLength}" placeholder="${t('net.codePh')}" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go"><button class="cta alt" id="n-join">${t('net.join')}</button></div>
      </div>
      <div class="mode-box"><b>${t('net.modeSolo')}</b><small>${t('net.soloDesc')}</small><button class="cta alt" id="n-solo">${t('net.startSolo')}</button></div>
      ${accounts.account ? (() => { const c = connectedChamp(); return `<div class="mode-box"><b>${t('net.modeChamp')}</b><small>${t('net.champDesc', { n: c.round, m: R.CHAMP_TRACKS.length, track: t(`track.${R.CHAMP_TRACKS[c.round - 1]}.name`) })}</small><small class="champ-len" id="n-champ-len">${lengthTag(connectedChampLength() ?? netLength())}${connectedChampLength() ? '' : ` · ${t('len.champNote')}`}</small><button class="cta alt" id="n-champ">${t('net.startChamp', { n: c.round })}</button></div>`; })() : ''}
    </div>
    <p><small>${t(accounts.account ? 'career.onlineNote' : accountsOn() ? 'career.guestNote' : 'career.noAccounts')}</small></p>
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
    for (const id of ['#n-create', '#n-join', '#n-solo', '#n-champ']) { const b = overlay.querySelector<HTMLButtonElement>(id); if (b) b.disabled = true; }
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
    // the server's guest-name rule (cleanName): a name with nothing left after it (blank, invisible-only, "(AI)") is asked for again
    const n = cleanName(name.value);
    if (!n) { say(t('net.err.name')); name.focus(); return null; }
    return { n, expect };
  };
  const join = (): void => {
    const w = who(); if (!w) return;
    const c = code.value.trim().toUpperCase();
    if (c.length !== LIMITS.codeLength) { say(t('net.err.code')); code.focus(); return; }
    void netBegin((s) => s.join(c, w.n, netLivery(), w.expect, netSetup()));
  };
  // the setup goes only to a server that runs setups (NetSession drops it otherwise): every car there is Balanced (#133)
  bindRadios('nrsetup', (id) => { chooseSetup(id); syncSetupDesc('nrsetup', netSetup()); });
  // the length goes only to a server that runs presets (NetSession drops it otherwise): such a room is Standard
  bindRadios('nrlen', (id) => {
    chooseLength(id);
    const note = overlay.querySelector('.rlen .len-note');
    if (note) note.textContent = t('net.lengthNote', { len: lengthTag(netLength()) });
    const cl = overlay.querySelector('#n-champ-len');
    if (cl && !connectedChampLength()) cl.textContent = `${lengthTag(netLength())} · ${t('len.champNote')}`;
  });
  overlay.querySelector('#n-create')!.addEventListener('click', () => { const w = who(); if (w) void netBegin((s) => s.create(w.n, 'multiplayer', { track: T.DEF.id, aiFill: overlay.querySelector<HTMLInputElement>('#n-ai')!.checked, length: netLength() }, netLivery(), w.expect, undefined, netSetup())); });
  overlay.querySelector('#n-join')!.addEventListener('click', join);
  overlay.querySelector('#n-solo')!.addEventListener('click', () => { const w = who(); if (w) void netBegin((s) => s.create(w.n, 'solo', { track: T.DEF.id, length: netLength() }, netLivery(), w.expect, undefined, netSetup())); });
  overlay.querySelector('#n-champ')?.addEventListener('click', () => {
    const w = who(); if (!w) return;
    const c = connectedChamp();
    // the championship's length is chosen when its first round is started, and every later round keeps it (#132)
    const length = connectedChampLength() ?? keepConnectedChampLength(c, netLength());
    // each round's setup is the one chosen for it here (#133): a new choice is allowed between rounds, never during one
    void netBegin((s) => s.create(w.n, 'championship', { track: R.CHAMP_TRACKS[c.round - 1], length }, netLivery(), w.expect, c, netSetup()));
  });
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
  if (a.state === 'loading') return `<button class="linkbtn" id="o-account" disabled aria-busy="true">${t('acct.loading')}</button>`;
  if (a.state === 'unavailable') return `<button class="linkbtn" id="o-account">${t('acct.unavailableShort')}</button>`;
  // the display name is the driver's own public name; other people's text is always escaped
  if (a.state === 'signed-in') return `<button class="linkbtn" id="o-account" aria-label="${t('acct.profile')}">👤 <span class="nm">${esc(a.account.displayName)}</span></button>`;
  return `<button class="linkbtn" id="o-account">${t('acct.signIn')}</button>`;
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
      <section class="career" id="a-career" aria-busy="true" aria-live="polite"><h3>${t('career.title')}</h3><p><small>${t('career.loading')}</small></p></section>
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
    loadCareer(a.account.id);
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
        // the account was created but the server could not sign it in: send the driver to sign in (registering again would
        // only say the name is taken), with the username filled in
        if (reg && r.error === 'unavailable' && r.detail === 'account_created') {
          const name = user.value.trim();
          acctNotice = t('acct.err.createdNotSignedIn');
          showAccount('login');
          const u = overlay.querySelector<HTMLInputElement>('#a-user-in');
          if (u) u.value = name;
          return;
        }
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
    // the server refused this page's protocol: newer (upgraded after this page loaded) → Reload (#67); older → Retry (#80)
    if (r.code === 'protocol') { onProtocolRefused(); return; }
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
/** Local and offline races never earn account points: said wherever the server could have offered them. */
function localCareerNote(): string {
  if (!accountsOn()) return '';
  return `<p class="career-note"><small>${t(accounts.account ? 'career.localNote' : 'career.localNoteGuest')}</small></p>`;
}

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

/** The server's career points for this race, with whether they are stored yet. Nothing here is computed by the browser. */
function awardsHtml(r: ResultView, a: AwardsView | null): string {
  // a server without accounts records no careers: nothing to say
  if (!accountsOn() && !a?.rows.some((x) => x.credit)) return '';
  if (!a || a.raceId !== r.raceId) return `<p class="sync" data-sync="none"><small>${t('career.waiting')}</small></p>`;
  if (!a.eligible) return `<p class="sync" data-sync="none"><small>${t(a.reason === 'practice' ? 'career.practice' : 'career.incomplete')}</small></p>`;
  const byId = new Map(r.participants.map((x) => [x.id, x]));
  const rows = a.rows.filter((x) => x.credit).map((x) => {
    const p = byId.get(x.participant);
    const where = x.status === 'dq' ? t('res.dq') : x.status === 'dnf' ? t('res.dnf') : `P${x.pos}`;
    return `<tr class="${x.participant === localId ? 'me' : ''}" data-pts="${x.points}"><td>#${p?.num ?? 0} ${esc(x.participant === localId ? t('hud.you') : p?.name ?? '')}</td><td>${where}</td><td class="mono">+${x.points}</td></tr>`;
  }).join('');
  const mine = a.rows.find((x) => x.participant === localId);
  const guestNote = mine && !mine.credit ? `<p><small>${t(accountsOn() ? 'career.youGuest' : 'career.noAccounts')}</small></p>` : '';
  const others = a.rows.some((x) => !x.credit) ? `<p><small>${t('career.noCredit')}</small></p>` : '';
  // nobody signed in: no accounts to save to, so no sync state either
  if (!rows) return guestNote;
  return `<div class="lbl2">${t('career.racePoints')}</div>
    <div class="tscroll"><table><thead><tr><th>${t('res.driver')}</th><th>#</th><th>${t('champ.points')}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${guestNote}${others}
    <p class="sync" data-sync="${a.sync}" role="status">${t(`career.sync.${a.sync}`)}</p>`;
}

const fmtDate = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
const careerMode = (m: string): string => t(`career.mode.${m}`);

/** The signed-in driver's career from the server, rendered into the profile once it arrives (for that account only). */
function loadCareer(accountId: string): void {
  void accounts.stats().then((r) => {
    const el = overlay.querySelector<HTMLElement>('#a-career');
    if (screen !== 'account' || !el || accounts.account?.id !== accountId) return;
    el.removeAttribute('aria-busy');
    el.innerHTML = r.ok ? careerHtml(r.stats) : `<h3>${t('career.title')}</h3><p><small>${t(`acct.err.${r.error}`)}</small></p>`;
  });
}
function careerHtml(s: CareerStats): string {
  const c = s.career;
  const tile = (v: number | string, label: string, id: string): string => `<div class="tile" data-k="${id}"><b class="mono">${v}</b><small>${label}</small></div>`;
  const bests = s.bests.length ? `<div class="tscroll"><table><thead><tr><th>${t('career.circuit')}</th><th>${t('career.mode')}</th><th>${t('res.best')}</th></tr></thead><tbody>${s.bests.map((b) => `<tr data-mode="${b.mode}" data-setup="${setupOr(b.setup)}"><td>${t(`track.${b.track}.name`)}${b.current ? '' : ` <small>(${t(b.tuningCurrent === false ? 'career.oldTuning' : 'career.oldLayout')})</small>`}</td><td>${careerMode(b.mode)} ${setupChip(b.setup)}</td><td class="mono">${R.fmtMs(b.lapMs)} <small>${t('career.lapN', { n: b.lap })} · ${fmtDate(b.setAt)}</small></td></tr>`).join('')}</tbody></table></div>` : `<p><small>${t('career.noBests')}</small></p>`;
  const recent = s.recent.length ? `<div class="tscroll"><table><thead><tr><th>${t('career.date')}</th><th>${t('career.mode')}</th><th>${t('career.circuit')}</th><th>#</th><th>${t('champ.points')}</th></tr></thead><tbody>${s.recent.map((x) => `<tr data-race="${esc(x.raceId)}"><td>${fmtDate(x.finishedAt)}</td><td>${careerMode(x.mode)}${x.championship ? ` <small>R${x.championship.round}</small>` : ''} <small class="len">${lengthName(lengthOr(x.length))}</small> ${setupChip(x.setup)}</td><td>${t(`track.${x.track}.name`)}</td><td>${x.status === 'dq' ? t('res.dq') : x.status === 'dnf' ? t('res.dnf') : `P${x.pos}/${x.field}`}</td><td class="mono">${x.points}</td></tr>`).join('')}</tbody></table></div>` : `<p><small>${t('career.noRaces')}</small></p>`;
  return `<h3>${t('career.title')} · <span class="nm">${esc(s.displayName)}</span></h3>
    <div class="tiles">${tile(c.points, t('career.points'), 'points')}${tile(c.wins, '🥇', 'wins')}${tile(c.seconds, '🥈', 'seconds')}${tile(c.thirds, '🥉', 'thirds')}${tile(c.races, t('career.races'), 'races')}</div>
    <p><small>${t('career.policy', { a: s.scoring.podium[0] ?? 0, b: s.scoring.podium[1] ?? 0, c: s.scoring.podium[2] ?? 0 })}</small></p>
    <h3>${t('career.bests')}</h3>${bests}
    <h3>${t('career.recent')}</h3>${recent}`;
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

function seatRow(p: PublicRoom['participants'][number], hostId: string | null): string {
  const tags: string[] = [];
  if (p.id === net?.me) tags.push(`<span class="chip yel">${t('hud.you')}</span>`);
  if (p.id === hostId) tags.push(`<span class="chip cyan">${t('net.host')}</span>`);
  if (p.left) tags.push(`<span class="chip red">${t('net.left')}</span>`);
  else if (!p.connected) tags.push(`<span class="chip org">${t('net.disconnected')}</span>`);
  if (!p.left && p.id !== hostId) tags.push(p.ready ? `<span class="chip grn">${t('net.ready')}</span>` : `<span class="chip dim">${t('net.notReady')}</span>`);
  const asked = p.liveryRequested ? ` <small>${t('net.asked', { c: t(`net.liv.${p.liveryRequested}`) })}</small>` : '';
  // every driver's setup is shown to everyone before the start (#133); a server older than setups names none (Balanced)
  return `<tr class="${p.id === net?.me ? 'me' : ''}" data-pid="${esc(p.id)}" data-setup="${setupOr(p.setup)}"><td class="mono">#${p.num}</td><td>${colorDot(p.color)}<span class="nm">${esc(p.name)}</span>${asked} ${setupChip(p.setup)}</td><td>${tags.join(' ')}</td></tr>`;
}

/** The room: code to share, track, every driver's identity and state, AI slots, and what this browser may do. */
function showLobby(): void {
  const r = net?.room;
  if (!net || !r) return;
  const first = screen !== 'lobby';
  enter('lobby');
  overlay.className = 'overlay show';
  const host = net.host;
  // while reconnecting the seat may be gone on the server: Start and Ready wait for the resume
  const live = net.conn === 'connected' ? '' : 'disabled';
  const meP = r.participants.find((p) => p.id === net!.me);
  const others = r.participants.filter((p) => p.id !== r.hostId && !p.left);
  const waitingFor = r.participants.length < r.minHumans ? t('net.needMore', { n: r.minHumans }) : r.participants.some((p) => !p.connected) ? t('net.waitConn') : others.some((p) => !p.ready) ? t('net.waitReady') : '';
  const trackTabs = host && r.mode !== 'championship' ? `<div class="tabs" role="radiogroup">${T.TRACKS.map((d) => `<button class="tab ${d.id === r.settings.track ? 'sel' : ''}" data-ntrack="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('')}</div>` : `<div class="lobby-track">${t(`track.${r.settings.track}.name`)}</div>`;
  // the race length (#132): every driver sees it before Ready/Start; only the host changes it, and only on a server that runs
  // presets (its rooms carry `length`). A championship round keeps its championship's length
  const len = lengthOr(r.settings.length);
  const lenRow = host && r.settings.length !== undefined && r.mode !== 'championship' && r.mode !== 'practice' && net.lengths.length > 1
    ? lengthRadiosHtml('nlen', len, net.lengths)
    : `<div class="lbl2">${t('len.label')}</div><div class="lobby-track lobby-len" id="l-len">${lengthTag(len)}</div>`;
  const aiRow = r.mode === 'multiplayer' ? (host ? `<label class="chk"><input type="checkbox" id="l-ai" ${r.settings.aiFill ? 'checked' : ''}> ${t('net.aiFill')}</label>` : `<small>${t(r.settings.aiFill ? 'net.aiOn' : 'net.aiOff')}</small>`) : '';
  const aiRows = r.ai.map((a) => `<tr class="ai" data-setup="${setupOr(a.setup)}"><td class="mono">#${a.num}</td><td>${colorDot(a.color)}<span class="nm">${esc(a.name)}</span> ${setupChip(a.setup)}</td><td><span class="chip dim">${t('net.aiSlot')}</span></td></tr>`).join('');
  // this driver's own setup (#133): only on a server that runs setups (its rooms list `setups`), only in the lobby. A room
  // a seated older page keeps to Balanced shows the others disabled and says why
  const offered = net.setups;
  const allowed = r.setups ?? [];
  const mySetup = setupOr(meP?.setup);
  const setupRow = r.setups !== undefined && offered.length > 1 && meP && !meP.left
    ? setupRadiosHtml('nsetup', mySetup, offered, allowed.length > 1 ? t('setup.lobbyNote') : t('setup.lockNote'), allowed)
    : '';
  const free = r.maxHumans - r.participants.filter((p) => !p.left).length;
  const livs = NET_LIVERIES.map((l) => `<button class="car sq ${meP?.livery === l.id ? 'sel' : ''}" data-mylivery="${l.id}" aria-label="${t(`net.liv.${l.id}`)}" title="${t(`net.liv.${l.id}`)}"><i style="background:${hexc(l.color)}"></i></button>`).join('');
  overlay.innerHTML = `<div class="card results lobby">
    <div class="lbl2">${modeLabel(r.mode)}</div>
    ${r.mode === 'multiplayer' ? `<h2>${t('net.room')} <span class="code mono" id="l-code"></span></h2>
    <div class="row"><button class="cta alt small" id="l-copy">${t('net.copy')}</button>${typeof navigator.share === 'function' ? `<button class="cta alt small" id="l-share">${t('net.share')}</button>` : ''}</div>` : `<h2>${r.mode === 'championship' && r.championship ? t('net.champRound', { n: r.championship.round, m: R.CHAMP_TRACKS.length }) : t('net.modeSolo')}</h2>`}
    <div class="lbl2">${t('title.track')}</div>
    ${trackTabs}
    ${lenRow}
    ${aiRow}
    <div class="tscroll"><table><thead><tr><th>${t('net.num')}</th><th>${t('res.driver')}</th><th>${t('net.state')}</th></tr></thead><tbody>${r.participants.map((p) => seatRow(p, r.hostId)).join('')}${aiRows}</tbody></table></div>
    ${r.mode === 'multiplayer' ? `<p><small>${t('net.seats', { n: Math.max(0, free), m: r.maxHumans })}</small></p>` : ''}
    <div class="lbl2">${t('net.yourColour')}</div><div class="cars">${livs}</div>
    ${setupRow}
    <p id="l-msg" class="net-msg" role="status" aria-live="polite">${esc(host ? waitingFor : t('net.hostStarts'))}</p>
    <div class="row">
      ${host ? `<button class="cta" id="l-start" ${live} ${waitingFor && r.mode === 'multiplayer' ? 'aria-disabled="true"' : ''}>${t('net.start')}</button>` : `<button class="cta" id="l-ready" ${live}>${t(meP?.ready ? 'net.unready' : 'net.readyBtn')}</button>`}
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
  bindRadios('nlen', (id) => { chooseLength(id); net?.settings({ length: lengthOr(id) }); });
  overlay.querySelector<HTMLInputElement>('#l-ai')?.addEventListener('change', (e) => net?.settings({ aiFill: (e.target as HTMLInputElement).checked }));
  bindRadios('nsetup', (id) => { chooseSetup(id); syncSetupDesc('nsetup', setupOr(id)); net?.setup(setupOr(id)); });
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
  bindHowTo();
  overlay.querySelector('#o-resume')!.addEventListener('click', () => {
    if (netResult && netResult.raceId === netRaceId) showNetResults(netResult);
    else resume();   // a driver whose race is over goes back to spectating (#135)
  });
  overlay.querySelector('#o-leave')!.addEventListener('click', () => net?.leave());
}

/** Standings rows from the server: positions only for classified finishers, explicit DQ and DNF, nothing estimated. */
function standingRows(rows: { id: string; name: string; color: number; num: number; pos: number | null; status: string; time: number | null; best: number; pits: number; reason: string; lap?: string; setup?: SetupId }[], pick = false): string {
  return rows.map((x) => {
    // #135: on the live standings a car still racing can be picked to watch (never the driver's own: it is not running)
    const watch = pick && x.status === 'running' && x.id !== localId ? ` <button class="cta alt small w-pick" data-watch="${esc(x.id)}">${t('spec.watchRow')}</button>` : '';
    const cell = x.status === 'dq' ? `<td class="mono dq">${t('res.dq')}</td>` : x.status === 'dnf' ? `<td class="mono">${t('res.dnf')}</td>` : x.status === 'running' ? `<td class="mono"><small>${t('net.stillRacing')}${x.lap ? ` · ${x.lap}` : ''}</small></td>` : `<td class="mono">${fmt(x.time ?? NaN)}</td>`;
    return `<tr class="${x.id === localId ? 'me' : ''}" data-status="${x.status}"><td>${x.pos ?? '–'}</td><td>${colorDot(x.color)}#${x.num} ${esc(x.id === localId ? t('hud.you') : x.name)} ${setupChip(x.setup)}${watch}</td>${cell}<td class="mono">${fmt(x.best)}</td><td>${x.pits}</td><td>${x.reason}</td></tr>`;
  }).join('');
}
const STAND_HEAD = (): string => `<thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead>`;

/** what the pending card last showed: unchanged content is left alone, so a selection or a screen reader's place in the table is not reset for nothing */
let netWaitShown = { head: '', rows: '' };
/**
 * Standings / My result (#135): this driver is done but the race is not. Live state with no positions invented for anyone still
 * running, the driver's own result, and a way back to watching; a running car's row picks it as the one to watch. Online it is
 * the pending card (with Leave, and its lost-contact safety net, #43); locally the race carries on behind it, with Skip to
 * results and the menu.
 */
function showNetWait(): void {
  enter('netwait');
  netWaitShown = { head: '', rows: '' };
  overlay.className = 'overlay show see';
  // the card and its buttons are built once; each snapshot updates only the heading and the standings, so a press or the
  // keyboard focus on Watch or Leave survives the 20 Hz updates
  const acts = net
    ? `<button class="cta alt" id="w-leave">${t('net.leave')}</button>`
    : `<button class="cta alt" id="w-skip">${t('spec.skip')}</button><button class="cta alt" id="w-menu">${t('pause.menu')}</button>`;
  overlay.innerHTML = `<div class="card results netwait">
    <h2>${t('net.pendingTitle')}</h2>
    <div class="place" id="w-head"></div>
    <p><small>${t(net ? 'net.pendingNote' : 'spec.localNote')}</small></p>
    <p class="deb-pending"><small>${t('deb.pending')}</small></p>
    <p id="w-lost" class="net-msg" role="status" aria-live="polite"></p>
    <div class="tscroll"><table>${STAND_HEAD()}<tbody id="w-rows"></tbody></table></div>
    <div class="row"><button class="cta" id="w-watch">${t('net.watch')}</button>${acts}</div>
  </div>`;
  overlay.querySelector('#w-watch')!.addEventListener('click', closeNetWait);
  overlay.querySelector('#w-leave')?.addEventListener('click', () => net?.leave());
  overlay.querySelector('#w-skip')?.addEventListener('click', skipToResults);
  overlay.querySelector('#w-menu')?.addEventListener('click', toMenu);
  // a running car's Watch button: follow that car and go back to the race view (event delegation: the rows are redrawn)
  overlay.querySelector('#w-rows')!.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-watch]');
    if (!b || !spec.active) return;
    if (spec.pick(race, b.dataset.watch!)) closeNetWait();
  });
  renderNetWait();
  // online, the safety net normally runs already (it started with spectating); a fresh window either way
  if (net) netGuard.start();
}
function renderNetWaitView(v: NetWaitView): void {
  if (v === 'closed') { showNetClosed(); return; }
  const el = overlay.querySelector('#w-lost');
  if (el) el.textContent = v === 'lost' ? t('net.lostContact') : '';
}
/** The room closed (the resume was refused) before the server sent results: nothing more will come. */
function showNetClosed(): void {
  enter('netres');
  overlay.className = 'overlay show';
  overlay.innerHTML = `<div class="card results netclosed">
    <h2>${t('net.pendingTitle')}</h2>
    <p role="status">${t('net.closedNoResult')}</p>
    <div class="row"><button class="cta" id="w-menu">${t('net.backMenu')}</button></div>
  </div>`;
  const back = overlay.querySelector<HTMLButtonElement>('#w-menu')!;
  back.addEventListener('click', () => { if (online.state === 'available') showOnline(); else showTitle(); });
  back.focus({ preventScroll: true });
}
/** Back to watching (#135): the spectator view, with the target kept (or the one picked from the standings). */
function closeNetWait(): void { if (!spec.active && me().status !== 'running') enterSpectate(); resume(); }
function renderNetWait(): void {
  const headEl = overlay.querySelector('#w-head'), rowsEl = overlay.querySelector('#w-rows');
  if (!headEl || !rowsEl) return;
  const p = me();
  const rows = race.order().map((c) => ({
    id: c.id, name: c.name, color: c.color, num: c.num, pos: null, status: c.status, time: c.status === 'finished' ? c.finishTime + c.timePen : null,
    best: c.bestLap, pits: c.pitStops, reason: c.status === 'dq' ? t(`res.dqReason.${c.dqReason}`) : c.status === 'dnf' ? t(`net.dnf.${c.dnfReason}`) : flags(c), lap: `${Math.min(race.targetLaps, c.lapsDone + 1)}/${race.targetLaps}`,
    setup: c.setup.id,
  }));
  const head = p.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${p.dqReason}`)}` : p.status === 'dnf' ? t('res.youDnf') : t('net.youFinished');
  const body = standingRows(rows, spec.active);
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
      id: x.id, name: byId.get(x.id)?.name ?? x.id, color: liv(x.id), num: byId.get(x.id)?.num ?? 0, pos: x.pos, status: x.status, time: x.time, setup: byId.get(x.id)?.setup,
      best: x.bestLap, pits: x.pitStops, reason: x.status === 'dq' ? `<span class="flag sg">${t('hud.flagDq')}</span> <small>${t(`res.dqReason.${x.dqReason}`)}</small>` : x.status === 'dnf' ? `<small>${t(`net.dnf.${x.dnfReason}`)}</small>` : x.timePen > 0 ? `<span class="flag tp">+${x.timePen}s</span>` : '–',
    }));
    const mine = r.classification.find((x) => x.id === localId);
    head = !mine ? '' : mine.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${mine.dqReason}`)}` : mine.status === 'dnf' ? t('res.youDnf') : t('res.youPlace', { n: mine.pos ?? 0 });
    body = `<div class="tscroll"><table>${STAND_HEAD()}<tbody>${standingRows(rows)}</tbody></table></div>`;
    // #134: this driver's debrief, as the server collected it (never from events this page received); an older server's
    // result has none, which is shown as unavailable
    if (mine && r.outcome === 'completed') {
      const setup = setupOr(byId.get(mine.id)?.setup);
      body += debriefHtml({
        d: readDebrief(r, mine.id), pb: comparePb(netPbBefore(r), mine.bestLap > 0 ? mine.bestLap : null), open: debriefOpen(),
        facts: { status: mine.status, dqReason: mine.dqReason, dnfReason: mine.dnfReason, timePen: mine.timePen, pos: mine.pos },
        where: `${t(`track.${r.track.id}.name`)} · ${lengthTag(lengthOr(r.settings?.length))} · ${setupTag(setup)}`,
      });
    }
  } else {
    head = t('net.noResult');
    body = `<p>${t(r.outcome === 'aborted' ? 'net.aborted' : 'net.ended', { why: esc(r.abortReason ?? '') })}</p>`;
  }
  const canRematch = room?.state === 'results' && room.raceId === r.raceId;
  overlay.innerHTML = `<div class="card results netres" data-race="${esc(r.raceId)}">
    <div class="lbl2">${modeLabel(r.mode)} · ${t(`track.${r.track.id}.name`)} · ${lengthTag(lengthOr(r.settings?.length))}</div>
    <h2>${t('net.finalTitle')}</h2>
    <div class="place">${head}</div>
    ${body}
    <div class="awards" id="r-awards">${awardsHtml(r, net?.awards ?? null)}</div>
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
      v = new m.View3D(app, vp, pixelRatioFor(preset, dpr));
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
