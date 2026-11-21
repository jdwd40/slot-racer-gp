// The hub-size budget (#141): src/race.ts and src/main.ts are the two files every feature used to land in. They may not
// grow past these ceilings. New behaviour belongs in a subsystem module (src/menu/* for client screens, a module of its
// own beside src/race.ts for race rules), wired in from the hub. Each extract that shrinks a hub ratchets its ceiling down
// in the same PR, to the new line count plus a small slack (50 lines), so silent regrowth fails CI.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Line ceilings, updated by the extract PRs (README.md, "Where new code goes"). */
const HUB_CEILINGS: Record<string, number> = {
  'src/race.ts': 2402,
  'src/main.ts': 2380,
};

/** Lines as `wc -l` counts them: newline characters. */
const lineCount = (path: string): number => (readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').match(/\n/g) ?? []).length;

describe('hub-size budget (#141)', () => {
  for (const [path, max] of Object.entries(HUB_CEILINGS)) {
    it(`${path} stays within ${max} lines`, () => {
      expect(lineCount(path), `${path} is over its ceiling: move the new code into a module (or ratchet only after an extract)`).toBeLessThanOrEqual(max);
    });
  }
});
