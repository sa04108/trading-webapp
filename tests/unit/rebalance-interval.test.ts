import { describe, expect, it } from 'vitest';
import {
  addRebalanceInterval,
  computeRebalanceDates,
  rebalanceIntervalFitsPeriod,
} from '../../src/shared/schemas/rebalance-interval.js';

describe('addRebalanceInterval', () => {
  it('일·주·년 달력 주기를 UTC 기준으로 더한다', () => {
    expect(addRebalanceInterval('2025-01-31', { value: 1, unit: 'DAY' })).toBe('2025-02-01');
    expect(addRebalanceInterval('2025-01-31', { value: 1, unit: 'WEEK' })).toBe('2025-02-07');
    expect(addRebalanceInterval('2024-02-29', { value: 1, unit: 'YEAR' })).toBe('2025-02-28');
  });

  it('월말을 대상 월 말일로 clamp한다', () => {
    expect(addRebalanceInterval('2024-01-31', { value: 1, unit: 'MONTH' })).toBe('2024-02-29');
    expect(addRebalanceInterval('2025-01-31', { value: 1, unit: 'MONTH' })).toBe('2025-02-28');
  });

  it('매번 원래 anchor를 기준으로 월 주기를 더한다', () => {
    expect(addRebalanceInterval('2024-01-31', { value: 1, unit: 'MONTH' }, 2)).toBe('2024-03-31');
  });
});

describe('computeRebalanceDates', () => {
  it('기간 끝을 포함해 기준일 목록을 만든다', () => {
    expect(computeRebalanceDates(
      { from: '2025-01-01', to: '2025-01-15' },
      { value: 1, unit: 'WEEK' },
    )).toEqual(['2025-01-01', '2025-01-08', '2025-01-15']);
  });

  it('리밸런싱하지 않으면 최초 선정일만 만든다', () => {
    expect(computeRebalanceDates(
      { from: '2025-01-01', to: '2025-12-31' },
      { value: 1, unit: 'NONE' },
    )).toEqual(['2025-01-01']);
  });
});

describe('rebalanceIntervalFitsPeriod', () => {
  it('inclusive 기간과 같은 1일 주기를 허용한다', () => {
    expect(rebalanceIntervalFitsPeriod(
      { from: '2025-01-01', to: '2025-01-01' },
      { value: 1, unit: 'DAY' },
    )).toBe(true);
  });

  it('기간을 초과하는 주기를 거부한다', () => {
    expect(rebalanceIntervalFitsPeriod(
      { from: '2025-01-01', to: '2025-01-31' },
      { value: 2, unit: 'MONTH' },
    )).toBe(false);
  });

  it('리밸런싱하지 않는 선택은 기간 길이와 무관하게 허용한다', () => {
    expect(rebalanceIntervalFitsPeriod(
      { from: '2025-01-01', to: '2025-01-01' },
      { value: 1, unit: 'NONE' },
    )).toBe(true);
  });
});
