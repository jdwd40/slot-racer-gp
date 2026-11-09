// Resource measurement for a running room server: fills `rooms` rooms with `humans` WebSocket clients each, races them for
// `seconds`, and samples the server's RSS (from /api/health) and, with --pid, its CPU use from /proc. Diagnostics only.
//   node scripts/load-check.mjs http://127.0.0.1:8787 --rooms 6 --humans 4 --seconds 60 --origin https://slotrush.jdwd40.com --pid 1234
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOMS = Number(opt('--rooms', 6)), HUMANS = Number(opt('--humans', 4)), SECONDS = Number(opt('--seconds', 60));
const ORIGIN = opt('--origin', 'http://localhost:5173');
const PID = opt('--pid', null);
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

function client() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { headers: { origin: ORIGIN } });
    const c = { ws, msgs: 0, bytes: 0, waiters: [], seq: 0, me: null, room: null };
    ws.on('message', (d) => {
      c.msgs++; c.bytes += d.length;
      const m = JSON.parse(String(d));
      for (const w of [...c.waiters]) if (w.p(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.r(m); }
    });
    ws.on('open', () => res(c));
    ws.on('error', rej);
  });
}
const wait = (c, p) => new Promise((r) => c.waiters.push({ p, r }));
const send = (c, m) => c.ws.send(JSON.stringify(m));
const cpuTicks = () => { if (!PID) return null; const f = readFileSync(`/proc/${PID}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
const health = () => fetch(`${base}/api/health`).then((r) => r.json());

const all = [];
for (let r = 0; r < ROOMS; r++) {
  const host = await client(); all.push(host);
  send(host, { t: 'hello', v: 1, proto: 'slotrush' }); await wait(host, (m) => m.t === 'welcome');
  send(host, { t: 'create', name: `Load${r}`, mode: 'multiplayer', settings: { track: `circuit-${(r % 5) + 1}` } });
  const j = await wait(host, (m) => m.t === 'joined' || m.t === 'nack');
  if (j.t !== 'joined') { console.error('create refused', j); process.exit(1); }
  const cs = [host];
  for (let k = 1; k < HUMANS; k++) {
    const c = await client(); all.push(c); cs.push(c);
    send(c, { t: 'hello', v: 1, proto: 'slotrush' }); await wait(c, (m) => m.t === 'welcome');
    send(c, { t: 'join', code: j.room.code, name: `L${r}-${k}` }); await wait(c, (m) => m.t === 'joined');
    send(c, { t: 'ready', ready: true });
  }
  await new Promise((res) => setTimeout(res, 100));
  send(host, { t: 'start' });
}
const t0 = Date.now(), c0 = cpuTicks();
const h0 = await health();
let rssMax = h0.rssMb, tickMax = 0;
// every client: Throttle on/off in a 1.2 s rhythm (cars circulate, de-slot, recover) with a 100 ms heartbeat
const timer = setInterval(() => { const ph = ((Date.now() - t0) % 1200) < 800; for (const c of all) send(c, { t: 'ctl', seq: ++c.seq, up: ph, down: false }); }, 100);
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await health(); rssMax = Math.max(rssMax, h.rssMb); tickMax = Math.max(tickMax, h.tickMaxMs);
}
clearInterval(timer);
const h1 = await health();
const secs = (Date.now() - t0) / 1000, c1 = cpuTicks();
const msgs = all.reduce((n, c) => n + c.msgs, 0), bytes = all.reduce((n, c) => n + c.bytes, 0);
console.log(JSON.stringify({
  rooms: ROOMS, humansPerRoom: HUMANS, seconds: Math.round(secs), roomsRacing: h1.racing, connections: h1.connections,
  rssStartMb: h0.rssMb, rssMaxMb: rssMax, heapMb: h1.heapMb, worstTickMs: tickMax,
  cpuPercent: c0 === null ? null : Math.round(((c1 - c0) / 100 / secs) * 1000) / 10,
  perClientMsgPerS: Math.round(msgs / all.length / secs), perClientKBps: Math.round(bytes / all.length / secs / 1024),
}));
for (const c of all) c.ws.close();
process.exit(0);
