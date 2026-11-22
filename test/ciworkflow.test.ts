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

  it('has the client check, server, lint, coverage and deploy jobs', () => {
    expect([...all.keys()].sort()).toEqual(['check', 'coverage', 'deploy', 'lint', 'server']);
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

// ESLint runs on every PR and push to main as its own visible job, but is not a deploy gate yet (#148): it is outside
// deploy.needs, so its result can neither block nor allow a deployment, and it holds no secrets and deploys nothing.
describe('ESLint report job (#148)', () => {
  const all = jobs();
  const lint = all.get('lint')!;

  it('runs npm run lint after a lockfile install, on the same triggers as the gating jobs', () => {
    expect(lint, 'a lint job').toBeDefined();
    const body = lint.join('\n');
    expect(body).toMatch(/run: npm ci\n/);
    expect(body).toMatch(/run: npm run lint\s*$/m);
    expect(body.indexOf('run: npm ci')).toBeLessThan(body.indexOf('run: npm run lint'));
    expect(body, 'no job-level if: (runs on PRs and main alike)').not.toMatch(/^ {4}if:/m);
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts.lint).toMatch(/^eslint\b/);
  });

  it('is not a deploy gate: deploy does not need it and its condition never mentions it', () => {
    const deploy = all.get('deploy')!;
    expect(needsOf(deploy)).not.toContain('lint');
    expect(ifOf(deploy)).not.toMatch(/lint/);
    for (const id of ['check', 'server']) expect(needsOf(all.get(id)!), `${id} does not wait for lint or coverage`).toEqual([]);
  });

  it('holds no secrets, deploys nothing and keeps the workflow\'s read-only permissions', () => {
    const body = lint.join('\n');
    expect(body).not.toMatch(/secrets\.|ssh|deploy\/run\.sh|upload-artifact/);
    expect(body).not.toMatch(/^ {4}permissions:/m);
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

/** the `- name:` steps of a job, in order, each with its own lines (the step's `uses:`/`run:` and keys) */
function steps(body: string[]): { name: string; lines: string[] }[] {
  const out: { name: string; lines: string[] }[] = [];
  for (const l of body) {
    const m = /^ {6}- (?:name: (.*)|\S.*)$/.exec(l);
    if (m) { out.push({ name: m[1] ?? '', lines: [l] }); continue; }
    out.at(-1)?.lines.push(l);
  }
  return out;
}
const runOf = (s: { lines: string[] }) => s.lines.map((l) => /^ {8}run: (.*)$/.exec(l)?.[1]).find((r) => r !== undefined) ?? '';

// The Playwright smoke (#145) runs inside the check job on the production build, after that build and before it is packaged
// and retained: deploy downloads only check's artifact and needs check to succeed, so a failed or removed-but-still-green
// smoke would have to show up here. It is client-only (no room server, no secrets) and stays short (a step timeout and the
// script's own --max-minutes). The full browser-check matrix is not in CI.
describe('Playwright smoke gate (#145)', () => {
  const all = jobs();
  const check = steps(all.get('check')!);
  const names = check.map((s) => s.name);
  const at = (re: RegExp) => check.findIndex((s) => re.test(runOf(s)));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

  it('check runs the smoke after the production build and before the artifact is packaged and retained', () => {
    const build = at(/^npm run build$/), install = at(/^npx playwright-core install\b/), smoke = at(/^npm run check:smoke\b/);
    const pack = at(/deploy\/artifact\.py pack /);
    const retain = check.findIndex((s) => s.lines.some((l) => /uses: actions\/upload-artifact@/.test(l)));
    expect(build, 'production build step').toBeGreaterThanOrEqual(0);
    expect(check[build].lines.join('\n'), 'the smoke tests the VITE_ONLINE=1 build that ships').toMatch(/VITE_ONLINE: '1'/);
    expect(install, 'browser install step').toBeGreaterThan(build);
    expect(smoke, 'smoke step').toBeGreaterThan(install);
    expect(pack, 'artifact packed after the smoke').toBeGreaterThan(smoke);
    expect(retain, 'artifact retained after the smoke').toBeGreaterThan(pack);
    expect(check.filter((s) => /check:smoke|browser-check/.test(runOf(s))).length, 'exactly one browser step').toBe(1);
    expect(names.filter((n) => /smoke/i.test(n)).length).toBeGreaterThanOrEqual(1);
  });

  it('the smoke step is not skippable: no step-level if:, no continue-on-error, and a time box', () => {
    for (const re of [/^npx playwright-core install\b/, /^npm run check:smoke\b/]) {
      const s = check[at(re)];
      const body = s.lines.join('\n');
      expect(body, `${s.name}: no step-level if:`).not.toMatch(/^ {8}if:/m);
      expect(body, `${s.name}: no continue-on-error`).not.toMatch(/continue-on-error/);
      const t = /^ {8}timeout-minutes: (\d+)\s*$/m.exec(body);
      expect(t, `${s.name}: has a step timeout`).not.toBeNull();
      expect(Number(t![1])).toBeLessThanOrEqual(5);
    }
    expect(runOf(check[at(/^npx playwright-core install\b/)])).toBe('npx playwright-core install --with-deps --only-shell chromium');
  });

  it('deploy still needs check, so the smoke gates the static deploy', () => {
    expect(needsOf(all.get('deploy')!)).toContain('check');
    expect(ifOf(all.get('deploy')!)).toMatch(/needs\.check\.result == 'success'/);
  });

  it('check:smoke runs only the smoke scenario, time-boxed, on the built dist/ (no --url, so no live site)', () => {
    const cmd = pkg.scripts['check:smoke'];
    expect(cmd).toMatch(/^node scripts\/browser-check\.mjs smoke --max-minutes [1-4]$/);
    const src = readFileSync('scripts/browser-check.mjs', 'utf8');
    expect(src).toMatch(/^const SCENARIOS = \{[^}]*\bsmoke\b[^}]*\};$/m);
    // the smoke uses the page as a visitor sees it: no ?qa=1 (withQa), no full-hook calls, and /api stubbed in the page
    const body = /^async function smoke\(run, c\) \{\n([\s\S]*?)\n\}\n/m.exec(src)?.[1] ?? '';
    expect(body, 'the smoke scenario').not.toBe('');
    expect(body).not.toMatch(/withQa|startSession|advance\(|qaNet|qaOnline|netDrop|setLocalSlot/);
    expect(body).toMatch(/route\.fulfill/);
  });

  it('the full browser-check matrix stays opt-in (npm run check:browser), never a CI step', () => {
    expect(pkg.scripts['check:browser']).toBe('npm run build && node scripts/browser-check.mjs');
    expect(text).not.toMatch(/check:browser|browser-check\.mjs|online-check/);
  });

  it('uses the locked playwright-core', () => {
    expect(pkg.devDependencies['playwright-core']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// Coverage (#145) is measured on pull requests and reported, never enforced: no threshold anywhere, and like lint it is
// outside deploy.needs, so it can neither block nor allow a deployment.
describe('coverage report job (#145)', () => {
  const all = jobs();
  const cov = all.get('coverage')!;
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

  it('runs npm run test:coverage after a lockfile install, on pull requests only', () => {
    expect(cov, 'a coverage job').toBeDefined();
    const body = cov.join('\n');
    expect(body).toMatch(/run: npm ci\n/);
    expect(body).toMatch(/run: npm run test:coverage\s*$/m);
    expect(body.indexOf('run: npm ci')).toBeLessThan(body.indexOf('run: npm run test:coverage'));
    expect(jobKey(cov, 'if')?.inline).toBe("github.event_name == 'pull_request'");
    expect(pkg.scripts['test:coverage']).toMatch(/^vitest run --coverage\b/);
  });

  it('matches the installed vitest exactly and sets no coverage threshold', () => {
    expect(pkg.devDependencies['@vitest/coverage-v8']).toMatch(/^\d+\.\d+\.\d+$/);
    const vitest = JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')) as { version: string };
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe(vitest.version);
    const config = readFileSync('vitest.config.ts', 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(config).toMatch(/provider: 'v8'/);
    expect(config, 'no coverage threshold (a floor is a later decision)').not.toMatch(/thresholds?|perFile|autoUpdate/);
    expect(pkg.scripts['test:coverage']).not.toMatch(/threshold/);
  });

  it('is not a deploy gate and holds no secrets', () => {
    expect(needsOf(all.get('deploy')!)).not.toContain('coverage');
    expect(ifOf(all.get('deploy')!)).not.toMatch(/coverage/);
    expect(cov.join('\n')).not.toMatch(/secrets\.|ssh|deploy\/run\.sh|upload-artifact/);
    expect(cov.join('\n')).not.toMatch(/^ {4}permissions:/m);
  });
});

// The server-deploy reminder (#142): a PR that changes RULES_VERSION or PROTOCOL_VERSION fails until its description says
// `SERVER-DEPLOY: required` (scripts/server-deploy-check.mjs, unit-tested in test/serverDeployCheck.test.ts). Its own
// workflow, on pull requests only (a push to main has no description), re-run when the description is edited; it deploys
// nothing and holds no secrets. The server job it reminds about cannot be skipped in ci.yml: no job-level if: and no path
// filter on the workflow's triggers. The same workflow carries the John checkpoint job (#143, scripts/john-gate-check.mjs,
// unit-tested in test/johnGateCheck.test.ts), wired the same way.
describe('server-deploy reminder (#142)', () => {
  const FILE = '.github/workflows/server-deploy.yml';
  const raw = readFileSync(FILE, 'utf8');
  const own = raw.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, ''));
  const body = own.join('\n');

  it('runs on pull requests only, including description edits, never on push', () => {
    expect(body).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, edited, reopened, synchronize\]\n/m);
    expect(body).not.toMatch(/^ {2}push:/m);
    expect(body).not.toMatch(/pull_request_target|workflow_run|paths(-ignore)?:/);
    expect(body).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  // job id -> its lines, under the top-level jobs: mapping (two-space headers)
  const jobsAt = own.indexOf('jobs:');
  const wfJobs = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const l of own.slice(jobsAt + 1)) {
    const h = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (h) { cur = []; wfJobs.set(h[1], cur); continue; }
    cur?.push(l);
  }
  // each job: always runs on a PR, runs its tested script on the merge commit against its base, body from the environment
  const pinned = (id: string, run: string) => {
    const job = wfJobs.get(id)!.join('\n');
    expect(job, 'no job- or step-level if: (it always runs on a PR)').not.toMatch(/^ {4,8}if:/m);
    expect(job).not.toMatch(/continue-on-error|always\(\)|secrets\.|ssh|deploy\/run\.sh|upload-artifact|needs:|permissions:/);
    expect(job).toMatch(/fetch-depth: 2\n/);
    expect(job).toMatch(/persist-credentials: false/);
    expect(job).toMatch(/ {10}PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}\n/);
    const runs = [...job.matchAll(/^ {8}run: (.*)$/gm)].map((m) => m[1]);
    expect(runs).toEqual([run]);
    // the description is never pasted into a shell line (script injection)
    expect(runs.join('\n')).not.toMatch(/\$\{\{/);
  };

  it('has the versions job and the John checkpoint job (#143), nothing else', () => {
    expect([...wfJobs.keys()]).toEqual(['versions', 'john']);
  });

  it('the versions job runs the server-deploy script on the merge commit against its base, with the body from the environment', () => {
    pinned('versions', 'node scripts/server-deploy-check.mjs HEAD^1');
  });

  it('the john job runs the John checkpoint script the same way (#143, test/johnGateCheck.test.ts)', () => {
    pinned('john', 'node scripts/john-gate-check.mjs HEAD^1');
  });

  it('the server job in ci.yml cannot be skipped: no job-level if:, no path filters, and the static deploy needs it', () => {
    const all = jobs();
    expect(all.get('server')!.join('\n')).not.toMatch(/^ {4}if:/m);
    expect(text).not.toMatch(/paths(-ignore)?:|branches-ignore:/);
    expect(needsOf(all.get('deploy')!)).toContain('server');
    // ci.yml still deploys no server (docs/online-server.md: the upgrade is the owner's, server first)
    expect(all.get('server')!.join('\n')).not.toMatch(/ssh|deploy\/run\.sh/);
  });
});
