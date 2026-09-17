import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// 같은 회귀 검증을 Vitest 배포 게이트와 의존성 없는 node --test에서 모두 실행한다.
it('독립 Bash 배포의 정상·실패·복구 경로를 검증한다', () => {
  const result = spawnSync(process.execPath, ['--test', 'tests/deployment/deploy.test.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 110_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);
