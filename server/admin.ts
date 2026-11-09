// Owner-run administration on the server host (see docs/online-server.md):
//   node server-dist/admin.mjs migrate
//   node server-dist/admin.mjs status
//   node server-dist/admin.mjs reset-password <username>   (new password on stdin; or empty stdin: one is generated and printed once)
//   node server-dist/admin.mjs prune-sessions
// Reads DATABASE_URL from the environment (the service's env file). Nothing here is reachable over the network.
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Accounts, checkPassword, checkUsername } from './accounts';
import { createPool } from './db';
import { migrate, schemaStatus } from './migrations';

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  if ((stream as NodeJS.ReadStream).isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of stream) { chunks.push(Buffer.from(c as Buffer)); if (chunks.reduce((n, b) => n + b.length, 0) > 4096) break; }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

/** Generated recovery password: 20 characters from an unambiguous alphabet (about 110 bits). */
export function generatePassword(): string {
  const A = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(20)].map((b) => A[b % A.length]).join('');
}

export async function run(argv: string[], pool: Pool, io: { stdin: () => Promise<string>; out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === 'migrate') {
    const done = await migrate(pool);
    io.out(done.length ? `applied: ${done.join(', ')}` : 'schema already current');
    return 0;
  }
  if (cmd === 'status') {
    const s = await schemaStatus(pool);
    io.out(JSON.stringify(s));
    return s.current ? 0 : 3;
  }
  if (cmd === 'reset-password') {
    if (checkUsername(arg)) { io.err('usage: reset-password <username>'); return 2; }
    let pw = (await io.stdin()).trim();
    let generated = false;
    if (!pw) { pw = generatePassword(); generated = true; }
    const bad = checkPassword(pw);
    if (bad) { io.err(bad); return 2; }
    const r = await new Accounts(pool).resetPassword(arg, pw);
    if (!r.ok) { io.err(`no account named ${arg}`); return 1; }
    io.out(`password reset for ${arg.toLowerCase()}; ${r.revoked} session(s) signed out`);
    if (generated) io.out(`new password (shown once, give it to the player privately): ${pw}`);
    return 0;
  }
  if (cmd === 'prune-sessions') {
    const r = await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    io.out(`removed ${r.rowCount ?? 0} expired session(s)`);
    return 0;
  }
  io.err('usage: admin.mjs migrate | status | reset-password <username> | prune-sessions');
  return 2;
}

const isMain = process.argv[1] && /admin\.(mjs|ts|js)$/.test(process.argv[1]);
if (isMain) {
  const pool = createPool({ databaseUrl: process.env.DATABASE_URL ?? null, dbPoolMax: 1 });
  run(process.argv.slice(2), pool, { stdin: () => readStdin(), out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') })
    .then(async (code) => { await pool.end(); process.exit(code); }, async (e: unknown) => { process.stderr.write(`admin failed: ${String((e as Error)?.message ?? e)}\n`); await pool.end().catch(() => undefined); process.exit(1); });
}
