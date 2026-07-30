import { describe, expect, it } from 'vitest';
import {
  collectTimeframeForSlice,
  coverageTimeframeForSlice,
  defaultTimeframeFromLegacy,
  legacyConsumeDefault,
  sliceForTimeframe,
  sliceTimeframes,
  symbolsKey,
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

describe('legacyConsumeDefault', () => {
  it('timeframe 없는 저장된 요청의 소비 봉 — 분봉 데이터셋은 1h(기존 동작), 일봉은 1d', () => {
    expect(legacyConsumeDefault('1m')).toBe('1h');
    expect(legacyConsumeDefault('1d')).toBe('1d');
  });
});

describe('symbolsKey', () => {
  it('순서·중복과 무관하게 같은 구성은 같은 키다', () => {
    expect(symbolsKey(['000660', '005930', '005930'])).toBe('000660,005930');
    expect(symbolsKey(['005930', '000660'])).toBe('000660,005930');
  });
});

describe('defaultTimeframeFromLegacy', () => {
  it('기존 1h 종류는 분봉 기본, 1d/1m 은 그대로다', () => {
    expect(defaultTimeframeFromLegacy('1h')).toBe('1m');
    expect(defaultTimeframeFromLegacy('1d')).toBe('1d');
    expect(defaultTimeframeFromLegacy('1m')).toBe('1m');
  });
});
