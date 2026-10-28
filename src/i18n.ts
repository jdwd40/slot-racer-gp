// Player-visible text comes from the bundled string table (assets/ui/strings.json).
import strings from '../assets/ui/strings.json';

const SRC: Record<string, string> = {};
for (const s of (strings as { strings: { id: string; text: string }[] }).strings) SRC[s.id] = s.text;

/** Look up a string by id, substituting {name} placeholders; unknown ids fall back to the id itself. */
export function t(id: string, vars?: Record<string, string | number>): string {
  let out = SRC[id] ?? id;
  if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}
