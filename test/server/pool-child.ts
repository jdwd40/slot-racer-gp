// Child process for test/server/dbpool.test.ts (#48). A minimal PostgreSQL-wire peer accepts real pg connections from the
// production createPool and then drops them: while idle in the pool, while checked out, and with a query in flight. Before
// the fix the first drop was an unhandled pool 'error' event and Node exited with status 1. Prints one JSON summary line.
import net from 'node:net';
import { createPool } from '../../server/db';
import { createLogger } from '../../server/log';

const PASSWORD = process.argv[2] ?? 'pool-child-pw';
const sockets = new Set<net.Socket>();
let hang = false;   // when set, queries get no reply (an in-flight query when the socket drops)
let opened = 0;

// AuthenticationOk + ReadyForQuery('I'), then EmptyQueryResponse + ReadyForQuery for every simple query
const READY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
const EMPTY = Buffer.from([0x49, 0, 0, 0, 4, 0x5a, 0, 0, 0, 5, 0x49]);
const peer = net.createServer((s) => {
  opened++;
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
  s.on('error', () => undefined);
  let buf = Buffer.alloc(0);
  let started = false;
  s.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0)); started = true; s.write(READY); continue;
      }
      if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
      const type = String.fromCharCode(buf[0]);
      buf = buf.subarray(1 + buf.readInt32BE(1));
      if (type === 'Q' && !hang) s.write(EMPTY);
      if (type === 'X') s.end();
    }
  });
});
const dropAll = (): void => { for (const s of sockets) s.destroy(); };
const tick = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
const port = (peer.address() as net.AddressInfo).port;
const log = createLogger('debug', (line) => { process.stdout.write(line + '\n'); });
const pool = createPool({ databaseUrl: `postgres://pool_user:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/pool_db?sslmode=disable`, dbPoolMax: 2 }, log);
const out: Record<string, unknown> = { listeners: pool.listenerCount('error') };

// 1. idle connection lost: logged, discarded, and the next query gets a fresh connection
(await pool.connect()).release();
out.idleBefore = pool.idleCount;
dropAll();
await tick();
out.totalAfterIdleDrop = pool.totalCount;
await pool.query('SELECT 1');
out.recoveredAfterIdle = true;

// 2. checked-out connection lost between queries (inside a transaction, say): no crash, dropped on release
const c = await pool.connect();
dropAll();
await tick();
c.release();
out.totalAfterCheckedOutDrop = pool.totalCount;
await pool.query('SELECT 1');
out.recoveredAfterCheckedOut = true;

// 3. connection lost with a query in flight: the query rejects to its caller, the process lives on
hang = true;
const q = pool.query('SELECT 1').then(() => 'resolved', (e: Error) => `rejected: ${e.message}`);
await tick();
dropAll();
out.inFlight = await q;
hang = false;
await pool.query('SELECT 1');
out.recoveredAfterInFlight = true;
out.opened = opened;

// lifecycle: the pool ends cleanly and nothing keeps the process alive
await pool.end();
peer.close();
out.ended = pool.ended;
process.stdout.write(JSON.stringify({ summary: out }) + '\n');
