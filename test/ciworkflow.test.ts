// The static deploy must be gated on BOTH validation jobs for the exact commit (#55). There is no YAML parser among the
// dependencies, so this reads .github/workflows/ci.yml with a deliberately narrow line parser: job headers at two spaces
// under `jobs:`, job keys at four. Anything it does not understand (an `||`, a `!`, an unknown condition) fails the test
// rather than being guessed at. The deploy condition is then evaluated the way GitHub Actions does for every combination
// of prerequisite results, so a failed, cancelled or skipped prerequisite is shown to block deployment.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW = process.env.SLOTRUSH_CI_WORKFLOW ?? '.github/workflows/ci.yml';
// comments removed (whole-line and trailing), so the workflow's own explanatory comments cannot satisfy or trip a check
const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  .filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, ''));
const text = lines.join('\n');

/** job id -> its lines (header excluded), from the top-level `jobs:` mapping */
function jobs(): Map<string, string[]> {
  const start = lines.findIndex((l) => l === 'jobs:');
  expect(start, 'top-level jobs: mapping').toBeGreaterThanOrEqual(0);
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // next top-level key
    const h = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (h) { cur = []; out.set(h[1], cur); continue; }
    cur?.push(l);
  }
  return out;
}

/** a job-level key (four-space indent): its inline value, or its block-list items */
function jobKey(body: string[], key: string): { inline: string; items: string[] } | null {
  const i = body.findIndex((l) => l.startsWith(`    ${key}:`));
  if (i < 0) return null;
  const inline = body[i].slice(`    ${key}:`.length).replace(/\s+#.*$/, '').trim();
  const items: string[] = [];
  for (const l of body.slice(i + 1)) {
    const m = /^ {6}- (\S+)\s*$/.exec(l);
    if (!m) break;
    items.push(m[1]);
  }
  return { inline, items };
}

function needsOf(body: string[]): string[] {
  const n = jobKey(body, 'needs');
  if (!n) return [];
  if (n.items.length) return n.items;
  const list = /^\[(.*)\]$/.exec(n.inline);
  return (list ? list[1].split(',') : [n.inline]).map((s) => s.trim()).filter(Boolean);
}

function ifOf(body: string[]): string {
  const c = jobKey(body, 'if');
  expect(c, 'deploy has a job-level if:').not.toBeNull();
  let e = c!.inline;
  expect(e, 'single-line if:').not.toMatch(/^[|>]/);
  const quoted = /^(['"])(.*)\1$/.exec(e);
  if (quoted) e = quoted[2];
  const wrapped = /^\$\{\{(.*)\}\}$/.exec(e.trim());
  return (wrapped ? wrapped[1] : e).trim();
}

type Result = 'success' | 'failure' | 'cancelled' | 'skipped';
interface Ctx { needs: Record<string, Result>; event: string; ref: string; }

/**
 * GitHub Actions semantics for a job's `if:`: without a status function (success(), always(), failure(), cancelled())
 * it is implicitly `success() && (...)`, and success() is true only when every needed job succeeded. Only a conjunction
 * of the atoms below is accepted.
 */
function deploys(expr: string, needs: string[], ctx: Ctx): boolean {
  expect(expr.replaceAll('success()', ''), 'deploy condition uses only && (no ||, !, or grouping)').not.toMatch(/\|\||!(?!=)|[()]/);
  const atoms = expr.split('&&').map((a) => a.trim());
  const status = atoms.filter((a) => /^[a-z]+\(\)$/.test(a));
  for (const s of status) expect(s, 'only success() may appear as a status function').toBe('success()');
  if (status.length === 0) atoms.unshift('success()');
  return atoms.every((a) => {
    if (a === 'success()') return needs.every((n) => ctx.needs[n] === 'success');
    let m = /^needs\.([A-Za-z0-9_-]+)\.result == '(\w+)'$/.exec(a);
    if (m) { expect(needs, `${a} refers to a needed job`).toContain(m[1]); return ctx.needs[m[1]] === m[2]; }
    m = /^github\.event_name == '(\w+)'$/.exec(a);
    if (m) return ctx.event === m[1];
    m = /^github\.ref == '([^']+)'$/.exec(a);
    if (m) return ctx.ref === m[1];
    throw new Error(`unrecognised deploy condition atom: ${a}`);
  });
}

describe('CI release gate (#55)', () => {
  const all = jobs();
  const deploy = all.get('deploy')!;

  it('has the client check, server and deploy jobs', () => {
    expect([...all.keys()].sort()).toEqual(['check', 'deploy', 'server']);
  });

  it('deploy needs both the client check job and the server/database/package/smoke job', () => {
    expect(needsOf(deploy).sort()).toEqual(['check', 'server']);
  });

  it('deploys only on a push to main when both prerequisites succeeded; failure, cancellation or a skip blocks it', () => {
    const needs = needsOf(deploy);
    const expr = ifOf(deploy);
    const results: Result[] = ['success', 'failure', 'cancelled', 'skipped'];
    const events: [string, string][] = [
      ['push', 'refs/heads/main'], ['pull_request', 'refs/pull/1/merge'], ['push', 'refs/heads/other'],
    ];
    for (const check of results) for (const server of results) for (const [event, ref] of events) {
      const ran = deploys(expr, needs, { needs: { check, server }, event, ref });
      const want = check === 'success' && server === 'success' && event === 'push' && ref === 'refs/heads/main';
      expect(ran, `check=${check} server=${server} ${event} ${ref}`).toBe(want);
    }
  });

  it('nothing can mark a failed validation step or job as passed', () => {
    expect(text).not.toMatch(/continue-on-error/);
    expect(text).not.toMatch(/failure\(\)|cancelled\(\)/);
    for (const id of ['check', 'server']) {
      const body = all.get(id)!;
      expect(body.join('\n'), `${id} has no job-level if:`).not.toMatch(/^ {4}if:/m);
      expect(body.join('\n'), `${id} steps never use always()`).not.toMatch(/always\(\)/);
    }
    // the one always() is the deploy job's final key cleanup step, after the deploy step itself
    const always = deploy.map((l, i) => [l, i] as const).filter(([l]) => /always\(\)/.test(l));
    expect(always.length).toBe(1);
    const at = always[0][1];
    expect(deploy[at - 1]).toMatch(/- name: Remove ephemeral SSH files/);
    expect(deploy.slice(at + 1).join('\n')).not.toMatch(/- name:|uses:/);
  });

  it('keeps the checked artifact, permissions, serial deployment and the verify/rollback script unchanged', () => {
    const d = deploy.join('\n');
    expect(d).toMatch(/artifact-ids: \$\{\{ needs\.check\.outputs\.artifact-id \}\}/);
    expect(d).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    expect(d).toMatch(/ {4}permissions:\n {6}contents: read\n {6}actions: read\n/);
    expect(d).toMatch(/ {4}concurrency:\n {6}group: slotrush-production\n {6}cancel-in-progress: false\n/);
    expect(d).toMatch(/run: bash deploy\/run\.sh bundle/);
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(text).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    expect(all.get('check')!.join('\n')).toMatch(/python3 deploy\/artifact\.py pack dist bundle "\$CHECKED_SHA"/);
    // the server job still deploys nothing and holds no secrets
    expect(all.get('server')!.join('\n')).not.toMatch(/secrets\.|ssh|deploy\/run\.sh/);
  });
});

// The database test files are chosen by one vitest file filter, used both by the CI database step and by `npm run test:db`
// (scripts/local-pg.mjs), never by a hand-written list: a new *.db.test.ts used to be skipped silently unless both lists were
// edited (#106). vitest selects a file when its path contains a filter.
describe('database tests (#106)', () => {
  const server = jobs().get('server')!;
  const at = server.findIndex((l) => /SLOTRUSH_TEST_DATABASE_URL:/.test(l));
  const run = server.slice(at).find((l) => /^ {8}run: /.test(l))!.trim().slice('run: '.length);
  const testFiles = (readdirSync('test', { recursive: true }) as string[]).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f.replaceAll('\\', '/')}`);

  it('CI runs them with a single vitest file filter, not a list of files', () => {
    expect(at, 'the server job sets SLOTRUSH_TEST_DATABASE_URL on its database step').toBeGreaterThanOrEqual(0);
    expect(run).toBe('npx vitest run db.test.ts');
  });

  it('npm run test:db (scripts/local-pg.mjs) uses the same filter', () => {
    const src = readFileSync('scripts/local-pg.mjs', 'utf8');
    const spawn = /spawnSync\('npx', \[([^\]]*)\]/.exec(src);
    expect(spawn, 'local-pg.mjs runs vitest').not.toBeNull();
    const args = [...spawn![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(['npx', ...args].join(' ')).toBe(run);
  });

  it('the filter selects exactly the test files that need the database', () => {
    const filter = run.split(' ').at(-1)!;
    const needDb = testFiles.filter((f) => /process\.env\.SLOTRUSH_TEST_DATABASE_URL\b/.test(readFileSync(f, 'utf8')));
    const selected = testFiles.filter((f) => f.includes(filter));
    expect(needDb.length).toBeGreaterThanOrEqual(5);
    expect(selected.sort()).toEqual(needDb.sort());
  });
});
