// Personal-best ghost: records the player's lap as compact (t, u, d, yaw)
// samples and replays it through the track geometry, so lane changes, ramps
// and banking come out exactly as driven. The ghost is purely visual.
// No Three.js here (#147): this module is in the first (title) chunk. The ghost car's model is made by the 3D view
// (carModel.makeGhostCar) and attached once that chunk has loaded; until then the player keeps its data and draws nothing.
import * as T from './track';
import { Car } from './race';
import type { CarVisual } from './carModel';
import { GhostData, GHOST_HZ, GHOST_VERSION } from './records';

export class GhostRecorder {
  samples: number[] = [];
  t0 = 0; u0 = 0; lastT = -1;
  active = false;

  /** start a fresh recording at a timing-line crossing */
  start(c: Car): void {
    this.samples = []; this.t0 = c.lapStartT; this.u0 = T.FINISH_S + (c.crossed - 1) * T.L; this.lastT = -1; this.active = true;
    this.sample(c, c.lapStartT);
  }
  stop(): void { this.active = false; }
  sample(c: Car, raceTime: number): void {
    if (!this.active || c.mode === 'off' || c.mode === 'tow') return;
    const t = raceTime - this.t0;
    if (t - this.lastT < 1 / GHOST_HZ - 1e-6) return;
    this.lastT = t;
    this.samples.push(+t.toFixed(3), +(c.u - this.u0).toFixed(3), +c.d.toFixed(3), +c.yawOff.toFixed(3));
  }
  /** package the finished lap (called at the next crossing) */
  finish(c: Car, raceTime: number, track: string, car: string, initials: string, ms: number): GhostData {
    // the lap's own setup and tuning (#133): a ghost is only ever challenged with the same pair
    this.sample(c, raceTime);
    // final sample exactly on the line
    const dur = ms / 1000;
    this.samples.push(+dur.toFixed(3), +T.L.toFixed(3), +c.d.toFixed(3), 0);
    this.active = false;
    return { v: GHOST_VERSION, track, car, initials, L: +T.L.toFixed(3), ms: Math.round(ms), s: this.samples, setup: c.setup.id, tuning: c.setup.tuning };
  }
}

export class GhostPlayer {
  /** the ghost car's model, from the 3D view (null until that has loaded): see attach */
  visual: CarVisual | null = null;
  data: GhostData | null = null;
  t0 = -1;
  shown = true;
  private i = 0;

  /** Give the player its car model (carModel.makeGhostCar, already in the scene). Playback state is kept. */
  attach(visual: CarVisual): void { this.visual = visual; visual.group.visible = false; }

  setData(d: GhostData | null): void { this.data = d; this.t0 = -1; this.i = 0; }
  /** restart playback at the player's crossing time */
  launch(raceTime: number): void { this.t0 = raceTime; this.i = 0; }
  get running(): boolean { return this.data !== null && this.t0 >= 0; }

  update(raceTime: number, dt: number): void {
    if (!this.visual) return;
    const g = this.visual.group;
    if (!this.data || this.t0 < 0 || !this.shown) { g.visible = false; return; }
    const s = this.data.s;
    const n = s.length / 4;
    const t = raceTime - this.t0;
    while (this.i < n - 2 && s[(this.i + 1) * 4] <= t) this.i++;
    while (this.i > 0 && s[this.i * 4] > t) this.i--;
    const a = this.i * 4, b = Math.min(n - 1, this.i + 1) * 4;
    const ta = s[a], tb = s[b];
    const f = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
    const u = s[a + 1] + (s[b + 1] - s[a + 1]) * f;
    const d = s[a + 2] + (s[b + 2] - s[a + 2]) * f;
    const yaw = s[a + 3] + (s[b + 3] - s[a + 3]) * f;
    const sPos = T.FINISH_S + u;
    const p = T.point3(sPos, d);
    g.visible = true;
    g.position.set(p.x, p.z, -p.y);
    g.rotation.set(T.rollAt(sPos), p.h + yaw, Math.atan(T.slopeZ(sPos)), 'YXZ');
    const v = f < 1 && tb > ta ? (s[b + 1] - s[a + 1]) / (tb - ta) : 0;
    for (const w of this.visual.wheels) w.rotation.z -= (v * dt) / 0.12;
  }
}
