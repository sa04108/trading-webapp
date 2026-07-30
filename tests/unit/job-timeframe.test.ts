import { describe, expect, it } from 'vitest';
import { resolveJobTimeframe } from '../../src/web/features/backtests/job-timeframe.js';

const datasets = [
  { id: 'ds_1h', defaultTimeframe: '1m' },
  { id: 'ds_1d', defaultTimeframe: '1d' },
];

describe('resolveJobTimeframe', () => {
  it('요청에 timeframe 이 있으면 그것을 쓴다', () => {
    const job = { datasetId: 'ds_1h', request: { timeframe: '1m' } };
    expect(resolveJobTimeframe(job, datasets)).toBe('1m');
  });

  it('요청에 없으면 defaultTimeframe 1m → 1h 로 폴백한다 — 엔진의 미지정 규칙과 같다', () => {
    const job = { datasetId: 'ds_1h', request: {} };
    expect(resolveJobTimeframe(job, datasets)).toBe('1h');
  });

  it('요청에 없으면 defaultTimeframe 1d → 1d 로 폴백한다', () => {
    const job = { datasetId: 'ds_1d', request: {} };
    expect(resolveJobTimeframe(job, datasets)).toBe('1d');
  });

  it('데이터셋도 못 찾으면 null', () => {
    const job = { datasetId: 'ds_deleted', request: {} };
    expect(resolveJobTimeframe(job, datasets)).toBeNull();
    expect(resolveJobTimeframe(job, undefined)).toBeNull();
  });
});
