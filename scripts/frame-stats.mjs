// Turns a per-frame browser trace into the numbers in docs/validation.md. Plain JS with no browser
// dependency, so the normal test suite covers it (test/frameStats.test.ts).

/** Reference-machine goal, fixed before any assessment. Absolute, so faster displays are not held to a tighter bar. */
export const GOAL = {
  medianMs: 17.5,        // a 60 Hz frame plus timer jitter
  p95Ms: 25,             // the odd missed vsync is fine, a steady stream is not
  p99Ms: 34,             // at most about 1% of frames miss more than one vsync
  gapsOver50PerMin: 1,   // a visible hitch at most once a minute
  minActiveSec: 60,      // a shorter sample cannot show any of this
};

/** One simulation step: the most the race clock may differ from kept wall time (docs/timing.md). */
export const CLOCK_TOLERANCE_SEC = 1 / 60 + 0.002;

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** Acceleration status from the WebGL renderer string. Hardware only means the browser did not report a software device. */
export function accelerationOf(renderer) {
  if (!renderer) return 'unavailable';
  return SOFTWARE.test(renderer) ? 'software' : 'hardware';
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stateOf(row) {
  if (row.screen === 'pause') return 'paused';
  if (row.screen !== 'race') return 'other';
  return row.phase === 'racing' ? 'racing' : row.phase === 'countdown' ? 'countdown' : 'other';
}

const round = (n, dp = 3) => (n === null ? null : +n.toFixed(dp));

/**
 * rows: one per animation callback, { ts (ms), screen, phase, raceTime (s), dropped (s, or null on builds without the stepper) }.
 * A gap is active only if both ends are racing, so countdowns, pauses and the frames either side of them never count.
 */
export function summarise(rows) {
  const gaps = [];
  let activeMs = 0, raceSec = 0, droppedSec = rows.some((r) => r.dropped === null) ? null : 0;
  let countdownMs = 0, pausedMs = 0, otherMs = 0, pauses = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i], gap = b.ts - a.ts;
    const sa = stateOf(a), sb = stateOf(b);
    if (sb === 'paused' && sa !== 'paused') pauses++;
    if (sa === 'racing' && sb === 'racing') {
      gaps.push(gap); activeMs += gap; raceSec += b.raceTime - a.raceTime;
      if (droppedSec !== null) droppedSec += b.dropped - a.dropped;
    } else if (sa === 'paused' || sb === 'paused') pausedMs += gap;
    else if (sa === 'countdown' || sb === 'countdown') countdownMs += gap;
    else otherMs += gap;
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const wallSec = activeMs / 1000;
  return {
    measurementSec: round(rows.length ? (rows[rows.length - 1].ts - rows[0].ts) / 1000 : 0),
    countdownSec: round(countdownMs / 1000),
    pauses: { count: pauses, wallSec: round(pausedMs / 1000) },
    otherSec: round(otherMs / 1000),
    active: {
      frames: gaps.length,
      wallSec: round(wallSec),
      raceSec: round(raceSec),
      droppedSec: round(droppedSec),
      // what the policy cannot explain: wall time that was neither raced nor dropped by the 250 ms rule
      clockErrorSec: droppedSec === null ? null : round(raceSec - (wallSec - droppedSec)),
      frameMs: {
        median: round(percentile(sorted, 50), 1),
        p95: round(percentile(sorted, 95), 1),
        p99: round(percentile(sorted, 99), 1),
        max: round(sorted[sorted.length - 1] ?? null, 1),
      },
      gapsOver50: gaps.filter((g) => g > 50).length,
      gapsOver250: gaps.filter((g) => g > 250).length,
    },
  };
}

/** Assess the goal. Only a run on a reported hardware renderer may be met or not met; anything else stays unavailable. */
export function assessGoal(summary, acceleration) {
  if (acceleration !== 'hardware') return { status: 'unavailable', reasons: [`${acceleration} renderer: diagnostic only, not evidence of real-time smoothness`] };
  const a = summary.active, misses = [];
  if (a.wallSec < GOAL.minActiveSec) return { status: 'unavailable', reasons: [`only ${a.wallSec} s active, goal needs ${GOAL.minActiveSec} s`] };
  if (a.frameMs.median > GOAL.medianMs) misses.push(`median ${a.frameMs.median} > ${GOAL.medianMs} ms`);
  if (a.frameMs.p95 > GOAL.p95Ms) misses.push(`p95 ${a.frameMs.p95} > ${GOAL.p95Ms} ms`);
  if (a.frameMs.p99 > GOAL.p99Ms) misses.push(`p99 ${a.frameMs.p99} > ${GOAL.p99Ms} ms`);
  const perMin = a.gapsOver50 / (a.wallSec / 60);
  if (perMin > GOAL.gapsOver50PerMin) misses.push(`${round(perMin, 2)} gaps over 50 ms per minute > ${GOAL.gapsOver50PerMin}`);
  return { status: misses.length ? 'not met' : 'met', reasons: misses };
}

const COMPARED = ['machine', 'os', 'browser', 'renderer', 'viewport', 'dpr', 'drawingBuffer', 'track', 'car', 'camera', 'workload'];

/** Which identity fields stop two perf reports being like for like. The preset is left out: the baseline has none, so the drawing buffer stands in. */
export function comparisonGaps(a, b) {
  return COMPARED.filter((k) => JSON.stringify(a.environment[k]) !== JSON.stringify(b.environment[k]));
}
