// Post-finish spectating (#135, docs/spectating.md): which car the camera follows once the local driver's own race is over.
// A view target only: it never changes who this browser drives (localId / the server seat), and nothing here touches a car.
// No DOM and no race mutation, so tests drive it with plain races.
import type { Car, DriverId, Race } from './race';

/** A car that can be watched: still racing. A finished, disqualified or retired car is not followed. */
export const watchable = (c: Car): boolean => c.status === 'running';

/**
 * Whether the local driver's view should switch to spectating now: their car is terminal (finished, DQ or DNF) while the race is
 * still open. `others` (the local race): only while another car is still running, since a local race with nobody left closes on
 * its own a moment later. Online every terminal driver spectates until the server's result, with or without cars left to follow.
 */
export function shouldSpectate(race: Race, me: Car | undefined, others: boolean): boolean {
  if (!me || race.practice || race.phase === 'done' || me.status === 'running') return false;
  return !others || race.cars.some((c) => c !== me && watchable(c));
}

export class Spectator {
  /** the spectator view is up (entered once per race, left on results, leave, restart or a new race) */
  active = false;
  /** the car the camera follows; null when no car is left running (then the whole track is shown, waiting for results) */
  target: DriverId | null = null;
  /** Whole track: the overview camera instead of following the target (the target stays selected) */
  whole = false;

  /** Start spectating: follow the leading car still running. */
  enter(race: Race): void {
    this.active = true; this.whole = false;
    this.target = this.lead(race);
  }

  /** Back to driving mode (results, leave, restart, a new race): no target survives. */
  reset(): void { this.active = false; this.target = null; this.whole = false; }

  /** The running cars in race order (leader first): the order Previous / Next walk through. */
  running(race: Race): Car[] { return race.order().filter(watchable); }

  lead(race: Race): DriverId | null { return this.running(race)[0]?.id ?? null; }

  /**
   * Keep the target while it is still running. When it finishes, retires or is gone, follow the car that was next behind it in
   * race order (else the new leader); with no car left running, follow nobody.
   */
  ensure(race: Race): void {
    if (!this.active) return;
    const cur = this.target ? race.car(this.target) : undefined;
    if (cur && watchable(cur)) return;
    const order = race.order();
    const at = cur ? order.indexOf(cur) : -1;
    const behind = at >= 0 ? order.slice(at + 1).find(watchable) : undefined;
    this.target = behind?.id ?? this.lead(race);
  }

  /** Previous (-1) or next (+1) running car in race order, wrapping; leaves Whole track for the chosen car. */
  step(race: Race, dir: -1 | 1): void {
    const run = this.running(race);
    if (!run.length) { this.target = null; return; }
    const i = run.findIndex((c) => c.id === this.target);
    this.target = run[i < 0 ? (dir > 0 ? 0 : run.length - 1) : (i + dir + run.length) % run.length].id;
    this.whole = false;
  }

  /** Follow this car (picked from the standings), if it is still running. */
  pick(race: Race, id: DriverId): boolean {
    const c = race.car(id);
    if (!c || !watchable(c)) return false;
    this.target = id; this.whole = false;
    return true;
  }

  /** The car the camera should follow now, or null for the whole track. */
  focus(race: Race): Car | null {
    if (this.whole || !this.target) return null;
    return race.car(this.target) ?? null;
  }
}
