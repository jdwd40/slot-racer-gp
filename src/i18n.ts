// Player-visible text goes through the platform translator; falls back to source text.
import strings from '../assets/ui/strings.json';

const SRC: Record<string, string> = {};
for (const s of (strings as { strings: { id: string; text: string }[] }).strings) SRC[s.id] = s.text;

interface L10n { t: (id: string, vars?: Record<string, string | number> | string) => string; onChange?: (cb: () => void) => void; locale?: () => string; }
function l10n(): L10n | undefined { return (window as unknown as { Tesana?: { l10n?: L10n } }).Tesana?.l10n; }

export function t(id: string, vars?: Record<string, string | number>): string {
  let out: string | undefined;
  try { const l = l10n(); if (l) out = vars ? l.t(id, vars) : l.t(id); } catch { out = undefined; }
  if (!out || out === id) {
    out = SRC[id] ?? id;
    if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}
export function onLangChange(cb: () => void): void { try { l10n()?.onChange?.(cb); } catch { /* ignore */ } }
