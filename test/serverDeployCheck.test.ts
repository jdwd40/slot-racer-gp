// The server-deploy reminder (#142, scripts/server-deploy-check.mjs): a PR changing RULES_VERSION or PROTOCOL_VERSION in
// src/net/protocol.ts fails unless its description has a `SERVER-DEPLOY: required` line; every other PR passes. The CLI is
// also run end to end in a throwaway git repository, the way the workflow runs it on a PR's merge commit.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARKER, check, hasMarker, versionsOf } from '../scripts/server-deploy-check.mjs';

const src = (protocol: string, rules: string, extra = '') => `// header\nexport const PROTOCOL_VERSION = ${protocol};\nexport const PROTOCOL_NAME = 'slotrush';\n${extra}export const RULES_VERSION = ${rules};\n`;
const BASE = src('2', "'race-core-2026.11.8'");

describe('server-deploy check (#142)', () => {
  it('reads both constants from the real protocol.ts', () => {
    const real = readFileSync('src/net/protocol.ts', 'utf8');
    expect(versionsOf(real)).toEqual({ protocol: '2', rules: "'race-core-2026.11.8'" });
    expect(versionsOf('')).toEqual({ protocol: null, rules: null });
  });

  it('passes a PR that does not change either version, with or without the line', () => {
    const head = src('2', "'race-core-2026.11.8'", "export const OTHER = 'x';\n");
    expect(check({ base: BASE, head, body: '' })).toMatchObject({ ok: true, changed: [] });
    expect(check({ base: BASE, head, body: null })).toMatchObject({ ok: true });
    expect(check({ base: BASE, head: BASE, body: `x\n${MARKER}` })).toMatchObject({ ok: true, changed: [] });
  });

  it('fails a rules or protocol bump without the line, and passes it with the line', () => {
    for (const head of [src('2', "'race-core-2026.11.9'"), src('3', "'race-core-2026.11.8'"), src('3', "'race-core-2026.12.1'")]) {
      const no = check({ base: BASE, head, body: 'Changes the physics.\n\nSERVER-DEPLOY: not needed' });
      expect(no.ok).toBe(false);
      expect(no.message).toContain(MARKER);
      expect(no.changed.length).toBeGreaterThan(0);
      expect(check({ base: BASE, head, body: `Changes the physics.\r\n\r\n${MARKER}\r\n` })).toMatchObject({ ok: true });
    }
    expect(check({ base: BASE, head: src('2', "'race-core-2026.11.9'"), body: '' }).changed).toEqual(["RULES_VERSION 'race-core-2026.11.8' -> 'race-core-2026.11.9'"]);
  });

  it('a removed or renamed constant counts as changed; a base without the file passes', () => {
    expect(check({ base: BASE, head: "export const PROTOCOL_VERSION = 2;\nexport const RULES = 'x';\n", body: '' })).toMatchObject({ ok: false, changed: ["RULES_VERSION 'race-core-2026.11.8' -> (removed)"] });
    expect(check({ base: BASE, head: null, body: '' }).ok).toBe(false);
    expect(check({ base: null, head: BASE, body: '' })).toMatchObject({ ok: true });
  });

  it('the line must stand on its own (list bullets, quotes and case are fine); a mention inside a sentence is not enough', () => {
    for (const ok of [MARKER, `  ${MARKER}  `, `- ${MARKER}`, `> ${MARKER}`, 'server-deploy: REQUIRED', `intro\n\n${MARKER}\nmore`, 'SERVER-DEPLOY:required'])
      expect(hasMarker(ok), ok).toBe(true);
    for (const no of ['', 'Remember: SERVER-DEPLOY: required later', 'SERVER-DEPLOY: required?', 'SERVER-DEPLOY: not required', 'SERVER DEPLOY: required', undefined, null, 42])
      expect(hasMarker(no), String(no)).toBe(false);
  });
});

describe('server-deploy check CLI on a merge commit (#142)', () => {
  const script = path.resolve('scripts/server-deploy-check.mjs');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });
  function repo(head: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'sdc-'));
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(path.join(dir, 'src/net'), { recursive: true });
    writeFileSync(path.join(dir, 'src/net/protocol.ts'), BASE);
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'pr');
    writeFileSync(path.join(dir, 'src/net/protocol.ts'), head);
    writeFileSync(path.join(dir, 'other.txt'), 'x');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'pr');
    // the merge commit the pull_request event checks out: first parent is the base branch
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    return dir;
  }
  const run = (dir: string, body: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, PR_BODY: body, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });

  it('exits 1 on a rules bump without the line, 0 with it, 0 for an unrelated change, 2 without a base commit', () => {
    const bump = repo(src('2', "'race-core-2026.11.9'"));
    const same = repo(BASE);
    try {
      const fail = run(bump, 'no line');
      expect(fail.status).toBe(1);
      expect(fail.stdout).toContain('FAILED');
      expect(run(bump, `Bumps rules.\n\n${MARKER}\n`).status).toBe(0);
      expect(run(same, '').status).toBe(0);
      expect(run(same, '', 'HEAD~5').status).toBe(2);
    } finally { rmSync(bump, { recursive: true, force: true }); rmSync(same, { recursive: true, force: true }); }
  }, 30_000);
});
