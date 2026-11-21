// The title and pause screens (#141, moved out of src/main.ts unchanged): the title card with its circuit picker, race
// options, car, play modes and links, and the local race menu. createTitle is called once by src/main.ts with the overlay,
// the hub state it reads and writes (through accessors: the state stays in main.ts) and the actions it starts.
import * as T from '../track';
import * as R from '../records';
import { t } from '../i18n';
import { DRIVERS, type Race } from '../race';
import { LENGTH_IDS, raceLength, type RaceLengthId } from '../raceLength';
import { SETUP_IDS, type SetupId } from '../carSetup';
import { afterRetry, type OnlineStatus } from '../online';
import { loadSeat, type NetSession } from '../net/session';
import type { PresetId } from '../graphics';
import type { AutoQuality } from '../autoQuality';
import type { Sfx } from '../audio';
import { carName, colorDot, controlsHtml, howToButtonHtml, lengthRadiosHtml, lengthTag, setupRadiosHtml, setupTag, tipHtml, tipToggleHtml, titleOpen, trackSvg } from './controls';
import type { Mode, Screen } from './types';
/** pre-race lineup: the three rivals and their driving styles */
function lineupHtml(): string {
  return `<div class="lineup">${DRIVERS.slice(1).map((d, i) => `<div class="rival">${colorDot(d.color)}<div><b>${d.name}</b><em>${t(`persona.${d.persona}.name`)}</em>${tipHtml('rivals', `<span class="blurb">${t(`persona.${d.persona}.desc`)}</span>`, 'span', i)}</div></div>`).join('')}</div>`;
}
/** The title's rivals (#153): one short line, the three names and styles, their blurbs behind the "i" at its end. */
function rivalsHtml(): string {
  return `<div class="rivals"><div class="lbl2 has-info"><span>${t('title.rivals')}</span>${tipToggleHtml('rivals', t('info.rivals'), DRIVERS.length - 1)}</div>${lineupHtml()}</div>`;
}

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

/** What the title and pause screens use from the hub (src/main.ts). */
export interface TitleDeps {
  readonly overlay: HTMLElement;
  readonly sfx: Sfx;
  readonly autoQuality: AutoQuality;
  readonly screen: Screen;
  mode: Mode;
  camMode: 'follow' | 'full';
  champ: R.Championship | null;
  carId: string;
  readonly preset: PresetId;
  readonly raceLen: RaceLengthId;
  readonly carSetupId: SetupId;
  readonly online: OnlineStatus;
  lbSetup: SetupId;
  readonly net: NetSession | null;
  enter(s: Screen): void;
  setRace(r: Race): void;
  newRace(): Race;
  applyTrack(id: string): void;
  startSession(m: Mode): void;
  restartSession(): void;
  resume(): void;
  toMenu(): void;
  startChampRound(): void;
  showChamp(finished: Race | null): void;
  showBoards(): void;
  showOnline(): void;
  showAccount(): void;
  showNetMenu(): void;
  onlineLinksHtml(): string;
  onlineNoticeHtml(): string;
  syncRecheck(): void;
  probeHealth(): Promise<OnlineStatus>;
  applyOnline(st: OnlineStatus, redraw?: boolean): void;
  seatStore(): Storage | null;
  netBegin(req: (s: NetSession) => Promise<{ ok: true } | { ok: false; code: string; detail?: string }>): Promise<void>;
  // the bound menu controls (src/menu/controls.ts)
  bindHowTo(): void;
  bindTips(): void;
  bindRadios(name: string, choose: (id: string) => void): void;
  chooseLength(id: string): void;
  syncSetupDesc(name: string, id: SetupId): void;
  chooseSetup(id: string): void;
  settingsHtml(): string;
  bindSettings(): void;
}

/** The title and pause screens bound to the hub: called once by src/main.ts. */
export function createTitle(hub: TitleDeps) {
  const { overlay, sfx, autoQuality, enter, setRace, newRace, applyTrack, startSession, restartSession, resume, toMenu, startChampRound, showChamp, showBoards, showOnline, showAccount, showNetMenu,
    onlineLinksHtml, onlineNoticeHtml, syncRecheck, probeHealth, applyOnline, seatStore, netBegin, bindHowTo, bindTips, bindRadios, chooseLength, syncSetupDesc, chooseSetup, settingsHtml, bindSettings } = hub;
  /** the title has opened Settings by itself once for the automatic-Low notice */
  let autoNoteShown = false;

  /** The title's cars (#153): a colour and a name each; on a phone the name is read out but not shown, so the four fit beside the initials. */
  function carPickerHtml(): string {
    return `<div class="cars" role="group" aria-labelledby="o-car-lbl">${R.LIVERIES.map((l) => `<button class="car ${l.id === hub.carId ? 'sel' : ''}" data-car="${l.id}" title="${l.name}" aria-pressed="${l.id === hub.carId}"><i style="background:#${l.color.toString(16).padStart(6, '0')}"></i><span class="cname">${l.name}</span></button>`).join('')}</div>`;
  }

  /**
   * The title's circuit picker (#153). On a desktop the five circuits sit in one compact row (map, name, lap length) with the
   * chosen one's description once under it. On a phone, or a phone on its side, the row is a snap-scrolling strip that shows
   * one circuit at a time, with Previous / Next either side and a dot per circuit: Previous, Next, a swipe or a tap on a card
   * chooses; a tap on the chosen card shows or hides its description, which starts hidden there.
   */
  let trackDescOpen = false;
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
        if (id && id !== T.DEF.id && hub.screen === 'title') pickTrack(id);
      };
      settle = window.setTimeout(done, 140);
    }, { passive: true });
  }

  function showTitle(): void {
    enter('title');
    hub.camMode = 'full';
    hub.mode = 'race';
    overlay.className = 'overlay show';
    const nRounds = R.CHAMP_TRACKS.length;
    let champBtns = `<button class="cta alt" id="o-champ">${t('title.champ')}</button>`;
    // a championship in progress keeps its own length (#132), so the button says which one it is
    // (a phone on its side shows the shorter label, so Practice, Continue and New share one row beside the circuit)
    if (hub.champ && !R.champDone(hub.champ)) champBtns = `<button class="cta alt" id="o-champ-cont"><span class="cc-long">${t('title.champContinue', { n: hub.champ.rounds.length + 1, m: nRounds })}</span><span class="cc-short">${t('title.champContinueShort', { n: hub.champ.rounds.length + 1, m: nRounds })}</span> <span class="sub">${lengthTag(hub.champ.length)} · ${setupTag(hub.champ.setup)}</span></button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
    else if (hub.champ) champBtns = `<button class="cta alt" id="o-champ-view">${t('title.champView')}</button><button class="cta alt small" id="o-champ">${t('title.champNew')}</button>`;
    // the automatic switch to Low (#66) says so in the graphics group: Settings opens by itself the first time that notice is due
    let autoOpened = false;
    if (autoQuality.undoTarget(hub.preset) && !autoNoteShown) { autoNoteShown = true; autoOpened = true; titleOpen.add('settings'); }
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
          <p id="o-goal">${t('title.goalShort', { n: raceLength(hub.raceLen).laps })}</p>
        </div>
        ${trackPickerHtml()}
      </div>
      <div class="t-main">
        <div class="setup">
          ${lengthRadiosHtml('rlen', hub.raceLen, LENGTH_IDS, t('len.note'), true)}
          ${setupRadiosHtml('rsetup', hub.carSetupId, SETUP_IDS, t('setup.note'), SETUP_IDS, true)}
          <div class="who">
            <label class="ini"><span class="lbl2">${t('title.initials')}</span><input id="o-ini" maxlength="${R.MAX_INITIALS}" placeholder="${R.ANON}" value="${R.savedInitialsRaw().replace(/"/g, '')}" autocomplete="off" autocapitalize="characters" enterkeyhint="done" spellcheck="false"></label>
            <div class="carpick"><span class="lbl2" id="o-car-lbl">${t('title.car')}<span class="car-now"> · <span id="o-car-name">${carName(hub.carId)}</span></span></span>${carPickerHtml()}</div>
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
        ${tipHtml('modes', `<p class="modes">${t('net.localNote')}</p>${hub.online.state === 'available' ? `<p class="modes">${t('net.onlineNote')}</p>` : ''}`)}
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
      hub.carId = b.dataset.car!; R.saveCar(hub.carId);
      overlay.querySelectorAll('.car').forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      overlay.querySelector('#o-car-name')!.textContent = carName(hub.carId);
      setRace(newRace());
    }));
    bindSettings();
    bindRadios('rlen', (id) => {
      chooseLength(id);
      overlay.querySelector('#o-goal')!.textContent = t('title.goalShort', { n: raceLength(hub.raceLen).laps });
      setRace(newRace());
    });
    // the setup is the next race's (#133): the grid shown behind the menu is rebuilt with it, nothing running is changed
    bindRadios('rsetup', (id) => { chooseSetup(id); syncSetupDesc('rsetup', hub.carSetupId); setRace(newRace()); });
    const ini = overlay.querySelector<HTMLInputElement>('#o-ini')!;
    ini.addEventListener('input', () => R.saveInitialsRaw(ini.value));
    ini.addEventListener('keydown', (e) => { if (e.key === 'Enter') ini.blur(); e.stopPropagation(); });
    overlay.querySelector('#o-start')!.addEventListener('click', () => { sfx.init(); startSession('race'); });
    overlay.querySelector('#o-practice')!.addEventListener('click', () => { sfx.init(); startSession('practice'); });
    // a new championship takes the length chosen now and keeps it for every round (#132)
    // ...and the setup chosen now for its first round (#133); it can be changed between rounds
    overlay.querySelector('#o-champ')!.addEventListener('click', () => { sfx.init(); hub.champ = R.newChamp(hub.carId, R.currentInitials(), hub.raceLen, hub.carSetupId); startChampRound(); });
    overlay.querySelector('#o-champ-cont')?.addEventListener('click', () => { sfx.init(); startChampRound(); });
    overlay.querySelector('#o-champ-view')?.addEventListener('click', () => { sfx.init(); showChamp(null); });
    overlay.querySelector('#o-boards')!.addEventListener('click', () => { sfx.init(); hub.lbSetup = hub.carSetupId; showBoards(); });
    // Settings opened by itself for the automatic-Low notice (#66, #152): the card scrolls just far enough to show it and its
    // Undo, which on a short screen would otherwise sit below the fold (Start Race stays in view: it is near the top)
    if (autoOpened) overlay.querySelector('#o-gfx-auto')?.scrollIntoView({ block: 'nearest' });
  }

  function showPause(): void {
    if (hub.net) { showNetMenu(); return; }
    enter('pause');
    overlay.className = 'overlay show';
    const title = hub.mode === 'practice' ? t('prac.title') : hub.mode === 'champ' && hub.champ ? t('champ.round', { n: hub.champ.rounds.length + 1, m: R.CHAMP_TRACKS.length }) : t('pause.title');
    overlay.innerHTML = `<div class="card">
      <h2>${title}</h2>
      ${hub.mode === 'practice' ? `<p>${t('prac.hint')}</p>` : ''}
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

  return { centreTrack, showTitle, showPause };
}
