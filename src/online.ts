// Online availability gate for the browser game. Online play is OFF unless the build sets VITE_ONLINE=1, and even then it
// stays unavailable until the same-origin /api/health answers ok with exactly this client's protocol version. The default
// static build never contacts the server. No secret is part of the bundle: the endpoint is the page's own origin.
// A server that speaks a NEWER protocol means this page is an old cached bundle: it says so and offers a reload instead of
// hiding online play without a word (#67). It never connects with the old protocol, which the server would refuse anyway.
import { PROTOCOL_VERSION } from './net/protocol';
import { t } from './i18n';

export type OnlineStatus =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string }
  /** this page is older than the game server (health reports a newer protocol, or the hello was refused): reload to update */
  | { state: 'outdated'; server: number | null }
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
    // an older server (the static client is released before the server is upgraded): local play only until it is
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
