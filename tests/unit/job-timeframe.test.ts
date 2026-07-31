import { describe, expect, it } from 'vitest';
import { resolveJobTimeframe } from '../../src/web/features/backtests/job-timeframe.js';

/**
 * 요청이 유일한 출처다 — 데이터셋에서 `defaultTimeframe` 이 없어진 뒤(D-034) 폴백할
 * 근거가 사라졌다. 제출 검증이 해소한 값을 저장 요청에 박아 넣으므로 지금 만들어지는
 * 잡은 항상 이 필드를 갖는다.
 */
describe('resolveJobTimeframe', () => {
  it('요청의 timeframe 을 그대로 쓴다', () => {
    expect(resolveJobTimeframe({ request: { timeframe: '1m' } })).toBe('1m');
    expect(resolveJobTimeframe({ request: { timeframe: '1h' } })).toBe('1h');
    expect(resolveJobTimeframe({ request: { timeframe: '1d' } })).toBe('1d');
  });

  it('없으면 null — 없는 근거로 추측하지 않는다', () => {
    // 데이터셋의 defaultTimeframe 으로 폴백하던 자리다. 그 필드가 사라진 뒤 추측한 값을
    // "실제로 소비한 봉" 이라고 화면에 적으면 그게 더 나쁘다.
    expect(resolveJobTimeframe({ request: {} })).toBeNull();
  });
});
