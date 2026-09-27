import { defineConfig } from 'vitest/config';

// Integration tests against docker-compose.test.yml (see server/test/integration/README.md)
export default defineConfig({
  test: {
    include: ['test/integration/**/*.it.test.ts'],
    globalSetup: ['test/integration/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
