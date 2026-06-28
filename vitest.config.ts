import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Browser tests are inherently slow — generous per-test timeout
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Tests share a browser instance so they must run sequentially
    sequence: {
      concurrent: false,
    },
    // Only look in tests/ directory
    include: ['tests/**/*.test.ts'],
  },
});
