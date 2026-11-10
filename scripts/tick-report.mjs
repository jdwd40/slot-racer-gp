// Turns /api/health readings taken during a workload into tick statistics for that workload (#54). Used by load-check.mjs;
// tested in test/server/tickstats.test.ts. Health's `ticks` and `tickLag` carry a rolling 50-60 s window with an exact
// maximum, and process totals with their histogram buckets. So, for the workload between the first and last reading:
//  - count and p50/p95/p99 come from the difference of the total buckets: exactly the samples taken in between, at the
//    histogram's resolution (a percentile is a bucket upper bound, at most ~9% above the true value);
//  - the max is the largest exact maximum of the rolling windows read during the workload. As long as readings are less
//    than 50 s apart those windows cover every sample in between, so no spike between two readings is lost (they can also
//    cover up to 60 s before the first reading: room setup, or other load on the server). It is never a decayed value.

/** Count per bucket upper bound: `b` minus `a` (both health `totalBuckets`, [upperMs, count] pairs). */
export function diffBuckets(a, b) {
  const before = new Map(a.map(([u, n]) => [u, n]));
  return b.map(([u, n]) => [u, n - (before.get(u) ?? 0)]).filter(([, n]) => n > 0);
}

/** p-quantile of [upperMs, count] buckets (ascending), capped at `maxMs`; 0 for none. */
export function bucketPercentile(buckets, p, maxMs = Infinity) {
  const total = buckets.reduce((s, [, n]) => s + n, 0);
  if (!total) return 0;
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (const [u, n] of buckets) { seen += n; if (seen >= rank) return Math.min(u, maxMs); }
  return Math.min(buckets.at(-1)[0], maxMs);
}

/**
 * Workload statistics for one duration metric (`ticks` or `tickLag`) from the first reading `h0`, the readings polled
 * during the workload and the last reading `h1` (also counted as a poll). Returns null if the server reports no such field.
 */
export function workloadDurations(key, h0, polls, h1) {
  if (!h0?.[key] || !h1?.[key]) return null;
  const d = diffBuckets(h0[key].totalBuckets, h1[key].totalBuckets);
  const maxMs = Math.max(0, ...[...polls, h1].map((h) => h[key]?.recent?.maxMs ?? 0));
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    count: h1[key].total.count - h0[key].total.count,
    p50Ms: r(bucketPercentile(d, 0.5, maxMs)), p95Ms: r(bucketPercentile(d, 0.95, maxMs)), p99Ms: r(bucketPercentile(d, 0.99, maxMs)),
    maxMs: r(maxMs),
    meanMs: r((h1[key].total.sumMs - h0[key].total.sumMs) / Math.max(1, h1[key].total.count - h0[key].total.count)),
  };
}
