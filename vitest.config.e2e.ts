import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/openclaw/**/*.test.ts'],
    testTimeout: 300_000, // 5 min per test (container cold start)
    hookTimeout: 60_000,
    fileParallelism: false, // run test files sequentially (01 → 02 → ...)
    sequence: {
      concurrent: false,
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // all files in one process → shared filesystem state
      },
    },
  },
});
