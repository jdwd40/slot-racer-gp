// Menu controls (#141, moved out of src/main.ts unchanged): the HTML for the race menu's legend, the How to play sheet's
// sections, the circuit map, the title's fold-out notes, the settings / race-length / car-setup radio groups and the small
// name and tag helpers the screens share. The pure HTML builders are plain functions; the ones that bind the overlay or
// read and change the hub's state come from createControls, which src/main.ts calls once with what they need.
import * as T from '../track';
import * as R from '../records';
import { t } from '../i18n';
import { LENGTH_IDS, lengthOr, raceLength, type RaceLengthId } from '../raceLength';
import { SETUP_IDS, setupOr, type SetupId } from '../carSetup';
import { PRESETS, type PresetId } from '../graphics';
import { TOUCH_MODES, type TouchMode } from '../input';
import type { AutoQuality } from '../autoQuality';
/** The keyboard grid: the How to play sheet's Keyboard section, and the compact legend on the race menu. */
export function keysHtml(cls: string): string {
  const row = (k: string, id: string): string => `<div class="krow"><span class="keys">${k}</span><span>${t(id)}</span></div>`;
  return `<div class="${cls}">
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
  </div>`;
}

/** The touch pad's buttons, each named as on the pad with what it does (#151): the sheet's Drive section and the touch legend. */
export function touchGridHtml(cls: string): string {
  const row = (b: string, id: string): string => `<div><dt>${t(`touch.${b}`)}</dt><dd>${t(id)}</dd></div>`;
  return `<dl class="${cls}">${row('throttle', 'how.drive.throttle')}${row('brake', 'how.drive.brake')}${row('lane', 'how.drive.lane')}${row('pit', 'how.drive.pit')}${row('defer', 'how.drive.defer')}</dl>`;
}

/** The How to play control on the title and the race menu (#151). */
export function howToButtonHtml(wrap = true): string {
  const b = `<button class="linkbtn" id="o-help" aria-haspopup="dialog">${t('how.open')}</button>`;
  return wrap ? `<div class="help-link">${b}</div>` : b;
}
/**
 * The race menu's legend: the keyboard grid, or on a touch screen what each pad button does, then How to play for the pit
 * and service rules.
 */
export function controlsHtml(): string {
  return `${touchGridHtml('touch-legend')}${keysHtml('controls')}${howToButtonHtml()}`;
}

const HOW_PIT = ['how.pit.1', 'how.pit.2', 'how.pit.3', 'how.pit.4', 'how.pit.5'];
const HOW_RULES = ['how.rules.1', 'how.rules.2', 'how.rules.3', 'how.rules.4', 'how.rules.5'];
/** The sheet's sections: on a touch screen Drive comes first, otherwise Keyboard does. */
export function howToHtml(touch: boolean): string {
  const list = (ids: string[]): string => `<ul>${ids.map((id) => `<li>${t(id)}</li>`).join('')}</ul>`;
  const sec = (key: string, title: string, body: string): string => `<section class="how-sec" data-how="${key}" aria-labelledby="how-${key}"><h3 id="how-${key}">${title}</h3>${body}</section>`;
  const drive = sec('drive', t('how.drive'), `${touch ? '' : `<p class="how-lead">${t('how.drive.touchLead')}</p>`}${touchGridHtml('how-touch')}`);
  const pit = sec('pit', t('how.pit'), list(HOW_PIT));
  const rules = sec('rules', t('how.rules'), list(HOW_RULES));
  const keys = sec('keys', t('how.keys'), keysHtml('how-keys'));
  return (touch ? [drive, pit, rules, keys] : [keys, pit, rules, drive]).join('');
}

/** Small SVG map of a circuit for the track picker. */
export function trackSvg(def: T.TrackDef): string {
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

/**
 * The title's progressive disclosure (#152): a note, the setup description, the rival blurbs, the play-mode notes and the
 * settings stay folded until their toggle is pressed, one tap each. Which ones are open is kept for this page load, so a title
 * redrawn by the online status answering (or a touch-mode change) leaves them as the player left them.
 */
export const titleOpen = new Set<string>();

/** The panel (or one of several panels, `part`) a toggle shows; `tag` is the element it is. */
export function tipHtml(key: string, body: string, tag = 'div', part = 0): string {
  return `<${tag} class="tip" data-tip="${key}" id="o-tip-${key}-${part}"${titleOpen.has(key) ? '' : ' hidden'}>${body}</${tag}>`;
}
/** A toggle for the panels `key` (`parts` of them): the round "i" beside a section label, named `label`, or with `link` a text link reading `label`. */
export function tipToggleHtml(key: string, label: string, parts = 1, link = '', id = ''): string {
  const ctl = Array.from({ length: parts }, (_, i) => `o-tip-${key}-${i}`).join(' ');
  const attrs = `type="button"${id ? ` id="${id}"` : ''} data-info="${key}" aria-expanded="${titleOpen.has(key)}" aria-controls="${ctl}"`;
  return link ? `<button class="${link}" ${attrs}>${label}</button>` : `<button class="info" ${attrs} aria-label="${label}"><span aria-hidden="true">i</span></button>`;
}
export const carName = (id: string): string => R.LIVERIES.find((l) => l.id === id)?.name ?? '';

const ARROW_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
/** A settings radio group for the title and pause cards, named by the data attribute its buttons carry; wire it up with bindRadios. */
export function radiosHtml(name: string, label: string, opts: readonly { id: string; label: string }[], current: string, extra = ''): string {
  const btns = opts.map((o) => {
    const on = o.id === current;
    return `<button class="tab ${on ? 'sel' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-${name}="${o.id}">${t(o.label)}</button>`;
  }).join('');
  return `<div class="gfx"><div class="lbl2" id="o-${name}">${t(label)}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div>${extra}</div>`;
}

/** A race-length preset's name, and its name with its lap count ("Endurance · 26 laps"), from the one preset table. */
export const lengthName = (id: RaceLengthId): string => t(`len.${id}`);
export const lengthTag = (id: RaceLengthId): string => t('len.tag', { name: lengthName(id), n: raceLength(id).laps });
/**
 * The race-length selector (#132): a radio group like the settings ones (bindRadios wires it), each choice showing its name
 * over its lap count so the three stay short enough to sit side by side on a phone. `name` is the data attribute.
 */
export function lengthRadiosHtml(name: string, current: RaceLengthId, ids: readonly RaceLengthId[] = LENGTH_IDS, note = '', fold = false): string {
  const btns = ids.map((id) => {
    const on = id === current;
    return `<button class="tab len ${on ? 'sel' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-${name}="${id}" aria-label="${lengthTag(id)}"><b>${lengthName(id)}</b> ${fold ? `<span class="sub">${t('len.laps', { n: raceLength(id).laps })}</span>` : `<small>${t('len.laps', { n: raceLength(id).laps })}</small>`}</button>`;
  }).join('');
  // folded (the title, #152): the note sits behind the "i" beside the label, in body-size text
  // (#153: the title lays the "i" at the end of the row of choices where that row has room, style.css)
  if (fold) return `<div class="gfx rlen"><div class="lbl2 has-info"><span id="o-${name}">${t('len.label')}</span>${note ? tipToggleHtml(name, t('info.len')) : ''}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div>${note ? tipHtml(name, `<p class="len-note">${note}</p>`) : ''}</div>`;
  return `<div class="gfx rlen"><div class="lbl2" id="o-${name}">${t('len.label')}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div>${note ? `<small class="len-note">${note}</small>` : ''}</div>`;
}
/** A car setup's name ("Speed") and its tag ("Speed setup"), from the one preset table (#133). */
export const setupName = (id: SetupId): string => t(`setup.${id}`);
export const setupTag = (id: SetupId): string => t('setup.tag', { name: setupName(id) });
/**
 * The car-setup selector (#133): a radio group like the length one (bindRadios wires it: click, tap or the arrow keys), each
 * choice its name over a one-word strength, and under it the chosen setup's strength and cost in plain words (a live region,
 * so a screen reader hears the change). `allowed`: the setups that may be chosen now (a room locked to Balanced disables the
 * rest, which stay visible). `name` is the data attribute.
 */
export function setupRadiosHtml(name: string, current: SetupId, ids: readonly SetupId[] = SETUP_IDS, note = '', allowed: readonly SetupId[] = ids, fold = false): string {
  const btns = ids.map((id) => {
    const on = id === current;
    const off = !allowed.includes(id) && !on;
    return `<button class="tab len csetup ${on ? 'sel' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-${name}="${id}" ${off ? 'disabled aria-disabled="true"' : ''} aria-label="${t(`setup.${id}.desc`)}"><b>${setupName(id)}</b> ${fold ? `<span class="sub">${t(`setup.${id}.short`)}</span>` : `<small>${t(`setup.${id}.short`)}</small>`}</button>`;
  }).join('');
  // folded (the title, #152): the chosen setup's strength and cost, and the note, behind the "i" (each choice's label still carries its own)
  if (fold) return `<div class="gfx rsetup" data-for="${name}"><div class="lbl2 has-info"><span id="o-${name}">${t('setup.label')}</span>${tipToggleHtml(name, t('info.setup'))}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div>${tipHtml(name, `<p class="setup-desc" id="o-${name}-desc" aria-live="polite">${t(`setup.${current}.desc`)}</p>${note ? `<p class="len-note">${note}</p>` : ''}`)}</div>`;
  return `<div class="gfx rsetup" data-for="${name}"><div class="lbl2" id="o-${name}">${t('setup.label')}</div><div class="tabs" role="radiogroup" aria-labelledby="o-${name}">${btns}</div><small class="setup-desc" id="o-${name}-desc" aria-live="polite">${t(`setup.${current}.desc`)}</small>${note ? `<small class="len-note">${note}</small>` : ''}</div>`;
}
const TOUCH_OPTS = TOUCH_MODES.map((id) => ({ id, label: `touch.${id}` }));
export function colorDot(c: number): string { return `<i style="background:#${c.toString(16).padStart(6, '0')}"></i>`; }

/** A driver's setup as a small text label (#133), for the lobby and results tables. */
export const setupChip = (id: SetupId | undefined): string => `<small class="setup-chip" data-setup="${setupOr(id)}">${setupName(setupOr(id))}</small>`;

/** What the bound controls use from the hub (src/main.ts): the overlay, the settings state and the actions that change it. */
export interface ControlsDeps {
  readonly overlay: HTMLElement;
  readonly autoQuality: AutoQuality;
  readonly preset: PresetId;
  readonly touchMode: TouchMode;
  raceLen: RaceLengthId;
  carSetupId: SetupId;
  setPreset(id: PresetId): void;
  setTouchMode(m: TouchMode): void;
  openHowTo(opener: HTMLElement | null): void;
}

/** The controls bound to the hub's overlay and state: called once by src/main.ts. */
export function createControls(hub: ControlsDeps) {
  const { overlay, autoQuality, setPreset, setTouchMode, openHowTo } = hub;
  function bindHowTo(): void {
    overlay.querySelector<HTMLElement>('#o-help')?.addEventListener('click', (e) => openHowTo(e.currentTarget as HTMLElement));
  }

  function bindTips(): void {
    overlay.querySelectorAll<HTMLButtonElement>('[data-info]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.info!;
      const on = !titleOpen.has(key);
      if (on) titleOpen.add(key); else titleOpen.delete(key);
      b.setAttribute('aria-expanded', String(on));
      overlay.querySelectorAll<HTMLElement>(`[data-tip="${key}"]`).forEach((p) => { p.hidden = !on; });
    }));
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

  /** Remember a race length picked anywhere (title, online menu, a room the driver hosts) for the next setup. */
  function chooseLength(id: string): void {
    hub.raceLen = lengthOr(id);
    R.saveLength(hub.raceLen);
  }

  /** Show the chosen setup's strength and cost under its selector. */
  function syncSetupDesc(name: string, id: SetupId): void {
    const el = overlay.querySelector(`#o-${name}-desc`);
    if (el) el.textContent = t(`setup.${id}.desc`);
  }
  /** Remember a car setup picked anywhere (title, online menu, own lobby seat) for the next race, practice or seat. */
  function chooseSetup(id: string): void {
    hub.carSetupId = setupOr(id);
    R.saveSetup(hub.carSetupId);
  }

  /** Under the graphics selector while the automatic switch to Low is in force: says why, and offers the way back. */
  function autoNoteHtml(): string {
    const to = autoQuality.undoTarget(hub.preset);
    if (!to) return '';
    const name = t(PRESETS.find((p) => p.id === to)!.label);
    return `<div class="gfx-auto" id="o-gfx-auto"><span class="auto-note">${t('gfx.autoLow')}</span> <button class="tab" id="o-gfx-undo">${t('gfx.autoUndo', { preset: name })}</button></div>`;
  }
  function settingsHtml(): string {
    return radiosHtml('preset', 'gfx.label', PRESETS, hub.preset, autoNoteHtml()) + radiosHtml('touch', 'touch.label', TOUCH_OPTS, hub.touchMode);
  }
  /** Re-mark the graphics selector after a change made outside it (undo), and drop the auto-switch note once it no longer applies. */
  function syncPresetRadios(): void {
    overlay.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((x) => {
      const on = x.dataset.preset === hub.preset;
      x.classList.toggle('sel', on); x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1;
    });
    if (!autoQuality.undoTarget(hub.preset)) overlay.querySelector('#o-gfx-auto')?.remove();
  }
  function bindSettings(): void {
    // a pick in the selector is the player's own choice, which the automatic fallback never overrides afterwards
    bindRadios('preset', (id) => { autoQuality.playerChose(); setPreset(id as PresetId); syncPresetRadios(); });
    bindRadios('touch', (id) => setTouchMode(id as TouchMode));
    overlay.querySelector('#o-gfx-undo')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const to = autoQuality.undo(hub.preset);
      if (to) setPreset(to);
      syncPresetRadios();
    });
  }

  return { bindHowTo, bindTips, bindRadios, chooseLength, syncSetupDesc, chooseSetup, autoNoteHtml, settingsHtml, syncPresetRadios, bindSettings };
}
