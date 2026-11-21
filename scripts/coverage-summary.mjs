#!/usr/bin/env node
// Coverage by top-level directory (#145), from the json-summary report `npm run test:coverage` writes: the client (src/)
// and the room server (server/) separately, for the job log and, in GitHub Actions, the job summary. Report only: it never
// fails on a percentage (there is no coverage floor yet; docs/validation.md has the first figures).
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, process.argv[2] ?? 'coverage/coverage-summary.json');
const report = JSON.parse(readFileSync(file, 'utf8'));
const KINDS = ['lines', 'statements', 'functions', 'branches'];
const groups = new Map([['src', null], ['server', null], ['total', null]].map(([k]) => [k, Object.fromEntries(KINDS.map((x) => [x, { covered: 0, total: 0 }]))]));
let files = 0;
for (const [name, m] of Object.entries(report)) {
  if (name === 'total') continue;
  const top = path.relative(ROOT, name).split(path.sep)[0];
  files++;
  for (const g of [top, 'total']) {
    const acc = groups.get(g);
    if (!acc) continue;
    for (const k of KINDS) { acc[k].covered += m[k].covered; acc[k].total += m[k].total; }
  }
}
const pct = (x) => (x.total ? ((100 * x.covered) / x.total).toFixed(2) : 'n/a');
const rows = [...groups].map(([g, acc]) => `| ${g === 'total' ? 'all' : `${g}/`} | ${KINDS.map((k) => `${pct(acc[k])} % (${acc[k].covered}/${acc[k].total})`).join(' | ')} |`);
const table = [`| Directory | ${KINDS.map((k) => k[0].toUpperCase() + k.slice(1)).join(' | ')} |`, `| --- |${' --- |'.repeat(KINDS.length)}`, ...rows].join('\n');
console.log(`\nCoverage by directory (${files} files; report only, no threshold):\n\n${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Test coverage (report only, no threshold)\n\n${table}\n`);
