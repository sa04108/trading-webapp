import fs from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { DatabaseHandle } from '../../../shared/db/database.js';
import { newId } from '../../../shared/ids.js';
import {
  backtestResultSummarySchema,
  backtestResultWriteContextSchema,
  type BacktestResultArtifactImporter,
  type ValidatedBacktestResultArtifact,
} from '../application/backtest-result-artifact.js';
import { BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION } from './sqlite-backtest-result-artifact-writer.js';

export const MAX_BACKTEST_RESULT_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_BACKTEST_RESULT_ROWS = 5_000_000;
const finiteNumber = z.number().finite();
const nonNegativeInteger = z.number().int().nonnegative();

const equityRowSchema = z.object({
  tsMs: nonNegativeInteger,
  equity: finiteNumber,
});
const drawdownRowSchema = z.object({
  tsMs: nonNegativeInteger,
  drawdown: finiteNumber,
});
const tradeRowSchema = z.object({
  symbol: z.string().min(1).max(32),
  quantity: finiteNumber,
  entryTsMs: nonNegativeInteger,
  exitTsMs: nonNegativeInteger,
  entryPrice: finiteNumber,
  exitPrice: finiteNumber,
  grossPnl: finiteNumber,
  costs: finiteNumber,
  netPnl: finiteNumber,
  returnPct: finiteNumber,
  holdingTimeMs: nonNegativeInteger,
  exitReason: z.string().max(1_000).nullable(),
});
const monthlyRowSchema = z.object({
  year: z.number().int().min(1900).max(9999),
  month: z.number().int().min(1).max(12),
  returnPct: finiteNumber,
});

export class InvalidBacktestResultArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidBacktestResultArtifactError';
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new InvalidBacktestResultArtifactError(`${label}가 올바르지 않습니다`, { cause: error });
  }
}

function openArtifact(artifactPath: string): Database.Database {
  const sqlite = new Database(artifactPath, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  sqlite.pragma('trusted_schema = OFF');
  return sqlite;
}

/** 신뢰하지 않는 Worker SQLite artifact를 검증하고 현재 결과 테이블로 복사한다. */
export class SqliteBacktestResultArtifactImporter implements BacktestResultArtifactImporter {
  constructor(private readonly destination: DatabaseHandle) {}

  validate(artifactPath: string, expectedJobId: string): ValidatedBacktestResultArtifact {
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BACKTEST_RESULT_ARTIFACT_BYTES) {
      throw new InvalidBacktestResultArtifactError('결과 artifact 파일 크기가 허용 범위를 벗어납니다');
    }
    const sqlite = openArtifact(artifactPath);
    try {
      const integrity = sqlite.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new InvalidBacktestResultArtifactError('SQLite integrity check 실패');
      const schemaVersion = sqlite.pragma('user_version', { simple: true }) as number;
      if (schemaVersion !== BACKTEST_RESULT_ARTIFACT_SCHEMA_VERSION) {
        throw new InvalidBacktestResultArtifactError(`지원하지 않는 결과 schema: ${schemaVersion}`);
      }
      const tableList = sqlite.pragma('table_list') as Array<{
        name: string;
        type: string;
        strict: number;
      }>;
      const tables = new Map(tableList.map((table) => [table.name, table]));
      for (const name of ['artifact_manifest', 'equity_points', 'drawdown_points', 'trades', 'monthly_returns']) {
        const table = tables.get(name);
        if (table?.type !== 'table' || table.strict !== 1) {
          throw new InvalidBacktestResultArtifactError(`결과 ${name}가 STRICT table이 아닙니다`);
        }
      }
      const manifest = sqlite.prepare(
        `SELECT schema_version AS schemaVersion, context_json AS contextJson, summary_json AS summaryJson
         FROM artifact_manifest WHERE singleton = 1`,
      ).get() as { schemaVersion: number; contextJson: string; summaryJson: string } | undefined;
      if (manifest === undefined || manifest.schemaVersion !== schemaVersion) {
        throw new InvalidBacktestResultArtifactError('결과 manifest가 없거나 schema가 일치하지 않습니다');
      }
      const context = parseJson(manifest.contextJson, backtestResultWriteContextSchema, 'context');
      const summary = parseJson(manifest.summaryJson, backtestResultSummarySchema, 'summary');
      if (context.jobId !== expectedJobId) {
        throw new InvalidBacktestResultArtifactError('artifact jobId가 lease jobId와 다릅니다');
      }
      const counts = sqlite.prepare(
        `SELECT
           (SELECT count(*) FROM equity_points) AS equityCount,
           (SELECT count(*) FROM drawdown_points) AS drawdownCount,
           (SELECT count(*) FROM trades) AS tradeCount,
           (SELECT count(*) FROM monthly_returns) AS monthlyCount`,
      ).get() as { equityCount: number; drawdownCount: number; tradeCount: number; monthlyCount: number };
      const rowCount = counts.equityCount + counts.drawdownCount + counts.tradeCount + counts.monthlyCount;
      if (rowCount > MAX_BACKTEST_RESULT_ROWS) {
        throw new InvalidBacktestResultArtifactError(`결과 행 수가 상한을 넘습니다: ${rowCount}`);
      }
      if (counts.equityCount !== counts.drawdownCount || counts.tradeCount !== summary.metrics.tradeCount) {
        throw new InvalidBacktestResultArtifactError('결과 행 수와 summary 지표가 일치하지 않습니다');
      }
      return { path: artifactPath, context, summary, schemaVersion, rowCount };
    } catch (error) {
      if (error instanceof InvalidBacktestResultArtifactError) throw error;
      throw new InvalidBacktestResultArtifactError('결과 artifact 구조를 읽을 수 없습니다', { cause: error });
    } finally {
      sqlite.close();
    }
  }

  /** 호출자가 연 transaction 안에서 실행한다. 중간 행 검증 실패도 전체 import를 rollback한다. */
  write(artifact: ValidatedBacktestResultArtifact): void {
    const source = openArtifact(artifact.path);
    try {
      const target = this.destination.sqlite;
      const { context, summary } = artifact;
      target.prepare(
        `INSERT INTO backtest_runs (
           id, job_id, strategy_id, strategy_version, strategy_source_hash, parameter_json,
           universe_rule_json, schedule_hash, universe_json, universe_hash, engine_version,
           fee_model_version, slippage_model_version, random_seed, git_commit_sha,
           provenance_pin_json, warnings_json, open_positions_json, started_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('run'),
        context.jobId,
        context.strategyId,
        context.strategyVersion,
        context.strategySourceHash,
        context.parameterJson,
        context.universeRuleJson,
        context.scheduleHash,
        context.universeJson,
        context.universeHash,
        context.engineVersion,
        context.feeModelVersion,
        context.slippageModelVersion,
        context.randomSeed,
        context.gitCommitSha,
        context.provenancePinJson,
        JSON.stringify(summary.warnings),
        JSON.stringify(summary.openPositions),
        context.startedAtMs,
        context.completedAtMs,
      );
      target.prepare(
        `INSERT INTO backtest_metrics (
           job_id, total_return_pct, cagr_pct, max_drawdown_pct, sharpe,
           win_rate, trade_count, metrics_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        context.jobId,
        summary.metrics.totalReturnPct,
        summary.metrics.cagrPct,
        summary.metrics.maxDrawdownPct,
        summary.metrics.sharpe,
        summary.metrics.winRate,
        summary.metrics.tradeCount,
        JSON.stringify(summary.metrics),
      );

      const insertEquity = target.prepare(
        'INSERT INTO backtest_equity_points (job_id, ts_ms, equity) VALUES (?, ?, ?)',
      );
      for (const raw of source.prepare(
        'SELECT ts_ms AS tsMs, equity FROM equity_points ORDER BY sequence',
      ).iterate()) {
        const row = equityRowSchema.parse(raw);
        insertEquity.run(context.jobId, row.tsMs, row.equity);
      }

      const insertDrawdown = target.prepare(
        'INSERT INTO backtest_drawdown_points (job_id, ts_ms, drawdown) VALUES (?, ?, ?)',
      );
      for (const raw of source.prepare(
        'SELECT ts_ms AS tsMs, drawdown FROM drawdown_points ORDER BY sequence',
      ).iterate()) {
        const row = drawdownRowSchema.parse(raw);
        insertDrawdown.run(context.jobId, row.tsMs, row.drawdown);
      }

      const insertTrade = target.prepare(
        `INSERT INTO backtest_trades (
           job_id, symbol, quantity, entry_ts_ms, exit_ts_ms, entry_price, exit_price,
           gross_pnl, costs, net_pnl, return_pct, holding_time_ms, exit_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const raw of source.prepare(
        `SELECT symbol, quantity, entry_ts_ms AS entryTsMs, exit_ts_ms AS exitTsMs,
                entry_price AS entryPrice, exit_price AS exitPrice, gross_pnl AS grossPnl,
                costs, net_pnl AS netPnl, return_pct AS returnPct,
                holding_time_ms AS holdingTimeMs, exit_reason AS exitReason
         FROM trades ORDER BY sequence`,
      ).iterate()) {
        const row = tradeRowSchema.parse(raw);
        insertTrade.run(
          context.jobId,
          row.symbol,
          row.quantity,
          row.entryTsMs,
          row.exitTsMs,
          row.entryPrice,
          row.exitPrice,
          row.grossPnl,
          row.costs,
          row.netPnl,
          row.returnPct,
          row.holdingTimeMs,
          row.exitReason,
        );
      }

      const insertMonthly = target.prepare(
        'INSERT INTO backtest_monthly_returns (job_id, year, month, return_pct) VALUES (?, ?, ?, ?)',
      );
      for (const raw of source.prepare(
        'SELECT year, month, return_pct AS returnPct FROM monthly_returns ORDER BY sequence',
      ).iterate()) {
        const row = monthlyRowSchema.parse(raw);
        insertMonthly.run(context.jobId, row.year, row.month, row.returnPct);
      }
    } catch (error) {
      if (error instanceof InvalidBacktestResultArtifactError) throw error;
      throw new InvalidBacktestResultArtifactError('결과 행 import에 실패했습니다', { cause: error });
    } finally {
      source.close();
    }
  }
}
