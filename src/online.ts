// Online availability gate for the browser game. Online play is OFF unless the build sets VITE_ONLINE=1, and even then it
// stays unavailable until the same-origin /api/health answers ok with exactly this client's protocol version. The default
// static build never contacts the server. No secret is part of the bundle: the endpoint is the page's own origin.
import { PROTOCOL_VERSION } from './net/protocol';

export type OnlineStatus =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'unavailable'; reason: string }
  | { state: 'available'; version: string; wsUrl: string };

export const ONLINE_ENABLED: boolean = import.meta.env.VITE_ONLINE === '1';

/** Probe the same-origin room service. Every input is a parameter so the gate is unit-testable. */
export async function probeOnline(enabled: boolean, fetchFn: typeof fetch, origin: string, timeoutMs = 4000): Promise<OnlineStatus> {
  if (!enabled) return { state: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${origin}/api/health`, { signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return { state: 'unavailable', reason: `health ${r.status}` };
    const h = (await r.json()) as { ok?: unknown; protocol?: unknown; version?: unknown };
    if (h.ok !== true) return { state: 'unavailable', reason: 'not ok' };
    if (h.protocol !== PROTOCOL_VERSION) return { state: 'unavailable', reason: `protocol ${String(h.protocol)} (client ${PROTOCOL_VERSION})` };
    return { state: 'available', version: String(h.version), wsUrl: origin.replace(/^http/, 'ws') + '/ws' };
  } catch (e) {
    return { state: 'unavailable', reason: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
