#!/usr/bin/env node
// Bounded browser validation of the real game. Procedure and results: docs/validation.md.
//
//   node scripts/browser-check.mjs [tracks race controlled routing practice championship touch responsive touchrace reverse]   functional checks (default: all)
//   node scripts/browser-check.mjs perf --label updated --machine "<name>"          frame-time capture
//   node scripts/browser-check.mjs compare <baseline.json> <updated.json>           like-for-like comparison
//
// Every browser context is a throwaway profile, so nothing of the user's is read or written.
// Exit code: 0 all checks passed (unavailable ones are listed), 1 a check failed, 2 the time limit was hit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { accelerationOf, assessGoal, comparisonGaps, summarise, CLOCK_TOLERANCE_SEC, GOAL } from './frame-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 20261107;
const LAPS = 13;
const TRACK = 'circuit-1';   // Clubman Park
const CAR = 'sunburst';
const STRINGS = Object.fromEntries(JSON.parse(readFileSync(path.join(ROOT, 'assets/ui/strings.json'), 'utf8')).strings.map((s) => [s.id, s.text]));
/** the fixed start of a string, up to its first {placeholder} */
const text = (id) => STRINGS[id].split('{')[0].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ in-page instrumentation
/** Runs in the page before the game. Wraps requestAnimationFrame to trace every frame, and exposes a driver that reads state and says which keys to press. */
function instrument({ seed }) {
  if (seed !== null) {
    let a = seed >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const qa = (window.__qa = { rows: [], log: [], pixels: null, wantPixels: false, pointerIds: new Set(), padClicks: 0 });
  window.addEventListener('pointerdown', (e) => qa.pointerIds.add(e.pointerId), true);
  window.addEventListener('click', (e) => { if (e.target.closest?.('.tbtn')) qa.padClicks++; }, true);
  const seen = {};
  const note = (ts, raceTime, key, value) => {
    if (seen[key] === value) return;
    seen[key] = value;
    qa.log.push({ ts: Math.round(ts), raceTime: +raceTime.toFixed(3), key, value });
  };
  /** colour variety of the frame just drawn; must run in the same task as the render, before the buffer is cleared */
  const samplePixels = () => {
    const src = document.querySelector('#app > canvas');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const colours = new Set();
    let sum = 0, sq = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l; sq += l * l;
      colours.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
    }
    const n = d.length / 4;
    return { colours: colours.size, meanLuma: +(sum / n).toFixed(1), lumaStdev: +Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)).toFixed(1) };
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => {
    cb(ts);
    const g = window.__game;
    if (!g) return;
    const r = g.race, p = r.player;
    qa.rows.push({ ts, screen: g.screen, phase: r.phase, raceTime: r.raceTime, dropped: g.stepper ? g.stepper.dropped : null, v: +p.v.toFixed(2), throttle: +p.throttle.toFixed(2), brake: p.brake });
    note(ts, r.raceTime, 'screen', g.screen);
    note(ts, r.raceTime, 'phase', r.phase);
    note(ts, r.raceTime, 'lights', r.lights);
    note(ts, r.raceTime, 'mode', p.mode);
    note(ts, r.raceTime, 'lap', p.lapsDone);
    note(ts, r.raceTime, 'lastLap', +p.lastLap.toFixed(3));
    note(ts, r.raceTime, 'lane', p.change ? 'changing' : p.laneSide);
    note(ts, r.raceTime, 'laneReq', p.laneReq);
    note(ts, r.raceTime, 'pitReq', p.pitReq);
    note(ts, r.raceTime, 'pitStops', p.pitStops);
    note(ts, r.raceTime, 'offences', p.offences);
    note(ts, r.raceTime, 'view', g.view);
    note(ts, r.raceTime, 'toast', document.getElementById('h-toast')?.textContent ?? '');
    if (qa.wantPixels) { qa.wantPixels = false; qa.pixels = samplePixels(); }
  });

  /** Read the player's situation and decide the keys: stay under the corner speed, hold back in traffic, pit for fuel or a penalty. */
  qa.drive = (o) => {
    const g = window.__game, r = g.race, T = g.T, p = r.player, s = T.wrapS(p.u);
    const st = { screen: g.screen, phase: r.phase, mode: p.mode, lap: p.lapsDone, crossed: p.crossed, v: p.v, fuel: p.fuel, side: p.laneSide, raceTime: r.raceTime, finished: p.finished, sgOwed: p.sgOwed, pitStops: p.pitStops, view: g.view, lapValid: p.lapValid };
    const cmd = { up: false, down: false, lane: false, pit: false };
    if (g.screen !== 'race' || p.finished) return { st, cmd };
    if (r.phase === 'countdown') { cmd.up = !!o.holdOnGrid; return { st, cmd }; }
    const need = (o.laps - p.lapsDone) * 0.175;        // tank per lap at race pace, with a margin
    const fill = Math.min(1, need + 0.08);
    const wantPit = p.sgOwed > 0 || (!r.practice && p.fuel < 0.25 && p.fuel < need);
    if (p.mode === 'race') {
      const side = (p.change ? p.change.to : p.laneSide) < 0 ? -1 : 1;
      const outside = side < 0;
      const laneTest = !wantPit && o.laneTest && ((p.lapsDone === 1 && outside) || (p.lapsDone === 2 && !outside));
      // routing takes the car outside for a pit request: Space would be an override here, so it is only used for the lane test
      cmd.lane = !p.change && !p.pitReq && !p.laneReq && laneTest;
      cmd.pit = wantPit && !p.pitReq;
      const n = r.profiles['player:1'].length;
      const at = (x) => Math.floor(T.wrapS(x) / T.PROFILE_STEP) % n;
      const look = p.v * 0.45;
      let target = 1e9;
      for (const sd of p.change ? [-1, 1] : [side]) {
        const pr = r.profiles[`player:${sd}`];
        target = Math.min(target, pr[at(s)], pr[at(s + look / 2)], pr[at(s + look)]);
      }
      if (p.recoverT > 0) target *= 0.8;
      for (const c of r.cars) {
        if (c === p || c.mode === 'off' || c.mode === 'tow' || Math.abs(c.d - p.d) > T.CAR_W) continue;
        const gap = T.gapS(s, T.wrapS(c.u));
        if (gap > 0 && gap < 14) target = Math.min(target, c.v + 2.2 * (gap - T.CAR_LEN - 1.2));
      }
      cmd.up = p.v < target - 0.2;
      cmd.down = p.v > target + 0.5;
    } else if (p.mode === 'pitlane') {
      let stop = null;
      if (p.sgOwed > 0) stop = T.PEN_S;
      else if (!p.serviced && p.fuel < fill) stop = T.BAYS.find((b, j) => T.gapS(s, b) > -0.6 && r.bayFree(j, p)) ?? null;
      const a = stop === null ? 0 : T.gapS(s, stop);
      // a key lands two or three frames after the read that chose it, so the stopping distance includes that reaction time
      const rows = qa.rows.slice(-6);
      const frameSec = rows.length > 1 ? (rows[rows.length - 1].ts - rows[0].ts) / (rows.length - 1) / 1000 : 0;
      const reach = p.v * frameSec * 3 + (p.v * p.v) / 60;
      if (p.sgServing) cmd.down = true;
      else if (stop === null || a < -1) cmd.up = true;
      else if (a < Math.max(0.8, reach + 0.2)) cmd.down = true;
      else cmd.up = p.v < Math.min(T.PIT_SPEED, 1.5 + a);
    } else if (p.mode === 'service') cmd.up = p.fuel >= fill && p.penalty <= 0;
    else if (p.mode === 'bayOut') cmd.up = true;
    return { st, cmd };
  };
}

// ------------------------------------------------------------ harness
/** Real keyboard input through the browser's input pipeline. */
class Keys {
  held = new Set();
  constructor(page) { this.page = page; }
  async set(code, on) {
    if (on === this.held.has(code)) return;
    if (on) { this.held.add(code); await this.page.keyboard.down(code); } else { this.held.delete(code); await this.page.keyboard.up(code); }
  }
  async tap(code) { await this.page.keyboard.press(code); }
  async release() { for (const k of [...this.held]) await this.set(k, false); }
}

/** One scenario's results: individually recorded checks, so a failure leaves the rest of the evidence intact. */
class Checks {
  list = [];
  evidence = {};
  ok(name, passed, detail) {
    this.list.push({ name, status: passed ? 'passed' : 'failed', detail: detail ?? null });
    console.log(`    ${passed ? 'pass' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    return passed;
  }
  unavailable(name, detail) {
    this.list.push({ name, status: 'unavailable', detail });
    console.log(`    n/a   ${name}  ${detail}`);
  }
}

async function open(run, { seed = SEED, fixtures = null, viewport = run.viewport, dpr = run.dpr, preset = run.preset, device = {} } = {}) {
  // newContext is an empty, throwaway profile; nothing here touches a real browser profile
  const context = await run.browser.newContext({ viewport, deviceScaleFactor: dpr, ...device });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(instrument, { seed });
  const load = async () => { await page.goto(run.url); await page.waitForFunction(() => window.__game && window.__game.screen === 'title'); };
  await load();
  if (fixtures) {
    await page.evaluate((f) => { for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v); }, fixtures);
    await page.reload();
    await page.waitForFunction(() => window.__game && window.__game.screen === 'title');
  }
  const choice = page.locator(`[data-preset="${preset}"]`);
  if (await choice.count()) await choice.click();
  return { context, page, errors, keys: new Keys(page), load };
}

const read = (page, fn, arg) => page.evaluate(fn, arg);
const game = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.player; return { screen: g.screen, mode: g.mode, view: g.view, track: g.T.DEF.id, phase: r.phase, raceTime: r.raceTime, t: r.t, lights: r.lights, pmode: p.mode, lap: p.lapsDone, u: p.u, v: p.v, throttle: p.throttle, fuel: p.fuel, dropped: g.stepper ? g.stepper.dropped : null }; });
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
/** wait for n more frames to be drawn */
const frames = async (page, n = 3) => { const c = await read(page, () => window.__qa.rows.length); await waitFor(page, (m) => window.__qa.rows.length >= m, c + n); };
const pixels = async (page) => { await read(page, () => { window.__qa.pixels = null; window.__qa.wantPixels = true; }); await waitFor(page, () => window.__qa.pixels); return read(page, () => window.__qa.pixels); };
const toast = (page) => page.locator('#h-toast').textContent();

/** Drive with real keys until `until(state)`. `onTick` runs once per poll, so checks never stop the car from being driven. */
async function driveUntil(s, until, { budgetMs, opts = {}, onTick }) {
  const { page, keys } = s;
  const deadline = Date.now() + budgetMs;
  const o = { laps: LAPS, ...opts };
  for (;;) {
    const { st, cmd } = await read(page, (x) => window.__qa.drive(x), o);
    if (until(st)) return st;
    if (Date.now() > deadline) throw new Error(`driving timed out after ${budgetMs / 1000} s at ${JSON.stringify(st)}`);
    if (st.screen === 'pause') { s.unexpectedPauses = (s.unexpectedPauses ?? 0) + 1; await keys.release(); await keys.tap('Escape'); continue; }
    await keys.set('KeyW', cmd.up);
    await keys.set('KeyS', cmd.down);
    if (cmd.lane) await keys.tap('Space');
    if (cmd.pit) await keys.tap('KeyP');
    if (onTick) await onTick(st);
    await sleep(15);
  }
}

function driveFor(s, ms, opts) {
  const end = Date.now() + ms;
  return driveUntil(s, () => Date.now() > end, { budgetMs: ms + 5000, opts });
}

async function capture(page) {
  return read(page, () => ({ rows: window.__qa.rows, log: window.__qa.log }));
}

/** Everything needed to repeat a run. Only what reproduction needs: no host name, user name or paths. */
async function environment(run, page, extra = {}) {
  const e = await read(page, () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const canvas = document.querySelector('#app > canvas');
    const g = window.__game;
    return {
      userAgent: navigator.userAgent,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      viewport: { width: innerWidth, height: innerHeight },
      drawingBuffer: { width: canvas.width, height: canvas.height },
      dpr: devicePixelRatio,
      track: g.T.DEF.id,
      car: g.R.savedCar(),
      camera: g.view ?? 'follow',   // the baseline has no hook, but starting a session sets follow in every build
      preset: g.preset ?? 'none (build has no presets)',
      drawCalls: g.info().calls,
      triangles: g.info().tris,
    };
  });
  return { machine: run.machine, commit: run.commit, revision: run.revision, url: run.url, browser: `${run.browser.browserType().name()} ${run.browser.version()}`, headed: !!run.headed, os: `${os.type()} ${os.release()} ${os.arch()}`, ...e, acceleration: accelerationOf(e.renderer), ...extra };
}

/** Click a HUD button that compact layouts keep in the More tray. */
async function utility(page, selector) {
  const tray = await page.locator('#b-more').isVisible();
  if (tray) await page.click('#b-more');
  await page.click(selector);
  if (tray) await page.click('#b-more');
}

async function pickRaceSetup(page) {
  await page.click(`.track[data-id="${TRACK}"]`);
  await page.click(`.car[data-car="${CAR}"]`);
}

// ------------------------------------------------------------ scenarios
/** Every configured circuit loads through the title screen and draws a real picture in both camera views. */
async function tracks(run, c) {
  // the HUD has a fixed size, so a tiny window shows little of the circuit; CSS size is cheap at Low
  const s = await open(run, { viewport: { width: Math.max(run.viewport.width, 960), height: Math.max(run.viewport.height, 540) } });
  const { page, keys } = s;
  const ids = await read(page, () => window.__game.T.TRACKS.map((t) => t.id));
  c.evidence.tracks = [];
  for (const id of ids) {
    await page.click(`.track[data-id="${id}"]`);
    await page.click('#o-start');
    await frames(page, 4);
    const follow = await pixels(page);
    await page.screenshot({ path: path.join(run.out, `track-${id}-follow.png`) });
    await keys.tap('KeyC');
    await sleep(2000);
    await frames(page, 2);
    const full = await pixels(page);
    await page.screenshot({ path: path.join(run.out, `track-${id}-full.png`) });
    const g = await game(page);
    const calls = await read(page, () => window.__game.info().calls);
    c.ok(`${id} loads and draws`, g.track === id && g.screen === 'race' && calls > 50 && follow.colours > 20 && full.colours > 20 && follow.lumaStdev > 3 && full.lumaStdev > 3, { calls, follow, full });
    c.evidence.tracks.push({ id, calls, follow, full });
    await keys.tap('Escape');
    await page.click('#o-menu');
  }
  return s;
}

/** The representative scenario: one complete 13-lap race through real frames and real keys. */
async function race(run, c) {
  const s = await open(run);
  const { page, keys } = s;
  await pickRaceSetup(page);
  c.ok('Clubman Park and Sunburst selected on the title screen', await read(page, (x) => document.querySelector('.track.sel').dataset.id === x.t && document.querySelector('.car.sel').dataset.car === x.c, { t: TRACK, c: CAR }));
  await page.click('#o-start');
  const start = await game(page);
  c.ok('Race mode starts on the grid in countdown', start.mode === 'race' && start.screen === 'race' && start.phase === 'countdown' && start.pmode === 'grid', start);
  c.evidence.environment = await environment(run, page, { workload: `${LAPS}-lap race, real keys` });

  // W is held through the lights: the car must wait for the start
  await keys.set('KeyW', true);
  await driveUntil(s, (st) => st.phase === 'racing', { budgetMs: 20000, opts: { holdOnGrid: true } });

  // checks that run while the car keeps being driven: one key per poll, each confirmed by the next read
  const views = [
    { label: 'C to full', act: () => keys.tap('KeyC'), want: 'full' },
    { label: 'wheel zoom back to follow', act: () => page.mouse.wheel(0, 120), want: 'follow' },
    { label: 'view button to full', act: () => utility(page, '#b-view'), want: 'full' },
    { label: 'C to follow', act: () => keys.tap('KeyC'), want: 'follow' },
  ];
  let view = null, viewAt = 0, paused = false;
  const onTick = async (st) => {
    if (st.lap >= 1 && views.length) {
      if (view && st.view === view.want) { c.ok(`Camera: ${view.label}`, true); views.shift(); view = null; }
      else if (view && Date.now() - viewAt > 4000) { c.ok(`Camera: ${view.label}`, false, st.view); views.shift(); view = null; }
      if (!view && views.length) { view = views[0]; viewAt = Date.now(); await view.act(); }
    }
    if (st.lap >= 2 && !paused) {
      paused = true;
      await keys.release();   // a pause ends every hold, so the driver presses again after it
      await keys.tap('Escape');
      await waitFor(page, () => window.__game.screen === 'pause');
      const a = await game(page);
      await sleep(2000);
      const b = await game(page);
      const card = await page.locator('.overlay.show #o-resume').isVisible();
      await page.screenshot({ path: path.join(run.out, 'race-paused.png') });
      await keys.tap('Escape');
      await waitFor(page, () => window.__game.screen === 'race');
      c.ok('Esc pauses, the clock stops and Esc resumes', a.raceTime === b.raceTime && a.t === b.t && card, { raceTimeAtPause: a.raceTime, afterTwoSeconds: b.raceTime });
      c.evidence.pauseLabel = 'race-paused.png is the pause card, not a finish or results screen';
    }
  };
  const end = await driveUntil(s, (st) => st.finished, { budgetMs: run.raceBudgetMs, opts: { laneTest: true }, onTick });
  await keys.release();
  c.ok('Player reached the chequered flag', end.lap === LAPS, end);
  c.ok('No unplanned pause during the race', !s.unexpectedPauses, s.unexpectedPauses ?? 0);

  await waitFor(page, () => window.__game.screen === 'results');
  const res = await read(page, () => {
    const r = window.__game.race, p = r.player, rows = [...document.querySelectorAll('.card.results tbody tr')];
    return { phase: r.phase, lapsDone: p.lapsDone, finished: p.finished, finishTime: p.finishTime, bestLap: p.bestLap, pitStops: p.pitStops, offences: p.offences, timePen: p.timePen, heading: document.querySelector('.card.results h2').textContent, place: document.querySelector('.card.results .place').textContent, rows: rows.map((x) => [...x.children].map((td) => td.textContent.trim()).join(' | ')), mine: document.querySelector('.card.results tr.me')?.textContent ?? '', board: window.__game.R.board('race', 'circuit-1').length, playerResult: r.results().find((x) => x.car.isPlayer).time, again: !!document.getElementById('o-again') };
  });
  await page.setViewportSize({ width: Math.max(run.viewport.width, 960), height: Math.max(run.viewport.height, 620) });
  await frames(page, 2);
  await page.screenshot({ path: path.join(run.out, 'race-results.png') });
  await page.setViewportSize(run.viewport);
  c.ok('Real results screen: phase done, four rows, restart offered', res.phase === 'done' && res.rows.length === 4 && res.again && !!res.mine, { heading: res.heading, place: res.place, rows: res.rows });

  const { rows, log } = await capture(page);
  const results = rows.findIndex((r) => r.screen === 'results');
  const racing = rows.slice(0, results + 1);
  const ev = (k) => log.filter((e) => e.key === k);
  const stats = summarise(racing);
  c.evidence.frames = stats;
  c.evidence.results = res;

  const lights = ev('lights').map((e) => e.value).filter((v) => v > 0);
  c.ok('Countdown showed lights 1 to 5, then GO', [1, 2, 3, 4, 5].every((n) => lights.includes(n)) && ev('phase').some((e) => e.value === 'racing'), lights);
  const grid = racing.filter((r) => r.phase === 'countdown' && r.screen === 'race');
  c.ok('W held through the lights revved the car but did not move it', Math.max(...grid.map((r) => r.v)) === 0 && Math.max(...grid.map((r) => r.throttle)) > 0.9, { countdownFrames: grid.length });
  const peak = Math.max(...racing.filter((r) => r.phase === 'racing').map((r) => r.throttle));
  const vmax = Math.max(...racing.map((r) => r.v));
  c.ok('Throttle: W reached full throttle and speed', peak >= 0.99 && vmax > 15, { peakThrottle: peak, topSpeed: vmax });
  const braked = racing.filter((r, i) => i && r.brake > 0 && r.v < racing[i - 1].v && r.phase === 'racing').length;
  c.ok('Brake: S slowed the car', braked > 20, { brakingFrames: braked });
  const lanes = ev('lane').map((e) => e.value);
  c.ok('Lane request: Space armed a change and the car moved lane and back', ev('laneReq').some((e) => e.value === true) && lanes.includes(1) && lanes.includes('changing') && lanes.filter((v) => v === -1).length >= 2, lanes.slice(0, 8));
  const modes = ev('mode').map((e) => e.value);
  const stops = modes.filter((m) => m === 'service').length;
  c.ok('Pit request armed by P', ev('pitReq').some((e) => e.value === true));
  c.ok('Pit entry, service and exit, in order', ['pitlane', 'bayIn', 'service', 'bayOut', 'pitlane', 'race'].every((m, i, a) => modes.join().includes(a.slice(0, i + 1).join())) && res.pitStops >= 1, { pitStops: res.pitStops, modes });
  c.evidence.pit = ev('mode').filter((e) => ['pitlane', 'bayIn', 'service', 'bayOut', 'off', 'tow'].includes(e.value)).map((e) => ({ raceTime: e.raceTime, mode: e.value }));
  c.evidence.toasts = ev('toast').map((e) => e.value).filter(Boolean);
  c.ok('Refuelling message shown in the pit', c.evidence.toasts.some((t) => t.startsWith(text('msg.refuelling'))), stops);

  const laps = ev('lap').map((e) => e.value).filter((v) => v > 0);
  c.ok(`Lap counter ran 1 to ${LAPS}, once each`, laps.length === LAPS && laps.every((v, i) => v === i + 1), laps);
  const times = ev('lastLap').map((e) => e.value).filter((v) => v > 0);
  const firstCross = res.finishTime - times.reduce((a, b) => a + b, 0);
  c.ok('Lap times add up to the finish time', times.length === LAPS && firstCross >= 0 && firstCross < 2, { laps: times, finishTime: res.finishTime, timeBeforeFirstCrossing: firstCross });
  c.evidence.laps = times;

  const a = stats.active;
  c.ok('Clock policy: race time equals active wall time less dropped time', Math.abs(a.clockErrorSec) <= CLOCK_TOLERANCE_SEC, a);

  // restart from the results screen
  await page.click('#o-again');
  await frames(page, 2);
  const again = await game(page);
  c.ok('Play again gives a fresh countdown, zero clock and a full tank', again.screen === 'race' && again.phase === 'countdown' && again.raceTime === 0 && again.lap === 0 && again.fuel === 1, again);
  return s;
}

/** Pit and stop-and-go routing with real keys and frames: a fuel stop on every circuit, then a stop-and-go. Cars are placed by script: functional coverage only. */
async function routing(run, c) {
  // the default small window matters here: the penalty box is 2.2 m long, so a software renderer's slower frames at a larger size step right over it
  const s = await open(run);
  const { page, keys } = s;
  const CYAN = 0x22d3ee, YELLOW = 0xffd23f;
  const chips = () => page.locator('#h-chips').textContent();
  const arrows = () => read(page, () => { const a = window.__game.arrows; return { lane: a.lane.visible, pit: a.pit.visible, laneColour: a.lane.material.color.getHex(), pitColour: a.pit.material.color.getHex() }; });
  /** a running race with the player on the inside lane, short of the last switch before the pit entrance, on a low tank */
  const approach = (id) => read(page, (x) => {
    const g = window.__game, T = g.T;
    g.applyTrack(x);
    g.startSession('race');
    g.advance(7);
    const r = g.race, p = r.player;
    const sw = [...T.SWITCHES].sort((a, b) => T.ahead(a.s1, T.PIT_IN0) - T.ahead(b.s1, T.PIT_IN0))[0];
    const put = (car, u, side, v) => { car.u = u; car.laneSide = side; car.d = side * T.LANE_HALF; car.v = v; car.change = null; car.mode = 'race'; car.throttle = 0; car.graceT = 0; car.recoverT = 0; car.cutT = 0; car.pushedT = 0; };
    const u = p.crossed * T.L + T.wrapS(sw.s0 - 20);
    r.cars.forEach((o, i) => { if (i) put(o, u + T.L / 2 + i * 8, 1, 0); });
    put(p, u, 1, 10);
    r.squeezeQ.length = 0; // a car moved by script past the squeeze never leaves its queue, and would hold everyone behind it
    p.fuel = 0.2;
    return sw.s0;
  }, id);
  const held = { budgetMs: 60000, opts: { laps: 3 } };
  const ids = await read(page, () => window.__game.T.TRACKS.map((t) => t.id));

  for (const id of ids) {
    const first = id === ids[0];
    await keys.release();
    const sw = await approach(id);
    await keys.tap('KeyP');
    await frames(page, 3);
    if (first) {
      c.ok('Fuel: chip shows the automatic move outside', (await chips()).includes(STRINGS['hud.routeOutsideMove']), await chips());
      const a = await arrows();
      c.ok('Fuel: cyan lane and pit arrows show the automatic route', a.lane && a.pit && a.laneColour === CYAN && a.pitColour === CYAN, a);
      await keys.tap('Space');
      await frames(page, 3);
      c.ok('Fuel: Space shows the one-switch inside choice as staying in lane', (await chips()).includes(STRINGS['hud.routeInsideStay']), await chips());
      const b = await arrows();
      c.ok('Fuel: arrows show the override, and warn the pit entrance will be missed', b.lane && b.laneColour === YELLOW && b.pitColour !== CYAN, b);
      await page.screenshot({ path: path.join(run.out, 'routing-override.png') });
      await keys.tap('Space');
      await frames(page, 3);
      c.ok('Fuel: a second Space restores automatic outside', (await chips()).includes(STRINGS['hud.routeOutsideMove']), await chips());
    }
    const entry = await driveUntil(s, (st) => st.mode === 'pitlane', held);
    const inPit = await read(page, () => { const p = window.__game.race.player; return { pitReq: p.pitReq, override: p.laneOverride, moved: p.laneSide }; });
    c.ok(`${id}: routed outside from the inside lane and entered the pits with no lane key`, entry.mode === 'pitlane' && !inPit.pitReq && !inPit.override, { sw, ...inPit });
    if (!first) continue;
    await driveUntil(s, (st) => st.mode === 'service', held);
    const out = await driveUntil(s, (st) => st.mode === 'race', held);
    await frames(page, 3);
    const after = await read(page, () => { const p = window.__game.race.player; return { pitReq: p.pitReq, fuel: p.fuel, pitStops: p.pitStops }; });
    c.ok('Fuel: serviced, rejoined and the request is over', out.mode === 'race' && !after.pitReq && after.fuel > 0.3 && after.pitStops >= 1, after);
    c.ok('Fuel: no route chip after the stop', !(await chips()).includes('PIT ROUTE'), await chips());
    await keys.release();
  }

  // stop-and-go: same routing with no P key
  await keys.release();
  await approach(ids[0]);
  await read(page, () => { const r = window.__game.race, p = r.player; p.fuel = 1; p.offences = 2; r.offence(p, r.cars[2], 'rear'); p.sgSkipNext = false; });
  await frames(page, 3);
  c.ok('Stop-and-go: award alone shows the automatic route', (await chips()).includes(STRINGS['hud.routeOutsideMove']) && (await chips()).includes(STRINGS['hud.sgChip']), await chips());
  await keys.tap('Space');
  await frames(page, 3);
  const over = await read(page, () => { const p = window.__game.race.player; return { sgOwed: p.sgOwed, sgChances: p.sgChances, pitReq: p.pitReq, override: p.laneOverride }; });
  c.ok('Stop-and-go: override keeps the penalty and its deadline', over.override && over.pitReq && over.sgOwed === 3 && over.sgChances === 2, over);
  await keys.tap('Space');
  await frames(page, 3);
  const served = await driveUntil(s, (st) => st.sgOwed === 0, held);
  const left = await driveUntil(s, (st) => st.mode === 'race', held);
  await keys.release();
  await frames(page, 3);
  const end = await read(page, () => { const p = window.__game.race.player; return { timePen: p.timePen, sgOwed: p.sgOwed, pitReq: p.pitReq, penaltyOnly: p.pitPenaltyOnly }; });
  c.evidence.stopAndGo = await read(page, () => window.__qa.log.filter((e) => ['pitReq', 'lane', 'mode', 'toast'].includes(e.key)).slice(-16).map((e) => `${e.raceTime.toFixed(1)} ${e.key}=${e.value}`));
  c.ok('Stop-and-go: routed in, served in the box, no time penalty, no stale request', served.mode === 'pitlane' && left.mode === 'race' && end.timePen === 0 && !end.pitReq && !end.penaltyOnly, end);
  return s;
}

/** Penalties, de-slot and recovery, and page lifecycle. Set up with scripted state and __game.advance: functional coverage only. */
async function controlled(run, c) {
  const s = await open(run);
  const { page, keys } = s;
  const setup = () => read(page, () => {
    const g = window.__game;
    g.startSession('race');
    g.advance(7);
    window.__put = (car, u, side, v) => { const T = g.T; car.u = u; car.laneSide = side; car.d = side * T.LANE_HALF; car.v = v; car.change = null; car.mode = 'race'; car.throttle = 0; car.graceT = 0; car.recoverT = 0; car.cutT = 0; car.pushedT = 0; };
  });
  await setup();

  // de-slot: a real grip failure, entering the tightest corner flat out
  await keys.set('KeyW', true);
  const off = await read(page, () => {
    const g = window.__game, T = g.T, r = g.race, p = r.player;
    let s0 = 40, k = 0;
    for (let x = 40; x < T.L - 20; x += 0.5) if (Math.abs(T.curvature(x)) > k) { k = Math.abs(T.curvature(x)); s0 = x; }
    r.cars.forEach((x, i) => { if (i) window.__put(x, s0 + 40 + i * 8, 1, 0); });
    window.__put(p, s0 + p.crossed * T.L, 1, 25);
    g.advance(0.6);
    return { mode: p.mode, u0: p.off?.u0 ?? null, lapValid: p.lapValid };
  });
  await keys.set('KeyW', false);
  await frames(page, 2);
  c.ok('De-slot: overspeed left the slot and voided the lap', off.mode === 'off' && !off.lapValid, off);
  c.ok('De-slot message shown', (await toast(page)).startsWith(text('msg.deslot')));
  await waitFor(page, () => window.__game.race.player.mode === 'race', undefined, 20000);
  const back = await read(page, () => { const p = window.__game.race.player; return { u: p.u, recoverT: p.recoverT, graceT: p.graceT, v: p.v }; });
  await frames(page, 2);
  c.ok('Recovery: marshal replaced the car behind the exit with grace', Math.abs(back.u - (off.u0 - 1.6)) < 0.5 && back.graceT > 0, back);
  c.ok('Recovery message shown', (await toast(page)).startsWith(text('msg.backOn')));

  // penalties: real contacts judged by the real collision code
  await setup();
  const hit = () => read(page, () => {
    const g = window.__game, T = g.T, r = g.race, p = r.player, a = r.cars[2];
    const base = 40 + p.crossed * T.L;
    r.cars.forEach((x, i) => { if (i && x !== a) window.__put(x, base + 30 + i * 8, 1, 0); });
    window.__put(a, base, 1, 10);
    window.__put(p, base - T.CAR_LEN + 0.1, 1, 16);
    g.advance(0.01);
    window.__put(p, base - 6, 1, 10);
    g.advance(0.03);
    return { offences: p.offences, sgOwed: p.sgOwed, pitReq: p.pitReq, lapValid: p.lapValid };
  });
  const h1 = await hit();
  await frames(page, 2);
  c.ok('First rear-end contact is a warning', h1.offences === 1 && h1.sgOwed === 0, h1);
  c.ok('Warning shown', (await toast(page)).startsWith(text('pen.warn1')));
  await hit();
  const h3 = await hit();
  await frames(page, 2);
  c.ok('Third contact issues a stop-and-go and arms the pit', h3.offences === 3 && h3.sgOwed === 3 && h3.pitReq, h3);
  c.ok('Stop-and-go chip shown on the HUD', (await page.locator('#h-chips').textContent()).includes(STRINGS['hud.sgChip']));
  // serve it with real keys, stopping in the box
  await read(page, () => { const g = window.__game, T = g.T, r = g.race, p = r.player; r.cars.forEach((x, i) => { if (i) window.__put(x, (p.crossed + 1) * T.L + 60 + i * 8, 1, 0); }); window.__put(p, p.crossed * T.L + T.L - 10, -1, 8); p.pitReq = true; });
  const served = await driveUntil(s, (st) => st.sgOwed === 0, { budgetMs: 40000 });
  await keys.release();
  await frames(page, 2);
  const servedState = await read(page, () => { const p = window.__game.race.player; return { timePen: p.timePen, sgOwed: p.sgOwed, mode: p.mode }; });
  c.ok('Stop-and-go served in the box with no time penalty', served.mode === 'pitlane' && servedState.timePen === 0, servedState);
  c.ok('Served message shown', (await toast(page)).startsWith(text('msg.penServed')));

  // an unserved stop becomes a time penalty on the real results screen
  await hit();
  const finish = await read(page, () => {
    const g = window.__game, T = g.T, r = g.race, p = r.player;
    const owed = p.sgOwed;
    window.__put(p, T.FINISH_S + 13 * T.L - 3, -1, 16);
    p.crossed = 13; p.lapsDone = 12; p.sectors = 7;
    return { owed, timeBefore: p.timePen };
  });
  await keys.set('KeyW', true);
  await read(page, () => window.__game.advance(5));
  await keys.release();
  await waitFor(page, () => window.__game.screen === 'results');
  const res = await read(page, () => { const r = window.__game.race, p = r.player; const mine = r.results().find((x) => x.car.isPlayer); return { timePen: p.timePen, time: mine.time, finishTime: p.finishTime, row: document.querySelector('.card.results tr.me').textContent }; });
  c.ok('Unserved stop adds its time penalty at the flag and on the results screen', finish.owed === 3 && res.timePen === 10 && Math.abs(res.time - res.finishTime - 10) < 0.001 && res.row.includes('10'), res);

  // lifecycle. Blur and hidden are synthetic events here: headless pages cannot really lose focus
  await setup();
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.player.throttle > 0.9);
  await read(page, () => window.dispatchEvent(new Event('blur')));
  const blurred = await game(page);
  await page.click('#o-resume');
  // settling takes about 0.12 s of race time however many frames that is. Bounded in race time, so a throttle that never falls reaches the check below instead of a timeout
  await waitFor(page, (until) => { const g = window.__game, r = g.race; return g.screen !== 'race' || r.player.throttle < 0.05 || r.raceTime >= until; }, blurred.raceTime + 0.5);
  const afterBlur = await game(page);
  await keys.release();
  c.ok('Blur (synthetic) pauses and clears held keys', blurred.screen === 'pause' && afterBlur.screen === 'race' && afterBlur.throttle < 0.05, { blurred: blurred.screen, throttleAfterResume: afterBlur.throttle });

  const hide = (hidden) => read(page, (h) => { Object.defineProperty(document, 'hidden', { get: () => h, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  await hide(true);
  const h0 = await game(page);
  const hiddenFrom = await read(page, () => window.__qa.rows.length);
  await sleep(3000);
  const h1b = await game(page);
  await hide(false);
  await page.click('#o-resume');
  await frames(page, 3);
  // the policy's promise, read from the frames: the first callback back counts zero elapsed time, so nothing is replayed or dropped
  const back2 = await read(page, (from) => {
    const rows = window.__qa.rows;
    let i = from;
    while (rows[i].screen !== 'race') i++;
    return { raced: rows[i].raceTime - rows[i - 1].raceTime, dropped: rows[i].dropped - rows[i - 1].dropped };
  }, hiddenFrom);
  c.ok('Hidden tab (synthetic) pauses, and 3 s away is not replayed', h0.screen === 'pause' && h0.raceTime === h1b.raceTime && back2.raced === 0 && back2.dropped === 0, { hiddenFor: 3, firstCallbackBack: back2 });

  c.unavailable('Real window blur and tab switch', 'not automated: the two checks above dispatch synthetic events');

  // a real stall: block the main thread and let the policy deal with it
  await frames(page, 3);
  const stallFrom = await read(page, () => { const t = performance.now(); while (performance.now() - t < 1500); return window.__qa.rows.length; });
  await frames(page, 3);
  const stall = await read(page, (from) => {
    const rows = window.__qa.rows;
    let i = from;   // the first frame after the stall began; scripted set-up earlier also blocks the page
    for (let j = from; j + 1 < rows.length; j++) if (rows[j].ts - rows[j - 1].ts > rows[i].ts - rows[i - 1].ts) i = j;
    const a = rows[i - 1], b = rows[i], next = rows[i + 1];
    return { gapSec: (b.ts - a.ts) / 1000, raced: b.raceTime - a.raceTime, dropped: b.dropped - a.dropped, nextGapSec: (next.ts - b.ts) / 1000, nextRaced: next.raceTime - b.raceTime };
  }, stallFrom);
  c.ok('1.5 s main-thread stall: 250 ms raced, the rest dropped, no burst after', stall.gapSec >= 1.5 && stall.raced <= 0.25 + CLOCK_TOLERANCE_SEC && Math.abs(stall.dropped - (stall.gapSec - 0.25)) < 0.01 && stall.nextRaced <= stall.nextGapSec + CLOCK_TOLERANCE_SEC, stall);

  const size = await read(page, () => ({ w: innerWidth, h: innerHeight }));
  await page.setViewportSize({ width: size.w + 160, height: size.h + 90 });
  await frames(page, 3);
  const buf = await read(page, () => { const k = document.querySelector('#app > canvas'); return { w: k.width, h: k.height, cssW: k.clientWidth, cssH: k.clientHeight, screen: window.__game.screen }; });
  c.ok('Resize follows the window and leaves the race running', buf.cssW === size.w + 160 && buf.cssH === size.h + 90 && buf.screen === 'race', buf);

  await keys.tap('KeyR');
  await frames(page, 2);
  const r = await game(page);
  c.ok('R restarts to a fresh countdown', r.phase === 'countdown' && r.raceTime === 0 && r.lap === 0, r);
  return s;
}

/** Valid and invalid practice laps, ghost save, replay and reload, against fixture saves that must survive. */
async function practice(run, c) {
  const other = JSON.stringify({ v: 1, track: 'circuit-2', car: 'frost', initials: 'OLD', L: 300, ms: 40000, s: [0, 0, 0, 0, 1, 1, 0, 0] });
  const slow = JSON.stringify([{ id: 'fixture', initials: 'OLD', car: 'frost', ms: 590000, at: 1 }]);
  const fixtures = { 'srgp.track': TRACK, 'srgp.initials': '"QA"', 'srgp.lb.practice.circuit-1': slow, 'srgp.lb.race.circuit-2': slow, 'srgp.ghost.circuit-2.frost.OLD': other };
  const s = await open(run, { fixtures });
  const { page, keys } = s;
  const key = 'srgp.ghost.circuit-1.sunburst.QA';
  await page.click('#o-practice');
  const opts = { laps: 1e6 };

  // the out-lap crosses the line almost at once; the next crossing completes the first timed lap
  await driveUntil(s, (st) => st.lap >= 1, { budgetMs: 90000, opts });
  await frames(page, 2);
  const first = await read(page, (k) => { const g = window.__game, gd = JSON.parse(localStorage.getItem(k) ?? 'null'); return { pbMs: g.pbMs, ghostMs: gd?.ms ?? null, samples: gd ? gd.s.length / 4 : 0, ghostLoaded: g.ghost.data?.ms ?? null, board: g.R.board('practice', 'circuit-1').map((r) => ({ initials: r.initials, ms: r.ms })) }; }, key);
  c.ok('Valid lap sets a PB, joins the board and saves a ghost', first.pbMs > 0 && first.ghostMs === first.pbMs && first.board.length === 2 && first.board[0].ms === first.pbMs, first);
  c.ok('Ghost samples at about 20 Hz', Math.abs(first.samples - (first.pbMs / 1000) * 20) < 5, { samples: first.samples, lapSec: first.pbMs / 1000 });
  c.ok('Fixture lap kept on the board', first.board.some((r) => r.ms === 590000));

  // replay on the next lap: a visible ghost moving round the circuit behind the same timeline
  const samples = [];
  for (let i = 0; i < 4; i++) {
    await driveFor(s, 1500, opts);
    samples.push(await read(page, () => {
      const gm = window.__game, T = gm.T, g = gm.ghost, v = g.visual.group, d = g.data.s;
      // where the saved recording says the ghost is now, found independently of GhostPlayer
      const t = gm.race.raceTime - g.t0;
      let i = 0;
      while (i + 2 < d.length / 4 && d[(i + 1) * 4] <= t) i++;
      const f = Math.max(0, Math.min(1, (t - d[i * 4]) / (d[i * 4 + 4] - d[i * 4])));
      const mix = (k) => d[i * 4 + k] + (d[i * 4 + 4 + k] - d[i * 4 + k]) * f;
      const want = T.point3(T.FINISH_S + mix(1), mix(2));
      return { running: g.running, visible: v.visible, x: v.position.x, z: v.position.z, offRecording: Math.hypot(v.position.x - want.x, v.position.z + want.y) };
    }));
  }
  const moved = samples.slice(1).every((p, i) => Math.hypot(p.x - samples[i].x, p.z - samples[i].z) > 1);
  c.ok('Ghost replays the saved lap: running, visible, moving and on its recorded path', samples.every((p) => p.running && p.visible && p.offRecording < 1) && moved, samples);
  await page.screenshot({ path: path.join(run.out, 'practice-ghost.png') });

  // a de-slot voids the lap: no record, no new ghost
  const before = await read(page, (k) => ({ pb: window.__game.pbMs, board: window.__game.R.board('practice', 'circuit-1').length, ghost: localStorage.getItem(k) }), key);
  await read(page, () => { const r = window.__game.race; r.deslot(r.player); });
  const lapNow = (await game(page)).lap;
  await driveUntil(s, (st) => st.lap > lapNow, { budgetMs: 60000, opts });
  await frames(page, 2);
  const after = await read(page, (k) => ({ pb: window.__game.pbMs, board: window.__game.R.board('practice', 'circuit-1').length, ghost: localStorage.getItem(k), lastLapInvalid: document.getElementById('h-toast').textContent }), key);
  c.ok('Invalid lap saves nothing', after.pb === before.pb && after.board === before.board && after.ghost === before.ghost, { pb: after.pb, board: after.board });
  c.ok('Invalid lap is announced', after.lastLapInvalid.startsWith(text('msg.lapInvalid')), after.lastLapInvalid);
  await keys.release();

  // reload: the save must come back and replay
  await s.load();
  await page.click('#o-practice');
  await frames(page, 2);
  const loaded = await read(page, () => { const g = window.__game; return { ghostMs: g.ghost.data?.ms ?? null, pbMs: g.pbMs }; });
  c.ok('Ghost and PB load after a reload', loaded.ghostMs === before.pb && loaded.pbMs === before.pb, loaded);
  await driveUntil(s, (st) => st.crossed >= 1, { budgetMs: 30000, opts });
  await driveFor(s, 2000, opts);
  await keys.release();
  c.ok('Reloaded ghost launches at the line', await read(page, () => window.__game.ghost.running && window.__game.ghost.visual.group.visible));

  const untouched = await read(page, (f) => Object.keys(f).filter((k) => k !== 'srgp.lb.practice.circuit-1').filter((k) => localStorage.getItem(k) !== f[k]), fixtures);
  c.ok('Fixture saves for other tracks and cars are byte-identical', untouched.length === 0, untouched);
  return s;
}

/** Championship save and load against fixtures, including a damaged save. The race itself is skipped with scripted state. */
async function championship(run, c) {
  const round = (track) => ({ track, order: [0, 1, 2, 3].map((idx, i) => ({ idx, dnf: false, time: 300 + i })) });
  const champ = JSON.stringify({ v: 1, car: CAR, initials: 'QA', rounds: [round('circuit-1'), round('circuit-2')], startedAt: 1 });
  const keep = { 'srgp.initials': '"QA"', 'srgp.lb.race.circuit-1': JSON.stringify([{ id: 'fixture', initials: 'OLD', car: 'frost', ms: 590000, at: 1 }]) };
  const s = await open(run, { fixtures: { 'srgp.champ': champ, ...keep } });
  const { page, keys } = s;

  const cont = page.locator('#o-champ-cont');
  c.ok('Saved championship offers round 3 of 4', (await cont.textContent()).includes('3'), await cont.textContent());
  await cont.click();
  await frames(page, 2);
  const g = await game(page);
  c.ok('Continue loads the third championship circuit', g.mode === 'champ' && g.track === 'circuit-4' && g.screen === 'race', { mode: g.mode, track: g.track });

  await read(page, () => {
    const gm = window.__game, T = gm.T, r = gm.race, p = r.player;
    gm.advance(7);
    r.cars.forEach((x, i) => { if (i) x.u += 40 + i * 8; });
    p.u = T.FINISH_S + 13 * T.L - 3; p.crossed = 13; p.lapsDone = 12; p.sectors = 7; p.v = 16; p.mode = 'race';
  });
  await keys.set('KeyW', true);
  await read(page, () => window.__game.advance(5));
  await keys.release();
  await waitFor(page, () => window.__game.screen === 'champ');
  await frames(page, 2);
  const saved = await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')));
  c.ok('Finished round is stored once, against the right circuit', saved.rounds.length === 3 && saved.rounds[2].track === 'circuit-4', saved.rounds.map((r) => r.track));
  c.ok('Round 1 and 2 results unchanged', JSON.stringify(saved.rounds.slice(0, 2)) === JSON.stringify(JSON.parse(champ).rounds));
  await page.screenshot({ path: path.join(run.out, 'championship-standings.png') });

  // the standings screen must not award the round again on the next frames or on a reload
  await frames(page, 4);
  await s.load();
  const reread = await read(page, () => ({ rounds: window.__game.R.loadChamp().rounds.length, button: document.getElementById('o-champ-cont')?.textContent ?? '' }));
  c.ok('Reload keeps three rounds and offers round 4', reread.rounds === 3 && reread.button.includes('4'), reread);

  for (const [name, bad] of [['corrupt JSON', '{oops'], ['wrong version', '{"v":99,"rounds":[]}']]) {
    await read(page, (b) => localStorage.setItem('srgp.champ', b), bad);
    await s.load();
    c.ok(`Damaged championship save (${name}) leaves a working title screen`, await read(page, () => window.__game.screen === 'title' && !!document.getElementById('o-champ') && !document.getElementById('o-champ-cont')));
  }
  const kept = await read(page, (f) => Object.keys(f).filter((k) => localStorage.getItem(k) !== f[k]), keep);
  c.ok('Other saves are byte-identical', kept.length === 0, kept);
  return s;
}

/**
 * Touch through the browser's own input pipeline: real pointer, touch and capture events, with several fingers at once.
 * This is Chromium's touch emulation. No physical touchscreen is involved. Fingers are placed on a control's centre or a point.
 */
class Fingers {
  points = new Map();
  next = 1;
  constructor(page, cdp) { this.page = page; this.cdp = cdp; }
  /** a touch the page never acknowledges must fail this check, not stall the run */
  async dispatch(type, touchPoints) { await Promise.race([this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints }), sleep(5000).then(() => { throw new Error(`${type} was not acknowledged`); })]); }
  send(type) { return this.dispatch(type, [...this.points].map(([id, p]) => ({ id, ...p }))); }
  async at(selector) {
    if (typeof selector !== 'string') return selector;
    const b = await this.page.locator(selector).boundingBox();
    if (!b) throw new Error(`${selector} is not visible`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  /** a new finger on a control or a point; returns its id */
  async put(selector) { const id = this.next++; this.points.set(id, await this.at(selector)); await this.send('touchStart'); return id; }
  async slide(id, x, y) { this.points.set(id, { x, y }); await this.send('touchMove'); }
  /** touchEnd naming one point lifts that finger alone; the others stay down */
  async lift(id) { const p = this.points.get(id); this.points.delete(id); await this.dispatch('touchEnd', [{ id, ...p }]); }
  async tap(selector) { await this.lift(await this.put(selector)); }
  /** the browser takes every finger away, as it does for a system gesture */
  async cancel() { this.points.clear(); await this.send('touchCancel'); }
}

/** The Keys interface played on the touch pad, so the shared driver can drive by touch alone. */
class PadKeys {
  held = new Map();
  constructor(fingers) { this.fingers = fingers; }
  async set(code, on) {
    if (on === this.held.has(code)) return;
    if (on) this.held.set(code, await this.fingers.put(code === 'KeyW' ? '#t-throttle' : '#t-brake'));
    else { await this.fingers.lift(this.held.get(code)); this.held.delete(code); }
  }
  async tap(code) { await this.fingers.tap({ Space: '#t-lane', KeyP: '#t-pit', Escape: '#t-pause' }[code]); }
  async release() { for (const k of [...this.held.keys()]) await this.set(k, false); }
}

const PHONE = { hasTouch: true, isMobile: true };

/** Touch mode end to end, on Chromium's touch emulation and on a mouse. No physical device: see docs/touch.md. */
async function touch(run, c) {
  const held = (page) => read(page, () => { const i = window.__game.input, on = (x) => document.getElementById(x).classList.contains('down'); return { throttle: i.held('throttle'), brake: i.held('brake'), throttleDown: on('t-throttle'), brakeDown: on('t-brake') }; });
  const clear = (h) => !h.throttle && !h.brake && !h.throttleDown && !h.brakeDown;
  const padShown = (page) => read(page, () => ({ body: document.body.classList.contains('touch'), pad: !document.getElementById('t-pad').hidden }));
  const radio = (page) => read(page, () => document.querySelector('[data-touch][aria-checked="true"]').dataset.touch);
  /** count every call the race receives, so a double dispatch cannot hide behind a toggle */
  const countActions = (page) => read(page, () => { const r = window.__game.race, n = (window.__qa.actions = { lane: 0, pit: 0, armed: [] }); for (const [m, k] of [['requestLane', 'lane'], ['requestPit', 'pit']]) { const f = r[m].bind(r); r[m] = () => { n[k]++; f(); if (k === 'lane') n.armed.push(r.player.laneReq); }; } });
  const actions = (page) => read(page, () => window.__qa.actions);
  const state = (page) => read(page, () => { const r = window.__game.race, p = r.player, cue = (x) => document.getElementById(x); return { laneReq: p.laneReq, pitReq: p.pitReq, only: p.pitPenaltyOnly, override: p.laneOverride, route: r.nextRoute(p), laneCue: cue('t-lane').dataset.cue, pitCue: cue('t-pit').dataset.cue, laneText: cue('t-lane-cue').textContent, pitText: cue('t-pit-cue').textContent, chips: cue('h-chips').textContent }; });

  // ---- desktop: no touch hardware, mouse and keyboard
  const d = await open(run);
  {
    const { page, keys } = d;
    c.ok('Desktop: Auto is selected by default and leaves touch off', await radio(page) === 'auto' && !(await padShown(page)).body, await padShown(page));
    await page.click('#o-ini');
    await page.keyboard.type('w p');
    const typed = await read(page, () => ({ value: document.getElementById('o-ini').value, screen: window.__game.screen }));
    c.ok('Typing W, Space and P in the initials box stays in the box', typed.screen === 'title' && typed.value === 'w p', typed);
    await page.focus('[data-touch="auto"]');
    for (const k of ['Space', 'Enter']) await keys.tap(k);
    c.ok('Space and Enter on the touch selector do not start a race', await read(page, () => window.__game.screen === 'title'));
    await page.focus('.car');
    await keys.tap('Space');
    c.ok('Space on a car button picks the car and does not start a race', await read(page, () => window.__game.screen === 'title'));
    await page.click('[data-touch="off"]');
    await page.reload();
    await page.waitForFunction(() => window.__game?.screen === 'title');
    c.ok('Off persists across a reload', await radio(page) === 'off' && await read(page, () => localStorage.getItem('srgp.touch')) === 'off');

    await page.click('#o-start');
    await keys.set('KeyW', true);
    await frames(page, 2);
    c.ok('Touch Off: the pad is hidden and W holds throttle', (await held(page)).throttle && !(await padShown(page)).pad);
    await keys.tap('Space');
    await keys.tap('KeyP');
    const kb = await read(page, () => { const p = window.__game.race.player; return { pitReq: p.pitReq, laneReq: p.laneReq }; });
    await keys.set('KeyW', false);
    c.ok('Touch Off: Space and P still reach the race and W releases', kb.pitReq && !(await held(page)).throttle, kb);

    // pause, switch mode, carry on: the race must not notice
    await keys.tap('Escape');
    const before = await game(page);
    await page.click('[data-touch="on"]');
    const after = await game(page);
    c.ok('Changing the setting while paused leaves the race as it was', after.screen === 'pause' && after.raceTime === before.raceTime && after.t === before.t && after.u === before.u, { before: before.t, after: after.t });
    await page.click('#o-resume');
    const on = await padShown(page);
    c.ok('Touch On: the pad appears on a desktop after resume', on.body && on.pad, on);

    // mouse on the pad: the same pointer code as a finger
    const pos = await page.locator('#t-throttle').boundingBox();
    await page.mouse.move(pos.x + 20, pos.y + 20);
    await page.mouse.down();
    const m1 = await held(page);
    await page.mouse.move(run.viewport.width / 2, 10);
    const m2 = await held(page);
    await page.mouse.up();
    const m3 = await held(page);
    c.ok('Mouse: hold survives sliding off the control and releases outside it', m1.throttle && m1.throttleDown && m2.throttle && clear(m3), { m1, m2, m3 });

    await keys.set('KeyW', true);
    await page.mouse.move(pos.x + 20, pos.y + 20);
    await page.mouse.down();
    await page.mouse.up();
    const mixed = await held(page);
    c.ok('Mixed: a pointer lifting does not release a held key', mixed.throttle && !mixed.throttleDown, mixed);
    await page.mouse.down();
    await keys.set('KeyW', false);
    const mixed2 = await held(page);
    await page.mouse.up();
    c.ok('Mixed: a key lifting does not release a held pointer', mixed2.throttle && mixed2.throttleDown && clear(await held(page)), mixed2);

    await keys.set('KeyW', true);
    await keys.tap('Escape');
    const paused = await held(page);
    await keys.tap('Escape');
    await page.keyboard.down('KeyW');   // the key is already down, so this arrives as auto-repeat
    await frames(page, 2);
    const repeat = await held(page);
    await page.keyboard.up('KeyW');
    keys.held.clear();
    await page.keyboard.down('KeyW');
    const fresh = await held(page);
    await page.keyboard.up('KeyW');
    c.ok('Keyboard: pause drops a held key, auto-repeat does not bring it back, a fresh press does', clear(paused) && clear(repeat) && fresh.throttle, { paused, repeat, fresh });
    await d.context.close();
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));

  // ---- storage that does not work
  for (const [name, fixture] of [['invalid', { 'srgp.touch': 'sideways' }], ['blocked', null]]) {
    const b = await open(run, { fixtures: fixture });
    if (!fixture) {
      await b.page.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function g(k) { if (k === 'srgp.touch') throw new Error('blocked'); return get.call(this, k); }; Storage.prototype.setItem = function s(k, v) { if (k === 'srgp.touch') throw new Error('blocked'); set.call(this, k, v); }; });
      await b.load();
      await b.page.click('[data-touch="on"]');
      c.ok('Blocked storage: the title loads and a choice lasts the session', await radio(b.page) === 'on' && (await padShown(b.page)).body && b.errors.length === 0, b.errors.slice(0, 3));
    } else c.ok('Invalid stored value falls back to Auto', await radio(b.page) === 'auto' && b.errors.length === 0);
    await b.context.close();
  }

  // ---- emulated phone: everything below is touch alone
  const viewport = { width: 667, height: 375 };
  const s = await open(run, { viewport, device: PHONE });
  const { page } = s;
  const cdp = await s.context.newCDPSession(page);
  const f = new Fingers(page, cdp);
  c.evidence.touch = await read(page, () => ({ coarse: matchMedia('(any-pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints }));
  c.ok('Emulated phone: Auto turns touch on from capability', (await padShown(page)).body && await radio(page) === 'auto', c.evidence.touch);
  const styles = await read(page, () => { const ta = (q) => getComputedStyle(document.querySelector(q)).touchAction; return { card: ta('.card'), canvas: ta('#app > canvas'), pad: ta('.tbtn'), view: getComputedStyle(document.querySelector('meta[name=viewport]') ? document.body : document.body).touchAction, meta: document.querySelector('meta[name=viewport]').content }; });
  c.ok('Gestures are suppressed on the pad only, and page zoom is not disabled', styles.pad === 'none' && styles.card === 'auto' && styles.canvas === 'auto' && !/user-scalable|maximum-scale/.test(styles.meta), styles);

  // the title card scrolls by finger
  const card = page.locator('.card.title');
  const box = await card.boundingBox();
  const swipe = await f.put({ x: box.x + box.width / 2, y: 300 });
  for (let i = 1; i <= 8; i++) { await f.slide(swipe, box.x + box.width / 2, 300 - i * 30); await sleep(16); }
  await f.lift(swipe);
  await sleep(300);
  const scrolled = await read(page, () => document.querySelector('.card.title').scrollTop);
  c.ok('Menus keep touch scrolling', scrolled > 0, { scrollTop: scrolled });

  await page.locator(`.track[data-id="${TRACK}"]`).tap();
  await page.locator(`.car[data-car="${CAR}"]`).tap();
  c.ok('Touch: car and track picked by tapping', await read(page, (x) => document.querySelector('.track.sel').dataset.id === x.t && document.querySelector('.car.sel').dataset.car === x.c, { t: TRACK, c: CAR }));
  await page.screenshot({ path: path.join(run.out, 'touch-title-phone.png') });
  await page.locator('#o-start').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.ok('Touch: Start begins a race and the pad shows', (await padShown(page)).pad);
  const audio = await read(page, () => window.__game.audio);
  c.ok('Touch: audio initialised by the tap on Start', audio !== null, audio);

  const thr = await f.put('#t-throttle');
  await waitFor(page, () => window.__game.race.player.throttle > 0.5);
  const h1 = await held(page);
  c.ok('Throttle: holds, shows pressed, and has pointer capture', h1.throttle && h1.throttleDown && await read(page, () => { const e = document.getElementById('t-throttle'); return [...window.__qa.pointerIds].some((i) => e.hasPointerCapture(i)); }), h1);
  await page.screenshot({ path: path.join(run.out, 'touch-pressed-phone.png') });
  await waitFor(page, () => window.__game.race.phase === 'racing' && window.__game.race.player.v > 3);
  await countActions(page);
  await f.tap('#t-lane');
  await frames(page, 2);
  const a1 = await actions(page);
  c.ok('Second finger: one Lane tap is one action, throttle stays held', a1.lane === 1 && a1.armed[0] === true && (await held(page)).throttle, a1);
  await f.tap('#t-lane');
  await f.tap('#t-pit');
  await frames(page, 2);
  const a2 = await actions(page), st2 = await state(page);
  c.ok('One Pit tap is one action and shows armed from the race', a2.lane === 2 && a2.pit === 1 && st2.pitReq && st2.pitCue === 'armed' && (await held(page)).throttle, { a2, cue: st2.pitText });
  await f.tap('#t-pit');
  const brk = await f.put('#t-brake');
  await frames(page, 2);
  const h2 = await held(page);
  await f.lift(brk);
  const h3 = await held(page);
  await f.lift(thr);
  const h4 = await held(page);
  c.ok('Throttle and Brake together, each finger with its own lifetime', h2.throttle && h2.brake && h3.throttle && !h3.brake && clear(h4), { h2, h3, h4 });
  const clicks = await read(page, () => window.__qa.padClicks);
  c.ok('No click event follows a touch on the pad', clicks === 0, clicks);

  // release paths
  const out1 = await f.put('#t-throttle');
  await f.slide(out1, viewport.width / 2, 40);
  const stillHeld = await held(page);
  await f.lift(out1);
  c.ok('Released outside the control, after sliding off it', stillHeld.throttle && clear(await held(page)), stillHeld);
  await f.put('#t-throttle');
  await f.put('#t-brake');
  await f.cancel();
  c.ok('touchcancel (pointercancel) releases every finger', clear(await held(page)));
  const lost = await f.put('#t-throttle');
  await f.slide(lost, viewport.width - 50, viewport.height - 50);   // capture is only established, and so only losable, at the pointer's next event
  await frames(page, 3);
  await read(page, () => { const e = document.getElementById('t-throttle'); for (const i of window.__qa.pointerIds) if (e.hasPointerCapture(i)) e.releasePointerCapture(i); });
  await f.slide(lost, viewport.width - 40, viewport.height - 40);   // the browser reports the loss with the pointer's next event
  await frames(page, 3);
  const h5 = await held(page);
  await f.lift(lost);
  c.ok('lostpointercapture releases, and the later touchend is harmless', clear(h5) && clear(await held(page)), h5);

  // lifecycle: a finger is left on the glass throughout
  const pause1 = await f.put('#t-throttle');
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  const h6 = await held(page);
  await page.screenshot({ path: path.join(run.out, 'touch-paused-phone.png') });
  c.ok('Pause tapped with throttle held: pauses, clears input and pad', clear(h6) && !(await padShown(page)).pad, h6);
  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__game.screen === 'race');
  const now = await game(page);
  await waitFor(page, (until) => { const r = window.__game.race; return r.player.throttle < 0.05 || r.raceTime >= until; }, now.raceTime + 0.5);
  const after = await game(page);
  await f.lift(pause1);
  c.ok('Resume with the old finger still down gives no throttle', after.throttle < 0.05 && clear(await held(page)), { throttle: after.throttle });
  const again = await f.put('#t-throttle');
  const h7 = await held(page);
  await f.lift(again);
  c.ok('A fresh press works after resume', h7.throttle && clear(await held(page)), h7);

  const blur1 = await f.put('#t-throttle');
  await read(page, () => window.dispatchEvent(new Event('blur')));
  const h8 = await held(page);
  await f.lift(blur1);
  await page.locator('#o-resume').tap();
  c.ok('Blur (synthetic) with a finger down pauses and clears', clear(h8) && await read(page, () => window.__game.screen === 'race'), h8);
  const hid1 = await f.put('#t-brake');
  await read(page, () => { Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const h9 = await held(page);
  await read(page, () => { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await f.lift(hid1);
  c.ok('Hidden tab (synthetic) with a finger down pauses and clears', clear(h9) && await read(page, () => window.__game.screen === 'pause'), h9);

  await page.locator('#o-restart').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  const r0 = await game(page);
  c.ok('Touch: Restart from pause gives a fresh countdown', r0.phase === 'countdown' && r0.raceTime === 0 && r0.lap === 0, r0);
  const rs1 = await f.put('#t-throttle');
  await page.keyboard.press('KeyR');
  const h10 = await held(page);
  await f.lift(rs1);
  c.ok('Restart while holding drops the hold', clear(h10) && (await padShown(page)).pad, h10);

  const off1 = await f.put('#t-throttle');
  const raceBefore = await game(page);
  await read(page, () => window.__game.setTouchMode('off'));
  const h11 = await held(page), shownOff = await padShown(page), raceAfter = await game(page);
  await f.lift(off1);
  await read(page, () => window.__game.setTouchMode('auto'));
  c.ok('Disabling touch mid-hold removes the pad, clears input, keeps the race', clear(h11) && !shownOff.pad && !shownOff.body && raceAfter.phase === raceBefore.phase && raceAfter.u === raceBefore.u, shownOff);

  // lane and pit against the race: same sequence by touch and by key from the same state
  const placed = () => read(page, () => {
    const g = window.__game, T = g.T;
    g.startSession('race');
    g.advance(7);
    const r = g.race, p = r.player;
    const sw = [...T.SWITCHES].sort((a, b) => T.ahead(a.s1, T.PIT_IN0) - T.ahead(b.s1, T.PIT_IN0))[0];
    const put = (car, u, side, v) => { car.u = u; car.laneSide = side; car.d = side * T.LANE_HALF; car.v = v; car.change = null; car.mode = 'race'; car.throttle = 0; car.graceT = 0; car.recoverT = 0; car.cutT = 0; car.pushedT = 0; };
    const u = p.crossed * T.L + T.wrapS(sw.s0 - 20);
    r.cars.forEach((o, i) => { if (i) put(o, u + T.L / 2 + i * 8, 1, 0); });
    put(p, u, 1, 10);
    r.squeezeQ.length = 0;
    p.fuel = 0.2;
  });
  await placed();
  await f.tap('#t-lane');
  await frames(page, 2);
  const armed = await state(page);
  await f.tap('#t-lane');
  await frames(page, 2);
  const disarmed = await state(page);
  c.ok('Lane shows ready from the race, and a second tap cancels it', armed.laneReq && armed.laneCue === 'armed' && !disarmed.laneReq && disarmed.laneCue === 'idle', { armed: armed.laneText, disarmed: disarmed.laneText });
  await page.screenshot({ path: path.join(run.out, 'touch-ready-phone.png') });
  const seq = ['#t-pit', '#t-lane', '#t-lane', '#t-pit'];
  const KEY = { '#t-pit': 'KeyP', '#t-lane': 'Space' };
  const replay = async (act) => { await placed(); const out = []; for (const b of seq) { await act(b); await frames(page, 1); const x = await state(page); out.push({ pit: x.pitReq, over: x.override, route: x.route, lane: x.laneCue, pitCue: x.pitCue }); } return out; };
  const byTouch = await replay((b) => f.tap(b));
  const byKey = await replay((b) => page.keyboard.press(KEY[b]));
  c.ok('Pit, override, restore, cancel: touch and keyboard give the same states', JSON.stringify(byTouch) === JSON.stringify(byKey) && byTouch[1].lane === 'override', byTouch.map((x) => `${x.pitCue}/${x.lane}`));

  await placed();
  await read(page, () => { const r = window.__game.race, p = r.player; p.fuel = 1; p.offences = 2; r.offence(p, r.cars[2], 'rear'); p.sgSkipNext = false; });
  await frames(page, 2);
  const sg1 = await state(page);
  await f.tap('#t-pit');
  await f.tap('#t-lane');
  await frames(page, 2);
  const sg2 = await state(page);
  await page.screenshot({ path: path.join(run.out, 'touch-override-phone.png') });
  await f.tap('#t-lane');
  await f.tap('#t-pit');
  await frames(page, 2);
  const sg3 = await state(page);
  c.ok('Stop-and-go by touch: shown as compulsory, Pit cannot cancel it, Lane overrides', sg1.pitCue === 'compulsory' && sg1.laneCue === 'routed' && sg2.pitReq && !sg2.only && sg2.override && sg2.laneCue === 'override' && sg3.pitCue === 'compulsory' && sg3.laneCue === 'routed', { sg1: sg1.pitText, sg2: sg2.laneText, sg3: sg3.pitText });

  // drive into the pits on the pad alone, from the inside lane
  await placed();
  s.keys = new PadKeys(f);
  await s.keys.tap('KeyP');
  const entry = await driveUntil(s, (st) => st.mode === 'pitlane', { budgetMs: 60000, opts: { laps: 3 } });
  await s.keys.release();
  c.ok('Driven on the pad alone: Pit routes outside and enters the pit lane', entry.mode === 'pitlane', { mode: entry.mode, side: entry.side });

  // audio: back from a suspended context on the next touch, with mute kept
  await read(page, () => window.__game.suspendAudio());
  await f.tap('#b-more');
  await page.locator('#b-snd').tap();
  const muted = await read(page, () => window.__game.muted);
  await read(page, () => window.__game.suspendAudio());
  await f.tap('#t-brake');
  await waitFor(page, () => window.__game.audio === 'running', undefined, 3000).catch(() => {});
  const audioBack = await read(page, () => ({ state: window.__game.audio, muted: window.__game.muted }));
  c.ok('Audio resumes from a pad touch and stays muted', muted && audioBack.state === 'running' && audioBack.muted, audioBack);
  await page.locator('#b-snd').tap();

  // out through the menus
  await f.tap('#t-view');
  await frames(page, 2);
  c.ok('Touch: View toggles the camera', await read(page, () => window.__game.view === 'full'));
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  await page.locator('#o-resume').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.ok('Touch: Pause and Resume', true);
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  await page.locator('#o-menu').tap();
  await waitFor(page, () => window.__game.screen === 'title');
  c.ok('Touch: back to the menu, pad gone, nothing held', !(await padShown(page)).pad && clear(await held(page)));
  await page.locator('#o-practice').tap();
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'practice');
  const prac = await f.put('#t-throttle');
  await read(page, () => { window.__game.race.phase = 'done'; });
  await waitFor(page, () => window.__game.screen === 'results');
  const h12 = await held(page);
  await f.lift(prac);
  await page.locator('#o-again').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.ok('Race end with a finger down clears it, and Again restarts by touch', clear(h12) && (await padShown(page)).pad, h12);

  // layouts: every primary control on screen, big enough, apart, and actually the thing under the thumb
  c.evidence.layouts = [];
  for (const [name, width, height] of [['phone landscape, small', 667, 375], ['phone landscape', 844, 390], ['tablet landscape', 1024, 768], ['tablet portrait', 768, 1024], ['phone portrait', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await frames(page, 2);
    const m = await read(page, () => {
      const ids = ['t-throttle', 't-brake', 't-lane', 't-pit', 't-pause', 't-view', 'b-more'].filter((id) => document.getElementById(id).getClientRects().length);
      const rects = ids.map((id) => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { id, x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button')?.id ?? null }; });
      let gap = 1e9;
      for (const a of rects) for (const b of rects) {
        if (a.id >= b.id) continue;
        gap = Math.min(gap, Math.max(Math.max(a.x, b.x) - Math.min(a.r, b.r), Math.max(a.y, b.y) - Math.min(a.b, b.b)));
      }
      const hud = ['.tl', '.tc', '.bl'].map((q) => document.querySelector(q).getBoundingClientRect());
      const covered = rects.filter((a) => hud.some((h) => h.width && a.x < h.right && h.left < a.r && a.y < h.bottom && h.top < a.b)).map((a) => a.id);
      return { rects, gap: Math.round(gap), covered };
    });
    const by = Object.fromEntries(m.rects.map((r) => [r.id, r]));
    const onScreen = m.rects.every((r) => r.x >= 0 && r.y >= 0 && r.r <= width && r.b <= height);
    const sized = m.rects.every((r) => r.w >= 48 && r.h >= 48);
    const holds = ['t-throttle', 't-brake'].every((id) => by[id].w >= 96 && by[id].h >= 96 && by[id].w > by['t-lane'].w && by[id].h > by['t-lane'].h);
    const reachable = m.rects.every((r) => r.top === r.id);
    c.ok(`Layout ${width}x${height} (${name}): on screen, 48 px or more, holds larger, apart, not covered`, onScreen && sized && holds && reachable && m.gap >= 8 && m.covered.length === 0, { gap: m.gap, covered: m.covered, tap: `${by['t-lane'].w}x${by['t-lane'].h}`, throttle: `${by['t-throttle'].w}x${by['t-throttle'].h}`, brake: `${by['t-brake'].w}x${by['t-brake'].h}` });
    c.evidence.layouts.push({ name, width, height, gap: m.gap, rects: m.rects });
    await page.screenshot({ path: path.join(run.out, `touch-${width}x${height}.png`) });
  }
  return s;
}

// ------------------------------------------------------------ responsive layouts
const LAYOUTS = [['phone portrait, small', 360, 640], ['phone portrait', 390, 844], ['phone landscape, small', 640, 360], ['phone landscape', 844, 390], ['tablet portrait', 768, 1024]];
const CONTROLS = ['t-throttle', 't-brake', 't-lane', 't-pit', 't-pause'];
const held2 = (page) => read(page, () => { const i = window.__game.input; return { throttle: i.held('throttle'), brake: i.held('brake') }; });

/** Worst case for the HUD: a stop-and-go owed on the pit route, low fuel, a time penalty and a long message at once. Layout only: the race is not played on from here. */
const crowdHud = (page) => read(page, () => { const g = window.__game, p = g.race.player; p.fuel = 0.05; p.sgOwed = 5; p.sgChances = 2; p.timePen = 10; p.pitReq = true; p.pitPenaltyOnly = true; p.laneOverride = true; p.finished = false; document.getElementById('h-toast').textContent = 'Second contact with Green Viper. One more and you serve a stop-and-go penalty'; document.getElementById('h-toast').className = 'toast show warn'; });

/** Geometry of the racing HUD: what is on screen, what touches what, and how much of the track is left. */
function measureHud(ids) {
  const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const hit = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
  const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const named = { pos: '#h-pos', lap: '#h-lap', time: '#h-time', fuel: '.bl .meter:nth-child(2)', chips: '#h-chips', mini: '#h-mini', status: '#h-status', toast: '#h-toast', top: '.tl', timer: '.tc' };
  const parts = Object.fromEntries(Object.entries(named).map(([k, q]) => { const e = document.querySelector(q); return [k, shown(e) ? rectOf(e) : null]; }));
  const controls = ids.map((id) => { const e = document.getElementById(id), r = rectOf(e); return { id, ...r, top: document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2)?.closest('button')?.id ?? null }; });
  const box = document.getElementById('app').getBoundingClientRect();
  const pairs = [];
  const solid = ['top', 'timer', 'fuel', 'chips', 'mini', 'status', 'toast'];
  for (const a of solid) for (const c of controls) if (parts[a] && hit(parts[a], c)) pairs.push(`${a}/${c.id}`);
  for (const [a, b] of [['top', 'timer'], ['top', 'mini'], ['timer', 'mini'], ['status', 'fuel'], ['status', 'chips'], ['toast', 'top'], ['toast', 'timer'], ['toast', 'status']]) if (parts[a] && parts[b] && hit(parts[a], parts[b])) pairs.push(`${a}/${b}`);
  let gap = 1e9;
  for (const a of controls) for (const b of controls) if (a.id < b.id) gap = Math.min(gap, Math.max(Math.max(a.x, b.x) - Math.min(a.r, b.r), Math.max(a.y, b.y) - Math.min(a.b, b.b)));
  // the share of a coarse grid of screen points that lands on the track view rather than on a panel or control
  let free = 0, n = 0;
  const panels = [...document.querySelectorAll('.tl, .tc, .bl, #h-mini, #h-status, .tbtn, .tr .btn')].filter((e) => shown(e)).map(rectOf);
  for (let x = 4; x < box.width; x += 8) for (let y = 4; y < box.height; y += 8) { n++; if (!panels.some((r) => x >= r.x && x <= r.r && y >= r.y && y <= r.b)) free++; }
  const mid = { x: box.width / 2, y: box.height / 2, r: box.width / 2 + 1, b: box.height / 2 + 1 };
  const mini = document.getElementById('h-mini');
  const canvas = document.querySelector('#app > canvas');
  return { parts, controls, pairs, gap: Math.round(gap), free: +(free / n).toFixed(2), carClear: !panels.some((r) => hit(r, mid)), mini: { cssW: mini.clientWidth, cssH: mini.clientHeight, w: mini.width, h: mini.height, projW: window.__game.mini.w, projH: window.__game.mini.h }, canvas: { w: canvas.clientWidth, h: canvas.clientHeight, bw: canvas.width, bh: canvas.height }, box: { w: box.width, h: box.height }, aspect: window.__game.aspect, pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}

/** Whether a menu fits: no sideways page, nothing clipped, and every control reachable by scrolling the card alone, then actually on top where a finger lands. */
function measureMenu() {
  const card = document.querySelector('.overlay.show .card'), r = card.getBoundingClientRect();
  const box = document.getElementById('app').getBoundingClientRect();
  const out = { pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardX: card.scrollWidth - card.clientWidth, inside: r.x >= 0 && r.y >= 0 && r.right <= box.width + 0.5 && r.bottom <= box.height + 0.5, blocked: [], small: [], tableScroll: [...card.querySelectorAll('.tscroll')].map((t) => t.scrollWidth - t.clientWidth) };
  card.scrollTop = 0;
  const row = card.querySelector(':scope > .row');
  out.actionsPinned = !!row && row.getBoundingClientRect().bottom <= r.bottom + 1;
  for (const e of card.querySelectorAll('button, input')) {
    e.scrollIntoView({ block: 'center', inline: 'center' });
    const b = e.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    if (top !== e && !e.contains(top)) out.blocked.push(e.id || e.dataset.id || e.dataset.car || e.textContent.trim().slice(0, 16));
    if (b.height < 44 || b.width < 44) out.small.push(`${e.id || e.textContent.trim().slice(0, 12)} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  card.scrollTop = 0;
  return out;
}

const menuOk = (m) => m.pageX <= 0 && m.cardX <= 0 && m.inside && m.blocked.length === 0 && m.small.length === 0;

/** The supported layouts, by touch alone on Chromium's emulation, and the desktop layout by mouse and keys. See docs/responsive.md. */
async function responsive(run, c) {
  const shot = (page, name) => page.screenshot({ path: path.join(run.out, `${name}.png`) });
  const size = (page, w, h) => page.setViewportSize({ width: w, height: h });
  const champ = JSON.stringify({ v: 1, car: CAR, initials: 'QA', rounds: [{ track: 'circuit-1', order: [0, 1, 2, 3].map((idx, i) => ({ idx, dnf: false, time: 300 + i })) }], startedAt: 1 });
  const board = JSON.stringify([{ id: 'a', initials: 'QA', car: 'frost', ms: 61234, at: 1 }, { id: 'b', initials: 'ZED', car: CAR, ms: 62345, at: 2 }]);

  // ---- desktop first: the regression baseline. Geometry measured on the previous commit at 1440x900
  const d = await open(run, { viewport: { width: 1440, height: 900 } });
  {
    const { page, keys } = d;
    await page.click('#o-start');
    await frames(page, 2);
    const g = await read(page, () => { const q = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width].map(Math.round); }, m = document.getElementById('h-mini'); return { tl: q('.tl').slice(0, 2), tc: q('.tc')[1], tr: [document.querySelector('.tr').getBoundingClientRect().right, q('.tr')[1]], bl: q('.bl'), mini: [m.clientWidth, m.clientHeight, m.width, m.height], br: [m.getBoundingClientRect().right, m.getBoundingClientRect().bottom], more: document.getElementById('b-more').getClientRects().length, touch: document.body.classList.contains('touch'), btn: document.getElementById('b-zin').getBoundingClientRect().height }; });
    c.ok('Desktop 1440x900: HUD positions, 230x200 minimap and 36 px buttons are unchanged, with no More tray', g.tl.join() === '12,12' && g.tc === 12 && g.tr.join() === '1428,12' && g.bl[0] === 12 && g.bl[2] === 280 && g.mini.join() === '230,200,230,200' && g.br.join() === '1428,888' && g.more === 0 && !g.touch && g.btn === 36, g);
    await shot(page, 'desktop-1440x900');
    await keys.set('KeyW', true);
    await frames(page, 2);
    await size(page, 1300, 800);
    await frames(page, 3);
    const w = await held2(page);
    await keys.set('KeyW', false);
    c.ok('Desktop: resizing keeps a held key', w.throttle, w);
    await size(page, 1440, 900);
    await keys.tap('KeyC');
    await frames(page, 1);
    const v1 = await read(page, () => window.__game.view);
    await page.click('#b-view');
    await frames(page, 1);
    const v2 = await read(page, () => window.__game.view);
    await page.click('#b-snd');
    await page.click('#b-snd');
    await keys.tap('Escape');
    await waitFor(page, () => window.__game.screen === 'pause');
    const card = await read(page, () => { const r = document.querySelector('.card').getBoundingClientRect(); return { sticky: getComputedStyle(document.querySelector('.card > .row')).position, legend: document.querySelector('.controls').getClientRects().length > 0, w: r.width }; });
    c.ok('Desktop: C and the View button work by key and mouse, and the pause card keeps its legend', v1 === 'full' && v2 === 'follow' && card.legend && card.sticky === 'static', { v1, v2, card });
    await d.context.close();
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));

  // ---- emulated touch device
  const s = await open(run, { viewport: { width: 360, height: 640 }, dpr: 2, device: PHONE, fixtures: { 'srgp.champ': champ, 'srgp.lb.practice.circuit-1': board, 'srgp.track': TRACK } });
  const { page } = s;
  const cdp = await s.context.newCDPSession(page);
  const f = new Fingers(page, cdp);
  c.evidence.touch = await read(page, () => ({ coarse: matchMedia('(any-pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints, dpr: devicePixelRatio }));

  // menus, each at every size
  const menus = async (name) => {
    for (const [label, w, h] of LAYOUTS) {
      await size(page, w, h);
      await frames(page, 2);
      const m = await read(page, measureMenu);
      c.ok(`Menu ${name} at ${w}x${h}: no sideways overflow, every control reachable and 44 px or more`, menuOk(m), { ...m, label });
      if (name === 'title' || name === 'results') await shot(page, `${name}-${w}x${h}`);
    }
  };
  await menus('title');
  await size(page, 360, 640);
  await page.locator('#o-boards').tap();
  await waitFor(page, () => window.__game.screen === 'boards');
  await menus('leaderboards');
  await size(page, 360, 640);
  await page.locator('#o-back').tap();
  await waitFor(page, () => window.__game.screen === 'title');

  // the racing HUD at every size, with everything shown at once
  await page.locator('#o-start').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.evidence.hud = [];
  for (const [label, w, h] of LAYOUTS) {
    await size(page, w, h);
    await frames(page, 3);
    const clean = await read(page, measureHud, CONTROLS);
    await crowdHud(page);
    await frames(page, 3);
    const m = await read(page, measureHud, CONTROLS);
    await shot(page, `race-${w}x${h}`);
    const seen = ['pos', 'lap', 'time', 'fuel', 'chips', 'mini', 'status', 'toast'].filter((k) => { const p = m.parts[k]; return !p || p.x < 0 || p.y < 0 || p.r > w + 0.5 || p.b > h + 0.5; });
    const sized = m.controls.every((r) => r.x >= 0 && r.y >= 0 && r.r <= w && r.b <= h && r.w >= 48 && r.h >= 48 && r.top === r.id);
    c.ok(`Race HUD at ${w}x${h} (${label}): status, fuel, messages and controls all on screen, nothing overlapping`, seen.length === 0 && sized && m.pairs.length === 0 && m.gap >= 8 && m.pageX <= 0, { missing: seen, overlaps: m.pairs, gap: m.gap });
    c.ok(`Race HUD at ${w}x${h}: track view keeps the middle of the screen and over half the area`, clean.carClear && clean.free >= 0.5, { freeClean: clean.free, freeCrowded: m.free, middleClearWhenCrowded: m.carClear });
    c.ok(`Minimap at ${w}x${h}: backing store, CSS size and projection agree`, Math.abs(m.mini.w - m.mini.projW * 2) <= 1 && Math.abs(m.mini.h - m.mini.projH * 2) <= 1 && Math.abs(m.mini.cssW - m.mini.projW) <= 1 && m.mini.cssW >= 96, m.mini);
    c.ok(`Canvas at ${w}x${h}: fills the box, aspect follows`, m.canvas.w === w && m.canvas.h === h && Math.abs(m.aspect - w / h) < 0.001 && Math.abs(m.canvas.bw / m.canvas.bh - w / h) < 0.02, m.canvas);

    if (await page.locator('#b-more').isVisible()) {
      await f.tap('#b-more');
      await frames(page, 1);
      const tray = await read(page, () => { const more = document.getElementById('b-more'); const b = ['t-view', 'b-zout', 'b-zin', 'b-snd'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button')?.id ?? null }; }); const pad = [...document.querySelectorAll('.tbtn')].map((e) => e.getBoundingClientRect()); return { b, expanded: more.getAttribute('aria-expanded'), label: more.getAttribute('aria-label'), clash: b.filter((x) => pad.some((p) => x.x < p.right && p.left < x.r && x.y < p.bottom && p.top < x.b)).map((x) => x.id) }; });
      c.ok(`More tray at ${w}x${h}: labelled, opens by touch, View, zoom and sound on screen, clear of the pad`, tray.expanded === 'true' && !!tray.label && tray.clash.length === 0 && tray.b.every((x) => x.x >= 0 && x.r <= w && x.b <= h && x.w >= 48 && x.h >= 48 && x.top === x.id), tray);
      if (w === 360) await shot(page, 'race-tray-360x640');
      await f.tap('#b-more');
    }
    await read(page, () => { const p = window.__game.race.player; p.fuel = 1; p.sgOwed = 0; p.timePen = 0; p.pitReq = false; p.pitPenaltyOnly = false; p.laneOverride = false; document.getElementById('h-toast').className = 'toast'; });
  }

  // tray actions with a finger already down
  await size(page, 640, 360);
  await frames(page, 2);
  const thr = await f.put('#t-throttle');
  await f.tap('#b-more');
  await frames(page, 1);
  const mutedBefore = await read(page, () => window.__game.muted);
  await f.tap('#b-snd');
  const mutedAfter = await read(page, () => window.__game.muted);
  await f.tap('#b-snd');
  const stillHeld = await held2(page);
  await f.tap('#b-more');
  await f.lift(thr);
  c.ok('Second finger: More and Sound work while Throttle stays held, one action per tap', mutedBefore !== mutedAfter && stillHeld.throttle, { mutedBefore, mutedAfter, stillHeld });

  // viewport lifecycle
  const mid = async (w, h) => { await size(page, w, h); await frames(page, 3); return game(page); };
  await read(page, () => { window.__game.startSession('race'); window.__game.advance(9); });
  await frames(page, 2);
  const r0 = await game(page);
  const hold = await f.put('#t-throttle');
  await waitFor(page, () => window.__game.input.held('throttle'));
  await size(page, 640, 304);   // 56 px of browser bar appears
  await frames(page, 3);
  const bar = await held2(page);
  await size(page, 640, 360);
  await frames(page, 3);
  const bar2 = await held2(page);
  c.ok('Browser bar sliding: throttle stays held', bar.throttle && bar2.throttle, { bar, bar2 });
  const r1 = await mid(360, 640);
  const rot = await held2(page);
  const m1 = await read(page, measureHud, CONTROLS);
  c.ok('Rotation mid-hold: the hold is released and the race carries on from where it was', !rot.throttle && !rot.brake && r1.screen === 'race' && r1.raceTime >= r0.raceTime && r1.lap === r0.lap && r1.u >= r0.u && r1.phase === 'racing', { before: { t: r0.raceTime, u: r0.u }, after: { t: r1.raceTime, u: r1.u }, rot });
  c.ok('Rotation: canvas, camera and controls follow', m1.canvas.w === 360 && m1.canvas.h === 640 && Math.abs(m1.aspect - 0.5625) < 0.001 && m1.controls.every((x) => x.r <= 360 && x.b <= 640 && x.top === x.id), m1.canvas);
  await f.slide(hold, 300, 500);
  await frames(page, 3);
  const revived = await held2(page);
  await f.lift(hold);
  const fresh = await f.put('#t-throttle');
  const pressed = await held2(page);
  await f.lift(fresh);
  c.ok('The old finger cannot revive the hold, a fresh press works', !revived.throttle && pressed.throttle && !(await held2(page)).throttle, { revived, pressed });
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  await shot(page, 'pause-360x640');
  const p0 = await game(page);
  await size(page, 640, 360);
  await frames(page, 3);
  await size(page, 360, 640);
  await frames(page, 3);
  const p1 = await game(page);
  c.ok('Rotation while paused: still paused, clock unchanged, nothing held', p1.screen === 'pause' && p1.raceTime === p0.raceTime && p1.t === p0.t && !(await held2(page)).throttle, { p0: p0.raceTime, p1: p1.raceTime });

  // overlays take the input
  const pad = await read(page, () => { const b = document.querySelector('.overlay.show'); return { top: document.elementFromPoint(300, 590)?.closest('.overlay') === b, hidden: document.getElementById('t-pad').hidden }; });
  const before = await game(page);
  await f.tap({ x: 300, y: 590 });
  await f.tap({ x: 60, y: 590 });
  await frames(page, 2);
  const after = await game(page);
  c.ok('Pause menu: taps where the pad was land on the overlay and drive nothing', pad.top && pad.hidden && after.screen === 'pause' && !(await held2(page)).throttle && after.t === before.t, pad);
  await menus('pause');
  await size(page, 360, 640);
  await page.locator('#o-resume').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  await frames(page, 2);
  c.ok('Resume tap does not leak into a driving action', !(await held2(page)).throttle && !(await held2(page)).brake && await read(page, () => !window.__game.race.player.pitReq && !window.__game.race.player.laneReq));

  // results and championship
  await read(page, () => { window.__game.race.phase = 'done'; });
  await waitFor(page, () => window.__game.screen === 'results');
  await menus('results');
  await size(page, 360, 640);
  await page.locator('#o-menu').tap();
  await waitFor(page, () => window.__game.screen === 'title');
  await page.locator('#o-champ-cont').tap();
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'champ');
  await read(page, () => { const g = window.__game; g.race.phase = 'done'; });
  await waitFor(page, () => window.__game.screen === 'champ');
  await menus('championship');
  await size(page, 360, 640);
  const rounds = await read(page, () => window.__game.champ.rounds.length);
  await page.locator('#o-next').tap();
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'champ');
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  await page.locator('#o-menu').tap();
  await waitFor(page, () => window.__game.screen === 'title');
  await page.reload();
  await page.waitForFunction(() => window.__game?.screen === 'title');
  c.ok('Championship by touch: round stored, continue, leave, and the save survives a reload', rounds === 2 && await read(page, () => window.__game.champ.rounds.length === 2 && !!document.getElementById('o-champ-cont')), rounds);

  // practice
  await page.locator('#o-practice').tap();
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'practice');
  await f.tap('#b-more');
  await frames(page, 2);
  const ghostOn = await read(page, () => window.__game.ghost.shown);
  await page.locator('#b-ghost').tap();
  const ghostOff = await read(page, () => ({ shown: window.__game.ghost.shown, pressed: document.getElementById('b-ghost').getAttribute('aria-pressed') }));
  await page.locator('#b-ghost').tap();
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  const trayShut = await read(page, () => document.getElementById('b-more').getAttribute('aria-expanded'));
  await page.locator('#o-restart').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.ok('Practice by touch: ghost toggles from the tray, pause closes the tray, Restart works', ghostOn && !ghostOff.shown && ghostOff.pressed === 'false' && trayShut === 'false' && await read(page, () => window.__game.race.phase === 'countdown'), ghostOff);
  await f.tap('#t-pause');
  await waitFor(page, () => window.__game.screen === 'pause');
  await page.locator('#o-menu').tap();
  await waitFor(page, () => window.__game.screen === 'title');

  // settings persist, and rotating does not touch an explicit choice
  await page.locator('[data-preset="balanced"]').tap();
  await page.locator('[data-touch="on"]').tap();
  await size(page, 640, 360);
  await frames(page, 2);
  await page.reload();
  await page.waitForFunction(() => window.__game?.screen === 'title');
  const kept = await read(page, () => ({ preset: window.__game.preset, touch: window.__game.touchMode, saved: localStorage.getItem('srgp.graphics') ?? null }));
  c.ok('Graphics and touch choices made by touch survive rotation and a reload', kept.preset === 'balanced' && kept.touch === 'on', kept);
  await page.locator('[data-preset="low"]').tap();
  await page.locator('[data-touch="auto"]').tap();

  // initials with an on-screen keyboard. The keyboard itself is simulated: only the visual viewport shrinks, as on iOS Safari
  await size(page, 390, 844);
  await frames(page, 2);
  const canvas0 = await read(page, () => document.querySelector('#app > canvas').clientHeight);
  await page.locator('#o-ini').tap();
  await page.keyboard.type('abc');
  await read(page, () => { Object.defineProperty(window.visualViewport, 'height', { get: () => 508, configurable: true }); window.visualViewport.dispatchEvent(new Event('resize')); });
  await frames(page, 2);
  const kb = await read(page, () => { const i = document.getElementById('o-ini').getBoundingClientRect(), g = document.querySelector('.card').getBoundingClientRect(), s2 = document.getElementById('o-start').getBoundingClientRect(); return { kb: document.querySelector('.overlay').style.getPropertyValue('--kb'), input: [i.top, i.bottom], card: g.bottom, start: s2.bottom, canvas: document.querySelector('#app > canvas').clientHeight, screen: window.__game.screen }; });
  await shot(page, 'keyboard-390x844');
  c.ok('Keyboard (simulated): the card clears it, the field stays in view, the canvas keeps its size', kb.kb === '336px' && kb.input[0] >= 0 && kb.input[1] <= 508 && kb.card <= 508 && kb.start <= 508 && kb.canvas === canvas0 && kb.screen === 'title', kb);
  await page.keyboard.press('Enter');
  await read(page, () => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
  const typed = await read(page, () => ({ kb: document.querySelector('.overlay').style.getPropertyValue('--kb'), value: document.getElementById('o-ini').value, stored: window.__game.R.savedInitialsRaw(), focused: document.activeElement?.id ?? '' }));
  c.ok('Enter closes the field, the space comes back and the initials are kept', typed.kb === '0px' && typed.focused !== 'o-ini' && typed.stored.toUpperCase() === 'ABC', typed);

  // safe areas, through the browser's own override where this Chromium has it
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 47, right: 47, bottom: 21 } });
    await size(page, 844, 390);
    await frames(page, 2);
    await page.locator('#o-start').tap();
    await waitFor(page, () => window.__game.screen === 'race');
    await frames(page, 3);
    const m = await read(page, measureHud, CONTROLS);
    await shot(page, 'race-safe-area-844x390');
    const by = Object.fromEntries(m.controls.map((x) => [x.id, x]));
    c.ok('Safe areas 47/47/21 at 844x390: controls and status clear the notch and home indicator', by['t-brake'].x >= 47 && by['t-brake'].b <= 369 && by['t-throttle'].r <= 797 && by['t-throttle'].b <= 369 && by['t-pause'].r <= 797 && m.parts.top.x >= 47 && m.pairs.length === 0, { brake: by['t-brake'].x, throttleRight: by['t-throttle'].r, top: m.parts.top.x });
    await f.tap('#t-pause');
    await waitFor(page, () => window.__game.screen === 'pause');
    const g = await read(page, () => { const r = document.querySelector('.card').getBoundingClientRect(); return { x: r.x, r: r.right, b: r.bottom }; });
    c.ok('Safe areas: the pause card stays inside them', g.x >= 47 && g.r <= 797 && g.b <= 369, g);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
  } catch (e) { c.unavailable('Safe-area override', String(e.message ?? e).split('\n')[0]); }

  // frame time and control response on this renderer, by preset. Diagnostic only
  await page.locator('#o-menu').tap().catch(() => {});
  await waitFor(page, () => window.__game.screen === 'title');
  c.evidence.response = [];
  for (const preset of ['low', 'balanced']) {
    await size(page, 844, 390);
    await page.locator(`[data-preset="${preset}"]`).tap();
    await page.locator('#o-start').tap();
    await waitFor(page, () => window.__game.screen === 'race');
    await read(page, () => { window.__game.advance(8); });
    await read(page, () => { const q = (window.__qa.resp = { frames: [], press: [], last: performance.now(), t0: 0 }); const loop = () => { const t = performance.now(); q.frames.push(t - q.last); q.last = t; if (q.t0) { q.press.push(t - q.t0); q.t0 = 0; } q.raf = requestAnimationFrame(loop); }; requestAnimationFrame(loop); document.getElementById('t-brake').addEventListener('pointerdown', () => { q.t0 = performance.now(); }); });
    for (let i = 0; i < 12; i++) { await f.tap('#t-brake'); await sleep(250); }
    const r = await read(page, () => { const q = window.__qa.resp; cancelAnimationFrame(q.raf); return { frames: q.frames.slice(2), press: q.press }; });
    const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    const row = { preset, viewport: '844x390', dpr: 2, buffer: await read(page, () => { const e = document.querySelector('#app > canvas'); return `${e.width}x${e.height}`; }), frames: r.frames.length, medianMs: +q(r.frames, 0.5).toFixed(1), p95Ms: +q(r.frames, 0.95).toFixed(1), pressToFrameMedianMs: +q(r.press, 0.5).toFixed(1), pressToFrameMaxMs: +Math.max(...r.press).toFixed(1), samples: r.press.length };
    c.evidence.response.push(row);
    console.log(`    info  ${JSON.stringify(row)}`);
    c.ok(`${preset}: emulated presses all reached a frame (SwiftShader, diagnostic)`, r.press.length >= 10, row);
    await f.tap('#t-pause');
    await waitFor(page, () => window.__game.screen === 'pause');
    await page.locator('#o-menu').tap();
    await waitFor(page, () => window.__game.screen === 'title');
  }
  return s;
}

/** A whole Clubman Park race on the pad alone, at a phone landscape size: fuel stop, finish, results and restart by touch. */
async function touchrace(run, c) {
  const viewport = { width: 844, height: 390 };
  const s = await open(run, { viewport, device: PHONE, fixtures: { 'srgp.track': TRACK } });
  const { page } = s;
  const cdp = await s.context.newCDPSession(page);
  const f = new Fingers(page, cdp);
  s.keys = new PadKeys(f);
  await page.locator(`.car[data-car="${CAR}"]`).tap();
  await page.locator('#o-start').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  c.evidence.environment = await environment(run, page, { workload: `${LAPS}-lap race, emulated touch` });
  await driveUntil(s, (st) => st.phase === 'racing', { budgetMs: 20000 });
  const seen = { pitlane: false, service: false, status: '' };
  const onTick = async (st) => {
    if (st.mode === 'pitlane' && !seen.pitlane) { seen.pitlane = true; }
    if (st.mode === 'service' && !seen.service) {
      seen.service = true;
      seen.status = await page.locator('#h-status').textContent();
      seen.overlaps = (await read(page, measureHud, CONTROLS)).pairs;
      await page.screenshot({ path: path.join(run.out, 'touchrace-service.png') });
    }
  };
  const end = await driveUntil(s, (st) => st.finished, { budgetMs: run.raceBudgetMs, opts: {}, onTick });
  await s.keys.release();
  c.ok('Touch race: the player reached the flag on the pad alone', end.lap === LAPS, end);
  c.ok('Touch race: no unplanned pause', !s.unexpectedPauses, s.unexpectedPauses ?? 0);
  await waitFor(page, () => window.__game.screen === 'results');
  await frames(page, 2);
  const m = await read(page, measureMenu);
  await page.screenshot({ path: path.join(run.out, 'touchrace-results.png') });
  const res = await read(page, () => { const r = window.__game.race, p = r.player; return { stops: p.pitStops, lap: p.lapsDone, rows: document.querySelectorAll('.card.results tbody tr').length, place: document.querySelector('.place').textContent, time: p.finishTime }; });
  const { log } = await capture(page);
  const modes = log.filter((e) => e.key === 'mode').map((e) => e.value);
  c.ok('Touch race: fuel stop entered, served and left, in order', ['pitlane', 'bayIn', 'service', 'bayOut', 'pitlane', 'race'].every((x, i, a) => modes.join().includes(a.slice(0, i + 1).join())) && res.stops >= 1, { stops: res.stops, modes: modes.slice(0, 10) });
  c.ok('Touch race: refuelling instructions shown and clear of the controls', seen.status.includes(text('hud.refuel')) && (seen.overlaps ?? []).length === 0, seen);
  c.ok('Touch race: results fit and work', res.rows === 4 && menuOk(m), { ...res, m });
  c.evidence.results = res;
  await page.locator('#o-again').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  const again = await game(page);
  c.ok('Touch race: Race Again gives a fresh countdown, zero clock and a full tank', again.phase === 'countdown' && again.raceTime === 0 && again.lap === 0 && again.fuel === 1, again);
  return s;
}

/** Hold-Brake reverse on real keys and emulated touch: penalty box and bay recovery, the HUD cue, blur/resume and pointer cancel. Scripted placement: functional coverage only. */
async function reverse(run, c) {
  /** a running race with the rivals half a lap away, the player stopped at `s` in the pit lane or on the outside road lane */
  const setup = (page, x) => read(page, (o) => {
    const g = window.__game, T = g.T;
    if (g.screen !== 'race') g.startSession('race');
    if (g.race.phase === 'countdown') g.advance(7);
    const r = g.race, p = r.player;
    r.cars.forEach((o2, i) => { if (i) { o2.u = p.u + T.L / 2 + i * 8; o2.laneSide = 1; o2.d = T.LANE_HALF; o2.mode = 'race'; o2.change = null; } });
    r.squeezeQ.length = 0;
    Object.assign(p, { u: o.s, v: 0, change: null, laneSide: -1, mode: o.pit ? 'pitlane' : 'race', d: o.pit ? T.pitD(o.s) : -T.LANE_HALF, throttle: 0, revMark: null, serviced: false, fuel: o.fuel ?? 1, sgOwed: o.sgOwed ?? 0, sgChances: o.sgOwed ? 2 : 0, sgServed: 0, sgServing: false });
    if (o.sgOwed) { p.pitReq = true; p.pitPenaltyOnly = true; }
  }, x);
  const P = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.player, T = g.T; return { s: T.wrapS(p.u), v: p.v, revOn: p.revOn, latch: p.revLatch, mode: p.mode, sgOwed: p.sgOwed, sgServing: p.sgServing, timePen: p.timePen, bay: p.bay, pitStops: p.pitStops, screen: g.screen, chips: document.getElementById('h-chips').textContent, brakeCue: document.getElementById('t-brake').dataset.cue, brakeText: document.getElementById('t-brake-cue').textContent }; });

  // ---- keyboard
  const s = await open(run);
  const { page, keys } = s;
  const T0 = await read(page, () => ({ PEN_S: window.__game.T.PEN_S, PEN_HALF: window.__game.T.PEN_HALF, BAY3: window.__game.T.BAYS[3], BAY_HALF: window.__game.T.BAY_HALF, PIT_IN1: window.__game.T.PIT_IN1 }));
  await setup(page, { s: T0.PEN_S + T0.PEN_HALF + 0.5, pit: true, sgOwed: 3 });
  // slow software frames can reach the box between two reads, so the chip is watched as it changes
  await read(page, (label) => { const el = document.getElementById('h-chips'); window.__qa.revChip = false; new MutationObserver(() => { if (el.textContent.includes(label)) window.__qa.revChip = true; }).observe(el, { childList: true, subtree: true, characterData: true }); }, STRINGS['hud.reverse']);
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.player.revOn || window.__game.race.player.sgServing, null, 10000);
  await frames(page, 2);
  const backing = { ...(await P(page)), chipSeen: await read(page, () => window.__qa.revChip) };
  c.ok('Keyboard: holding Brake at a standstill engages reverse and the HUD shows it', backing.chipSeen && backing.s < T0.PEN_S + T0.PEN_HALF + 0.4, backing);
  await page.screenshot({ path: path.join(run.out, 'reverse-hud.png') });
  await waitFor(page, () => window.__game.race.player.sgServing, null, 15000);
  const serving = await P(page);
  await waitFor(page, () => window.__game.race.player.sgOwed === 0, null, 20000);
  await sleep(1200);
  const after = await P(page);
  c.ok('Box: backing up with Brake held stops in the box and serves the full stop', Math.abs(serving.s - T0.PEN_S) < T0.PEN_HALF && after.sgOwed === 0 && after.timePen === 0, { serving, after });
  c.ok('Box: Brake still held after service does not reverse', after.v === 0 && !after.revOn && Math.abs(after.s - serving.s) < 0.2 && after.latch, after);
  await keys.set('ArrowDown', false);

  await setup(page, { s: T0.BAY3 + T0.BAY_HALF + 0.5, pit: true, fuel: 0.3 });
  await frames(page, 2);
  await keys.set('ArrowDown', true);
  // released on reaching the bay's far edge: a key lands a few slow software frames after the read that chose it
  await waitFor(page, (b) => { const g = window.__game, p = g.race.player; return g.T.gapS(b, g.T.wrapS(p.u)) < 0.9; }, T0.BAY3, 15000);
  await keys.set('ArrowDown', false);
  await waitFor(page, () => ['bayIn', 'service'].includes(window.__game.race.player.mode), null, 10000).catch(() => null);
  const bay = await P(page);
  c.ok('Bay: back past an overshot bay, release, and the bay is captured for refuelling', ['bayIn', 'service'].includes(bay.mode) && bay.bay === 3 && bay.pitStops === 1, bay);

  await setup(page, { s: 120 });
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.player.v < -1, null, 10000);
  await read(page, () => window.dispatchEvent(new Event('blur')));
  await frames(page, 2);
  const paused = await P(page);
  await keys.tap('Escape');
  await sleep(1200);
  const resumed = await P(page);
  c.ok('Blur pauses and clears reverse; resume with the key still down coasts to rest', paused.screen === 'pause' && !paused.revOn && resumed.screen === 'race' && resumed.v === 0 && !resumed.revOn, { paused, resumed });
  await keys.set('ArrowDown', false);

  // ---- emulated touch
  const t = await open(run, { viewport: { width: 844, height: 390 }, device: PHONE });
  await read(t.page, () => window.__game.setTouchMode('on'));
  const f = new Fingers(t.page, await t.context.newCDPSession(t.page));
  await setup(t.page, { s: 120 });
  await frames(t.page, 3);
  const id = await f.put('#t-brake');
  await waitFor(t.page, () => window.__game.race.player.v < -1, null, 10000);
  await frames(t.page, 2);
  const tb = await P(t.page);
  c.ok('Touch: holding the Brake button engages reverse, and the button shows R', tb.revOn && tb.brakeCue === 'reverse' && tb.brakeText === STRINGS['touch.brake.reverse'], tb);
  await t.page.screenshot({ path: path.join(run.out, 'reverse-touch.png') });
  await f.cancel();
  await sleep(1000);
  const tc = await P(t.page);
  c.ok('Touch: a cancelled pointer ends reverse and the car comes to rest', tc.v === 0 && !tc.revOn && tc.brakeCue === 'idle', tc);
  void id;
  c.ok('Touch: no page or console errors', t.errors.length === 0, t.errors.slice(0, 5));
  await t.context.close();
  return s;
}

/** Real-time frame capture with the renderer on. Reports presentation and clock separately. */
async function perf(run) {
  const s = await open(run);
  const { page, keys } = s;
  await pickRaceSetup(page);
  await page.click('#o-start');
  const workload = `Race mode from the grid, seed ${SEED}, ${run.seconds} s active with one 2 s pause, scripted driver on real keys`;
  await driveUntil(s, (st) => st.phase === 'racing', { budgetMs: 120000 });
  const environmentAtGo = await environment(run, page, { workload });
  const started = Date.now();
  let pausedOnce = false;
  await driveUntil(s, () => Date.now() - started > run.seconds * 1000 + (pausedOnce ? 2000 : 0), {
    budgetMs: run.seconds * 1000 + 30000,
    onTick: async () => {
      if (pausedOnce || Date.now() - started < (run.seconds * 1000) / 2) return;
      pausedOnce = true;
      await keys.release();
      await keys.tap('Escape');
      await sleep(2000);
      await keys.tap('Escape');
    },
  });
  await keys.release();
  const { rows } = await capture(page);
  const stats = summarise(rows);
  const drawn = await read(page, () => window.__game.info().calls);
  await s.context.close();
  return { label: run.label, environment: environmentAtGo, rendererEnabled: drawn > 0, drawCalls: drawn, stats, goal: GOAL, assessment: assessGoal(stats, environmentAtGo.acceleration), pageErrors: s.errors };
}

// ------------------------------------------------------------ cli
const SCENARIOS = { tracks, race, controlled, routing, practice, championship, touch, responsive, touchrace, reverse };
const USAGE = 'usage: browser-check.mjs [tracks|race|controlled|routing|practice|championship|touch|responsive|touchrace|reverse ...] | perf | compare <a.json> <b.json>\n'
  + 'options: --dist <dir> --url <url> --commit <sha> --machine <name> --label <name> --viewport WxH --dpr N --preset low|balanced|high\n'
  + '         --seconds N --headed --channel <chrome|msedge> --out <dir> --max-minutes N';

function compare(aPath, bPath) {
  const a = JSON.parse(readFileSync(aPath, 'utf8')), b = JSON.parse(readFileSync(bPath, 'utf8'));
  const gaps = comparisonGaps(a, b);
  const row = (r) => { const x = r.stats.active; return `| ${r.label} | ${(r.environment.commit ?? r.environment.revision ?? '').slice(0, 7)} | ${x.frameMs.median} | ${x.frameMs.p95} | ${x.frameMs.p99} | ${x.gapsOver50} | ${x.wallSec} | ${x.raceSec} | ${x.droppedSec ?? 'n/a'} | ${r.stats.countdownSec} | ${r.stats.pauses.count} / ${r.stats.pauses.wallSec} | ${r.stats.measurementSec} |`; };
  console.log('| Build | Commit | Median ms | p95 ms | p99 ms | Gaps > 50 ms | Active wall s | Race s | Dropped s | Countdown s | Pauses / s | Measured s |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  console.log(row(a)); console.log(row(b));
  console.log(gaps.length ? `\nNOT like for like: ${gaps.join(', ')} differ.` : `\nLike for like on ${a.environment.machine}, ${a.environment.renderer}, ${a.environment.viewport.width}x${a.environment.viewport.height}.`);
  for (const r of [a, b]) console.log(`Goal, ${r.label}: ${r.assessment.status}${r.assessment.reasons.length ? ` (${r.assessment.reasons.join('; ')})` : ''}`);
  process.exit(gaps.length ? 1 : 0);
}

async function revisionOf(url) {
  try {
    const r = await fetch(new URL('REVISION', url), { signal: AbortSignal.timeout(10000) });
    const v = (await r.text()).trim();
    return r.ok && /^[0-9a-f]{40}$/.test(v) ? v : null;
  } catch { return null; }
}

function headCommit() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain') ? ' (working tree has uncommitted changes)' : '');
}

async function main() {
  const { values: v, positionals: pos } = parseArgs({
    allowPositionals: true,
    options: {
      dist: { type: 'string' }, url: { type: 'string' }, commit: { type: 'string' }, machine: { type: 'string', default: 'unnamed' }, label: { type: 'string', default: 'build' },
      viewport: { type: 'string' }, dpr: { type: 'string', default: '1' }, preset: { type: 'string' }, seconds: { type: 'string', default: '120' },
      headed: { type: 'boolean', default: false }, channel: { type: 'string' }, out: { type: 'string' }, 'max-minutes': { type: 'string', default: '25' }, help: { type: 'boolean', default: false },
    },
  });
  if (v.help) { console.log(USAGE); return; }
  if (pos[0] === 'compare') { if (pos.length !== 3) throw new Error(USAGE); compare(pos[1], pos[2]); return; }
  const isPerf = pos[0] === 'perf';
  const names = isPerf ? [] : pos.length ? pos : Object.keys(SCENARIOS);
  for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}\n${USAGE}`);

  // the hard limit: whatever hangs, this run ends and says so
  const limit = setTimeout(() => { console.error(`Time limit of ${v['max-minutes']} minutes reached.`); process.exit(2); }, +v['max-minutes'] * 60000);
  limit.unref();

  const [w, h] = (v.viewport ?? (isPerf ? '1280x720' : '480x270')).split('x').map(Number);
  const preset = v.preset ?? (isPerf ? 'balanced' : 'low');
  let server = null, url = v.url;
  if (!url) {
    server = await preview({ root: ROOT, logLevel: 'silent', build: { outDir: path.resolve(v.dist ?? path.join(ROOT, 'dist')) }, preview: { port: 4173 } });
    url = server.resolvedUrls.local[0];
  }
  const revision = v.url ? await revisionOf(url) : null;
  const commit = v.commit ?? (v.url ? null : headCommit());
  const short = (revision ?? commit ?? 'unknown').slice(0, 8);
  const out = path.resolve(v.out ?? path.join(ROOT, '.qa/browser-check', `${new Date().toISOString().replace(/[:.]/g, '-')}-${short}`));
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: !v.headed, channel: v.channel });
  const run = { browser, url, out, commit, revision, machine: v.machine, label: v.label, headed: v.headed, viewport: { width: w, height: h }, dpr: +v.dpr, preset, seconds: +v.seconds, raceBudgetMs: 12 * 60000 };

  console.log(`Testing ${url}, ${commit ?? `public /REVISION ${revision ?? 'unavailable'}`}, ${browser.browserType().name()} ${browser.version()}`);
  let failed = false;
  try {
    if (isPerf) {
      console.log(`Perf capture of ${run.commit ?? run.revision ?? url}: ${run.seconds} s active at ${w}x${h}, ${preset}`);
      const r = await perf(run);
      const file = path.join(out, `perf-${run.label}.json`);
      writeFileSync(file, JSON.stringify(r, null, 2));
      const { acceleration, renderer } = r.environment;
      if (acceleration !== 'hardware') console.log(`\n*** ${acceleration} renderer (${renderer}): diagnostic only, not evidence of real-time smoothness ***`);
      console.log(JSON.stringify({ environment: r.environment, stats: r.stats, assessment: r.assessment, pageErrors: r.pageErrors }, null, 2));
      console.log(`Report: ${file}`);
      failed = r.pageErrors.length > 0 || !r.rendererEnabled;
    } else {
      const scenarios = [];
      for (const name of names) {
        console.log(`\n${name}`);
        const c = new Checks();
        const t0 = Date.now();
        let s = null, crash = null;
        try { s = await SCENARIOS[name](run, c); } catch (e) { crash = String(e.stack ?? e); c.ok('Scenario ran to the end', false, crash.split('\n')[0]); }
        const errors = s?.errors ?? [];
        if (s) {
          c.ok('No page or console errors', errors.length === 0, errors.slice(0, 5));
          c.evidence.environment ??= await environment(run, s.page);
          c.evidence.log = (await capture(s.page)).log.filter((e) => ['screen', 'phase', 'mode', 'toast', 'offences'].includes(e.key));
          await s.context.close();
        }
        const status = c.list.some((x) => x.status === 'failed') ? 'failed' : 'passed';
        failed ||= status === 'failed';
        scenarios.push({ name, status, durationSec: Math.round((Date.now() - t0) / 1000), checks: c.list, evidence: c.evidence, crash });
        writeFileSync(path.join(out, 'report.json'), JSON.stringify({ commit, revision, url, machine: run.machine, viewport: run.viewport, dpr: run.dpr, preset, scenarios }, null, 2));
      }
      console.log('\n| Scenario | Status | Passed | Failed | Unavailable | Seconds |\n| --- | --- | --- | --- | --- | --- |');
      for (const s of scenarios) console.log(`| ${s.name} | ${s.status} | ${s.checks.filter((x) => x.status === 'passed').length} | ${s.checks.filter((x) => x.status === 'failed').length} | ${s.checks.filter((x) => x.status === 'unavailable').length} | ${s.durationSec} |`);
      console.log(`\nReport and screenshots: ${out}`);
    }
  } finally {
    await browser.close();
    if (server) await new Promise((r) => server.httpServer.close(r));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
