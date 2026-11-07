#!/usr/bin/env node
// Bounded browser validation of the real game. Procedure and results: docs/validation.md.
//
//   node scripts/browser-check.mjs [tracks race controlled practice championship]   functional checks (default: all)
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
  const qa = (window.__qa = { rows: [], log: [], pixels: null, wantPixels: false });
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
      if (!p.change) cmd.lane = wantPit && outside ? p.laneReq : !p.laneReq && ((wantPit && !outside) || laneTest);
      cmd.pit = wantPit && outside && !p.pitReq;
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

async function open(run, { seed = SEED, fixtures = null, viewport = run.viewport, dpr = run.dpr, preset = run.preset } = {}) {
  // newContext is an empty, throwaway profile; nothing here touches a real browser profile
  const context = await run.browser.newContext({ viewport, deviceScaleFactor: dpr });
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
    if (st.screen === 'pause') { s.unexpectedPauses = (s.unexpectedPauses ?? 0) + 1; await keys.tap('Escape'); continue; }
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
    { label: 'view button to full', act: () => page.click('#b-view'), want: 'full' },
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
const SCENARIOS = { tracks, race, controlled, practice, championship };
const USAGE = 'usage: browser-check.mjs [tracks|race|controlled|practice|championship ...] | perf | compare <a.json> <b.json>\n'
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
