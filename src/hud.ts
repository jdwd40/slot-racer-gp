import * as T from './track';
import { Race, LAPS, LOW_FUEL, Car, SERVICE_READY, DriverId, SOLO_ID, STALL } from './race';
import { t } from './i18n';
import { fmtMs } from './records';
import { laneCue, pitCue } from './input';
import { FuelLapsEstimator, SteadyFigure, fuelLapsVisible, fuelWarning, lapsToFlag } from './fuelLaps';

/** `me` is the local driver: the HUD shows that car's state, whatever its grid slot. */
export interface HudExtra { mode: 'race' | 'practice' | 'champ'; pbMs: number; round: string; me: DriverId; }

export function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '–:––.–';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
/** chip text for the next switch's pit route, including when the choice means staying in the current lane */
export function routeChipId(r: { stay: boolean; override: boolean }): string {
  return `hud.route${r.override ? 'Inside' : 'Outside'}${r.stay ? 'Stay' : 'Move'}`;
}
const QUEUE_CHIP = { queued: 'hud.qQueued', bay: 'hud.qBay', exit: 'hud.qExit' } as const;
const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');
const VIEW_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4"/></svg>';
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/></svg>';

export class Hud {
  root: HTMLElement;
  el: Record<string, HTMLElement> = {};
  cache: Record<string, string> = {};
  mini: HTMLCanvasElement; mctx: CanvasRenderingContext2D;
  /** the minimap's static layers (panel, track, pit lane, banks, squeeze, switches, bridges, finish, P), at the minimap's backing size; see drawMiniStatic */
  miniBg: HTMLCanvasElement; bgctx: CanvasRenderingContext2D;
  miniPts: { x: number; y: number }[] = [];
  miniPit: { x: number; y: number }[] = [];
  mScale = 1; mOx = 0; mOy = 0; mW = 230; mH = 200;
  toastT = 0;
  fuelVisit = false;
  /** laps of fuel left (#87): one estimator per race and local car, and the steadied figure it shows */
  fuelEst = new FuelLapsEstimator(); fuelFig = new SteadyFigure();
  fuelFor: { race: Race | null; id: DriverId | null } = { race: null, id: null };

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="topbar">
        <div class="panel tl">
          <div class="big"><span class="lbl" data-t="hud.pos"></span><span id="h-pos">1/4</span></div>
          <div class="big"><span class="lbl" data-t="hud.lap"></span><span id="h-lap">1/${LAPS}</span></div>
          <div id="h-round" class="round"></div>
          <div id="h-stand" class="stand"></div>
        </div>
        <div class="panel tc">
          <div><span class="lbl" data-t="hud.time"></span><span id="h-time" class="mono"></span></div>
          <div><span class="lbl" data-t="hud.last"></span><span id="h-last" class="mono"></span></div>
          <div><span class="lbl" id="h-bestlbl" data-t="hud.best"></span><span id="h-best" class="mono best"></span></div>
        </div>
      </div>
      <div id="h-tools" class="tr">
        <button id="b-more" class="btn sq more" aria-label="${t('ctl.more')}" aria-expanded="false" aria-controls="h-util">⋯</button>
        <div id="h-util" class="util">
          <button id="b-view" class="btn" title="C">${VIEW_ICON} <span data-t="hud.view"></span></button>
          <button id="t-view" class="btn touch-only" tabindex="-1" data-tap="view">${VIEW_ICON} <span data-t="hud.view"></span></button>
          <button id="b-zout" class="btn sq" title="-" aria-label="${t('ctl.zoomOut')}">−</button>
          <button id="b-zin" class="btn sq" title="+" aria-label="${t('ctl.zoomIn')}">+</button>
          <button id="b-ghost" class="btn sq" title="G" aria-label="${t('ctl.ghostShort')}" aria-pressed="true">👻</button>
          <button id="b-snd" class="btn sq" title="M" aria-label="${t('ctl.sound')}" aria-pressed="true">🔊</button>
        </div>
        <button id="b-pause" class="btn sq" title="Esc" aria-label="${t('ctl.pause')}">${PAUSE_ICON}</button>
        <button id="t-pause" class="btn sq touch-only" tabindex="-1" data-tap="pause" aria-label="${t('ctl.pause')}">${PAUSE_ICON}</button>
      </div>
      <div class="dock">
        <div id="h-status" class="status"></div>
        <div class="panel bl">
          <div class="meter"><span class="lbl" data-t="hud.throttle"></span><div class="bar"><div id="h-thr" class="fill thr"></div></div></div>
          <div class="meter"><span class="lbl" data-t="hud.fuel"></span><div class="bar"><div id="h-fuel" class="fill fuel"></div><div id="h-fuelpct" class="pct"></div></div><span id="h-fuellaps" class="fuellaps" role="img" hidden><span class="fl-long"></span><span class="fl-short"></span></span></div>
          <div id="h-chips" class="chips"></div>
        </div>
      </div>
      <div class="br"><canvas id="h-mini"></canvas></div>
      <div id="h-toast" class="toast"></div>
      <div id="h-lights" class="lights">${'<i></i>'.repeat(5)}</div>
      <div id="h-go" class="go"></div>
      <div id="t-pad" class="pad" hidden>
        <button id="t-brake" class="tbtn hold" tabindex="-1" data-hold="brake"><b data-t="touch.brake"></b><small id="t-brake-cue"></small></button>
        <button id="t-lane" class="tbtn" tabindex="-1" data-tap="lane"><b data-t="touch.lane"></b><small id="t-lane-cue"></small></button>
        <button id="t-pit" class="tbtn" tabindex="-1" data-tap="pit"><b data-t="touch.pit"></b><small id="t-pit-cue"></small></button>
        <button id="t-defer" class="tbtn" tabindex="-1" data-tap="defer" hidden><b data-t="touch.defer"></b><small data-t="touch.defer.idle"></small></button>
        <button id="t-throttle" class="tbtn hold" tabindex="-1" data-hold="throttle"><b data-t="touch.throttle"></b><small id="t-throttle-cue" data-t="touch.hold"></small></button>
      </div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[id]').forEach((e) => (this.el[e.id] = e));
    this.mini = this.el['h-mini'] as HTMLCanvasElement;
    this.mctx = this.mini.getContext('2d')!;
    this.miniBg = document.createElement('canvas');
    this.bgctx = this.miniBg.getContext('2d')!;
    this.fitMini();
    this.relabel();
  }

  /**
   * Match the minimap's projection and backing store to its CSS size, which the stylesheet sets per layout.
   * Computed style still answers while the HUD is hidden on the menus. The backing store follows the device, not the graphics preset, so it stays sharp on Low.
   */
  fitMini(): void {
    const css = getComputedStyle(this.mini);
    const w = parseFloat(css.width) || this.mW, h = parseFloat(css.height) || this.mH;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (bw === this.mini.width && bh === this.mini.height && w === this.mW && h === this.mH) return;
    this.mW = w; this.mH = h;
    this.mini.width = bw; this.mini.height = bh;
    this.mctx.setTransform(bw / w, 0, 0, bh / h, 0, 0);
    this.rebuildMini();
  }

  /** Open or close the compact layouts' tray of secondary controls. */
  setMore(open: boolean): void {
    this.el['h-tools'].classList.toggle('open', open);
    this.el['b-more'].setAttribute('aria-expanded', String(open));
  }
  get moreOpen(): boolean { return this.el['h-tools'].classList.contains('open'); }

  /** Recompute the minimap projection for the active track and repaint its static layers. */
  rebuildMini(): void {
    const B = T.BOUNDS, pad = 14;
    this.mScale = Math.min((this.mW - pad * 2) / B.w, (this.mH - pad * 2) / B.h);
    this.mOx = this.mW / 2 - B.cx * this.mScale; this.mOy = this.mH / 2 + B.cy * this.mScale;
    this.miniPts = []; this.miniPit = [];
    for (let s = 0; s <= T.L; s += 0.8) this.miniPts.push(this.mp(T.center(s)));
    for (let s = T.PIT_IN0; s <= T.PIT_OUT1; s += 0.5) this.miniPit.push(this.mp(T.point(s, T.pitD(s))));
    this.drawMiniStatic();
  }

  mp(p: { x: number; y: number }): { x: number; y: number } { return { x: this.mOx + p.x * this.mScale, y: this.mOy - p.y * this.mScale }; }

  relabel(): void {
    this.root.querySelectorAll<HTMLElement>('[data-t]').forEach((e) => { e.textContent = t(e.dataset.t!); });
    this.cache = {};
  }

  set(id: string, v: string, html = false): void {
    if (this.cache[id] === v) return;
    this.cache[id] = v;
    if (html) this.el[id].innerHTML = v; else this.el[id].textContent = v;
  }

  /** Show a tap control's state as a shape and a word, so it never rests on colour alone. */
  cue(name: 'lane' | 'pit' | 'brake' | 'throttle', state: string): void {
    const b = this.el[`t-${name}`];
    if (b.dataset.cue === state) return;
    b.dataset.cue = state;
    this.set(`t-${name}-cue`, t(`touch.${name}.${state}`));
  }

  toast(text: string, kind: string): void {
    const e = this.el['h-toast'];
    e.textContent = text; e.className = 'toast show ' + kind; this.toastT = 2.4;
  }

  goFlash(text: string): void {
    const e = this.el['h-go']; e.textContent = text; e.classList.remove('show'); void e.offsetWidth; e.classList.add('show');
  }

  /**
   * The per-frame entry (src/main.ts frame()): show or hide the HUD, and refresh it only while it is shown (#102). Hidden on the
   * title, menus, lobby, account, boards, championship and online results, where nothing reads it; the frame that shows it
   * again runs update() before anything is painted, so standings, fuel and minimap are current from the first visible frame.
   * While hidden only the toast keeps counting down, so one raised just before leaving the race does not reappear later.
   * The fuel-laps estimator (#87) is fed by update(): every screen with a race running (race, pause, results, netwait) shows the HUD.
   */
  frame(shown: boolean, race: Race, dt: number, time: number, x?: HudExtra): void {
    const display = shown ? '' : 'none';
    if (this.root.style.display !== display) this.root.style.display = display;
    if (shown) this.update(race, dt, time, x); else this.tickToast(dt);
  }

  tickToast(dt: number): void {
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el['h-toast'].classList.remove('show'); }
  }

  update(race: Race, dt: number, time: number, x: HudExtra = { mode: 'race', pbMs: 0, round: '', me: SOLO_ID }): void {
    const p = race.car(x.me) ?? race.cars[0];
    const order = race.order();
    const pos = order.indexOf(p) + 1;
    const practice = x.mode === 'practice';
    this.el['b-ghost'].style.display = practice ? '' : 'none';
    this.set('h-round', x.round ? `${t('hud.round')} ${x.round}` : '');
    this.set('h-pos', practice ? '–' : `${pos}/${race.cars.length}`);
    this.set('h-lap', practice ? `${Math.max(1, p.lapsDone + 1)}` : `${Math.min(LAPS, Math.max(1, p.lapsDone + 1))}/${LAPS}`);
    if (practice) {
      // live lap time, previous lap and the stored personal best (millisecond precision)
      const live = p.crossed >= 1 && race.phase === 'racing' ? (race.raceTime - p.lapStartT) * 1000 : 0;
      this.set('h-time', live > 0 ? fmtMs(live) : '0:00.000');
      this.set('h-last', p.lapsDone > 0 ? fmtMs(p.lastLap * 1000) : fmtMs(0));
      this.set('h-best', fmtMs(x.pbMs));
      this.set('h-bestlbl', t('hud.pb'));
      this.el['h-stand'].style.display = 'none';
    } else {
      this.set('h-bestlbl', t('hud.best'));
      this.el['h-stand'].style.display = '';
    }
    const stand = order.map((c, i) => `<div class="${c === p ? 'me' : ''}"><b>${i + 1}</b><i style="background:${hex(c.color)}"></i>${escHtml(carLabel(c, p.id))}${flags(c)}${c.mode === 'service' || c.mode === 'bayIn' ? ' ⛽' : ''}${c.status === 'finished' ? ' 🏁' : ''}</div>`).join('');
    this.set('h-stand', stand, true);
    if (!practice) {
      const cur = race.phase === 'countdown' ? 0 : p.finished ? p.finishTime : race.raceTime;
      this.set('h-time', fmt(cur).replace('–:––.–', '0:00.0'));
      this.set('h-last', fmt(p.lastLap));
      this.set('h-best', fmt(p.bestLap));
    }
    (this.el['h-thr'] as HTMLElement).style.width = `${(p.throttle * 100).toFixed(0)}%`;
    const fe = this.el['h-fuel'] as HTMLElement;
    fe.style.width = `${(p.fuel * 100).toFixed(1)}%`;
    const low = p.fuel < LOW_FUEL;
    fe.classList.toggle('low', low);
    this.set('h-fuelpct', `${Math.round(p.fuel * 100)}%`);
    this.fuelLaps(race, p, practice);

    // chips
    const chips: string[] = [];
    if (low && !p.finished) chips.push(`<span class="chip red blink">⚠ ${t('hud.lowFuel')}</span>`);
    if (practice && p.crossed >= 1 && !p.lapValid) chips.push(`<span class="chip org">✕ ${t('hud.lapInvalid')}</span>`);
    // service: each reason on its own chip, so requested, deferred, due, overdue and the breach never blur together
    const live = !practice && !p.finished;
    const held = live && p.routeHold >= 0 && p.routeHold === race.apprLap(p);
    if (live && p.svcBreach) chips.push(`<span class="chip red blink">✕ ${t('hud.breach')}</span>`);
    // last chance (#65): missing this lap's entrance means a DQ. Put first, so on a crowded phone HUD it is never the one wrapped last
    if (live && race.lastChance(p)) chips.unshift(`<span class="chip red blink last-chance">⚠ ${t('hud.lastChance')}</span>`);
    // stopped on track (#69): the server's (or the local race's) count, shown as words and a number, ahead of everything
    const stall = stallLeft(p);
    if (stall) chips.unshift(`<span class="chip red blink stall" data-n="${stall}">⚠ ${t('hud.stallChip', { n: stall })}</span>`);
    const dueChip = (lap: number): string => { const d = race.dueState(p, lap); return d === 'none' ? '' : ` · ${t(`hud.dueChip.${d}`)}`; };
    const dueText = (lap: number): string => { const d = race.dueState(p, lap); return d === 'none' ? '' : t(`hud.due.${d}`); };
    if (p.sgOwed > 0 && !p.finished) chips.push(`<span class="chip red ${p.svcBreach ? '' : 'blink'}">■ ${t('hud.sgChip')}${dueChip(p.sgDue)}</span>`);
    if (p.fuelDue > 0 && !p.finished) chips.push(`<span class="chip org">⛽ ${t('hud.fuelChip')}${dueChip(p.fuelDue)}</span>`);
    if (p.fuelReq && !p.finished) chips.push(`<span class="chip cyan">⛽ ${t('hud.fuelReq')}</span>`);
    // automatic stop-and-go: what the car is doing for the driver (the simulation decides; the HUD only reads it)
    // fuel visits drive themselves in practice too (no deadlines there, but the same bay stop)
    const sgp = p.finished ? null : p.sgPhase;
    const b = race.bayNo(p);
    if (sgp) {
      const n = Math.max(0, p.sgOwed - p.sgServed).toFixed(1);
      const cls = sgp === 'armed' ? 'red' : sgp === 'deferred' || sgp === 'release' ? 'yel' : sgp === 'queued' || sgp === 'bayWait' || sgp === 'exit' ? 'org' : 'cyan';
      const icon = sgp === 'deferred' ? '⏭' : sgp === 'armed' ? '■' : sgp === 'ready' ? '▶' : sgp === 'release' ? '△' : sgp === 'exit' || sgp === 'bayWait' ? '⏸' : 'A';
      chips.push(`<span class="chip ${cls} sgp" data-sg="${sgp}">${icon} ${t(`hud.sgA.${sgp}`, { n, b })}</span>`);
    }
    if (held && sgp !== 'deferred') chips.push(`<span class="chip yel">⏭ ${t('hud.held')}</span>`);
    const canDefer = race.deferBlock(p) === null;
    if (canDefer) chips.push(`<span class="chip yel kbd-only"><kbd>N</kbd> ${t('hud.deferKey')}</span>`);
    if (p.timePen > 0) chips.push(`<span class="chip red">⏱ ${t('hud.timePen', { n: p.timePen })}</span>`);
    if (p.laneReq) chips.push(`<span class="chip yel">⇄ ${t('hud.laneArmed')}</span>`);
    const route = race.nextRoute(p);
    if (route) chips.push(`<span class="chip ${route.override ? 'yel' : 'cyan'}">${route.override ? '⇄' : 'P'} ${t(routeChipId(route))}</span>`);
    if (p.squeezeHold) chips.push(`<span class="chip org">▼ ${t('hud.yield')}</span>`);
    // shared pit queue: what the simulation is holding the car for (the HUD keeps no queue of its own)
    const wait = p.finished ? null : p.pitWait;
    if (wait && !(wait === 'queued' && sgp === 'queued') && !(wait === 'exit' && sgp === 'exit')) chips.push(`<span class="chip org">⏸ ${t(QUEUE_CHIP[wait])}</span>`);
    const rev = reversing(p);
    if (rev) chips.push(`<span class="chip rev">R ${t('hud.reverse')}</span>`);
    this.set('h-chips', chips.join(''), true);
    this.cue('lane', laneCue(p, route));
    this.cue('pit', p.finished ? 'idle' : pitCue(p, held));
    const dEl = this.el['t-defer'];
    if (dEl.hidden === canDefer) dEl.hidden = !canDefer;
    this.root.classList.toggle('defer', canDefer);
    this.cue('brake', rev ? 'reverse' : p.finished ? 'idle' : p.sgCtl ? 'auto' : p.pitHold ? 'held' : 'idle');
    // Throttle in the bay: what a press does now (the same rule for a key and a finger)
    this.cue('throttle', sgp === 'ready' ? 'ready' : sgp === 'release' ? 'release' : p.sgCtl && !p.finished ? 'auto' : 'hold');

    // status line. fuelVisit: this bay visit is settling (or has settled) a committed fuel stop
    const inBay = p.mode === 'bayIn' || p.mode === 'service' || p.mode === 'bayOut';
    if (!inBay || p.towSvc) this.fuelVisit = false; else if (p.fuelDue > 0) this.fuelVisit = true;
    let st = '';
    const inPitLane = p.mode === 'pitlane' && !p.finished;
    if (stall) {
      st = `<b class="red stall">⚠ ${t('hud.stallWarn', { n: stall })}</b>`;
    } else if (p.stallHold && !p.finished) {
      st = `<b class="org">${t('hud.stallHold', { b })}</b>`;
    } else if (p.sgServing) {
      st = `<b class="red">${t('hud.sgServing', { n: Math.max(0, p.sgOwed - p.sgServed).toFixed(1) })}</b>`;
    } else if (sgp === 'leaving') {
      st = wait === 'exit' ? `<b class="org">${t('hud.qExitLine')}</b>` : `<b class="cyan">${t('hud.sgL.leaving')}</b>`;
    } else if (p.sgOwed > 0 && !p.finished) {
      if (p.mode === 'pitlane') st = wait === 'bay' ? `<b class="org">${t('hud.qBayLine')}</b>` : wait === 'queued' || sgp === 'queued' ? `<b class="org">${t('hud.sgL.queued')}</b>` : `<b class="red">${t('hud.sgBox')}</b>`;
      else {
        const lead = sgp === 'entry' ? 'hud.sgL.entry' : sgp === 'queued' ? 'hud.sgL.queued' : sgp === 'deferred' ? 'hud.sgL.deferred' : 'hud.sgOwed';
        st = `<b class="${sgp === 'deferred' ? 'yel' : 'red'}">${t(lead)}</b> · ${t('hud.sgDetail', { n: Math.round(p.sgOwed), due: sgp === 'deferred' ? '' : dueText(p.sgDue) }).replace(/ · $/, '')}`;
        if (!held && sgp !== 'entry' && race.boxBusy(p)) st += ` · <small>${t(race.deferBlock(p) === null ? 'hud.boxBusy' : 'hud.boxBusyFinal')}</small>`;
      }
    } else if (wait && wait !== 'exit' && p.mode !== 'service') {
      st = `<b class="org">${t(wait === 'bay' ? 'hud.qBayLine' : 'hud.qQueuedLine')}</b>`;
    } else if (inPitLane && (sgp === 'bay' || sgp === 'bayWait')) {
      st = `<b class="${sgp === 'bay' ? 'cyan' : 'org'}">${t(`hud.sgL.${sgp}`, { b })}</b>`;
    } else if (p.mode === 'race' && sgp === 'entry' && p.sgOwed <= 0) {
      st = `<b class="cyan">${t('hud.sgL.entryBay', { b })}</b>`;
    } else if (p.mode === 'service') {
      // refuelling, then why departure is not available yet, or what Throttle does now (Waiting for clear exit once asked)
      // a stopped-on-track recovery is not a pit stop: the bay adds no fuel, so the line says so rather than "refuelling"
      st = `<b>${t(p.stallSvc ? 'hud.stallBay' : 'hud.refuel', { n: Math.round(p.fuel * 100) })}</b>`;
      if (p.fuelDue > 0 && !p.towSvc) st += ` · <span class="org">${t('hud.fuelServing', { n: Math.max(0, SERVICE_READY - p.serviceT + 0.05).toFixed(1) })}</span>`;
      else if (this.fuelVisit) st += ` · <span class="grn">${t('hud.fuelServed')}</span>`;
      const why = race.departBlock(p);
      if (p.penalty > 0) st += ` · <span class="red">${t('hud.penalty', { n: Math.ceil(p.penalty) })}</span> · ${t('hud.departPenalty')}`;
      else if (p.exitReq) st += ` · <b class="org">${t('hud.waitClear')}</b>`;
      else if (p.finished) { /* the AI rule takes the car out after the flag */ }
      else if (why === 'settle' && !(p.fuelDue > 0 && !p.towSvc)) st += ` · ${t('hud.departSettle', { n: Math.max(0, SERVICE_READY - p.serviceT + 0.05).toFixed(1) })}`;
      else if (!why) st += ` · <span class="${sgp === 'release' ? 'yel' : 'grn'}">${t(sgp === 'release' ? 'hud.releaseHint' : 'hud.refuelHint')}</span>`;
    } else if (wait === 'exit') {
      st = `<b class="org">${t('hud.qExitLine')}</b>`;
    } else if (p.fuelDue > 0 && !p.finished && !held) {
      st = `<b class="org">${t('hud.fuelDueOwed')}</b>${dueText(p.fuelDue) ? ` · ${dueText(p.fuelDue)}` : ''}`;
    } else if (p.mode === 'pitlane' && T.gapS(race.s(p), T.BAYS[3] + T.BAY_HALF) > 0 && !p.finished) {
      st = t('hud.stopBay', { b });
    } else if (live && p.svcBreach) {
      st = `<b class="red">${t('hud.breachLine')}</b>`;
    }
    this.set('h-status', st, true);
    this.el['h-status'].style.opacity = st ? '1' : '0';

    // lights
    const lights = this.el['h-lights'];
    lights.style.opacity = race.phase === 'countdown' ? '1' : '0';
    const n = race.lights;
    const kids = lights.children;
    for (let i = 0; i < 5; i++) (kids[i] as HTMLElement).className = i < n ? 'on' : '';

    this.tickToast(dt);
    this.drawMini(race, time, p.id);
  }

  /**
   * The approximate laps-of-fuel figure right of the fuel bar (#87, src/fuelLaps.ts, docs/fuel-laps.md). Reads only what the
   * online mirror also has (fuel, u, lapsDone, crossed, the race clock and track), so offline and online behave alike.
   * Orange: probably not enough to reach the flag; red: under a lap. The bar, LOW FUEL chip and toast are unchanged.
   */
  fuelLaps(race: Race, p: Car, practice: boolean): void {
    const e = this.el['h-fuellaps'];
    if (this.fuelFor.race !== race || this.fuelFor.id !== p.id) {
      this.fuelFor = { race, id: p.id }; this.fuelEst.reset(); this.fuelFig.reset();
    }
    const show = fuelLapsVisible({ practice: practice || race.practice, finished: p.finished, status: p.status, phase: race.phase });
    if (!show) { if (!e.hidden) e.hidden = true; this.fuelFig.reset(); return; }
    const L = race.T.L;
    const r = this.fuelEst.update({ fuel: p.fuel, u: p.u, L, now: race.raceTime });
    const n = this.fuelFig.show(r.laps, race.raceTime);
    const warn = fuelWarning(Number(n), lapsToFlag(LAPS, p.lapsDone, race.T.ahead(race.T.FINISH_S, race.s(p)), L, p.crossed));
    const long = t('hud.fuelLaps', { n });
    if (this.cache['h-fuellaps'] !== long + warn) {
      this.cache['h-fuellaps'] = long + warn;
      e.className = `fuellaps ${warn}`;
      e.title = long; e.setAttribute('aria-label', long);
      (e.firstElementChild as HTMLElement).textContent = long;
      (e.lastElementChild as HTMLElement).textContent = t('hud.fuelLapsShort', { n });
    }
    if (e.hidden) e.hidden = false;
  }

  /**
   * Paint the minimap's static layers into miniBg (#102): everything that depends only on the track, the projection and the
   * backing size, none of it on the race or the local driver. Called from rebuildMini, which runs on a track change and from
   * fitMini on any CSS size or device-pixel-ratio change; drawMini copies it 1:1 each frame and draws only the cars on top.
   */
  drawMiniStatic(): void {
    const bg = this.miniBg, g = this.bgctx;
    if (bg.width !== this.mini.width || bg.height !== this.mini.height) { bg.width = this.mini.width; bg.height = this.mini.height; }
    g.setTransform(this.mini.width / this.mW, 0, 0, this.mini.height / this.mH, 0, 0);
    g.clearRect(0, 0, this.mW, this.mH);
    g.fillStyle = 'rgba(10,14,20,0.72)';
    g.beginPath(); g.roundRect(0, 0, this.mW, this.mH, 12); g.fill();
    const line = (pts: { x: number; y: number }[], w: number, col: string, close = false): void => {
      g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (close) g.closePath(); g.stroke();
    };
    line(this.miniPts, 7, '#5b6270', true);
    line(this.miniPts, 4, '#2a2e36', true);
    line(this.miniPit, 2.5, '#6b7280');
    // banked sweepers
    for (const b of T.BANKS) {
      const a: { x: number; y: number }[] = [];
      for (let s = b.s0; s <= b.s1; s += 0.8) a.push(this.mp(T.center(s)));
      line(a, 4, '#4a3a2a');
    }
    // squeeze zone
    const sq: { x: number; y: number }[] = [];
    for (let s = T.SQ_Q1; s <= T.SQ_Q2; s += 0.8) sq.push(this.mp(T.center(s)));
    line(sq, 4, '#f5b301');
    // switches
    for (const sw of T.SWITCHES) {
      const a: { x: number; y: number }[] = [];
      for (let s = sw.s0; s <= sw.s1; s += 0.8) a.push(this.mp(T.center(s)));
      line(a, 4, '#e5e7eb');
    }
    // bridges: raised stretches drawn over everything else
    for (const r of T.RAISED) {
      const a: { x: number; y: number }[] = [];
      for (let s = r.s0; s <= r.s1; s += 0.8) a.push(this.mp(T.center(s)));
      line(a, 9, '#0b0d10'); line(a, 5, '#8b94a3');
    }
    // finish line
    const f1 = this.mp(T.point(T.FINISH_S, -1.4)), f2 = this.mp(T.point(T.FINISH_S, 1.4));
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(f1.x, f1.y); g.lineTo(f2.x, f2.y); g.stroke();
    // pit entrance marker
    const pe = this.mp(T.point(T.PIT_IN0, -2.4));
    g.fillStyle = '#22d3ee'; g.beginPath(); g.arc(pe.x, pe.y + 6, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#062a33'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P', pe.x, pe.y + 6.5);
  }

  drawMini(race: Race, time: number, me: DriverId): void {
    const g = this.mctx;
    // the static layers, pixel for pixel at the backing resolution (identity transform: no resampling, crisp at 2x)
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.mini.width, this.mini.height);
    g.drawImage(this.miniBg, 0, 0);
    g.restore();
    // the full redraw left these set from the track lines; the dots' strokes keep them
    g.lineJoin = 'round'; g.lineCap = 'round';
    // cars
    // the local driver's dot is drawn last, on top
    const cars = [...race.cars].sort((a, b) => (a.id === me ? 1 : 0) - (b.id === me ? 1 : 0));
    for (const c of cars) {
      if (c.mode === 'tow') continue;
      const p = this.mp({ x: c.x, y: c.y });
      if (c.id === me) {
        const pulse = 7 + Math.sin(time * 6) * 2;
        g.strokeStyle = 'rgba(255,224,102,0.9)'; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, pulse + 2, 0, Math.PI * 2); g.stroke();
        g.fillStyle = hex(c.color); g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(p.x, p.y, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        g.fillStyle = hex(c.color); g.strokeStyle = '#0b0d10'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); g.stroke();
      }
    }
  }
}

/**
 * Whether the race core's stopped-on-track count is paused for this car right now (#82): it is rolling backwards at
 * STALL.stopV or more. This is exactly the condition under which Race.stallUpdate() (src/race.ts) does not add the step's
 * time to a running episode (`if (c.v > -STALL.stopV) c.stallT += dt`); a copy, so the server bundle does not change, and
 * test/stall.test.ts pins the two together frame by frame. Reverse gear alone (revOn) is NOT the pause: the standstill that
 * engages reverse, or a car in reverse stopped against the car it backed into, still counts.
 */
export function stallPaused(c: { v: number }): boolean { return c.v <= -STALL.stopV; }

/**
 * Whole seconds left on a stopped-on-track warning (3, 2, 1), or 0 when none is running (#69). Also 0 exactly while the count
 * is paused because the car is backing up (#82, stallPaused): backing up is the recovery manoeuvre, so a frozen tow countdown
 * is never shown; and a count that is running is never hidden, so the warning stays up in reverse gear at a standstill (while
 * reverse engages, or blocked by a car behind). When the car stops again the warning returns with the time that is left.
 */
export function stallLeft(c: { stallT: number; mode: string; finished: boolean; v: number }): number {
  if (!(c.stallT > 0) || c.mode !== 'race' || c.finished || stallPaused(c)) return 0;
  return Math.max(1, Math.min(Math.ceil(STALL.grace), Math.ceil(STALL.grace - c.stallT - 1e-9)));
}

/** The player is in reverse gear, or still rolling backwards after leaving it. */
export function reversing(c: { revOn: boolean; v: number }): boolean { return c.revOn || c.v < -0.05; }

/** Names can come from other players: escape before they go into markup. */
export function escHtml(s: string): string { return s.replace(/[&<>"'`]/g, (ch) => `&#${ch.charCodeAt(0)};`); }

/** "You" for the local driver's car, the driver's name for everyone else (other humans included). */
export function carLabel(c: Car, me: DriverId): string { return c.id === me ? t('hud.you') : c.name; }

/** warning flags, outstanding stop-and-go and time penalty markers shown beside a driver's name */
export function flags(c: Car): string {
  let h = '';
  const w = Math.min(2, c.offences);
  if (w > 0) h += `<span class="flag ${w === 2 ? 'final' : ''}" title="${w === 2 ? t('pen.flashFinal') : ''}">${'⚑'.repeat(w)}</span>`;
  if (c.sgOwed > 0 && c.status === 'running') h += `<span class="flag sg">SG</span>`;
  if (c.timePen > 0) h += `<span class="flag tp">+${c.timePen}s</span>`;
  if (c.status === 'dq') h += `<span class="flag sg" title="${t(`res.dqReason.${c.dqReason}`)}">${t('hud.flagDq')}</span>`;
  else if (c.status === 'dnf') h += `<span class="flag tp">${t('res.dnf')}</span>`;
  return h;
}
