import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookLevel, installGameHook, MINIMAL_KEYS, minimalHook } from '../src/qaHook';

// #146: the full window.__game diagnostics hook only in a dev server, a VITE_QA build or with ?qa=1
const FULL_ONLY = ['advance', 'startSession', 'showTitle', 'qaNetLobby', 'qaNetResult', 'netDrop', 'setLocalSlot', 'setView', 'zoom', 'race', 'net', 'input'];
const fullHook = () => Object.fromEntries(FULL_ONLY.map((k) => [k, () => k]));
const src = (state: { screen: string; online: { state: string; reason?: string }; preset: string; mode: string }) =>
  ({ screen: () => state.screen, online: () => state.online, preset: () => state.preset, mode: () => state.mode });

describe('debug hook gate (#146)', () => {
  it('a production build (no DEV, no VITE_QA) without the flag gets the minimal hook', () => {
    // what Vite puts in import.meta.env for `VITE_ONLINE=1 vite build`
    const prod = { DEV: false, PROD: true, MODE: 'production', VITE_ONLINE: '1' };
    for (const search of ['', '?', '?qa=0', '?qa=true', '?qa=', '?QA=1', '?xqa=1', '?foo=qa=1']) expect(hookLevel(prod, search)).toBe('minimal');
    for (const v of [undefined, '', '0', 'false', 'FALSE', ' 0 ']) expect(hookLevel({ DEV: false, VITE_QA: v }, '')).toBe('minimal');
  });

  it('DEV, a truthy VITE_QA or ?qa=1 turn the full hook on', () => {
    expect(hookLevel({ DEV: true }, '')).toBe('dev');
    expect(hookLevel({ DEV: false, VITE_QA: '1' }, '')).toBe('build');
    expect(hookLevel({ DEV: false, VITE_QA: 'yes' }, '')).toBe('build');
    expect(hookLevel({ DEV: false }, '?qa=1')).toBe('url');
    expect(hookLevel({ DEV: false }, '?lang=en&qa=1')).toBe('url');
  });

  it('the minimal hook: only screen, online, preset, mode and hook; live, read-only and frozen, no functions', () => {
    const state = { screen: 'title', online: { state: 'unavailable', reason: 'x' }, preset: 'low', mode: 'race' };
    const win: Record<string, unknown> = {};
    let built = false;
    const g = installGameHook(win, 'minimal', () => { built = true; return fullHook(); }, src(state)) as Record<string, unknown>;
    expect(built).toBe(false);
    expect(win.__game).toBe(g);
    expect(Object.keys(g).sort()).toEqual([...MINIMAL_KEYS, 'hook'].sort());
    for (const k of FULL_ONLY) expect(k in g).toBe(false);
    for (const k of Object.keys(g)) expect(typeof g[k]).not.toBe('function');
    expect(g.hook).toBe('minimal');
    expect(g.screen).toBe('title');
    state.screen = 'race';
    expect(g.screen).toBe('race');
    expect(Object.isFrozen(g)).toBe(true);
    expect(() => { g.screen = 'title'; }).toThrow(TypeError);
    expect(() => { g.advance = () => 0; }).toThrow(TypeError);
    expect(() => { delete g.mode; }).toThrow(TypeError);
    // a nested object is a frozen copy: the game's own status cannot be reached through the hook
    const on = g.online as { state: string };
    expect(on).not.toBe(state.online);
    expect(() => { on.state = 'hacked'; }).toThrow(TypeError);
    expect(state.online.state).toBe('unavailable');
    // the window property itself cannot be replaced or redefined
    expect(() => { win.__game = fullHook(); }).toThrow(TypeError);
    expect(() => Object.defineProperty(win, '__game', { value: {} })).toThrow(TypeError);
    expect(win.__game).toBe(g);
  });

  it('the full hook when allowed, tagged with the reason', () => {
    for (const level of ['dev', 'build', 'url'] as const) {
      const win: Record<string, unknown> = {};
      const g = installGameHook(win, level, fullHook, src({ screen: 'title', online: { state: 'off' }, preset: 'low', mode: 'race' })) as Record<string, unknown>;
      for (const k of FULL_ONLY) expect(typeof g[k]).toBe('function');
      expect(g.hook).toBe(level);
    }
  });

  it('minimalHook copies arrays and objects deeply', () => {
    const online = { state: 'available', lengths: ['sprint'] };
    const g = minimalHook({ screen: () => 'title', online: () => online, preset: () => 'low', mode: () => 'race' }) as { online: { lengths: string[] } };
    expect(Object.isFrozen(g.online.lengths)).toBe(true);
    expect(g.online.lengths).not.toBe(online.lengths);
  });

  it('main.ts sets window.__game only through the gate, from import.meta.env and location.search', () => {
    const main = readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
    expect(main).toContain('installGameHook(window, hookLevel(import.meta.env, location.search),');
    expect(main.match(/installGameHook\(/g)).toHaveLength(1);
    expect(main).not.toMatch(/\.__game\s*=/);
    expect(main).not.toMatch(/['"]__game['"]/);
  });
});
