import { describe, expect, it, vi } from 'vitest';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import type {
  BacktestRunInput,
  BacktestRunResult,
} from '../../src/server/modules/backtest/domain/engine.js';
import {
  measureBacktestArtifact,
  type BacktestResultArtifact,
} from '../../src/server/modules/backtest/application/backtest-result-artifact.js';
import { BacktestRunner } from '../../src/server/modules/backtest/application/backtest-runner.js';

function engineResult(cancelled = false): BacktestRunResult {
  return {
    metrics: {
      initialCash: 1_000,
      finalEquity: 1_100,
      totalReturnPct: 10,
      cagrPct: 10,
      maxDrawdownPct: -5,
      maxDrawdownDurationMs: 0,
      volatilityPct: 2,
      sharpe: 1,
      sortino: 1,
      calmar: 2,
      winRate: 100,
      profitFactor: null,
      avgWin: 100,
      avgLoss: null,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 0,
      tradeCount: 1,
      avgHoldingTimeMs: 86_400_000,
      maxConcurrentPositions: 1,
      totalCommission: 1,
      totalTax: 2,
      totalSlippage: 3,
    },
    openPositions: [{
      symbol: '005930',
      quantity: 1,
      avgEntryPrice: 100,
      entryTsMs: 1,
      lastPrice: 110,
      lastPriceTsMs: 2,
      unrealizedPnl: 10,
      returnPct: 10,
    }],
    equityPoints: [{ tsMs: 1, equity: 1_100 }],
    drawdownPoints: [{ tsMs: 1, drawdown: -0.05 }],
    trades: [{
      symbol: '005930',
      quantity: 1,
      entryTsMs: 1,
      exitTsMs: 2,
      entryPrice: 100,
      exitPrice: 110,
      grossPnl: 10,
      costs: 1,
      netPnl: 9,
      returnPct: 9,
      holdingTimeMs: 1,
      exitReason: 'TEST',
    }],
    fills: [],
    monthlyReturns: [{ year: 2026, month: 1, returnPct: 10 }],
    warnings: ['engine warning'],
    cancelled,
    processedBars: 10,
    delistingLiquidations: [],
  };
}

describe('BacktestRunner', () => {
  it('계산 결과를 저장소 독립 artifact로 만들고 입력 경고를 앞에 합친다', async () => {
    const execute = vi.fn(async () => engineResult());
    const runner = new BacktestRunner(execute);

    const outcome = await runner.run(
      {} as AnyTradingStrategy,
      {} as BacktestRunInput,
      {},
      ['input warning'],
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('COMPLETED');
    if (outcome.status !== 'COMPLETED') throw new Error('expected completed outcome');
    expect(outcome.artifact).toMatchObject({
      schemaVersion: 1,
      processedBars: 10,
      warnings: ['input warning', 'engine warning'],
    });
    expect(outcome.artifact).not.toHaveProperty('fills');
    expect(outcome.artifact).not.toHaveProperty('cancelled');
  });

  it('취소 결과는 저장 가능한 artifact를 만들지 않는다', async () => {
    const runner = new BacktestRunner(async () => engineResult(true));
    const outcome = await runner.run(
      {} as AnyTradingStrategy,
      {} as BacktestRunInput,
      {},
    );

    expect(outcome).toEqual({ status: 'CANCELLED', processedBars: 10 });
    expect(outcome).not.toHaveProperty('artifact');
  });
});

describe('measureBacktestArtifact', () => {
  it('전체 결과 직렬화 없이 저장 행 수와 payload 크기를 계측한다', () => {
    const result = engineResult();
    const artifact: BacktestResultArtifact = {
      schemaVersion: 1,
      metrics: result.metrics,
      openPositions: result.openPositions,
      equityPoints: result.equityPoints,
      drawdownPoints: result.drawdownPoints,
      trades: result.trades,
      monthlyReturns: result.monthlyReturns,
      warnings: result.warnings,
      processedBars: result.processedBars,
    };

    expect(measureBacktestArtifact(artifact)).toEqual(expect.objectContaining({
      rowCount: 6,
      equityPointCount: 1,
      drawdownPointCount: 1,
      tradeCount: 1,
      monthlyReturnCount: 1,
      openPositionCount: 1,
      estimatedPayloadBytes: expect.any(Number),
    }));
    expect(measureBacktestArtifact(artifact).estimatedPayloadBytes).toBeGreaterThan(160);
  });
});
