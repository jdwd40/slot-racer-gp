// Resource measurement for a running room server: fills `rooms` rooms with `humans` WebSocket clients each, races them for
// `seconds`, and reports from /api/health the tick work's sample count, p50/p95/p99 and exact max, the tick timer's lateness
// (event-loop delay), CPU (the server's own cpuUsage, or /proc with --pid), RSS/heap and room/client counts. Diagnostics only:
// figures from a shared build host are not a certification of the production VPS.
//   node scripts/load-check.mjs http://127.0.0.1:8787 --rooms 6 --humans 4 --seconds 60 --origin https://slotrush.jdwd40.com --pid 1234
// All its clients share one address, so the server it measures needs SLOTRUSH_MAX_CONNECTIONS_PER_IP >= rooms x humans and
// SLOTRUSH_ROOMS_PER_IP >= rooms for that run (the stock 8 and 3 protect the public service from exactly this, #52).
// Options:
//   --drive       clients drive with the headless test bot (test/server/bot.ts, bundled on the fly) instead of the
//                 throttle on/off rhythm, so they complete the race: human finishes, classification and result envelopes
//   --ai-fill     fill free seats with AI cars (with --humans < 4: humans finish, then the AI run-on and its classification)
//   --until-results  end once every room has its result (still bounded by --seconds)
//   --poll S      seconds between health readings (default 2; must stay under the 50 s the rolling tick window guarantees)
//   --commit SHA  the tested commit to record (default: `git rev-parse HEAD` in the current directory)
// Tick statistics: scripts/tick-report.mjs (and docs/online-server.md, Monitoring).
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { workloadDurations } from './tick-report.mjs';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const ROOMS = Number(opt('--rooms', 6)), HUMANS = Number(opt('--humans', 4)), SECONDS = Number(opt('--seconds', 60));
const POLL_S = Number(opt('--poll', 2));
const ORIGIN = opt('--origin', 'http://localhost:5173');
const PID = opt('--pid', null);
const DRIVE = flag('--drive'), AI_FILL = flag('--ai-fill'), UNTIL_RESULTS = flag('--until-results');
if (!(POLL_S > 0 && POLL_S < 50)) { console.error('--poll must be between 0 and 50 s (the rolling tick window keeps samples for at least 50 s)'); process.exit(2); }
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let drive = null;
if (DRIVE) {
  // the same bot the server tests drive with, built like online-check.mjs builds its QA server (test tooling, never shipped)
  const { build } = await import('esbuild');
  const out = path.join(ROOT, '.qa/load-bot.mjs');
  await build({ entryPoints: [path.join(ROOT, 'test/server/bot.ts')], outfile: out, bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'warning' });
  ({ drive } = await import(pathToFileURL(out).href));
}

function client() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { headers: { origin: ORIGIN } });
    const c = { ws, msgs: 0, bytes: 0, waiters: [], seq: 0, act: 0, me: null, held: { up: false, down: false }, results: 0, pace: 1 };
    ws.on('message', (d) => {
      c.msgs++; c.bytes += d.length;
      const m = JSON.parse(String(d));
      if (m.t === 'joined') c.me = m.you;
      if (m.t === 'result') c.results++;
      if (drive && m.t === 'state' && c.me && ws.readyState === WebSocket.OPEN) {
        const o = drive(m.snap, c.me, c.pace);
        if (o.up !== c.held.up || o.down !== c.held.down) { c.held = { up: o.up, down: o.down }; send(c, { t: 'ctl', seq: ++c.seq, ...c.held }); }
        if (o.pit) send(c, { t: 'act', seq: ++c.act, type: 'pit' });
      }
      for (const w of [...c.waiters]) if (w.p(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.r(m); }
    });
    ws.on('open', () => res(c));
    ws.on('error', rej);
  });
}
const wait = (c, p) => new Promise((r) => c.waiters.push({ p, r }));
const send = (c, m) => { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)); };
const cpuTicks = () => { if (!PID) return null; const f = readFileSync(`/proc/${PID}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
const health = () => fetch(`${base}/api/health`).then((r) => r.json());
const tryRun = (f) => { try { return f(); } catch { return null; } };
const serverRuntime = PID ? tryRun(() => execFileSync(readlinkSync(`/proc/${PID}/exe`), ['--version'], { encoding: 'utf8' }).trim()) : null;
const commit = opt('--commit', null) ?? tryRun(() => execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());

const all = [], hosts = [];
for (let r = 0; r < ROOMS; r++) {
  const host = await client(); all.push(host); hosts.push(host);
  send(host, { t: 'hello', v: 1, proto: 'slotrush' }); await wait(host, (m) => m.t === 'welcome');
  send(host, { t: 'create', name: `Load${r}`, mode: 'multiplayer', settings: { track: `circuit-${(r % 5) + 1}`, aiFill: AI_FILL } });
  const j = await wait(host, (m) => m.t === 'joined' || m.t === 'nack');
  if (j.t !== 'joined') { console.error('create refused', j, j.code === 'unavailable' || j.code === 'rate' ? '(one-address load: start the server with SLOTRUSH_ROOMS_PER_IP >= --rooms, see the header)' : ''); process.exit(1); }
  const cs = [host];
  for (let k = 1; k < HUMANS; k++) {
    const c = await client(); all.push(c); cs.push(c);
    c.pace = 1 - k * 0.03;
    send(c, { t: 'hello', v: 1, proto: 'slotrush' }); await wait(c, (m) => m.t === 'welcome');
    send(c, { t: 'join', code: j.room.code, name: `L${r}-${k}` }); await wait(c, (m) => m.t === 'joined');
    send(c, { t: 'ready', ready: true });
  }
  await new Promise((res) => setTimeout(res, 100));
  send(host, { t: 'start' });
}
const t0 = Date.now(), c0 = cpuTicks();
const h0 = await health();
const polls = [];
let rssMax = h0.rssMb;
const timer = setInterval(() => {
  if (DRIVE) { for (const c of all) send(c, { t: 'ctl', seq: ++c.seq, ...c.held }); return; }   // heartbeat at the held pedals
  // every client: Throttle on/off in a 1.2 s rhythm (cars circulate, de-slot, recover) with a 100 ms heartbeat
  const ph = ((Date.now() - t0) % 1200) < 800; for (const c of all) send(c, { t: 'ctl', seq: ++c.seq, up: ph, down: false });
}, 100);
const done = () => UNTIL_RESULTS && hosts.every((h) => h.results > 0);
while (Date.now() - t0 < SECONDS * 1000 && !done()) {
  const until = Math.min(t0 + SECONDS * 1000, Date.now() + POLL_S * 1000);
  while (Date.now() < until && !done()) await new Promise((r) => setTimeout(r, 100));
  const h = await health(); polls.push(h); rssMax = Math.max(rssMax, h.rssMb);
}
clearInterval(timer);
const h1 = await health();
const secs = (Date.now() - t0) / 1000, c1 = cpuTicks();
const msgs = all.reduce((n, c) => n + c.msgs, 0), bytes = all.reduce((n, c) => n + c.bytes, 0);
const cpuMs = (h) => (h.cpuUserMs ?? NaN) + (h.cpuSystemMs ?? NaN);
const ticks = workloadDurations('ticks', h0, polls, h1);
console.log(JSON.stringify({
  commit, serverVersion: h1.version, serverRuntime, clientRuntime: process.version,
  rooms: ROOMS, humansPerRoom: HUMANS, aiFill: AI_FILL, drive: DRIVE, seconds: Math.round(secs * 10) / 10, pollS: POLL_S, polls: polls.length + 1,
  roomsAtEnd: h1.rooms, roomsRacing: h1.racing, connections: h1.connections, humans: h1.humans,
  roomsWithResult: hosts.filter((h) => h.results > 0).length,
  rssStartMb: h0.rssMb, rssMaxMb: Math.max(rssMax, h1.rssMb), heapMb: h1.heapMb,
  cpuPercent: c0 === null ? null : Math.round(((c1 - c0) / 100 / secs) * 1000) / 10,
  serverCpuPercent: Number.isFinite(cpuMs(h0)) ? Math.round(((cpuMs(h1) - cpuMs(h0)) / 10 / secs) * 10) / 10 : null,
  // tick work per 10 ms tick, and the tick timer's lateness (event-loop delay): exact max, histogram percentiles
  ticks, tickLag: workloadDurations('tickLag', h0, polls, h1),
  // the old field, kept so runs stay comparable with earlier reports: the largest exact max seen (never the decayed value)
  worstTickMs: ticks ? ticks.maxMs : Math.max(0, ...polls.map((h) => h.tickMaxMs)),
  perClientMsgPerS: Math.round(msgs / all.length / secs), perClientKBps: Math.round(bytes / all.length / secs / 1024),
}));
for (const c of all) c.ws.close();
process.exit(0);
