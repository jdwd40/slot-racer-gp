import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // the simulation is deterministic once Math.random is seeded, so no retries
    retry: 0,
    testTimeout: 60000,
  },
});
