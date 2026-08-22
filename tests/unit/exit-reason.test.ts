import { describe, expect, it } from 'vitest';
import { exitReasonLabel } from '../../src/web/features/backtests/exit-reason.js';

describe('exitReasonLabel', () => {
  it('청산 사유 코드를 한국어로 표기한다', () => {
    expect(exitReasonLabel('STOP')).toBe('손절');
    expect(exitReasonLabel('TRAIL_STOP')).toBe('추적 익절');
    expect(exitReasonLabel('TAKE_PROFIT')).toBe('익절');
    expect(exitReasonLabel('TREND_END')).toBe('추세 반전');
    expect(exitReasonLabel('TIME')).toBe('보유 기간 만료');
    expect(exitReasonLabel('RSI_EXIT')).toBe('RSI 회복');
    expect(exitReasonLabel('DELISTED')).toBe('상장폐지');
    expect(exitReasonLabel('REBALANCE_EXIT')).toBe('리밸런스 유니버스 이탈');
    expect(exitReasonLabel('REBALANCE_TRIM')).toBe('리밸런스 비중 축소');
  });

  it('사유가 없으면 - 를 보여준다', () => {
    expect(exitReasonLabel(null)).toBe('-');
  });

  it('모르는 코드는 그대로 돌려준다 — 새 사유가 표시를 막지 않는다', () => {
    expect(exitReasonLabel('NEW_REASON')).toBe('NEW_REASON');
  });
});
