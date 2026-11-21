// The offline results, championship and leaderboard screens (#141, moved out of src/main.ts unchanged): a local race's
// results with the driver's debrief, a championship's round results and standings with the between-rounds setup choice and
// the round bookkeeping, and the device's leaderboards. createResults is called once by src/main.ts with the overlay, the
// hub state it reads and writes (through accessors: the state stays in main.ts) and the actions it calls.
import * as T from '../track';
import * as R from '../records';
import { t } from '../i18n';
import type { Car, DriverId, Race } from '../race';
import { SETUP_IDS, setupOr, type SetupId } from '../carSetup';
import { comparePb } from '../debrief';
import { debriefHtml, debriefOpen } from '../debriefView';
import { carLabel, escHtml, flags, fmt } from '../hud';
import type { Sfx } from '../audio';
import { colorDot, lengthTag, setupChip, setupName, setupRadiosHtml, setupTag } from './controls';
import type { Mode, Screen } from './types';

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;

/** What the results, championship and leaderboard screens use from the hub (src/main.ts). */
export interface ResultsDeps {
  readonly overlay: HTMLElement;
  readonly sfx: Sfx;
  readonly freshIds: Set<string>;
  readonly mode: Mode;
  camMode: 'follow' | 'full';
  readonly race: Race;
  readonly localId: DriverId;
  readonly pbBefore: number | null;
  readonly champ: R.Championship | null;
  champRoundSaved: boolean;
  carId: string;
  lbTrack: string;
  lbKind: R.BoardKind;
  lbSetup: SetupId;
  me(): Car;
  isMe(c: Car): boolean;
  enter(s: Screen): void;
  applyTrack(id: string): void;
  startSession(m: Mode): void;
  restartSession(): void;
  toMenu(): void;
  showTitle(): void;
  localCareerNote(): string;
  // the bound menu controls (src/menu/controls.ts)
  bindRadios(name: string, choose: (id: string) => void): void;
  syncSetupDesc(name: string, id: SetupId): void;
  chooseSetup(id: string): void;
}

/** The results, championship and leaderboard screens bound to the hub: called once by src/main.ts. */
export function createResults(hub: ResultsDeps) {
  const { overlay, sfx, freshIds, me, isMe, enter, applyTrack, startSession, restartSession, toMenu, showTitle, localCareerNote, bindRadios, syncSetupDesc, chooseSetup } = hub;
  function showResults(): void {
    if (hub.mode === 'champ') { recordChampRound(); showChamp(hub.race); return; }
    enter('results');
    const res = hub.race.results();
    const mine = me();
    const pos = res.findIndex((r) => isMe(r.car)) + 1;
    // classified rows only get a position and a time; DQ and DNF rows say so instead and never inherit a place
    const winner = res[0].status === 'finished' ? res[0].time : NaN;
    const timeCell = (r: (typeof res)[number], i: number): string => {
      if (r.status === 'dq') return `<td class="mono dq">${t('res.dq')}</td>`;
      if (r.status === 'dnf') return `<td class="mono">${t('res.dnf')}</td>`;
      return `<td class="mono">${i === 0 ? fmt(r.time) : '+' + (r.time - winner).toFixed(1) + 's'}${r.est ? ` <small>(${t('res.est')})</small>` : ''}</td>`;
    };
    const rows = res.map((r, i) => `<tr class="${isMe(r.car) ? 'me' : ''}"><td>${r.status === 'finished' ? i + 1 : '–'}</td><td>${colorDot(r.car.color)}${esc(carLabel(r.car, hub.localId))} ${setupChip(r.car.setup.id)}</td>
      ${timeCell(r, i)}
      <td class="mono">${fmt(r.car.bestLap)}</td><td>${r.car.pitStops}</td><td>${flags(r.car) || '–'}${r.status === 'dq' ? ` <small>${t(`res.dqReason.${r.car.dqReason}`)}</small>` : ''}</td></tr>`).join('');
    const place = mine.status === 'dq' ? `${t('res.youDq')} · ${t(`res.dqReason.${mine.dqReason}`)}` : mine.status === 'finished' ? t('res.youPlace', { n: pos }) : t('res.youDnf');
    overlay.className = 'overlay show';
    overlay.innerHTML = `<div class="card results">
      <div class="lbl2 res-len">${t(`track.${T.DEF.id}.name`)} · ${lengthTag(hub.race.length.id)} · <span class="res-setup">${setupTag(mine.setup.id)}</span></div>
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
    if (hub.race.phase !== 'done') return '';
    const d = hub.race.debrief(p.id);
    return debriefHtml({
      d, pb: comparePb(hub.pbBefore, p.bestLap > 0 ? p.bestLap : null), open: debriefOpen(),
      facts: { status: p.status, dqReason: p.dqReason, dnfReason: p.dnfReason, timePen: p.timePen, pos },
      where: `${t(`track.${hub.race.T.DEF.id}.name`)} · ${lengthTag(hub.race.length.id)} · ${setupTag(p.setup.id)}`,
    });
  }

  // ---- championship
  const driverName = (idx: number): string => (idx === 0 ? t('hud.you') : ['', 'Red Comet', 'Blue Arrow', 'Green Viper'][idx]);
  const driverColor = (idx: number): number => (idx === 0 ? R.livery(hub.champ?.car ?? hub.carId).color : [0, 0xe8322a, 0x2a6df0, 0x22b04b][idx]);

  /** Store the finished round's result once (points are never awarded twice). */
  function recordChampRound(): void {
    // only the race's final standings (every car terminal) are recorded: never a live or estimated order
    if (!hub.champ || hub.champRoundSaved || R.champDone(hub.champ) || hub.race.phase !== 'done' || !hub.race.final) return;
    hub.champ.rounds.push(R.roundRecord(T.DEF.id, hub.race.final.map((x) => ({ car: { idx: x.slot }, status: x.status, time: x.time ?? 0 })), me().setup.id));
    R.saveChamp(hub.champ);
    hub.champRoundSaved = true;
  }

  function startChampRound(): void {
    if (!hub.champ || R.champDone(hub.champ)) { showTitle(); return; }
    hub.carId = hub.champ.car;
    applyTrack(R.CHAMP_TRACKS[hub.champ.rounds.length]);
    hub.champRoundSaved = false;
    startSession('champ');
  }

  /** Round results + cumulative standings (after a race), or the final table. */
  function showChamp(finished: Race | null): void {
    if (!hub.champ) { showTitle(); return; }
    enter('champ');
    hub.camMode = 'full';
    const c = hub.champ;
    const nR = R.CHAMP_TRACKS.length;
    const done = R.champDone(c);
    const last = c.rounds[c.rounds.length - 1];
    let roundHtml = '';
    if (finished && last) {
      const rows = last.order.map((o, i) => `<tr class="${o.idx === 0 ? 'me' : ''}"><td>${o.dq || o.dnf ? '–' : i + 1}</td><td>${colorDot(driverColor(o.idx))}${driverName(o.idx)}</td><td class="mono">${o.dq ? t('champ.dq') : o.dnf ? t('champ.dnf') : fmt(o.time)}</td><td class="mono">${R.roundPoints(last, i)}</td></tr>`).join('');
      roundHtml = `<h3>${t('champ.roundResults')} · ${t(`track.${last.track}.name`)}</h3>
        <div class="tscroll"><table><thead><tr><th>#</th><th>${t('res.driver')}</th><th>${t('res.time')}</th><th>${t('champ.points')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      // the round's own race (#134): the player's debrief under the round's classification (slot 0 is the player in a championship)
      if (finished === hub.race && hub.race.final) {
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
    const tabs = T.TRACKS.map((d) => `<button class="tab ${d.id === hub.lbTrack ? 'sel' : ''}" data-id="${d.id}">${t(`track.${d.id}.name`)}</button>`).join('');
    const kinds = (['practice', 'race'] as R.BoardKind[]).map((k) => `<button class="tab kind ${k === hub.lbKind ? 'sel' : ''}" data-kind="${k}">${t(`boards.${k}`)}</button>`).join('');
    const rows = R.board(hub.lbKind, hub.lbTrack, hub.lbSetup);
    const body = rows.length ? rows.map((r, i) => `<tr class="${freshIds.has(r.id) ? 'fresh' : ''}"><td>${i + 1}</td><td>${r.initials}</td><td>${colorDot(R.livery(r.car).color)}${R.livery(r.car).name}</td><td class="mono">${R.fmtMs(r.ms)}</td><td>${freshIds.has(r.id) ? `<span class="chip yel">${t('boards.new')}</span>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">${t('boards.empty')}</td></tr>`;
    overlay.innerHTML = `<div class="card results boards">
      <h2>${t('boards.title')}</h2>
      <p>${t('boards.hint')} ${t('boards.setupHint')}</p>
      <div class="tabs">${tabs}</div>
      <div class="tabs">${kinds}</div>
      <div class="tabs" role="radiogroup" aria-label="${t('setup.label')}">${SETUP_IDS.map((id) => `<button class="tab setupf ${id === hub.lbSetup ? 'sel' : ''}" role="radio" aria-checked="${id === hub.lbSetup}" data-lbsetup="${id}">${setupName(id)}</button>`).join('')}</div>
      <div class="lbl2 lb-setup">${t(`track.${hub.lbTrack}.name`)} · ${t(`boards.${hub.lbKind}`)} · ${setupTag(hub.lbSetup)}</div>
      <div class="tscroll"><table><thead><tr><th>${t('boards.rank')}</th><th>${t('boards.initials')}</th><th>${t('boards.car')}</th><th>${t('boards.time')}</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="row"><button class="cta alt" id="o-back">${t('boards.back')}</button></div>
    </div>`;
    overlay.querySelectorAll<HTMLElement>('.tab[data-id]').forEach((b) => b.addEventListener('click', () => { hub.lbTrack = b.dataset.id!; showBoards(); }));
    overlay.querySelectorAll<HTMLElement>('.tab[data-kind]').forEach((b) => b.addEventListener('click', () => { hub.lbKind = b.dataset.kind as R.BoardKind; showBoards(); }));
    overlay.querySelectorAll<HTMLElement>('.tab[data-lbsetup]').forEach((b) => b.addEventListener('click', () => { hub.lbSetup = setupOr(b.dataset.lbsetup); showBoards(); (overlay.querySelector(`[data-lbsetup="${hub.lbSetup}"]`) as HTMLElement | null)?.focus(); }));
    overlay.querySelector('#o-back')!.addEventListener('click', showTitle);
  }

  return { showResults, localDebrief, recordChampRound, startChampRound, showChamp, showBoards };
}
