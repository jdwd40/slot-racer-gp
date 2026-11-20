/**
 * The `window.__game` diagnostics hook (#146). The full hook drives the local UI (`advance`, `startSession`, `qaNetLobby`,
 * `netDrop`, `setLocalSlot`, ...) and is for QA scripts only. It is exposed only when one of these is true:
 *   * a dev server (`import.meta.env.DEV`),
 *   * a QA build (`VITE_QA=1`, or any value but '' / '0' / 'false'),
 *   * the page URL has the query flag `?qa=1` (what scripts/browser-check.mjs and scripts/online-check.mjs append).
 * Otherwise a default build (production, `VITE_ONLINE=1`) gets a minimal, frozen, read-only object: `screen`, `online`,
 * `preset`, `mode`, and `hook: 'minimal'`, with no setters and no functions. Every input is a parameter so it is unit-testable.
 */

/** why the full hook is on, or 'minimal' */
export type HookLevel = 'dev' | 'build' | 'url' | 'minimal';

/** the keys of the minimal production hook, besides `hook` */
export const MINIMAL_KEYS = ['screen', 'online', 'preset', 'mode'] as const;

const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && !['', '0', 'false'].includes(String(v).trim().toLowerCase());

/** Which hook this page gets: `env` is `import.meta.env`, `search` is `location.search`. */
export function hookLevel(env: { DEV?: boolean; VITE_QA?: unknown }, search: string): HookLevel {
  if (env.DEV) return 'dev';
  if (truthy(env.VITE_QA)) return 'build';
  if (new URLSearchParams(search).get('qa') === '1') return 'url';
  return 'minimal';
}

export interface MinimalSource { screen: () => unknown; online: () => unknown; preset: () => unknown; mode: () => unknown }

/** a deep-frozen copy, so a read of the minimal hook can never reach (or change) the game's own objects */
function frozenCopy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  const c = (Array.isArray(v) ? v.map(frozenCopy) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frozenCopy(x)]))) as T;
  return Object.freeze(c);
}

/** The minimal read-only hook: getters only (non-writable, non-configurable), on a frozen object. */
export function minimalHook(src: MinimalSource): Readonly<Record<(typeof MINIMAL_KEYS)[number] | 'hook', unknown>> {
  const o = {} as Record<string, unknown>;
  for (const k of MINIMAL_KEYS) Object.defineProperty(o, k, { get: () => frozenCopy(src[k]()), enumerable: true, configurable: false });
  Object.defineProperty(o, 'hook', { value: 'minimal', enumerable: true, writable: false, configurable: false });
  return Object.freeze(o) as Readonly<Record<(typeof MINIMAL_KEYS)[number] | 'hook', unknown>>;
}

/**
 * Install `__game` on `target` (the window): the full hook built by `full()` (only called when allowed, tagged with `hook`
 * set to the reason), or the minimal one. The property itself is non-writable and non-configurable, so page code cannot
 * swap the minimal hook for something else under the same name.
 */
export function installGameHook(target: object, level: HookLevel, full: () => object, src: MinimalSource): object {
  const value = level === 'minimal' ? minimalHook(src) : Object.defineProperty(full(), 'hook', { value: level, enumerable: true });
  Object.defineProperty(target, '__game', { value, enumerable: false, writable: false, configurable: false });
  return value;
}
