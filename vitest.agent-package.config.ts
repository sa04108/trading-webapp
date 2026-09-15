import { defineConfig } from 'vitest/config';

// 배포 산출물을 먼저 만든 릴리스 검증에서만 명시적으로 실행한다.
export default defineConfig({
  test: {
    include: ['tests/integration/packaged-agent-runtime.check.ts'],
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
