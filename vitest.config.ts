import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

// 한 테스트 실행의 소스 worker는 모두 동일한 코드 스냅샷의 버전을 사용한다.
process.env.QUANT_SOURCE_RUNTIME_VERSIONS = execFileSync(process.execPath, [path.resolve(import.meta.dirname, 'scripts/build-runtime-versions.mjs'), '--print'], { encoding: 'utf8' });

export default defineConfig({
  // Task 9 부터 웹 컴포넌트 markup 테스트(.test.tsx)가 생겨 vite.config.ts 와 같은 별칭이
  // 필요하다 — vitest 는 vite.config.ts 를 읽지 않으므로 여기서 다시 선언한다.
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/web'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.tsx',
      'tests/integration/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    // better-sqlite3 등 네이티브 모듈은 워커 스레드보다 포크가 안전하다
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
