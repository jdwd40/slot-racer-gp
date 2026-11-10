// Bounded duration statistics for the room tick loop (#54): exact maxima and histogram percentiles that a poller cannot
// miss. The decayed `tickLoadMs` in rooms.ts is a recent-load signal for admission; it forgets a spike within seconds, so
// reports read these instead. Memory is fixed (a few KiB, whatever the uptime or tick count) and recording one sample is
// one Math.log2 and two array writes, cheap enough for every 10 ms tick on the 1-vCPU host.

/** Bucket resolution: 8 buckets per doubling, so a reported percentile is at most ~9% above the true value. */
const PER_OCTAVE = 8;
/** Smallest resolved duration (ms); anything shorter counts in bucket 0. */
const MIN_MS = 0.001;
/** 1 µs × 2^32 ≈ 71 minutes: no tick is ever longer, and longer samples are clamped into the last bucket. */
const BUCKETS = 32 * PER_OCTAVE;

const index = (ms: number): number => (ms <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.floor(Math.log2(ms / MIN_MS) * PER_OCTAVE)));
/** Upper bound of a bucket (ms): the value a percentile in it is reported as (never below the true value). */
export const bucketUpperMs = (i: number): number => MIN_MS * 2 ** ((i + 1) / PER_OCTAVE);

export interface DurationSummary {
  /** samples (ticks) in this window */
  count: number;
  /** percentiles: the upper bound of the histogram bucket holding that rank (at most ~9% high), capped at maxMs */
  p50Ms: number; p95Ms: number; p99Ms: number;
  /** the exact largest sample, never decayed, sampled or averaged */
  maxMs: number;
  meanMs: number;
  /** sum of all samples (ms): with count, readings can be subtracted to get an interval's exact mean */
  sumMs: number;
}

/** A fixed-size log-bucketed histogram with an exact count, sum and maximum. */
export class Histogram {
  readonly counts = new Float64Array(BUCKETS);
  count = 0;
  sumMs = 0;
  maxMs = 0;

  record(ms: number): void {
    if (!(ms >= 0)) return;   // NaN or negative (a clock step backwards): not a duration
    this.counts[index(ms)]++;
    this.count++; this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  reset(): void { this.counts.fill(0); this.count = 0; this.sumMs = 0; this.maxMs = 0; }

  add(o: Histogram): void {
    for (let i = 0; i < BUCKETS; i++) this.counts[i] += o.counts[i];
    this.count += o.count; this.sumMs += o.sumMs;
    if (o.maxMs > this.maxMs) this.maxMs = o.maxMs;
  }

  percentile(p: number): number {
    if (!this.count) return 0;
    const rank = Math.max(1, Math.ceil(p * this.count));
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= rank) return Math.min(bucketUpperMs(i), this.maxMs);
    }
    return this.maxMs;
  }

  summary(): DurationSummary {
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return {
      count: this.count, p50Ms: r(this.percentile(0.5)), p95Ms: r(this.percentile(0.95)), p99Ms: r(this.percentile(0.99)),
      maxMs: r(this.maxMs), meanMs: r(this.count ? this.sumMs / this.count : 0), sumMs: r(this.sumMs),
    };
  }

  /** Non-empty buckets as [upper bound ms, count]: two readings can be subtracted to get exact counts for the interval. */
  buckets(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < BUCKETS; i++) if (this.counts[i]) out.push([Math.round(bucketUpperMs(i) * 1e6) / 1e6, this.counts[i]]);
    return out;
  }
}

/**
 * Durations over two windows:
 *  - `total`: every sample since the process started (never reset, so readers cannot reset each other's view);
 *  - `recent`: a rolling window of `slots` slots of `slotMs` (wall clock, the manager's injectable `now`). A sample stays
 *    in it for at least (slots - 1) × slotMs and at most slots × slotMs: with the defaults, 50 to 60 s. Any poller reading
 *    more often than every 50 s therefore sees every spike in some report, with its exact maximum.
 * Slots age by time, not by samples, so an idle period with no ticks (no rooms) empties the recent window on its own.
 */
export class DurationStats {
  readonly total = new Histogram();
  private ring: Histogram[];
  /** the slot number (floor(now / slotMs)) each ring entry holds */
  private slotOf: number[];

  constructor(private now: () => number, readonly slotMs = 10_000, readonly slots = 6) {
    this.ring = Array.from({ length: slots }, () => new Histogram());
    this.slotOf = new Array<number>(slots).fill(-Infinity);
  }

  get windowMs(): number { return this.slotMs * this.slots; }

  record(ms: number): void {
    const s = Math.floor(this.now() / this.slotMs), k = ((s % this.slots) + this.slots) % this.slots;
    if (this.slotOf[k] !== s) { this.ring[k].reset(); this.slotOf[k] = s; }
    this.ring[k].record(ms);
    this.total.record(ms);
  }

  /** The recent window as one histogram (built per read: health is polled every few seconds, ticks every 10 ms). */
  recent(): Histogram {
    const s = Math.floor(this.now() / this.slotMs), h = new Histogram();
    for (let k = 0; k < this.slots; k++) if (this.slotOf[k] > s - this.slots && this.slotOf[k] <= s) h.add(this.ring[k]);
    return h;
  }
}
