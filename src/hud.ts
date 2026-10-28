import * as T from './track';
import { Race, LAPS, LOW_FUEL, Car } from './race';
import { t } from './i18n';
import { fmtMs } from './records';

export interface HudExtra { mode: 'race' | 'practice' | 'champ'; pbMs: number; round: string; }

export function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '–:––.–';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

export class Hud {
  root: HTMLElement;
  el: Record<string, HTMLElement> = {};
  cache: Record<string, string> = {};
  mini: HTMLCanvasElement; mctx: CanvasRenderingContext2D;
  miniPts: { x: number; y: number }[] = [];
  miniPit: { x: number; y: number }[] = [];
  mScale = 1; mOx = 0; mOy = 0; mW = 230; mH = 200;
  toastT = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
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
      <div class="tr">
        <button id="b-view" class="btn" title="C"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4"/></svg> <span data-t="hud.view"></span></button>
        <button id="b-zout" class="btn sq" title="-">−</button>
        <button id="b-zin" class="btn sq" title="+">+</button>
        <button id="b-ghost" class="btn sq" title="G">👻</button>
        <button id="b-snd" class="btn sq" title="M">🔊</button>
        <button id="b-pause" class="btn sq" title="Esc"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="3.5" height="12" rx="1"/><rect x="8.5" y="1" width="3.5" height="12" rx="1"/></svg></button>
      </div>
      <div class="panel bl">
        <div class="meter"><span class="lbl" data-t="hud.throttle"></span><div class="bar"><div id="h-thr" class="fill thr"></div></div></div>
        <div class="meter"><span class="lbl" data-t="hud.fuel"></span><div class="bar"><div id="h-fuel" class="fill fuel"></div><div id="h-fuelpct" class="pct"></div></div></div>
        <div id="h-chips" class="chips"></div>
      </div>
      <div class="br"><canvas id="h-mini"></canvas></div>
      <div id="h-toast" class="toast"></div>
      <div id="h-status" class="status"></div>
      <div id="h-lights" class="lights">${'<i></i>'.repeat(5)}</div>
      <div id="h-go" class="go"></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[id]').forEach((e) => (this.el[e.id] = e));
    this.mini = this.el['h-mini'] as HTMLCanvasElement;
    this.mctx = this.mini.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.mini.width = this.mW * dpr; this.mini.height = this.mH * dpr;
    this.mini.style.width = this.mW + 'px'; this.mini.style.height = this.mH + 'px';
    this.mctx.scale(dpr, dpr);
    this.rebuildMini();
    this.relabel();
  }

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
    const stand = order.map((c, i) => `<div class="${c.isPlayer ? 'me' : ''}"><b>${i + 1}</b><i style="background:${hex(c.color)}"></i>${c.isPlayer ? t('hud.you') : c.name}${flags(c)}${c.mode === 'service' || c.mode === 'bayIn' ? ' ⛽' : ''}${c.finished ? ' 🏁' : ''}</div>`).join('');
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
    if (p.sgOwed > 0) chips.push(`<span class="chip red blink">■ ${t('hud.sgChip')}</span>`);
    if (p.timePen > 0) chips.push(`<span class="chip red">⏱ ${t('hud.timePen', { n: p.timePen })}</span>`);
    if (p.laneReq) chips.push(`<span class="chip yel">⇄ ${t('hud.laneArmed')}</span>`);
    if (p.pitReq) chips.push(`<span class="chip cyan">P ${t('hud.pitArmed')}</span>`);
    if (p.squeezeHold) chips.push(`<span class="chip org">▼ ${t('hud.yield')}</span>`);
    if (p.yielding) chips.push(`<span class="chip org">▼ ${t('hud.pitYield')}</span>`);
    this.set('h-chips', chips.join(''), true);

    // status line
    let st = '';
    if (p.sgServing) {
      st = `<b class="red">${t('hud.sgServing', { n: Math.max(0, p.sgOwed - p.sgServed).toFixed(1) })}</b>`;
    } else if (p.sgOwed > 0 && !p.finished) {
      if (p.mode === 'pitlane') st = `<b class="red">${t('hud.sgBox')}</b>`;
      else {
        const detail = p.sgChances <= 1 ? t('hud.sgDetail1', { n: Math.round(p.sgOwed) }) : t('hud.sgDetail', { n: Math.round(p.sgOwed), k: p.sgChances });
        st = `<b class="red">${t('hud.sgOwed')}</b> · ${detail}${p.sgSkipNext ? ` · <small>${t('hud.sgSkip')}</small>` : ''}`;
      }
    } else if (p.mode === 'service') {
      st = `<b>${t('hud.refuel', { n: Math.round(p.fuel * 100) })}</b>`;
      if (p.penalty > 0) st += ` · <span class="red">${t('hud.penalty', { n: Math.ceil(p.penalty) })}</span>`;
      else if (p.waitingClear) st += ` · ${t('hud.waitClear')}`;
      else if (!p.finished) st += ` · ${t('hud.refuelHint')}`;
    } else if (p.mode === 'pitlane' && T.gapS(race.s(p), T.BAYS[3] + T.BAY_HALF) > 0 && !p.finished) {
      st = t('hud.stopBay');
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

export function carLabel(c: Car): string { return c.isPlayer ? t('hud.you') : c.name; }

/** warning flags, outstanding stop-and-go and time penalty markers shown beside a driver's name */
export function flags(c: Car): string {
  let h = '';
  const w = Math.min(2, c.offences);
  if (w > 0) h += `<span class="flag ${w === 2 ? 'final' : ''}" title="${w === 2 ? t('pen.flashFinal') : ''}">${'⚑'.repeat(w)}</span>`;
  if (c.sgOwed > 0) h += `<span class="flag sg">SG</span>`;
  if (c.timePen > 0) h += `<span class="flag tp">+${c.timePen}s</span>`;
  return h;
}
