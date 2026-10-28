// Initials, leaderboards, ghosts and championship persistence (localStorage replaced by a double).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as T from '../src/track';
import * as R from '../src/records';
import { memStorage } from './helpers';

beforeEach(() => { vi.stubGlobal('localStorage', memStorage()); T.setTrack('circuit-1'); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('initials', () => {
  it('normalises to up to three upper-case characters with "Annon" as the default', () => {
    expect(R.ANON).toBe('Annon');
    expect(R.normaliseInitials('')).toBe('Annon');
    expect(R.normaliseInitials('   ')).toBe('Annon');
    expect(R.normaliseInitials(' ab ')).toBe('AB');
    expect(R.normaliseInitials('abcd')).toBe('ABC');
  });
  it('round-trips through storage', () => {
    R.saveInitialsRaw(' jd ');
    expect(R.savedInitialsRaw()).toBe('jd');
    expect(R.currentInitials()).toBe('JD');
    expect(localStorage.getItem('srgp.initials')).toBe('"jd"');
  });
  it('falls back to Annon when nothing is stored', () => {
    expect(R.currentInitials()).toBe('Annon');
  });
});

describe('leaderboards', () => {
  it('keeps the ten fastest laps sorted ascending and reports whether a lap made the board', () => {
    const times = [52000, 48000, 60000, 45000, 47000, 49000, 51000, 53000, 55000, 57000, 59000, 46000];
    const made: boolean[] = [];
    for (const ms of times) made.push(R.submitLap('race', 'circuit-1', 'JD', 'sunburst', ms) !== null);
    const b = R.board('race', 'circuit-1');
    expect(b).toHaveLength(10);
    expect(b.map((x) => x.ms)).toEqual([45000, 46000, 47000, 48000, 49000, 51000, 52000, 53000, 55000, 57000]);
    expect(made[2]).toBe(true);   // 60000 made the board while it had room
    expect(made[10]).toBe(true);  // 59000 displaced 60000
    expect(made[11]).toBe(true);  // 46000 displaced 59000
    expect(R.submitLap('race', 'circuit-1', 'JD', 'sunburst', 61000)).toBeNull(); // slower than the tenth
    expect(R.board('race', 'circuit-1')).toHaveLength(10);
    expect(b.every((x) => x.initials === 'JD' && x.car === 'sunburst')).toBe(true);
  });
  it('keeps practice and race boards and circuits separate', () => {
    R.submitLap('practice', 'circuit-1', 'AB', 'blaze', 40000);
    R.submitLap('race', 'circuit-2', 'CD', 'frost', 41000);
    expect(R.board('race', 'circuit-1')).toHaveLength(0);
    expect(R.board('practice', 'circuit-1')[0].initials).toBe('AB');
    expect(R.board('race', 'circuit-2')[0].initials).toBe('CD');
    expect(localStorage.getItem('srgp.lb.practice.circuit-1')).not.toBeNull();
  });
  it('drops malformed stored rows', () => {
    localStorage.setItem('srgp.lb.race.circuit-1', JSON.stringify([{ id: 'a', initials: 'X', car: 'blaze', ms: 0, at: 1 }, null, { id: 'b', initials: 'Y', car: 'blaze', ms: 50000, at: 1 }, { id: 'c' }]));
    expect(R.board('race', 'circuit-1').map((x) => x.id)).toEqual(['b']);
  });
  it('formats lap times to the millisecond', () => {
    expect(R.fmtMs(65432)).toBe('1:05.432');
    expect(R.fmtMs(0)).toBe('–:––.–––');
  });
});

describe('ghosts', () => {
  const data: R.GhostData = { v: R.GHOST_VERSION, track: 'circuit-1', car: 'sunburst', initials: 'JD', L: +T.L.toFixed(3), ms: 42000, s: Array.from({ length: 16 }, (_, i) => i) };
  it('saves and loads a ghost for the same circuit, car and initials', () => {
    R.saveGhost(data);
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')).toEqual(data);
    expect(R.loadGhost('circuit-1', 'blaze', 'JD')).toBeNull();
    expect(R.loadGhost('circuit-1', 'sunburst', 'XX')).toBeNull();
  });
  it('rejects a ghost recorded on a different version or lap length', () => {
    R.saveGhost({ ...data, v: R.GHOST_VERSION + 1 });
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')).toBeNull();
    R.saveGhost({ ...data, L: data.L + 1 });
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')).toBeNull();
    R.saveGhost(data); R.clearGhost('circuit-1', 'sunburst', 'JD');
    expect(R.loadGhost('circuit-1', 'sunburst', 'JD')).toBeNull();
  });
});

describe('championship', () => {
  it('persists progress under srgp.champ and reports completion', () => {
    expect(R.loadChamp()).toBeNull();
    const c = R.newChamp('blaze', 'JD');
    expect(R.loadChamp()).toEqual(c);
    expect(R.champDone(c)).toBe(false);
    for (const track of R.CHAMP_TRACKS) c.rounds.push({ track, order: [] });
    R.saveChamp(c);
    expect(R.champDone(R.loadChamp()!)).toBe(true);
    R.clearChamp();
    expect(R.loadChamp()).toBeNull();
    expect(R.CHAMP_TRACKS).toHaveLength(4);
    expect(R.CHAMP_POINTS).toEqual([10, 6, 4, 2]);
  });
  it('awards points by finishing position and gives DNFs nothing', () => {
    const c = R.newChamp('blaze', 'JD');
    c.rounds.push({ track: 'circuit-1', order: [{ idx: 2, dnf: false, time: 1 }, { idx: 0, dnf: false, time: 2 }, { idx: 1, dnf: false, time: 3 }, { idx: 3, dnf: true, time: 0 }] });
    const st = R.standings(c, 4);
    expect(st.map((s) => [s.idx, s.points])).toEqual([[2, 10], [0, 6], [1, 4], [3, 0]]);
    expect(st[0].wins).toBe(1); expect(st[1].seconds).toBe(1);
  });
  it('breaks ties on wins, then second places, then the last round position', () => {
    const c = R.newChamp('blaze', 'JD');
    // round 1: 0 wins, 1 second; round 2: 1 wins, 0 second -> both 16 points, one win each, one second each
    c.rounds.push({ track: 'circuit-1', order: [{ idx: 0, dnf: false, time: 1 }, { idx: 1, dnf: false, time: 2 }, { idx: 2, dnf: false, time: 3 }, { idx: 3, dnf: false, time: 4 }] });
    c.rounds.push({ track: 'circuit-2', order: [{ idx: 1, dnf: false, time: 1 }, { idx: 0, dnf: false, time: 2 }, { idx: 3, dnf: false, time: 3 }, { idx: 2, dnf: false, time: 4 }] });
    let st = R.standings(c, 4);
    expect(st[0].idx).toBe(1); // last-round position decides
    expect(st[1].idx).toBe(0);
    // round 3: 2 wins, 3 second, 0 third, 1 fourth -> 0:20, 1:18, 2:16, 3:12
    c.rounds.push({ track: 'circuit-4', order: [{ idx: 2, dnf: false, time: 1 }, { idx: 3, dnf: false, time: 2 }, { idx: 0, dnf: false, time: 3 }, { idx: 1, dnf: false, time: 4 }] });
    st = R.standings(c, 4);
    expect(st.map((s) => s.idx)).toEqual([0, 1, 2, 3]);
    expect(st.map((s) => s.points)).toEqual([20, 18, 16, 12]);
    // equal points and wins: more second places rank higher
    const d = R.newChamp('blaze', 'JD');
    d.rounds.push({ track: 'circuit-1', order: [{ idx: 0, dnf: false, time: 1 }, { idx: 1, dnf: false, time: 2 }, { idx: 2, dnf: false, time: 3 }, { idx: 3, dnf: false, time: 4 }] });
    d.rounds.push({ track: 'circuit-2', order: [{ idx: 1, dnf: false, time: 1 }, { idx: 2, dnf: false, time: 2 }, { idx: 0, dnf: false, time: 3 }, { idx: 3, dnf: false, time: 4 }] });
    d.rounds.push({ track: 'circuit-4', order: [{ idx: 2, dnf: false, time: 1 }, { idx: 0, dnf: false, time: 2 }, { idx: 1, dnf: false, time: 3 }, { idx: 3, dnf: false, time: 4 }] });
    // 0: 10+4+6=20 (1 win, 1 second); 1: 6+10+4=20 (1 win, 1 second); 2: 4+6+10=20 (1 win, 1 second) -> last round decides: 2, 0, 1
    expect(R.standings(d, 4).map((s) => s.idx)).toEqual([2, 0, 1, 3]);
  });
});
