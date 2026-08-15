import type { DatabaseHandle } from '../../../shared/db/database.js';
import {
  backtestDrawdownPoints,
  backtestEquityPoints,
  backtestMetrics,
  backtestMonthlyReturns,
  backtestRuns,
  backtestTrades,
} from '../../../shared/db/schema.js';
import { newId } from '../../../shared/ids.js';
import type {
  BacktestResultArtifact,
  BacktestResultWriteContext,
  BacktestResultWriter,
} from '../application/backtest-result-artifact.js';

/** 결과 artifact를 현재 조회 스키마에 원자적으로 import하는 로컬 adapter. */
export class SqliteBacktestResultWriter implements BacktestResultWriter {
  constructor(private readonly handle: DatabaseHandle) {}

  write(context: BacktestResultWriteContext, artifact: BacktestResultArtifact): void {
    const db = this.handle.db;
    const insertResults = this.handle.sqlite.transaction(() => {
      db.insert(backtestRuns)
        .values({
          id: newId('run'),
          jobId: context.jobId,
          strategyId: context.strategyId,
          strategyVersion: context.strategyVersion,
          strategySourceHash: context.strategySourceHash,
          parameterJson: context.parameterJson,
          universeRuleJson: context.universeRuleJson,
          scheduleHash: context.scheduleHash,
          universeJson: context.universeJson,
          universeHash: context.universeHash,
          engineVersion: context.engineVersion,
          feeModelVersion: context.feeModelVersion,
          slippageModelVersion: context.slippageModelVersion,
          randomSeed: context.randomSeed,
          gitCommitSha: context.gitCommitSha,
          provenancePinJson: context.provenancePinJson,
          warningsJson: JSON.stringify(artifact.warnings),
          openPositionsJson: JSON.stringify(artifact.openPositions),
          startedAtMs: context.startedAtMs,
          completedAtMs: context.completedAtMs,
        })
        .run();

      db.insert(backtestMetrics)
        .values({
          jobId: context.jobId,
          totalReturnPct: artifact.metrics.totalReturnPct,
          cagrPct: artifact.metrics.cagrPct,
          maxDrawdownPct: artifact.metrics.maxDrawdownPct,
          sharpe: artifact.metrics.sharpe,
          winRate: artifact.metrics.winRate,
          tradeCount: artifact.metrics.tradeCount,
          metricsJson: JSON.stringify(artifact.metrics),
        })
        .run();

      const chunkInsert = <T>(rows: readonly T[], insert: (chunk: T[]) => void): void => {
        for (let index = 0; index < rows.length; index += 500) {
          insert(rows.slice(index, index + 500) as T[]);
        }
      };

      chunkInsert(artifact.equityPoints, (chunk) =>
        db
          .insert(backtestEquityPoints)
          .values(chunk.map((point) => ({
            jobId: context.jobId,
            tsMs: point.tsMs,
            equity: point.equity,
          })))
          .run(),
      );
      chunkInsert(artifact.drawdownPoints, (chunk) =>
        db
          .insert(backtestDrawdownPoints)
          .values(chunk.map((point) => ({
            jobId: context.jobId,
            tsMs: point.tsMs,
            drawdown: point.drawdown,
          })))
          .run(),
      );
      chunkInsert(artifact.trades, (chunk) =>
        db
          .insert(backtestTrades)
          .values(chunk.map((trade) => ({
            jobId: context.jobId,
            symbol: trade.symbol,
            quantity: trade.quantity,
            entryTsMs: trade.entryTsMs,
            exitTsMs: trade.exitTsMs,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            grossPnl: trade.grossPnl,
            costs: trade.costs,
            netPnl: trade.netPnl,
            returnPct: trade.returnPct,
            holdingTimeMs: trade.holdingTimeMs,
            exitReason: trade.exitReason ?? null,
          })))
          .run(),
      );
      if (artifact.monthlyReturns.length > 0) {
        db.insert(backtestMonthlyReturns)
          .values(artifact.monthlyReturns.map((monthly) => ({
            jobId: context.jobId,
            ...monthly,
          })))
          .run();
      }
    });
    insertResults();
  }
}
