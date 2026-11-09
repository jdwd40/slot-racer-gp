import * as T from './track';
import { Race, LAPS, LOW_FUEL, Car, SERVICE_READY } from './race';
import { t } from './i18n';
import { fmtMs } from './records';
import { laneCue, pitCue } from './input';

export interface HudExtra { mode: 'race' | 'practice' | 'champ'; pbMs: number; round: string; }

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
  miniPts: { x: number; y: number }[] = [];
  miniPit: { x: number; y: number }[] = [];
  mScale = 1; mOx = 0; mOy = 0; mW = 230; mH = 200;
  toastT = 0;
  fuelVisit = false;

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
          <div class="meter"><span class="lbl" data-t="hud.fuel"></span><div class="bar"><div id="h-fuel" class="fill fuel"></div><div id="h-fuelpct" class="pct"></div></div></div>
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
        <button id="t-throttle" class="tbtn hold" tabindex="-1" data-hold="throttle"><b data-t="touch.throttle"></b><small data-t="touch.hold"></small></button>
      </div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[id]').forEach((e) => (this.el[e.id] = e));
    this.mini = this.el['h-mini'] as HTMLCanvasElement;
    this.mctx = this.mini.getContext('2d')!;
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

  /** Recompute the minimap projection for the active track. */
  rebuildMini(): void {
    const B = T.BOUNDS, pad = 14;
    this.mScale = Math.min((this.mW - pad * 2) / B.w, (this.mH - pad * 2) / B.h);
    this.mOx = this.mW / 2 - B.cx * this.mScale; this.mOy = this.mH / 2 + B.cy * this.mScale;
    this.miniPts = []; this.miniPit = [];
    for (let s = 0; s <= T.L; s += 0.8) this.miniPts.push(this.mp(T.center(s)));
    for (let s = T.PIT_IN0; s <= T.PIT_OUT1; s += 0.5) this.miniPit.push(this.mp(T.point(s, T.pitD(s))));
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
  cue(name: 'lane' | 'pit' | 'brake', state: string): void {
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

  update(race: Race, dt: number, time: number, x: HudExtra = { mode: 'race', pbMs: 0, round: '' }): void {
    const p = race.player;
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
    const stand = order.map((c, i) => `<div class="${c.isPlayer ? 'me' : ''}"><b>${i + 1}</b><i style="background:${hex(c.color)}"></i>${c.isPlayer ? t('hud.you') : c.name}${flags(c)}${c.mode === 'service' || c.mode === 'bayIn' ? ' ⛽' : ''}${c.status === 'finished' ? ' 🏁' : ''}</div>`).join('');
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

    // chips
    const chips: string[] = [];
    if (low && !p.finished) chips.push(`<span class="chip red blink">⚠ ${t('hud.lowFuel')}</span>`);
    if (practice && p.crossed >= 1 && !p.lapValid) chips.push(`<span class="chip org">✕ ${t('hud.lapInvalid')}</span>`);
    // service: each reason on its own chip, so requested, deferred, due, overdue and the breach never blur together
    const live = !practice && !p.finished;
    const held = live && p.routeHold >= 0 && p.routeHold === race.apprLap(p);
    if (live && p.svcBreach) chips.push(`<span class="chip red blink">✕ ${t('hud.breach')}</span>`);
    const dueChip = (lap: number): string => { const d = race.dueState(p, lap); return d === 'none' ? '' : ` · ${t(`hud.dueChip.${d}`)}`; };
    const dueText = (lap: number): string => { const d = race.dueState(p, lap); return d === 'none' ? '' : t(`hud.due.${d}`); };
    if (p.sgOwed > 0 && !p.finished) chips.push(`<span class="chip red ${p.svcBreach ? '' : 'blink'}">■ ${t('hud.sgChip')}${dueChip(p.sgDue)}</span>`);
    if (p.fuelDue > 0 && !p.finished) chips.push(`<span class="chip org">⛽ ${t('hud.fuelChip')}${dueChip(p.fuelDue)}</span>`);
    if (p.fuelReq && !p.finished) chips.push(`<span class="chip cyan">⛽ ${t('hud.fuelReq')}</span>`);
    // automatic stop-and-go: what the car is doing for the driver (the simulation decides; the HUD only reads it)
    const sgp = p.finished || practice ? null : p.sgPhase;
    if (sgp) {
      const n = Math.max(0, p.sgOwed - p.sgServed).toFixed(1);
      const cls = sgp === 'armed' ? 'red' : sgp === 'deferred' ? 'yel' : sgp === 'queued' ? 'org' : 'cyan';
      chips.push(`<span class="chip ${cls} sgp" data-sg="${sgp}">${sgp === 'deferred' ? '⏭' : sgp === 'armed' ? '■' : 'A'} ${t(`hud.sgA.${sgp}`, { n })}</span>`);
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
    if (wait && !(wait === 'queued' && sgp === 'queued')) chips.push(`<span class="chip org">⏸ ${t(QUEUE_CHIP[wait])}</span>`);
    const rev = reversing(p);
    if (rev) chips.push(`<span class="chip rev">R ${t('hud.reverse')}</span>`);
    this.set('h-chips', chips.join(''), true);
    this.cue('lane', laneCue(p, route));
    this.cue('pit', p.finished ? 'idle' : pitCue(p, held));
    const dEl = this.el['t-defer'];
    if (dEl.hidden === canDefer) dEl.hidden = !canDefer;
    this.root.classList.toggle('defer', canDefer);
    this.cue('brake', rev ? 'reverse' : p.finished ? 'idle' : p.sgCtl ? 'auto' : p.pitHold ? 'held' : 'idle');

    // status line. fuelVisit: this bay visit is settling (or has settled) a committed fuel stop
    const inBay = p.mode === 'bayIn' || p.mode === 'service' || p.mode === 'bayOut';
    if (!inBay || p.towSvc) this.fuelVisit = false; else if (p.fuelDue > 0) this.fuelVisit = true;
    let st = '';
    if (p.sgServing) {
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
    } else if (p.mode === 'service') {
      st = `<b>${t('hud.refuel', { n: Math.round(p.fuel * 100) })}</b>`;
      if (p.fuelDue > 0 && !p.towSvc) st += ` · <span class="org">${t('hud.fuelServing', { n: Math.max(0, SERVICE_READY - p.serviceT + 0.05).toFixed(1) })}</span>`;
      else if (this.fuelVisit) st += ` · <span class="grn">${t('hud.fuelServed')}</span>`;
      if (p.penalty > 0) st += ` · <span class="red">${t('hud.penalty', { n: Math.ceil(p.penalty) })}</span>`;
      else if (p.waitingClear) st += ` · ${t('hud.waitClear')}`;
      else if (!p.finished) st += ` · ${t('hud.refuelHint')}`;
    } else if (wait === 'exit') {
      st = `<b class="org">${t('hud.qExitLine')}</b>`;
    } else if (p.fuelDue > 0 && !p.finished && !held) {
      st = `<b class="org">${t('hud.fuelDueOwed')}</b>${dueText(p.fuelDue) ? ` · ${dueText(p.fuelDue)}` : ''}`;
    } else if (p.mode === 'pitlane' && T.gapS(race.s(p), T.BAYS[3] + T.BAY_HALF) > 0 && !p.finished) {
      st = t('hud.stopBay');
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

    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el['h-toast'].classList.remove('show'); }
    this.drawMini(race, time);
  }

  drawMini(race: Race, time: number): void {
    const g = this.mctx;
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
    // cars
    const cars = [...race.cars].sort((a) => (a.isPlayer ? 1 : -1));
    for (const c of cars) {
      if (c.mode === 'tow') continue;
      const p = this.mp({ x: c.x, y: c.y });
      if (c.isPlayer) {
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

/** The player is in reverse gear, or still rolling backwards after leaving it. */
export function reversing(c: { revOn: boolean; v: number }): boolean { return c.revOn || c.v < -0.05; }

export function carLabel(c: Car): string { return c.isPlayer ? t('hud.you') : c.name; }

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
