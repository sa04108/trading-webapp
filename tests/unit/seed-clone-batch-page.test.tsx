import { describe, expect, it } from 'vitest';
import { summarizeSeedCloneMetrics } from '../../src/web/features/backtests/seed-clone-statistics.js';
import type { BacktestMetrics, SeedCloneBatchItem } from '../../src/web/features/backtests/types.js';

const metrics = (
  totalReturnPct: number,
  sharpe: number | null = null,
  maxDrawdownPct = 0,
): BacktestMetrics => ({
  initialCash: 1,
  finalEquity: 1,
  totalReturnPct,
  cagrPct: null,
  maxDrawdownPct,
  maxDrawdownDurationMs: 0,
  volatilityPct: null,
  sharpe,
  sortino: null,
  calmar: null,
  winRate: null,
  profitFactor: null,
  avgWin: null,
  avgLoss: null,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  tradeCount: 0,
  avgHoldingTimeMs: null,
  maxConcurrentPositions: 0,
  totalCommission: 0,
  totalTax: 0,
  totalSlippage: 0,
});

const item = (seed: number, value: number): SeedCloneBatchItem => ({
  ordinal: seed,
  randomSeed: seed,
  jobId: `bt_${seed}`,
  status: 'COMPLETED',
  metrics: metrics(value),
});

describe('난수 시드 실험 지표 요약', () => {
  it('완료 결과만으로 수익률·Sharpe·MDD 분포를 계산한다', () => {
    const summary = summarizeSeedCloneMetrics([
      { ...item(10, 30), metrics: metrics(30, 1.5, -30) },
      { ...item(20, -10), metrics: metrics(-10, 0.5, -10) },
      { ...item(30, 10), metrics: metrics(10, null, -20) },
      { ...item(40, 99), status: 'FAILED', metrics: null },
    ]);
    expect(summary).toMatchObject({
      totalReturn: {
        count: 3,
        mean: 10,
        sampleStdDev: 20,
        median: 10,
        min: -10,
        max: 30,
      },
      sharpe: {
        count: 2,
        mean: 1,
        median: 1,
        min: 0.5,
        max: 1.5,
      },
      maxDrawdown: {
        count: 3,
        mean: -20,
        sampleStdDev: 10,
        median: -20,
        min: -30,
        max: -10,
      },
      worstSeed: 20,
      bestSeed: 10,
    });
    expect(summary?.sharpe?.sampleStdDev).toBeCloseTo(Math.SQRT1_2);
  });

  it('표본이 하나면 평균은 계산하고 표본 표준편차는 보류한다', () => {
    const summary = summarizeSeedCloneMetrics([
      { ...item(7, 12), metrics: metrics(12, 0.8, -5) },
    ]);
    expect(summary?.totalReturn).toMatchObject({ count: 1, mean: 12, sampleStdDev: null });
    expect(summary?.sharpe).toMatchObject({ count: 1, mean: 0.8, sampleStdDev: null });
  });

  it('완료된 지표가 없으면 요약하지 않는다', () => {
    expect(summarizeSeedCloneMetrics([
      { ...item(1, 1), status: 'RUNNING', metrics: null },
    ])).toBeNull();
  });
});
