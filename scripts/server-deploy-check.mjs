#!/usr/bin/env node
// The server-deploy reminder for pull requests (#142). The static client deploys itself on every merge to main; the room
// server is upgraded by hand (docs/online-server.md). A change to RULES_VERSION or PROTOCOL_VERSION in src/net/protocol.ts
// means both sides must move together, so such a PR must say so in its description with a line
//
//   SERVER-DEPLOY: required
//
// and this check fails until it does. Every other PR passes untouched. It is a reminder, not the safety net: the client's
// handshake (src/online.ts, src/net/client.ts) already refuses to race on a server with other rules or protocol.
//
// Usage (CI: .github/workflows/server-deploy.yml, on the PR's merge commit):
//   PR_BODY="$BODY" node scripts/server-deploy-check.mjs [<base-rev>]       base-rev defaults to HEAD^1 (the PR's base)
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_FILE = 'src/net/protocol.ts';
/** The line a PR description must carry when it changes either version (case-insensitive, on a line of its own). */
export const MARKER = 'SERVER-DEPLOY: required';
const MARKER_RE = /^[\s>*-]*SERVER-DEPLOY:\s*required\s*$/im;

/**
 * The two version constants as they appear in protocol.ts source (`export const NAME = value;`), or null for one that is
 * not found. Only the first definition of each counts.
 */
export function versionsOf(src) {
  const text = typeof src === 'string' ? src : '';
  const protocol = /^export const PROTOCOL_VERSION\s*=\s*([^;\n]+);/m.exec(text)?.[1].trim() ?? null;
  const rules = /^export const RULES_VERSION\s*=\s*([^;\n]+);/m.exec(text)?.[1].trim() ?? null;
  return { protocol, rules };
}

/** Whether a PR description carries the server-deploy line. */
export const hasMarker = (body) => typeof body === 'string' && MARKER_RE.test(body);

/**
 * The verdict for one PR. `base` / `head`: protocol.ts at the base and at the PR (null: the file does not exist there).
 * - a base without the file: nothing to compare against, passes (a new repository or a moved file is not a version bump);
 * - a head without either constant, while the base has it: fails (a removed or renamed constant must be looked at);
 * - a changed constant: passes only with the marker line in `body`.
 */
export function check({ base, head, body }) {
  if (base === null || base === undefined) return { ok: true, changed: [], message: `${PROTOCOL_FILE} is not on the base branch: nothing to compare.` };
  const was = versionsOf(base), now = versionsOf(head);
  const changed = [];
  for (const [key, name] of [['protocol', 'PROTOCOL_VERSION'], ['rules', 'RULES_VERSION']]) {
    if (was[key] === null) continue;
    if (now[key] !== was[key]) changed.push(`${name} ${was[key]} -> ${now[key] ?? '(removed)'}`);
  }
  if (!changed.length) return { ok: true, changed, message: 'PROTOCOL_VERSION and RULES_VERSION unchanged: no server deploy needed for the handshake.' };
  if (hasMarker(body)) return { ok: true, changed, message: `${changed.join('; ')}. The PR description says "${MARKER}": upgrade the room server first (docs/online-server.md), then let the static client deploy.` };
  return {
    ok: false, changed,
    message: `${changed.join('; ')}. This needs a room-server upgrade (docs/online-server.md, "Deploy order"): add a line "${MARKER}" to the PR description. Editing the description re-runs this check.`,
  };
}

function gitShow(rev, file) {
  try { return execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
}

function main() {
  const base = process.argv[2] ?? 'HEAD^1';
  // the base must be readable as a commit at all: a shallow checkout without it would otherwise pass silently
  try { execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { stdio: 'ignore' }); } catch {
    console.error(`server-deploy-check: base revision ${base} is not available (fetch-depth too shallow?)`);
    process.exit(2);
  }
  let head;
  try { head = readFileSync(PROTOCOL_FILE, 'utf8'); } catch { head = ''; }
  const r = check({ base: gitShow(base, PROTOCOL_FILE), head, body: process.env.PR_BODY ?? '' });
  console.log(`server-deploy-check: ${r.ok ? 'ok' : 'FAILED'}: ${r.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Server deploy reminder (#142)\n\n${r.ok ? '' : '**Failed.** '}${r.message}\n`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
