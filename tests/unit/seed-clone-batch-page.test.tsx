import { describe, expect, it } from 'vitest';
import { summarizeSeedCloneMetrics } from '../../src/web/features/backtests/seed-clone-batch-page.js';
import type { BacktestMetrics, SeedCloneBatchItem } from '../../src/web/features/backtests/types.js';

const metrics = (totalReturnPct: number): BacktestMetrics => ({
  initialCash: 1,
  finalEquity: 1,
  totalReturnPct,
  cagrPct: null,
  maxDrawdownPct: 0,
  maxDrawdownDurationMs: 0,
  volatilityPct: null,
  sharpe: null,
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
  it('완료 결과만으로 중앙값과 최고·최저 시드를 계산한다', () => {
    const summary = summarizeSeedCloneMetrics([
      item(10, 30),
      item(20, -10),
      item(30, 10),
      { ...item(40, 99), status: 'FAILED', metrics: null },
    ]);
    expect(summary).toEqual({
      count: 3,
      median: 10,
      min: -10,
      max: 30,
      worstSeed: 20,
      bestSeed: 10,
    });
  });
});
