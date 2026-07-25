import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    // better-sqlite3 등 네이티브 모듈은 워커 스레드보다 포크가 안전하다
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
