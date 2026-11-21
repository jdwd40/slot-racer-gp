import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // the simulation is deterministic once Math.random is seeded, so no retries
    retry: 0,
    testTimeout: 60000,
    // `npm run test:coverage` (#145): measured, never enforced. No thresholds here on purpose: the first figures are in
    // docs/validation.md and a floor is a later decision. Off unless --coverage is given, so `npm test` is unchanged. The
    // script also lifts the per-test timeout: v8 coverage slows the long simulation sweeps (one took 82 s against the 60 s).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'server/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // the figures still reach the log when a test fails (the job is red then anyway)
      reportOnFailure: true,
    },
  },
});
