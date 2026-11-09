// Health and connection check for a running room server. Exits non-zero on any failure. Used locally and as the production
// activation gate (docs/online-server.md):
//   node scripts/server-smoke.mjs http://127.0.0.1:8787 [--origin https://slotrush.jdwd40.com] [--expect server-dist/protocol.json]
// Checks: /api/health ok, /api/version protocol equals the build's, a WebSocket hello, a server-hosted solo race starts and
// streams state, a bad origin and a protocol mismatch are refused. Never prints tokens.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const origin = opt('--origin', 'http://localhost:5173');
const expectFile = opt('--expect', 'server-dist/protocol.json');
let expected = null;
try { expected = JSON.parse(readFileSync(expectFile, 'utf8')); } catch { /* checked below */ }

let failed = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); if (!cond) failed++; };
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

function open(org = origin) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { headers: { origin: org }, handshakeTimeout: 5000 });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.on('open', () => res({ ws, msgs }));
    ws.on('error', rej);
    ws.on('unexpected-response', (_req, r) => rej(new Error(`http ${r.statusCode}`)));
  });
}
const until = async (msgs, pred, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); }
  return null;
};

try {
  const h = await fetch(`${base}/api/health`).then(async (r) => ({ status: r.status, body: await r.json() }));
  ok('health', h.status === 200 && h.body.ok === true, `status ${h.status} db=${h.body.db} rooms=${h.body.rooms}/${h.body.roomCap} rss=${h.body.rssMb}MB`);
  const v = await fetch(`${base}/api/version`).then((r) => r.json());
  ok('build metadata found', !!expected, expectFile);
  if (expected) ok('protocol compatible', v.protocol === expected.protocol && v.rules === expected.rules, `server ${v.protocol}/${v.rules} vs build ${expected.protocol}/${expected.rules}`);

  const bad = await open('https://evil.example').then(() => 'opened', (e) => e.message);
  ok('foreign origin refused', bad === 'http 403', bad);

  const mm = await open();
  mm.ws.send(JSON.stringify({ t: 'hello', v: 999, proto: 'slotrush' }));
  const refuse = await until(mm.msgs, (m) => m.t === 'nack' && m.code === 'protocol');
  ok('protocol mismatch refused', !!refuse);
  mm.ws.close();

  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello', v: expected?.protocol ?? 1, proto: 'slotrush' }));
  ok('hello/welcome', !!(await until(c.msgs, (m) => m.t === 'welcome')));
  c.ws.send(JSON.stringify({ t: 'create', name: 'Smoke', mode: 'solo', settings: { track: 'circuit-1' } }));
  const j = await until(c.msgs, (m) => m.t === 'joined' || m.t === 'nack');
  ok('solo room created', j?.t === 'joined', j?.t === 'nack' ? j.code : `room ${j?.room?.code}`);
  if (j?.t === 'joined') {
    c.ws.send(JSON.stringify({ t: 'start' }));
    const st = await until(c.msgs, (m) => m.t === 'state' && m.snap?.cars?.length === 4);
    ok('race state streams', !!st, st ? `track ${st.snap.track}, ${st.snap.cars.length} cars` : '');
    c.ws.send(JSON.stringify({ t: 'leave' }));
    ok('left cleanly', !!(await until(c.msgs, (m) => m.t === 'bye' && m.code === 'left')));
  }
  c.ws.close();
} catch (e) {
  ok('reachable', false, String(e?.message ?? e));
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
