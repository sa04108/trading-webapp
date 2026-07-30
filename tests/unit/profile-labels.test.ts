import { describe, expect, it } from 'vitest';
import {
  costProfileLabel,
  slippageProfileLabel,
} from '../../src/web/features/backtests/profile-labels.js';

describe('costProfileLabel', () => {
  it('수수료·세율을 퍼센트로 표기한다', () => {
    expect(
      costProfileLabel({ buyCommissionRate: 0.00015, sellCommissionRate: 0.00015, sellTaxRate: 0.0015 }),
    ).toBe('수수료 0.015% · 매도세 0.15%');
  });

  it('매수·매도 수수료가 다르면 나눠 적는다', () => {
    expect(
      costProfileLabel({ buyCommissionRate: 0.0001, sellCommissionRate: 0.0002, sellTaxRate: 0.0015 }),
    ).toBe('수수료 매수 0.01% · 매도 0.02% · 매도세 0.15%');
  });

  it('전부 0 이면 무비용으로 표기한다', () => {
    expect(
      costProfileLabel({ buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 }),
    ).toBe('무비용');
  });
});

describe('slippageProfileLabel', () => {
  it('bp 로 표기한다', () => {
    expect(slippageProfileLabel({ bps: 5, fixed: 0 })).toBe('5bp');
  });

  it('고정 성분이 있으면 함께 적는다', () => {
    expect(slippageProfileLabel({ bps: 5, fixed: 3 })).toBe('5bp + 3원');
  });

  it('전부 0 이면 무슬리피지로 표기한다', () => {
    expect(slippageProfileLabel({ bps: 0, fixed: 0 })).toBe('무슬리피지');
  });
});
