#!/usr/bin/env node
// Bounded browser checks of online play: independent browser contexts against the real room server. Results: docs/online-client-evidence.md.
//
//   node scripts/online-check.mjs [gate lobby service connection layout]   (default: all)
//
// What runs: an online-enabled build (VITE_ONLINE=1) in dist-online/, two vite previews (same-origin /api and /ws proxies, as
// Nginx does in production), and two in-process room servers built from server/ (scripts/qa-server.ts):
//   * "fast": SLOTRUSH_TIME_SCALE=2 (test-only, refused in production) so full 13-lap races fit the time budget;
//   * "real": real time, behind a TCP proxy that can add latency, jitter and stalls, for responsiveness measurements.
// Browsers are Chromium (Playwright) with SwiftShader on a GPU-less host, and touch is Chromium's touch emulation:
// diagnostics only, not evidence of smooth play on a physical phone or tablet. Exit code 0 pass, 1 fail, 2 time limit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { instrument, Keys, Checks, Fingers, PadKeys, PHONE, environment, driveUntil, waitFor, read, sleep, LAPS, STRINGS } from './browser-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.qa/online-check', new Date().toISOString().replace(/[:.]/g, '-'));
const MAX_MIN = Number(process.env.ONLINE_CHECK_MAX_MIN ?? 40);
const str = (id) => STRINGS[id].split('{')[0].trim();
const waitUntil = async (f, ms) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(10); } };

// ------------------------------------------------------------ infrastructure
/** A TCP relay with adjustable one-way delay, jitter and a stall switch. Data order is always kept, as TCP does. */
function latencyProxy(target) {
  const ctl = { delayMs: 0, jitterMs: 0, stallUntil: 0, conns: new Set() };
  const pipe = (from, to) => {
    let last = 0;
    from.on('data', (buf) => {
      const now = Date.now();
      const at = Math.max(now + ctl.delayMs + Math.random() * ctl.jitterMs, ctl.stallUntil, last);
      last = at;
      setTimeout(() => { if (!to.destroyed) to.write(buf); }, at - now);
    });
    from.on('close', () => setTimeout(() => to.destroy(), Math.max(0, last - Date.now()) + 5));
    from.on('error', () => to.destroy());
  };
  const server = net.createServer((c) => {
    const u = net.connect(target.port, '127.0.0.1');
    ctl.conns.add(c); c.on('close', () => ctl.conns.delete(c));
    pipe(c, u); pipe(u, c);
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ ctl, port: server.address().port, close: () => { for (const c of ctl.conns) c.destroy(); server.close(); } })));
}

async function startPreview(port, backend) {
  process.env.SLOTRUSH_BACKEND = backend;
  const proxy = { '/api': { target: backend, changeOrigin: false }, '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: false } };
  const s = await preview({ root: ROOT, logLevel: 'silent', build: { outDir: path.join(ROOT, 'dist-online') }, preview: { port, strictPort: true, proxy } });
  return { url: `http://localhost:${port}/`, close: () => new Promise((r) => s.httpServer.close(r)) };
}

const VIEWS = {
  desktop: { viewport: { width: 1280, height: 720 } },
  laptop: { viewport: { width: 960, height: 540 } },
  phonePortrait: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...PHONE },
  phoneNarrow: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, ...PHONE },
  phoneLandscape: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, ...PHONE },
  tablet: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, ...PHONE },
  tabletPortrait: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, ...PHONE },
  // functional runs: CSS sizes of real devices at device pixel ratio 1, and a small desktop, so SwiftShader keeps up
  small: { viewport: { width: 480, height: 270 } },
  phoneLo: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ...PHONE },
  phoneLandLo: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, ...PHONE },
  tabletLo: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, ...PHONE },
};

/** A throwaway browser context on the low preset, with the shared in-page driver and a key or touch "Keys". */
async function openPage(run, url, view = 'laptop', { touch = false, name = view, fpsCap = 0 } = {}) {
  const context = await run.browser.newContext({ ...VIEWS[view] });
  run.contexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource|net::/.test(m.text())) errors.push(`console: ${m.text()}`); });
  // Several pages share four cores of software rendering. A cap on drawn frames (harness only, before the game loads) leaves
  // each page's main thread free for its socket and input: the online client never simulates, so only drawing slows down.
  // Each callback chain (the game loop, the timing probe) is paced on its own clock, so no loop can starve another.
  await page.addInitScript(instrument, { seed: null });
  if (fpsCap) await page.addInitScript((ms) => { const raf = window.requestAnimationFrame.bind(window); const last = new Map(); window.requestAnimationFrame = (cb) => raf(function step(ts) { if (ts - (last.get(cb) ?? 0) < ms) { raf(step); return; } last.set(cb, ts); cb(ts); }); }, Math.round(1000 / fpsCap));
  await page.addInitScript(() => {
    // Brake press timing, armed by the check: to the first server state that shows it (network + server), and to the first drawn frame
    const q = (window.__lat = { arm: false, downAt: 0, waitNet: false, waitDraw: false, net: [], drawn: [] });
    window.addEventListener('keydown', (e) => { if (q.arm && !e.repeat && e.code === 'KeyS') { q.arm = false; q.downAt = performance.now(); q.waitNet = q.waitDraw = true; } }, true);
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          if (!q.waitNet || typeof ev.data !== 'string' || !ev.data.startsWith('{"t":"state"')) return;
          const m = JSON.parse(ev.data), me = window.__game?.localId, c = m.snap.cars.find((x) => x.id === me);
          if (c && c.brake > 0) { q.net.push(+(performance.now() - q.downAt).toFixed(1)); q.waitNet = false; }
        });
      }
    };
    const raf = window.requestAnimationFrame.bind(window);
    const tick = (ts) => {
      const g = window.__game;
      if (g && q.waitDraw && g.net) { const p = g.race.car(g.localId); if (p && p.brake > 0) { q.drawn.push(+(ts - q.downAt).toFixed(1)); q.waitDraw = false; } }
      raf(tick);
    };
    raf(tick);
  });
  await page.goto(url);
  await waitFor(page, () => window.__game && window.__game.screen === 'title', undefined, 120000);
  const low = page.locator('[data-preset="low"]');
  if (await low.count()) await low.click();
  let keys = new Keys(page);
  let fingers = null;
  if (touch) {
    const cdp = await context.newCDPSession(page);
    fingers = new Fingers(page, cdp);
    keys = new PadKeys(fingers);
    await page.locator('[data-touch="on"]').click();
  }
  return { name, context, page, errors, keys, fingers, view };
}

const netOf = (page) => read(page, () => window.__game.net);
const waitOnline = (page) => waitFor(page, () => window.__game.online.state !== 'checking', undefined, 15000);

/** Through the menus: Online, a name, then create (multiplayer or solo) or join by typing the code. */
async function goOnline(s, name) {
  await waitOnline(s.page);
  // under four software-rendered pages the one health probe can time out: that page then (correctly) offers no Online, so reload once
  if (!(await s.page.locator('#o-online').count())) { s.probeRetries = (s.probeRetries ?? 0) + 1; await s.page.reload(); await waitFor(s.page, () => window.__game && window.__game.screen === 'title', undefined, 120000); await waitOnline(s.page); }
  await s.page.click('#o-online');
  await s.page.fill('#n-name', name);
}
async function createRoom(s, name, { solo = false, ai = false } = {}) {
  await goOnline(s, name);
  if (ai) await s.page.check('#n-ai');
  await s.page.click(solo ? '#n-solo' : '#n-create');
  await waitFor(s.page, () => window.__game.screen === 'lobby');
  return (await netOf(s.page)).room.code;
}
async function joinRoom(s, name, code) {
  await goOnline(s, name);
  await s.page.fill('#n-code', code);
  await s.page.click('#n-join');
}

/** Drive several browsers at once, each with its own keys or fingers, until each reaches `until`. */
const PACE = 0.72;
/** frames per second drawn by each page in the multi-page races (harness cap, see openPage) */
const CAP = 4;
/** pace of the scripted drivers in the representative race (real time, so they stay within the finish window of the AI) */
const SPACE = 0.86;
async function driveAll(list, until, budgetMs, opts = {}) {
  return Promise.all(list.map((s) => driveUntil(s, until, { budgetMs, opts: { pace: PACE, ...opts } }).catch((e) => ({ error: String(e.message ?? e) }))).concat());
}
const done = (st) => st.finished || st.screen === 'netres' || st.screen === 'netwait' || st.screen === 'online' || st.screen === 'title';

async function snapshotOf(page, file) { try { await page.screenshot({ path: path.join(OUT, file) }); } catch { /* best effort */ } }

/** Layout facts for whatever card is open: horizontal overflow, cut-off text and small touch targets. */
const layoutFacts = (page) => read(page, () => {
  const card = document.querySelector('.overlay.show .card');
  const vw = innerWidth, vh = innerHeight;
  const r = card?.getBoundingClientRect();
  const targets = [...(card?.querySelectorAll('button, input:not(.chk input), label.chk') ?? [])].filter((e) => e.offsetParent).map((e) => { const b = e.getBoundingClientRect(); return { id: e.id || e.dataset.nlivery || e.dataset.mylivery || e.dataset.ntrack || e.tagName, w: Math.round(b.width), h: Math.round(b.height) }; });
  return {
    vw, vh, card: r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
    fitsWidth: !!r && r.left >= -1 && r.right <= vw + 1, docScrollX: document.documentElement.scrollWidth > vw + 1,
    small: targets.filter((t) => t.h < 40 || t.w < 40), targets: targets.length,
  };
});

// ------------------------------------------------------------ scenarios
/** Online-enabled build with no reachable service: nothing online is offered, and local play and saves work as before. */
async function gate(run, c) {
  const fixtures = { 'srgp.initials': '"QA"', 'srgp.car': '"blaze"', 'srgp.board.race.circuit-1': JSON.stringify([{ id: 'x1', initials: 'QA', car: 'blaze', ms: 61234, at: 1 }]), 'srgp.champ': JSON.stringify({ v: 1, car: 'blaze', initials: 'QA', rounds: [{ track: 'circuit-1', order: [{ idx: 0, dnf: false, time: 200 }, { idx: 1, dnf: false, time: 201 }, { idx: 2, dnf: false, time: 202 }, { idx: 3, dnf: false, time: 203 }] }], startedAt: 1 }) };
  const s = await openPage(run, run.deadUrl, 'laptop');
  const { page } = s;
  await read(page, (f) => { for (const [k, v] of Object.entries(f)) localStorage.setItem(k, v); }, fixtures);
  await page.reload();
  await waitFor(page, () => window.__game && window.__game.screen === 'title');
  await waitOnline(page);
  const st = await read(page, () => ({ online: window.__game.online, button: !!document.getElementById('o-online'), note: document.querySelector('.net-off')?.textContent ?? '' }));
  c.ok('Service down: health check fails, so online play is not offered (no Online button) and the page says so', st.online.state === 'unavailable' && !st.button && st.note.length > 0, st);
  await page.click('[data-preset="balanced"]');
  await page.click('#o-start');
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'race');
  await sleep(6000);
  const r = await read(page, () => ({ mode: window.__game.mode, phase: window.__game.race.phase, t: window.__game.race.t, preset: window.__game.preset, me: window.__game.localId }));
  c.ok('Service down: a local race runs on this device (graphics preset applied)', r.mode === 'race' && r.t > 1.5 && r.preset === 'balanced' && r.me === 'solo', r);
  await page.keyboard.press('Escape');
  await page.click('#o-menu');
  await page.click('#o-practice');
  await waitFor(page, () => window.__game.screen === 'race' && window.__game.mode === 'practice');
  c.ok('Service down: practice starts', true);
  await page.keyboard.press('Escape'); await page.click('#o-menu');
  const champ = await read(page, () => !!document.getElementById('o-champ-cont'));
  c.ok('Service down: the stored championship is offered to continue', champ);
  const kept = await read(page, (f) => Object.keys(f).filter((k) => localStorage.getItem(k) !== f[k]), fixtures);
  c.ok('Stored records and championship are byte-identical afterwards', kept.length === 0, kept);
  await page.click('[data-preset="low"]');
  return [s];
}

/** Lobby flows and the 4-, 3- and 2-player races, all through the UI on the time-scaled server. */
async function lobby(run, c) {
  const url = run.fastUrl;
  const host = await openPage(run, url, 'small', { name: 'host', fpsCap: CAP });
  const phone = await openPage(run, url, 'phoneLo', { touch: true, name: 'phone', fpsCap: CAP });
  const tablet = await openPage(run, url, 'tabletLo', { touch: true, name: 'tablet', fpsCap: CAP });
  const desk = await openPage(run, url, 'small', { name: 'desk', fpsCap: CAP });
  const all = [host, phone, tablet, desk];
  const code = await createRoom(host, 'Host Ana');
  c.ok('Create room: a 6-character code is shown as text in the lobby', /^[A-Z2-9]{6}$/.test(code) && (await host.page.locator('#l-code').textContent()) === code, code);
  await joinRoom(phone, '<img src=x onerror="window.__xss=1">Zed', code.toLowerCase());
  await joinRoom(tablet, 'Tab', code);
  await joinRoom(desk, 'Desk', code);
  for (const s of all) await waitFor(s.page, () => window.__game.screen === 'lobby' && window.__game.net.room.participants.length === 4);
  const lob = await read(host.page, () => ({ rows: [...document.querySelectorAll('.lobby tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()), imgs: document.querySelectorAll('.lobby tbody img').length, xss: !!window.__xss }));
  const xssPhone = await read(phone.page, () => ({ xss: !!window.__xss, imgs: document.querySelectorAll('.overlay img').length }));
  c.ok('Lobby lists every driver with number, name and state; a name containing markup renders as text', lob.rows.length === 4 && lob.rows.some((r) => r.includes('<img src=x')) && lob.imgs === 0 && !lob.xss && !xssPhone.xss && xssPhone.imgs === 0, lob);
  await snapshotOf(phone.page, 'lobby-phone-portrait.png'); await snapshotOf(tablet.page, 'lobby-tablet.png'); await snapshotOf(host.page, 'lobby-laptop.png');
  for (const s of [phone, tablet, host]) c.ok(`Lobby layout (${s.view}): card fits the width, no sideways scroll`, (await layoutFacts(s.page)).fitsWidth && !(await layoutFacts(s.page)).docScrollX, await layoutFacts(s.page));
  // fifth human (opened only now: every open page renders, and SwiftShader shares four cores)
  const fifth = await openPage(run, url, 'phoneLandLo', { touch: true, name: 'fifth', fpsCap: CAP });
  await joinRoom(fifth, 'Fifth', code);
  await waitFor(fifth.page, () => document.getElementById('n-msg')?.textContent.length > 0 && !document.getElementById('n-msg').textContent.includes('Connecting'));
  const full = await read(fifth.page, () => ({ screen: window.__game.screen, msg: document.getElementById('n-msg').textContent, net: window.__game.net }));
  c.ok('A fifth driver is refused with "room is full" and stays on a usable menu', full.screen === 'online' && full.msg === STRINGS['net.err.full'] && full.net === null, full);
  c.ok('No page errors (fifth)', fifth.errors.length === 0, fifth.errors);
  await fifth.context.close();
  // readiness and permissions
  const start0 = await read(host.page, () => document.getElementById('l-start')?.getAttribute('aria-disabled'));
  await host.page.click('#l-start', { force: true });   // aria-disabled: still pressable, and the server refuses with a reason
  await waitFor(host.page, () => document.getElementById('l-msg').textContent.includes('ready') || document.getElementById('l-msg').textContent.includes('Not everyone'));
  const notStarted = await read(host.page, () => window.__game.net.room.state);
  c.ok('Start is refused until every driver is ready (the host sees why)', start0 === 'true' && notStarted === 'lobby', { start0, notStarted });
  c.ok('Only the host has Start; guests have Ready', (await phone.page.locator('#l-start').count()) === 0 && (await phone.page.locator('#l-ready').count()) === 1);
  await phone.page.locator('#l-ready').tap();
  await waitFor(host.page, () => window.__game.net.room.participants.filter((p) => p.ready).length === 1);
  await phone.page.locator('#l-ready').tap();
  await waitFor(host.page, () => window.__game.net.room.participants.filter((p) => p.ready).length === 0);
  c.ok('Ready and unready are shown to everyone', true);
  // host changes the track: others' ready clears
  await host.page.click('[data-ntrack="circuit-2"]');
  await waitFor(desk.page, () => window.__game.net.room.settings.track === 'circuit-2');
  c.ok('The host changes the track; every lobby shows it', true);
  for (const s of [phone, tablet]) await s.page.locator('#l-ready').tap();
  await desk.page.click('#l-ready');
  await waitFor(host.page, () => window.__game.net.room.participants.filter((p) => p.ready).length === 3);
  await host.page.click('#l-start');
  for (const s of all) await waitFor(s.page, () => window.__game.screen === 'race' && window.__game.net.raceId);
  for (const s of all) await waitFor(s.page, () => document.querySelector('#h-stand .me'), undefined, 20000).catch(() => null);
  await sleep(2000);
  const ids = await Promise.all(all.map(async (s) => read(s.page, () => { const g = window.__game, p = g.race.car(g.localId); return { me: g.localId, slot: p.idx, num: p.num, bay: p.bayHome, hudYou: document.querySelector('#h-stand .me')?.textContent ?? '', mine: g.bays.filter((b) => b.mine).length, mineNum: g.bays.find((b) => b.mine)?.num, camToCar: +Math.hypot(g.camTarget.x - p.x, -g.camTarget.z - p.y).toFixed(1) }; })));
  c.ok('Four browsers race: each follows its own driver ID and slot (nonzero slots included): HUD row "YOU", camera on its car, own bay painted with its number', new Set(ids.map((x) => x.me)).size === 4 && new Set(ids.map((x) => x.slot)).size === 4 && ids.filter((x) => x.slot > 0).length === 3 && ids.every((x) => x.hudYou.includes(str('hud.you')) && x.mine === 1 && x.mineNum === x.num && x.camToCar < 10), ids);
  const lateJoin = await openPage(run, url, 'laptop', { name: 'late', fpsCap: CAP });
  await joinRoom(lateJoin, 'Late', code);
  await waitFor(lateJoin.page, () => document.getElementById('n-msg').textContent.startsWith('That race'));
  c.ok('Join after the start is refused: the starting roster is locked', true);
  await lateJoin.context.close();
  // simultaneous distinct inputs: every seat's held pedals on the server match its own browser, never another's
  const samples = { match: 0, total: 0, distinct: 0 };
  const sampler = setInterval(async () => {
    try {
      const room = run.fast.room(code);
      if (!room || !room.race) return;
      const srv = Object.fromEntries(room.parts.map((p) => [p.id, `${+p.held.up}${+p.held.down}`]));
      const local = await Promise.all(all.map((s) => read(s.page, () => { const n = window.__game.net; return n && [n.me, `${+n.held.up}${+n.held.down}`]; })));
      samples.total++;
      if (local.every((l) => l && srv[l[0]] === l[1])) samples.match++;
      if (new Set(Object.values(srv)).size > 1) samples.distinct++;
    } catch { /* page busy */ }
  }, 700);
  const fin = await driveAll(all, done, 6 * 60000);
  clearInterval(sampler);
  c.ok('Distinct simultaneous inputs: each seat\'s server-side pedals match that browser (sampled), and seats differ', samples.total > 10 && samples.match / samples.total > 0.8 && samples.distinct > 3, samples);
  c.ok('4-player race: every browser drove to its own finish', fin.every((x) => !x.error), fin);
  for (const s of all) await waitFor(s.page, () => window.__game.screen === 'netres', undefined, 150000);
  const res = await Promise.all(all.map((s) => read(s.page, () => ({ digest: window.__game.net.result.digest, rows: [...document.querySelectorAll('.netres tbody tr')].map((r) => r.dataset.status + ':' + r.children[0].textContent), table: document.querySelector('.netres tbody').textContent.replace(/You/g, '') }))));
  c.ok('4-player race: every browser shows the same final server standings', new Set(res.map((r) => r.digest)).size === 1 && res[0].rows.length === 4, res.map((r) => r.rows));
  run.evidence.race4 = res[0].rows;
  await snapshotOf(phone.page, 'results-phone-portrait.png');
  // reopen results: the same result again is not fresh and records nothing
  const before = await read(host.page, () => JSON.stringify(Object.entries(localStorage).filter(([k]) => k.startsWith('srgp.board') || k === 'srgp.champ')));
  // rematch: same room, same people
  const pids = await Promise.all(all.map((s) => read(s.page, () => window.__game.net.me)));
  await host.page.click('#r-rematch');
  for (const s of all) await waitFor(s.page, () => window.__game.screen === 'lobby');
  const again = await Promise.all(all.map((s) => read(s.page, () => ({ me: window.__game.net.me, code: window.__game.net.room.code }))));
  c.ok('Rematch returns everyone to the same room with the same participant IDs', again.every((a, i) => a.me === pids[i] && a.code === code), again);
  const after = await read(host.page, () => JSON.stringify(Object.entries(localStorage).filter(([k]) => k.startsWith('srgp.board') || k === 'srgp.champ')));
  c.ok('No local leaderboard or championship entry was created by the online race', before === after && after === '[]', after);
  // the creator leaves in the lobby: host passes on
  await host.page.click('#l-leave');
  await waitFor(host.page, () => window.__game.screen === 'title' && window.__game.net === null);
  await waitFor(phone.page, () => window.__game.net.room.participants.length === 3);
  const newHost = await read(phone.page, () => ({ host: window.__game.net.room.hostId === window.__game.net.me, start: !!document.getElementById('l-start') }));
  c.ok('Creator leaves the lobby: hosting passes to the earliest remaining driver, who gets Start', newHost.host && newHost.start, newHost);
  const three = [phone, tablet, desk];
  await tablet.page.locator('#l-ready').tap(); await desk.page.click('#l-ready');
  await waitFor(phone.page, () => window.__game.net.room.participants.filter((p) => p.ready).length === 2);
  await phone.page.locator('#l-start').tap();
  for (const s of three) await waitFor(s.page, () => window.__game.screen === 'race');
  const fin3 = await driveAll(three, done, 6 * 60000);
  for (const s of three) await waitFor(s.page, () => window.__game.screen === 'netres', undefined, 150000);
  const res3 = await Promise.all(three.map((s) => read(s.page, () => window.__game.net.result)));
  c.ok('3-player race (touch host): completed with identical standings everywhere', fin3.every((x) => !x.error) && new Set(res3.map((r) => r.digest)).size === 1 && res3[0].classification.length === 3, res3[0].classification.map((x) => `${x.pos}:${x.status}`));
  run.evidence.race3 = res3[0].classification.map((x) => `${x.pos ?? '-'}:${x.status}${x.dnfReason ? '/' + x.dnfReason : ''}`);
  // a guest leaves at results; 2 remain for the 2-player race
  await desk.page.click('#r-leave');
  await waitFor(phone.page, () => window.__game.net.room.participants.length === 2);
  await phone.page.locator('#r-rematch').tap();
  for (const s of [phone, tablet]) await waitFor(s.page, () => window.__game.screen === 'lobby');
  await tablet.page.locator('#l-ready').tap();
  await waitFor(phone.page, () => window.__game.net.room.participants.every((p) => p.ready || p.host));
  await phone.page.locator('#l-start').tap();
  for (const s of [phone, tablet]) await waitFor(s.page, () => window.__game.screen === 'race');
  // the winner's finish must not stop the other: tablet drives slower, phone finishes first
  const [fa, fb] = await Promise.all([driveUntil(phone, done, { budgetMs: 6 * 60000, opts: { pace: PACE } }).catch((e) => ({ error: String(e) })), (async () => { await sleep(4000); return driveUntil(tablet, done, { budgetMs: 6 * 60000, opts: { pace: PACE * 0.9 } }).catch((e) => ({ error: String(e) })); })()]);
  const mid = await read(tablet.page, () => window.__game.screen);
  for (const s of [phone, tablet]) await waitFor(s.page, () => window.__game.screen === 'netres', undefined, 150000).catch(async (e) => { throw new Error(`${e.message} ${JSON.stringify({ fa, fb, mid, now: await Promise.all([phone, tablet].map((x) => read(x.page, () => ({ screen: window.__game.screen, net: window.__game.net && { conn: window.__game.net.conn, state: window.__game.net.room?.state }, phase: window.__game.race.phase, cars: window.__game.race.cars.map((c) => c.status) })))) })}`); });
  const res2 = await Promise.all([phone, tablet].map((s) => read(s.page, () => window.__game.net.result)));
  c.ok('2-player race: completed; identical standings on both', !fa.error && !fb.error && res2[0].digest === res2[1].digest && res2[0].classification.length === 2, res2[0].classification.map((x) => `${x.pos}:${x.status}`));
  run.evidence.race2 = res2[0].classification.map((x) => `${x.pos ?? '-'}:${x.status}${x.dnfReason ? '/' + x.dnfReason : ''}`);
  void mid;
  for (const s of [phone, tablet]) { const b = s.page.locator('#r-leave'); if (await b.count()) await b.tap(); }
  return [host, phone, tablet, desk];
}

/** One representative race: queue at the box, automatic stop-and-go, own-bay refuelling with a fresh Throttle, override and Defer, final-lap DQ. */
async function service(run, c) {
  const url = run.realUrl;   // real time: scripted drivers keep up with the AI and finish inside the window
  const a = await openPage(run, url, 'small', { name: 'keys', fpsCap: CAP });
  const b = await openPage(run, url, 'phoneLandLo', { touch: true, name: 'touch', fpsCap: CAP });
  const code = await createRoom(a, 'Keys', { ai: true });
  await joinRoom(b, 'Touch', code);
  await waitFor(b.page, () => window.__game.screen === 'lobby');
  const aiCount = await read(a.page, () => window.__game.net.room.ai.length);
  c.ok('AI slots configured by the host are listed in the lobby', aiCount === 2, aiCount);
  await b.page.locator('#l-ready').tap();
  await waitFor(a.page, () => window.__game.net.room.participants.every((p) => p.ready || p.host));
  await a.page.click('#l-start');
  for (const s of [a, b]) await waitFor(s.page, () => window.__game.screen === 'race' && window.__game.race.phase === 'racing', undefined, 30000);
  // observe phases on both pages
  for (const s of [a, b]) await read(s.page, () => { const seen = (window.__seen = { sg: [], wait: [], modes: [], bayOwn: null, chips: new Set() }); setInterval(() => { const g = window.__game; if (!g.net) return; const p = g.race.car(g.localId); const last = (arr, v) => { if (v && arr[arr.length - 1] !== v) arr.push(v); }; last(seen.sg, p.sgPhase); last(seen.wait, p.pitWait); last(seen.modes, p.mode); if (p.mode === 'service') seen.bayOwn = p.bay === p.bayHome; for (const ch of document.querySelectorAll('#h-chips .chip')) seen.chips.add(ch.textContent); }, 30); });
  const room = run.real.room(code);
  const [ida, idb] = await Promise.all([a, b].map((s) => read(s.page, () => window.__game.localId)));
  const ai = room.race.cars.find((x) => !x.human);
  const A = room.race.car(ida), B = room.race.car(idb);
  // manual override on the touch driver: ask for a pit stop then override the route at the next switch
  await b.fingers.tap('#t-pit');
  await waitFor(b.page, () => { const g = window.__game; return g.race.car(g.localId).pitReq; });
  await b.fingers.tap('#t-lane');
  await waitFor(b.page, () => { const g = window.__game; return g.race.car(g.localId).laneOverride && document.getElementById('t-lane').dataset.cue === 'override'; }, undefined, 8000).catch(() => null);
  const ov = await read(b.page, () => { const g = window.__game, p = g.race.car(g.localId); return { override: p.laneOverride, route: g.race.nextRoute(p), cue: document.getElementById('t-lane').dataset.cue }; });
  c.ok('Touch: Lane while routed to the pits is a manual override (server state and pad cue)', ov.override && ov.cue === 'override', ov);
  // cancel the optional request again so the debt checks below are clean
  await b.fingers.tap('#t-pit');
  // seed three rear-end offences on the keyboard driver and an AI car at once: both owe a stop-and-go now -> the box queues
  // when an AI car is just ahead of the keyboard driver, both owe a stop-and-go at once: the second must queue for the box
  const T = room.race.T;
  const close = () => room.race.cars.find((x) => !x.human && x.mode === 'race' && T.gapS(T.wrapS(A.u), T.wrapS(x.u)) > 3 && T.gapS(T.wrapS(A.u), T.wrapS(x.u)) < 25 && room.race.apprLap(x) === room.race.apprLap(A));
  const pair = (async () => {
    await waitUntil(() => A.mode === 'race' && T.gapS(T.wrapS(A.u), T.PIT_IN0) > 60 && !!close(), 90000).catch(() => null);
    const q = close() ?? ai;
    for (let k = 0; k < 3; k++) { room.race.offence(A, B, 'rear'); room.race.offence(q, B, 'rear'); }
    return q.id;
  })();
  const both = [a, b];
  // the touch driver gets its stop-and-go just after passing the pit exit, so the next approach is a lap away, then defers it
  const deferTap = (async () => {
    const T = room.race.T;
    await waitUntil(() => B.mode === 'race' && B.lapsDone >= 1 && T.gapS(T.PIT_OUT1, T.wrapS(B.u)) > 5 && T.gapS(T.PIT_OUT1, T.wrapS(B.u)) < 40, 120000);
    for (let k = 0; k < 3; k++) room.race.offence(B, A, 'rear');
    await waitFor(b.page, () => { const g = window.__game, p = g.race.car(g.localId); return p.sgOwed > 0 && g.race.deferBlock(p) === null && !document.getElementById('t-defer').hidden; }, undefined, 20000);
    await b.fingers.tap('#t-defer');
    await waitFor(b.page, () => { const g = window.__game; return g.race.car(g.localId).sgDeferred; }, undefined, 5000);
    return true;
  })().catch((e) => String(e));
  // drive both until each has served its stop-and-go and has completed a fuel stop (back on the road)
  const served = (st) => done(st) || (st.sgOwed === 0 && st.pitStops >= 1 && st.mode === 'race' && st.lap >= 3);
  const r1 = await driveAll(both, served, 5 * 60000, { pace: SPACE });
  const queuedWith = await pair;
  const deferred = await deferTap;
  const seenA = await read(a.page, () => ({ ...window.__seen, chips: [...window.__seen.chips] }));
  const seenB = await read(b.page, () => ({ ...window.__seen, chips: [...window.__seen.chips] }));
  c.ok('Touch: Defer moves the stop-and-go to the next approach (server-side deferral)', deferred === true && seenB.sg.includes('deferred'), { deferred, sg: seenB.sg });
  c.ok('Automatic stop-and-go served for the keyboard driver (entry, serving, leaving) with no key needed', seenA.sg.join().includes('entry,serving,leaving') || seenA.sg.join().includes('queued,entry,serving,leaving'), { sg: seenA.sg, owedNow: A.sgOwed, offencesNow: A.offences, note: 'later stops come from real contacts by the scripted drivers' });
  const queued = [...seenA.sg, ...seenA.wait, ...seenB.sg, ...seenB.wait].some((x) => x === 'queued' || x === 'bay' || x === 'bayWait' || x === 'exit');
  c.ok('Shared pit queue: a driver waited for the box, a bay or the exit (seen in the HUD state)', queued, { queuedWith, a: seenA.wait, b: seenB.wait, sgA: seenA.sg, sgB: seenB.sg });
  c.ok('Own-bay refuelling: service in the driver\'s own bay, then a fresh Throttle press releases the car', [seenA, seenB].some((x) => x.bayOwn && (x.sg.includes('ready') || x.sg.includes('release')) && x.modes.includes('bayOut')), { a: [seenA.sg, seenA.modes], b: [seenB.sg, seenB.modes] });
  run.evidence.service = { aSg: seenA.sg, bSg: seenB.sg, aWait: seenA.wait, bWait: seenB.wait, r1 };
  // DQ and DNF in the shared standings. The scripted drivers are too slow on SwiftShader to reach lap 13 inside the AI's finish
  // window, so the final-lap DQ itself is checked headlessly (test/server/netsession.test.ts). Here: the touch driver owes a stop
  // with a latched breach and is retired by the server (DQ deadline: leaving never escapes a DQ), the keyboard driver retires
  // (DNF), and the AI field runs on to the flag; both browsers must show the same server standings with DQ and DNF spelled out.
  for (let k = 0; k < 3; k++) room.race.offence(B, A, 'rear');
  B.svcBreach = 'stopGo';
  room.race.retire(idb);
  const dqSeen = await waitFor(b.page, () => window.__game.screen === 'netwait' && document.querySelector('.netwait .place')?.textContent, undefined, 15000).then((h) => h.jsonValue()).catch(() => '');
  // the pending card is updated by every snapshot: its buttons must stay the same elements, and keep the keyboard focus
  const kept = await read(b.page, async () => {
    const watch = document.getElementById('w-watch'), leave = document.getElementById('w-leave');
    leave?.focus();
    const tick0 = window.__game.net.tick;
    await new Promise((r) => setTimeout(r, 1500));
    return { snaps: window.__game.net.tick - tick0, same: !!watch && watch.isConnected && document.getElementById('w-watch') === watch && document.getElementById('w-leave') === leave, focus: document.activeElement?.id ?? '' };
  });
  c.ok('Pending card: Watch and Leave stay mounted and keep focus while snapshots update the standings', kept.snaps > 5 && kept.same && kept.focus === 'w-leave', kept);
  room.race.retire(ida);
  for (const s of both) await waitFor(s.page, () => window.__game.screen === 'netres', undefined, 150000);
  const res = await Promise.all(both.map((s) => read(s.page, () => ({ r: window.__game.net.result, rows: [...document.querySelectorAll('.netres tbody tr')].map((x) => `${x.dataset.status}|${x.children[2].textContent}|${x.children[5].textContent}`) }))));
  const rowB = res[0].r.classification.find((x) => x.id === idb), rowA = res[0].r.classification.find((x) => x.id === ida);
  c.ok('DQ and DNF are explicit in the pending card and the final standings, identical on both browsers', dqSeen.startsWith(STRINGS['res.youDq']) && rowB.status === 'dq' && rowA.status === 'dnf' && res[0].r.digest === res[1].r.digest && JSON.stringify(res[0].rows) === JSON.stringify(res[1].rows.map((r) => r)) && res[0].rows.some((r) => r.startsWith('dq|DQ')) && res[0].rows.some((r) => r.startsWith('dnf|DNF')), { dqSeen, rows: res[0].rows });
  run.evidence.serviceResult = res[0].r.classification.map((x) => `${x.pos ?? '-'}:${x.status}${x.dqReason ? '/' + x.dqReason : ''}${x.dnfReason ? '/' + x.dnfReason : ''}`);
  await snapshotOf(b.page, 'results-phone-landscape-dq.png');
  return [a, b];
}

/** Real time through the latency proxy: responsiveness and snapshots, reverse, focus/background, disconnects, reload and expiry. */
async function connection(run, c) {
  const url = run.realUrl;
  const P = run.proxy.ctl;
  // ---- the protocol path alone (no rendering): a headless client with the browser's client module, through the same proxy
  const proto = async (label) => {
    const cl = new run.qa.OnlineClient(`ws://127.0.0.1:${run.proxy.port}/ws`, run.qa.WebSocket, { headers: { origin: 'http://localhost:4182' } });
    await cl.connect();
    const j = await cl.request({ t: 'create', name: 'Probe', mode: 'solo', settings: { track: 'circuit-1' } });
    cl.send({ t: 'start' });
    let snap = null;
    cl.onMessage = (m) => { if (m.t === 'state') snap = m.snap; };
    await waitUntil(() => snap && snap.phase === 'racing', 20000);
    cl.startHeartbeat();
    const out = [];
    for (let k = 0; k < 15; k++) {
      const t0 = performance.now();
      cl.setHeld(false, true);
      await waitUntil(() => snap.cars.find((c) => c.id === j.you).brake > 0, 3000);
      out.push(performance.now() - t0);
      cl.setHeld(false, false);
      await waitUntil(() => snap.cars.find((c) => c.id === j.you).brake === 0, 3000);
      await sleep(120);
    }
    cl.send({ t: 'leave' }); cl.close();
    const v = out.sort((x, y) => x - y);
    const r = { label, n: v.length, medianMs: +v[Math.floor(v.length / 2)].toFixed(1), p90Ms: +v[Math.floor(v.length * 0.9)].toFixed(1), maxMs: +v.at(-1).toFixed(1) };
    run.evidence.protocolLatency = [...(run.evidence.protocolLatency ?? []), r];
    return r;
  };
  const pl0 = await proto('loopback');
  c.ok('Protocol path, loopback: press -> server step -> next 20 Hz snapshot (headless client, no rendering)', pl0.medianMs < 120, pl0);
  P.delayMs = 60; P.jitterMs = 30;
  const pl1 = await proto('+60 ms each way, 0-30 ms jitter');
  c.ok('Protocol path, induced latency: confirmation grows by about the added round trip only', pl1.medianMs < pl0.medianMs + 220, pl1);
  P.delayMs = 0; P.jitterMs = 0;
  const a = await openPage(run, url, 'small', { name: 'keys' });
  const code = await createRoom(a, 'Keys');
  await joinRoom(b, 'Phone', code);
  await waitFor(b.page, () => window.__game.screen === 'lobby');
  await b.page.locator('#l-ready').tap();
  await waitFor(a.page, () => window.__game.net.room.participants.every((p) => p.ready || p.host));
  await a.page.click('#l-start');
  for (const s of [a, b]) await waitFor(s.page, () => window.__game.screen === 'race' && window.__game.race.phase === 'racing', undefined, 30000);
  const room = run.real.room(code);
  const [ida, idb] = await Promise.all([a, b].map((s) => read(s.page, () => window.__game.localId)));
  const A = room.race.car(ida), B = room.race.car(idb);
  const seat = (id) => room.parts.find((p) => p.id === id);

  // ---- responsiveness: press-to-drawn time and snapshot buffer, ordinary then induced latency, then a stall
  const measure = async (label) => {
    await read(a.page, () => { window.__lat.net = []; window.__lat.drawn = []; });
    const t0 = await read(a.page, () => ({ ...window.__game.net.buf }));
    const w0 = Date.now();
    for (let k = 0; k < 8; k++) {
      await driveFor(a, 1200);
      await a.keys.release();
      await waitFor(a.page, () => window.__game.race.car(window.__game.localId).brake === 0, undefined, 3000).catch(() => null);
      await read(a.page, () => { window.__lat.arm = true; });
      await a.page.keyboard.down('KeyS'); await sleep(350); await a.page.keyboard.up('KeyS');
      await sleep(250);
    }
    const r = await read(a.page, () => ({ net: window.__lat.net, drawn: window.__lat.drawn, buf: { ...window.__game.net.buf }, lag: window.__game.net.lagMs }));
    const stat = (xs) => { const v = [...xs].sort((x, y) => x - y); const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null); return { n: v.length, median: q(0.5), p90: q(0.9), max: v.at(-1) ?? null }; };
    const frames = r.buf.frames - t0.frames, wall = (Date.now() - w0) / 1000;
    const out = { label, toServerState: stat(r.net), toDrawnFrame: stat(r.drawn), fps: +(frames / wall).toFixed(1), starvedFrames: r.buf.starved - t0.starved, frames, reanchors: r.buf.reanchors - t0.reanchors, maxGapMs: Math.round(r.buf.maxGapMs), depth: r.buf.depth, staleSnaps: r.buf.stale - t0.stale };
    run.evidence.latency = [...(run.evidence.latency ?? []), out];
    return out;
  };
  const driveFor = (s, ms) => { const end = Date.now() + ms; return driveUntil(s, (st) => Date.now() > end || done(st), { budgetMs: ms + 5000, opts: { pace: PACE } }); };
  const m0 = await measure('loopback (no added delay)');
  c.ok('Browser, loopback: Brake press -> server state -> drawn frame recorded (SwiftShader frame rate shown; diagnostic)', m0.toServerState.n >= 4 && m0.staleSnaps === 0, m0);
  P.delayMs = 60; P.jitterMs = 30;
  const m1 = await measure('+60 ms each way, 0-30 ms jitter');
  c.ok('Browser, +60 ms/0-30 ms jitter: presses confirmed, buffer bounded, no stale snapshot applied (diagnostic)', m1.toServerState.n >= 4 && m1.depth <= 24 && m1.staleSnaps === 0, m1);
  P.delayMs = 0; P.jitterMs = 0;
  const rt0 = A.raceTime ?? room.race.raceTime;
  const laps0 = await read(a.page, () => window.__game.race.car(window.__game.localId).lapsDone);
  const evBefore = await read(a.page, () => window.__game.net.buf.reanchors);
  P.stallUntil = Date.now() + 1500;
  await sleep(2500);
  const st = await read(a.page, () => ({ buf: { ...window.__game.net.buf }, laps: window.__game.race.car(window.__game.localId).lapsDone, conn: window.__game.net.conn }));
  const stall = { serverAdvancedS: +(room.race.raceTime - rt0).toFixed(2), maxGapMs: st.buf.maxGapMs, reanchors: st.buf.reanchors - evBefore, lapsBefore: laps0, lapsAfter: st.laps, conn: st.conn };
  run.evidence.stall = stall;
  c.ok('1.5 s stall: the shared race keeps running on the server, the client holds then re-anchors, no lap replayed', stall.serverAdvancedS > 2 && stall.maxGapMs >= 1400 && stall.conn === 'connected' && st.laps >= laps0 && st.laps <= laps0 + 1, stall);
  await a.keys.release();

  // ---- deliberate reverse (keyboard): stop, keep holding Brake
  await a.page.keyboard.down('KeyS');
  await waitFor(a.page, () => { const g = window.__game, p = g.race.car(g.localId); return p.revOn && p.v < -0.2; }, undefined, 6000).catch(() => null);
  const rev = await read(a.page, () => { const g = window.__game, p = g.race.car(g.localId); return { revOn: p.revOn, v: +p.v.toFixed(2), chips: document.getElementById('h-chips').textContent }; });
  await a.page.keyboard.up('KeyS');
  await sleep(400);
  const revOff = A.revOn;
  c.ok('Deliberate reverse online: holding Brake at a standstill reverses (server state), release ends it', rev.revOn && rev.v < 0 && rev.chips.includes(str('hud.reverse')) && !revOff, rev);

  // ---- menu and lost focus: controls released, server informed, race not paused
  await a.page.keyboard.down('KeyW');
  await waitFor(a.page, () => window.__game.race.car(window.__game.localId).throttle > 0.3, undefined, 3000);
  await a.page.keyboard.press('Escape');
  const t1 = room.race.raceTime;
  await sleep(400);
  const menu = { screen: await read(a.page, () => window.__game.screen), serverHeld: { ...seat(ida).held }, raceAdvanced: +(room.race.raceTime - t1).toFixed(2), title: await a.page.locator('.overlay h2').textContent() };
  c.ok('Menu online: this client\'s Throttle is released on the server at once; the race keeps running', menu.screen === 'pause' && !menu.serverHeld.up && menu.raceAdvanced > 0.3 && menu.title === STRINGS['net.menuTitle'], menu);
  await a.page.click('#o-resume');
  await sleep(500);
  const stale = { held: { ...seat(ida).held }, local: await read(a.page, () => window.__game.input.held('throttle')) };
  c.ok('Returning from the menu does not restore the held key (fresh press needed)', !stale.held.up && !stale.local, stale);
  await a.page.keyboard.up('KeyW');

  // ---- mobile background with a finger on Throttle
  const finger = await b.fingers.put('#t-throttle');
  await waitFor(b.page, () => window.__game.race.car(window.__game.localId).throttle > 0.2, undefined, 3000);
  await read(b.page, () => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const t2 = room.race.raceTime;
  await sleep(500);
  const bg = { screen: await read(b.page, () => window.__game.screen), serverHeld: { ...seat(idb).held }, raceAdvanced: +(room.race.raceTime - t2).toFixed(2) };
  c.ok('Mobile background: controls released and the server told at once; the shared race is not paused', bg.screen === 'pause' && !bg.serverHeld.up && bg.raceAdvanced > 0.3, bg);
  await read(b.page, () => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await b.page.locator('#o-resume').tap();
  await sleep(700);
  const ret = { screen: await read(b.page, () => window.__game.screen), held: { ...seat(idb).held }, local: await read(b.page, () => window.__game.input.held('throttle')) };
  c.ok('Back from background: the finger still on the glass does not count until it presses again', ret.screen === 'race' && !ret.held.up && !ret.local, ret);
  await b.fingers.lift(finger);

  // ---- disconnect while accelerating, then the automatic reconnect
  await a.page.keyboard.down('KeyW');
  await waitFor(a.page, () => window.__game.race.car(window.__game.localId).throttle > 0.3, undefined, 3000);
  const lapsA = A.lapsDone;
  await read(a.page, () => window.__game.netDrop());
  await sleep(120);
  const drop = { held: { ...seat(ida).held }, connected: !!seat(ida).peer };
  drop.banner = await waitFor(a.page, () => document.getElementById('net-banner').textContent, undefined, 3000).then((h) => h.jsonValue()).catch(() => '');
  await waitFor(a.page, () => window.__game.net && window.__game.net.conn === 'connected', undefined, 15000);
  await sleep(500);
  const rec = await read(a.page, () => ({ me: window.__game.net.me, reconnects: window.__game.net.reconnects, held: window.__game.input.held('throttle') }));
  c.ok('Disconnect while accelerating: the server neutralizes that car at once; the banner says reconnecting', !drop.held.up && drop.banner.startsWith(str('net.reconnecting')), drop);
  c.ok('Reconnect restores the same car and progress; the held key needs a fresh press', rec.me === ida && rec.reconnects > 0 && !rec.held && !seat(ida).held.up && A.lapsDone >= lapsA && A.status === 'running', { rec, laps: [lapsA, A.lapsDone] });
  await a.page.keyboard.up('KeyW');

  // ---- reload the phone mid-race: Rejoin from the title within the grace period
  await b.page.reload();
  await waitFor(b.page, () => window.__game && window.__game.screen === 'title');
  await waitOnline(b.page);
  await b.page.locator('#o-rejoin').tap();
  await waitFor(b.page, () => window.__game.screen === 'race' && window.__game.net && window.__game.net.me, undefined, 15000).catch(async (e) => { throw new Error(`${e.message} ${JSON.stringify(await read(b.page, () => ({ screen: window.__game.screen, msg: document.getElementById('n-msg')?.textContent, net: window.__game.net && window.__game.net.conn })))} ${run.real.log.lines.slice(-10).join(' ')}`); });
  c.ok('Page reload: Rejoin from the title resumes the same seat before expiry', (await read(b.page, () => window.__game.localId)) === idb);

  // ---- expiry: the phone cannot reconnect for longer than the grace period
  await b.page.routeWebSocket(/\/ws$/, (ws) => ws.close({ code: 4000, reason: 'blocked' }));
  await read(b.page, () => window.__game.netDrop());
  await waitFor(b.page, () => window.__game.screen === 'online', undefined, (run.real.cfg.graceS + 15) * 1000);
  const exp = await read(b.page, () => ({ msg: document.getElementById('n-msg').textContent, seat: sessionStorage.getItem('srgp.seat') }));
  c.ok('Seat expiry: the phone is told its seat expired and the stored seat is gone', exp.msg === STRINGS['net.end.expired'] && exp.seat === null, exp);
  await b.page.unrouteAll({ behavior: 'ignoreErrors' });
  await b.page.fill('#n-code', code);
  await b.page.locator('#n-join').tap();
  await waitFor(b.page, () => document.getElementById('n-msg').textContent.startsWith('That race'));
  c.ok('An expired seat cannot be re-claimed as a new driver through the UI (join refused: race started)', B.status !== 'running', { status: B.status, reason: B.dnfReason ?? B.dqReason });
  // the creator's car retires on Leave; the room has nobody left racing, so it closes without a result
  await a.page.keyboard.press('Escape');
  await a.page.click('#o-leave');
  await waitFor(a.page, () => window.__game.screen === 'title' && window.__game.net === null);
  c.ok('Leave race from the menu ends this seat and returns to the title', A.status !== 'running', { status: A.status, reason: A.dnfReason });
  return [a, b];
}

/** Menus and race HUD at phone, tablet and desktop sizes, with the online pieces in place. */
async function layout(run, c) {
  const pages = [];
  for (const view of ['phoneNarrow', 'phonePortrait', 'phoneLandscape', 'tablet', 'tabletPortrait', 'desktop']) {
    const s = await openPage(run, run.fastUrl, view, { touch: !!VIEWS[view].hasTouch });
    pages.push(s);
    const { page } = s;
    await waitOnline(page);
    await snapshotOf(page, `title-${view}.png`);
    await page.click('#o-online');
    const menu = await layoutFacts(page);
    await snapshotOf(page, `online-menu-${view}.png`);
    c.ok(`${view}: online menu fits (no sideways scroll); every control is at least 40 px`, menu.fitsWidth && !menu.docScrollX && menu.small.length === 0, menu);
    await page.fill('#n-name', 'Layout');
    await page.click('#n-solo');
    await waitFor(page, () => window.__game.screen === 'lobby');
    const lob = await layoutFacts(page);
    await snapshotOf(page, `lobby-solo-${view}.png`);
    const label = await page.locator('.lobby .lbl2').first().textContent();
    c.ok(`${view}: connected-solo lobby fits and is labelled as connected solo`, lob.fitsWidth && !lob.docScrollX && lob.small.length === 0 && label === STRINGS['net.modeSolo'], { ...lob, label });
    await page.click('#l-start');
    await waitFor(page, () => window.__game.screen === 'race');
    await sleep(800);
    await snapshotOf(page, `race-${view}.png`);
    const hud = await read(page, () => { const r = (id) => document.getElementById(id)?.getBoundingClientRect(); const pad = !document.getElementById('t-pad').hidden; const b = r('t-throttle'); return { pad, throttle: b && { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }, vw: innerWidth, vh: innerHeight, me: window.__game.localId.startsWith('p_') }; });
    c.ok(`${view}: online race HUD follows the server seat; touch pad ${VIEWS[view].hasTouch ? 'shown and on screen' : 'hidden'}`, hud.me && (VIEWS[view].hasTouch ? hud.pad && hud.throttle.right <= hud.vw && hud.throttle.bottom <= hud.vh : !hud.pad), hud);
    if (s.fingers) await s.fingers.tap('#t-pause'); else await page.keyboard.press('Escape');
    await waitFor(page, () => window.__game.screen === 'pause', undefined, 5000).catch(() => null);
    const pm = await layoutFacts(page);
    c.ok(`${view}: race menu fits`, pm.fitsWidth && !pm.docScrollX, pm);
    await page.locator('#o-leave').click();
    await waitFor(page, () => window.__game.screen === 'title');
    await s.context.close();
  }
  return [];
}

const SCENARIOS = { gate, lobby, service, connection, layout };

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}: ${Object.keys(SCENARIOS).join(' ')}`);
  const limit = setTimeout(() => { console.error(`Time limit of ${MAX_MIN} minutes reached.`); process.exit(2); }, MAX_MIN * 60000);
  limit.unref();
  mkdirSync(OUT, { recursive: true });
  console.log('Building the online-enabled client (VITE_ONLINE=1) into dist-online/ …');
  execFileSync('npx', ['vite', 'build', '--outDir', 'dist-online', '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, VITE_ONLINE: '1' }, stdio: 'ignore' });
  const qaFile = path.join(ROOT, '.qa/qa-server.mjs');
  await build({ entryPoints: [path.join(ROOT, 'scripts/qa-server.ts')], outfile: qaFile, bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'warning' });
  const { startQaServer } = await import(pathToFileURL(qaFile).href);
  const origins = ['http://localhost:4181', 'http://localhost:4182', 'http://localhost:4183'];
  const common = { allowedOrigins: origins, maxConnections: 100, maxConnectionsPerIp: 60, msgRate: 120, msgBurst: 200, graceS: 8, roomCap: 20 };
  const fast = await startQaServer({ ...common, timeScale: 2, maxCatchUpSteps: 12 });
  // 40 s grace here (production default 20): a SwiftShader page reload alone can take longer than 20 s on this host
  const real = await startQaServer({ ...common, graceS: 40 });
  const proxy = await latencyProxy(real);
  const dead = 'http://127.0.0.1:9';   // nothing listens: the service is "down"
  const pv = [await startPreview(4181, fast.url), await startPreview(4182, `http://127.0.0.1:${proxy.port}`), await startPreview(4183, dead)];
  const browser = await chromium.launch({ headless: true });
  const run = { contexts: new Set(), qa: await import(pathToFileURL(qaFile).href), browser, fast, real, proxy, fastUrl: pv[0].url, realUrl: pv[1].url, deadUrl: pv[2].url, evidence: {} };
  console.log(`Chromium ${browser.version()}; fast server :${fast.port} (time x2), real-time server :${real.port} behind proxy :${proxy.port}`);
  const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), browser: `chromium ${browser.version()}`, scenarios: [] };
  let failed = false;
  try {
    for (const name of names) {
      console.log(`\n${name}`);
      const c = new Checks();
      const t0 = Date.now();
      let sessions = [];
      try { sessions = await SCENARIOS[name](run, c); } catch (e) { c.ok('Scenario ran to the end', false, String(e.stack ?? e).split('\n').slice(0, 3).join(' | ')); }
      for (const s of sessions) {
        c.ok(`No page errors (${s.name})`, s.errors.length === 0, s.errors.slice(0, 5));
        if (!report.environment) report.environment = await environment({ machine: 'build host', commit: report.commit, revision: null, url: run.fastUrl, browser, headed: false }, s.page).catch(() => null);
        await s.context.close().catch(() => null);
      }
      // a scenario that stopped early must not leave pages rendering into the next one
      for (const ctx of run.contexts) await ctx.close().catch(() => null);
      run.contexts.clear();
      const status = c.list.some((x) => x.status === 'failed') ? 'failed' : 'passed';
      failed ||= status === 'failed';
      report.scenarios.push({ name, status, seconds: Math.round((Date.now() - t0) / 1000), checks: c.list });
      report.evidence = run.evidence;
      writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    }
    console.log('\n| Scenario | Status | Passed | Failed | Seconds |\n| --- | --- | --- | --- | --- |');
    for (const s of report.scenarios) console.log(`| ${s.name} | ${s.status} | ${s.checks.filter((x) => x.status === 'passed').length} | ${s.checks.filter((x) => x.status === 'failed').length} | ${s.seconds} |`);
    console.log(`\nEvidence: ${JSON.stringify(run.evidence)}`);
    console.log(`Report and screenshots: ${OUT}`);
  } finally {
    await browser.close();
    for (const p of pv) await p.close();
    proxy.close();
    await fast.close(); await real.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1); });
