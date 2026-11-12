// Online availability gate for the browser game. Online play is OFF unless the build sets VITE_ONLINE=1, and even then it
// stays unavailable until the same-origin /api/health answers ok with exactly this client's protocol version. The default
// static build never contacts the server. No secret is part of the bundle: the endpoint is the page's own origin.
// A server that speaks a NEWER protocol means this page is an old cached bundle: it says so and offers a reload instead of
// hiding online play without a word (#67). It never connects with the old protocol, which the server would refuse anyway.
// A server that speaks an OLDER protocol (rolled back after a protocol bump, or not yet upgraded after the static client) is
// not this page's fault: reloading may fetch the same bundle again. The page says online play is temporarily unavailable,
// offers Retry (a fresh health probe) and re-probes now and then while the title is shown, so it recovers by itself (#80).
import { PROTOCOL_VERSION } from './net/protocol';
import { t } from './i18n';

export type OnlineStatus =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string }
  /** this page is older than the game server (health reports a newer protocol, or the hello was refused): reload to update */
  | { state: 'outdated'; server: number | null }
  /** the game server is older than this page (a server rollback, or the server not upgraded yet): retry later, no reload (#80) */
  | { state: 'behind'; server: number | null }
  | { state: 'available'; version: string; wsUrl: string; /** the server has a database: sign-in and driver profiles are offered */ accounts: boolean };

export const ONLINE_ENABLED: boolean = import.meta.env.VITE_ONLINE === '1';

/** Probe the same-origin room service. Every input is a parameter so the gate is unit-testable. */
export async function probeOnline(enabled: boolean, fetchFn: typeof fetch, origin: string, timeoutMs = 4000): Promise<OnlineStatus> {
  if (!enabled) return { state: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${origin}/api/health`, { signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return { state: 'unavailable', reason: `health ${r.status}` };
    const h = (await r.json()) as { ok?: unknown; protocol?: unknown; version?: unknown; accounts?: unknown; profiles?: unknown };
    if (h.ok !== true) return { state: 'unavailable', reason: 'not ok' };
    if (typeof h.protocol === 'number' && h.protocol > PROTOCOL_VERSION) return { state: 'outdated', server: h.protocol };
    // an older server (rolled back, or the static client released before the server is upgraded): retry until it matches
    if (typeof h.protocol === 'number' && h.protocol < PROTOCOL_VERSION) return { state: 'behind', server: h.protocol };
    if (h.protocol !== PROTOCOL_VERSION) return { state: 'unavailable', reason: `protocol ${String(h.protocol)} (client ${PROTOCOL_VERSION})` };
    return { state: 'available', version: String(h.version), wsUrl: origin.replace(/^http/, 'ws') + '/ws', accounts: h.accounts === true && h.profiles === true };
  } catch (e) {
    return { state: 'unavailable', reason: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The title screen's notice for an outdated page: the reason and a Reload button (`#o-reload`, wired by main.ts). */
export function outdatedHtml(): string {
  return `<div class="row net-outdated"><p class="modes net-off"><small>${t('net.outdated')}</small></p><button class="cta" id="o-reload">${t('net.reload')}</button></div>`;
}

/**
 * What a hello refused for its protocol means. The refusal does not tell the client the server's protocol, so the caller
 * re-probes /api/health and passes the answer here: only a server that reports a NEWER protocol makes this page outdated.
 * Anything else (an older server, a probe that fails, or one that now matches: the server changed again meanwhile) is the
 * temporary "unavailable, retry" notice, never "a new version is available".
 */
export function afterProtocolRefusal(probed: OnlineStatus): OnlineStatus {
  if (probed.state === 'outdated') return probed;
  return { state: 'behind', server: probed.state === 'behind' ? probed.server : null };
}

/**
 * A Retry press or a periodic re-check while the older-server notice shows: available or outdated are taken as they are; a
 * probe that fails (the server restarting during the rollback) keeps the Retry notice rather than dropping the button.
 */
export function afterRetry(probed: OnlineStatus): OnlineStatus {
  if (probed.state === 'available' || probed.state === 'outdated' || probed.state === 'behind') return probed;
  return { state: 'behind', server: null };
}

/** The title screen's notice for an older game server: temporarily unavailable, and a Retry button (`#o-retry`, wired by main.ts). */
export function behindHtml(): string {
  return `<div class="row net-behind"><p class="modes net-off" role="status"><small>${t('net.behind')}</small></p><button class="cta alt" id="o-retry">${t('net.retry')}</button></div>`;
}

/** How often, and how many times, the title re-probes health while it shows the "temporarily unavailable" notice. */
export const RECHECK_MS = 45_000;
export const RECHECK_MAX = 20;

/**
 * Re-probe health every `everyMs` while `keep()` holds (the title is shown with the `behind` notice), at most `max` times.
 * Each answer goes to `apply`; the loop stops once the answer is anything but `behind`, `keep()` fails or `max` is reached,
 * and then calls `done`. Returns a function that stops it early. One probe at a time: the next waits for the previous one.
 */
export function startRecheck(probe: () => Promise<OnlineStatus>, apply: (st: OnlineStatus) => void, keep: () => boolean,
  done: () => void = () => {}, everyMs = RECHECK_MS, max = RECHECK_MAX): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false, tries = 0;
  const stop = (): void => { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); timer = null; done(); };
  const tick = (): void => {
    timer = null;
    if (stopped) return;
    if (!keep()) { stop(); return; }
    tries++;
    void probe().then((st) => {
      if (stopped) return;
      if (!keep()) { stop(); return; }
      apply(st);
      if (st.state !== 'behind' || tries >= max) stop(); else timer = setTimeout(tick, everyMs);
    });
  };
  timer = setTimeout(tick, everyMs);
  return stop;
}
