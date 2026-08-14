import { describe, expect, it } from 'vitest';
import { resolveJobTimeframe } from '../../src/web/features/backtests/job-timeframe.js';

/** 저장된 요청의 봉 주기를 결과 화면에 표시한다. */
describe('resolveJobTimeframe', () => {
  it('요청의 timeframe 을 그대로 쓴다', () => {
    expect(resolveJobTimeframe({ request: { timeframe: '1d' } })).toBe('1d');
  });

  it('없으면 null — 없는 근거로 추측하지 않는다', () => {
    expect(resolveJobTimeframe({ request: {} })).toBeNull();
  });
});
