import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: { include: ['src/**/*.ts'], reporter: ['text-summary', 'lcov'] },
    // config.ts validates the environment on import: test-only values, no database is contacted
    env: {
      SESSION_SECRET: 'test-session-secret-with-at-least-32-chars',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      KNOWLEDGE_FS_ROOT: '/data/shares',
      LOG_LEVEL: 'silent',
    },
  },
});
