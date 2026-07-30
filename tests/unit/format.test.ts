import { describe, expect, it } from 'vitest';
import { timeframeLabel } from '../../src/web/lib/format.js';

describe('timeframeLabel', () => {
  it('봉 주기 코드를 한국어로 표기한다', () => {
    expect(timeframeLabel('1m')).toBe('1분봉');
    expect(timeframeLabel('1h')).toBe('1시간봉');
    expect(timeframeLabel('1d')).toBe('일봉');
  });

  it('모르는 코드는 그대로 돌려준다', () => {
    expect(timeframeLabel('5m')).toBe('5m');
  });
});
