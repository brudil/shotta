import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The end-to-end test starts a server and a browser.
    testTimeout: 300_000,
  },
});
