import { describe, expect, it } from 'vitest';
import {
  proceedsFromSell,
  requiredCashForBuy,
  roundToTick,
  simulateFill,
} from '../../src/server/modules/backtest/domain/execution.js';
import {
  getCostProfile,
  getKrxExecutionRules,
} from '../../src/server/modules/backtest/domain/cost-profiles.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';

const PROFILE: ExecutionProfile = {
  cost: {
    id: 'test',
    version: '1',
    buyCommissionRate: 0.001, // 0.1%
    sellCommissionRate: 0.001,
    sellTaxRate: 0.002, // 0.2%
  },
  slippage: { id: 'test', version: '1', bps: 10, fixed: 0 }, // 0.1%
  rules: { tickSize: 0, minOrderQty: 1 },
};

describe('simulateFill (스펙 §9.1 next-bar-open + §9.3 비용 모델)', () => {
  it('fills BUY above open by slippage and charges commission', () => {
    const fill = simulateFill({ symbol: 'A', side: 'BUY', quantity: 10 }, 10_000, 1, PROFILE);
    expect(fill.price).toBeCloseTo(10_010); // 10000 × (1 + 0.001)
    expect(fill.grossAmount).toBeCloseTo(100_100);
    expect(fill.commission).toBeCloseTo(100.1);
    expect(fill.tax).toBe(0);
    expect(fill.slippageCost).toBeCloseTo(100);
    expect(requiredCashForBuy(fill)).toBeCloseTo(100_200.1);
  });

  it('fills SELL below open and charges commission + tax', () => {
    const fill = simulateFill({ symbol: 'A', side: 'SELL', quantity: 10 }, 10_000, 1, PROFILE);
    expect(fill.price).toBeCloseTo(9_990);
    expect(fill.commission).toBeCloseTo(99.9);
    expect(fill.tax).toBeCloseTo(199.8);
    expect(proceedsFromSell(fill)).toBeCloseTo(99_900 - 99.9 - 199.8);
  });

  it('rounds BUY up and SELL down to tick size (최소 호가 단위)', () => {
    const withTick: ExecutionProfile = {
      ...PROFILE,
      rules: { tickSize: 50, minOrderQty: 1 },
    };
    const buy = simulateFill({ symbol: 'A', side: 'BUY', quantity: 1 }, 10_003, 1, withTick);
    expect(buy.price).toBe(10_050); // 10003×1.001=10013.003 → 50 단위 올림
    const sell = simulateFill({ symbol: 'A', side: 'SELL', quantity: 1 }, 10_003, 1, withTick);
    expect(sell.price).toBe(9_950); // 9992.997 → 50 단위 내림
  });

  it('applies fixed slippage', () => {
    const fixedSlip: ExecutionProfile = {
      ...PROFILE,
      slippage: { id: 'f', version: '1', bps: 0, fixed: 5 },
    };
    const fill = simulateFill({ symbol: 'A', side: 'BUY', quantity: 1 }, 1_000, 1, fixedSlip);
    expect(fill.price).toBe(1_005);
  });

  it('charges the historical sell tax rate at the fill timestamp', () => {
    const historical: ExecutionProfile = {
      ...PROFILE,
      cost: getCostProfile('kr-equity-default')!,
    };
    const beforeCut = simulateFill(
      { symbol: 'A', side: 'SELL', quantity: 1 },
      10_000,
      Date.parse('2024-12-26T00:00:00Z'),
      historical,
    );
    const afterCut = simulateFill(
      { symbol: 'A', side: 'SELL', quantity: 1 },
      10_000,
      Date.parse('2024-12-27T00:00:00Z'),
      historical,
    );
    expect(beforeCut.tax).toBe(Math.floor(beforeCut.grossAmount * 0.0018));
    expect(afterCut.tax).toBe(Math.floor(afterCut.grossAmount * 0.0015));
  });

  it('rounds with the historical KRX market-specific tick size', () => {
    const beforeChange = Date.parse('2023-01-24T00:00:00Z');
    const kospi = simulateFill(
      { symbol: 'A', side: 'BUY', quantity: 1 },
      150_001,
      beforeChange,
      { ...PROFILE, slippage: { ...PROFILE.slippage, bps: 0 }, rules: getKrxExecutionRules('KOSPI') },
    );
    const kosdaq = simulateFill(
      { symbol: 'A', side: 'BUY', quantity: 1 },
      150_001,
      beforeChange,
      { ...PROFILE, slippage: { ...PROFILE.slippage, bps: 0 }, rules: getKrxExecutionRules('KOSDAQ') },
    );
    expect(kospi.price).toBe(150_500);
    expect(kosdaq.price).toBe(150_100);
  });

  it('prefers the fill candle venue over the request-market fallback', () => {
    const beforeChange = Date.parse('2023-01-24T00:00:00Z');
    const fill = simulateFill(
      { symbol: 'A', side: 'BUY', quantity: 1 },
      150_001,
      beforeChange,
      { ...PROFILE, slippage: { ...PROFILE.slippage, bps: 0 }, rules: getKrxExecutionRules('KOSPI') },
      'KOSDAQ',
    );
    expect(fill.price).toBe(150_100);
  });
});

describe('roundToTick', () => {
  it('handles zero tick size as no-op', () => {
    expect(roundToTick(123.456, 0, 'up')).toBe(123.456);
  });
  it('rounds exact multiples to themselves', () => {
    expect(roundToTick(10_000, 50, 'up')).toBe(10_000);
    expect(roundToTick(10_000, 50, 'down')).toBe(10_000);
  });
});
