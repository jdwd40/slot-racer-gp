// Package the built room server as one self-contained, checksummed release: server-dist/ plus the locked production
// dependencies (ws, pg, express-session, argon2 with its bundled linux-x64 prebuild), installed with `npm ci --omit=dev
// --ignore-scripts`, so the host never builds or runs install scripts. Run on linux-x64 with Node 22 (as CI does).
//   node scripts/pack-server.mjs  ->  server-bundle/slotrush-server-<rev>.tar.gz and .sha256
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

if (!existsSync('server-dist/main.mjs')) throw new Error('run npm run build:server first');
const rev = readFileSync('server-dist/VERSION', 'utf8').trim();
const name = `slotrush-server-${rev}`;
const out = `server-bundle/${name}`;
rmSync('server-bundle', { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('server-dist', `${out}/server-dist`, { recursive: true });
for (const f of ['package.json', 'package-lock.json', '.nvmrc']) copyFileSync(f, `${out}/${f}`);
cpSync('scripts/server-smoke.mjs', `${out}/scripts/server-smoke.mjs`);
cpSync('deploy/server', `${out}/deploy/server`, { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
// the release must load its native hasher and every runtime package as installed, with no build step
execFileSync(process.execPath, ['-e', "Promise.all(['argon2','ws','pg','express-session'].map((m)=>import(m))).then(async([a])=>{const h=await a.default.hash('x');if(!(await a.default.verify(h,'x')))process.exit(1)})"], { cwd: out, stdio: 'inherit' });
writeFileSync(`${out}/RELEASE`, JSON.stringify({ name, rev, node: process.version, builtAt: new Date().toISOString() }) + '\n');
execFileSync('tar', ['-C', 'server-bundle', '-czf', `server-bundle/${name}.tar.gz`, name]);
const sha = createHash('sha256');
await new Promise((res, rej) => createReadStream(`server-bundle/${name}.tar.gz`).on('data', (d) => sha.update(d)).on('end', res).on('error', rej));
writeFileSync(`server-bundle/${name}.tar.gz.sha256`, `${sha.digest('hex')}  ${name}.tar.gz\n`);
console.log(`server-bundle/${name}.tar.gz`);
