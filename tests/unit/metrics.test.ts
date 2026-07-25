import { describe, expect, it } from 'vitest';
import {
  computeDrawdownStats,
  computeMetrics,
  computeMonthlyReturns,
} from '../../src/server/modules/backtest/domain/metrics.js';
import type { EquityPoint, Trade } from '../../src/server/modules/backtest/domain/types.js';

const DAY = 86_400_000;

function equitySeries(values: number[], startTs = Date.UTC(2026, 0, 1)): EquityPoint[] {
  return values.map((equity, i) => ({ tsMs: startTs + i * DAY, equity }));
}

function trade(netPnl: number, overrides: Partial<Trade> = {}): Trade {
  return {
    symbol: 'A',
    quantity: 1,
    entryTsMs: 0,
    exitTsMs: DAY,
    entryPrice: 100,
    exitPrice: 100 + netPnl,
    grossPnl: netPnl,
    costs: 0,
    netPnl,
    returnPct: netPnl,
    holdingTimeMs: DAY,
    ...overrides,
  };
}

describe('computeDrawdownStats (스펙 §9.6 MDD)', () => {
  it('finds max drawdown and duration', () => {
    // 100 → 120 → 90 → 95 → 130 : MDD = 90/120 - 1 = -25%
    const points = equitySeries([100, 120, 90, 95, 130]);
    const stats = computeDrawdownStats(points);
    expect(stats.maxDrawdownPct).toBeCloseTo(-25);
    expect(stats.maxDrawdownDurationMs).toBe(3 * DAY); // 120(peak) → 130(회복)
  });

  it('reports zero drawdown for monotonic growth', () => {
    const stats = computeDrawdownStats(equitySeries([100, 110, 120]));
    expect(stats.maxDrawdownPct).toBe(0);
  });
});

describe('computeMonthlyReturns', () => {
  it('computes month-over-month returns from equity', () => {
    const jan = Date.UTC(2026, 0, 31);
    const feb = Date.UTC(2026, 1, 28);
    const result = computeMonthlyReturns(
      [
        { tsMs: jan, equity: 110 },
        { tsMs: feb, equity: 99 },
      ],
      100,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ year: 2026, month: 1 });
    expect(result[0]!.returnPct).toBeCloseTo(10);
    expect(result[1]).toMatchObject({ year: 2026, month: 2 });
    expect(result[1]!.returnPct).toBeCloseTo(-10);
  });
});

describe('computeMetrics', () => {
  it('computes trade statistics', () => {
    const trades = [trade(10), trade(20), trade(-5), trade(-5), trade(-5), trade(30)];
    const metrics = computeMetrics(equitySeries([100, 145]), trades, [], 100, 2);

    expect(metrics.tradeCount).toBe(6);
    expect(metrics.winRate).toBeCloseTo(50);
    expect(metrics.profitFactor).toBeCloseTo(60 / 15);
    expect(metrics.avgWin).toBeCloseTo(20);
    expect(metrics.avgLoss).toBeCloseTo(-5);
    expect(metrics.maxConsecutiveWins).toBe(2);
    expect(metrics.maxConsecutiveLosses).toBe(3);
    expect(metrics.maxConcurrentPositions).toBe(2);
    expect(metrics.totalReturnPct).toBeCloseTo(45);
  });

  it('computes CAGR over a one-year horizon', () => {
    const points: EquityPoint[] = [
      { tsMs: Date.UTC(2025, 0, 1), equity: 100 },
      { tsMs: Date.UTC(2026, 0, 1), equity: 121 },
    ];
    const metrics = computeMetrics(points, [], [], 100, 0);
    expect(metrics.cagrPct).toBeCloseTo(21, 0);
  });
});
