import { describe, expect, it } from 'vitest';
import {
  formatPreparationResumeTime,
  pollInterval,
  shouldCloseStream,
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
