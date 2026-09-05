import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  formatPreparationResumeTime,
  isPreparingCurrentParams,
  pollInterval,
  preparationJobQueryKey,
  seedPreparationJob,
  shouldCloseStream,
  type BacktestPreparationJob,
} from '../../src/web/features/backtests/preparation-live.js';

describe('pollInterval (SSE 실패 시 폴백 규칙 — useBacktestLive 와 같다)', () => {
  it('SSE 가 끊기고 종료되지 않은 상태면 2초를 준다', () => {
    expect(pollInterval('RUNNING', true)).toBe(2_000);
    expect(pollInterval('WAITING_DAILY_QUOTA', true)).toBe(2_000);
    expect(pollInterval('QUEUED', true)).toBe(2_000);
  });

  it('SSE 가 살아 있으면 폴링하지 않는다', () => {
    expect(pollInterval('RUNNING', false)).toBe(false);
  });

  it('종료 상태면 SSE 가 끊겨도 폴링하지 않는다', () => {
    expect(pollInterval('COMPLETED', true)).toBe(false);
    expect(pollInterval('FAILED', true)).toBe(false);
    expect(pollInterval('CANCELLED', true)).toBe(false);
  });

  it('아직 job 이 없으면(null) 폴링하지 않는다', () => {
    expect(pollInterval(null, true)).toBe(false);
  });
});

describe('shouldCloseStream', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    '%s 는 종료 상태라 스트림을 닫는다',
    (status) => {
      expect(shouldCloseStream(status)).toBe(true);
    },
  );

  it.each(['QUEUED', 'RUNNING', 'WAITING_DAILY_QUOTA'] as const)(
    '%s 는 진행 중이라 스트림을 유지한다',
    (status) => {
      expect(shouldCloseStream(status)).toBe(false);
    },
  );
});

/**
 * "미리보기" 버튼을 잠글지 판정하는 순수 함수 — 코디네이터 리뷰 finding 1의
 * 회귀를 막는다. rule A로 미리보기를 눌러 job이 WAITING_DAILY_QUOTA로 넘어간
 * 채(다음 KST 자정까지) 사용자가 rule B로 바꾸면, 그 job은 이제 지금 값과
 * 무관한 낡은 요청이라 버튼을 잠글 이유가 없다 — 잠그면 브리프의 "새 hash로
 * 다시 미리보기를 누르면 새 job 또는 queue를 받는다" 를 어긴다.
 */
describe('isPreparingCurrentParams', () => {
  const paramsA = { rule: 'A' };
  const paramsB = { rule: 'B' };
  const paramsEqual = (a: typeof paramsA, b: typeof paramsA): boolean => a.rule === b.rule;

  it('추적 중인 job 이 없으면 false', () => {
    expect(isPreparingCurrentParams(null, paramsA, 'RUNNING', paramsEqual)).toBe(false);
  });

  it('다른 파라미터로 시작된 job 이면 진행 중이어도 false — 버튼을 잠그지 않는다', () => {
    expect(isPreparingCurrentParams(paramsA, paramsB, 'WAITING_DAILY_QUOTA', paramsEqual)).toBe(
      false,
    );
    expect(isPreparingCurrentParams(paramsA, paramsB, 'RUNNING', paramsEqual)).toBe(false);
    expect(isPreparingCurrentParams(paramsA, paramsB, 'QUEUED', paramsEqual)).toBe(false);
  });

  it('같은 파라미터 + non-terminal 이면 true', () => {
    expect(isPreparingCurrentParams(paramsA, paramsA, 'QUEUED', paramsEqual)).toBe(true);
    expect(isPreparingCurrentParams(paramsA, paramsA, 'RUNNING', paramsEqual)).toBe(true);
    expect(isPreparingCurrentParams(paramsA, paramsA, 'WAITING_DAILY_QUOTA', paramsEqual)).toBe(
      true,
    );
  });

  it('같은 파라미터여도 terminal 이면 false', () => {
    expect(isPreparingCurrentParams(paramsA, paramsA, 'COMPLETED', paramsEqual)).toBe(false);
    expect(isPreparingCurrentParams(paramsA, paramsA, 'FAILED', paramsEqual)).toBe(false);
    expect(isPreparingCurrentParams(paramsA, paramsA, 'CANCELLED', paramsEqual)).toBe(false);
  });

  it('job 상태를 모르면 조회 실패일 수 있으므로 버튼을 잠그지 않는다', () => {
    expect(isPreparingCurrentParams(paramsA, paramsA, null, paramsEqual)).toBe(false);
  });
});

describe('seedPreparationJob', () => {
  it('202 응답의 job을 상세 조회 전 같은 query key에서 읽을 수 있게 한다', () => {
    const client = new QueryClient();
    const job: BacktestPreparationJob = {
      id: 'prep_1',
      requestHash: 'hash_1',
      status: 'QUEUED',
      phase: 'MARKET_DATA',
      overallProgress: 0,
      doneSymbols: 0,
      totalSymbols: 0,
      savedFacts: 0,
      gapCount: 0,
      nextResumeAtMs: null,
      error: null,
    };

    seedPreparationJob(client, job);

    expect(client.getQueryData(preparationJobQueryKey(job.id))).toEqual({ job });
  });
});

describe('formatPreparationResumeTime', () => {
  it('null 이면 알 수 없음으로 표시한다', () => {
    expect(formatPreparationResumeTime(null)).toBe('알 수 없음');
  });

  it('KST 기준 재개 시각을 표시한다', () => {
    // 2026-08-11 00:00 KST == 2026-08-10 15:00 UTC
    const tsMs = Date.UTC(2026, 7, 10, 15, 0, 0);
    const formatted = formatPreparationResumeTime(tsMs);
    expect(formatted).toContain('KST');
    expect(formatted).toContain('11');
    expect(formatted).toContain('00:00');
  });
});
