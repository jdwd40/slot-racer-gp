// The online screens (#141, moved out of src/main.ts unchanged): the online menu (create, join, connected solo and
// championship), the room lobby, the online race menu, the live standings / pending card, the closed-room card and the
// server's final results with career points. The session handlers (netBegin, onNetState, onNetResult, ...) stay in
// src/main.ts and call in here. createOnline is called once by src/main.ts with the overlay, the hub state it reads and
// writes (through accessors: the state stays in main.ts) and the actions it calls.
import * as T from '../track';
import * as R from '../records';
import { t } from '../i18n';
import type { Car, DriverId, Race } from '../race';
import { lengthOr, type RaceLengthId } from '../raceLength';
import { setupOr, type SetupId } from '../carSetup';
import { comparePb, readDebrief } from '../debrief';
import { debriefHtml, debriefOpen } from '../debriefView';
import { escHtml, flags, fmt } from '../hud';
import type { Spectator } from '../spectate';
import type { OnlineStatus } from '../online';
import type { NetSession, ResultView } from '../net/session';
import type { AccountClient } from '../net/account';
import type { NetWaitGuard, NetWaitView } from '../net/netwait';
import { LIVERIES as NET_LIVERIES, LIMITS, cleanName, type AwardsView, type ChampionshipTag, type LiveryId, type PublicRoom } from '../net/protocol';
import { colorDot, controlsHtml, lengthRadiosHtml, lengthTag, setupChip, setupRadiosHtml, setupTag } from './controls';
import type { Screen } from './types';

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;
const hashCode = (): string => /^#room=([A-Za-z0-9]{6})$/.exec(location.hash)?.[1]?.toUpperCase() ?? '';
const modeLabel = (m: string): string => t(m === 'multiplayer' ? 'net.modeMulti' : m === 'solo' ? 'net.modeSolo' : m === 'championship' ? 'net.modeChamp' : m === 'practice' ? 'career.mode.practice' : 'net.modeOther');
const hexc = (c: number): string => '#' + c.toString(16).padStart(6, '0');

const STAND_HEAD = (): string => `<thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('res.best')}</th><th>${t('res.pits')}</th><th>${t('res.pen')}</th></tr></thead>`;


/** What the online screens use from the hub (src/main.ts). */
export interface OnlineDeps {
  readonly overlay: HTMLElement;
  readonly accounts: AccountClient;
  readonly spec: Spectator;
  readonly netGuard: NetWaitGuard;
  readonly NAME_KEY: string;
  readonly NLIV_KEY: string;
  readonly online: OnlineStatus;
  readonly screen: Screen;
  readonly net: NetSession | null;
  readonly netRaceId: string | null;
  readonly netResult: ResultView | null;
  netNotice: string;
  onlinePending: boolean;
  readonly race: Race;
  readonly localId: DriverId;
  me(): Car;
  enter(s: Screen): void;
  resume(): void;
  toMenu(): void;
  showTitle(): void;
  closeNetWait(): void;
  skipToResults(): void;
  netName(): string;
  netLivery(): LiveryId;
  netLengths(): readonly RaceLengthId[];
  netLength(): RaceLengthId;
  netSetups(): readonly SetupId[];
  netSetup(): SetupId;
  connectedChamp(): ChampionshipTag;
  connectedChampLength(): RaceLengthId | null;
  keepConnectedChampLength(c: ChampionshipTag, length: RaceLengthId): RaceLengthId;
  accountsOn(): boolean;
  entryIdentity(): string | undefined | null;
  say(msg: string): void;
  netBegin(req: (s: NetSession) => Promise<{ ok: true } | { ok: false; code: string; detail?: string }>): Promise<void>;
  netPbBefore(r: ResultView): number | null;
  // the bound menu controls (src/menu/controls.ts)
  bindHowTo(): void;
  bindRadios(name: string, choose: (id: string) => void): void;
  chooseLength(id: string): void;
  syncSetupDesc(name: string, id: SetupId): void;
  chooseSetup(id: string): void;
  settingsHtml(): string;
  bindSettings(): void;
}

/** The online screens bound to the hub: called once by src/main.ts. */
export function createOnline(hub: OnlineDeps) {
  const { overlay, accounts, spec, netGuard, NAME_KEY, NLIV_KEY, me, enter, resume, toMenu, showTitle, closeNetWait, skipToResults, netName, netLivery, netLengths, netLength, netSetups, netSetup,
    connectedChamp, connectedChampLength, keepConnectedChampLength, accountsOn, entryIdentity, say, netBegin, netPbBefore, bindHowTo, bindRadios, chooseLength, syncSetupDesc, chooseSetup, settingsHtml, bindSettings } = hub;
  /** The online menu: create a multiplayer room, join one by code, or start a connected solo race with AI. */
  function showOnline(): void {
    if (hub.online.state !== 'available') { showTitle(); return; }
    // a re-render of this menu (the sign-in check answered, another tab switched identity) keeps a room code being typed
    const typedCode = hub.screen === 'online' ? overlay.querySelector<HTMLInputElement>('#n-code')?.value : undefined;
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
    overlay.querySelector('#n-msg')!.textContent = hub.netNotice;
    // until the sign-in check answers, the page cannot say who would take the seat: room entry waits for it
    hub.onlinePending = entryIdentity() === null;
    if (hub.onlinePending) {
      for (const id of ['#n-create', '#n-join', '#n-solo', '#n-champ']) { const b = overlay.querySelector<HTMLButtonElement>(id); if (b) b.disabled = true; }
      if (!hub.netNotice) overlay.querySelector('#n-msg')!.textContent = t('acct.loading');
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
    overlay.querySelector('#n-back')!.addEventListener('click', () => { hub.netNotice = ''; showTitle(); });
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
      return `<tr class="${x.participant === hub.localId ? 'me' : ''}" data-pts="${x.points}"><td>#${p?.num ?? 0} ${esc(x.participant === hub.localId ? t('hud.you') : p?.name ?? '')}</td><td>${where}</td><td class="mono">+${x.points}</td></tr>`;
    }).join('');
    const mine = a.rows.find((x) => x.participant === hub.localId);
    const guestNote = mine && !mine.credit ? `<p><small>${t(accountsOn() ? 'career.youGuest' : 'career.noAccounts')}</small></p>` : '';
    const others = a.rows.some((x) => !x.credit) ? `<p><small>${t('career.noCredit')}</small></p>` : '';
    // nobody signed in: no accounts to save to, so no sync state either
    if (!rows) return guestNote;
    return `<div class="lbl2">${t('career.racePoints')}</div>
      <div class="tscroll"><table><thead><tr><th>${t('res.driver')}</th><th>#</th><th>${t('champ.points')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${guestNote}${others}
      <p class="sync" data-sync="${a.sync}" role="status">${t(`career.sync.${a.sync}`)}</p>`;
  }

  function seatRow(p: PublicRoom['participants'][number], hostId: string | null): string {
    const tags: string[] = [];
    if (p.id === hub.net?.me) tags.push(`<span class="chip yel">${t('hud.you')}</span>`);
    if (p.id === hostId) tags.push(`<span class="chip cyan">${t('net.host')}</span>`);
    if (p.left) tags.push(`<span class="chip red">${t('net.left')}</span>`);
    else if (!p.connected) tags.push(`<span class="chip org">${t('net.disconnected')}</span>`);
    if (!p.left && p.id !== hostId) tags.push(p.ready ? `<span class="chip grn">${t('net.ready')}</span>` : `<span class="chip dim">${t('net.notReady')}</span>`);
    const asked = p.liveryRequested ? ` <small>${t('net.asked', { c: t(`net.liv.${p.liveryRequested}`) })}</small>` : '';
    // every driver's setup is shown to everyone before the start (#133); a server older than setups names none (Balanced)
    return `<tr class="${p.id === hub.net?.me ? 'me' : ''}" data-pid="${esc(p.id)}" data-setup="${setupOr(p.setup)}"><td class="mono">#${p.num}</td><td>${colorDot(p.color)}<span class="nm">${esc(p.name)}</span>${asked} ${setupChip(p.setup)}</td><td>${tags.join(' ')}</td></tr>`;
  }

  /** The room: code to share, track, every driver's identity and state, AI slots, and what this browser may do. */
  function showLobby(): void {
    const r = hub.net?.room;
    if (!hub.net || !r) return;
    const first = hub.screen !== 'lobby';
    enter('lobby');
    overlay.className = 'overlay show';
    const host = hub.net.host;
    // while reconnecting the seat may be gone on the server: Start and Ready wait for the resume
    const live = hub.net.conn === 'connected' ? '' : 'disabled';
    const meP = r.participants.find((p) => p.id === hub.net!.me);
    const others = r.participants.filter((p) => p.id !== r.hostId && !p.left);
    const waitingFor = r.participants.length < r.minHumans ? t('net.needMore', { n: r.minHumans }) : r.participants.some((p) => !p.connected) ? t('net.waitConn') : others.some((p) => !p.ready) ? t('net.waitReady') : '';
    const trackTabs = host && r.mode !== 'championship' ? `<div class="tabs" role="radiogroup">${T.TRACKS.map((d) => `<button class="tab ${d.id === r.settings.track ? 'sel' : ''}" data-ntrack="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('')}</div>` : `<div class="lobby-track">${t(`track.${r.settings.track}.name`)}</div>`;
    // the race length (#132): every driver sees it before Ready/Start; only the host changes it, and only on a server that runs
    // presets (its rooms carry `length`). A championship round keeps its championship's length
    const len = lengthOr(r.settings.length);
    const lenRow = host && r.settings.length !== undefined && r.mode !== 'championship' && r.mode !== 'practice' && hub.net.lengths.length > 1
      ? lengthRadiosHtml('nlen', len, hub.net.lengths)
      : `<div class="lbl2">${t('len.label')}</div><div class="lobby-track lobby-len" id="l-len">${lengthTag(len)}</div>`;
    const aiRow = r.mode === 'multiplayer' ? (host ? `<label class="chk"><input type="checkbox" id="l-ai" ${r.settings.aiFill ? 'checked' : ''}> ${t('net.aiFill')}</label>` : `<small>${t(r.settings.aiFill ? 'net.aiOn' : 'net.aiOff')}</small>`) : '';
    const aiRows = r.ai.map((a) => `<tr class="ai" data-setup="${setupOr(a.setup)}"><td class="mono">#${a.num}</td><td>${colorDot(a.color)}<span class="nm">${esc(a.name)}</span> ${setupChip(a.setup)}</td><td><span class="chip dim">${t('net.aiSlot')}</span></td></tr>`).join('');
    // this driver's own setup (#133): only on a server that runs setups (its rooms list `setups`), only in the lobby. A room
    // a seated older page keeps to Balanced shows the others disabled and says why
    const offered = hub.net.setups;
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
    overlay.querySelectorAll<HTMLElement>('[data-ntrack]').forEach((b) => b.addEventListener('click', () => hub.net?.settings({ track: b.dataset.ntrack! })));
    bindRadios('nlen', (id) => { chooseLength(id); hub.net?.settings({ length: lengthOr(id) }); });
    overlay.querySelector<HTMLInputElement>('#l-ai')?.addEventListener('change', (e) => hub.net?.settings({ aiFill: (e.target as HTMLInputElement).checked }));
    bindRadios('nsetup', (id) => { chooseSetup(id); syncSetupDesc('nsetup', setupOr(id)); hub.net?.setup(setupOr(id)); });
    overlay.querySelectorAll<HTMLElement>('[data-mylivery]').forEach((b) => b.addEventListener('click', () => { try { localStorage.setItem(NLIV_KEY, b.dataset.mylivery!); } catch { /* ignore */ } hub.net?.livery(b.dataset.mylivery as LiveryId); }));
    overlay.querySelector('#l-start')?.addEventListener('click', () => hub.net?.start());
    overlay.querySelector('#l-ready')?.addEventListener('click', () => hub.net?.ready(!meP?.ready));
    overlay.querySelector('#l-leave')!.addEventListener('click', () => hub.net?.leave());
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
      if (hub.netResult && hub.netResult.raceId === hub.netRaceId) showNetResults(hub.netResult);
      else resume();   // a driver whose race is over goes back to spectating (#135)
    });
    overlay.querySelector('#o-leave')!.addEventListener('click', () => hub.net?.leave());
  }

  /** Standings rows from the server: positions only for classified finishers, explicit DQ and DNF, nothing estimated. */
  function standingRows(rows: { id: string; name: string; color: number; num: number; pos: number | null; status: string; time: number | null; best: number; pits: number; reason: string; lap?: string; setup?: SetupId }[], pick = false): string {
    return rows.map((x) => {
      // #135: on the live standings a car still racing can be picked to watch (never the driver's own: it is not running)
      const watch = pick && x.status === 'running' && x.id !== hub.localId ? ` <button class="cta alt small w-pick" data-watch="${esc(x.id)}">${t('spec.watchRow')}</button>` : '';
      const cell = x.status === 'dq' ? `<td class="mono dq">${t('res.dq')}</td>` : x.status === 'dnf' ? `<td class="mono">${t('res.dnf')}</td>` : x.status === 'running' ? `<td class="mono"><small>${t('net.stillRacing')}${x.lap ? ` · ${x.lap}` : ''}</small></td>` : `<td class="mono">${fmt(x.time ?? NaN)}</td>`;
      return `<tr class="${x.id === hub.localId ? 'me' : ''}" data-status="${x.status}"><td>${x.pos ?? '–'}</td><td>${colorDot(x.color)}#${x.num} ${esc(x.id === hub.localId ? t('hud.you') : x.name)} ${setupChip(x.setup)}${watch}</td>${cell}<td class="mono">${fmt(x.best)}</td><td>${x.pits}</td><td>${x.reason}</td></tr>`;
    }).join('');
  }
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
    const acts = hub.net
      ? `<button class="cta alt" id="w-leave">${t('net.leave')}</button>`
      : `<button class="cta alt" id="w-skip">${t('spec.skip')}</button><button class="cta alt" id="w-menu">${t('pause.menu')}</button>`;
    overlay.innerHTML = `<div class="card results netwait">
      <h2>${t('net.pendingTitle')}</h2>
      <div class="place" id="w-head"></div>
      <p><small>${t(hub.net ? 'net.pendingNote' : 'spec.localNote')}</small></p>
      <p class="deb-pending"><small>${t('deb.pending')}</small></p>
      <p id="w-lost" class="net-msg" role="status" aria-live="polite"></p>
      <div class="tscroll"><table>${STAND_HEAD()}<tbody id="w-rows"></tbody></table></div>
      <div class="row"><button class="cta" id="w-watch">${t('net.watch')}</button>${acts}</div>
    </div>`;
    overlay.querySelector('#w-watch')!.addEventListener('click', closeNetWait);
    overlay.querySelector('#w-leave')?.addEventListener('click', () => hub.net?.leave());
    overlay.querySelector('#w-skip')?.addEventListener('click', skipToResults);
    overlay.querySelector('#w-menu')?.addEventListener('click', toMenu);
    // a running car's Watch button: follow that car and go back to the race view (event delegation: the rows are redrawn)
    overlay.querySelector('#w-rows')!.addEventListener('click', (e) => {
      const b = (e.target as Element | null)?.closest<HTMLElement>('[data-watch]');
      if (!b || !spec.active) return;
      if (spec.pick(hub.race, b.dataset.watch!)) closeNetWait();
    });
    renderNetWait();
    // online, the safety net normally runs already (it started with spectating); a fresh window either way
    if (hub.net) netGuard.start();
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
    back.addEventListener('click', () => { if (hub.online.state === 'available') showOnline(); else showTitle(); });
    back.focus({ preventScroll: true });
  }

  function renderNetWait(): void {
    const headEl = overlay.querySelector('#w-head'), rowsEl = overlay.querySelector('#w-rows');
    if (!headEl || !rowsEl) return;
    const p = me();
    const rows = hub.race.order().map((c) => ({
      id: c.id, name: c.name, color: c.color, num: c.num, pos: null, status: c.status, time: c.status === 'finished' ? c.finishTime + c.timePen : null,
      best: c.bestLap, pits: c.pitStops, reason: c.status === 'dq' ? t(`res.dqReason.${c.dqReason}`) : c.status === 'dnf' ? t(`net.dnf.${c.dnfReason}`) : flags(c), lap: `${Math.min(hub.race.targetLaps, c.lapsDone + 1)}/${hub.race.targetLaps}`,
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
    const room = hub.net?.room;
    const host = !!hub.net?.host;
    const byId = new Map(r.participants.map((x) => [x.id, x]));
    const liv = (id: string): number => NET_LIVERIES.find((l) => l.id === byId.get(id)?.livery)?.color ?? 0x888888;
    let body: string, head: string;
    if (r.classification) {
      const rows = r.classification.map((x) => ({
        id: x.id, name: byId.get(x.id)?.name ?? x.id, color: liv(x.id), num: byId.get(x.id)?.num ?? 0, pos: x.pos, status: x.status, time: x.time, setup: byId.get(x.id)?.setup,
        best: x.bestLap, pits: x.pitStops, reason: x.status === 'dq' ? `<span class="flag sg">${t('hud.flagDq')}</span> <small>${t(`res.dqReason.${x.dqReason}`)}</small>` : x.status === 'dnf' ? `<small>${t(`net.dnf.${x.dnfReason}`)}</small>` : x.timePen > 0 ? `<span class="flag tp">+${x.timePen}s</span>` : '–',
      }));
      const mine = r.classification.find((x) => x.id === hub.localId);
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
      <div class="awards" id="r-awards">${awardsHtml(r, hub.net?.awards ?? null)}</div>
      <p><small>${t('net.resultNote')}</small></p>
      <div class="row">${canRematch ? (host ? `<button class="cta" id="r-rematch">${t('net.rematch')}</button>` : `<span class="net-msg">${t('net.waitRematch')}</span>`) : ''}<button class="cta alt" id="r-leave">${t('net.leave')}</button></div>
    </div>`;
    overlay.querySelector('#r-rematch')?.addEventListener('click', () => hub.net?.rematch());
    overlay.querySelector('#r-leave')!.addEventListener('click', () => { if (hub.net) hub.net.leave(); else showTitle(); });
  }

  return { showOnline, awardsHtml, showLobby, showNetMenu, showNetWait, renderNetWaitView, showNetClosed, renderNetWait, showNetResults };
}
