// Online availability gate for the browser game. Online play is OFF unless the build sets VITE_ONLINE=1, and even then it
// stays unavailable until the same-origin /api/health answers ok with exactly this client's protocol version. The default
// static build never contacts the server. No secret is part of the bundle: the endpoint is the page's own origin.
// A server that speaks a NEWER protocol means this page is an old cached bundle: it says so and offers a reload instead of
// hiding online play without a word (#67). It never connects with the old protocol, which the server would refuse anyway.
// A server that speaks an OLDER protocol (rolled back after a protocol bump, or not yet upgraded after the static client) is
// not this page's fault: reloading may fetch the same bundle again. The page says online play is temporarily unavailable,
// offers Retry (a fresh health probe) and re-probes now and then while the title is shown, so it recovers by itself (#80).
// The race rules are gated the same way once the protocol matches (#142): a server on NEWER rules is Reload, a server on
// OLDER rules (or one whose rules this page cannot read or order) is Retry. Protocol always wins over rules.
import { PROTOCOL_VERSION, RULES_VERSION } from './net/protocol';
import { LENGTH_IDS, type RaceLengthId } from './raceLength';
import { SETUP_IDS, type SetupId } from './carSetup';
import { t } from './i18n';

export type OnlineStatus =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string }
  /**
   * this page is older than the game server (health reports a newer protocol or newer rules, or the hello was refused):
   * reload to update. `server` is the server's protocol; `rules` (#142) the server's rules string when that is what differs.
   */
  | { state: 'outdated'; server: number | null; rules?: string }
  /**
   * the game server is older than this page (a server rollback, or the server not upgraded yet): retry later, no reload
   * (#80). `rules` (#142): set when protocols match but the rules do not (null: the server reported none this page can read).
   */
  | { state: 'behind'; server: number | null; rules?: string | null }
  | {
    state: 'available'; version: string; wsUrl: string; /** the server has a database: sign-in and driver profiles are offered */ accounts: boolean;
    /**
     * the race-length presets (#132) the server runs that this page knows, from health's `lengths`. A server older than
     * presets lists none: then only Standard is offered online and no length is ever sent to it (it would refuse the field).
     */
    lengths: RaceLengthId[];
    /**
     * the car-setup presets (#133) the server accepts that this page knows, from health's `setups`. A server older than setups
     * lists none: then the online menu shows no setup selector and no setup is ever sent to it (every car there is Balanced).
     */
    setups: SetupId[];
  };

export const ONLINE_ENABLED: boolean = import.meta.env.VITE_ONLINE === '1';

/** The `race-core-YYYY.MM.N` form every RULES_VERSION has used: year, month and a counter within the month. */
const RULES_RE = /^race-core-(\d{4})\.(\d{1,2})\.(\d{1,6})$/;

/**
 * How the server's race rules (from /api/health or `welcome`) stand against this page's (#142). `same`: equal strings.
 * `newer` / `older`: both in the `race-core-YYYY.MM.N` form and ordered by year, month, then counter (numerically, so
 * `…11.10` is newer than `…11.9`). `unknown`: anything else that differs (missing, not a string, another form): the caller
 * treats it as an older server (Retry), never as "a new version is available".
 */
export function compareRules(server: unknown, local: string = RULES_VERSION): 'same' | 'newer' | 'older' | 'unknown' {
  if (typeof server !== 'string' || server === '') return 'unknown';
  if (server === local) return 'same';
  const a = RULES_RE.exec(server), b = RULES_RE.exec(local);
  if (!a || !b) return 'unknown';
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0 ? 'newer' : 'older';
  }
  return 'unknown';   // the same numbers spelt differently (a leading zero): not equal, so not a match
}

/**
 * What a rules mismatch means for the online gate, once the protocols match: newer server rules make this page outdated
 * (Reload); older, missing or unreadable ones are the server's side (Retry). Null when the rules match.
 */
export function rulesStatus(server: unknown, local: string = RULES_VERSION): OnlineStatus | null {
  const c = compareRules(server, local);
  if (c === 'same') return null;
  if (c === 'newer') return { state: 'outdated', server: PROTOCOL_VERSION, rules: server as string };
  return { state: 'behind', server: PROTOCOL_VERSION, rules: typeof server === 'string' && server !== '' ? server : null };
}

/**
 * Probe the same-origin room service. Every input is a parameter so the gate is unit-testable; `rules` is this page's
 * RULES_VERSION (a test passes another to stand for a page built with other rules).
 */
export async function probeOnline(enabled: boolean, fetchFn: typeof fetch, origin: string, timeoutMs = 4000, rules: string = RULES_VERSION): Promise<OnlineStatus> {
  if (!enabled) return { state: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${origin}/api/health`, { signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return { state: 'unavailable', reason: `health ${r.status}` };
    const h = (await r.json()) as { ok?: unknown; protocol?: unknown; rules?: unknown; version?: unknown; accounts?: unknown; profiles?: unknown; lengths?: unknown; setups?: unknown };
    if (h.ok !== true) return { state: 'unavailable', reason: 'not ok' };
    if (typeof h.protocol === 'number' && h.protocol > PROTOCOL_VERSION) return { state: 'outdated', server: h.protocol };
    // an older server (rolled back, or the static client released before the server is upgraded): retry until it matches
    if (typeof h.protocol === 'number' && h.protocol < PROTOCOL_VERSION) return { state: 'behind', server: h.protocol };
    if (h.protocol !== PROTOCOL_VERSION) return { state: 'unavailable', reason: `protocol ${String(h.protocol)} (client ${PROTOCOL_VERSION})` };
    // the same protocol on other race rules (#142): never offered as available. A health body without `rules` (a server
    // older than the field) is not taken as a match either: Retry, like any older server
    const mismatch = rulesStatus(h.rules, rules);
    if (mismatch) return mismatch;
    const lengths = Array.isArray(h.lengths) ? LENGTH_IDS.filter((id) => (h.lengths as unknown[]).includes(id)) : [];
    const setups = Array.isArray(h.setups) ? SETUP_IDS.filter((id) => (h.setups as unknown[]).includes(id)) : [];
    return { state: 'available', version: String(h.version), wsUrl: origin.replace(/^http/, 'ws') + '/ws', accounts: h.accounts === true && h.profiles === true, lengths, setups };
  } catch (e) {
    return { state: 'unavailable', reason: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The title screen's notice for an outdated page: the reason and a Reload button (`#o-reload`, wired by main.ts). */
export function outdatedHtml(): string {
  return `<div class="row net-outdated"><p class="modes net-off">${t('net.outdated')}</p><button class="cta" id="o-reload">${t('net.reload')}</button></div>`;
}

/**
 * What a hello refused for its protocol means, or a `welcome` on other race rules (#142: this page closed it rather than
 * enter a room). The refusal does not tell the client the server's protocol, so the caller re-probes /api/health and
 * passes the answer here: only a server that reports a NEWER protocol or newer rules makes this page outdated.
 * Anything else (an older server, a probe that fails, or one that now matches: the server changed again meanwhile) is the
 * temporary "unavailable, retry" notice, never "a new version is available".
 */
export function afterProtocolRefusal(probed: OnlineStatus): OnlineStatus {
  if (probed.state === 'outdated' || probed.state === 'behind') return probed;
  return { state: 'behind', server: null };
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
  return `<div class="row net-behind"><p class="modes net-off" role="status">${t('net.behind')}</p><button class="cta alt" id="o-retry">${t('net.retry')}</button></div>`;
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
