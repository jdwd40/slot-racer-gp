// Bundle the room server (server/main.ts, server/admin.ts and the shared race core they import) into server-dist/.
// Runtime packages stay external and are installed from the lockfile with `npm ci --omit=dev` (see docs/online-server.md).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

let rev = process.env.SLOTRUSH_BUILD ?? '';
if (!rev) { try { rev = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { rev = 'unknown'; } }
rmSync('server-dist', { recursive: true, force: true });
mkdirSync('server-dist');
await build({
  entryPoints: { main: 'server/main.ts', admin: 'server/admin.ts' },
  outdir: 'server-dist', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false, legalComments: 'none',
  packages: 'external',
  define: { __SLOTRUSH_BUILD__: JSON.stringify(rev) },
  logLevel: 'warning',
});
writeFileSync('server-dist/VERSION', rev + '\n');
// the protocol this build speaks, for the rollout compatibility check (scripts/server-smoke.mjs)
const src = readFileSync('src/net/protocol.ts', 'utf8');
const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(src)?.[1]);
const rules = /RULES_VERSION = '([^']+)'/.exec(src)?.[1];
if (!protocol || !rules) throw new Error('cannot read PROTOCOL_VERSION / RULES_VERSION');
writeFileSync('server-dist/protocol.json', JSON.stringify({ version: rev, protocol, rules }) + '\n');
console.log(`server-dist/ built (${rev})`);
