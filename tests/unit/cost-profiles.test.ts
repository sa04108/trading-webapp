import { describe, expect, it } from 'vitest';
import {
  getCostProfile,
  getSlippageProfile,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';

describe('kr-equity-default', () => {
  it('2025년부터 적용된 증권거래세 0.15% 를 쓴다', () => {
    const profile = getCostProfile('kr-equity-default');
    expect(profile?.sellTaxRate).toBe(0.0015);
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
