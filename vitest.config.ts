import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

// 한 테스트 실행의 소스 worker는 모두 동일한 코드 스냅샷의 버전을 사용한다.
process.env.QUANT_SOURCE_RUNTIME_VERSIONS = execFileSync(process.execPath, [path.resolve(import.meta.dirname, 'scripts/build-runtime-versions.mjs'), '--print'], { encoding: 'utf8' });

export default defineConfig({
  // 웹 테스트도 제품과 같은 모듈 별칭을 사용한다.
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/web'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/provider-network-guard.ts'],
    // better-sqlite3 등 네이티브 모듈은 워커 스레드보다 포크가 안전하다
    pool: 'forks',
    isolate: true,
    retry: 0,
    allowOnly: false,
    passWithNoTests: false,
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          include: ['tests/component/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
