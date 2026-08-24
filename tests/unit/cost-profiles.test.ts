import { describe, expect, it } from 'vitest';
import {
  getCostProfile,
  getSlippageProfile,
  sellTaxRateAt,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';

describe('kr-equity-default', () => {
  it.each([
    ['2019-06-02', 0.003],
    ['2019-06-03', 0.0025],
    ['2021-01-01', 0.0023],
    ['2023-01-01', 0.002],
    ['2024-01-01', 0.0018],
    ['2025-01-01', 0.0015],
    ['2026-01-01', 0.002],
  ])('%s 체결일의 매도세율을 적용한다', (date, expected) => {
    const profile = getCostProfile('kr-equity-default')!;
    expect(sellTaxRateAt(profile, Date.parse(`${date}T00:00:00Z`))).toBe(expected);
  });

  it('수수료율은 매수·매도 0.015% 그대로다', () => {
    const profile = getCostProfile('kr-equity-default');
    expect(profile?.buyCommissionRate).toBe(0.00015);
    expect(profile?.sellCommissionRate).toBe(0.00015);
  });
});

describe('fixed-5bps', () => {
  it('5bp 고정 슬리피지다', () => {
    const profile = getSlippageProfile('fixed-5bps');
    expect(profile?.bps).toBe(5);
    expect(profile?.fixed).toBe(0);
  });
});
