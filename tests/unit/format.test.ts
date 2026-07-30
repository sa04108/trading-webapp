import { describe, expect, it } from 'vitest';
import { datasetTimeframeLabel, timeframeLabel } from '../../src/web/lib/format.js';

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

describe('datasetTimeframeLabel', () => {
  it('1h 종류 데이터셋은 실체가 1분봉이므로 1분봉으로 표기한다', () => {
    expect(datasetTimeframeLabel('1h')).toBe('1분봉');
  });

  it('나머지는 timeframeLabel 과 같다', () => {
    expect(datasetTimeframeLabel('1m')).toBe('1분봉');
    expect(datasetTimeframeLabel('1d')).toBe('일봉');
  });
});
