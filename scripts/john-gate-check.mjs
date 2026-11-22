#!/usr/bin/env node
// The human checkpoint for pull requests (#143, docs/shipping.md). Automated shipping must stop for John in two cases only:
//
// - rules: RULES_VERSION or PROTOCOL_VERSION in src/net/protocol.ts changes. The PR description must carry a line
//     JOHN-OK: rules
// - hubs:  src/race.ts or src/main.ts grows by more than HUB_SLACK (20) net lines (line count at the PR minus line count
//   on the base). The PR description must carry a line
//     JOHN-OK: hubs
//   unless the same PR lowers that hub's own ceiling in test/hubSize.test.ts (a ratcheting extract, #141).
//
// Every other PR passes untouched. Only the PR description counts (not commit messages): John signs off by editing it,
// which re-runs this check. A missing description fails closed whenever a case triggers.
//
// Usage (CI: .github/workflows/server-deploy.yml, job `john`, on the PR's merge commit):
//   PR_BODY="$BODY" node scripts/john-gate-check.mjs [<base-rev>]       base-rev defaults to HEAD^1 (the PR's base)
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_FILE, versionsOf } from './server-deploy-check.mjs';

export const HUBS = ['src/race.ts', 'src/main.ts'];
export const HUB_TEST = 'test/hubSize.test.ts';
/** Net lines a hub may grow by in one PR without John. */
export const HUB_SLACK = 20;
export const RULES_TAG = 'JOHN-OK: rules';
export const HUBS_TAG = 'JOHN-OK: hubs';

/** Whether a PR description carries `JOHN-OK: <what>` on a line of its own (list bullets, quotes and case are fine). */
export function hasTag(body, what) {
  if (typeof body !== 'string') return false;
  return new RegExp(`^[\\s>*-]*JOHN-OK:\\s*${what}\\s*$`, 'im').test(body);
}

/** Lines as `wc -l` counts them (newline characters), the way test/hubSize.test.ts counts; null for a missing file. */
export const lineCount = (src) => (typeof src === 'string' ? (src.match(/\n/g) ?? []).length : null);

/**
 * The ceiling for each hub in test/hubSize.test.ts source (`'src/race.ts': 1828,`), or null where it is not found.
 * @returns {Record<string, number | null>}
 */
export function ceilingsOf(src) {
  const text = typeof src === 'string' ? src : '';
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const hub of HUBS) {
    const esc = hub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^\\s*['"]${esc}['"]\\s*:\\s*(\\d+)\\s*,?\\s*$`, 'm').exec(text);
    out[hub] = m ? Number(m[1]) : null;
  }
  return out;
}

/**
 * The verdict for one PR. `base` / `head`: { protocol, hubs: { [hub]: source }, hubTest } at the base and at the PR
 * (null for a missing file). Returns { ok, rules: string[] (what changed), hubs: [{ hub, growth, exempt }], message }.
 */
export function check({ base, head, body }) {
  const problems = [], notes = [];

  // rules: the same comparison as the server-deploy reminder (a removed constant counts as changed)
  const rules = [];
  if (base.protocol !== null && base.protocol !== undefined) {
    const was = versionsOf(base.protocol), now = versionsOf(head.protocol);
    for (const [key, name] of [['protocol', 'PROTOCOL_VERSION'], ['rules', 'RULES_VERSION']]) {
      if (was[key] !== null && now[key] !== was[key]) rules.push(`${name} ${was[key]} -> ${now[key] ?? '(removed)'}`);
    }
  }
  if (rules.length) {
    if (hasTag(body, 'rules')) notes.push(`${rules.join('; ')}: approved ("${RULES_TAG}").`);
    else problems.push(`${rules.join('; ')}: a rules or protocol change needs John's approval. Park the PR with the needs-john label; John adds a line "${RULES_TAG}" to the description.`);
  }

  // hubs: net growth per hub, exempt when that hub's ceiling drops in the same PR
  const wasCeil = ceilingsOf(base.hubTest), nowCeil = ceilingsOf(head.hubTest);
  const hubs = [];
  for (const hub of HUBS) {
    const was = lineCount(base.hubs?.[hub]), now = lineCount(head.hubs?.[hub]);
    if (was === null) continue; // not on the base: nothing to compare against
    const growth = (now ?? 0) - was;
    const exempt = wasCeil[hub] !== null && nowCeil[hub] !== null && nowCeil[hub] < wasCeil[hub];
    hubs.push({ hub, growth, exempt });
    if (growth <= HUB_SLACK) continue;
    if (exempt) notes.push(`${hub} +${growth} lines, but its ceiling drops ${wasCeil[hub]} -> ${nowCeil[hub]} (ratcheting extract).`);
    else if (hasTag(body, 'hubs')) notes.push(`${hub} +${growth} lines: approved ("${HUBS_TAG}").`);
    else problems.push(`${hub} grows by ${growth} net lines (slack ${HUB_SLACK}): new code belongs in a module (README, "Where new code goes"). Move it out, or park the PR with needs-john; John adds a line "${HUBS_TAG}" to the description.`);
  }

  const ok = problems.length === 0;
  const message = ok
    ? (notes.length ? notes.join(' ') : `No rules/protocol change and no hub grows by more than ${HUB_SLACK} lines: no John sign-off needed.`)
    : problems.join(' ');
  return { ok, rules, hubs, message };
}

function gitShow(rev, file) {
  try { return execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }); } catch { return null; }
}
function readOrNull(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function main() {
  const rev = process.argv[2] ?? 'HEAD^1';
  // the base must be readable as a commit at all: a shallow checkout without it would otherwise pass silently
  try { execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], { stdio: 'ignore' }); } catch {
    console.error(`john-gate-check: base revision ${rev} is not available (fetch-depth too shallow?)`);
    process.exit(2);
  }
  const at = (read) => ({ protocol: read(PROTOCOL_FILE), hubTest: read(HUB_TEST), hubs: Object.fromEntries(HUBS.map((h) => [h, read(h)])) });
  const r = check({ base: at((f) => gitShow(rev, f)), head: at(readOrNull), body: process.env.PR_BODY ?? '' });
  console.log(`john-gate-check: ${r.ok ? 'ok' : 'FAILED'}: ${r.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### John checkpoint (#143)\n\n${r.ok ? '' : '**Waiting for John.** '}${r.message}\n\nSee docs/shipping.md.\n`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
