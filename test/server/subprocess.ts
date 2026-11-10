// Bundles a server entry point (TypeScript) with esbuild so a test can run it as its own Node process, the way production
// runs server-dist/main.mjs. The output sits under node_modules/.cache so the external runtime packages resolve from the
// repository's node_modules.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export async function bundle(entry: string): Promise<string> {
  const dir = resolve('node_modules/.cache/slotrush-test');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${basename(entry, '.ts')}-${process.pid}-${Date.now()}.mjs`);
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', logLevel: 'warning' });
  return out;
}
