/**
 * 백테스트 자식 프로세스 (스펙 §5):
 * 부모의 HTTP 이벤트 루프·메모리와 격리되어 DuckDB 로드 → 엔진 실행 → 결과 저장을 수행한다.
 * 환경변수는 §5 화이트리스트만 받는다. 종료 전 최종 상태를 DB 에 직접 기록한다.
 */
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { openDatabase } from '../server/shared/db/database.js';
import {
  backtestDrawdownPoints,
  backtestEquityPoints,
  backtestJobs,
  backtestMetrics,
  backtestMonthlyReturns,
  backtestRuns,
  backtestSymbolMetrics,
  backtestTrades,
  datasetVersions,
  datasets,
} from '../server/shared/db/schema.js';
import { newId } from '../server/shared/ids.js';
import { ENGINE_VERSION, runBacktest } from '../server/modules/backtest/domain/engine.js';
import {
  DEFAULT_EXECUTION_RULES,
  getCostProfile,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import type { Candle, Market } from '../server/modules/market-data/domain/candle.js';
import { DuckDbService } from '../server/modules/market-data/infrastructure/duckdb-service.js';
import { ParquetCandleRepository } from '../server/modules/market-data/infrastructure/parquet-candle-repository.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { backtestRequestSchema } from '../shared/schemas/backtest-request.js';

let cancelRequested = false;
process.on('message', (message: { type?: string }) => {
  if (message?.type === 'cancel') cancelRequested = true;
});
process.on('SIGTERM', () => {
  cancelRequested = true;
});

function send(message: unknown): void {
  process.send?.(message);
}

async function main(): Promise<void> {
  const jobId = process.env.BACKTEST_JOB_ID ?? process.argv[2];
  const databasePath = process.env.DATABASE_PATH;
  const dataRoot = process.env.DATA_ROOT;
  if (!jobId || !databasePath || !dataRoot) {
    throw new Error('BACKTEST_JOB_ID / DATABASE_PATH / DATA_ROOT 환경변수가 필요합니다');
  }

  const handle = openDatabase(databasePath);
  const db = handle.db;
  const duckdb = new DuckDbService({
    threads: Number(process.env.DUCKDB_THREADS ?? '1'),
    memoryLimit: process.env.DUCKDB_MEMORY_LIMIT ?? '384MB',
  });

  const finish = (status: 'COMPLETED' | 'FAILED' | 'CANCELLED', error?: string): void => {
    db.update(backtestJobs)
      .set({ status, error: error ?? null, completedAtMs: Date.now() })
      .where(eq(backtestJobs.id, jobId))
      .run();
  };

  try {
    const job = db.select().from(backtestJobs).where(eq(backtestJobs.id, jobId)).get();
    if (!job) throw new Error(`job not found: ${jobId}`);

    const request = backtestRequestSchema.parse(JSON.parse(job.requestJson));

    const registry = new StrategyRegistry();
    const strategy = registry.get(request.strategyId);
    if (!strategy) throw new Error(`unknown strategy: ${request.strategyId}`);
    const validated = registry.validateParameters(request.strategyId, request.parameters);
    if (!validated.ok) throw new Error(`invalid parameters: ${validated.error}`);

    const costProfile = getCostProfile(request.execution.commissionProfileId);
    const slippageProfile = getSlippageProfile(request.execution.slippageProfileId);
    if (!costProfile || !slippageProfile) throw new Error('unknown cost/slippage profile');

    const dataset = db.select().from(datasets).where(eq(datasets.id, request.datasetId)).get();
    if (!dataset) throw new Error(`dataset not found: ${request.datasetId}`);
    const datasetVersion = db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, dataset.id))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
      .get();

    // 캔들 로드 (1h 사전 집계 우선, 스펙 §11)
    const repository = new ParquetCandleRepository(dataRoot, duckdb);
    const fromTsMs = Date.parse(`${request.period.from}T00:00:00Z`);
    const toTsMs = Date.parse(`${request.period.to}T23:59:59.999Z`);
    const candles: Candle[] = [];
    for await (const candle of repository.getCandles({
      market: dataset.market as Market,
      timeframe: '1h',
      symbols: request.universe.symbols,
      fromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
    }
    if (candles.length === 0) {
      throw new Error('선택한 기간·종목에 데이터가 없습니다. 데이터 커버리지를 확인하세요.');
    }

    const startedAtMs = Date.now();
    let lastProgressSentAt = 0;
    let lastSymbol: string | null = null;

    const parameters = validated.value as Record<string, unknown>;
    const maxPositions =
      typeof parameters.maxPositions === 'number' ? parameters.maxPositions : 10;

    const result = runBacktest(strategy, {
      candles,
      initialCash: request.capital.initialCash,
      execution: {
        cost: costProfile,
        slippage: slippageProfile,
        rules: DEFAULT_EXECUTION_RULES,
      },
      parameters,
      randomSeed: request.randomSeed,
      maxPositions,
    }, {
      shouldCancel: () => cancelRequested,
      onProgress: ({ processedBars, totalBars, currentTsMs }) => {
        const now = Date.now();
        if (now - lastProgressSentAt < 200 && processedBars < totalBars) return;
        lastProgressSentAt = now;
        lastSymbol = new Date(currentTsMs).toISOString().slice(0, 10);
        send({ type: 'progress', processedBars, totalBars, currentSymbol: lastSymbol });
      },
    });

    if (result.cancelled) {
      finish('CANCELLED');
      send({ type: 'cancelled' });
      return;
    }

    // 재현성 메타데이터 (스펙 §9.5).
    // strategySourceHash: 빌드 산출물에서 원본 소스를 읽을 수 없어
    // id+version+파라미터 스키마의 해시로 대체한다 (전략 로직 변경 시 version 을 올릴 것).
    const strategySourceHash = createHash('sha256')
      .update(strategy.id)
      .update(strategy.version)
      .update(JSON.stringify(z.toJSONSchema(strategy.parameterSchema as z.ZodType)))
      .digest('hex');

    const insertResults = handle.sqlite.transaction(() => {
      db.insert(backtestRuns)
        .values({
          id: newId('run'),
          jobId,
          strategyId: strategy.id,
          strategyVersion: strategy.version,
          strategySourceHash,
          parameterJson: JSON.stringify(parameters),
          datasetId: dataset.id,
          datasetVersion: datasetVersion?.version ?? 0,
          datasetHash: datasetVersion?.contentHash ?? 'unknown',
          engineVersion: ENGINE_VERSION,
          feeModelVersion: `${costProfile.id}@${costProfile.version}`,
          slippageModelVersion: `${slippageProfile.id}@${slippageProfile.version}`,
          randomSeed: request.randomSeed,
          gitCommitSha: process.env.BUILD_GIT_SHA ?? 'unknown',
          warningsJson: JSON.stringify(result.warnings),
          startedAtMs,
          completedAtMs: Date.now(),
        })
        .run();

      db.insert(backtestMetrics)
        .values({
          jobId,
          totalReturnPct: result.metrics.totalReturnPct,
          cagrPct: result.metrics.cagrPct,
          maxDrawdownPct: result.metrics.maxDrawdownPct,
          sharpe: result.metrics.sharpe,
          winRate: result.metrics.winRate,
          tradeCount: result.metrics.tradeCount,
          metricsJson: JSON.stringify(result.metrics),
        })
        .run();

      const chunkInsert = <T>(rows: readonly T[], insert: (chunk: T[]) => void): void => {
        for (let i = 0; i < rows.length; i += 500) {
          insert(rows.slice(i, i + 500) as T[]);
        }
      };

      chunkInsert(result.equityPoints, (chunk) =>
        db
          .insert(backtestEquityPoints)
          .values(chunk.map((p) => ({ jobId, tsMs: p.tsMs, equity: p.equity })))
          .run(),
      );
      chunkInsert(result.drawdownPoints, (chunk) =>
        db
          .insert(backtestDrawdownPoints)
          .values(chunk.map((p) => ({ jobId, tsMs: p.tsMs, drawdown: p.drawdown })))
          .run(),
      );
      chunkInsert(result.trades, (chunk) =>
        db
          .insert(backtestTrades)
          .values(
            chunk.map((t) => ({
              jobId,
              symbol: t.symbol,
              quantity: t.quantity,
              entryTsMs: t.entryTsMs,
              exitTsMs: t.exitTsMs,
              entryPrice: t.entryPrice,
              exitPrice: t.exitPrice,
              grossPnl: t.grossPnl,
              costs: t.costs,
              netPnl: t.netPnl,
              returnPct: t.returnPct,
              holdingTimeMs: t.holdingTimeMs,
              exitReason: t.exitReason ?? null,
            })),
          )
          .run(),
      );
      if (result.monthlyReturns.length > 0) {
        db.insert(backtestMonthlyReturns)
          .values(result.monthlyReturns.map((m) => ({ jobId, ...m })))
          .run();
      }
      if (result.symbolMetrics.length > 0) {
        db.insert(backtestSymbolMetrics)
          .values(
            result.symbolMetrics.map((s) => ({
              jobId,
              symbol: s.symbol,
              tradeCount: s.tradeCount,
              netPnl: s.netPnl,
              winRate: s.winRate,
            })),
          )
          .run();
      }
    });
    insertResults();

    db.update(backtestJobs)
      .set({
        progressBars: result.processedBars,
        totalBars: result.processedBars,
      })
      .where(eq(backtestJobs.id, jobId))
      .run();

    finish('COMPLETED');
    send({ type: 'completed' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finish(cancelRequested ? 'CANCELLED' : 'FAILED', cancelRequested ? undefined : reason);
    send(cancelRequested ? { type: 'cancelled' } : { type: 'failed', reason });
    process.exitCode = cancelRequested ? 0 : 1;
  } finally {
    duckdb.close();
    handle.close();
  }
}

void main().then(
  () => setTimeout(() => process.exit(process.exitCode ?? 0), 50),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
