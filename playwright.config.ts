import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
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
