// HUD refresh only while shown, and the minimap's static layers painted once per rebuild (#102).
// src/hud.ts runs here against a minimal DOM double: elements found by id in the HUD markup, and canvases whose 2D context
// records every drawing operation with the transform and style state in force, so the old full redraw (copied below as
// legacyDrawMini) and the new composite (static layer copied 1:1, then the cars) can be compared operation for operation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as T from '../src/track';
import type { Race, DriverId } from '../src/race';
import { Hud } from '../src/hud';
import { fresh, seedRandom, place, DT, memStorage } from './helpers';

type Mat = [number, number, number, number, number, number];
interface Op { op: string; args: unknown[]; m: Mat; st: Record<string, unknown>; path: unknown[][]; src?: Rec }

const STATE0 = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' };

const USES: Record<string, string[]> = {
  fill: ['fillStyle'], stroke: ['strokeStyle', 'lineWidth', 'lineJoin', 'lineCap'],
  fillText: ['fillStyle', 'font', 'textAlign', 'textBaseline'], clearRect: [], drawImage: [],
};

/** A recording CanvasRenderingContext2D: paths, transform, save/restore and the style state each fill, stroke or clear sees. */
class Rec {
  ops: Op[] = [];
  m: Mat = [1, 0, 0, 1, 0, 0];
  st: Record<string, unknown> = { ...STATE0 };
  stack: { m: Mat; st: Record<string, unknown> }[] = [];
  path: unknown[][] = [];
  // style state, kept in st (accessors installed in the constructor)
  declare fillStyle: string; declare strokeStyle: string; declare lineWidth: number; declare lineJoin: string;
  declare lineCap: string; declare font: string; declare textAlign: string; declare textBaseline: string;
  constructor(readonly canvas: StubCanvas) {
    for (const k of Object.keys(STATE0)) Object.defineProperty(this, k, { get: () => this.st[k], set: (v) => { this.st[k] = v; }, enumerable: true });
  }
  reset(): void { this.m = [1, 0, 0, 1, 0, 0]; this.st = { ...STATE0 }; this.stack = []; this.path = []; }
  private draw(op: string, args: unknown[], extra: Partial<Op> = {}): void {
    // only the state the operation reads (text settings never reach a fill or stroke of a path)
    const st = Object.fromEntries(USES[op].map((k) => [k, this.st[k]]));
    this.ops.push({ op, args, m: [...this.m] as Mat, st, path: op === 'fill' || op === 'stroke' ? this.path.map((p) => [...p]) : [], ...extra });
  }
  setTransform(...a: number[]): void { this.m = a as Mat; }
  save(): void { this.stack.push({ m: [...this.m] as Mat, st: { ...this.st } }); }
  restore(): void { const s = this.stack.pop(); if (s) { this.m = s.m; this.st = s.st; } }
  beginPath(): void { this.path = []; }
  moveTo(...a: number[]): void { this.path.push(['moveTo', ...a]); }
  lineTo(...a: number[]): void { this.path.push(['lineTo', ...a]); }
  closePath(): void { this.path.push(['closePath']); }
  arc(...a: number[]): void { this.path.push(['arc', ...a]); }
  roundRect(...a: number[]): void { this.path.push(['roundRect', ...a]); }
  fill(): void { this.draw('fill', []); }
  stroke(): void { this.draw('stroke', []); }
  fillText(...a: unknown[]): void { this.draw('fillText', a); }
  clearRect(...a: number[]): void { this.draw('clearRect', a); }
  drawImage(img: StubCanvas, ...a: number[]): void { this.draw('drawImage', a, { src: img.ctx }); }
}

class StubEl {
  style: Record<string, string> = { display: '' };
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  cls = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean): void => { if (on ?? !this.cls.has(c)) this.cls.add(c); else this.cls.delete(c); },
    add: (c: string): void => { this.cls.add(c); }, remove: (c: string): void => { this.cls.delete(c); },
    contains: (c: string): boolean => this.cls.has(c),
  };
  textContent = ''; className = ''; title = ''; hidden = false; offsetWidth = 0;
  children: StubEl[] = [];
  id = '';
  byId: StubEl[] = [];
  private html = '';
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) { this.html = v; this.parse(v); }
  protected parse(_v: string): void { /* plain elements keep markup as text */ }
  get firstElementChild(): StubEl { return this.children[0]; }
  get lastElementChild(): StubEl { return this.children[this.children.length - 1]; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  appendChild(e: StubEl): StubEl { this.children.push(e); return e; }
  querySelectorAll(sel: string): StubEl[] { return sel === '[id]' ? this.byId : []; }
}

class StubCanvas extends StubEl {
  ctx: Rec = new Rec(this);
  private w = 300; private h = 150;
  /** like a real canvas, setting either size clears the bitmap and resets the context */
  get width(): number { return this.w; } set width(v: number) { this.w = v; this.ctx.reset(); }
  get height(): number { return this.h; } set height(v: number) { this.h = v; this.ctx.reset(); }
  getContext(): Rec { return this.ctx; }
}

/** The HUD root: its markup is scanned for ids, each becoming a stub element (canvas for the minimap). */
class StubRoot extends StubEl {
  protected override parse(v: string): void {
    this.byId = [...v.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => {
      const e = tag === 'canvas' ? new StubCanvas() : new StubEl();
      e.id = id;
      if (id === 'h-lights') for (let i = 0; i < 5; i++) e.children.push(new StubEl());
      if (id === 'h-fuellaps') e.children.push(new StubEl(), new StubEl());
      return e;
    });
  }
}

let dpr = 1;
const canvases: StubCanvas[] = [];
beforeEach(() => {
  seedRandom(7);
  dpr = 1; canvases.length = 0;
  vi.stubGlobal('localStorage', memStorage());
  vi.stubGlobal('window', { get devicePixelRatio() { return dpr; } });
  vi.stubGlobal('getComputedStyle', () => ({ width: '230px', height: '200px' }));
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag === 'canvas') { const c = new StubCanvas(); canvases.push(c); return c; }
      return tag === 'div' ? new StubRoot() : new StubEl();
    },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const make = (): Hud => new Hud(new StubEl() as unknown as HTMLElement);
const el = (h: Hud, id: string): StubEl => h.el[id] as unknown as StubEl;
const mainRec = (h: Hud): Rec => (h.mini as unknown as StubCanvas).ctx;
const bgRec = (h: Hud): Rec => (h.miniBg as unknown as StubCanvas).ctx;
const ME = (r: Race): DriverId => r.cars[0].id;

/**
 * The minimap as drawn before #102, verbatim: every layer every frame, on the minimap's own (scaled) context.
 * Kept here as the reference the composite must reproduce.
 */
function legacyDrawMini(h: Hud, g: Rec, race: Race, time: number, me: DriverId): void {
  const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');
  g.clearRect(0, 0, h.mW, h.mH);
  g.fillStyle = 'rgba(10,14,20,0.72)';
  g.beginPath(); g.roundRect(0, 0, h.mW, h.mH, 12); g.fill();
  const line = (pts: { x: number; y: number }[], w: number, col: string, close = false): void => {
    g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (close) g.closePath(); g.stroke();
  };
  line(h.miniPts, 7, '#5b6270', true);
  line(h.miniPts, 4, '#2a2e36', true);
  line(h.miniPit, 2.5, '#6b7280');
  for (const b of T.BANKS) { const a: { x: number; y: number }[] = []; for (let s = b.s0; s <= b.s1; s += 0.8) a.push(h.mp(T.center(s))); line(a, 4, '#4a3a2a'); }
  const sq: { x: number; y: number }[] = [];
  for (let s = T.SQ_Q1; s <= T.SQ_Q2; s += 0.8) sq.push(h.mp(T.center(s)));
  line(sq, 4, '#f5b301');
  for (const sw of T.SWITCHES) { const a: { x: number; y: number }[] = []; for (let s = sw.s0; s <= sw.s1; s += 0.8) a.push(h.mp(T.center(s))); line(a, 4, '#e5e7eb'); }
  for (const r of T.RAISED) { const a: { x: number; y: number }[] = []; for (let s = r.s0; s <= r.s1; s += 0.8) a.push(h.mp(T.center(s))); line(a, 9, '#0b0d10'); line(a, 5, '#8b94a3'); }
  const f1 = h.mp(T.point(T.FINISH_S, -1.4)), f2 = h.mp(T.point(T.FINISH_S, 1.4));
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(f1.x, f1.y); g.lineTo(f2.x, f2.y); g.stroke();
  const pe = h.mp(T.point(T.PIT_IN0, -2.4));
  g.fillStyle = '#22d3ee'; g.beginPath(); g.arc(pe.x, pe.y + 6, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#062a33'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P', pe.x, pe.y + 6.5);
  const cars = [...race.cars].sort((a, b) => (a.id === me ? 1 : 0) - (b.id === me ? 1 : 0));
  for (const c of cars) {
    if (c.mode === 'tow') continue;
    const p = h.mp({ x: c.x, y: c.y });
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

/** What the legacy redraw paints in its second frame (its context carries state over from the first, as the live one did). */
function legacyFrame(h: Hud, race: Race, time: number): Op[] {
  const c = new StubCanvas();
  c.width = h.mini.width; c.height = h.mini.height;
  c.ctx.setTransform(h.mini.width / h.mW, 0, 0, h.mini.height / h.mH, 0, 0);
  legacyDrawMini(h, c.ctx, race, time - 1, ME(race));
  c.ctx.ops = [];
  legacyDrawMini(h, c.ctx, race, time, ME(race));
  return c.ctx.ops;
}

/** The composite's frame with the 1:1 copy of the static layer replaced by the operations that painted that layer. */
function compositeFrame(h: Hud, ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const o of ops) {
    if (o.op === 'clearRect') {
      // the whole backing store, at identity: the same clear as the legacy one at the scaled transform
      expect(o.m).toEqual([1, 0, 0, 1, 0, 0]);
      expect(o.args).toEqual([0, 0, h.mini.width, h.mini.height]);
    } else if (o.op === 'drawImage') {
      // copied pixel for pixel: identity transform, origin, and a layer exactly the minimap's backing size
      expect(o.src).toBe(bgRec(h));
      expect(o.m).toEqual([1, 0, 0, 1, 0, 0]);
      expect(o.args).toEqual([0, 0]);
      expect([h.miniBg.width, h.miniBg.height]).toEqual([h.mini.width, h.mini.height]);
      // the layer as last painted (each paint starts with its clear)
      const bg = bgRec(h).ops;
      out.push(...bg.slice(bg.map((b) => b.op).lastIndexOf('clearRect')));
    } else out.push(o);
  }
  return out;
}

/** a race on the active track with the cars spread out and moving */
function racing(track = T.DEF?.id ?? 'circuit-1'): Race {
  const r = fresh(track);
  r.cars.forEach((c, i) => place(c, 40 + i * 9, i % 2 ? 1 : -1, 12 + i));
  r.cars[0].human = true;
  for (let i = 0; i < 30; i++) r.update(DT, {});
  return r;
}

describe('Hud.frame: refreshed only while shown (#102)', () => {
  it('skips update while hidden and hides the root; ticks only the toast', () => {
    const h = make(), r = racing();
    const up = vi.spyOn(h, 'update');
    h.frame(true, r, DT, 0, { mode: 'race', pbMs: 0, round: '', me: ME(r) });
    expect(up).toHaveBeenCalledTimes(1);
    expect(h.root.style.display).toBe('');
    h.toast('hello', 'info');
    const static0 = bgRec(h).ops.length, main0 = mainRec(h).ops.length;
    for (let i = 0; i < 200; i++) h.frame(false, r, DT, i * DT, { mode: 'race', pbMs: 0, round: '', me: ME(r) });
    expect(up).toHaveBeenCalledTimes(1);
    expect(h.root.style.display).toBe('none');
    // nothing is redrawn while hidden
    expect(mainRec(h).ops.length).toBe(main0);
    expect(bgRec(h).ops.length).toBe(static0);
    // the toast still runs out on time (200 frames > its 2.4 s), as it did when update ran on every screen
    expect(el(h, 'h-toast').cls.has('show')).toBe(false);
  });

  it('the first frame after showing again is current: standings, position, fuel and minimap', () => {
    const h = make(), r = racing();
    const x = { mode: 'race' as const, pbMs: 0, round: '', me: ME(r) };
    place(r.cars[0], 300, 1, 12); // leading
    for (let i = 0; i < 5; i++) h.frame(true, r, DT, i * DT, x);
    expect(el(h, 'h-pos').textContent).toBe(`1/${r.cars.length}`);
    const before = { fuel: el(h, 'h-fuelpct').textContent, stand: el(h, 'h-stand').innerHTML, pos: el(h, 'h-pos').textContent };
    for (let i = 0; i < 5; i++) h.frame(false, r, DT, i * DT, x);
    // the race moves on while the HUD is hidden: the local car drops to last with a near-empty tank
    const p = r.cars[0];
    p.fuel = 0.07; place(p, 20, 1, 5);
    r.cars.forEach((c, i) => { if (i) place(c, 80 + i * 9, 1, 12); });
    for (let i = 0; i < 3; i++) h.frame(false, r, DT, i * DT, x);
    expect(el(h, 'h-fuelpct').textContent).toBe(before.fuel);
    const up = vi.spyOn(h, 'update');
    mainRec(h).ops = [];
    h.frame(true, r, DT, 1.5, x);
    expect(up).toHaveBeenCalledTimes(1);
    expect(h.root.style.display).toBe('');
    expect(el(h, 'h-fuelpct').textContent).toBe('7%');
    expect(el(h, 'h-fuel').style.width).toBe('7.0%');
    expect(el(h, 'h-pos').textContent).toBe(`${r.cars.length}/${r.cars.length}`);
    expect(el(h, 'h-pos').textContent).not.toBe(before.pos);
    expect(el(h, 'h-stand').innerHTML).not.toBe(before.stand);
    expect(el(h, 'h-chips').innerHTML).toContain('chip red blink');
    // the minimap of that frame matches a full redraw of the current race
    expect(compositeFrame(h, mainRec(h).ops)).toEqual(legacyFrame(h, r, 1.5));
  });

  it('keeps feeding the fuel-laps estimator every visible race frame, and does not on hidden screens', () => {
    const h = make(), r = racing();
    const feed = vi.spyOn(h.fuelEst, 'update');
    const x = { mode: 'race' as const, pbMs: 0, round: '', me: ME(r) };
    for (let i = 0; i < 20; i++) { r.update(DT, {}); h.frame(true, r, DT, i * DT, x); }
    expect(feed).toHaveBeenCalledTimes(20);
    expect(el(h, 'h-fuellaps').hidden).toBe(false);
    for (let i = 0; i < 20; i++) h.frame(false, r, DT, i * DT, x);
    expect(feed).toHaveBeenCalledTimes(20);
  });

  it('main.ts drives the HUD through Hud.frame only', () => {
    const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/hud\.update\(/);
    expect(src).not.toMatch(/hud\.root\.style\.display/);
    expect(src.match(/hud\.frame\(/g)?.length).toBe(1);
  });
});

describe('minimap static layers (#102)', () => {
  it('are painted once per rebuild, not per frame', () => {
    const h = make(), r = racing();
    const x = { mode: 'race' as const, pbMs: 0, round: '', me: ME(r) };
    const paint = vi.spyOn(h, 'drawMiniStatic');
    const staticOps = bgRec(h).ops.length;
    expect(staticOps).toBeGreaterThan(10);
    for (let i = 0; i < 30; i++) { r.update(DT, {}); h.frame(true, r, DT, i * DT, x); }
    expect(paint).not.toHaveBeenCalled();
    expect(bgRec(h).ops.length).toBe(staticOps);
    // each frame: one clear, one copy, and the cars (a ring, a fill and a stroke for the local car, a fill and a stroke for the rest)
    mainRec(h).ops = [];
    h.frame(true, r, DT, 1, x);
    expect(mainRec(h).ops.map((o) => o.op)).toEqual(['clearRect', 'drawImage', ...r.cars.slice(1).flatMap(() => ['fill', 'stroke']), 'stroke', 'fill', 'stroke']);
    h.rebuildMini();
    expect(paint).toHaveBeenCalledTimes(1);
    h.fitMini(); // same size and pixel ratio: nothing to redo
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('the composite equals the full redraw, frame after frame, on every track', () => {
    for (const id of T.TRACKS.map((d) => d.id)) {
      T.setTrack(id);
      const h = make(), r = racing();
      const x = { mode: 'race' as const, pbMs: 0, round: '', me: ME(r) };
      for (let i = 0; i < 3; i++) {
        r.update(DT, {});
        mainRec(h).ops = [];
        h.frame(true, r, DT, 0.4 + i * 0.37, x);
        expect(compositeFrame(h, mainRec(h).ops), id).toEqual(legacyFrame(h, r, 0.4 + i * 0.37));
      }
    }
  });

  it('is rebuilt for a new track and for a new device pixel ratio, at the backing resolution (crisp at 2x)', () => {
    const h = make(), r = racing();
    const x = { mode: 'race' as const, pbMs: 0, round: '', me: ME(r) };
    expect([h.mini.width, h.mini.height, h.miniBg.width, h.miniBg.height]).toEqual([230, 200, 230, 200]);
    dpr = 2;
    const paint = vi.spyOn(h, 'drawMiniStatic');
    h.fitMini();
    expect(paint).toHaveBeenCalledTimes(1);
    expect([h.mini.width, h.mini.height, h.miniBg.width, h.miniBg.height]).toEqual([460, 400, 460, 400]);
    expect(bgRec(h).ops.filter((o) => o.op === 'clearRect').at(-1)!.m).toEqual([2, 0, 0, 2, 0, 0]);
    mainRec(h).ops = [];
    h.frame(true, r, DT, 2, x);
    expect(compositeFrame(h, mainRec(h).ops)).toEqual(legacyFrame(h, r, 2));
    // another track: the layer follows it
    const other = T.TRACKS.find((d) => d.id !== T.DEF.id)!.id;
    const old = JSON.stringify(bgRec(h).ops);
    T.setTrack(other);
    const r2 = racing();
    h.rebuildMini();
    expect(paint).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bgRec(h).ops)).not.toBe(old);
    mainRec(h).ops = [];
    h.frame(true, r2, DT, 3, { ...x, me: ME(r2) });
    expect(compositeFrame(h, mainRec(h).ops)).toEqual(legacyFrame(h, r2, 3));
  });
});
