import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  BacktestResultArtifact,
  BacktestResultWriteContext,
} from '../../src/server/modules/backtest/application/backtest-result-artifact.js';
import { SqliteBacktestResultWriter } from '../../src/server/modules/backtest/infrastructure/sqlite-backtest-result-writer.js';
import {
  backtestJobs,
  symbolMasterVersions,
} from '../../src/server/shared/db/schema.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const ARTIFACT: BacktestResultArtifact = {
  schemaVersion: 1,
  metrics: {
    initialCash: 10_000,
    finalEquity: 10_000,
    totalReturnPct: 0,
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
  },
  openPositions: [],
  equityPoints: [],
  drawdownPoints: [],
  trades: [],
  monthlyReturns: [],
  warnings: [],
  processedBars: 0,
};

function seedJob(t: TestApp, jobId: string): BacktestResultWriteContext {
  t.container.database.db.insert(backtestJobs).values({
    id: jobId,
    status: 'RUNNING',
    requestJson: '{}',
    strategyId: 'test-strategy',
    universeRuleJson: '{}',
    universeScheduleJson: '[]',
    createdAtMs: 1,
  }).run();
  return {
    jobId,
    strategyId: 'test-strategy',
    strategyVersion: '1',
    strategySourceHash: 'source-hash',
    parameterJson: '{}',
    universeRuleJson: '{}',
    scheduleHash: 'schedule-hash',
    universeJson: '[]',
    universeHash: 'universe-hash',
    engineVersion: 'engine-version',
    feeModelVersion: 'fee-version',
    slippageModelVersion: 'slippage-version',
    randomSeed: 1,
    gitCommitSha: 'git-sha',
    provenancePinJson: null,
    startedAtMs: 1,
    completedAtMs: 2,
  };
}

describe('SqliteBacktestResultWriter final precondition', () => {
  it('결과와 같은 transaction에서 검사하고 실패 시 검사 중 변경도 rollback한다', async () => {
    const ctx = await createTestApp();
    try {
      ctx.container.database.sqlite.exec(
        'CREATE TABLE result_writer_guard_probe (value INTEGER NOT NULL)',
      );
      const writer = new SqliteBacktestResultWriter(ctx.container.database, () => {
        ctx.container.database.sqlite
          .prepare('INSERT INTO result_writer_guard_probe (value) VALUES (1)')
          .run();
        throw new Error('identity changed');
      });

      expect(() => writer.write({} as never, {} as never)).toThrow('identity changed');
      expect(ctx.container.database.sqlite
        .prepare('SELECT count(*) AS count FROM result_writer_guard_probe')
        .get()).toEqual({ count: 0 });
      expect(ctx.container.database.sqlite
        .prepare('SELECT count(*) AS count FROM backtest_runs')
        .get()).toEqual({ count: 0 });
    } finally {
      await ctx.close();
    }
  });

  it('job 완료 CAS가 실패하면 앞서 쓴 결과 행을 모두 rollback한다', async () => {
    const ctx = await createTestApp();
    try {
      const context = seedJob(ctx, 'bt_complete_cas_lost');
      const writer = new SqliteBacktestResultWriter(
        ctx.container.database,
        () => undefined,
        () => false,
      );

      expect(() => writer.write(context, ARTIFACT)).toThrow(/job 완료 전이/);
      expect(ctx.container.database.sqlite
        .prepare('SELECT count(*) AS count FROM backtest_runs WHERE job_id = ?')
        .get(context.jobId)).toEqual({ count: 0 });
      expect(ctx.container.database.sqlite
        .prepare('SELECT count(*) AS count FROM backtest_metrics WHERE job_id = ?')
        .get(context.jobId)).toEqual({ count: 0 });
    } finally {
      await ctx.close();
    }
  });

  it('최종 검사부터 결과 저장까지 다른 연결의 SCD write가 끼어들지 못한다', async () => {
    const ctx = await createTestApp();
    const competing = new Database(path.join(ctx.dir, 'app.sqlite'), { timeout: 0 });
    try {
      const context = seedJob(ctx, 'bt_writer_lock');
      ctx.container.database.db.insert(symbolMasterVersions).values({
        standardCode: 'KR7005930003',
        validFromDate: '2000-01-01',
        validToDate: null,
        shortCode: '005930',
        name: '검사 전 이름',
        market: 'KOSPI',
        sharesOutstanding: '1',
        instrumentType: 'COMMON_STOCK',
        listedDate: '2000-01-01',
        recordedAtMs: 1,
      }).run();
      competing.pragma('busy_timeout = 0');

      const writer = new SqliteBacktestResultWriter(ctx.container.database, () => {
        let competingError: unknown;
        try {
          competing.prepare(
            `UPDATE symbol_master_versions
             SET name = '경쟁 변경'
             WHERE standard_code = 'KR7005930003' AND valid_from_date = '2000-01-01'`,
          ).run();
        } catch (error) {
          competingError = error;
        }
        expect(competingError).toMatchObject({ code: 'SQLITE_BUSY' });
      });

      writer.write(context, ARTIFACT);
      expect(ctx.container.database.sqlite.prepare(
        `SELECT name FROM symbol_master_versions
         WHERE standard_code = 'KR7005930003' AND valid_from_date = '2000-01-01'`,
      ).get()).toEqual({ name: '검사 전 이름' });
      expect(competing.prepare(
        `UPDATE symbol_master_versions
         SET name = 'transaction 뒤 변경'
         WHERE standard_code = 'KR7005930003' AND valid_from_date = '2000-01-01'`,
      ).run().changes).toBe(1);
    } finally {
      competing.close();
      await ctx.close();
    }
  });
});
