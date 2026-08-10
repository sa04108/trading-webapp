import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * `facts:sync` 는 Task 11 에서 CLI 전용 경로 자체를 지웠다 — 재무·자본변동은 백테스트
 * 준비(preparation)가 필요한 만큼만 자동으로 수집한다(스펙 2026-08-09). 이 테스트는
 * 명령이 사용법에서 사라졌을 뿐 아니라 실제로 호출해도 "지원하지 않는 명령"으로 막히는지
 * 실행 결과로 확인한다 — usage 문자열만 grep 하면 코드가 남아 있어도 통과할 수 있다.
 */
describe('cli facts:sync 제거', () => {
  it('facts:sync 는 지원하지 않는 명령으로 처리되고 --symbols 안내가 남지 않는다', () => {
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/server/cli.ts', 'facts:sync'],
      { encoding: 'utf8' },
    );
    expect(cli.status).toBe(1);
    expect(`${cli.stdout}${cli.stderr}`).toContain('지원하지 않는 명령');
    expect(`${cli.stdout}${cli.stderr}`).not.toContain('--symbols');
  });
});
