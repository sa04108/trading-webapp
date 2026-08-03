import { describe, expect, it } from 'vitest';
import {
  collectTimeframeForSlice,
  coverageTimeframeForSlice,
  sliceForTimeframe,
  sliceTimeframes,
} from '../../src/server/modules/market-data/domain/dataset-slice.js';

describe('sliceTimeframes', () => {
  it('일봉 슬라이스는 1d 만, 분봉 슬라이스는 1m 과 1h 집계를 담는다', () => {
    expect(sliceTimeframes('1d')).toEqual(['1d']);
    expect(sliceTimeframes('1m')).toEqual(['1m', '1h']);
  });
});

describe('collectTimeframeForSlice / coverageTimeframeForSlice', () => {
  it('수집 봉은 슬라이스 키와 같고, 커버리지 기준은 분봉 슬라이스만 1h 다', () => {
    expect(collectTimeframeForSlice('1d')).toBe('1d');
    expect(collectTimeframeForSlice('1m')).toBe('1m');
    expect(coverageTimeframeForSlice('1d')).toBe('1d');
    expect(coverageTimeframeForSlice('1m')).toBe('1h');
  });
});

describe('sliceForTimeframe', () => {
  it('1m 과 1h 는 분봉 슬라이스, 1d 는 일봉 슬라이스다', () => {
    expect(sliceForTimeframe('1m')).toBe('1m');
    expect(sliceForTimeframe('1h')).toBe('1m');
    expect(sliceForTimeframe('1d')).toBe('1d');
  });
});

