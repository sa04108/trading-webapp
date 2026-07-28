/**
 * 백테스트 자식 프로세스 (스펙 §5):
 * 부모의 HTTP 이벤트 루프·메모리와 격리되어 DuckDB 로드 → 엔진 실행 → 결과 저장을 수행한다.
 * 환경변수는 §5 화이트리스트만 받는다. 종료 전 최종 상태를 DB 에 직접 기록한다.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { readGitCommitSha } from '../server/shared/build-info.js';
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
import { TERMINAL_STATUSES } from '../server/modules/backtest/application/job-queue.js';
import { ENGINE_VERSION, runBacktest } from '../server/modules/backtest/domain/engine.js';
import {
  DEFAULT_EXECUTION_RULES,
  getCostProfile,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import type { Candle, Market, Timeframe } from '../server/modules/market-data/domain/candle.js';
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
    // 부모와의 경합에서 이미 확정된 종료 상태를 되돌리지 않는다
    db.update(backtestJobs)
      .set({ status, error: error ?? null, completedAtMs: Date.now() })
      .where(and(eq(backtestJobs.id, jobId), notInArray(backtestJobs.status, TERMINAL_STATUSES)))
      .run();
  };

  try {
    const job = db.select().from(backtestJobs).where(eq(backtestJobs.id, jobId)).get();
    if (!job) throw new Error(`job not found: ${jobId}`);

    // 스키마 변경 이전에 저장된 요청은 zod 원문 대신 이해 가능한 메시지로 실패시킨다
    const parsedRequest = backtestRequestSchema.safeParse(JSON.parse(job.requestJson));
    if (!parsedRequest.success) {
      throw new Error(
        '저장된 요청이 현재 요청 스키마와 호환되지 않습니다. 복제 대신 새 백테스트를 생성하세요.',
      );
    }
    const request = parsedRequest.data;

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

    // 제출 시점에 고정된 버전을 사용한다 (스펙 §9.5). 실행 시점의 latest 가 다르면
    // 대기 중 import 가 데이터를 바꿨다는 뜻 — Parquet 은 파티션 재작성 방식이라
    // 물리적 스냅샷 격리가 없으므로 경고로 명시한다.
    const latestVersion = db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetId, dataset.id))
      .orderBy(desc(datasetVersions.version))
      .limit(1)
      .get();
    const pinnedVersion = job.datasetVersion ?? latestVersion?.version ?? 0;
    const pinnedHash = job.datasetHash ?? latestVersion?.contentHash ?? 'unknown';
    const datasetWarnings: string[] = [];
    if (job.datasetVersion !== null && latestVersion && latestVersion.version !== job.datasetVersion) {
      datasetWarnings.push(
        `제출 시점 데이터셋 버전(v${job.datasetVersion})과 실행 시점 최신 버전(v${latestVersion.version})이 다릅니다. ` +
          '대기 중 데이터가 변경되어 결과가 제출 당시 데이터와 다를 수 있습니다.',
      );
    }

    // 캔들 로드 (스펙 §11). 데이터셋의 timeframe 이 백테스트가 소비하는 기준이다 —
    // 1m 수집·import 는 1h 로 사전 집계되어 '1h', 일봉 수집은 '1d' 로 저장된다.
    // 여기를 '1h' 로 고정하면 일봉 데이터셋은 파티션이 없어 0봉으로 실패한다 (D-024).
    const timeframe = dataset.timeframe as Timeframe;
    const repository = new ParquetCandleRepository(dataRoot, duckdb);
    const fromTsMs = Date.parse(`${request.period.from}T00:00:00Z`);
    const toTsMs = Date.parse(`${request.period.to}T23:59:59.999Z`);
    const candles: Candle[] = [];
    for await (const candle of repository.getCandles({
      datasetId: dataset.id,
      market: dataset.market as Market,
      timeframe,
      symbols: request.universe.symbols,
      fromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
    }
    if (candles.length === 0) {
      // 어떤 timeframe 을 찾았는지 밝힌다 — 커버리지가 정상인데 실패하면 여기서 갈린다
      throw new Error(
        `선택한 기간·종목에 ${timeframe} 데이터가 없습니다. 데이터 커버리지를 확인하세요.`,
      );
    }

    const startedAtMs = Date.now();
    let lastProgressSentAt = 0;

    const parameters = validated.value as Record<string, unknown>;

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
      maxPositions: request.risk.maxPositions,
    }, {
      shouldCancel: () => cancelRequested,
      onProgress: ({ processedBars, totalBars, currentTsMs }) => {
        const now = Date.now();
        if (now - lastProgressSentAt < 200 && processedBars < totalBars) return;
        lastProgressSentAt = now;
        // 엔진은 시간 우선으로 돌기 때문에 "현재 심볼" 은 존재하지 않는다 — 처리 중인 날짜를 표시
        const progressLabel = new Date(currentTsMs).toISOString().slice(0, 10);
        send({ type: 'progress', processedBars, totalBars, progressLabel });
      },
    });

    if (result.cancelled) {
      finish('CANCELLED');
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
          datasetVersion: pinnedVersion,
          datasetHash: pinnedHash,
          engineVersion: ENGINE_VERSION,
          feeModelVersion: `${costProfile.id}@${costProfile.version}`,
          slippageModelVersion: `${slippageProfile.id}@${slippageProfile.version}`,
          randomSeed: request.randomSeed,
          gitCommitSha: readGitCommitSha(),
          warningsJson: JSON.stringify([...datasetWarnings, ...result.warnings]),
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

    // 종료 상태는 DB 가 유일한 진실이다 — 부모는 exit 이벤트에서 DB 를 읽는다
    finish('COMPLETED');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    finish(cancelRequested ? 'CANCELLED' : 'FAILED', cancelRequested ? undefined : reason);
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
