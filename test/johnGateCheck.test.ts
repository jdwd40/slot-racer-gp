// The human checkpoint (#143, scripts/john-gate-check.mjs, docs/shipping.md): a PR that changes RULES_VERSION or
// PROTOCOL_VERSION fails without a `JOHN-OK: rules` line in its description; a PR that grows src/race.ts or src/main.ts by
// more than 20 net lines fails without `JOHN-OK: hubs`, unless it also lowers that hub's ceiling in test/hubSize.test.ts.
// Everything else passes. Fixture "diffs" are base/head file contents; the CLI also runs end to end on a merge commit.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HUBS_TAG, HUB_SLACK, RULES_TAG, ceilingsOf, check, hasTag, lineCount } from '../scripts/john-gate-check.mjs';

const proto = (protocol: string, rules: string) => `// header\nexport const PROTOCOL_VERSION = ${protocol};\nexport const RULES_VERSION = ${rules};\n`;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const l${i} = ${i};\n`).join('');
const hubTest = (race: number, main: number) => `const HUB_CEILINGS: Record<string, number> = {\n  'src/race.ts': ${race},\n  'src/main.ts': ${main},\n};\n`;

type Side = { protocol: string | null; hubTest: string | null; hubs: Record<string, string | null> };
const side = (o: { protocol?: string; race?: number; main?: number; ceil?: [number, number]; extra?: Record<string, string> } = {}): Side => ({
  protocol: o.protocol ?? proto('2', "'race-core-2026.11.8'"),
  hubTest: hubTest(...(o.ceil ?? [1828, 1404])),
  hubs: { 'src/race.ts': lines(o.race ?? 1778), 'src/main.ts': lines(o.main ?? 1354) },
});
const BASE = side();

describe('john gate (#143): rules', () => {
  it('fails a RULES_VERSION or PROTOCOL_VERSION change without JOHN-OK: rules and passes it with the tag', () => {
    for (const protocol of [proto('2', "'race-core-2026.11.9'"), proto('3', "'race-core-2026.11.8'")]) {
      const head = side({ protocol });
      const no = check({ base: BASE, head, body: 'Changes the physics.\n\nSERVER-DEPLOY: required\n' });
      expect(no.ok).toBe(false);
      expect(no.message).toContain(RULES_TAG);
      expect(no.message).toContain('needs-john');
      expect(check({ base: BASE, head, body: `Changes the physics.\r\n\r\n${RULES_TAG}\r\n` }).ok).toBe(true);
      // the hubs tag does not approve a rules change; a missing body fails closed
      expect(check({ base: BASE, head, body: HUBS_TAG }).ok).toBe(false);
      expect(check({ base: BASE, head, body: null }).ok).toBe(false);
    }
    expect(check({ base: BASE, head: side({ protocol: proto('2', "'race-core-2026.11.9'") }), body: '' }).rules)
      .toEqual(["RULES_VERSION 'race-core-2026.11.8' -> 'race-core-2026.11.9'"]);
  });

  it('a removed constant counts as changed; the real protocol.ts is read', () => {
    expect(check({ base: BASE, head: { ...BASE, protocol: 'export const PROTOCOL_VERSION = 2;\n' }, body: '' }).ok).toBe(false);
    expect(check({ base: BASE, head: { ...BASE, protocol: null }, body: '' }).ok).toBe(false);
    const real = readFileSync('src/net/protocol.ts', 'utf8');
    expect(check({ base: { ...BASE, protocol: real }, head: { ...BASE, protocol: real }, body: '' }).rules).toEqual([]);
  });
});

describe('john gate (#143): hubs', () => {
  it(`passes net growth of exactly ${HUB_SLACK} lines and fails ${HUB_SLACK + 1}, for each hub`, () => {
    expect(HUB_SLACK).toBe(20);
    for (const hub of ['race', 'main'] as const) {
      const at = (n: number) => side(hub === 'race' ? { race: 1778 + n } : { main: 1354 + n });
      expect(check({ base: BASE, head: at(20), body: '' }).ok).toBe(true);
      const over = check({ base: BASE, head: at(21), body: '' });
      expect(over.ok).toBe(false);
      expect(over.message).toContain(`src/${hub}.ts grows by 21 net lines`);
      expect(over.message).toContain(HUBS_TAG);
    }
  });

  it('net, not gross: a rewrite that adds 300 lines and removes 290 passes', () => {
    const head = side();
    head.hubs['src/race.ts'] = lines(1778 - 290) + 'x\n'.repeat(300);
    expect(check({ base: BASE, head, body: '' })).toMatchObject({ ok: true, hubs: [{ hub: 'src/race.ts', growth: 10, exempt: false }, { hub: 'src/main.ts', growth: 0, exempt: false }] });
  });

  it('hub growth over the slack passes with JOHN-OK: hubs (not with the rules tag)', () => {
    const head = side({ race: 1778 + 40, main: 1354 + 30 });
    expect(check({ base: BASE, head, body: `Big feature.\n\n- ${HUBS_TAG}\n` }).ok).toBe(true);
    expect(check({ base: BASE, head, body: RULES_TAG }).ok).toBe(false);
  });

  it('growth with a drop of that hub\'s own ceiling (a ratcheting extract) passes; a drop of the other hub\'s does not', () => {
    expect(check({ base: BASE, head: side({ race: 1778 + 30, ceil: [1820, 1404] }), body: '' }).ok).toBe(true);
    const wrong = check({ base: BASE, head: side({ main: 1354 + 30, ceil: [1700, 1404] }), body: '' });
    expect(wrong.ok).toBe(false);
    expect(wrong.message).toContain('src/main.ts');
    // a raised ceiling is no exemption
    expect(check({ base: BASE, head: side({ race: 1778 + 30, ceil: [1900, 1404] }), body: '' }).ok).toBe(false);
  });

  it('reads ceilings from the real test/hubSize.test.ts and counts lines like it does', () => {
    const real = ceilingsOf(readFileSync('test/hubSize.test.ts', 'utf8'));
    expect(real['src/race.ts']).toBeGreaterThan(0);
    expect(real['src/main.ts']).toBeGreaterThan(0);
    expect(ceilingsOf('')).toEqual({ 'src/race.ts': null, 'src/main.ts': null });
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(1);
    expect(lineCount(null)).toBeNull();
  });
});

describe('john gate (#143): PRs that need no sign-off', () => {
  it('passes a docs-only PR and a new-module PR (src/fuelLaps.ts style) with an empty body', () => {
    // docs-only: no protocol, hub or ceiling change
    expect(check({ base: BASE, head: side(), body: '' })).toMatchObject({ ok: true, rules: [] });
    // a new module with a few lines of wiring in each hub
    expect(check({ base: BASE, head: side({ race: 1778 + 6, main: 1354 + 12 }), body: null }).ok).toBe(true);
    // shrinking a hub with a ratchet
    expect(check({ base: BASE, head: side({ race: 1500, ceil: [1550, 1404] }), body: '' }).ok).toBe(true);
  });

  it('a hub that is not on the base is skipped', () => {
    const base = { ...BASE, hubs: { 'src/race.ts': null, 'src/main.ts': lines(1354) } };
    expect(check({ base, head: side({ race: 5000 }), body: '' }).ok).toBe(true);
  });

  it('a tag must stand on its own line (bullets, quotes and case are fine)', () => {
    for (const ok of [RULES_TAG, `  ${RULES_TAG}  `, `- ${RULES_TAG}`, `> ${RULES_TAG}`, 'john-ok: RULES', `intro\n\n${RULES_TAG}\nmore`, 'JOHN-OK:rules'])
      expect(hasTag(ok, 'rules'), ok).toBe(true);
    for (const no of ['', 'Waiting for JOHN-OK: rules', 'JOHN-OK: rules?', 'JOHN-OK: rules and hubs', 'JOHN OK: rules', 'JOHN-OK: hubs', undefined, null, 42])
      expect(hasTag(no, 'rules'), String(no)).toBe(false);
  });
});

describe('john gate CLI on a merge commit (#143)', () => {
  const script = path.resolve('scripts/john-gate-check.mjs');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe' });
  function write(dir: string, s: Side) {
    mkdirSync(path.join(dir, 'src/net'), { recursive: true });
    mkdirSync(path.join(dir, 'test'), { recursive: true });
    writeFileSync(path.join(dir, 'src/net/protocol.ts'), s.protocol!);
    writeFileSync(path.join(dir, 'test/hubSize.test.ts'), s.hubTest!);
    for (const [f, src] of Object.entries(s.hubs)) writeFileSync(path.join(dir, f), src!);
  }
  function repo(head: Side): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'jgc-'));
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, BASE);
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'pr');
    write(dir, head);
    writeFileSync(path.join(dir, 'other.txt'), 'x');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'pr');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    return dir;
  }
  const run = (dir: string, body: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, PR_BODY: body, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });

  it('exits 1 on hub growth or a rules bump without the tag, 0 with it, 0 for an unrelated change, 2 without a base commit', () => {
    const grow = repo(side({ main: 1354 + 21 }));
    const bump = repo(side({ protocol: proto('2', "'race-core-2026.11.9'") }));
    const same = repo(BASE);
    try {
      const fail = run(grow, 'no tag');
      expect(fail.status).toBe(1);
      expect(fail.stdout).toContain('FAILED');
      expect(run(grow, `Grows main.\n\n${HUBS_TAG}\n`).status).toBe(0);
      expect(run(bump, '').status).toBe(1);
      expect(run(bump, `${RULES_TAG}\n`).status).toBe(0);
      expect(run(same, '').status).toBe(0);
      expect(run(same, '', 'HEAD~5').status).toBe(2);
    } finally { for (const d of [grow, bump, same]) rmSync(d, { recursive: true, force: true }); }
  }, 30_000);
});
