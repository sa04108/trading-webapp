import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // 백테스트 완료 대기(최대 90초) + 기간 전체 동기화 대기(최대 150초, mvp-flow.spec.ts
  // BACKFILL_WAIT_TIMEOUT_MS 참고) 를 한 테스트가 함께 쓸 수 있어야 한다. 옛
  // 120초 상한은 위저드가 날짜별 순차 동기화이던 시절(Task 4 이전) 값이다 —
  // 지금은 기간 전체를 백그라운드 백필로 한 번에 채우므로 실제 대기가 더 길다.
  timeout: 300_000,
  retries: 0,
  workers: 1, // 단일 서버 인스턴스 공유 + 동시 백테스트 1개 제약
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'pnpm exec tsx scripts/e2e-server.ts',
    url: 'http://127.0.0.1:3100/api/v1/health/live',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
