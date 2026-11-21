#!/usr/bin/env node
// Bounded browser validation of the real game. Procedure and results: docs/validation.md.
//
//   node scripts/browser-check.mjs [tracks race controlled routing practice championship touch responsive touchrace reverse service lastchance stall queue autosg autobay localslot online memory netbanner racelength carsetup debrief spectate qahook boot]   functional checks (default: all)
//   node scripts/browser-check.mjs perf --label updated --machine "<name>"          frame-time capture
//   node scripts/browser-check.mjs compare <baseline.json> <updated.json>           like-for-like comparison
//
// Every browser context is a throwaway profile, so nothing of the user's is read or written.
// window.__game (#146): the full debug hook these checks drive is exposed only by a dev server, a VITE_QA=1 build or a page
// opened with ?qa=1; every page opened here gets ?qa=1 appended (withQa), so dist/, dist-online/ and --url sites all work.
// A default (production) build without the flag has only a minimal read-only hook; scenario `qahook` checks that gate.
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
/** Standard's lap count (#132): the default race length every scenario races unless it picks another */
const LAPS = 13;
const TRACK = 'circuit-1';   // Clubman Park
const CAR = 'sunburst';
/** the protocol this checkout speaks (as scripts/build-server.mjs reads it) */
const PROTOCOL = Number(/PROTOCOL_VERSION = (\d+)/.exec(readFileSync(path.join(ROOT, 'src/net/protocol.ts'), 'utf8'))?.[1]);
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
  // the stopped-on-track rule off for the current race (#69): see scriptedTime
  qa.noStall = () => { window.__game.race.stallUpdate = () => {}; };
  window.addEventListener('pointerdown', (e) => qa.pointerIds.add(e.pointerId), true);
  window.addEventListener('click', (e) => { if (e.target.closest?.('.tbtn')) qa.padClicks++; }, true);
  const seen = {};
  const T0wrap = (g, u) => g.T.wrapS(u).toFixed(1);
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
    if (!g?.race) return;   // no hook yet, or the minimal one of a page opened without ?qa=1 (#146)
    const r = g.race, p = r.car(window.__game.localId);
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
    // stopped-on-track countdown (#69), in whole seconds left, and where the car stood when it began
    note(ts, r.raceTime, 'stall', p.stallT > 0 ? `${Math.ceil(3 - p.stallT)}s at s=${T0wrap(g, p.u)} v=${p.v.toFixed(2)}` : '');
    note(ts, r.raceTime, 'view', g.view);
    note(ts, r.raceTime, 'toast', document.getElementById('h-toast')?.textContent ?? '');
    if (qa.wantPixels) { qa.wantPixels = false; qa.pixels = samplePixels(); }
  });

  /** Read the player's situation and decide the keys: stay under the corner speed, hold back in traffic, pit for fuel or a penalty. */
  qa.drive = (o) => {
    const g = window.__game, r = g.race, T = g.T, p = r.car(window.__game.localId), s = T.wrapS(p.u);
    const st = { screen: g.screen, phase: r.phase, mode: p.mode, lap: p.lapsDone, crossed: p.crossed, v: p.v, fuel: p.fuel, side: p.laneSide, raceTime: r.raceTime, finished: p.finished, sgOwed: p.sgOwed, pitStops: p.pitStops, view: g.view, lapValid: p.lapValid, stallSvc: p.stallSvc };
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
      target *= o.pace ?? 1;   // online checks drive below the limit: SwiftShader frames and the network make every key late
      for (const c of r.cars) {
        if (c === p || c.mode === 'off' || c.mode === 'tow' || Math.abs(c.d - p.d) > T.CAR_W) continue;
        const gap = T.gapS(s, T.wrapS(c.u));
        if (gap > 0 && gap < 14) target = Math.min(target, c.v + 2.2 * (gap - T.CAR_LEN - 1.2));
      }
      cmd.up = p.v < target - 0.2;
      cmd.down = p.v > target + 0.5;
    } else if (p.mode === 'pitlane' && p.sgCtl) {
      // automatic pit service has the pedals (box, own bay, exit): no key changes anything, so none is pressed
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
    // a fresh press once ready; a stopped-on-track recovery adds no fuel (#69), so that bay is left as soon as it may be
    } else if (p.mode === 'service') cmd.up = (p.fuel >= fill || p.stallSvc) && p.penalty <= 0 && p.sgPhase !== 'refuel';
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

/**
 * Scripted fast-forward is set-up, not driving (#69). A scenario that skips the lights with `__game.advance` leaves the player
 * standing on the grid for seconds, then places it by script: without this, that time counted towards the stopped-on-track
 * rule and the car was recovered to its bay mid-scenario. So every `advance` ends with the stopped count cleared; whatever
 * happens in real frames afterwards counts as usual. `__qa.noStall()` switches the rule off for a scenario that holds the car
 * still on the road on purpose: the pit, service, reverse and touch scenarios place a stopped car and read the HUD, which at
 * SwiftShader frame rates takes longer than 3 s of race time. `race`, `touchrace`, `controlled` and `stall` keep the rule on.
 */
function scriptedTime() {
  const g = window.__game;
  const advance = g.advance;
  g.advance = (sec) => { advance(sec); for (const c of g.race.cars) { c.stallT = 0; c.stallRun = 0; } };
}

/**
 * Car setups (#133): the title's Car setup selector (mouse, keyboard, touch), its plain-words strength and cost, the setup
 * reaching the race and results, practice ghosts and leaderboards kept per setup (a legacy ghost is Balanced's), a
 * championship's setup changed between rounds, and the lobby: every driver's setup shown, the driver's own selector, a room
 * locked to Balanced by an older page, and a server older than setups.
 */
async function carsetup(run, c) {
  const titleState = (page) => read(page, () => ({
    opts: [...document.querySelectorAll('[data-rsetup]')].map((b) => ({ id: b.dataset.rsetup, on: b.getAttribute('aria-checked') === 'true', text: b.textContent.replace(/\s+/g, ' ').trim(), label: b.getAttribute('aria-label') })),
    group: document.querySelector('[data-rsetup]')?.closest('[role="radiogroup"]')?.getAttribute('aria-labelledby') ?? null,
    desc: document.getElementById('o-rsetup-desc')?.textContent ?? '', live: document.getElementById('o-rsetup-desc')?.getAttribute('aria-live') ?? null,
    chosen: window.__game.carSetup, car: window.__game.race.car(window.__game.localId).setup.id, ai: window.__game.race.cars.filter((x) => !x.human).map((x) => x.setup.id).join(),
    stored: localStorage.getItem('srgp.setup'),
  }));
  const selected = (t) => t.opts.filter((o) => o.on).map((o) => o.id).join();
  const name = (id) => STRINGS[`setup.${id}`];
  const stag = (id) => STRINGS['setup.tag'].replace('{name}', name(id));
  const toFlag = async (page, keys, lap) => {
    await read(page, (n) => {
      const gm = window.__game, T = gm.T, r = gm.race, p = r.car(gm.localId);
      gm.advance(7);
      r.cars.forEach((x, i) => { if (x !== p) x.u += 40 + i * 8; });
      p.u = T.FINISH_S + n * T.L - 3; p.hiU = p.u; p.crossed = n; p.lapsDone = n - 1; p.sectors = 7; p.v = 16; p.mode = 'race';
    }, lap);
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(5));
    await keys.release();
  };
  const selectorBox = (page, attr) => read(page, (a) => {
    const bs = [...document.querySelectorAll(`[data-${a}]`)].map((b) => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { id: b.dataset[a], x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b, clipped: b.scrollWidth > b.clientWidth + 1 }; });
    const hit = (p, q) => p.x < q.r - 0.5 && q.x < p.r - 0.5 && p.y < q.b - 0.5 && q.y < p.b - 0.5;
    const card = document.querySelector('.overlay.show .card').getBoundingClientRect();
    const desc = document.querySelector(`[data-for="${a}"] .setup-desc`)?.getBoundingClientRect();
    return { bs, overlap: bs.some((p, i) => bs.some((q, j) => i < j && hit(p, q))) || (!!desc && bs.some((p) => hit(p, { x: desc.x, y: desc.y, r: desc.right, b: desc.bottom }))), inside: bs.every((b) => b.x >= card.x - 0.5 && b.r <= card.right + 0.5 && b.x >= 0 && b.r <= innerWidth + 0.5), oneRow: new Set(bs.map((b) => Math.round(b.y))).size === 1 };
  }, attr);

  // ---- desktop: mouse and keyboard
  const d = await open(run, { viewport: { width: 1280, height: 800 } });
  {
    const { page, keys } = d;
    const t0 = await titleState(page);
    c.ok('Desktop title: a labelled Car setup group offers Balanced (chosen by default), Speed and Grip, each with its strength in a word', t0.group === 'o-rsetup' && t0.opts.map((o) => o.text).join('|') === ['balanced', 'speed', 'grip'].map((id) => `${name(id)} ${STRINGS[`setup.${id}.short`]}`).join('|') && selected(t0) === 'balanced' && t0.chosen === 'balanced' && t0.car === 'balanced' && t0.stored === null, t0);
    c.ok('Desktop: the chosen setup\'s strength and cost are written out under the selector (a live region); every choice\'s label carries its own', t0.desc === STRINGS['setup.balanced.desc'] && t0.live === 'polite' && t0.opts.every((o) => o.label === STRINGS[`setup.${o.id}.desc`] && o.label.startsWith(`${name(o.id)}:`)) && /Cost/.test(STRINGS['setup.speed.desc']) && /Cost/.test(STRINGS['setup.grip.desc']), { desc: t0.desc, labels: t0.opts.map((o) => o.label) });
    await page.click('[data-rsetup="speed"]');
    const t1 = await titleState(page);
    c.ok('Desktop: picking Speed shows its strength and cost, puts it on the grid behind the menu (rivals stay Balanced) and is remembered', selected(t1) === 'speed' && t1.desc === STRINGS['setup.speed.desc'] && t1.car === 'speed' && t1.ai === 'balanced,balanced,balanced' && t1.stored === '"speed"', t1);
    await page.focus('[data-rsetup="speed"]');
    await keys.tap('ArrowRight');
    const t2 = await titleState(page);
    const focus = await read(page, () => document.activeElement?.dataset.rsetup ?? null);
    c.ok('Desktop: the arrow keys move the choice (Speed -> Grip), focus following, description following', selected(t2) === 'grip' && focus === 'grip' && t2.desc === STRINGS['setup.grip.desc'] && t2.car === 'grip', { ...t2, focus });
    await d.load();
    const t3 = await titleState(page);
    c.ok('Desktop: after a reload the remembered choice (Grip) is selected again', selected(t3) === 'grip' && t3.car === 'grip', t3);
    const box = await selectorBox(page, 'rsetup');
    const menu = await read(page, measureMenu);
    c.ok('Desktop: the selector sits on one row inside the card, apart from its description, unclipped; no sideways overflow', box.oneRow && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped) && menu.pageX <= 0 && menu.cardX <= 0, { box, pageX: menu.pageX, cardX: menu.cardX });
    await page.screenshot({ path: path.join(run.out, 'carsetup-title-1280x800.png') });

    // a Grip race to its flag: the results name the setup, each row is labelled
    await page.click('[data-rlen="sprint"]');
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    const live = await read(page, () => window.__game.race.cars.map((x) => `${x.human ? 'me' : x.id}:${x.setup.id}`).join());
    c.ok('Desktop Grip race: the local car races Grip, the AI rivals carry their explicit Balanced setup', live === 'me:grip,ai1:balanced,ai2:balanced,ai3:balanced', live);
    await toFlag(page, keys, 5);
    await toResults(page, 'results');
    const res = await read(page, () => ({ head: document.querySelector('.res-setup')?.textContent ?? '', chips: [...document.querySelectorAll('.results tbody .setup-chip')].map((x) => x.dataset.setup) }));
    c.ok('Desktop results: the setup is named in the heading and every row carries its car\'s setup as text', res.head === stag('grip') && res.chips.length === 4 && res.chips.filter((x) => x === 'grip').length === 1 && res.chips.filter((x) => x === 'balanced').length === 3, res);
    await page.screenshot({ path: path.join(run.out, 'carsetup-results-1280x800.png') });
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');

    // practice ghosts: a ghost from before setups is a Balanced lap, challenged with Balanced only
    await read(page, () => {
      const T = window.__game.T, L = +T.L.toFixed(3);
      localStorage.setItem(`srgp.ghost.${T.DEF.id}.sunburst.Annon`, JSON.stringify({ v: 1, track: T.DEF.id, car: 'sunburst', initials: 'Annon', L, ms: 15000, s: [0, 0, 0, 0, 5, 80, 0, 0, 10, 160, 0, 0, 15, L, 0, 0] }));
      localStorage.setItem(`srgp.lb.practice.${T.DEF.id}`, JSON.stringify([{ id: 'legacy1', initials: 'OLD', car: 'sunburst', ms: 15000, at: 1 }]));
    });
    await d.load();
    await page.click('[data-rsetup="speed"]');
    await page.click('#o-practice');
    await waitFor(page, () => window.__game.screen === 'race');
    const gs = await read(page, () => ({ ghost: !!window.__game.ghost.data, pb: window.__game.pbMs, car: window.__game.race.car(window.__game.localId).setup.id }));
    c.ok('Desktop practice with Speed: the Balanced (legacy) ghost is not loaded and there is no personal best to beat', gs.car === 'speed' && !gs.ghost && gs.pb === 0, gs);
    await keys.tap('Escape');
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');
    await page.click('[data-rsetup="balanced"]');
    await page.click('#o-practice');
    await waitFor(page, () => window.__game.screen === 'race');
    const gb = await read(page, () => ({ ghost: window.__game.ghost.data?.ms ?? null, pb: window.__game.pbMs }));
    c.ok('Desktop practice with Balanced: the same legacy ghost is Balanced\'s, loaded with its personal best', gb.ghost === 15000 && gb.pb === 15000, gb);
    await keys.tap('Escape');
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');
    await page.click('#o-boards');
    await waitFor(page, () => window.__game.screen === 'boards');
    const b1 = await read(page, () => ({ rows: [...document.querySelectorAll('.boards tbody tr')].map((r) => r.textContent), head: document.querySelector('.lb-setup')?.textContent ?? '', sel: document.querySelector('[data-lbsetup][aria-checked="true"]')?.dataset.lbsetup }));
    await page.click('[data-lbsetup="speed"]');
    const b2 = await read(page, () => ({ rows: [...document.querySelectorAll('.boards tbody tr')].map((r) => r.textContent), head: document.querySelector('.lb-setup')?.textContent ?? '' }));
    c.ok('Desktop leaderboards: filtered and labelled by setup; the legacy lap is on Balanced\'s board, Speed\'s is empty', b1.sel === 'balanced' && b1.head.endsWith(stag('balanced')) && b1.rows.length === 1 && b1.rows[0].includes('OLD') && b2.head.endsWith(stag('speed')) && b2.rows.length === 1 && b2.rows[0].includes(STRINGS['boards.empty']), { b1, b2 });
    await page.click('#o-back');
    await waitFor(page, () => window.__game.screen === 'title');

    // a championship: started with Grip, changed to Speed between rounds, never during one
    await page.click('[data-rsetup="grip"]');
    await page.click('#o-champ');
    await waitFor(page, () => window.__game.screen === 'race');
    const c1 = await read(page, () => ({ car: window.__game.race.car(window.__game.localId).setup.id, save: JSON.parse(localStorage.getItem('srgp.champ')).setup }));
    c.ok('Desktop championship: the first round races the chosen setup (Grip), stored with the save', c1.car === 'grip' && c1.save === 'grip', c1);
    await toFlag(page, keys, 5);
    await toResults(page, 'champ');
    const sel = await read(page, () => [...document.querySelectorAll('[data-csetup]')].map((b) => `${b.dataset.csetup}:${b.getAttribute('aria-checked')}`).join());
    await page.click('[data-csetup="speed"]');
    const c2 = await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')));
    c.ok('Desktop: between rounds the standings card offers the setup (on Grip); choosing Speed is saved for the next round, round 1 keeps Grip', sel === 'balanced:false,speed:false,grip:true' && c2.setup === 'speed' && c2.rounds[0].setup === 'grip', { sel, setup: c2.setup, r1: c2.rounds[0].setup });
    await page.click('#o-next');
    await waitFor(page, () => window.__game.screen === 'race');
    const c3 = await read(page, () => window.__game.race.car(window.__game.localId).setup.id);
    await keys.tap('Escape');
    const pause = await read(page, () => document.querySelectorAll('[data-csetup], [data-rsetup]').length);
    c.ok('Desktop: round 2 races Speed; the race menu offers no setup change mid-round', c3 === 'speed' && pause === 0, { c3, pause });
    await d.context.close();
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));

  // ---- phone: emulated touch
  const s = await open(run, { viewport: { width: 360, height: 640 }, dpr: 2, device: PHONE, fixtures: { 'srgp.track': TRACK } });
  const { page } = s;
  const f = new Fingers(page, await s.context.newCDPSession(page));
  for (const [label, w, h] of LAYOUTS) {
    await page.setViewportSize({ width: w, height: h });
    await frames(page, 2);
    const box = await selectorBox(page, 'rsetup');
    const m = await read(page, measureMenu);
    c.ok(`Touch title at ${w}x${h} (${label}): the three setups on one row, 44 px or more, apart from each other and the text, unclipped, and the menu fits`, box.oneRow && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped && b.w >= 44 && b.h >= 44) && menuOk(m), { box: box.bs.map((b) => `${b.id} ${Math.round(b.w)}x${Math.round(b.h)}`), m });
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await frames(page, 2);
  await page.screenshot({ path: path.join(run.out, 'carsetup-title-360x640.png') });
  await f.tap('[data-rsetup="grip"]');
  const tt = await titleState(page);
  c.ok('Touch: a tap picks Grip, its strength and cost shown', selected(tt) === 'grip' && tt.car === 'grip' && tt.desc === STRINGS['setup.grip.desc'] && tt.stored === '"grip"', tt);
  // the lobby: everyone's setup, the driver's own selector
  const part = (id, num, nm, extra = {}) => ({ id, name: nm, slot: num - 1, num, bay: num - 1, livery: ['yellow', 'orange', 'blue'][num - 1], color: [0xffd23f, 0xfb923c, 0x2a6df0][num - 1], liveryRequested: null, ready: false, connected: true, host: num === 1, guest: true, joinOrder: num, left: false, ...extra });
  const room = { id: 'qa-room', code: 'S8AJ37', mode: 'multiplayer', state: 'lobby', rev: 1, hostId: 'p1', settings: { track: TRACK, aiFill: true, length: 'standard' }, championship: null,
    participants: [part('p1', 1, 'Host', { setup: 'speed', tuning: 1 }), part('p2', 2, 'Guest', { setup: 'grip', tuning: 1, ready: true }), part('p3', 3, 'Third', { setup: 'balanced', tuning: 0 })],
    ai: [{ id: 'ai_3', name: 'Green Viper (AI)', slot: 3, num: 24, bay: 3, livery: 'green', color: 0x22b04b, ai: true, setup: 'balanced', tuning: 0 }], raceId: null, maxHumans: 4, minHumans: 2, graceS: 20, setups: ['balanced', 'speed', 'grip'] };
  const lobbyState = () => read(page, () => ({
    rows: [...document.querySelectorAll('.lobby tbody tr')].map((r) => `${r.querySelector('.nm')?.textContent}:${r.querySelector('.setup-chip')?.textContent}`),
    radios: [...document.querySelectorAll('[data-nsetup]')].map((b) => `${b.dataset.nsetup}:${b.getAttribute('aria-checked')}${b.disabled ? ':off' : ''}`),
    note: document.querySelector('[data-for="nsetup"] .len-note')?.textContent ?? null,
  }));
  for (const [label, w, h] of LAYOUTS.slice(0, 4)) {
    await page.setViewportSize({ width: w, height: h });
    await read(page, (r) => window.__game.qaNetLobby(r, 'p2', 'connected', ['sprint', 'standard', 'endurance'], ['balanced', 'speed', 'grip']), room);
    await waitFor(page, () => window.__game.screen === 'lobby');
    await frames(page, 2);
    const st = await lobbyState();
    const box = await selectorBox(page, 'nsetup');
    const m = await read(page, measureMenu);
    const lobbyOk = m.pageX <= 0 && m.cardX <= 0 && m.inside && m.blocked.length === 0 && m.small.filter((x) => !x.startsWith('l-ai ')).every((x) => Number(/(\d+)x(\d+)$/.exec(x)?.[2]) >= 40 && Number(/(\d+)x(\d+)$/.exec(x)?.[1]) >= 40);
    c.ok(`Touch lobby at ${w}x${h} (${label}): every driver's and the AI's setup is shown in words; the guest's own selector is on Grip, 40 px+, apart; the lobby fits`,
      st.rows.join('|') === `Host:${name('speed')}|Guest:${name('grip')}|Third:${name('balanced')}|Green Viper (AI):${name('balanced')}` && st.radios.join() === 'balanced:false,speed:false,grip:true' && st.note === STRINGS['setup.lobbyNote'] && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped && b.w >= 44 && b.h >= 40) && lobbyOk, { st, box: box.bs.map((b) => `${b.id} ${Math.round(b.w)}x${Math.round(b.h)}`), m });
    if (w === 360) await page.screenshot({ path: path.join(run.out, 'carsetup-lobby-360x640.png') });
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await frames(page, 2);
  // a tap on Balanced: the choice goes to the server (here a pretend one with no socket) and is remembered for the next seat
  // (scrolled to the middle of the card: at its bottom edge the card's pinned action row lies over it, as over any control there)
  await read(page, () => document.querySelector('[data-nsetup="balanced"]').scrollIntoView({ block: 'center' }));
  await f.tap('[data-nsetup="balanced"]');
  const tap = await read(page, () => ({ pref: localStorage.getItem('srgp.setup'), on: document.querySelector('[data-nsetup][aria-checked="true"]')?.dataset.nsetup }));
  c.ok('Touch lobby: a tap on Balanced selects it and is remembered', tap.pref === '"balanced"' && tap.on === 'balanced', tap);
  // a room an older page keeps to Balanced: the other setups stay visible but disabled, and the note says why
  await read(page, (r) => window.__game.qaNetLobby({ ...r, setups: ['balanced'], participants: r.participants.map((p) => ({ ...p, setup: 'balanced', tuning: 0 })) }, 'p2', 'connected', ['sprint', 'standard', 'endurance'], ['balanced', 'speed', 'grip']), room);
  await frames(page, 2);
  const lock = await lobbyState();
  c.ok('Touch lobby locked by an older page: Speed and Grip disabled, Balanced on, and the reason in words', lock.radios.join() === 'balanced:true,speed:false:off,grip:false:off' && lock.note === STRINGS['setup.lockNote'], lock);
  // a server older than setups: no selector at all, and every car reads Balanced
  await read(page, (r) => { const old = { ...r, participants: r.participants.map(({ setup, tuning, ...p }) => p), ai: r.ai.map(({ setup, tuning, ...a }) => a) }; delete old.setups; window.__game.qaNetLobby(old, 'p2', 'connected', ['sprint', 'standard', 'endurance']); }, room);
  await frames(page, 2);
  const old = await lobbyState();
  c.ok('Touch lobby on a server older than setups: no setup selector, every car labelled Balanced', old.radios.length === 0 && old.rows.every((x) => x.endsWith(`:${name('balanced')}`)), old);
  c.ok('Touch part: no page or console errors', s.errors.length === 0, s.errors.slice(0, 5));
  return s;
}

/**
 * The page has booted: the title is up and the 3D view (#147: src/view3d.ts and Three.js, a chunk loaded after the title) is
 * built, so `startSession` and `advance` act at once. A build or hook without that state (older builds, the minimal hook)
 * counts as loaded. Runs in the page (waitForFunction).
 */
const booted = () => { const g = window.__game; return !!g && g.screen === 'title' && (g.view3d ?? 'ready') === 'ready'; };

/**
 * The page URL with the QA flag (#146): a default build (production included) exposes only a minimal read-only
 * `window.__game`; `?qa=1` turns on the full diagnostics hook these checks drive. Any existing query and hash are kept.
 */
function withQa(url) {
  const u = new URL(url);
  u.searchParams.set('qa', '1');
  return u.href;
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
  const load = async () => { await page.goto(withQa(run.url)); await page.waitForFunction(booted); await page.evaluate(scriptedTime); };
  await load();
  if (fixtures) {
    await page.evaluate((f) => { for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v); }, fixtures);
    await page.reload();
    await page.waitForFunction(booted);
    await page.evaluate(scriptedTime);
  }
  const choice = page.locator(`[data-preset="${preset}"]`);
  if (await choice.count()) await choice.click();
  return { context, page, errors, keys: new Keys(page), load };
}

const read = (page, fn, arg) => page.evaluate(fn, arg);
const game = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.car(window.__game.localId); return { screen: g.screen, mode: g.mode, view: g.view, track: g.T.DEF.id, phase: r.phase, raceTime: r.raceTime, t: r.t, lights: r.lights, pmode: p.mode, lap: p.lapsDone, u: p.u, v: p.v, throttle: p.throttle, fuel: p.fuel, dropped: g.stepper ? g.stepper.dropped : null }; });
const waitFor = (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
/** wait for n more frames to be drawn */
const frames = async (page, n = 3) => { const c = await read(page, () => window.__qa.rows.length); await waitFor(page, (m) => window.__qa.rows.length >= m, c + n); };
const pixels = async (page) => { await read(page, () => { window.__qa.pixels = null; window.__qa.wantPixels = true; }); await waitFor(page, () => window.__qa.pixels); return read(page, () => window.__qa.pixels); };
const toast = (page) => page.locator('#h-toast').textContent();

/**
 * #135: a local race whose player is done while other cars still run stays open for spectating; Skip to results ends it through
 * the same synchronous run-on as before (the same classification), so checks that want the results (or championship) screen
 * press it, through the spectator panel, whenever the race is being watched. A race with nobody left closes on its own.
 */
async function toResults(page, want = 'results', timeout = 30000) {
  await waitFor(page, (w) => window.__game.screen === w || (window.__game.spec.active && window.__game.screen === 'race'), want, timeout);
  if (await read(page, (w) => window.__game.screen !== w, want)) await page.locator('#s-skip').click();
  await waitFor(page, (w) => window.__game.screen === w, want, timeout);
}

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

  await toResults(page, 'results');
  const res = await read(page, () => {
    const r = window.__game.race, p = r.car(window.__game.localId), rows = [...document.querySelectorAll('.card.results tbody tr')];
    return { phase: r.phase, lapsDone: p.lapsDone, finished: p.finished, finishTime: p.finishTime, bestLap: p.bestLap, pitStops: p.pitStops, offences: p.offences, timePen: p.timePen, heading: document.querySelector('.card.results h2').textContent, place: document.querySelector('.card.results .place').textContent, rows: rows.map((x) => [...x.children].map((td) => td.textContent.trim()).join(' | ')), mine: document.querySelector('.card.results tr.me')?.textContent ?? '', board: window.__game.R.board('race', 'circuit-1').length, playerResult: r.results().find((x) => x.car.id === window.__game.localId).time, again: !!document.getElementById('o-again') };
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
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
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
    const inPit = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { pitReq: p.pitReq, override: p.laneOverride, moved: p.laneSide }; });
    c.ok(`${id}: routed outside from the inside lane and entered the pits with no lane key`, entry.mode === 'pitlane' && !inPit.pitReq && !inPit.override, { sw, ...inPit });
    if (!first) continue;
    await driveUntil(s, (st) => st.mode === 'service', held);
    const out = await driveUntil(s, (st) => st.mode === 'race', held);
    await frames(page, 3);
    const after = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { pitReq: p.pitReq, fuel: p.fuel, pitStops: p.pitStops }; });
    c.ok('Fuel: serviced, rejoined and the request is over', out.mode === 'race' && !after.pitReq && after.fuel > 0.3 && after.pitStops >= 1, after);
    c.ok('Fuel: no route chip after the stop', !(await chips()).includes('PIT ROUTE'), await chips());
    await keys.release();
  }

  // stop-and-go: same routing with no P key
  await keys.release();
  await approach(ids[0]);
  const due0 = await read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId); p.fuel = 1; p.offences = 2; r.offence(p, r.cars[2], 'rear'); return p.sgDue; });
  await frames(page, 3);
  c.ok('Stop-and-go: award alone shows the automatic route', (await chips()).includes(STRINGS['hud.routeOutsideMove']) && (await chips()).includes(STRINGS['hud.sgChip']), await chips());
  await keys.tap('Space');
  await frames(page, 3);
  const over = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { sgOwed: p.sgOwed, sgDue: p.sgDue, sgDeferred: p.sgDeferred, pitReq: p.pitReq, override: p.laneOverride }; });
  c.ok('Stop-and-go: override keeps the penalty and its deadline', over.override && over.pitReq && over.sgOwed === 3 && over.sgDue === due0 && !over.sgDeferred, over);
  await keys.tap('Space');
  await frames(page, 3);
  const served = await driveUntil(s, (st) => st.sgOwed === 0, held);
  const left = await driveUntil(s, (st) => st.mode === 'race', held);
  await keys.release();
  await frames(page, 3);
  const end = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { timePen: p.timePen, sgOwed: p.sgOwed, pitReq: p.pitReq, penaltyOnly: p.pitPenaltyOnly }; });
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
    const g = window.__game, T = g.T, r = g.race, p = r.car(window.__game.localId);
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
  await waitFor(page, () => window.__game.race.car(window.__game.localId).mode === 'race', undefined, 20000);
  const back = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { u: p.u, recoverT: p.recoverT, graceT: p.graceT, v: p.v }; });
  await frames(page, 2);
  c.ok('Recovery: marshal replaced the car behind the exit with grace', Math.abs(back.u - (off.u0 - 1.6)) < 0.5 && back.graceT > 0, back);
  c.ok('Recovery message shown', (await toast(page)).startsWith(text('msg.backOn')));

  // penalties: real contacts judged by the real collision code
  await setup();
  const hit = () => read(page, () => {
    const g = window.__game, T = g.T, r = g.race, p = r.car(window.__game.localId), a = r.cars[2];
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
  await read(page, () => { const g = window.__game, T = g.T, r = g.race, p = r.car(window.__game.localId); r.cars.forEach((x, i) => { if (i) window.__put(x, (p.crossed + 1) * T.L + 60 + i * 8, 1, 0); }); window.__put(p, p.crossed * T.L + T.L - 10, -1, 8); p.pitReq = true; });
  const served = await driveUntil(s, (st) => st.sgOwed === 0, { budgetMs: 40000 });
  await keys.release();
  await frames(page, 2);
  const servedState = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { timePen: p.timePen, sgOwed: p.sgOwed, mode: p.mode }; });
  c.ok('Stop-and-go served in the box with no time penalty', served.mode === 'pitlane' && servedState.timePen === 0, servedState);
  c.ok('Served message shown', (await toast(page)).startsWith(text('msg.penServed')));

  // an unserved stop disqualifies at the flag, on the real results screen
  await hit();
  const finish = await read(page, () => {
    const g = window.__game, T = g.T, r = g.race, p = r.car(window.__game.localId);
    const owed = p.sgOwed;
    window.__put(p, T.FINISH_S + 13 * T.L - 3, -1, 16);
    p.crossed = 13; p.lapsDone = 12; p.sectors = 7;
    return { owed, timeBefore: p.timePen };
  });
  await keys.set('KeyW', true);
  await read(page, () => window.__game.advance(5));
  await keys.release();
  await toResults(page, 'results');
  const res = await read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId); const mine = r.results().find((x) => x.car.id === window.__game.localId); return { timePen: p.timePen, status: mine.status, reason: p.dqReason, est: r.results().some((x) => x.est), row: document.querySelector('.card.results tr.me').textContent, place: document.querySelector('.card.results .place').textContent, title: document.querySelector('.card.results h2').textContent }; });
  c.ok('Unserved stop disqualifies at the flag: DQ row and reason on the results screen, no time penalty, no estimate', finish.owed === 3 && res.status === 'dq' && res.reason === 'stopGo' && res.timePen === 0 && !res.est && res.row.includes(STRINGS['res.dq']) && res.place.startsWith(STRINGS['res.youDq']) && !res.title.includes('🏆'), res);

  // lifecycle. Blur and hidden are synthetic events here: headless pages cannot really lose focus
  await setup();
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).throttle > 0.9);
  await read(page, () => window.dispatchEvent(new Event('blur')));
  const blurred = await game(page);
  await page.click('#o-resume');
  // settling takes about 0.12 s of race time however many frames that is. Bounded in race time, so a throttle that never falls reaches the check below instead of a timeout
  await waitFor(page, (until) => { const g = window.__game, r = g.race; return g.screen !== 'race' || r.car(window.__game.localId).throttle < 0.05 || r.raceTime >= until; }, blurred.raceTime + 0.5);
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
  await read(page, () => { const r = window.__game.race; r.deslot(r.car(window.__game.localId)); });
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
    const gm = window.__game, T = gm.T, r = gm.race, p = r.car(window.__game.localId);
    gm.advance(7);
    r.cars.forEach((x, i) => { if (i) x.u += 40 + i * 8; });
    p.u = T.FINISH_S + 13 * T.L - 3; p.crossed = 13; p.lapsDone = 12; p.sectors = 7; p.v = 16; p.mode = 'race';
  });
  await keys.set('KeyW', true);
  await read(page, () => window.__game.advance(5));
  await keys.release();
  await toResults(page, 'champ');
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
  async tap(code) { await this.fingers.tap({ Space: '#t-lane', KeyP: '#t-pit', KeyN: '#t-defer', Escape: '#t-pause' }[code]); }
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
  const countActions = (page) => read(page, () => { const r = window.__game.race, n = (window.__qa.actions = { lane: 0, pit: 0, armed: [] }); for (const [m, k] of [['requestLane', 'lane'], ['requestPit', 'pit']]) { const f = r[m].bind(r); r[m] = (...a) => { n[k]++; f(...a); if (k === 'lane') n.armed.push(r.car(window.__game.localId).laneReq); }; } });
  const actions = (page) => read(page, () => window.__qa.actions);
  const state = (page) => read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId), cue = (x) => document.getElementById(x); return { laneReq: p.laneReq, pitReq: p.pitReq, only: p.pitPenaltyOnly, override: p.laneOverride, route: r.nextRoute(p), laneCue: cue('t-lane').dataset.cue, pitCue: cue('t-pit').dataset.cue, laneText: cue('t-lane-cue').textContent, pitText: cue('t-pit-cue').textContent, chips: cue('h-chips').textContent }; });

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
    await page.waitForFunction(booted);
    c.ok('Off persists across a reload', await radio(page) === 'off' && await read(page, () => localStorage.getItem('srgp.touch')) === 'off');

    await page.click('#o-start');
    await keys.set('KeyW', true);
    await frames(page, 2);
    c.ok('Touch Off: the pad is hidden and W holds throttle', (await held(page)).throttle && !(await padShown(page)).pad);
    await keys.tap('Space');
    await keys.tap('KeyP');
    const kb = await read(page, () => { const p = window.__game.race.car(window.__game.localId); return { pitReq: p.pitReq, laneReq: p.laneReq }; });
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
  await waitFor(page, () => window.__game.race.car(window.__game.localId).throttle > 0.5);
  const h1 = await held(page);
  c.ok('Throttle: holds, shows pressed, and has pointer capture', h1.throttle && h1.throttleDown && await read(page, () => { const e = document.getElementById('t-throttle'); return [...window.__qa.pointerIds].some((i) => e.hasPointerCapture(i)); }), h1);
  await page.screenshot({ path: path.join(run.out, 'touch-pressed-phone.png') });
  await waitFor(page, () => window.__game.race.phase === 'racing' && window.__game.race.car(window.__game.localId).v > 3);
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
  await waitFor(page, (until) => { const r = window.__game.race; return r.car(window.__game.localId).throttle < 0.05 || r.raceTime >= until; }, now.raceTime + 0.5);
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
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
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
  await read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId); p.fuel = 1; p.offences = 2; r.offence(p, r.cars[2], 'rear'); });
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
  await toResults(page, 'results');
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

/**
 * Service obligations (docs/penalties.md): Defer by key and by touch, routing release and re-arm, the latched breach, DQ on the
 * real results screen and in a championship round, and the Defer button's place at phone sizes. Scripted placement, then real keys
 * and emulated touch: functional coverage only.
 */
async function service(run, c) {
  const st = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.car(window.__game.localId); return { fuelReq: p.fuelReq, fuelDue: p.fuelDue, sgOwed: p.sgOwed, sgDue: p.sgDue, sgDeferred: p.sgDeferred, hold: p.routeHold, appr: r.apprLap(p), pitReq: p.pitReq, route: !!r.nextRoute(p), mode: p.mode, breach: p.svcBreach, status: p.status, reason: p.dqReason, block: r.deferBlock(p), crossed: p.crossed, screen: g.screen, pitArrow: g.arrows.pit.visible, chips: document.getElementById('h-chips').textContent, status2: document.getElementById('h-status').textContent, toast: document.getElementById('h-toast').textContent, defer: !document.getElementById('t-defer').hidden, pitCue: document.getElementById('t-pit').dataset.cue, pitText: document.getElementById('t-pit-cue').textContent }; });
  /** racing on lap `lap`, the player stopped on the outside lane `into` m past the line, rivals parked half a lap on (or by the line, `field`) */
  const setup = (page, o) => read(page, (x) => {
    const g = window.__game, T = g.T;
    if (g.screen !== 'race') g.startSession(g.mode === 'champ' ? 'champ' : 'race');
    if (g.race.phase === 'countdown') g.advance(7);
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
    const put = (car, u, side, v) => Object.assign(car, { u, hiU: u, laneSide: side, d: side * T.LANE_HALF, v, change: null, mode: 'race', throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null });
    const into = x.into < 0 ? T.L + x.into : x.into; // negative: metres before the line that ends the lap
    const u = T.FINISH_S + (x.lap - 1) * T.L + into;
    r.cars.forEach((c2, i) => { if (!i) return; c2.crossed = x.lap; c2.lapsDone = x.lap - 1; put(c2, x.field ? u - 30 - i * 10 : u + T.L / 2 + i * 8, 1, x.field ? 14 : 0); });
    p.crossed = x.lap; p.lapsDone = x.lap - 1; p.sectors = into > T.L / 2 ? 7 : 0;
    put(p, u, -1, x.v ?? 0);
    r.squeezeQ.length = 0;
  }, o);
  const award = (page) => read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId); p.offences = 2; r.offence(p, r.cars[2], 'rear'); });

  // ---- keyboard
  const s = await open(run);
  const { page, keys } = s;
  await pickRaceSetup(page);
  await page.click('#o-start');
  await setup(page, { lap: 3, into: 60 });
  await keys.tap('KeyP');
  await frames(page, 3);
  let a = await st(page);
  c.ok('Optional request: chip says requested and optional, N offers deferral, nothing owed', a.fuelReq && a.fuelDue === 0 && a.chips.includes(STRINGS['hud.fuelReq']) && a.chips.includes(STRINGS['hud.deferKey']) && a.block === null, a);
  await keys.tap('KeyN');
  await frames(page, 3);
  a = await st(page);
  c.ok('N defers: fuel stop due next lap, route and pit arrow released for this approach, consequence shown', a.fuelDue === a.appr + 1 && a.hold === a.appr && !a.route && !a.pitArrow && a.chips.includes(STRINGS['hud.held']) && a.chips.includes(STRINGS['hud.dueChip.next']) && a.toast.startsWith(text('msg.deferred')), a);
  await page.screenshot({ path: path.join(run.out, 'service-deferred.png') });
  const due = a.fuelDue;
  await keys.tap('KeyN');
  await frames(page, 2);
  const again = await st(page);
  await keys.tap('KeyP');
  await frames(page, 2);
  const back = await st(page);
  await keys.tap('KeyP');
  await frames(page, 2);
  const noCancel = await st(page);
  c.ok('Second N refused, P brings the route back, a further P cannot cancel, and the deadline never moves', again.toast.startsWith(text('msg.deferHeld')) && back.route && back.toast.startsWith(text('msg.pitUndefer')) && noCancel.toast.startsWith(text('msg.pitDue')) && noCancel.pitReq && [again, back, noCancel].every((x) => x.fuelDue === due), { again: again.toast, back: back.toast, noCancel: noCancel.toast, due });
  await keys.tap('KeyN'); // release this approach again
  await frames(page, 2);
  // drive past the released entrance with real keys: no entry, then routing re-arms for the due lap
  await read(page, () => { const g = window.__game, T = g.T, p = g.race.car(window.__game.localId); Object.assign(p, { u: 2 * T.L + T.L + T.PIT_IN0 - 6, v: 8 }); p.hiU = p.u; });
  await keys.set('KeyW', true);
  await waitFor(page, () => { const g = window.__game, T = g.T, p = g.race.car(window.__game.localId); return p.u > 3 * T.L + T.PIT_IN0 + 2 || p.mode !== 'race'; }, undefined, 30000);
  await keys.set('KeyW', false);
  await frames(page, 3);
  a = await st(page);
  c.ok('Released approach passed without entering; routing re-armed for the due lap', a.mode === 'race' && a.hold === -1 && a.pitReq && a.route && a.fuelDue === due && a.block === 'used', a);
  // miss it on the due lap: the breach is latched at the line and shown at once
  await setup(page, { lap: due, into: -3, v: 12 });
  await keys.set('KeyW', true);
  await waitFor(page, (n) => window.__game.race.car(window.__game.localId).crossed > n, due, 30000);
  await keys.set('KeyW', false);
  await frames(page, 3);
  a = await st(page);
  c.ok('Missed due lap: breach latched and shown at once, the race carries on', a.breach === 'fuel' && a.status === 'running' && a.chips.includes(STRINGS['hud.breach']) && a.toast.startsWith(text('msg.breachFuel')), a);
  await page.screenshot({ path: path.join(run.out, 'service-breach.png') });
  // the flag: DQ, results reached, no estimate anywhere
  await setup(page, { lap: LAPS, into: -3, v: 12, field: true });
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).finished, undefined, 30000);
  await keys.set('KeyW', false);
  await toResults(page, 'results');
  const res = await read(page, () => { const r = window.__game.race; return { rows: r.results().map((x) => ({ s: x.status, est: x.est })), me: document.querySelector('.card.results tr.me').textContent, place: document.querySelector('.card.results .place').textContent, title: document.querySelector('.card.results h2').textContent, reason: r.car(window.__game.localId).dqReason }; });
  c.ok('Flag: DQ (missed deadline) on the real results screen, below the classified finishers, no trophy, no estimates', res.reason === 'deadline' && res.me.includes(STRINGS['res.dq']) && res.place.startsWith(STRINGS['res.youDq']) && !res.title.includes('🏆') && res.rows[res.rows.length - 1].s === 'dq' && res.rows.every((x) => !x.est && x.s !== 'running'), res);
  await page.screenshot({ path: path.join(run.out, 'service-dq-results.png') });
  await keys.tap('KeyR');
  await frames(page, 2);
  a = await st(page);
  c.ok('Race Again starts with no obligation, hold or breach', a.status === 'running' && !a.fuelReq && a.fuelDue === 0 && a.sgOwed === 0 && a.hold === -1 && a.breach === null, a);
  c.ok('Keyboard part: no page or console errors', s.errors.length === 0, s.errors.slice(0, 5));
  await s.context.close();

  // ---- championship: a DQ round is stored as a DQ and scores nothing
  const round = (track) => ({ track, order: [0, 1, 2, 3].map((idx, i) => ({ idx, dnf: false, time: 300 + i })) });
  const champ = JSON.stringify({ v: 1, car: CAR, initials: 'QA', rounds: [round('circuit-1'), round('circuit-2')], startedAt: 1 });
  const ch = await open(run, { fixtures: { 'srgp.champ': champ } });
  {
    const { page, keys } = ch;
    await page.click('#o-champ-cont');
    await frames(page, 2);
    await setup(page, { lap: LAPS, into: -3, v: 12, field: true });
    await read(page, () => { window.__game.race.car(window.__game.localId).svcBreach = 'stopGo'; });
    await keys.set('KeyW', true);
    await toResults(page, 'champ');
    await keys.release();
    await frames(page, 2);
    const saved = await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')));
    const last = saved.rounds[2];
    const row = await read(page, () => document.querySelector('.card.champ tr.me')?.textContent ?? '');
    const pts = await read(page, () => window.__game.R.standings(window.__game.R.loadChamp(), 4).find((x) => x.idx === 0).points);
    c.ok('Championship: the DQ round is stored once as a DQ with no points, earlier rounds unchanged', saved.rounds.length === 3 && last.order[last.order.length - 1].idx === 0 && last.order[last.order.length - 1].dq === true && row.includes(STRINGS['champ.dq']) && JSON.stringify(saved.rounds.slice(0, 2)) === JSON.stringify(JSON.parse(champ).rounds) && pts === 20, { last, row, pts });
    await page.screenshot({ path: path.join(run.out, 'service-champ-dq.png') });
  }
  c.ok('Championship part: no page or console errors', ch.errors.length === 0, ch.errors.slice(0, 5));
  await ch.context.close();

  // ---- emulated touch, phone sizes
  const t = await open(run, { viewport: { width: 360, height: 640 }, dpr: 2, device: PHONE });
  {
    const { page } = t;
    const cdp = await t.context.newCDPSession(page);
    const f = new Fingers(page, cdp);
    await page.locator('#o-start').tap();
    await waitFor(page, () => window.__game.screen === 'race');
    await setup(page, { lap: 3, into: 60 });
    await award(page);
    for (const [w, h] of [[360, 640], [640, 360]]) {
      await page.setViewportSize({ width: w, height: h });
      await frames(page, 3);
      a = await st(page);
      const m = await read(page, measureHud, [...CONTROLS, 't-defer']);
      const sized = m.controls.every((r) => r.x >= 0 && r.y >= 0 && r.r <= w && r.b <= h && r.w >= 48 && r.h >= 48 && r.top === r.id);
      c.ok(`Touch ${w}x${h}: Defer shown for a stop-and-go due this lap, on screen, 48 px or more, nothing overlapping`, a.defer && sized && m.pairs.length === 0 && m.gap >= 8, { overlaps: m.pairs, gap: m.gap, chips: a.chips, status: a.status2 });
      await page.screenshot({ path: path.join(run.out, `service-defer-${w}x${h}.png`) });
    }
    const due2 = (await st(page)).sgDue;
    await f.tap('#t-defer');
    await frames(page, 3);
    a = await st(page);
    c.ok('Touch Defer: stop-and-go moved one lap and its deferral used, Pit shows next lap, Defer hidden', a.sgDue === due2 + 1 && a.sgDeferred && !a.defer && a.pitCue === 'held' && a.pitText === STRINGS['touch.pit.held'] && !a.route, a);
    // final lap with the box occupied: queue, no deferral
    await setup(page, { lap: LAPS, into: 60 });
    await read(page, () => { const g = window.__game, T = g.T, r = g.race, o = r.cars[3]; Object.assign(o, { mode: 'pitlane', u: (13 - 1) * T.L + T.PEN_S + T.L, v: 0 }); o.d = T.pitD(o.u); o.hiU = o.u; o.sgOwed = 3; o.sgDue = 13; o.sgDeferred = true; });
    await read(page, () => { const p = window.__game.race.car(window.__game.localId); p.sgOwed = 0; p.sgDue = 0; p.sgDeferred = false; });
    await award(page);
    await frames(page, 3);
    a = await st(page);
    c.ok('Touch final lap, box occupied: Defer not offered, Pit compulsory, status says queue', !a.defer && a.block === 'final' && a.pitCue === 'compulsory' && a.status2.includes(STRINGS['hud.boxBusyFinal']), a);
    await page.screenshot({ path: path.join(run.out, 'service-final-640x360.png') });
  }
  c.ok('Touch part: no page or console errors', t.errors.length === 0, t.errors.slice(0, 5));
  return t;
}

/**
 * Last-chance warning (#65): a fuel stop committed by driving past the pit on the inside-lane override is announced at the
 * line that starts its due lap ("pit at this lap's entrance or be disqualified"), and the red PIT THIS LAP — or DQ chip stays
 * until the stop is served or the breach is latched. Space on that lap says what skipping means. Keyboard at desktop size,
 * then the emulated touch pad at phone portrait and landscape, with the chip clear of every control. Real frames and real
 * keys or touches from a scripted start just before the last switch ahead of the pit entrance.
 */
async function lastchance(run, c) {
  const st = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.car(g.localId); return { crossed: p.crossed, fuelDue: p.fuelDue, last: r.lastChance(p), breach: p.svcBreach, mode: p.mode, override: p.laneOverride, chips: document.getElementById('h-chips').textContent, first: document.querySelector('#h-chips .chip')?.textContent ?? '', toast: document.getElementById('h-toast').textContent }; });
  const toasts = (page) => read(page, () => window.__qa.log.filter((e) => e.key === 'toast' && e.value).map((e) => e.value));
  /** lap 3, 15 m before the last switch ahead of the pit entrance, rivals parked half a lap on */
  const setup = (page) => read(page, () => {
    const g = window.__game, T = g.T;
    if (g.race.phase === 'countdown') g.advance(7);
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(g.localId);
    const sw = [...T.SWITCHES].sort((a, b) => T.ahead(a.s0, T.PIT_IN0) - T.ahead(b.s0, T.PIT_IN0))[0];
    const put = (car, u, side, v) => Object.assign(car, { u, hiU: u, laneSide: side, d: side * T.LANE_HALF, v, change: null, mode: 'race', throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null });
    const u = 3 * T.L + T.PIT_IN0 - T.ahead(sw.s0, T.PIT_IN0) - 15;
    r.cars.forEach((o, i) => { if (i) { o.crossed = 3; o.lapsDone = 2; put(o, u + T.L / 2 + i * 8, 1, 0); } });
    p.crossed = 3; p.lapsDone = 2; p.sectors = 0; p.fuel = 0.6;
    put(p, u, -1, 8);
    r.squeezeQ.length = 0;
  });
  const views = [
    { label: 'desktop 1280x720, keyboard', viewport: { width: 1280, height: 720 }, touch: false, shot: 'lastchance-desktop-1280x720.png' },
    { label: 'phone portrait 390x844, touch', viewport: { width: 390, height: 844 }, touch: true, shot: 'lastchance-phone-390x844.png' },
    { label: 'phone landscape 844x390, touch', viewport: { width: 844, height: 390 }, touch: true, shot: 'lastchance-phone-844x390.png' },
  ];
  let last = null;
  for (const v of views) {
    const s = await open(run, { viewport: v.viewport, dpr: v.touch ? 2 : 1, device: v.touch ? PHONE : {} });
    const { page } = s;
    if (v.touch) { s.keys = new PadKeys(new Fingers(page, await s.context.newCDPSession(page))); await page.click('[data-touch="on"]'); }
    await pickRaceSetup(page);
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    await setup(page);
    await s.keys.tap('KeyP');
    await frames(page, 2);
    await s.keys.tap('Space');
    await frames(page, 2);
    // past the entrance on the override, then over the line into the due lap
    await driveUntil(s, (x) => x.crossed >= 4, { budgetMs: 90000 });
    await s.keys.release();
    await frames(page, 3);
    const a = await st(page);
    const seen = await toasts(page);
    const iOver = seen.findIndex((x) => x.startsWith(text('msg.fuelOverride'))), iLast = seen.findIndex((x) => x.startsWith(text('msg.pitThisLap')));
    c.ok(`${v.label}: override past the pit commits the stop, then the due lap opens with "pit this lap or be disqualified"`, a.fuelDue === 4 && a.crossed === 4 && iOver >= 0 && iLast > iOver && a.toast.startsWith(text('msg.pitThisLap')), { a, seen: seen.slice(-6) });
    c.ok(`${v.label}: red PIT THIS LAP — or DQ chip shown, first in the row`, a.last && a.first.includes(STRINGS['hud.lastChance']), a.chips);
    if (v.touch) {
      const m = await read(page, measureHud, CONTROLS);
      const chip = await read(page, () => { const r = document.querySelector('#h-chips .last-chance').getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      c.ok(`${v.label}: chip fully on screen and nothing in the HUD overlaps a control`, chip.x >= 0 && chip.y >= 0 && chip.r <= chip.vw && chip.b <= chip.vh && m.pairs.length === 0 && m.pageX <= 0, { chip, overlaps: m.pairs });
    }
    await page.screenshot({ path: path.join(run.out, v.shot) });
    if (!v.touch) {
      // Space on the due lap, 15 m before the last switch ahead of the entrance (the override only lasts one switch). Placed by
      // script, as at the start: SwiftShader frames make the scripted driver run wide now and then, and a car off the slot has
      // no lane to choose. The override says what skipping means; then past the entrance on the inside and over the line
      await read(page, () => { const g = window.__game, T = g.T, p = g.race.car(g.localId); const sw = [...T.SWITCHES].sort((a, b) => T.ahead(a.s0, T.PIT_IN0) - T.ahead(b.s0, T.PIT_IN0))[0]; const u = 4 * T.L + T.PIT_IN0 - T.ahead(sw.s0, T.PIT_IN0) - 15; Object.assign(p, { u, hiU: Math.max(p.hiU, u), laneSide: -1, d: -T.LANE_HALF, v: 8, change: null, mode: 'race', throttle: 0, recoverT: 0, revMark: null }); });
      await frames(page, 2);
      await s.keys.tap('Space');
      await frames(page, 3);
      const b = await st(page);
      c.ok(`${v.label}: Space on the due lap warns that skipping this stop is a DQ`, b.override && b.toast.startsWith(text('msg.routeInsideDq')), b);
      await page.screenshot({ path: path.join(run.out, 'lastchance-desktop-override.png') });
      await driveUntil(s, (x) => x.crossed >= 5, { budgetMs: 120000 });
      await s.keys.release();
      await frames(page, 3);
      const d = await st(page);
      c.ok(`${v.label}: missed: the breach is latched and its chip replaces the last-chance chip`, d.breach === 'fuel' && !d.last && d.chips.includes(STRINGS['hud.breach']) && !d.chips.includes(STRINGS['hud.lastChance']), d);
      await page.screenshot({ path: path.join(run.out, 'lastchance-desktop-breach.png') });
    }
    c.ok(`${v.label}: no page or console errors`, s.errors.length === 0, s.errors.slice(0, 5));
    if (last) await last.context.close();
    last = s;
  }
  return last;
}

/**
 * Stopped-on-track recovery (#69): a car stopped on the racing lane gets the countdown, a drive-off cancels it, a second stop
 * is moved to the car's own bay after 3 s, and it leaves only on a fresh Throttle press with the pit lane clear. Keyboard at
 * 1280x720, the touch pad at 844x390 and 390x844. Scripted placement (rivals parked half a lap away), then real frames. Under
 * SwiftShader a check and a screenshot take longer than the 3 s being tested, so the race is held still (its update skipped,
 * frames still drawn) while each one is taken; every count and recovery itself happens in ordinary frames.
 */
async function stall(run, c) {
  const st = (page) => read(page, () => {
    const g = window.__game, r = g.race, p = r.car(g.localId), T = g.T, q = window.__qa;
    const rect = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, vw: innerWidth, vh: innerHeight }; };
    const bay = T.point3(T.BAYS[p.bayHome], T.BAY_D);
    return { screen: g.screen, mode: p.mode, v: +p.v.toFixed(2), stallT: +p.stallT.toFixed(3), bay: p.bay, home: p.bayHome, phase: p.sgPhase, exitReq: p.exitReq, s: +T.wrapS(p.u).toFixed(2), lane: p.laneSide,
      atBay: +Math.hypot(p.x - bay.x, p.y - bay.y).toFixed(3), throttle: g.input.held('throttle'), brake: g.input.held('brake'), revOn: p.revOn,
      chips: document.getElementById('h-chips').textContent, first: document.querySelector('#h-chips .chip')?.textContent ?? '', status: document.getElementById('h-status').textContent,
      chip: rect('#h-chips .stall'), line: rect('#h-status'), toast: document.getElementById('h-toast').textContent,
      thrCue: document.getElementById('t-throttle').dataset.cue, thrText: document.getElementById('t-throttle-cue').textContent,
      recovers: q.recovers, counts: [...q.stallSeen].sort().join(','), towPen: q.towPen };
  });
  /** lap 3 on the long straight of Clubman Park, at rest in the inside lane; rivals parked on the far side of the circuit */
  const setup = (page) => read(page, () => {
    const g = window.__game, T = g.T, L = 3;
    if (g.race.phase === 'countdown') g.advance(7);
    const r = g.race, p = r.car(g.localId), q = window.__qa;
    window.__me = () => window.__game.race.car(window.__game.localId);
    r.squeezeQ.length = 0;
    const put = (car, s, side, v) => Object.assign(car, { u: (L - 1) * T.L + s, hiU: (L - 1) * T.L + s, laneSide: side, d: side * T.LANE_HALF, v, change: null, mode: 'race', throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null, crossed: L, lapsDone: L - 1, sectors: 0, stallT: 0, stallRun: 0 });
    r.cars.forEach((o, i) => { if (o !== p) put(o, 150 + T.L / 2 + i * 10, 1, 0); });
    if (!r.__ai) { r.__ai = true; r.ai = () => ({ t: 0, b: 1 }); }
    if (!r.__upd) { const u = r.update.bind(r); r.__upd = u; r.update = (dt, i) => { if (!window.__qa.freeze) u(dt, i); }; }
    q.freeze = false;
    put(p, 150, 1, 0); p.fuel = 0.7;
    Object.assign(q, { recovers: 0, stallSeen: new Set(), towPen: false });
    if (!r.__rec) { r.__rec = true; const f = r.stallRecover.bind(r); r.stallRecover = (car) => { const ok = f(car); if (ok && car.id === g.localId) window.__qa.recovers++; return ok; }; }
    const pm = r.pmsg.bind(r); r.pmsg = (car, text, ...rest) => { if (text === 'msg.towPenalty') window.__qa.towPen = true; pm(car, text, ...rest); };
    if (!q.stallObs) {
      const el = document.getElementById('h-chips');
      q.stallObs = new MutationObserver(() => { const e = el.querySelector('.stall'); if (e) window.__qa.stallSeen.add(e.dataset.n); });
      q.stallObs.observe(el, { childList: true, subtree: true, characterData: true });
    }
  });
  const until = (page, fn, ms = 30000) => waitFor(page, fn, null, ms);
  /** hold the race still (frames keep drawing), or let it run */
  const hold = (page, on) => read(page, (x) => { window.__qa.freeze = x; }, on);
  /** let the race run in ordinary frames until fn holds, then hold it there */
  const reach = async (page, fn, ms) => {
    await read(page, (src) => { const q = window.__qa; q.stopWhen = new Function(`return (${src})()`); clearInterval(q.stopT); q.stopT = setInterval(() => { if (q.stopWhen()) { q.freeze = true; clearInterval(q.stopT); } }, 0); q.freeze = false; }, fn.toString());
    await until(page, () => window.__qa.freeze, ms);
    await frames(page, 2);
  };
  const views = [
    { tag: 'desktop-1280x720', label: 'desktop 1280x720, keyboard', viewport: { width: 1280, height: 720 }, touch: false },
    { tag: 'phone-844x390', label: 'phone landscape 844x390, touch', viewport: { width: 844, height: 390 }, touch: true },
    { tag: 'phone-390x844', label: 'phone portrait 390x844, touch', viewport: { width: 390, height: 844 }, touch: true },
  ];
  let last = null;
  for (const v of views) {
    // one software-rendered page at a time: a previous view still racing behind would slow this one's load past its limit
    if (last) { await last.context.close(); last = null; }
    const s = await open(run, { viewport: v.viewport, dpr: v.touch ? 2 : 1, device: v.touch ? PHONE : {} });
    const { page } = s;
    if (v.touch) { s.keys = new PadKeys(new Fingers(page, await s.context.newCDPSession(page))); await page.click('[data-touch="on"]'); }
    const shot = (name) => page.screenshot({ path: path.join(run.out, `stall-${v.tag}-${name}.png`) });
    const layout = async (what, a) => {
      if (!v.touch) return;
      const m = await read(page, measureHud, CONTROLS);
      const on = (x) => x && x.x >= 0 && x.y >= 0 && x.r <= x.vw && x.b <= x.vh;
      c.ok(`${v.label}: ${what} fully on screen, and nothing in the HUD overlaps a driving control`, on(a.chip) && on(a.line) && m.pairs.length === 0 && m.pageX <= 0, { chip: a.chip, line: a.line, overlaps: m.pairs });
    };
    await pickRaceSetup(page);
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    await setup(page);
    // ---- countdown: stopped on the lane, nothing pressed
    await reach(page, () => window.__me().stallT > 0.3 && !!document.querySelector('#h-chips .stall'), 20000);
    const a = await st(page);
    c.ok(`${v.label}: stopped on the racing lane: "Move your car — pit recovery in n" with the countdown chip first in the row`, a.mode === 'race' && a.first.includes(text('hud.stallChip')) && a.status.includes(text('hud.stallWarn')) && a.recovers === 0, a);
    await layout('the countdown chip and status line', a);
    await shot('countdown');
    // ---- cancellation: Throttle drives off before 3 s
    await s.keys.set('KeyW', true);
    await reach(page, () => window.__me().stallT === 0 || window.__me().mode !== 'race', 15000);
    const b = await st(page);
    await s.keys.set('KeyW', false);
    c.ok(`${v.label}: Throttle before 3 s cancels it: the warning goes at once and the car stays on the track`, b.mode === 'race' && b.stallT === 0 && !b.chips.includes(text('hud.stallChip')) && !b.status.includes(text('hud.stallWarn')) && b.recovers === 0, b);
    await shot('cancelled');
    // ---- removal: stop again and hold Brake and Throttle together (Brake wins: no drive, no reverse), so Throttle is held through it
    await read(page, () => window.__qa.stallSeen.clear());
    await s.keys.set('KeyS', true);
    await s.keys.set('KeyW', true);
    await reach(page, () => window.__me().mode !== 'race', 30000);
    await frames(page, 2);
    const d = await st(page);
    c.ok(`${v.label}: the countdown ran 3, 2, 1, then the car left the lane for its own bay, once, with "Stopped on track — moved to pits"`, d.counts === '1,2,3' && d.mode === 'service' && d.bay === d.home && d.atBay < 0.5 && d.recovers === 1 && d.toast.startsWith(STRINGS['msg.stallRecovered']) && !d.revOn && !d.towPen, d);
    await shot('in-bay');
    // ---- safe departure: Throttle still held never leaves; release, then a fresh press; the pit lane blocked, then clear
    await s.keys.set('KeyS', false);
    await hold(page, false);
    await until(page, () => window.__me().sgPhase === 'release', 15000);
    await sleep(1500);
    const e = await st(page);
    c.ok(`${v.label}: Throttle held through the recovery never leaves the bay: it asks to release it first`, e.mode === 'service' && !e.exitReq && e.phase === 'release' && e.chips.includes(text('hud.sgA.release')) && (!v.touch || e.thrCue === 'release'), e);
    await s.keys.set('KeyW', false);
    await until(page, () => window.__me().sgPhase === 'ready', 15000);
    await frames(page, 2);
    const f = await st(page);
    c.ok(`${v.label}: released: Ready, Throttle to leave`, f.phase === 'ready' && f.chips.includes(text('hud.sgA.ready')) && (!v.touch || f.thrCue === 'ready'), f);
    await shot('ready');
    await read(page, () => { const g = window.__game, T = g.T, r = g.race, p = r.car(g.localId), x = r.cars.find((o) => o !== p); window.__qa.blocker = x.idx; Object.assign(x, { mode: 'pitlane', u: p.u - 1, d: T.PIT_D, v: 0, laneSide: -1, change: null }); });
    await s.keys.set('KeyW', true); await frames(page, 2); await s.keys.set('KeyW', false);
    await frames(page, 4);
    await hold(page, true);
    const g1 = await st(page);
    c.ok(`${v.label}: a fresh press asks to leave; with a car beside the bay it waits for a clear exit`, g1.mode === 'service' && g1.exitReq && g1.phase === 'exit' && g1.chips.includes(text('hud.sgA.exit')), g1);
    await shot('wait-exit');
    await read(page, () => { const g = window.__game, T = g.T, x = g.race.cars.find((o) => o.idx === window.__qa.blocker); Object.assign(x, { mode: 'race', u: x.u + 140, laneSide: 1, d: T.LANE_HALF, v: 0 }); });
    await reach(page, () => window.__me().mode === 'race', 60000);
    const h = await st(page);
    c.ok(`${v.label}: once clear it leaves without another press and is handed back past the pit exit, on the outside lane, with no second recovery`, h.mode === 'race' && h.lane === -1 && h.s > 31 && h.s < 60 && h.recovers === 1 && !h.towPen, h);
    await shot('rejoined');
    await s.keys.release();
    await hold(page, false);
    c.ok(`${v.label}: no page or console errors`, s.errors.length === 0, s.errors.slice(0, 5));
    last = s;
  }
  return last;
}

// ------------------------------------------------------------ responsive layouts
const LAYOUTS = [['phone portrait, small', 360, 640], ['phone portrait', 390, 844], ['phone landscape, small', 640, 360], ['phone landscape', 844, 390], ['tablet portrait', 768, 1024]];
const CONTROLS = ['t-throttle', 't-brake', 't-lane', 't-pit', 't-pause'];
const held2 = (page) => read(page, () => { const i = window.__game.input; return { throttle: i.held('throttle'), brake: i.held('brake') }; });

/** Worst case for the HUD: a stop-and-go owed on the pit route, low fuel, a time penalty and a long message at once. Layout only: the race is not played on from here. */
const crowdHud = (page) => read(page, () => { const g = window.__game, p = g.race.car(window.__game.localId); p.fuel = 0.05; p.sgOwed = 5; p.sgDue = g.race.apprLap(p); p.fuelDue = p.sgDue + 1; p.svcBreach = 'fuel'; p.timePen = 10; p.pitReq = true; p.pitPenaltyOnly = true; p.laneOverride = true; p.finished = false; document.getElementById('h-toast').textContent = 'Second contact with Green Viper. One more and you serve a stop-and-go penalty'; document.getElementById('h-toast').className = 'toast show warn'; });

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

/** Viewports for the race messages against the start lights, standings, times, minimap and HUD buttons (#128): phone landscape
 *  sizes, both sides of the 700 / 701 compact boundary, the 701-1320 desktop windows where a long message reaches the
 *  standings, 840 / 841 where the start lights clear it, wide desktop, and windows only 501 px tall, where the meters, race
 *  instructions and minimap come up from the bottom. Each runs with touch and with a mouse. The very short landscape windows of
 *  #130 item 3 (568x320, an iPhone SE on its side, and 600x340, 640x320 and 740x340), where the meters reached the lights. */
const MSG_VIEWS = [[915, 412], [844, 390], [740, 360], [667, 375], [640, 360], [650, 900], [700, 800], [701, 800], [768, 1024], [800, 600], [840, 600], [841, 600], [960, 540], [1024, 768], [1100, 800], [1101, 800], [1180, 820], [1181, 820], [1280, 800], [1320, 800], [1321, 800], [1440, 900], [701, 501], [800, 501], [840, 501], [1100, 501], [1320, 501], [568, 320], [600, 340], [640, 320], [740, 340]];

/** Geometry of the centred race messages, the start lights and what they could land on, with the lights' real countdown state. */
function measureMessages() {
  const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const hit = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
  const parts = {};
  for (const [k, q] of Object.entries({ toast: '#h-toast', lights: '#h-lights', top: '.tl', timer: '.tc', mini: '#h-mini', meters: '.bl' })) { const e = document.querySelector(q); if (shown(e)) parts[k] = rectOf(e); }
  const st = document.getElementById('h-status');
  if (shown(st) && st.textContent.trim()) parts.status = rectOf(st);
  for (const e of document.querySelectorAll('.tr .btn, .tbtn')) if (shown(e)) parts[e.id] = rectOf(e);
  const keys = Object.keys(parts), pairs = [];
  // the message and the lights against each other and everything else, top and bottom, but the lights not against the race
  // instructions: no race shows those during the countdown (crowdHud forces them); the standings against the times, minimap and buttons
  if (parts.toast && parts.lights && hit(parts.toast, parts.lights)) pairs.push('toast/lights');
  for (const a of ['toast', 'lights']) for (const b of keys) if (!['toast', 'lights'].includes(b) && !(a === 'lights' && b === 'status') && parts[a] && hit(parts[a], parts[b])) pairs.push(`${a}/${b}`);
  for (const b of keys) if (!['top', 'toast', 'lights', 'meters', 'status'].includes(b) && parts.top && hit(parts.top, parts[b])) pairs.push(`top/${b}`);
  // the times against the minimap and every HUD button (#130)
  for (const b of keys) if (!['top', 'timer', 'toast', 'lights', 'meters', 'status'].includes(b) && parts.timer && hit(parts.timer, parts[b])) pairs.push(`timer/${b}`);
  const L = document.getElementById('h-lights'), T = document.getElementById('h-toast');
  const off = ['toast', 'lights'].filter((k) => !parts[k] || parts[k].x < 0 || parts[k].y < 0 || parts[k].r > innerWidth + 0.5 || parts[k].b > innerHeight + 0.5);
  return { pairs, off, toast: parts.toast, lights: parts.lights, top: parts.top, round: document.getElementById('h-round').textContent, lightsOn: getComputedStyle(L).opacity === '1' && L.querySelectorAll('i.on').length > 0, toastOn: T.classList.contains('show') && T.textContent.length > 60, toastPx: parseFloat(getComputedStyle(T).fontSize), phase: window.__game.race.phase, touch: document.body.classList.contains('touch') };
}

/** Viewports for the racing HUD with a status line showing (#130): the 601-1180 mouse windows where a centred status line met the
 *  meters and the minimap, both sides of 700 / 701, 840 / 841, 900 / 901 (where the times gain Last and Best), 1100 / 1101 and
 *  1180 / 1181, windows only 501 px tall, tablet portrait, and wide desktop. Touch runs the same sizes: 701-1100 is where the
 *  times sit in a row beside the standings, with the buttons at its right end. Then the very short landscape windows of #130
 *  item 3 (at most 340 px tall), where the chip list is capped, and 701x560 / 701x561 either side of the touch tablet cap. */
const SHORT_VIEWS = [[568, 320], [600, 340], [640, 320], [740, 340], [844, 340]];
const STATUS_VIEWS = [...SHORT_VIEWS, [701, 560], [701, 561], [601, 900], [650, 900], [700, 800], [701, 501], [701, 800], [750, 600], [768, 1024], [800, 501], [840, 600], [841, 600], [900, 600], [901, 600], [960, 540], [1000, 700], [1024, 768], [1100, 501], [1100, 800], [1101, 800], [1180, 820], [1181, 820], [1320, 501], [1440, 900]];

/** The longest name another player can have (LIMITS.nameMax, 16), as it would look in the standings */
const LONG_NAME = 'Maximilian Weber';

/** Geometry of the status line, meters, minimap, standings, times, message and HUD buttons while racing (#130). `short`: a very
 *  short window (at most 340 px tall), where the message is also checked against the meters, minimap, top bar and buttons. */
function measureStatus({ touch, short }) {
  const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const hit = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
  const parts = {};
  for (const [k, q] of Object.entries({ top: '.tl', timer: '.tc', mini: '#h-mini', meters: '.bl', toast: '#h-toast' })) { const e = document.querySelector(q); if (shown(e)) parts[k] = rectOf(e); }
  const st = document.getElementById('h-status');
  const statusOn = shown(st) && !!st.textContent.trim() && getComputedStyle(st).opacity === '1';
  if (statusOn) parts.status = rectOf(st);
  const buttons = [];
  for (const e of document.querySelectorAll('.tr .btn, .tbtn')) if (shown(e)) { parts[e.id] = rectOf(e); buttons.push(e.id); }
  const keys = Object.keys(parts), pairs = [];
  // the status line against everything, the message included; the times against the minimap and buttons, and with touch the
  // standings (the shared row). In a very short window, the message against the meters, minimap, top bar, times and buttons too
  for (const b of keys) if (b !== 'status' && parts.status && hit(parts.status, parts[b])) pairs.push(`status/${b}`);
  if (short) for (const b of keys) if (!['toast', 'status'].includes(b) && parts.toast && hit(parts.toast, parts[b])) pairs.push(`toast/${b}`);
  for (const b of [...buttons, 'mini', ...(touch ? ['top'] : [])]) if (parts.timer && parts[b] && hit(parts.timer, parts[b])) pairs.push(`timer/${b}`);
  for (const b of [...buttons, 'mini']) if (parts.top && parts[b] && hit(parts.top, parts[b])) pairs.push(`top/${b}`);
  const off = ['status', 'timer', 'top', ...buttons].filter((k) => !parts[k] || parts[k].x < 0 || parts[k].y < 0 || parts[k].r > innerWidth + 0.5 || parts[k].b > innerHeight + 0.5);
  // every row still shows its flags (where the standings show: compact layouts drop them), and the times their numbers
  const standOn = shown(document.getElementById('h-stand'));
  const flags = [...document.querySelectorAll('#h-stand > div')].map((d) => { const r = d.getBoundingClientRect(); return [...d.querySelectorAll('.flag')].every((f) => { const q = f.getBoundingClientRect(); return q.width > 0 && q.right <= r.right + 0.5; }); });
  const times = [...document.querySelectorAll('.tc .mono')].filter(shown).every((e) => e.scrollWidth <= e.clientWidth + 0.5 && e.getBoundingClientRect().width > 20);
  // the chips that show, their smallest text, and the "+N MORE" count; the touch controls' smallest side
  const chipEls = [...document.querySelectorAll('#h-chips .chip')].filter(shown);
  const chips = { shown: chipEls.length, hidden: document.querySelectorAll('#h-chips .chip[hidden]').length, px: Math.min(...chipEls.map((e) => parseFloat(getComputedStyle(e).fontSize))), extra: document.querySelector('#h-chips .chip.extra')?.textContent ?? null };
  const pad = Math.min(...[...document.querySelectorAll('.tbtn, .tr .btn')].filter(shown).map((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); }));
  return { pairs, off, chips, pad, status: parts.status, statusOn, statusLen: st.textContent.length, statusPx: parseFloat(getComputedStyle(st).fontSize), timer: parts.timer, top: parts.top, flags: !standOn || (flags.length === 4 && flags.every(Boolean)), standOn, times, phase: window.__game.race.phase, touch: document.body.classList.contains('touch') };
}

/** Race messages and start lights with the HUD crowded, touch and mouse, at every MSG_VIEWS size (#128). A championship round
 *  with penalty flags on every row, so the standings column is at its tallest (round label) and widest. */
async function hudMessages(run, c, champ) {
  for (const touch of [true, false]) {
    const s = await open(run, { viewport: { width: 1024, height: 768 }, device: touch ? PHONE : {}, fixtures: { 'srgp.champ': champ } });
    const { page } = s;
    if (touch) await page.locator('#o-champ-cont').tap(); else await page.click('#o-champ-cont');
    await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'champ');
    // hold the start: the lights come on through the HUD's own countdown and stay on while every size is measured
    await read(page, () => { window.__game.race.goT = 1e9; });
    await waitFor(page, () => window.__game.race.lights >= 3);
    const mode = touch ? 'touch' : 'mouse';
    c.evidence[`messages-${mode}`] = [];
    for (const [w, h] of MSG_VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      await frames(page, 3);
      await crowdHud(page);
      // the widest standings: every row carries both warning flags, a stop-and-go and a time penalty
      await read(page, () => { for (const x of window.__game.race.cars) Object.assign(x, { offences: 2, sgOwed: 5, timePen: 10 }); });
      await frames(page, 3);
      const m = await read(page, measureMessages);
      c.evidence[`messages-${mode}`].push({ size: `${w}x${h}`, pairs: m.pairs, toast: m.toast, lights: m.lights, top: m.top });
      c.ok(`Race messages at ${w}x${h} (${mode}): the lit start lights and a long message are on screen and clear of each other, the standings, times, meters, race instructions, minimap and buttons`, m.touch === touch && !!m.round && m.phase === 'countdown' && m.lightsOn && m.toastOn && m.toastPx >= 13 && m.off.length === 0 && m.pairs.length === 0, { overlaps: m.pairs, off: m.off, round: m.round, toast: m.toast, lights: m.lights, top: m.top, lightsOn: m.lightsOn, toastPx: m.toastPx });
      if ([568, 915, 1100, 1180].includes(w)) await page.screenshot({ path: path.join(run.out, `messages-${mode}-${w}x${h}.png`) });
    }

    // ---- racing, with the status line showing (#130). It only shows in a race: a penalty, the pits, fuel or a missed deadline.
    // The race is released, then held still (the stepper stops, the HUD keeps drawing from the race state) so every size reads
    // the same state. Two states: a stop-and-go owed with the box occupied (the most chips, so the tallest meter panel), and a
    // fuel stop in the bay with a penalty to serve (the longest status line). Every rival has the longest name a player can have
    await read(page, () => { window.__game.race.goT = 0; });
    await waitFor(page, () => window.__game.race.phase === 'racing');
    await read(page, () => { window.__game.stepper.frame = () => 0; });
    c.evidence[`status-${mode}`] = [];
    for (const [w, h] of STATUS_VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      await frames(page, 3);
      const seen = [];
      for (const state of ['armed', 'service']) {
        await crowdHud(page);
        await read(page, ({ state, name }) => {
          const g = window.__game, r = g.race, p = r.car(g.localId), other = r.cars.find((o) => o !== p);
          for (const x of r.cars) { Object.assign(x, { offences: 2, sgOwed: 5, timePen: 10 }); if (x !== p) x.name = name; }
          Object.assign(p, { mode: 'race', penalty: 0, lastLap: 63.4, bestLap: 61.2 });
          r.pit.box = state === 'armed' ? other.idx : -1;
          if (state === 'service') Object.assign(p, { mode: 'service', serviceT: 0, penalty: 3, sgOwed: 0 });
        }, { state, name: LONG_NAME });
        await frames(page, 3);
        const m = await read(page, measureStatus, { touch, short: h <= 340 });
        seen.push({ state, ...m });
        c.evidence[`status-${mode}`].push({ size: `${w}x${h}`, state, pairs: m.pairs, off: m.off, status: m.status, timer: m.timer, top: m.top });
        if (state === 'service' && [568, 701, 901, 1100].includes(w)) await page.screenshot({ path: path.join(run.out, `status-${mode}-${w}x${h}.png`) });
      }
      c.ok(`Racing HUD at ${w}x${h} (${mode}): the status line (stop-and-go owed with the box busy; a fuel stop with a penalty) is on screen, readable (13 px, or the 12 px of the touch phone dock) and clear of the meters, minimap, standings, times, message and buttons; the times are clear of the buttons and minimap, with every flag shown beside long names`, seen.every((m) => m.touch === touch && m.phase === 'racing' && m.statusOn && m.statusPx >= (touch && (w <= 700 || h <= 500) ? 12 : 13) && m.off.length === 0 && m.pairs.length === 0 && m.flags && m.times) && seen[1].statusLen > 90, seen.map((m) => ({ state: m.state, overlaps: m.pairs, off: m.off, status: m.status, len: m.statusLen, px: m.statusPx, timer: m.timer, top: m.top, flags: m.flags, times: m.times })));
      // the chip cap (#130 item 3): at most 3 chips in a window 340 px tall or less, and 5 with touch at 701-1100 x 501-560, the
      // last counting the rest (the stop-and-go state has more than that, so the count must show there; the fuel stop may fit
      // without one); elsewhere every chip shows. Chips stay at 11 px or more where capped, and the touch controls 48 px
      const cap = h <= 340 ? 3 : touch && w >= 701 && w <= 1100 && h >= 501 && h <= 560 ? 5 : 0;
      c.ok(`Chips at ${w}x${h} (${mode}): ${cap ? `at most ${cap} show with the crowded HUD, and when some are hidden the last is a "+N MORE" that counts them, at 11 px or more${touch ? ', and the touch controls stay 48 px or more' : ''}` : 'every chip shows, with no "+N MORE"'}`, seen.every((m) => cap ? m.chips.shown <= cap && (m.chips.extra === null ? m.chips.hidden === 0 : /^\+\d+ MORE$/.test(m.chips.extra) && +m.chips.extra.match(/\d+/)[0] === m.chips.hidden && m.chips.hidden >= 2) && m.chips.px >= 11 && (!touch || m.pad >= 48) : m.chips.hidden === 0 && m.chips.extra === null) && (!cap || seen[0].chips.extra !== null), seen.map((m) => ({ state: m.state, chips: m.chips, pad: m.pad })));
    }
    c.ok(`Race messages (${mode}): no page or console errors`, s.errors.length === 0, s.errors.slice(0, 5));
    await s.context.close();
  }
}

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

  // ---- the race messages against the start lights and the standings, touch and mouse (#128)
  await hudMessages(run, c, champ);

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
    await read(page, () => { const p = window.__game.race.car(window.__game.localId); p.fuel = 1; p.sgOwed = 0; p.sgDue = 0; p.fuelDue = 0; p.svcBreach = null; p.timePen = 0; p.pitReq = false; p.pitPenaltyOnly = false; p.laneOverride = false; document.getElementById('h-toast').className = 'toast'; });
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
  c.ok('Resume tap does not leak into a driving action', !(await held2(page)).throttle && !(await held2(page)).brake && await read(page, () => !window.__game.race.car(window.__game.localId).pitReq && !window.__game.race.car(window.__game.localId).laneReq));

  // results and championship
  await read(page, () => { window.__game.race.phase = 'done'; });
  await toResults(page, 'results');
  await menus('results');
  await size(page, 360, 640);
  await page.locator('#o-menu').tap();
  await waitFor(page, () => window.__game.screen === 'title');
  await page.locator('#o-champ-cont').tap();
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'champ');
  // end the round for real: every car terminally classified, then the race closes and freezes its final standings (a
  // championship only records race.final, never a live order)
  await read(page, () => { const r = window.__game.race; r.classifyRunning('timeout'); r.humansDoneT = r.t - 4; });
  await toResults(page, 'champ');
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
  await page.waitForFunction(booted);
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
  await page.waitForFunction(booted);
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
    // a stopped-on-track recovery (#69: the scripted driver at software frame rates sometimes stands at a corner for 3 s) is
    // a bay stay too, but not the fuel stop this check is about
    if (st.mode === 'service' && st.stallSvc) seen.recoveries = (seen.recoveries ?? 0) + (seen.inRecovery ? 0 : 1);
    seen.inRecovery = st.mode === 'service' && st.stallSvc;
    if (st.mode === 'service' && !st.stallSvc && !seen.service) {
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
  await toResults(page, 'results');
  await frames(page, 2);
  const m = await read(page, measureMenu);
  await page.screenshot({ path: path.join(run.out, 'touchrace-results.png') });
  const res = await read(page, () => { const r = window.__game.race, p = r.car(window.__game.localId); return { stops: p.pitStops, lap: p.lapsDone, rows: document.querySelectorAll('.card.results tbody tr').length, place: document.querySelector('.place').textContent, time: p.finishTime }; });
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
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
    r.cars.forEach((o2, i) => { if (i) { o2.u = p.u + T.L / 2 + i * 8; o2.laneSide = 1; o2.d = T.LANE_HALF; o2.mode = 'race'; o2.change = null; } });
    r.squeezeQ.length = 0;
    Object.assign(p, { u: o.s, v: 0, change: null, laneSide: -1, mode: o.pit ? 'pitlane' : 'race', d: o.pit ? T.pitD(o.s) : -T.LANE_HALF, throttle: 0, revMark: null, serviced: false, fuel: o.fuel ?? 1, sgOwed: o.sgOwed ?? 0, sgDue: o.sgOwed ? 99 : 0, sgServed: 0, sgServing: false, sgLeave: false, sgCommit: -1, sgCtl: false, sgPhase: null, pitFuel: false });
    if (o.sgOwed) { p.pitReq = true; p.pitPenaltyOnly = true; }
  }, x);
  const P = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.car(window.__game.localId), T = g.T; return { s: T.wrapS(p.u), v: p.v, revOn: p.revOn, latch: p.revLatch, mode: p.mode, sgOwed: p.sgOwed, sgServing: p.sgServing, timePen: p.timePen, bay: p.bay, pitStops: p.pitStops, screen: g.screen, chips: document.getElementById('h-chips').textContent, brakeCue: document.getElementById('t-brake').dataset.cue, brakeText: document.getElementById('t-brake-cue').textContent }; });

  // ---- keyboard
  const s = await open(run);
  const { page, keys } = s;
  const T0 = await read(page, () => ({ PEN_S: window.__game.T.PEN_S, PEN_HALF: window.__game.T.PEN_HALF, BAY0: window.__game.T.BAYS[0], BAY_HALF: window.__game.T.BAY_HALF, PIT_IN1: window.__game.T.PIT_IN1 }));
  await setup(page, { s: T0.PEN_S + T0.PEN_HALF + 0.5, pit: true, sgOwed: 3 });
  // slow software frames can reach the box between two reads, so the chip is watched as it changes
  await read(page, (label) => { const el = document.getElementById('h-chips'); window.__qa.revChip = false; new MutationObserver(() => { if (el.textContent.includes(label)) window.__qa.revChip = true; }).observe(el, { childList: true, subtree: true, characterData: true }); }, STRINGS['hud.reverse']);
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).revOn || window.__game.race.car(window.__game.localId).sgServing, null, 10000);
  await frames(page, 2);
  const backing = { ...(await P(page)), chipSeen: await read(page, () => window.__qa.revChip) };
  c.ok('Keyboard: holding Brake at a standstill engages reverse and the HUD shows it', backing.chipSeen && backing.s < T0.PEN_S + T0.PEN_HALF + 0.4, backing);
  await page.screenshot({ path: path.join(run.out, 'reverse-hud.png') });
  await waitFor(page, () => window.__game.race.car(window.__game.localId).sgServing, null, 15000);
  const serving = await P(page);
  await read(page, () => { clearInterval(window.__qa.revMinT); window.__qa.revMinV = 0; window.__qa.revMinT = setInterval(() => { window.__qa.revMinV = Math.min(window.__qa.revMinV, window.__game.race.car(window.__game.localId).v); }, 5); });
  await waitFor(page, () => window.__game.race.car(window.__game.localId).sgOwed === 0, null, 20000);
  // automatic stop-and-go (docs/auto-stop-go.md): the penalty-only visit is then driven to the pit exit with Brake still held
  await waitFor(page, () => window.__game.race.car(window.__game.localId).mode === 'race', null, 20000).catch(() => null);
  await sleep(1200);
  const after = { ...(await P(page)), minV: await read(page, () => window.__qa.revMinV) };
  c.ok('Box: backing up with Brake held stops in the box and serves the full stop', Math.abs(serving.s - T0.PEN_S) < T0.PEN_HALF && after.sgOwed === 0 && after.timePen === 0, { serving, after });
  c.ok('Box: Brake still held after service never reverses, through the automatic exit and after the handover', after.mode === 'race' && after.v === 0 && !after.revOn && after.minV >= 0 && after.latch, after);
  await keys.set('ArrowDown', false);

  await setup(page, { s: T0.BAY0 + T0.BAY_HALF + 0.5, pit: true, fuel: 0.3 });
  await frames(page, 2);
  await keys.set('ArrowDown', true);
  // released on reaching the bay's far edge: a key lands a few slow software frames after the read that chose it
  await waitFor(page, (b) => { const g = window.__game, p = g.race.car(window.__game.localId); return g.T.gapS(b, g.T.wrapS(p.u)) < 0.9; }, T0.BAY0, 15000);
  await keys.set('ArrowDown', false);
  await waitFor(page, () => ['bayIn', 'service'].includes(window.__game.race.car(window.__game.localId).mode), null, 10000).catch(() => null);
  const bay = await P(page);
  c.ok('Bay: back past its own overshot bay, release, and the bay is captured for refuelling', ['bayIn', 'service'].includes(bay.mode) && bay.bay === 0 && bay.pitStops === 1, bay);

  await setup(page, { s: 120 });
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).v < -1, null, 10000);
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
  await waitFor(t.page, () => window.__game.race.car(window.__game.localId).v < -1, null, 10000);
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

/** Shared pit queue HUD and holds. Scripted placement, then real keys and emulated touch: functional diagnostics only. */
async function queue(run, c) {
  const st = (page) => read(page, () => { const g = window.__game, r = g.race, p = r.car(window.__game.localId), T = g.T; return { mode: p.mode, s: +T.wrapS(p.u).toFixed(2), v: +p.v.toFixed(3), wait: p.pitWait, hold: p.pitHold, revOn: p.revOn, latch: p.revLatch, exitReq: p.exitReq, serviced: p.serviced, offences: (window.__qa.scene ?? []).reduce((n, i) => n + r.cars[i].offences, 0), chips: document.getElementById('h-chips').textContent, status: document.getElementById('h-status').textContent, brakeCue: document.getElementById('t-brake').dataset.cue, brakeText: document.getElementById('t-brake-cue').textContent, minV: window.__qa.minV, minGap: window.__qa.minGap, seen: window.__qa.seen, inputs: window.__qa.inputs.join(' '), merges: r.pit.log.filter((e) => e.car === p.idx && e.zone.startsWith('merge')).map((e) => `${e.op}${e.why ? ':' + e.why : ''}`) }; });
  /** lap 3 under way, every car placed by script: listed cars where given, the rest parked half a lap on; AI cars in `hold` keep their brakes on */
  const setup = (page, o) => read(page, (x) => {
    const g = window.__game, T = g.T, L = 3;
    if (g.screen !== 'race') g.startSession('race');
    if (g.race.phase === 'countdown') g.advance(7);
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
    if (!r.__ai) { const ai = r.ai.bind(r); r.__ai = ai; r.ai = (car, dt) => ((window.__qa.holdAI ?? []).includes(car.idx) ? { t: 0, b: 1 } : ai(car, dt)); }
    window.__qa.holdAI = x.hold ?? [];
    r.pit = new r.pit.constructor(r);
    r.squeezeQ.length = 0;
    const put = (car, s, mode, v, side = -1) => Object.assign(car, { u: L * T.L + s, hiU: L * T.L + s, v, change: null, laneSide: side, mode, d: mode === 'pitlane' ? T.pitD(s) : side * T.LANE_HALF, throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null, revOn: false, crossed: s >= T.FINISH_S ? L + 1 : L, lapsDone: s >= T.FINISH_S ? L : L - 1, serviced: false, exitReq: false, sgOwed: 0, sgServed: 0, sgServing: false, sgDue: 0, pitPlan: false, pitReq: false, fuelReq: false, fuelDue: 0, pitFuel: false, laneOverride: false, routeHold: -1, offences: 0, fuel: 1, refuelTarget: 1 });
    r.cars.forEach((car, i) => { if (i) put(car, T.L / 2 + i * 8, 'race', 0, 1); });
    for (const k of x.cars) {
      const car = r.cars[k.i];
      put(car, k.s, k.mode === 'race' ? 'race' : 'pitlane', k.v ?? 0);
      if (k.sg) Object.assign(car, { sgOwed: k.sg, sgDue: 13, pitReq: true });
      if (k.serviced) car.serviced = true;
      if (k.bay !== undefined) { r.enterBay(car, k.bay); Object.assign(car, { mode: 'service', d: T.BAY_D, bayT: 1, serviceT: 1, fuel: 0.5, refuelTarget: k.leave ? 0 : 2 }); }
    }
    window.__qa.minV = 0; window.__qa.minGap = 99; window.__qa.seen = {}; window.__qa.inputs = []; window.__qa.scene = x.cars.map((k) => k.i);
    // the HUD is watched as it changes: a short hold can fall between two reads on slow software frames
    if (!window.__qa.chipObs) {
      const el = document.getElementById('h-chips');
      window.__qa.chipObs = new MutationObserver(() => { for (const k of x.labels) if (el.textContent.includes(k)) window.__qa.seen[k] = true; });
      window.__qa.chipObs.observe(el, { childList: true, subtree: true, characterData: true });
    }
    clearInterval(window.__qa.qT);
    window.__qa.qT = setInterval(() => {
      const rr = window.__game.race, pp = rr.car(window.__game.localId);
      window.__qa.minV = Math.min(window.__qa.minV, pp.v);
      const ik = `${window.__game.input.held('throttle') ? 'T' : '-'}${window.__game.input.held('brake') ? 'B' : '-'}${pp.pitHold ? 'H' : '-'}${pp.mode[0]}`;
      if (window.__qa.inputs.at(-1)?.split('@')[0] !== ik) window.__qa.inputs.push(`${ik}@${T.wrapS(pp.u).toFixed(1)}`);
      for (const o2 of rr.cars) if (o2 !== pp && ['race', 'pitlane'].includes(o2.mode) && ['race', 'pitlane'].includes(pp.mode) && Math.abs(o2.d - pp.d) < T.CAR_W) window.__qa.minGap = Math.min(window.__qa.minGap, Math.abs(T.gapS(rr.s(pp), rr.s(o2))));
    }, 5);
  }, { labels: [STRINGS['hud.qQueued'], STRINGS['hud.qBay'], STRINGS['hud.qExit']], ...o });
  const ok = (a) => a.minGap >= 1.38 && a.offences === 0;

  // ---- keyboard
  const s = await open(run);
  const { page, keys } = s;
  await pickRaceSetup(page);
  await page.click('#o-start');
  const G = await read(page, () => { const T = window.__game.T; return { PEN_S: T.PEN_S, PIT_IN0: T.PIT_IN0, BAYS: T.BAYS, PIT_OUT0: T.PIT_OUT0, PIT_OUT1: T.PIT_OUT1 }; });
  // Queued: an AI car serves in the box; the player arrives on Throttle alone and is held behind it
  await setup(page, { cars: [{ i: 1, s: G.PEN_S, sg: 6 }, { i: 0, s: G.PIT_IN0 + 1.5, v: 6 }] });
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).pitWait === 'queued', null, 15000);
  await frames(page, 3);
  let a = await st(page);
  c.ok('Keyboard: Throttle alone joins the box queue; HUD shows Queued with its reason', a.wait === 'queued' && a.chips.includes(STRINGS['hud.qQueued']) && a.status.includes(text('hud.qQueuedLine')) && a.v < 0.1 && ok(a), a);
  await page.screenshot({ path: path.join(run.out, 'queue-queued.png') });
  // Brake held through the hold and the box car's departure: never reverses; a fresh press later can
  await keys.set('KeyW', false);
  await keys.set('ArrowDown', true);
  await read(page, () => { window.__qa.minV = 0; });
  await waitFor(page, () => { const r = window.__game.race; return r.cars[1].sgOwed === 0 && !r.car(window.__game.localId).pitHold; }, null, 20000);
  await sleep(1500);
  const held = await st(page);
  c.ok('Keyboard: Brake held through the queue and its release never arms reverse', held.minV >= 0 && !held.revOn && held.latch && ok(held), held);
  await keys.set('ArrowDown', false);
  await frames(page, 2);
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).revOn, null, 10000).catch(() => null);
  const fresh = await st(page);
  c.ok('Keyboard: a fresh Brake press after the hold is deliberate reverse again', fresh.revOn, fresh);
  await keys.set('ArrowDown', false);

  // Waiting for bay: a car pulls out of bay 2 just ahead of the player (already refuelled, driving out), who is held clear of its merge
  await setup(page, { cars: [{ i: 2, s: G.BAYS[2], bay: 2, leave: true }, { i: 0, s: G.BAYS[2] - 2, serviced: true }] });
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__qa.seen['WAITING FOR BAY'] || window.__game.race.car(window.__game.localId).mode !== 'pitlane', null, 15000).catch(() => null);
  await waitFor(page, () => { const g = window.__game; return g.T.gapS(g.T.wrapS(g.race.car(window.__game.localId).u), g.T.BAYS[3]) < 0; }, null, 15000).catch(() => null);
  a = await st(page);
  await keys.set('KeyW', false);
  c.ok('Keyboard: a departing bay car holds the through lane; HUD shows Waiting for bay, no contact', a.seen[STRINGS['hud.qBay']] === true && ok(a), a);

  // Waiting for clear exit: one Throttle press in the bay waits for a car standing in the merge, then leaves by itself
  await setup(page, { cars: [{ i: 0, s: G.BAYS[1], bay: 1 }, { i: 3, s: G.BAYS[1] + 0.3 }], hold: [3] });
  await frames(page, 3);
  await keys.tap('KeyW');
  await frames(page, 4);
  a = await st(page);
  c.ok('Keyboard: an exit request waits in the bay; HUD shows Waiting for clear exit', a.mode === 'service' && a.exitReq && a.wait === 'exit' && a.chips.includes(STRINGS['hud.qExit']) && a.status.includes(text('hud.waitClear')), a);
  await page.screenshot({ path: path.join(run.out, 'queue-exit-bay.png') });
  await read(page, () => { window.__qa.holdAI = []; });
  await waitFor(page, () => { const p = window.__game.race.car(window.__game.localId); return p.mode === 'pitlane' && p.serviced; }, null, 15000).catch(() => null);
  a = await st(page);
  c.ok('Keyboard: the bay exit completes exactly once, with no second press', a.mode === 'pitlane' && a.serviced && a.merges.join() === 'grant,release:done' && ok(a), a);

  // the pit exit: a car standing in the outside lane at the merge holds the pit car at the line
  await setup(page, { cars: [{ i: 0, s: G.PIT_OUT0 - 3, v: 6 }, { i: 3, s: G.PIT_OUT1 + 1, mode: 'race' }], hold: [3] });
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).pitWait === 'exit', null, 15000).catch(() => null);
  await frames(page, 3);
  a = await st(page);
  c.ok('Keyboard: stationary traffic at the pit exit; HUD shows Waiting for clear exit and the car waits at the line', a.wait === 'exit' && a.mode === 'pitlane' && a.s < G.PIT_OUT0 && a.chips.includes(STRINGS['hud.qExit']), a);
  await read(page, () => { window.__qa.holdAI = []; });
  await waitFor(page, () => window.__game.race.car(window.__game.localId).mode === 'race', null, 15000).catch(() => null);
  a = await st(page);
  await keys.set('KeyW', false);
  c.ok('Keyboard: the merge goes once the outside lane clears, with no contact', a.mode === 'race' && ok(a), a);

  // ---- emulated touch
  const t = await open(run, { viewport: { width: 844, height: 390 }, device: PHONE });
  await read(t.page, () => window.__game.setTouchMode('on'));
  await pickRaceSetup(t.page);
  await t.page.click('#o-start');
  const f = new Fingers(t.page, await t.context.newCDPSession(t.page));
  // a longer stop in the box: emulated touches land several slow software frames apart
  await setup(t.page, { cars: [{ i: 1, s: G.PEN_S, sg: 15 }, { i: 0, s: G.PIT_IN0 + 1.5, v: 6 }] });
  const thr = await f.put('#t-throttle');
  await waitFor(t.page, () => window.__game.race.car(window.__game.localId).pitWait === 'queued', null, 15000).catch(() => null);
  await frames(t.page, 3);
  const tq = await st(t.page);
  await f.lift(thr);
  const brk = await f.put('#t-brake');
  await read(t.page, () => { window.__qa.minV = 0; });
  c.ok('Touch: Throttle alone joins the queue; chips show Queued and Brake says reverse is off', tq.wait === 'queued' && tq.chips.includes(STRINGS['hud.qQueued']) && tq.brakeCue === 'held' && tq.brakeText === STRINGS['touch.brake.held'], tq);
  await t.page.screenshot({ path: path.join(run.out, 'queue-touch.png') });
  await waitFor(t.page, () => { const r = window.__game.race; return r.cars[1].sgOwed === 0 && !r.car(window.__game.localId).pitHold; }, null, 60000).catch(() => null);
  await sleep(1500);
  const tb = await st(t.page);
  c.ok('Touch: holding Brake through the queue and its release never reverses', tb.minV >= 0 && !tb.revOn && tb.latch && tb.mode === 'pitlane' && tb.inputs.split(' ').some((e) => e.startsWith('-BH')) && ok(tb), tb);
  await f.lift(brk);
  c.ok('Touch: no page or console errors', t.errors.length === 0, t.errors.slice(0, 5));
  await t.context.close();
  return s;
}

/**
 * Automatic stop-and-go (docs/auto-stop-go.md): real keys and emulated touch through the takeover, entry, queue, box, exit and
 * handover; Brake held throughout; deferral by N and by the touch button; pause mid-service. Cars are placed by script.
 */
async function autosg(run, c) {
  const PH = ['armed', 'entry', 'queued', 'serving', 'leaving', 'deferred'];
  const LABEL = Object.fromEntries(PH.map((k) => [k, text(`hud.sgA.${k}`)]));
  const st = (page) => read(page, () => {
    const g = window.__game, r = g.race, p = r.car(window.__game.localId), T = g.T, q = window.__qa;
    return { screen: g.screen, mode: p.mode, s: +T.wrapS(p.u).toFixed(2), v: +p.v.toFixed(3), phase: p.sgPhase, ctl: p.sgCtl, owed: p.sgOwed, served: +p.sgServed.toFixed(2), due: p.sgDue, deferred: p.sgDeferred, box: r.pit.box,
      bayGrants: r.pit.log.filter((e) => e.car === p.idx && e.zone.startsWith('bay') && e.op === 'grant').length, boxGrants: r.pit.log.filter((e) => e.car === p.idx && e.zone === 'box' && e.op === 'grant').length,
      revOn: p.revOn, latch: p.revLatch, fuel: +p.fuel.toFixed(4), offences: r.cars.reduce((n, x) => n + x.offences, 0) - q.off0,
      chips: document.getElementById('h-chips').textContent, status: document.getElementById('h-status').textContent, toast: document.getElementById('h-toast').textContent,
      brakeCue: document.getElementById('t-brake').dataset.cue, brakeText: document.getElementById('t-brake-cue').textContent,
      minV: q.minV, vIn: q.vIn, maxV: q.maxVPit, handS: q.handS, phases: q.phases.join('>'), seen: q.seen, inputs: q.inputs.join(' '), fuelUp: q.fuelUp };
  });
  /** lap 3 under way, the player placed `before` m short of the pit entrance and given a stop-and-go; listed AI cars placed too */
  const setup = (page, o) => read(page, (x) => {
    const g = window.__game, T = g.T, L = 3;
    if (g.screen !== 'race') g.startSession('race');
    if (g.race.phase === 'countdown') g.advance(7);
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
    r.pit = new r.pit.constructor(r);
    r.squeezeQ.length = 0;
    const put = (car, s, mode, v, side = -1) => Object.assign(car, { u: L * T.L + s, hiU: L * T.L + s, v, change: null, laneSide: side, mode, d: mode === 'pitlane' ? T.pitD(s) : side * T.LANE_HALF, throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null, revOn: false, crossed: L, lapsDone: L - 1, serviced: false, exitReq: false, sgOwed: 0, sgServed: 0, sgServing: false, sgDue: 0, sgDeferred: false, sgCommit: -1, sgLeave: false, sgCtl: false, sgPhase: null, svcBreach: null, pitPlan: false, pitReq: false, fuelReq: false, fuelDue: 0, pitFuel: false, laneOverride: false, routeHold: -1, offences: 0, fuel: 0.6, refuelTarget: 1 });
    r.cars.forEach((car, i) => { if (i) put(car, T.L / 2 + i * 8, 'race', 0, 1); });
    put(p, T.PIT_IN0 - x.before, 'race', x.v);
    for (const k of x.cars ?? []) { const car = r.cars[k.i]; put(car, k.s, 'pitlane', 0); Object.assign(car, { sgOwed: k.sg, sgDue: 13, pitReq: true }); }
    if (!r.__ai) { const ai = r.ai.bind(r); r.__ai = ai; r.ai = (car, dt) => (car.mode === 'race' && car.laneSide > 0 && !car.sgOwed ? { t: 0, b: 1 } : ai(car, dt)); }
    p.offences = 2; r.offence(p, r.cars[1], 'rear'); r.cars[1].offences = 0;
    const q = window.__qa;
    Object.assign(q, { minV: 0, vIn: -1, maxVPit: 0, handS: -1, phases: [], seen: {}, inputs: [], fuelUp: false, off0: r.cars.reduce((n, y) => n + y.offences, 0) });
    if (!q.sgObs) {
      const el = document.getElementById('h-chips');
      q.sgObs = new MutationObserver(() => { const e = el.querySelector('.sgp'); if (e) q.seen[e.dataset.sg] = el.textContent.includes(x.labels[e.dataset.sg]); });
      q.sgObs.observe(el, { childList: true, subtree: true, characterData: true });
    }
    clearInterval(q.sgT);
    let last = { mode: p.mode, fuel: p.fuel };
    q.sgT = setInterval(() => {
      const rr = window.__game.race, pp = rr.car(window.__game.localId);
      q.minV = Math.min(q.minV, pp.v);
      if (pp.mode === 'pitlane') q.maxVPit = Math.max(q.maxVPit, pp.v);
      if (last.mode === 'race' && pp.mode === 'pitlane') q.vIn = +pp.v.toFixed(2);
      if (last.mode === 'pitlane' && pp.mode === 'race' && q.handS < 0) q.handS = +T.wrapS(pp.u).toFixed(2);
      if (pp.fuel > last.fuel + 1e-9) q.fuelUp = true;
      if (q.phases.at(-1) !== pp.sgPhase) q.phases.push(pp.sgPhase);
      const ik = `${window.__game.input.held('throttle') ? 'T' : '-'}${window.__game.input.held('brake') ? 'B' : '-'}${pp.sgCtl ? 'A' : '-'}${pp.mode[0]}`;
      if (q.inputs.at(-1)?.split('@')[0] !== ik) q.inputs.push(`${ik}@${T.wrapS(pp.u).toFixed(1)}`);
      last = { mode: pp.mode, fuel: pp.fuel };
    }, 5);
  }, { labels: LABEL, ...o });
  const handed = (page, ms = 40000) => waitFor(page, () => { const p = window.__game.race.car(window.__game.localId); return p.sgOwed === 0 && p.mode === 'race'; }, null, ms).catch(() => null);
  const clean = (a) => a.minV >= 0 && a.offences === 0 && a.bayGrants === 0 && !a.fuelUp;

  // ---- keyboard
  const s = await open(run);
  const { page, keys } = s;
  await pickRaceSetup(page);
  await page.click('#o-start');
  const G = await read(page, () => { const T = window.__game.T; return { PEN_S: T.PEN_S, PEN_HALF: T.PEN_HALF, PIT_IN0: T.PIT_IN0, PIT_OUT1: T.PIT_OUT1, PIT_SPEED: T.PIT_SPEED }; });

  // a clear box, Throttle held from before the takeover to the handover, Brake never pressed
  // placed at rest: on slow software frames a moving car can reach the takeover before two frames are read
  await setup(page, { before: 44, v: 0 });
  await frames(page, 2);
  const armed = await st(page);
  c.ok('Keyboard: before the approach the HUD shows Stop-and-go armed and ordinary control applies', armed.phase === 'armed' && !armed.ctl && armed.chips.includes(LABEL.armed), armed);
  await keys.set('KeyW', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).sgServing, null, 30000).catch(() => null);
  await frames(page, 2);
  const serving = await st(page);
  await page.screenshot({ path: path.join(run.out, 'autosg-serving.png') });
  c.ok('Keyboard: Throttle held, the car is taken over, enters at the pit limit and stops in the box (Auto entry, then Serving with a countdown)', serving.seen.entry && serving.phase === 'serving' && Math.abs(serving.s - G.PEN_S) < G.PEN_HALF && serving.v === 0 && serving.vIn > 0 && serving.vIn <= G.PIT_SPEED + 0.05 && /\d/.test(serving.chips) && serving.status.includes(text('hud.sgServing')) && serving.brakeCue === 'auto', serving);
  await handed(page);
  const out = await st(page);
  await keys.set('KeyW', false);
  c.ok('Keyboard: served in full, Leaving pits to the exit, control handed back past the merge; no Brake, no bay, no fuel, no contact', out.owed === 0 && out.seen.leaving && out.handS >= G.PIT_OUT1 && out.handS < G.PIT_OUT1 + 5 /* first drawn frame after the crossing: one slow software frame */ && !out.ctl && out.phase === null && !out.inputs.includes('B') && out.maxV <= G.PIT_SPEED + 0.05 && clean(out), out);

  // an occupied box: queued behind an AI car serving there, Brake held through the entry, the queue, the box and the handover
  await setup(page, { before: 30, v: 12, cars: [{ i: 1, s: G.PEN_S, sg: 6 }] });
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).sgPhase === 'queued', null, 20000).catch(() => null);
  await frames(page, 2);
  const queued = await st(page);
  c.ok('Keyboard: Brake held, the occupied box queues the car short of it; HUD shows Queued and auto · no R', queued.phase === 'queued' && queued.chips.includes(LABEL.queued) && queued.s < G.PEN_S - G.PEN_HALF && queued.box !== 0, queued);
  await handed(page, 60000);
  await sleep(1500);
  const held = await st(page);
  c.ok('Keyboard: still holding Brake, the stop is served after the AI car and the handover never reverses', held.owed === 0 && held.mode === 'race' && held.seen.serving && held.seen.leaving && !held.revOn && held.latch && held.v === 0 && clean(held), held);
  await keys.set('ArrowDown', false);
  await frames(page, 2);
  await keys.set('ArrowDown', true);
  await waitFor(page, () => window.__game.race.car(window.__game.localId).revOn, null, 10000).catch(() => null);
  const rev = await st(page);
  c.ok('Keyboard: a fresh Brake press after the handover is deliberate reverse', rev.revOn, rev);
  await keys.set('ArrowDown', false);

  // Defer (N) before the takeover: Deferred — due next lap, and the entrance is driven past
  await setup(page, { before: 60, v: 0 });
  await keys.tap('KeyN');
  await frames(page, 3);
  const dfr = await st(page);
  c.ok('Keyboard: N before the approach defers the stop; HUD shows Deferred — due next lap', dfr.phase === 'deferred' && dfr.chips.includes(LABEL.deferred) && dfr.due === 4 && dfr.deferred, dfr);
  await read(page, () => { const g = window.__game, p = g.race.car(window.__game.localId); p.u = p.hiU = 3 * g.T.L + g.T.PIT_IN0 - 3; p.v = 8; });
  await waitFor(page, () => { const g = window.__game; return g.T.wrapS(g.race.car(window.__game.localId).u) > g.T.PIT_IN0 + 2; }, null, 10000).catch(() => null);
  const past = await st(page);
  c.ok('Keyboard: the deferred approach is not taken over or entered; the debt stays', past.mode === 'race' && !past.seen.entry && past.owed > 0 && past.boxGrants === 0, past);

  // pause mid-service (Esc), then resume with nothing pressed: the stop carries on and completes on its own
  await setup(page, { before: 20, v: 10 });
  await waitFor(page, () => window.__game.race.car(window.__game.localId).sgServed > 0.5, null, 20000).catch(() => null);
  await keys.tap('Escape');
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  const p1 = await st(page);
  await sleep(1200);
  const p2 = await st(page);
  c.ok('Keyboard: pausing mid-service freezes the stop and keeps the debt and the one box reservation', p1.screen === 'pause' && p2.served === p1.served && p2.owed === p1.owed && p2.box === 0 && p2.boxGrants === 1, { p1, p2 });
  await keys.tap('Escape');
  await handed(page);
  const res = await st(page);
  c.ok('Keyboard: resumed with no key, the stop completes in full and hands over once', res.owed === 0 && res.mode === 'race' && res.boxGrants === 1 && clean(res), res);

  // the help: keyboard rules explain the automatic stop and the DQ consequence
  await keys.tap('Escape');
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  const help = await page.locator('.overlay').textContent().catch(() => '');
  c.ok('Keyboard: the pause help explains the automatic stop-and-go, the override and the DQ', help.includes(STRINGS['ctl.rules']), help.slice(0, 120));
  await keys.tap('Escape');

  // ---- emulated touch
  const t = await open(run, { viewport: { width: 844, height: 390 }, device: PHONE });
  await read(t.page, () => window.__game.setTouchMode('on'));
  await pickRaceSetup(t.page);
  await t.page.click('#o-start');
  const f = new Fingers(t.page, await t.context.newCDPSession(t.page));
  await setup(t.page, { before: 30, v: 12, cars: [{ i: 1, s: G.PEN_S, sg: 12 }] });
  const thr = await f.put('#t-throttle');
  await waitFor(t.page, () => window.__game.race.car(window.__game.localId).sgPhase === 'queued', null, 20000).catch(() => null);
  await frames(t.page, 2);
  const tq = await st(t.page);
  const overlap = await read(t.page, () => {
    const chip = document.querySelector('#h-chips .sgp')?.getBoundingClientRect();
    if (!chip) return null;
    return [...document.querySelectorAll('#t-pad .tbtn')].filter((b) => !b.hidden).some((b) => { const r = b.getBoundingClientRect(); return !(r.right <= chip.left || r.left >= chip.right || r.bottom <= chip.top || r.top >= chip.bottom); });
  });
  await t.page.screenshot({ path: path.join(run.out, 'autosg-touch-queued.png') });
  c.ok('Touch: Throttle held by finger, the car is queued automatically; Brake shows auto · no R; the state chip covers no control', tq.phase === 'queued' && tq.chips.includes(LABEL.queued) && tq.brakeCue === 'auto' && tq.brakeText === STRINGS['touch.brake.auto'] && overlap === false, { ...tq, overlap });
  await handed(t.page, 60000);
  const tdone = await st(t.page);
  await f.lift(thr);
  c.ok('Touch: served and handed back at the pit exit with the finger still on Throttle, no Brake', tdone.owed === 0 && tdone.mode === 'race' && tdone.seen.serving && tdone.seen.leaving && !tdone.inputs.includes('B') && clean(tdone), tdone);
  // touch Defer before the approach
  await setup(t.page, { before: 60, v: 0 });
  await frames(t.page, 3);
  await f.tap('#t-defer');
  await frames(t.page, 3);
  const td = await st(t.page);
  c.ok('Touch: the Defer button defers the stop; HUD shows Deferred — due next lap', td.phase === 'deferred' && td.chips.includes(LABEL.deferred) && td.due === 4, td);
  c.ok('Touch: no page or console errors', t.errors.length === 0, t.errors.slice(0, 5));
  await t.context.close();
  return s;
}

/**
 * Automatic fuel visits to the player's own bay (docs/auto-bay.md): bay paint per livery, entry and stop with Throttle held,
 * the release-then-press departure, a blocked bay merge with pause and blur, a blocked pit exit, a combined visit, and touch.
 */
async function autobay(run, c) {
  const PH = ['armed', 'deferred', 'entry', 'queued', 'serving', 'bay', 'bayWait', 'refuel', 'release', 'ready', 'exit', 'leaving'];
  const LABEL = Object.fromEntries(PH.map((k) => [k, text(`hud.sgA.${k}`)]));
  const st = (page) => read(page, () => {
    const g = window.__game, r = g.race, p = r.car(window.__game.localId), T = g.T, q = window.__qa;
    return { screen: g.screen, mode: p.mode, s: +T.wrapS(p.u).toFixed(2), v: +p.v.toFixed(3), phase: p.sgPhase, ctl: p.sgCtl, bay: p.bay, home: p.bayHome, exitReq: p.exitReq, wait: p.pitWait,
      fuel: +p.fuel.toFixed(4), owed: p.sgOwed, stops: p.pitStops, revOn: p.revOn, latch: p.revLatch, held: g.input.held('throttle'),
      wrongBay: r.pit.log.filter((e) => e.zone.startsWith('bay') && e.op === 'grant' && +e.zone.slice(3) !== e.car).length,
      merges: r.pit.log.filter((e) => e.car === p.idx && e.zone.startsWith('merge') && e.op === 'grant').length,
      offences: r.cars.reduce((n, x) => n + x.offences, 0) - q.off0,
      chips: document.getElementById('h-chips').textContent, status: document.getElementById('h-status').textContent,
      thrCue: document.getElementById('t-throttle').dataset.cue, thrText: document.getElementById('t-throttle-cue').textContent, brakeCue: document.getElementById('t-brake').dataset.cue,
      minV: q.minV, vIn: q.vIn, maxPast: q.maxPast, handS: q.handS, phases: q.phases.join('>'), seen: q.seen, inputs: q.inputs.join(' '), fuelAtReq: q.fuelAtReq, maxFuelAfter: q.maxFuelAfter };
  });
  /** lap 3, the player `before` m short of the entrance at `v`; `fuel` sets the tank; `cars` places AI cars: lane (pitlane s), bay (in bay j), road (outside lane s) */
  const setup = (page, o) => read(page, (x) => {
    const g = window.__game, T = g.T, L = 3;
    if (g.screen !== 'race') g.startSession('race');
    if (g.race.phase === 'countdown') g.advance(7);
    window.__qa.noStall(); // reads the HUD of a car held still by script for seconds of software frames: not the stopped-on-track rule (#69; see the stall scenario)
    const r = g.race, p = r.car(window.__game.localId);
    r.pit = new r.pit.constructor(r);
    r.squeezeQ.length = 0;
    const put = (car, s, mode, v, side = -1) => Object.assign(car, { u: L * T.L + s, hiU: L * T.L + s, v, change: null, laneSide: side, mode, d: mode === 'pitlane' ? T.pitD(s) : side * T.LANE_HALF, throttle: 0, graceT: 0, recoverT: 0, cutT: 0, pushedT: 0, revMark: null, revOn: false, crossed: L, lapsDone: L - 1, serviced: false, exitReq: false, sgOwed: 0, sgServed: 0, sgServing: false, sgDue: 0, sgDeferred: false, sgCommit: -1, sgLeave: false, sgCtl: false, sgPhase: null, svcBreach: null, pitPlan: false, pitReq: false, fuelReq: false, fuelDue: 0, pitFuel: false, laneOverride: false, routeHold: -1, offences: 0, fuel: 0.6, refuelTarget: 1, penalty: 0, towSvc: false, upPrev: false });
    r.cars.forEach((car, i) => { if (i) put(car, T.L / 2 + i * 8, 'race', 0, 1); });
    put(p, T.PIT_IN0 - x.before, 'race', x.v);
    p.fuel = x.fuel;
    {
      const q = window.__qa;
      q.hold = new Set();
      for (const k of x.cars ?? []) {
        const car = r.cars[k.i];
        if (k.lane !== undefined) put(car, k.lane, 'pitlane', 0);
        if (k.road !== undefined) put(car, k.road, 'race', 0);
        if (k.bay !== undefined) { put(car, T.BAYS[k.bay], 'pitlane', 0); r.enterBay(car, k.bay); Object.assign(car, { mode: 'service', d: T.BAY_D, bayT: 1, serviceT: 1, refuelTarget: 2 }); }
        q.hold.add(car.idx);
      }
      if (!r.__ai) { const ai = r.ai.bind(r); r.__ai = ai; r.ai = (car, dt) => (window.__qa.hold.has(car.idx) ? { t: 0, b: 1 } : car.mode === 'race' && car.laneSide > 0 ? { t: 0, b: 1 } : ai(car, dt)); }
      if (x.sg) { p.offences = 2; r.offence(p, r.cars[1], 'rear'); r.cars[1].offences = 0; }
      Object.assign(q, { minV: 0, vIn: -1, maxPast: -1e9, handS: -1, phases: [], seen: {}, inputs: [], fuelAtReq: null, maxFuelAfter: 0, off0: r.cars.reduce((n, y) => n + y.offences, 0) });
      if (!q.bayObs) {
        const el = document.getElementById('h-chips');
        q.bayObs = new MutationObserver(() => { const e = el.querySelector('.sgp'); if (e) q.seen[e.dataset.sg] = el.textContent.includes(x.labels[e.dataset.sg].split('{')[0].trim()); });
        q.bayObs.observe(el, { childList: true, subtree: true, characterData: true });
      }
      clearInterval(q.bayT);
      let last = { mode: p.mode, req: false };
      q.bayT = setInterval(() => {
        const rr = window.__game.race, pp = rr.car(window.__game.localId);
        q.minV = Math.min(q.minV, pp.v);
        if (pp.mode === 'pitlane' && !pp.serviced) q.maxPast = Math.max(q.maxPast, T.gapS(T.BAYS[pp.bayHome], T.wrapS(pp.u)));
        if (last.mode === 'race' && pp.mode === 'pitlane') q.vIn = +pp.v.toFixed(2);
        if (last.mode === 'pitlane' && pp.mode === 'race' && q.handS < 0) q.handS = +T.wrapS(pp.u).toFixed(2);
        if (pp.exitReq && !last.req) q.fuelAtReq = pp.fuel;
        if (q.fuelAtReq !== null) q.maxFuelAfter = Math.max(q.maxFuelAfter, pp.fuel);
        if (q.phases.at(-1) !== pp.sgPhase) q.phases.push(pp.sgPhase);
        const ik = `${window.__game.input.held('throttle') ? 'T' : '-'}${window.__game.input.held('brake') ? 'B' : '-'}${pp.sgCtl ? 'A' : '-'}${pp.mode[0]}`;
        if (q.inputs.at(-1)?.split('@')[0] !== ik) q.inputs.push(`${ik}@${T.wrapS(pp.u).toFixed(1)}`);
        last = { mode: pp.mode, req: pp.exitReq };
      }, 5);
    }
  }, { labels: LABEL, ...o });
  const until = (page, fn, ms = 30000) => waitFor(page, fn, null, ms).catch(() => null);
  const inService = (page, ms) => until(page, () => window.__game.race.car(window.__game.localId).mode === 'service', ms);
  const handed = (page, ms = 30000) => until(page, () => { const p = window.__game.race.car(window.__game.localId); return p.mode === 'race' && p.pitStops > 0 && !p.sgCtl; }, ms);
  const freeAI = (page) => read(page, () => window.__qa.hold.clear());

  // ---- bays painted from their owners, for every livery
  const s = await open(run);
  const { page, keys } = s;
  await page.click(`.track[data-id="${TRACK}"]`);
  const paints = [];
  for (const l of await read(page, () => window.__game.R.LIVERIES)) {
    await page.click(`.car[data-car="${l.id}"]`);
    const b = await read(page, () => window.__game.bays);
    paints.push({ id: l.id, want: l.color, got: b[0].color, num: b[0].num, tag: b[0].tag, mine: b[0].mine, rivals: b.slice(1).map((x) => x.color) });
  }
  const DRV = [0xe8322a, 0x2a6df0, 0x22b04b];
  c.ok('Bays: the player\'s bay takes each selectable livery, with the car number and YOU; rivals keep their colours', paints.every((x) => x.got === x.want && x.num === 7 && x.tag === STRINGS['hud.you'] && x.mine && x.rivals.join() === DRV.join()), paints);
  await page.click(`.car[data-car="violet"]`);
  await page.click('#o-start');
  await setup(page, { before: 30, v: 0, fuel: 0.5 });
  // the camera over the bays, the player parked in the through lane beside them
  await read(page, () => { const g = window.__game, T = g.T, p = g.race.car(window.__game.localId); Object.assign(p, { u: 3 * T.L + T.BAYS[1] + 1.5, mode: 'pitlane', d: T.PIT_D, v: 0 }); g.zoom(5); g.snapCam(); });
  await frames(page, 6);
  await page.screenshot({ path: path.join(run.out, 'autobay-bays-violet.png') });
  await read(page, () => window.__game.showTitle());
  await pickRaceSetup(page);
  await page.click('#o-start');
  const G = await read(page, () => { const T = window.__game.T; return { BAY0: T.BAYS[0], PIT_OUT0: T.PIT_OUT0, PIT_OUT1: T.PIT_OUT1, PIT_SPEED: T.PIT_SPEED, PEN_S: T.PEN_S }; });

  // ---- keyboard: P, then Throttle held from before the takeover into the bay; no Brake
  await setup(page, { before: 44, v: 0, fuel: 0.3 });
  await keys.tap('KeyP');
  await keys.set('KeyW', true);
  await inService(page);
  await sleep(1500);
  const arr = await st(page);
  await page.screenshot({ path: path.join(run.out, 'autobay-service-held.png') });
  c.ok('Keyboard: P and Throttle held: Auto entry, at the pit limit, stopped in its own bay without passing it, no Brake', arr.mode === 'service' && arr.bay === arr.home && arr.seen.entry && arr.seen.bay && arr.vIn > 0 && arr.vIn <= G.PIT_SPEED + 0.05 && arr.maxPast <= 0.2 && !arr.inputs.includes('B') && arr.minV >= 0 && arr.wrongBay === 0, arr);
  c.ok('Keyboard: Throttle still held after arrival does not depart; HUD says release Throttle', !arr.exitReq && arr.phase === 'release' && arr.chips.includes(LABEL.release) && arr.status.includes(STRINGS['hud.releaseHint']) && arr.fuel > 0.3, arr);
  await keys.set('KeyW', false);
  await frames(page, 3);
  const rdy = await st(page);
  c.ok('Keyboard: released, the HUD shows Ready — Throttle to leave', rdy.phase === 'ready' && rdy.chips.includes(LABEL.ready) && rdy.status.includes(STRINGS['hud.refuelHint']), rdy);
  await keys.tap('KeyW');
  await handed(page);
  await sleep(300);
  const gone = await st(page);
  c.ok('Keyboard: one tap of W leaves: refuelling stops at the request, Leaving pits, control back past the pit exit', gone.mode === 'race' && gone.merges === 1 && gone.fuelAtReq !== null && gone.maxFuelAfter <= gone.fuelAtReq + 1e-9 && gone.seen.leaving && gone.handS >= G.PIT_OUT1 && gone.handS < G.PIT_OUT1 + 5 && gone.offences === 0, gone);

  // ---- a blocked bay merge: Waiting for clear exit in the bay; Esc and a window blur keep the request; released AI lets it go
  await setup(page, { before: 25, v: 10, fuel: 0.4 });
  await keys.tap('KeyP');
  await inService(page);
  await sleep(800);
  // once the player is in its bay, an AI car stands in the through lane just behind it, inside the merge zone
  await read(page, () => { const g = window.__game, T = g.T, a = g.race.cars[1]; Object.assign(a, { u: 3 * T.L + T.BAYS[0] - 1.2, hiU: 3 * T.L + T.BAYS[0] - 1.2, d: T.pitD(T.BAYS[0] - 1.2), v: 0, mode: 'pitlane', laneSide: -1, pitFuel: false, pitPlan: false, sgOwed: 0 }); window.__qa.hold.add(1); });
  await keys.tap('KeyW');
  await frames(page, 4);
  const blk = await st(page);
  await page.screenshot({ path: path.join(run.out, 'autobay-waiting-exit.png') });
  c.ok('Keyboard: with the bay merge blocked, the car stays in its bay showing Waiting for clear exit; refuelling has stopped', blk.mode === 'service' && blk.exitReq && blk.phase === 'exit' && blk.chips.includes(LABEL.exit) && blk.status.includes(STRINGS['hud.waitClear'].split(' —')[0]) && blk.maxFuelAfter <= blk.fuelAtReq + 1e-9, blk);
  await keys.tap('Escape');
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  await keys.tap('Escape');
  await read(page, () => window.dispatchEvent(new Event('blur')));
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  const pz = await st(page);
  await keys.tap('Escape');
  await frames(page, 3);
  const pz2 = await st(page);
  c.ok('Keyboard: Esc and a window blur pause; the latched request survives both, with no key held afterwards', pz.screen === 'pause' && pz2.screen === 'race' && pz2.exitReq && pz2.mode === 'service' && !pz2.held, { pz, pz2 });
  await freeAI(page);
  await handed(page);
  const blkDone = await st(page);
  c.ok('Keyboard: once the lane car moves on, the car leaves without another press and rejoins with no contact', blkDone.mode === 'race' && blkDone.merges === 1 && blkDone.offences === 0 && blkDone.wrongBay === 0, blkDone);

  // ---- Throttle held across a blur on arrival: forgotten, so a fresh press is still needed
  await setup(page, { before: 20, v: 10, fuel: 0.4 });
  await keys.tap('KeyP');
  await keys.set('KeyW', true);
  await inService(page);
  await sleep(800);
  await read(page, () => window.dispatchEvent(new Event('blur')));
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  await keys.tap('Escape');                                   // W is still physically down: no new keydown reaches the game
  await sleep(1200);
  const stale = await st(page);
  c.ok('Keyboard: a key held across a blur is cleared and never departs; the car waits in its bay, Ready', stale.mode === 'service' && !stale.exitReq && !stale.held && stale.phase === 'ready', stale);
  await keys.set('KeyW', false);
  await keys.tap('KeyW');
  await handed(page);
  c.ok('Keyboard: the next fresh press leaves', (await st(page)).mode === 'race');

  // ---- a blocked pit exit: out of the bay, waits at the exit line, merges once the outside lane is clear
  await setup(page, { before: 20, v: 10, fuel: 0.6, cars: [{ i: 1, road: G.PIT_OUT1 + 1.2 }] });
  await keys.tap('KeyP');
  await inService(page);
  await sleep(700);
  await keys.tap('KeyW');
  await until(page, () => { const p = window.__game.race.car(window.__game.localId); return p.mode === 'pitlane' && p.pitWait === 'exit' && p.v === 0; }, 15000);
  const ex = await st(page);
  c.ok('Keyboard: a car standing at the pit-exit merge holds the player at the exit line, Waiting for clear exit, still automatic', ex.mode === 'pitlane' && ex.wait === 'exit' && ex.phase === 'leaving' && ex.ctl && ex.s < G.PIT_OUT0 && ex.chips.includes(text('hud.qExit')), ex);
  await freeAI(page);
  await handed(page);
  const exDone = await st(page);
  c.ok('Keyboard: once the outside lane clears it merges and is handed back, no contact', exDone.mode === 'race' && exDone.handS >= G.PIT_OUT1 && exDone.offences === 0, exDone);

  // ---- combined: stop-and-go first in the box, then the bay
  await setup(page, { before: 44, v: 0, fuel: 0.4, sg: true });
  await keys.tap('KeyP');
  await keys.set('KeyW', true);
  await inService(page, 40000);
  await keys.set('KeyW', false);
  const cmb = await st(page);
  c.ok('Keyboard: a combined visit serves the stop-and-go in the box, then stops in the bay (Serving, then Auto pit)', cmb.mode === 'service' && cmb.owed === 0 && cmb.bay === cmb.home && /serving.*bay/.test(cmb.phases) && cmb.wrongBay === 0, cmb);
  await sleep(400);
  await keys.tap('KeyW');
  await handed(page);

  // the help
  await keys.tap('Escape');
  await waitFor(page, () => window.__game.screen === 'pause', null, 5000).catch(() => null);
  const help = await page.locator('.overlay').textContent().catch(() => '');
  c.ok('Keyboard: the pause help explains the automatic bay stop and the release-then-press departure', help.includes(STRINGS['ctl.rules']) && help.includes(STRINGS['ctl.pit']), help.slice(0, 120));
  await keys.tap('Escape');

  // ---- emulated touch, phone and tablet
  for (const vp of [{ width: 844, height: 390, name: 'phone' }, { width: 360, height: 640, name: 'portrait phone' }, { width: 1024, height: 768, name: 'tablet' }]) {
    const t = await open(run, { viewport: { width: vp.width, height: vp.height }, device: PHONE });
    await read(t.page, () => window.__game.setTouchMode('on'));
    await pickRaceSetup(t.page);
    await t.page.click('#o-start');
    const f = new Fingers(t.page, await t.context.newCDPSession(t.page));
    await setup(t.page, { before: 30, v: 10, fuel: 0.4 });
    await f.tap('#t-pit');
    const thr = await f.put('#t-throttle');
    await inService(t.page);
    await sleep(900);
    const th = await st(t.page);
    // the state chip and the status line stay clear of every pad control and inside the viewport
    const overlap = await read(t.page, () => {
      const els = [document.querySelector('#h-chips .sgp'), document.getElementById('h-status')].map((e) => e?.getBoundingClientRect());
      if (els.some((e) => !e || !e.width)) return null;
      const off = els.some((e) => e.left < 0 || e.top < 0 || e.right > innerWidth || e.bottom > innerHeight);
      return off || [...document.querySelectorAll('#t-pad .tbtn')].filter((b) => !b.hidden).some((b) => { const r = b.getBoundingClientRect(); return els.some((c) => !(r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom)); });
    });
    await t.page.screenshot({ path: path.join(run.out, `autobay-touch-${vp.name.replace(' ', '-')}.png`) });
    c.ok(`Touch ${vp.name}: finger held on Throttle into its own bay; it does not depart, Throttle reads lift off; chip and status are on screen and cover no control`, th.mode === 'service' && th.bay === th.home && !th.exitReq && th.phase === 'release' && th.thrCue === 'release' && th.thrText === STRINGS['touch.throttle.release'] && overlap === false && !th.inputs.includes('B'), { ...th, overlap });
    await f.lift(thr);
    await frames(t.page, 3);
    const tr = await st(t.page);
    c.ok(`Touch ${vp.name}: lifted, Throttle reads tap · leave`, tr.phase === 'ready' && tr.thrCue === 'ready' && tr.thrText === STRINGS['touch.throttle.ready'], tr);
    await f.tap('#t-throttle');
    await handed(t.page);
    const tg = await st(t.page);
    c.ok(`Touch ${vp.name}: one tap leaves; refuelling stopped at the tap; handed back past the pit exit`, tg.mode === 'race' && tg.merges === 1 && tg.maxFuelAfter <= tg.fuelAtReq + 1e-9 && tg.handS >= G.PIT_OUT1 && tg.offences === 0, tg);
    c.ok(`Touch ${vp.name}: no page or console errors`, t.errors.length === 0, t.errors.slice(0, 5));
    await t.context.close();
  }
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

/**
 * The local driver in a nonzero grid slot (issue #21): camera, player marker, HUD standings, own bay, audio emphasis, personal
 * messages and pedals all follow the local driver ID, not car zero. Ends by checking slot 0 again.
 */
async function localslot(run, c) {
  const s = await open(run);
  const { page, keys } = s;
  await read(page, () => { window.__game.setLocalSlot(2); window.__game.startSession('race'); });
  await waitFor(page, () => window.__game.screen === 'race');
  const setup = await read(page, () => { const g = window.__game, r = g.race, p = r.car(g.localId); return { id: p.id, idx: p.idx, at: r.cars.indexOf(p), human: r.cars.filter((x) => x.human).map((x) => x.id), slot0: { id: r.cars[0].id, name: r.cars[0].name, human: r.cars[0].human }, bayHome: p.bayHome, num: p.num }; });
  c.ok('Local driver races in slot 2 with that slot\'s number and bay; the rival moved to slot 0 is AI', setup.idx === 2 && setup.at === 2 && setup.bayHome === 2 && setup.human.join() === 'solo' && !setup.slot0.human && setup.slot0.name === 'Blue Arrow', setup);
  await read(page, () => window.__game.advance(7));
  // pedals: Throttle held drives the local car
  await keys.set('KeyW', true); await sleep(900); await keys.set('KeyW', false);
  const drive = await read(page, () => { const g = window.__game, p = g.race.car(g.localId); return { phase: g.race.phase, u: p.u, v: p.v, throttle: p.throttle, startU: null }; });
  c.ok('Throttle drives the local car in slot 2', drive.phase === 'racing' && drive.v > 1, drive);
  // camera follows the local car
  await read(page, () => { window.__game.zoom(18); window.__game.snapCam(); });
  await frames(page, 30);
  const cam = await read(page, () => { const g = window.__game, r = g.race, p = r.car(g.localId), t = g.camTarget, d = (x) => Math.hypot(t.x - x.x, t.z + x.y); return { toMe: d(p), toCar0: d(r.cars[0]), view: g.view }; });
  c.ok('Follow camera centres on the local car, not car 0', cam.toMe < 1 && cam.toCar0 > cam.toMe + 0.5, cam);
  // marker over the local car in the full view
  await read(page, () => window.__game.setView('full'));
  await frames(page, 40);
  const mk = await read(page, () => { const g = window.__game, r = g.race, p = r.car(g.localId), m = g.marker, d = (x) => Math.hypot(m.position.x - x.x, m.position.z + x.y); return { visible: m.visible, toMe: d(p), toCar0: d(r.cars[0]) }; });
  c.ok('Player marker sits on the local car in the full view', mk.visible && mk.toMe < 0.5 && mk.toCar0 > mk.toMe + 0.5, mk);
  // HUD standings and own bay
  const hud = await read(page, () => { const g = window.__game, r = g.race, p = r.car(g.localId); const me = [...document.querySelectorAll('#h-stand .me')].map((e) => e.textContent); return { me, pos: document.getElementById('h-pos').textContent, order: r.order().indexOf(p) + 1, bays: g.bays.map((b) => ({ mine: b.mine, tag: b.tag, sign: b.sign, num: b.num })), fuel: document.getElementById('h-fuelpct').textContent, myFuel: Math.round(p.fuel * 100), mix: g.motorMix }; });
  c.ok('HUD standings mark exactly one row, the local driver, and the position is the local car\'s', hud.me.length === 1 && hud.me[0].includes(STRINGS['hud.you']) && hud.pos.startsWith(`${hud.order}/`), hud);
  c.ok('HUD fuel reads the local car', hud.fuel === `${hud.myFuel}%`, { fuel: hud.fuel, myFuel: hud.myFuel });
  c.ok('Own bay is bay 3 (slot 2), tagged You; no other bay is marked as the player\'s', hud.bays[2].mine && hud.bays[2].tag === STRINGS['hud.you'] && hud.bays.filter((b) => b.mine).length === 1 && hud.bays[0].tag === 'BLUE', hud.bays);
  c.ok('Garage signs follow the bay owners: You over bay 3, the moved rival (Blue Arrow) over bay 1', hud.bays.map((b) => b.sign).join() === [STRINGS['garage.sign2'], STRINGS['garage.sign1'], STRINGS['hud.you'], STRINGS['garage.sign3']].join(), hud.bays);
  c.ok('Audio emphasis: the local car\'s motor is the full-volume one', hud.mix[2] === 1 && hud.mix.filter((v) => v === 1).length === 1, hud.mix);
  // a personal message reaches this view, and the action only touched the local car
  await keys.tap('KeyP');
  await frames(page, 3);
  const pit = await read(page, () => { const g = window.__game, r = g.race; return { toast: document.getElementById('h-toast').textContent, mine: r.car(g.localId).pitReq, others: r.cars.filter((x) => x.id !== g.localId).map((x) => ({ id: x.id, fuelReq: x.fuelReq })) }; });
  c.ok('Pit request: the local car is routed, a toast is shown, no other car gets a fuel request', pit.mine && pit.toast.length > 0 && pit.others.every((o) => !o.fuelReq), pit);
  await page.screenshot({ path: path.join(run.out, 'localslot-full.png') });
  // back to slot 0: the solo setup is unchanged
  await read(page, () => { window.__game.setLocalSlot(0); window.__game.startSession('race'); });
  const back = await read(page, () => { const g = window.__game, r = g.race; return { ids: r.cars.map((x) => x.id), idx: r.car(g.localId).idx, names: r.cars.map((x) => x.name) }; });
  c.ok('Slot 0 again: the standard solo grid', back.idx === 0 && back.ids.join() === 'solo,ai1,ai2,ai3' && back.names.join() === 'YOU,Red Comet,Blue Arrow,Green Viper', back);
  return s;
}

/**
 * Online gate (#22). Default build: online is off and the page never contacts /api or /ws. A VITE_ONLINE=1 build served
 * with the same-origin proxy (vite.config.ts) and a local room server: the health/protocol check passes, and a page-origin
 * WebSocket completes hello, creates a server-hosted solo race and receives authoritative state. Diagnostics only.
 */
async function online(run, c) {
  const net = [];
  const s = await open(run);
  const { page } = s;
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api') || u.pathname === '/ws') net.push(u.pathname); });
  await page.reload();
  await page.waitForFunction(booted);
  await waitFor(page, () => window.__game.online.state !== 'checking', undefined, 10000);
  const st = await read(page, () => window.__game.online);
  if (st.state === 'off') {
    await sleep(1500);
    c.ok('Default build: online play is off', true, st);
    c.ok('Default build: no request to /api or /ws', net.length === 0, net);
    c.unavailable('Online room round trip', 'this build does not enable online play (VITE_ONLINE unset)');
    return s;
  }
  c.ok('Online build: the same-origin health and protocol check passes', st.state === 'available' && st.wsUrl === new URL('/ws', run.url).href.replace(/^http/, 'ws'), st);
  c.ok('Online build: only same-origin /api/health was requested before any play', net.length > 0 && net.every((p) => p === '/api/health'), net);
  const trip = await read(page, ([wsUrl, v]) => new Promise((resolve) => {
    const out = { msgs: [] };
    const ws = new WebSocket(wsUrl);
    const done = () => { try { ws.close(); } catch { /* closed */ } resolve(out); };
    setTimeout(done, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v, proto: 'slotrush' }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      out.msgs.push(m.t);
      if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'create', name: 'Browser', mode: 'solo', settings: { track: 'circuit-2' } }));
      if (m.t === 'joined') { out.code = m.room.code; out.hasToken = typeof m.token === 'string' && m.token.length > 20; ws.send(JSON.stringify({ t: 'start' })); }
      // v2: the race's first state is a keyframe with the static car fields (control among them)
      if (m.t === 'state' && m.static?.cars.length === 4) { out.track = m.snap.track; out.cars = m.static.cars.map((x) => x.control); ws.send(JSON.stringify({ t: 'leave' })); }
      if (m.t === 'bye') { out.bye = m.code; done(); }
    };
  }), [st.wsUrl, PROTOCOL]);
  c.ok('Page WebSocket through the same-origin /ws proxy: hello, solo room, server race state, leave', trip.code && trip.hasToken && trip.track === 'circuit-2' && trip.cars.join() === 'human,ai,ai,ai' && trip.bye === 'left', trip);
  c.ok('No page errors', s.errors.length === 0, s.errors);
  return s;
}

/**
 * Boot with the 3D view split out (#147). Three.js and the race view are a chunk of their own (src/view3d.ts), loaded after
 * the title. With that chunk held back by the network: the title renders and its menus work (Leaderboards and back), no canvas
 * exists yet, and Start Race waits, saying so, then reaches the race once the chunk arrives. With the chunk failing to load (an
 * old tab after a deploy removed it, or a dropped connection): the title stays up with a short error offering Reload and Try
 * again, Start Race does not leave a blank page, and Try again loads it and the race starts.
 */
async function boot(run, c) {
  const CHUNK = /\/(assets\/view3d-[^/]+\.js|src\/view3d\.ts)(\?.*)?$/;
  const errors = [];
  const fresh = async () => {
    const context = await run.browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // the refused chunk's own network error is expected here; anything else is not
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|view3d/.test(m.text())) errors.push(`console: ${m.text()}`); });
    await page.addInitScript(instrument, { seed: SEED });
    return { context, page };
  };
  const state = (page) => read(page, () => {
    const g = window.__game, note = document.getElementById('view-note');
    return { screen: g.screen, view3d: g.view3d, canvas: !!document.querySelector('#app > canvas'), title: !!document.querySelector('.card.title #o-start'),
      note: note && !note.hidden ? note.textContent.trim() : '', noteKind: note?.dataset.show ?? '', reload: !!document.getElementById('v-reload'), retry: !!document.getElementById('v-retry') };
  });

  // ---- held: the title and menus before the 3D chunk, and a start that waits for it
  const a = await fresh();
  let release;
  const gate = new Promise((r) => { release = r; });
  let asked = 0;
  await a.page.route(CHUNK, async (route) => { asked++; await gate; await route.continue(); });
  await a.page.goto(withQa(run.url));
  await waitFor(a.page, () => window.__game && window.__game.screen === 'title');
  for (let i = 0; i < 100 && !asked; i++) await sleep(50);
  const held = await state(a.page);
  c.ok('Chunk held: the title renders with no 3D view yet (no canvas, view loading)', held.title && !held.canvas && held.view3d === 'loading' && held.noteKind === '', held);
  c.ok('The 3D chunk is requested right after the title (prefetch), before Start is pressed', asked > 0, { asked });
  await a.page.click('#o-boards');
  await waitFor(a.page, () => window.__game.screen === 'boards');
  await a.page.click('#o-back');
  await waitFor(a.page, () => window.__game.screen === 'title');
  c.ok('Chunk held: the menus work (Leaderboards and back)', (await state(a.page)).title);
  await a.page.click('#o-start');
  await a.page.waitForTimeout(300);
  const waiting = await state(a.page);
  c.ok('Chunk held: Start Race waits on the title and says the race view is loading', waiting.screen === 'title' && waiting.noteKind === 'loading' && waiting.note === text('ui.viewLoading'), waiting);
  release();
  await waitFor(a.page, () => window.__game.screen === 'race');
  await frames(a.page, 3);
  const raced = await state(a.page);
  const race = await read(a.page, () => ({ mode: window.__game.mode, view: window.__game.view, phase: window.__game.race.phase, calls: window.__game.info().calls }));
  c.ok('Chunk arrived: the waiting start goes ahead into the race, drawn by the 3D view', raced.view3d === 'ready' && raced.canvas && raced.noteKind === '' && race.mode === 'race' && race.view === 'follow' && race.phase === 'countdown' && race.calls > 0, { ...raced, ...race });
  await a.context.close();

  // ---- failed: a short error instead of a blank page, and Try again recovers
  const b = await fresh();
  let refuse = true;
  await b.page.route(CHUNK, (route) => (refuse ? route.abort('failed') : route.continue()));
  await b.page.goto(withQa(run.url));
  await waitFor(b.page, () => window.__game && window.__game.screen === 'title');
  await waitFor(b.page, () => window.__game.view3d === 'failed');
  const failed = await state(b.page);
  c.ok('Chunk failed: the title stays up with a short error, Reload and Try again', failed.title && failed.noteKind === 'failed' && failed.note.startsWith(text('ui.viewFailed').slice(0, 30)) && failed.reload && failed.retry && !failed.canvas, failed);
  await b.page.click('#o-start');
  await waitFor(b.page, () => window.__game.view3d === 'failed');
  await b.page.waitForTimeout(200);
  const again = await state(b.page);
  c.ok('Chunk failed: Start Race keeps the title and the error (not a blank page)', again.screen === 'title' && again.title && again.noteKind === 'failed', again);
  await b.page.screenshot({ path: path.join(run.out, 'boot-failed.png') });
  refuse = false;
  await b.page.click('#v-retry');
  const retried = await waitFor(b.page, () => window.__game.view3d !== 'loading' && window.__game.view3d !== 'failed', undefined, 15000).then(() => true, () => false);
  const after = await state(b.page);
  if (retried) {
    await b.page.click('#o-start');
    await waitFor(b.page, () => window.__game.screen === 'race');
    c.ok('Try again after the connection is back: the view loads and Start Race reaches the race', after.view3d === 'ready' && after.noteKind === '' && after.canvas, after);
  } else {
    // a browser that remembers the failed import() for this page: Reload is the way back (offered alongside)
    c.unavailable('Try again after the connection is back', `this browser kept the failed import (${JSON.stringify(after)}); Reload is offered`);
  }
  return { context: b.context, page: b.page, errors };
}

/**
 * Debug hook gate (#146). The build opened without `?qa=1` (the production page as a visitor sees it): `window.__game` is the
 * minimal read-only object (screen, online, preset, mode, hook) with no functions, no setters and no driving or network
 * keys, and neither it nor the window property can be changed. Then with `?qa=1`: the full hook, tagged `hook: 'url'`.
 * A dev server or a VITE_QA build exposes the full hook without the flag, so the first half is unavailable there.
 */
async function qahook(run, c) {
  const FULL = ['advance', 'startSession', 'showTitle', 'qaNetLobby', 'qaNetResult', 'netDrop', 'setLocalSlot', 'setView', 'zoom', 'race', 'net', 'input', 'stepper'];
  const context = await run.browser.newContext({ viewport: run.viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // the shared recorder (no __game needed to load); the run's report reads it from the ?qa=1 page at the end
  await page.addInitScript(instrument, { seed: SEED });
  const plain = new URL(run.url); plain.searchParams.delete('qa');
  await page.goto(plain.href);
  await page.waitForFunction(booted);
  const bare = await read(page, (full) => {
    const g = window.__game, keys = Object.keys(g), d = Object.getOwnPropertyDescriptor(window, '__game');
    const props = Object.fromEntries(keys.map((k) => { const p = Object.getOwnPropertyDescriptor(g, k); return [k, { get: !!p.get, set: !!p.set, writable: !!p.writable, configurable: p.configurable, fn: typeof (p.get ? p.get.call(g) : p.value) === 'function' }]; }));
    const json = (v) => { try { return JSON.stringify(v); } catch { return 'not serialisable (not the minimal hook)'; } };
    const before = json(g);
    // every write is refused (strict mode, so a refused write throws): a property set, a new key, a delete, a nested change
    // through `online`, replacing or redefining window.__game
    const tries = (function () {
      'use strict';
      const out = [];
      const t = (name, f) => { try { f(); out.push(name + ':allowed'); } catch (e) { out.push(name + ':' + e.name); } };
      t('set', () => { g.screen = 'race'; });
      t('add', () => { g.advance = () => 0; });
      t('delete', () => { delete g.mode; });
      t('nested', () => { g.online.state = 'hacked'; });
      t('replace', () => { window.__game = { advance: () => 0 }; });
      t('redefine', () => { Object.defineProperty(window, '__game', { value: {} }); });
      return out;
    })();
    return { hook: g.hook, keys, props, present: full.filter((k) => k in g), frozen: Object.isFrozen(g), sameAfter: json(window.__game) === before && window.__game === g, windowProp: { writable: d.writable, configurable: d.configurable }, tries, screen: g.screen, online: g.online, mode: g.mode, preset: g.preset };
  }, FULL);
  if (bare.hook === 'dev' || bare.hook === 'build') {
    c.unavailable('Default build without ?qa=1: minimal read-only __game', `this build exposes the full hook without the flag (hook: ${bare.hook})`);
  } else {
    c.ok('Default build without ?qa=1: __game is the minimal hook (screen, online, preset, mode, hook) and nothing else', bare.hook === 'minimal' && bare.keys.slice().sort().join() === 'hook,mode,online,preset,screen', bare.keys);
    c.ok('Default build without ?qa=1: no advance, startSession, qaNetLobby, netDrop, setLocalSlot or any other full-hook key', bare.present.length === 0, bare.present);
    c.ok('Minimal hook: getters only, no setters, no functions, nothing configurable', Object.entries(bare.props).every(([k, p]) => !p.set && !p.fn && p.configurable === false && (k === 'hook' ? !p.get && !p.writable : p.get)), bare.props);
    c.ok('Minimal hook: frozen; a set, an added key, a delete, a nested change and replacing window.__game are all refused (TypeError) and change nothing', bare.frozen && bare.sameAfter && !bare.windowProp.writable && !bare.windowProp.configurable && ['set', 'add', 'delete', 'nested', 'replace', 'redefine'].every((t) => bare.tries.includes(`${t}:TypeError`)) && bare.online.state !== 'hacked', { tries: bare.tries, frozen: bare.frozen, windowProp: bare.windowProp });
    c.ok('Minimal hook: live values (title screen, a known preset and online state)', bare.screen === 'title' && typeof bare.preset === 'string' && typeof bare.online?.state === 'string' && typeof bare.mode === 'string', { screen: bare.screen, preset: bare.preset, online: bare.online, mode: bare.mode });
  }
  await page.goto(withQa(run.url));
  await page.waitForFunction(booted);
  const qa = await read(page, (full) => ({ hook: window.__game.hook, missing: full.filter((k) => !(k in window.__game)) }), FULL);
  c.ok('With ?qa=1: the full hook (advance, startSession, qaNetLobby, netDrop, setLocalSlot and the rest)', ['url', 'dev', 'build'].includes(qa.hook) && qa.missing.length === 0, qa);
  await read(page, () => { window.__game.startSession('race'); window.__game.advance(1); });
  const drove = await read(page, () => ({ screen: window.__game.screen, t: window.__game.race.t }));
  c.ok('With ?qa=1: the hook drives the game (startSession, advance)', drove.screen === 'race' && drove.t > 0, drove);
  return { context, page, errors };
}

/**
 * GPU textures across repeated races (#37): every race rebuilds the four car visuals, and the old ones must free their
 * textures (the number roundels leaked before). renderer.info.memory.textures returns to the first race's count each time.
 */
async function memory(run, c) {
  const s = await open(run);
  const { page } = s;
  const sample = async () => {
    await read(page, () => { window.__game.startSession('race'); window.__game.advance(3); });
    await waitFor(page, () => window.__game.screen === 'race');
    await frames(page, 5);
    return read(page, () => window.__game.info());
  };
  const counts = [];
  for (let i = 0; i < 6; i++) counts.push(await sample());
  const tex = counts.map((x) => x.textures), geo = counts.map((x) => x.geometries);
  c.ok('Textures return to the baseline after every race rebuild', tex.every((n) => n === tex[0]), { textures: tex });
  c.ok('Geometries return to the baseline after every race rebuild', geo.every((n) => n === geo[0]), { geometries: geo });
  c.ok('No page errors', s.errors.length === 0, s.errors);
  return s;
}

/**
 * The reconnect banner on the lobby (#64). A dropped link in the lobby showed the race banner, "your car is held", over the
 * room heading and Copy code at phone sizes. With a socketless lobby from `__game.qaNetLobby` (the default build has online
 * off, and this is layout, not networking), each size forces Reconnecting and checks the seat wording and that the banner's
 * rectangle meets neither the heading, #l-code nor #l-copy; back to Connected, the banner and the room it made are gone.
 * The banner is laid out above the card with CSS (#121): a message wrapped to several lines keeps the heading and Copy code in
 * view while a short screen's card scrolls, and off the menu cards it still floats below the HUD with the car wording.
 */
async function netbanner(run, c) {
  const part = (id, num, name, extra = {}) => ({ id, name, slot: num - 1, num, bay: num - 1, livery: ['yellow', 'orange', 'white', 'purple'][num - 1], color: [0xffd23f, 0xfb923c, 0xf4f4f5, 0xa855f7][num - 1], liveryRequested: null, ready: false, connected: true, host: num === 1, guest: true, joinOrder: num, left: false, ...extra });
  // a joiner's view of a full four-driver room, as in the playtest that found it
  const room = { id: 'qa-room', code: 'S8AJ37', mode: 'multiplayer', state: 'lobby', rev: 1, hostId: 'p1', settings: { track: TRACK, aiFill: false }, championship: null, participants: [part('p1', 1, 'Host'), part('p2', 2, 'Joiner', { ready: true }), part('p3', 3, 'Third'), part('p4', 4, 'Fourth')], ai: [], raceId: null, maxHumans: 4, minHumans: 2, graceS: 20 };
  const want = STRINGS['net.reconnectingLobby'].replace('{n}', '20');
  const measure = () => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const b = document.getElementById('net-banner');
    return { screen: window.__game.screen, conn: window.__game.net?.conn ?? null, shown: getComputedStyle(b).display !== 'none', text: b.textContent, banner: box('#net-banner'), heading: box('.lobby h2'), code: box('#l-code'), copy: box('#l-copy'), card: box('.lobby'), cardScroll: document.querySelector('.lobby')?.scrollTop ?? null, onCard: document.getElementById('app').classList.contains('banner-card') };
  };
  const meets = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  let s = null;
  for (const vp of [{ width: 640, height: 400 }, { width: 360, height: 640 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    if (s) await s.context.close();
    const phone = vp.width < 1000;
    s = await open(run, { viewport: vp, ...(phone ? { dpr: 2, device: PHONE } : {}) });
    const { page } = s;
    const name = `${vp.width}x${vp.height}`;
    await read(page, (r) => window.__game.qaNetLobby(r, 'p2', 'connected'), room);
    await waitFor(page, () => window.__game.screen === 'lobby');
    await frames(page, 3);
    const before = await read(page, measure);
    c.ok(`${name}: connected lobby shows the room code and no banner`, before.screen === 'lobby' && !before.shown && !before.onCard && !!before.code && !!before.copy, before);
    await read(page, (r) => window.__game.qaNetLobby(r, 'p2', 'reconnecting'), room);
    await frames(page, 3);
    const rec = await read(page, measure);
    c.ok(`${name}: Reconnecting in the lobby says the seat is held for 20 s`, rec.shown && rec.conn === 'reconnecting' && rec.text === want, { text: rec.text });
    c.ok(`${name}: the banner meets neither the room heading, #l-code nor #l-copy`, rec.shown && !meets(rec.banner, rec.heading) && !meets(rec.banner, rec.code) && !meets(rec.banner, rec.copy), rec);
    // the card scrolls inside itself on a short screen: it starting below the banner keeps every part of it clear
    c.ok(`${name}: the card starts below the banner`, rec.onCard && rec.card.y >= rec.banner.y + rec.banner.h, { banner: rec.banner, card: rec.card });
    await page.screenshot({ path: path.join(run.out, `netbanner-${name}.png`) });
    // the strip beside and above the banner belongs to the menu (#126): a click or wheel there must not reach the track
    // behind the lobby, and the dimmed backdrop stacks above the HUD's top-right buttons, as the full-screen overlay did
    const strip = await read(page, () => {
      const b = document.getElementById('net-banner').getBoundingClientRect(), mid = b.top + b.height / 2;
      const pts = [[3, 3], [3, mid], [innerWidth - 3, mid], [b.left - 4, mid], [b.right + 4, mid]].filter(([x, y]) => x >= 0 && x < innerWidth && y >= 0);
      const hits = pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y), tag: document.elementFromPoint(x, y)?.tagName ?? null, layer: !!document.elementFromPoint(x, y)?.closest('#menu-layer') }));
      // the HUD is hidden on the menu cards; shown for one synchronous read, its buttons must still be under the menu layer
      const hud = document.getElementById('hud'), was = hud.style.display;
      hud.style.display = '';
      const btn = [...document.querySelectorAll('.tr .btn')].find((e) => e.getClientRects().length > 0);
      const r = btn.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const hudTop = { id: btn.id, hit: top?.id || top?.tagName || null, underMenu: !!top?.closest('#menu-layer') };
      hud.style.display = was;
      return { hits, hudTop };
    });
    c.ok(`${name}: a point in the strip beside or above the banner is the menu layer, not the track canvas`, strip.hits.length >= 3 && strip.hits.every((h) => h.tag !== 'CANVAS' && h.layer), strip.hits);
    c.ok(`${name}: the dimmed backdrop of a menu card stacks above the HUD's top-right buttons`, strip.hudTop.underMenu, strip.hudTop);
    await read(page, () => {
      window.__wheel = { canvas: 0, seen: 0 };
      document.querySelector('#app > canvas').addEventListener('wheel', () => window.__wheel.canvas++);
      window.addEventListener('wheel', () => window.__wheel.seen++, { capture: true });
    });
    const span = strip.hits[1];
    await page.mouse.move(span.x, span.y);
    await page.mouse.wheel(0, 240);
    await page.mouse.wheel(0, -240);
    await frames(page, 2);
    const wheel = await read(page, () => window.__wheel);
    c.ok(`${name}: a mouse wheel beside the banner does not reach the track camera behind the lobby`, wheel.seen > 0 && wheel.canvas === 0, wheel);
    // a message that wraps to several lines (#121): the banner is in the layout, so the card gives up exactly the banner's
    // height; the room heading and Copy code stay in view, and on a short screen the card scrolls inside what is left
    await read(page, (msg) => { document.getElementById('net-banner').textContent = msg; }, `${want} ${want} ${want}`);
    await frames(page, 3);
    const wrap = await read(page, () => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const card = document.querySelector('.lobby'), b = document.getElementById('net-banner');
      const visible = (sel) => { const e = document.querySelector(sel); if (!e) return false; const a = e.getBoundingClientRect(), k = card.getBoundingClientRect(); return a.top >= k.top - 0.5 && a.bottom <= k.bottom + 0.5 && a.top >= 0 && a.bottom <= innerHeight + 0.5 && a.left >= 0 && a.right <= innerWidth + 0.5; };
      return { banner: r(b), card: r(card), heading: r(document.querySelector('.lobby h2')), copy: r(document.getElementById('l-copy')), headingVisible: visible('.lobby h2'), copyVisible: visible('#l-copy'), scrolls: card.scrollHeight > card.clientHeight + 1, vh: innerHeight };
    });
    const short = vp.height < 500;
    c.ok(`${name}: a wrapped banner pushes the card below its own height, clear of the heading and Copy code`, wrap.banner.h > rec.banner.h && wrap.card.y >= wrap.banner.y + wrap.banner.h && !meets(wrap.banner, wrap.heading) && !meets(wrap.banner, wrap.copy), wrap);
    c.ok(`${name}: with the wrapped banner the room heading and Copy code are on screen inside the card${short ? ', which scrolls' : ''}`, wrap.headingVisible && wrap.copyVisible && (!short || wrap.scrolls), wrap);
    await read(page, (r) => window.__game.qaNetLobby(r, 'p2', 'connected'), room);
    await frames(page, 3);
    const after = await read(page, measure);
    c.ok(`${name}: back to connected, the banner and the room made for it are gone`, !after.shown && !after.onCard && Math.abs(after.card.y - before.card.y) < 1, { before: before.card, after: after.card });
    // off the menu cards (a race, the pending results card) the banner floats below the HUD with the car wording and takes no room
    await read(page, (r) => { window.__game.qaNetLobby(r, 'p2', 'reconnecting'); window.__game.showTitle(); }, room);
    await frames(page, 3);
    const float = await read(page, () => {
      const b = document.getElementById('net-banner'), cs = getComputedStyle(b), probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;top:calc(var(--eT, 8px) + 56px)';
      document.getElementById('app').appendChild(probe);
      const hudTop = probe.getBoundingClientRect().top; probe.remove();
      return { screen: window.__game.screen, shown: cs.display !== 'none', position: cs.position, top: b.getBoundingClientRect().top, hudTop, text: b.textContent, onCard: document.getElementById('app').classList.contains('banner-card'), overlayTop: document.querySelector('.overlay').getBoundingClientRect().top };
    });
    const carWant = STRINGS['net.reconnecting'].replace('{n}', '20');
    c.ok(`${name}: off a menu card the banner floats below the HUD with the car wording, and the overlay is not pushed down`, float.screen === 'title' && float.shown && !float.onCard && float.position === 'absolute' && Math.abs(float.top - float.hudTop) < 1 && float.overlayTop === 0 && float.text === carWant, float);
    // in a race no menu layer stands over the track, the HUD or the top-right buttons, the banner still showing (#126)
    await read(page, () => window.__game.startSession('race'));
    await waitFor(page, () => window.__game.screen === 'race');
    await frames(page, 3);
    const race = await read(page, () => {
      const b = document.getElementById('net-banner').getBoundingClientRect(), at = (x, y) => document.elementFromPoint(x, y);
      const btns = [...document.querySelectorAll('.tr .btn')].filter((e) => e.getClientRects().length > 0).map((e) => { const r = e.getBoundingClientRect(), top = at(r.x + r.width / 2, r.y + r.height / 2); return { id: e.id, ok: top === e || e.contains(top) }; });
      const tl = document.querySelector('.tl').getBoundingClientRect();
      return { shown: getComputedStyle(document.getElementById('net-banner')).display !== 'none', onCard: document.getElementById('app').classList.contains('banner-card'), centre: at(innerWidth / 2, innerHeight / 2)?.tagName, strip: at(3, b.top + b.height / 2)?.tagName, beside: at(b.right + 4, b.top + b.height / 2)?.tagName, hudPanel: !at(tl.x + tl.width / 2, tl.y + tl.height / 2)?.closest('#menu-layer'), btns };
    });
    c.ok(`${name}: racing with the banner shown, the track, the HUD and the top-right buttons are on top where they are`, race.shown && !race.onCard && race.centre === 'CANVAS' && race.strip === 'CANVAS' && race.beside === 'CANVAS' && race.hudPanel && race.btns.length > 0 && race.btns.every((x) => x.ok), race);
  }
  return s;
}

/**
 * Race-length presets (#132) on the real page, mouse and keyboard on a desktop and emulated touch on a phone: the title's
 * selector (labels, keyboard, remembered choice), a local race to the flag at its own lap count, practice without a target,
 * a championship that keeps its length through resume while the selector changes (and an older save that is Standard), the
 * HUD and menus at the new widths with nothing overlapping, and the room lobby for the host (selector) and a guest (label).
 */
async function racelength(run, c) {
  const titleState = (page) => read(page, () => ({
    opts: [...document.querySelectorAll('[data-rlen]')].map((b) => ({ id: b.dataset.rlen, on: b.getAttribute('aria-checked') === 'true', text: b.textContent.replace(/\s+/g, ' ').trim(), label: b.getAttribute('aria-label') })),
    group: document.querySelector('[data-rlen]')?.closest('[role="radiogroup"]')?.getAttribute('aria-labelledby') ?? null,
    goal: document.getElementById('o-goal')?.textContent ?? '', raceLen: window.__game.raceLen, laps: window.__game.race.targetLaps, stored: localStorage.getItem('srgp.raceLength'),
  }));
  const selected = (t) => t.opts.filter((o) => o.on).map((o) => o.id).join();
  const lapsText = (n) => STRINGS['len.laps'].replace('{n}', n);
  const tag = (id, n) => STRINGS['len.tag'].replace('{name}', STRINGS[`len.${id}`]).replace('{n}', n);
  /** Put the local car just short of the line that ends lap `lap` and let real frames carry it over with Throttle held. */
  const toFlag = async (page, keys, lap) => {
    await read(page, (n) => {
      const gm = window.__game, T = gm.T, r = gm.race, p = r.car(gm.localId);
      gm.advance(7);
      r.cars.forEach((x, i) => { if (x !== p) x.u += 40 + i * 8; });
      p.u = T.FINISH_S + n * T.L - 3; p.hiU = p.u; p.crossed = n; p.lapsDone = n - 1; p.sectors = 7; p.v = 16; p.mode = 'race';
    }, lap);
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(5));
    await keys.release();
  };
  /** The three selector buttons: inside the card and the viewport, apart from each other, and (touch) at least 44 px. */
  const selectorBox = (page, attr) => read(page, (a) => {
    const bs = [...document.querySelectorAll(`[data-${a}]`)].map((b) => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { id: b.dataset[a], x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b, clipped: b.scrollWidth > b.clientWidth + 1 }; });
    const hit = (p, q) => p.x < q.r - 0.5 && q.x < p.r - 0.5 && p.y < q.b - 0.5 && q.y < p.b - 0.5;
    const card = document.querySelector('.overlay.show .card').getBoundingClientRect();
    return { bs, overlap: bs.some((p, i) => bs.some((q, j) => i < j && hit(p, q))), inside: bs.every((b) => b.x >= card.x - 0.5 && b.r <= card.right + 0.5 && b.x >= 0 && b.r <= innerWidth + 0.5), oneRow: new Set(bs.map((b) => Math.round(b.y))).size === 1 };
  }, attr);

  // ---- desktop: mouse and keyboard
  const d = await open(run, { viewport: { width: 1280, height: 800 } });
  {
    const { page, keys } = d;
    const t0 = await titleState(page);
    c.ok('Desktop title: a labelled Race length group offers Sprint 5, Standard 13 (chosen by default) and Endurance 26 laps', t0.group === 'o-rlen' && t0.opts.map((o) => o.text).join('|') === [`Sprint ${lapsText(5)}`, `Standard ${lapsText(13)}`, `Endurance ${lapsText(26)}`].join('|') && t0.opts.every((o, i) => o.label === tag(o.id, [5, 13, 26][i])) && selected(t0) === 'standard' && t0.goal.startsWith('13 laps') && t0.laps === 13 && t0.stored === null, t0);
    await page.click('[data-rlen="sprint"]');
    const t1 = await titleState(page);
    c.ok('Desktop: picking Sprint updates the goal line and the grid behind the menu, and is remembered', selected(t1) === 'sprint' && t1.goal.startsWith('5 laps') && t1.laps === 5 && t1.stored === '"sprint"', t1);
    await page.focus('[data-rlen="sprint"]');
    await keys.tap('ArrowRight'); await keys.tap('ArrowRight');
    const t2 = await titleState(page);
    const focus = await read(page, () => document.activeElement?.dataset.rlen ?? null);
    c.ok('Desktop: the arrow keys move the choice like any radio group (Sprint -> Standard -> Endurance), focus following', selected(t2) === 'endurance' && focus === 'endurance' && t2.laps === 26, { ...t2, focus });
    await keys.tap('ArrowRight');   // wraps round to Sprint
    await d.load();
    const t3 = await titleState(page);
    c.ok('Desktop: after a reload the remembered choice (Sprint) is selected again', selected(t3) === 'sprint' && t3.raceLen === 'sprint' && t3.laps === 5, t3);
    const box = await selectorBox(page, 'rlen');
    const menu = await read(page, measureMenu);
    c.ok('Desktop: the selector sits on one row inside the card, its buttons apart and unclipped; the title has no sideways overflow', box.oneRow && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped) && menu.pageX <= 0 && menu.cardX <= 0, { box, pageX: menu.pageX, cardX: menu.cardX });
    await page.screenshot({ path: path.join(run.out, 'racelength-title-1280x800.png') });

    // a Sprint race to its flag
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    await frames(page, 2);
    const hud = await read(page, () => ({ lap: document.getElementById('h-lap').textContent, laps: window.__game.race.targetLaps }));
    c.ok('Desktop Sprint race: the HUD counts to 5 (lap 1/5)', hud.lap === '1/5' && hud.laps === 5, hud);
    await toFlag(page, keys, 5);
    await toResults(page, 'results');
    const res = await read(page, () => ({ head: document.querySelector('.res-len')?.textContent ?? '', me: (() => { const p = window.__game.race.car(window.__game.localId); return [p.status, p.lapsDone]; })(), final: window.__game.race.final.map((x) => [x.status, x.laps]) }));
    c.ok('Desktop Sprint race: the flag falls at lap 5, every car is classified at 5 laps, and the results name the length', res.me.join() === 'finished,5' && res.final.every(([st, l]) => st === 'finished' && l === 5) && res.head.includes(tag('sprint', 5)), res);
    await page.screenshot({ path: path.join(run.out, 'racelength-results-sprint.png') });
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');

    // practice has no lap target, whatever is chosen
    await page.click('[data-rlen="endurance"]');
    await page.click('#o-practice');
    await waitFor(page, () => window.__game.screen === 'race');
    await read(page, () => { const gm = window.__game, T = gm.T, p = gm.race.car(gm.localId); gm.advance(3); p.u = T.FINISH_S + 30 * T.L - 2; p.hiU = p.u; p.crossed = 30; p.lapsDone = 29; p.v = 14; p.mode = 'race'; });
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(2));
    await keys.release();
    await frames(page, 2);
    const prac = await read(page, () => ({ lap: document.getElementById('h-lap').textContent, screen: window.__game.screen, finished: window.__game.race.car(window.__game.localId).finished, practice: window.__game.race.practice }));
    c.ok('Desktop practice with Endurance chosen: no lap target (lap 31, no "/26") and no flag', prac.practice && prac.lap === '31' && !prac.finished && prac.screen === 'race', prac);
    await keys.tap('Escape');
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');

    // a championship keeps the length it started with
    await page.click('#o-champ');
    await waitFor(page, () => window.__game.screen === 'race');
    await frames(page, 2);
    const ch1 = await read(page, () => ({ laps: window.__game.race.targetLaps, lap: document.getElementById('h-lap').textContent, save: JSON.parse(localStorage.getItem('srgp.champ')) }));
    c.ok('Desktop: a new championship takes the chosen length (Endurance) and stores it', ch1.laps === 26 && ch1.lap === '1/26' && ch1.save.length === 'endurance' && ch1.save.rounds.length === 0, ch1);
    await keys.tap('Escape');
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');
    await page.click('[data-rlen="sprint"]');
    const cont = await page.locator('#o-champ-cont').textContent();
    await page.click('#o-champ-cont');
    await waitFor(page, () => window.__game.screen === 'race');
    const ch2 = await read(page, () => window.__game.race.targetLaps);
    c.ok('Desktop: with Sprint now chosen, Continue still races the championship\'s Endurance (and says so on the button)', ch2 === 26 && cont.includes(tag('endurance', 26)), { laps: ch2, cont });
    await toFlag(page, keys, 26);
    await toResults(page, 'champ');
    const ch3 = await read(page, () => ({ head: document.querySelector('.champ .res-len')?.textContent ?? '', save: JSON.parse(localStorage.getItem('srgp.champ')) }));
    c.ok('Desktop: the round is stored against the Endurance championship and the standings name its length', ch3.save.rounds.length === 1 && ch3.save.length === 'endurance' && ch3.head === tag('endurance', 26), { head: ch3.head, rounds: ch3.save.rounds.length, length: ch3.save.length });
    await d.load();
    await page.click('#o-champ-cont');
    await waitFor(page, () => window.__game.screen === 'race');
    c.ok('Desktop: after a reload the championship resumes at Endurance (round 2)', (await read(page, () => [window.__game.race.targetLaps, window.__game.champ.rounds.length, window.__game.T.DEF.id])).join() === `26,1,${'circuit-2'}`);
    // an older save (no length) is a Standard championship
    await read(page, () => localStorage.setItem('srgp.champ', JSON.stringify({ v: 1, car: 'sunburst', initials: 'QA', rounds: [], startedAt: 1 })));
    await d.load();
    const legacyBtn = await page.locator('#o-champ-cont').textContent();
    await page.click('#o-champ-cont');
    await waitFor(page, () => window.__game.screen === 'race');
    c.ok('Desktop: a championship saved before presets continues as Standard (13 laps), labelled so', (await read(page, () => window.__game.race.targetLaps)) === 13 && legacyBtn.includes(tag('standard', 13)), legacyBtn);
    await d.context.close();
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));

  // ---- phone: emulated touch
  const s = await open(run, { viewport: { width: 360, height: 640 }, dpr: 2, device: PHONE, fixtures: { 'srgp.track': TRACK } });
  const { page } = s;
  const f = new Fingers(page, await s.context.newCDPSession(page));
  for (const [label, w, h] of LAYOUTS) {
    await page.setViewportSize({ width: w, height: h });
    await frames(page, 2);
    const box = await selectorBox(page, 'rlen');
    const m = await read(page, measureMenu);
    c.ok(`Touch title at ${w}x${h} (${label}): the three choices on one row, 44 px or more, apart, unclipped, and the menu fits`, box.oneRow && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped && b.w >= 44 && b.h >= 44) && menuOk(m), { box: box.bs.map((b) => `${b.id} ${Math.round(b.w)}x${Math.round(b.h)}`), m });
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await frames(page, 2);
  await page.screenshot({ path: path.join(run.out, 'racelength-title-360x640.png') });
  await f.tap('[data-rlen="endurance"]');
  const tt = await titleState(page);
  c.ok('Touch: a tap picks Endurance', selected(tt) === 'endurance' && tt.laps === 26 && tt.stored === '"endurance"', tt);
  await f.tap('#o-start');
  await waitFor(page, () => window.__game.screen === 'race');
  for (const [label, w, h] of LAYOUTS) {
    await page.setViewportSize({ width: w, height: h });
    // the widest counter an Endurance race shows
    await read(page, () => { const p = window.__game.race.car(window.__game.localId); p.lapsDone = 25; p.crossed = 26; });
    await crowdHud(page);
    await frames(page, 3);
    const m = await read(page, measureHud, CONTROLS);
    const lap = await read(page, () => { const e = document.getElementById('h-lap'); return { text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 }; });
    c.ok(`Touch Endurance HUD at ${w}x${h} (${label}): "26/26" shown unclipped, nothing overlapping`, lap.text === '26/26' && !lap.clipped && m.pairs.length === 0 && m.pageX <= 0, { lap, overlaps: m.pairs });
    if (w === 360) await page.screenshot({ path: path.join(run.out, 'racelength-hud-360x640.png') });
  }
  // the room lobby: the host's selector and a guest's label, on the phone
  const part = (id, num, name, extra = {}) => ({ id, name, slot: num - 1, num, bay: num - 1, livery: ['yellow', 'orange'][num - 1], color: [0xffd23f, 0xfb923c][num - 1], liveryRequested: null, ready: false, connected: true, host: num === 1, guest: true, joinOrder: num, left: false, ...extra });
  const room = { id: 'qa-room', code: 'S8AJ37', mode: 'multiplayer', state: 'lobby', rev: 1, hostId: 'p1', settings: { track: TRACK, aiFill: true, length: 'endurance' }, championship: null, participants: [part('p1', 1, 'Host'), part('p2', 2, 'Guest')], ai: [], raceId: null, maxHumans: 4, minHumans: 2, graceS: 20 };
  for (const [label, w, h] of LAYOUTS.slice(0, 4)) {
    await page.setViewportSize({ width: w, height: h });
    await read(page, (r) => window.__game.qaNetLobby(r, 'p1', 'connected', ['sprint', 'standard', 'endurance']), room);
    await waitFor(page, () => window.__game.screen === 'lobby');
    await frames(page, 2);
    const box = await selectorBox(page, 'nlen');
    const on = await read(page, () => [...document.querySelectorAll('[data-nlen]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.nlen).join());
    const m = await read(page, measureMenu);
    // the lobby's own standard is 40 px for every control (its track tabs are 40 px: docs/online-client.md), not the 44 of the
    // title; the AI-fill checkbox is measured by its whole label row there, so its 22 px box is left out (as online-check does)
    const lobbyOk = m.pageX <= 0 && m.cardX <= 0 && m.inside && m.blocked.length === 0 && m.small.filter((x) => !x.startsWith('l-ai ')).every((x) => Number(/(\d+)x(\d+)$/.exec(x)?.[2]) >= 40 && Number(/(\d+)x(\d+)$/.exec(x)?.[1]) >= 40);
    c.ok(`Touch lobby at ${w}x${h} (${label}), host: the length selector shows Endurance, 40 px+ like the lobby's track tabs, apart, and the lobby fits`, on === 'endurance' && !box.overlap && box.inside && box.bs.every((b) => b.top && !b.clipped && b.w >= 44 && b.h >= 40) && lobbyOk, { on, box: box.bs.map((b) => `${b.id} ${Math.round(b.w)}x${Math.round(b.h)}`), m });
    if (w === 360) await page.screenshot({ path: path.join(run.out, 'racelength-lobby-host-360x640.png') });
    await read(page, (r) => window.__game.qaNetLobby(r, 'p2', 'connected', ['sprint', 'standard', 'endurance']), room);
    await frames(page, 2);
    const guest = await read(page, () => ({ text: document.getElementById('l-len')?.textContent ?? null, radios: document.querySelectorAll('[data-nlen]').length }));
    const gm = await read(page, measureMenu);
    c.ok(`Touch lobby at ${w}x${h}, guest: the length is shown as "Endurance · 26 laps" before Ready, with no selector, and the lobby fits`, guest.text === tag('endurance', 26) && guest.radios === 0 && menuOk(gm), { guest, gm });
    if (w === 360) await page.screenshot({ path: path.join(run.out, 'racelength-lobby-guest-360x640.png') });
  }
  // a room on a server older than presets: no length in its settings, no selector even for the host, and the label says Standard
  await read(page, (r) => { const old = { ...r, settings: { track: r.settings.track, aiFill: true } }; window.__game.qaNetLobby(old, 'p1', 'connected'); }, room);
  await frames(page, 2);
  const old = await read(page, () => ({ text: document.getElementById('l-len')?.textContent ?? null, radios: document.querySelectorAll('[data-nlen]').length }));
  c.ok('Touch lobby on a server older than presets: the host gets no selector and sees "Standard · 13 laps"', old.text === tag('standard', 13) && old.radios === 0, old);
  c.ok('Touch part: no page or console errors', s.errors.length === 0, s.errors.slice(0, 5));
  return s;
}

/**
 * Post-race debrief (#134): the local results card (desktop: expanded under the standings; phone: folded under its takeaway,
 * one tap away), its figures equal to the race core's frozen summary, the personal best compared with the value read before
 * the race (and a rematch starting from zero against the new one), a championship round's debrief, and the online results
 * card for a server result with a debrief, with a personal-best baseline, and from an older server (unavailable, no zeros).
 */
async function debrief(run, c) {
  const S = (id, vars = {}) => Object.entries(vars).reduce((x, [k, v]) => x.split(`{${k}}`).join(String(v)), STRINGS[id]);
  /** the local car to the line ending lap `lap` (a scripted fast-forward), optionally de-slotting it once on the way */
  const toFlag = async (page, keys, lap, { deslot = false } = {}) => {
    await read(page, ([n, ds]) => {
      const gm = window.__game, T = gm.T, r = gm.race, p = r.car(gm.localId);
      gm.advance(7);
      if (ds) { p.mode = 'race'; p.v = 20; r.deslot(p); gm.advance(4); }
      r.cars.forEach((x, i) => { if (x !== p) x.u += 40 + i * 8; });
      p.u = T.FINISH_S + n * T.L - 3; p.hiU = p.u; p.crossed = n; p.lapsDone = n - 1; p.sectors = 7; p.v = 16; p.mode = 'race'; p.lapValid = true;
    }, [lap, deslot]);
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(5));
    await keys.release();
  };
  const card = (page, sel = '.overlay.show .card') => read(page, (q) => {
    const el = document.querySelector(`${q} .debrief`);
    const box = (e) => { if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { y: Math.round(r.y), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), inView: r.y >= 0 && r.bottom <= innerHeight + 0.5, onTop: !!top && (top === e || e.contains(top)) }; };
    const cardEl = document.querySelector(q);
    cardEl.scrollTop = 0;
    const btns = [...cardEl.querySelectorAll(':scope > .row button')].map((b) => ({ id: b.id, ...box(b) }));
    const table = cardEl.querySelector('.tscroll');
    return {
      kind: el?.dataset.debrief ?? null, open: el?.hasAttribute('open') ?? null, tk: el?.querySelector('.deb-tk')?.dataset.tk ?? null, tkText: el?.querySelector('.deb-tk')?.textContent ?? '',
      rows: Object.fromEntries([...(el?.querySelectorAll('.deb-row') ?? [])].map((r) => [r.dataset.k, r.querySelector('dd').textContent.replace(/\s+/g, ' ').trim()])),
      text: el?.textContent.replace(/\s+/g, ' ').trim() ?? '', afterTable: !!table && !!el && !!(table.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      btns, pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth, cardX: cardEl.scrollWidth - cardEl.clientWidth,
      summary: box(el?.querySelector('summary') ?? null),
    };
  }, sel);
  const btnsOk = (k) => k.btns.length > 0 && k.btns.every((b) => b.inView && b.onTop);

  // ---- desktop
  const lb = JSON.stringify([{ id: 'old1', initials: 'Annon', car: 'sunburst', ms: 99999, at: 1 }]);
  const d = await open(run, { viewport: { width: 1280, height: 800 }, fixtures: { 'srgp.track': TRACK, 'srgp.lb.race.circuit-1': lb } });
  {
    const { page, keys } = d;
    await page.click('[data-rlen="sprint"]');
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    await toFlag(page, keys, 5, { deslot: true });
    await toResults(page, 'results');
    await frames(page, 2);
    const k = await card(page);
    const sum = await read(page, () => ({ d: window.__game.race.debrief(window.__game.localId), best: window.__game.race.car(window.__game.localId).bestLap, board: window.__game.R.board('race', 'circuit-1').map((r) => r.ms) }));
    c.ok('Desktop results: the debrief is expanded under the standings with result, pace, consistency, personal best, incidents, pits and penalties',
      k.kind === 'ok' && k.open === true && k.afterTable && ['result', 'pace', 'cons', 'pb', 'inc', 'pit', 'pen'].every((x) => x in k.rows), k);
    const dd = sum.d;
    c.ok('Desktop: the figures are the race core\'s frozen summary (1 de-slot with its time off the slot, laps, valid flying laps)',
      !!dd && dd.deslots === 1 && dd.offS >= 1.7 && k.rows.inc.startsWith(S('deb.incDeslots', { n: 1 })) && k.rows.inc.includes(S('deb.incOff', { s: dd.offS.toFixed(1) }))
      && (dd.best === null ? k.rows.pace.startsWith('—') : k.rows.pace.includes(dd.best.toFixed(3))) && k.rows.result.startsWith('P'), { dd, rows: k.rows });
    const quicker = ((99999 - Math.round(sum.best * 1000)) / 1000).toFixed(3);
    c.ok('Desktop: the best lap is compared with the personal best read before the race (99.999 s), not the one it just set; the takeaway names it',
      sum.best > 0 && k.rows.pb.includes(S('deb.pbNew', { d: quicker })) && k.rows.pb.includes('99.999') && k.tk === 'deb.tk.pb' && k.tkText === S('deb.tk.pb', { d: quicker }) && Math.min(...sum.board) === Math.round(sum.best * 1000),
      { pb: k.rows.pb, tk: k.tkText, board: sum.board, best: sum.best });
    c.ok('Desktop: Race Again and Menu stay visible and clickable with the breakdown open; no sideways overflow', btnsOk(k) && k.pageX <= 0 && k.cardX <= 0, { btns: k.btns, pageX: k.pageX, cardX: k.cardX });
    await page.screenshot({ path: path.join(run.out, 'debrief-results-1280x800.png') });
    // a rematch starts from zero, compared with the best the last race set
    await page.click('#o-again');
    await waitFor(page, () => window.__game.screen === 'race');
    await toFlag(page, keys, 5);
    await toResults(page, 'results');
    const k2 = await card(page);
    const d2 = await read(page, () => window.__game.race.debrief(window.__game.localId));
    const was = (Math.round(sum.best * 1000) / 1000).toFixed(3);
    c.ok('Desktop rematch: its debrief starts from zero (no de-slot) and its personal-best baseline is the previous race\'s best',
      d2.deslots === 0 && k2.rows.inc.startsWith(S('deb.incDeslots', { n: 0 })) && k2.rows.pb.includes(was), { inc: k2.rows.inc, pb: k2.rows.pb, was });
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');

    // a championship round: the debrief under the round's results, the next round one click away
    await page.click('#o-champ');
    await waitFor(page, () => window.__game.screen === 'race');
    await toFlag(page, keys, 5);
    await toResults(page, 'champ');
    const kc = await card(page);
    c.ok('Desktop championship round: the debrief follows the round results, its result line says the place, and Continue stays visible',
      kc.kind === 'ok' && kc.afterTable && /^P\d/.test(kc.rows.result) && kc.btns.some((b) => b.id === 'o-next') && btnsOk(kc), { rows: kc.rows, btns: kc.btns });
    await page.screenshot({ path: path.join(run.out, 'debrief-champ-1280x800.png') });

    // the online results card, from server results (no server: the diagnostics hook shows a given result)
    const base = { roomId: 'r', mode: 'solo', championship: null, outcome: 'completed', abortReason: null, track: { id: 'circuit-1', version: 'v1' }, rules: { version: 'rules-x' }, settings: { length: 'standard' },
      participants: [{ id: 'h1', control: 'human', slot: 0, num: 7, name: 'Me', livery: 'yellow', setup: 'grip', tuning: 1 }, { id: 'ai_1', control: 'ai', slot: 1, num: 11, name: 'Red (AI)', livery: 'red', setup: 'balanced', tuning: 0 }],
      classification: [{ id: 'h1', slot: 0, control: 'human', pos: 1, status: 'finished', time: 190.2, laps: 13, bestLap: 14.1, pitStops: 2, timePen: 0, dqReason: null, dnfReason: null }, { id: 'ai_1', slot: 1, control: 'ai', pos: 2, status: 'finished', time: 192, laps: 13, bestLap: 14.3, pitStops: 2, timePen: 0, dqReason: null, dnfReason: null }], digest: 'x' };
    const dbf = { driver: 'h1', laps: 13, valid: 9, best: 14.1, bestLap: 6, mean: 14.352, sd: 0.187, deslots: 0, offS: 0, offences: 1, stopGos: 0, hitBy: 2, served: 0, tows: 1, recoveries: 0, pit: { visits: 2, fuel: 1, s: 21.4, queueS: 1.2, serveS: 0, bayS: 6.3 }, forced: { towS: 19.8, recS: 0, penS: 14.8 }, open: null };
    await read(page, ([b, x]) => window.__game.qaNetResult({ ...b, raceId: 'qa-1', debrief: { v: 1, drivers: [x] } }, 'h1'), [base, dbf]);
    await waitFor(page, () => window.__game.screen === 'netres');
    const n1 = await card(page);
    c.ok('Online result with a debrief: the server\'s figures (pits 21.4 s including bay and queue time, tow with its penalty, hit by others 2), a takeaway backed by them, no PB row for a guest',
      n1.kind === 'ok' && n1.tk === 'deb.tk.tow' && n1.rows.pit.includes(S('deb.pitTime', { s: '21.4' })) && n1.rows.pit.includes(S('deb.pitBay', { s: '6.3' })) && n1.rows.pit.includes(S('deb.pitQueue', { s: '1.2' }))
      && n1.rows.forced.includes(S('deb.towPen', { s: '14.8' })) && n1.rows.inc.includes(S('deb.incHitBy', { n: 2 })) && !('pb' in n1.rows) && n1.rows.result.includes(S('setup.tag', { name: STRINGS['setup.grip'] })), n1.rows);
    // a signed-in driver's bests read at the start: only the one with the same circuit version, mode, rules, setup and tuning counts
    const bests = [
      { track: 'circuit-1', trackVersion: 'v1', current: true, mode: 'solo', rules: 'rules-x', setup: 'grip', tuning: 1, tuningCurrent: true, lapMs: 14350, lap: 4, livery: 'yellow', raceId: 'old', setAt: '2026-11-01T00:00:00Z' },
      { track: 'circuit-1', trackVersion: 'v1', current: true, mode: 'solo', rules: 'rules-x', setup: 'balanced', tuning: 0, tuningCurrent: true, lapMs: 13000, lap: 4, livery: 'yellow', raceId: 'old2', setAt: '2026-11-01T00:00:00Z' },
      { track: 'circuit-1', trackVersion: 'v0', current: false, mode: 'solo', rules: 'rules-x', setup: 'grip', tuning: 1, tuningCurrent: true, lapMs: 12000, lap: 4, livery: 'yellow', raceId: 'old3', setAt: '2026-11-01T00:00:00Z' },
      { track: 'circuit-1', trackVersion: 'v1', current: true, mode: 'multiplayer', rules: 'rules-x', setup: 'grip', tuning: 1, tuningCurrent: true, lapMs: 12500, lap: 4, livery: 'yellow', raceId: 'old4', setAt: '2026-11-01T00:00:00Z' },
    ];
    await read(page, ([b, x, pb]) => window.__game.qaNetResult({ ...b, raceId: 'qa-2', debrief: { v: 1, drivers: [x] } }, 'h1', pb), [base, { ...dbf, tows: 0, forced: { towS: 0, recS: 0, penS: 0 } }, bests]);
    const n2 = await card(page);
    c.ok('Online, signed in: compared only with the compatible best (14.350 s; not another setup, layout or mode), a new PB of 0.250 s',
      n2.rows.pb?.includes(S('deb.pbNew', { d: '0.250' })) && n2.rows.pb.includes('14.350') && n2.tk === 'deb.tk.pb', n2.rows.pb);
    // a result from a server older than debriefs: unavailable, no figures, no takeaway, no clean-race claim
    await read(page, (b) => window.__game.qaNetResult({ ...b, raceId: 'qa-3' }, 'h1'), base);
    const n3 = await card(page);
    c.ok('Online result from an older server (no debrief): marked unavailable with the result line only, no zeros and no takeaway',
      n3.kind === 'none' && n3.tk === null && n3.text.includes(STRINGS['deb.unavailable']) && !/\b0\b/.test(n3.text.replace(STRINGS['deb.unavailable'], '')) && !n3.text.includes(STRINGS['deb.tk.clean']), n3.text);
    await page.screenshot({ path: path.join(run.out, 'debrief-online-old-1280x800.png') });
    await d.context.close();
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));

  // ---- phone: emulated touch
  const s = await open(run, { viewport: { width: 360, height: 640 }, dpr: 2, device: PHONE, fixtures: { 'srgp.track': TRACK } });
  const { page, keys } = s;
  // taps through Playwright's touch emulation (scrolled into view first, as a finger would find the control)
  const f = { tap: (sel) => page.locator(sel).first().tap() };
  await f.tap('[data-rlen="sprint"]');
  await f.tap('#o-start');
  await waitFor(page, () => window.__game.screen === 'race');
  await toFlag(page, keys, 5, { deslot: true });
  await toResults(page, 'results');
  await frames(page, 2);
  const p1 = await card(page);
  c.ok('Touch 360x640: the debrief starts folded, showing its title and the takeaway (1 de-slot); Race Again and Menu visible and on top',
    p1.kind === 'ok' && p1.open === false && p1.tk === 'deb.tk.deslot1' && p1.summary?.h >= 40 && btnsOk(p1) && p1.pageX <= 0 && p1.cardX <= 0, { open: p1.open, tk: p1.tk, summary: p1.summary, btns: p1.btns });
  await page.screenshot({ path: path.join(run.out, 'debrief-results-360x640-folded.png') });
  await f.tap('.debrief summary');
  await frames(page, 2);
  const p2 = await card(page);
  c.ok('Touch: a tap expands the breakdown (one column); the actions stay pinned, visible and on top; no sideways overflow',
    p2.open === true && Object.keys(p2.rows).length >= 6 && btnsOk(p2) && p2.pageX <= 0 && p2.cardX <= 0, { rows: Object.keys(p2.rows), btns: p2.btns, pageX: p2.pageX, cardX: p2.cardX });
  await page.screenshot({ path: path.join(run.out, 'debrief-results-360x640-open.png') });
  for (const [w, h] of [[640, 360], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await frames(page, 2);
    const p3 = await card(page);
    c.ok(`Touch ${w}x${h}: the expanded debrief fits the width and the actions stay visible and on top`, btnsOk(p3) && p3.pageX <= 0 && p3.cardX <= 0, { btns: p3.btns, pageX: p3.pageX, cardX: p3.cardX });
  }
  await page.setViewportSize({ width: 360, height: 640 });
  await f.tap('#o-again');
  await waitFor(page, () => window.__game.screen === 'race');
  const z = await read(page, () => window.__game.race.debrief(window.__game.localId));
  c.ok('Touch: Race Again (a tap) starts a new race whose debrief starts from zero', z === null || (z.deslots === 0 && z.laps === 0), z);
  await keys.tap('Escape');
  await f.tap('#o-menu');
  await waitFor(page, () => window.__game.screen === 'title');
  const base = { raceId: 'qa-p', roomId: 'r', mode: 'multiplayer', championship: null, outcome: 'completed', abortReason: null, track: { id: 'circuit-1', version: 'v1' }, rules: { version: 'x' }, settings: { length: 'sprint' },
    participants: [{ id: 'h1', control: 'human', slot: 0, num: 7, name: 'Me', livery: 'yellow' }], classification: [{ id: 'h1', slot: 0, control: 'human', pos: null, status: 'dq', time: null, laps: 5, bestLap: 14.1, pitStops: 0, timePen: 0, dqReason: 'stopGo', dnfReason: null }], digest: 'x' };
  const dbf = { driver: 'h1', laps: 5, valid: 1, best: 14.1, bestLap: 3, mean: 14.1, sd: null, deslots: 0, offS: 0, offences: 3, stopGos: 1, hitBy: 0, served: 0, tows: 0, recoveries: 0, pit: { visits: 0, fuel: 0, s: 0, queueS: 0, serveS: 0, bayS: 0 }, forced: { towS: 0, recS: 0, penS: 0 }, open: null };
  await read(page, ([b, x]) => window.__game.qaNetResult({ ...b, debrief: { v: 1, drivers: [x] } }, 'h1'), [base, dbf]);
  await waitFor(page, () => window.__game.screen === 'netres');
  await f.tap('.debrief summary');
  await frames(page, 2);
  const p4 = await card(page);
  c.ok('Touch online result (a DQ): the takeaway gives the DQ\'s reason, consistency shows an em dash with one valid lap, Leave stays visible',
    p4.tk === 'deb.tk.dq.stopGo' && p4.rows.cons.startsWith('—') && p4.rows.result.includes(STRINGS['res.dqReason.stopGo']) && btnsOk(p4), { tk: p4.tk, cons: p4.rows.cons, result: p4.rows.result, btns: p4.btns });
  await page.screenshot({ path: path.join(run.out, 'debrief-online-360x640.png') });
  c.ok('Touch part: no page or console errors', s.errors.length === 0, s.errors.slice(0, 5));
  return s;
}

/**
 * Post-finish spectating (#135, docs/spectating.md): a local Sprint race the player finishes ahead of the field, desktop (mouse
 * and keys) and phone (Chromium touch emulation): the spectator view comes up by itself with Throttle still held across the
 * flag (nothing more reaches any car), follows the leading car still running, Previous / Next, Whole track, the standings card
 * with a row's Watch, the watched car finishing, the panel clear of the standings, times, minimap, buttons, messages and the
 * connection banner at every MSG_VIEWS size with touch and with a mouse, Skip to results (a valid classification), Race again
 * with the key / finger still down (the new race needs a fresh press), and a championship round watched then skipped.
 */
async function spectate(run, c) {
  const S = (id, vars = {}) => Object.entries(vars).reduce((x, [k, v]) => x.split(`{${k}}`).join(String(v)), STRINGS[id]);
  /** the local car to the line ending lap `lap`, the field put a little ahead on lap 1 (so it races on for minutes) */
  const nearFlag = (page, lap) => read(page, (n) => {
    const gm = window.__game, T = gm.T, r = gm.race, p = r.car(gm.localId);
    gm.advance(7);
    r.cars.forEach((x, i) => { if (x !== p) x.u += 40 + i * 8; });
    p.u = T.FINISH_S + n * T.L - 3; p.hiU = p.u; p.crossed = n; p.lapsDone = n - 1; p.sectors = 7; p.v = 16; p.mode = 'race'; p.lapValid = true;
  }, lap);
  const state = (page) => read(page, () => {
    const g = window.__game, r = g.race, p = r.car(g.localId), tg = g.spec.target ? r.car(g.spec.target) : null;
    const el = (id) => document.getElementById(id);
    return {
      screen: g.screen, localId: g.localId, spec: g.spec, phase: r.phase, me: p.status, meId: p.id,
      running: r.order().filter((x) => x.status === 'running').map((x) => x.id), target: tg && { id: tg.id, status: tg.status, num: tg.num, name: tg.name, lap: Math.min(r.targetLaps, tg.lapsDone + 1), laps: r.targetLaps },
      held: { throttle: g.input.held('throttle'), brake: g.input.held('brake') }, pad: !el('t-pad').hidden, panel: !el('h-spec').hidden, dock: document.querySelector('.bl').getClientRects().length > 0 ? 'shown' : 'none',
      who: el('h-spec-who').textContent, lap: el('h-spec-lap').textContent, mine: el('h-spec-me').textContent, time: el('h-time').textContent, whole: el('s-whole').getAttribute('aria-pressed'),
      skip: !el('s-skip').hidden, leave: !el('s-leave').hidden, cam: g.camTarget, finishTime: p.finishTime,
    };
  });
  /** the spectator panel against everything it could land on (#121, #126, #128, #130 layouts), the banner and a long message shown */
  const measureSpec = () => {
    const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
    const rectOf = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) }; };
    const hit = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
    const parts = {};
    for (const [k, q] of Object.entries({ top: '.tl', timer: '.tc', mini: '#h-mini', toast: '#h-toast', banner: '#net-banner', spec: '#h-spec' })) { const e = document.querySelector(q); if (shown(e)) parts[k] = rectOf(e); }
    for (const e of document.querySelectorAll('.tr .btn')) if (shown(e)) parts[e.id] = rectOf(e);
    const pairs = [];
    if (parts.spec) for (const k of Object.keys(parts)) if (k !== 'spec' && hit(parts.spec, parts[k])) pairs.push(`spec/${k}`);
    const btns = [...document.querySelectorAll('#h-spec button')].filter(shown).map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { id: b.id, w: Math.round(r.width), h: Math.round(r.height), onTop: !!top && (top === b || b.contains(top)), inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 }; });
    const sp = parts.spec;
    return { pairs, btns, spec: sp, inside: !!sp && sp.x >= 0 && sp.y >= 0 && sp.r <= innerWidth + 0.5 && sp.b <= innerHeight + 0.5, banner: !!parts.banner, toast: !!parts.toast, pad: !document.getElementById('t-pad').hidden, dock: shown(document.querySelector('.bl')), touch: document.body.classList.contains('touch'), pageX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  };
  /** what a long message and the reconnect banner look like at their worst (layout only: set by hand, the race is held still) */
  const crowd = (page) => read(page, (txt) => {
    const t = document.getElementById('h-toast'); t.textContent = 'Second contact with Green Viper. One more and you serve a stop-and-go penalty'; t.className = 'toast show warn';
    const b = document.getElementById('net-banner'); b.textContent = txt; b.className = 'show rec';
    for (const x of window.__game.race.cars) Object.assign(x, { offences: 2, timePen: 10 });
  }, S('net.reconnecting', { n: 20 }));

  // ---------------------------------------------------------------- desktop, mouse and keys
  const d = await open(run, { viewport: { width: 1280, height: 800 }, fixtures: { 'srgp.track': TRACK } });
  {
    const { page, keys } = d;
    await page.click('[data-rlen="sprint"]');
    await page.click('#o-start');
    await waitFor(page, () => window.__game.screen === 'race');
    // Throttle held across the flag, as a driver does (pressed while still racing: the car is 3 m from the line once placed)
    await keys.set('KeyW', true);
    await nearFlag(page, 5);
    await read(page, () => window.__game.advance(3));
    await waitFor(page, () => window.__game.spec.active);
    await frames(page, 3);
    let a = await state(page);
    c.ok('Desktop: at the flag the spectator view comes up by itself (no card over the action); the driving dock and pad are gone and the panel shows',
      a.screen === 'race' && a.me === 'finished' && a.spec.active && a.panel && a.dock === 'none' && !a.pad && a.phase === 'racing' && a.running.length === 3, a);
    c.ok('Desktop: following the leading car still running, labelled as that car (number, name, lap of the actual 5) and never "You"; the player is still the local driver',
      a.target && a.target.id === a.running[0] && a.target.id !== a.meId && a.localId === 'solo' && a.who === `${S('spec.watching')} #${a.target.num} ${a.target.name}` && a.lap === S('spec.lap', { n: a.target.lap, m: 5 }) && a.target.laps === 5, a);
    c.ok('Desktop: the personal line is the player\'s own (flag, provisional place); Skip to results offered, no Leave (a local race)', a.mine === S('spec.youFinished', { n: 1 }) && a.skip && !a.leave, a.mine);
    c.ok('Desktop: Throttle still physically held after the flag drives nothing (released on entry)', !a.held.throttle && !a.held.brake, a.held);
    const t0 = a.time;
    await sleep(1500);
    a = await state(page);
    c.ok('Desktop: the personal race clock stopped at the player\'s finish', a.time === t0 && t0 !== '0:00.0' && a.phase === 'racing', { t0, now: a.time, finishTime: a.finishTime });
    // a fresh press while watching is ignored too
    await keys.set('KeyW', false); await keys.set('KeyS', true);
    await frames(page, 2);
    a = await state(page);
    c.ok('Desktop: a fresh Brake press while spectating is not taken as driving input', !a.held.brake && !a.held.throttle, a.held);
    await keys.set('KeyS', false);
    // Previous / Next
    const first = a.target.id;
    await keys.tap('ArrowRight'); await frames(page, 2);
    const nx = await state(page);
    await keys.tap('ArrowLeft'); await frames(page, 2);
    const pv = await state(page);
    await page.click('#s-next'); await frames(page, 2);
    const nx2 = await state(page);
    c.ok('Desktop: → and ← (and the ▶ button) move between the running cars; the local driver stays the player', nx.target.id !== first && nx.running.includes(nx.target.id) && pv.target.id === first && nx2.target.id !== first && nx2.localId === 'solo', { first, next: nx.target.id, back: pv.target.id, button: nx2.target.id });
    // Whole track
    await keys.tap('KeyC');
    const centre = await read(page, () => ({ x: window.__game.T.BOUNDS.cx, z: -window.__game.T.BOUNDS.cy - 2 }));
    // the camera eases over (frame-rate bound on this host): wait for it to arrive, up to 15 s
    await waitFor(page, (q) => Math.hypot(window.__game.camTarget.x - q.x, window.__game.camTarget.z - q.z) < 3, centre, 15000).catch(() => null);
    const w1 = await state(page);
    await page.click('#s-whole'); await frames(page, 2);
    const w2 = await state(page);
    c.ok('Desktop: C shows the whole track (button pressed, camera over the circuit centre); the button goes back to following', w1.spec.whole && w1.whole === 'true' && Math.hypot(w1.cam.x - centre.x, w1.cam.z - centre.z) < 3 && !w2.spec.whole && w2.whole === 'false' && !!w2.spec.target, { w1: [w1.spec, w1.cam], centre, w2: w2.spec });
    await page.screenshot({ path: path.join(run.out, 'spectate-desktop-1280x800.png') });
    // standings: T opens, a row's Watch picks that car and returns
    await keys.tap('KeyT');
    await waitFor(page, () => window.__game.screen === 'netwait');
    await frames(page, 2);
    const card = await read(page, () => ({ head: document.getElementById('w-head').textContent, rows: [...document.querySelectorAll('#w-rows tr')].map((r) => r.dataset.status), picks: [...document.querySelectorAll('#w-rows [data-watch]')].map((b) => b.dataset.watch), me: document.querySelector('#w-rows tr.me')?.textContent ?? '', btns: [...document.querySelectorAll('.netwait > .row button')].map((b) => b.id) }));
    const before = await read(page, () => window.__game.race.raceTime);
    await sleep(600);
    const after = await read(page, () => window.__game.race.raceTime);
    c.ok('Desktop: T opens Standings / My result over the live race (it keeps running): your row, a Watch button on each running car only, Watch the race / Skip / Menu',
      card.rows.length === 4 && card.picks.length === 3 && !card.picks.includes('solo') && card.me.includes(S('hud.you')) && card.btns.join() === 'w-watch,w-skip,w-menu' && after > before, { card, before, after });
    const pick = card.picks[card.picks.length - 1];
    await page.click(`#w-rows [data-watch="${pick}"]`);
    await waitFor(page, () => window.__game.screen === 'race');
    a = await state(page);
    c.ok('Desktop: a standings row\'s Watch follows that car and returns to the race view', a.spec.target === pick && a.spec.active && !a.spec.whole, a.spec);
    // the watched car takes the flag: the view moves on to another running car
    await read(page, (id) => { const r = window.__game.race; r.finishCar(r.car(id), r.raceTime, null); }, pick);
    await frames(page, 3);
    a = await state(page);
    c.ok('Desktop: when the watched car finishes the view moves to a car still running (never a stale target)', a.spec.target !== pick && a.running.includes(a.spec.target), { was: pick, now: a.spec.target, running: a.running });
    // layout at every message size, mouse: the race held still while measured
    await read(page, () => { window.__game.stepper.frame = () => 0; });
    c.evidence['spec-mouse'] = [];
    const sizes = [...MSG_VIEWS, [1280, 720], [1920, 1080]];
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await frames(page, 3);
      await crowd(page);
      await frames(page, 2);
      const m = await read(page, measureSpec);
      c.evidence['spec-mouse'].push({ size: `${w}x${h}`, pairs: m.pairs, spec: m.spec });
      c.ok(`Spectator panel at ${w}x${h} (mouse): on screen, clear of the standings, times, minimap, HUD buttons, a long message and the reconnect banner; every button on top`,
        !m.touch && m.inside && m.pairs.length === 0 && m.btns.length >= 5 && m.btns.every((b) => b.onTop && b.inside && b.h >= 36) && m.banner && m.toast && !m.dock && m.pageX <= 0, { pairs: m.pairs, spec: m.spec, btns: m.btns.filter((b) => !b.onTop || !b.inside || b.h < 36) });
      if ([568, 844, 1280].includes(w)) await page.screenshot({ path: path.join(run.out, `spectate-mouse-${w}x${h}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // the layout-only flags and penalties come off again before the race is finished
    await read(page, () => { const st = window.__game.stepper; delete st.frame; for (const x of window.__game.race.cars) Object.assign(x, { offences: 0, timePen: 0 }); document.getElementById('net-banner').className = ''; });
    await frames(page, 3);
    // Skip to results with Throttle held down again before the press: a valid final classification, the player's own row
    await keys.set('KeyW', true);
    await page.click('#s-skip');
    await waitFor(page, () => window.__game.screen === 'results');
    const res = await read(page, () => { const r = window.__game.race; return { phase: r.phase, final: r.final.map((x) => `${x.id}:${x.status}:${x.pos}`), rows: document.querySelectorAll('.card.results tbody tr').length, mine: document.querySelector('.card.results tr.me')?.textContent ?? '', place: document.querySelector('.card.results .place').textContent, localId: window.__game.localId, spec: window.__game.spec.active, deb: document.querySelector('.card.results .debrief')?.dataset.debrief ?? null }; });
    c.ok('Desktop: Skip to results finishes the field through the race\'s own run-on: phase done, every car terminal, the player\'s row and place, the debrief; spectating over',
      res.phase === 'done' && res.final.length === 4 && res.final.every((x) => !x.includes(':running')) && res.final[0] === 'solo:finished:1' && res.rows === 4 && res.mine.includes(S('hud.you')) && res.place === S('res.youPlace', { n: 1 }) && res.localId === 'solo' && !res.spec && res.deb === 'ok', res);
    // Race again with W still held from before: the new race does not accelerate until W is pressed again
    await page.click('#o-again');
    await waitFor(page, () => window.__game.screen === 'race' && window.__game.race.phase === 'racing', undefined, 30000);
    await read(page, () => window.__game.advance(1.5));
    await frames(page, 2);
    const again = await read(page, () => { const g = window.__game, p = g.race.car(g.localId); return { held: g.input.held('throttle'), v: p.v, throttle: p.throttle, spec: g.spec.active, pad: !document.getElementById('t-pad').hidden, panel: !document.getElementById('h-spec').hidden, dock: document.querySelector('.bl').getClientRects().length > 0 ? 'shown' : 'none' }; });
    c.ok('Desktop: Race again with Throttle held since the last race: driving mode is back (dock, no panel) and the car does not move until Throttle is pressed again',
      !again.held && again.v < 0.05 && again.throttle < 0.01 && !again.spec && !again.panel && again.dock !== 'none', again);
    await keys.set('KeyW', false);
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(1));
    const press = await read(page, () => { const g = window.__game; return { held: g.input.held('throttle'), v: g.race.car(g.localId).v }; });
    await keys.set('KeyW', false);
    c.ok('Desktop: a fresh press drives the new race', press.held && press.v > 0.5, press);
    await page.click('#b-pause');
    await page.click('#o-menu');
    await waitFor(page, () => window.__game.screen === 'title');

    // a championship round: watched after the flag, then skipped; stored once with a full classification
    await page.click('#o-champ');
    await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'champ');
    await nearFlag(page, 5);
    await keys.set('KeyW', true);
    await read(page, () => window.__game.advance(3));
    await keys.set('KeyW', false);
    await waitFor(page, () => window.__game.spec.active);
    await frames(page, 3);
    const ch = await state(page);
    const round = await read(page, () => document.getElementById('h-round').textContent);
    c.ok('Desktop championship round: watched after the flag (the round label and the panel), the save not touched while watching',
      ch.spec.active && ch.panel && !!ch.target && round.includes('1/4') && (await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')).rounds.length)) === 0, { spec: ch.spec, round });
    await page.click('#s-skip');
    await waitFor(page, () => window.__game.screen === 'champ');
    const saved = await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')));
    c.ok('Desktop championship: Skip stores the round once, against its circuit, with all four cars classified and the player first',
      saved.rounds.length === 1 && saved.rounds[0].order.length === 4 && saved.rounds[0].order[0].idx === 0, saved.rounds[0]);
    await frames(page, 4);
    c.ok('Desktop championship: still one round after more frames', (await read(page, () => JSON.parse(localStorage.getItem('srgp.champ')).rounds.length)) === 1);
  }
  c.ok('Desktop part: no page or console errors', d.errors.length === 0, d.errors.slice(0, 5));
  await d.context.close();

  // ---------------------------------------------------------------- phone, touch emulation
  const s = await open(run, { viewport: { width: 390, height: 844 }, dpr: 1, device: PHONE, fixtures: { 'srgp.track': TRACK } });
  const { page } = s;
  const cdp = await s.context.newCDPSession(page);
  const f = new Fingers(page, cdp);
  await page.locator('[data-touch="on"]').tap();
  await page.locator('[data-rlen="sprint"]').tap();
  await page.locator('#o-start').tap();
  await waitFor(page, () => window.__game.screen === 'race' && !document.getElementById('t-pad').hidden);
  // a finger on Throttle across the flag (put down while still racing: the car is 3 m from the line once placed)
  const thrAt = await f.at('#t-throttle');
  const finger = await f.put(thrAt);
  await nearFlag(page, 5);
  await read(page, () => window.__game.advance(3));
  await waitFor(page, () => window.__game.spec.active);
  await frames(page, 3);
  let a = await state(page);
  c.ok('Touch: at the flag the spectator view comes up; the pad is hidden and the finger still on the glass holds nothing', a.spec.active && a.panel && !a.pad && !a.held.throttle && a.touch !== false && a.dock === 'none', { spec: a.spec, pad: a.pad, held: a.held });
  // the finger comes off: the browser sends no click to a menu card's buttons while another finger holds the glass
  await f.lift(finger);
  const first = a.target.id;
  await f.tap('#s-next'); await frames(page, 2);
  const nx = await state(page);
  await f.tap('#s-prev'); await frames(page, 2);
  const pv = await state(page);
  c.ok('Touch: ▶ and ◀ change the watched driver; the local driver stays the player', nx.target.id !== first && pv.target.id === first && nx.localId === 'solo', { first, next: nx.target.id, back: pv.target.id });
  await f.tap('#s-whole'); await frames(page, 2);
  const w = await state(page);
  c.ok('Touch: Whole track', w.spec.whole && w.whole === 'true', w.spec);
  await f.tap('#s-stand');
  await waitFor(page, () => window.__game.screen === 'netwait');
  await frames(page, 2);
  const m = await read(page, measureMenu);
  c.ok('Touch: Standings opens the card; it fits the phone with every control reachable and 44 px or more', menuOk(m), m);
  await page.screenshot({ path: path.join(run.out, 'spectate-touch-standings-390x844.png') });
  await page.locator('#w-watch').tap();
  await waitFor(page, () => window.__game.screen === 'race');
  a = await state(page);
  c.ok('Touch: Watch the race returns to spectating with the pad still hidden', a.spec.active && !a.pad && a.panel, { spec: a.spec, pad: a.pad });
  // Skip, then Race again (Enter) with a finger already on the glass where Throttle will be: the pad comes back under it, and
  // that finger holds nothing until it presses again
  await f.tap('#s-skip');
  await waitFor(page, () => window.__game.screen === 'results');
  const ghost = await f.put(thrAt);
  await page.keyboard.press('Enter');
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.race.phase === 'racing', undefined, 30000);
  await read(page, () => window.__game.advance(1.5));
  await frames(page, 2);
  const again = await read(page, () => { const g = window.__game, p = g.race.car(g.localId); return { held: g.input.held('throttle'), v: p.v, pad: !document.getElementById('t-pad').hidden, spec: g.spec.active }; });
  c.ok('Touch: Race again with a finger already down on Throttle\'s place: the pad is back, nothing is held, the car stays on the grid', again.pad && !again.held && again.v < 0.05 && !again.spec, again);
  await f.lift(ghost);
  const fresh = await f.put('#t-throttle');
  await read(page, () => window.__game.advance(1));
  const go = await read(page, () => { const g = window.__game; return { held: g.input.held('throttle'), v: g.race.car(g.localId).v }; });
  await f.lift(fresh);
  c.ok('Touch: a fresh touch on Throttle drives the new race', go.held && go.v > 0.5, go);
  // the layout at every message size, with touch, watching this second race after its flag (no finger down)
  await nearFlag(page, 5);
  await read(page, () => window.__game.advance(3));
  await waitFor(page, () => window.__game.spec.active);
  // layout at every message size, touch
  await read(page, () => { window.__game.stepper.frame = () => 0; });
  c.evidence['spec-touch'] = [];
  for (const [wd, ht] of MSG_VIEWS) {
    await page.setViewportSize({ width: wd, height: ht });
    await frames(page, 3);
    await crowd(page);
    await frames(page, 2);
    const mm = await read(page, measureSpec);
    c.evidence['spec-touch'].push({ size: `${wd}x${ht}`, pairs: mm.pairs, spec: mm.spec });
    c.ok(`Spectator panel at ${wd}x${ht} (touch): on screen, clear of the standings, times, minimap, HUD buttons, a long message and the reconnect banner; every button on top and 48 px or more; no pad`,
      mm.touch && mm.inside && mm.pairs.length === 0 && mm.btns.length >= 5 && mm.btns.every((b) => b.onTop && b.inside && b.h >= 48 && b.w >= 48) && !mm.pad && !mm.dock && mm.pageX <= 0, { pairs: mm.pairs, spec: mm.spec, btns: mm.btns.filter((b) => !b.onTop || !b.inside || b.h < 48 || b.w < 48) });
    if ([360, 568, 844].includes(wd)) await page.screenshot({ path: path.join(run.out, `spectate-touch-${wd}x${ht}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await read(page, () => { delete window.__game.stepper.frame; for (const x of window.__game.race.cars) Object.assign(x, { offences: 0, timePen: 0 }); document.getElementById('net-banner').className = ''; });
  await frames(page, 3);
  c.ok('Touch part: no page or console errors', s.errors.length === 0, s.errors.slice(0, 5));
  return s;
}

const SCENARIOS = { tracks, race, controlled, routing, practice, championship, touch, responsive, touchrace, reverse, service, lastchance, stall, queue, autosg, autobay, localslot, online, memory, netbanner, racelength, carsetup, debrief, spectate, qahook, boot };
const USAGE = 'usage: browser-check.mjs [tracks|race|controlled|routing|practice|championship|touch|responsive|touchrace|reverse|service|lastchance|stall|queue|autosg|autobay|localslot|online|memory|netbanner|racelength|carsetup|debrief|spectate|qahook|boot ...] | perf | compare <a.json> <b.json>\n'
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
          c.evidence.log = (await capture(s.page)).log.filter((e) => ['screen', 'phase', 'mode', 'toast', 'offences', 'stall'].includes(e.key));
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

// scripts/online-check.mjs reuses the driver, input helpers and checks; run directly, this file is the browser check
export { withQa, booted, instrument, Keys, Checks, Fingers, PadKeys, PHONE, environment, capture, driveUntil, waitFor, read, sleep, LAPS, STRINGS };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
