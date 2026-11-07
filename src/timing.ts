// Fixed-step simulation clock. requestAnimationFrame decides when we draw; this
// decides how much race time that wall time is worth. Policy: docs/timing.md.
export const STEP = 1 / 60;      // seconds per simulation step (Race.update runs it as two 1/120 s sub-steps)
export const MAX_GAP = 0.25;     // longest callback gap that counts in full; 2.5x the 100 ms of 10 FPS
/** per-callback catch-up limit: the remainder is under one step, so MAX_GAP can never owe more than this */
export const MAX_STEPS = Math.round(MAX_GAP / STEP);

export class FixedStepper {
  /** wall time banked towards the next step; always below STEP between callbacks, so no backlog can build */
  private acc = 0;
  private last: number | null = null;
  /** seconds of wall time thrown away by MAX_GAP (diagnostics only) */
  dropped = 0;

  /** how far presentation sits between the last two simulation states, 0..1 */
  get alpha(): number { return this.acc / STEP; }

  /** Forget the time baseline: the next callback counts zero elapsed time, so nothing before it is replayed. */
  rebase(): void { this.last = null; }

  /**
   * One animation callback. Runs every step owed while `active()` holds and returns how many ran.
   * If a step ends the simulated session the steps left over are dropped, not saved for later.
   */
  frame(now: number, active: () => boolean, step: (dt: number) => void): number {
    if (!active()) { this.rebase(); return 0; }
    const gap = this.last === null ? 0 : Math.max(0, (now - this.last) / 1000);
    this.last = now;
    const kept = Math.min(gap, MAX_GAP);
    this.dropped += gap - kept;
    this.acc += kept;
    let steps = 0;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      step(STEP);
      steps++;
      if (!active()) { this.acc %= STEP; this.rebase(); break; }
    }
    return steps;
  }
}

/** the drawn placement of a car; presentation only, never fed back into the simulation */
export interface Pose { x: number; y: number; z: number; h: number; roll: number; pitch: number; }

/** further than any car travels in one step (about 0.5): a marshal respawn or tow, which must not be drawn as a slide */
const SNAP_DIST = 2;

/** Placement `alpha` of the way from one simulation state to the next. */
export function blendPose(a: Pose, b: Pose, alpha: number): Pose {
  if ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 > SNAP_DIST ** 2) return b;
  const mix = (p: number, q: number): number => p + (q - p) * alpha;
  const turn = Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)); // shortest way round
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z), h: a.h + turn * alpha, roll: mix(a.roll, b.roll), pitch: mix(a.pitch, b.pitch) };
}
