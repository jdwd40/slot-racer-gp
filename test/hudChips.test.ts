// The chip list's cap for very short windows (#130 item 3): at most `cap` chips show, the last one counting the hidden rest.
import { describe, it, expect } from 'vitest';
import { capChips } from '../src/hud';

const chip = (s: string, cls = 'red'): string => `<span class="chip ${cls}">${s}</span>`;
const shown = (out: string[]): string[] => out.filter((c) => !c.includes(' hidden ')).map((c) => c.replace(/<[^>]+>/g, ''));

describe('capChips', () => {
  const five = ['A', 'B', 'C', 'D', 'E'].map((s) => chip(s));

  it('leaves the list alone with no cap or room for every chip', () => {
    expect(capChips(five, Infinity, false)).toEqual(five);
    expect(capChips(five, 5, true)).toEqual(five);
  });

  it('keeps the first cap - 1 chips in order and counts the rest on one more chip, never "+1"', () => {
    const out = capChips(five, 3, false);
    expect(shown(out)).toEqual(['A', 'B', '+3 MORE']);
    // hidden, not dropped: every chip's text is still there, in its place
    expect(out.slice(0, 5).map((c) => c.replace(/<[^>]+>/g, ''))).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(out.filter((c) => c.startsWith('<span hidden class="chip'))).toHaveLength(3);
    expect(shown(capChips(five.slice(0, 4), 3, false))).toEqual(['A', 'B', '+2 MORE']);
  });

  it('does not count the keyboard-only chip with touch, where it never shows', () => {
    const list = [chip('A'), chip('<kbd>N</kbd> DEFER', 'yel kbd-only'), chip('B'), chip('C')];
    expect(capChips(list, 3, true)).toEqual(list);
    expect(shown(capChips(list, 3, false))).toEqual(['A', 'N DEFER', '+2 MORE']);
  });
});
