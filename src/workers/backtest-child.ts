/**
 * 백테스트 자식 프로세스 (스펙 §5):
 * 부모의 HTTP 이벤트 루프·메모리와 격리되어 DuckDB 로드 → 엔진 실행 → 결과 저장을 수행한다.
 * 환경변수는 §5 화이트리스트만 받는다. 종료 전 최종 상태를 DB 에 직접 기록한다.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
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
  symbolVersions,
  symbols as symbolsTable,
  datasets,
} from '../server/shared/db/schema.js';
import { newId } from '../server/shared/ids.js';
import { TERMINAL_STATUSES } from '../server/modules/backtest/application/job-queue.js';
import { MAX_BACKTEST_BARS } from '../server/modules/backtest/domain/bar-estimate.js';
import { ENGINE_VERSION, runBacktest } from '../server/modules/backtest/domain/engine.js';
import {
  DEFAULT_EXECUTION_RULES,
  getCostProfile,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import { ParquetFactRepository } from '../server/modules/facts/infrastructure/parquet-fact-repository.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../server/modules/facts/domain/fact.js';
import type { Candle, Market, Timeframe } from '../server/modules/market-data/domain/candle.js';
import { DuckDbService } from '../server/modules/market-data/infrastructure/duckdb-service.js';
import { ParquetCandleRepository } from '../server/modules/market-data/infrastructure/parquet-candle-repository.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { strategySourceHash } from '../server/modules/strategy/application/strategy-source-hash.js';
import { backtestRequestSchema, periodToTsRange } from '../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../shared/schemas/provenance-pin.js';
import { installCancellationHandlers } from './cancellation.js';

const cancellation = installCancellationHandlers();

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

    // datasetId 경로만 실존 데이터셋을 요구한다 — universeSnapshotId 경로(Task 12)는
    // 데이터셋이 없다. 그 경우 backtestRuns.datasetId 에는 job.datasetId(제출 시점에
    // queue.enqueue 가 저장한 '' sentinel)를 그대로 쓴다.
    let resolvedDatasetId = job.datasetId;
    if (request.datasetId !== undefined) {
      const dataset = db.select().from(datasets).where(eq(datasets.id, request.datasetId)).get();
      if (!dataset) throw new Error(`dataset not found: ${request.datasetId}`);
      resolvedDatasetId = dataset.id;
    }
    // market 은 이제 종목의 속성이다 — 요청 유니버스의 종목들에서 읽는다. 여러 시장이
    // 섞이면 세션·집계 기준이 하나로 정해지지 않아 실행 자체가 성립하지 않는다.
    const universeMarkets = [
      ...new Set(
        db
          .select({ market: symbolsTable.market })
          .from(symbolsTable)
          .where(inArray(symbolsTable.code, [...request.universe.symbols]))
          .all()
          .map((row) => row.market),
      ),
    ];
    if (universeMarkets.length !== 1) {
      throw new Error(
        universeMarkets.length === 0
          ? '유니버스 종목이 등록돼 있지 않습니다'
          : `유니버스가 여러 시장에 걸쳐 있습니다: ${universeMarkets.join(', ')}`,
      );
    }
    const datasetMarket = universeMarkets[0] as Market;

    // 제출 시점에 고정된 종목 버전 스냅샷을 사용한다 (스펙 §9.5). 실행 시점의 latest 가
    // 다르면 대기 중 동기화가 데이터를 바꿨다는 뜻 — Parquet 은 파티션 재작성 방식이라
    // 물리적 스냅샷 격리가 없으므로 경고로 명시한다. 종목 데이터가 데이터셋 간에
    // 공유되므로 "다른 사람이 이 종목을 동기화했다" 도 같은 경로로 잡힌다.
    const pinnedEntries: Array<{ code: string; slice: string; version: number; contentHash: string }> =
      job.universeJson === null
        ? []
        : (JSON.parse(job.universeJson) as Array<{
            code: string;
            slice: string;
            version: number;
            contentHash: string;
          }>);
    const currentVersions = new Map(
      db
        .select()
        .from(symbolVersions)
        .all()
        .reduce((acc, row) => {
          const key = `${row.code}:${row.slice}`;
          const prev = acc.get(key);
          if (prev === undefined || row.version > prev.version) acc.set(key, row);
          return acc;
        }, new Map<string, typeof symbolVersions.$inferSelect>()),
    );
    const datasetWarnings: string[] = [];
    // 서버가 제출 시점에 조립한 pin(Task 12) — 데이터셋 경로의 시점 불명 경고는
    // 여기서 실행 경고로 옮긴다. run 에는 원문 그대로 복사한다(아래 provenancePinJson).
    const pin: ProvenancePin | null = job.provenancePinJson
      ? (JSON.parse(job.provenancePinJson) as ProvenancePin)
      : null;
    if (pin?.timepointWarning) datasetWarnings.push(pin.timepointWarning);
    const drifted = pinnedEntries.filter((entry) => {
      const current = currentVersions.get(`${entry.code}:${entry.slice}`);
      return (current?.version ?? 0) !== entry.version;
    });
    if (drifted.length > 0) {
      datasetWarnings.push(
        `제출 이후 데이터가 변경된 종목이 있습니다: ${drifted
          .map((entry) => `${entry.code}(${entry.slice})`)
          .join(', ')} — 결과가 제출 당시 데이터와 다를 수 있습니다.`,
      );
    }
    const pinnedUniverseJson = job.universeJson ?? '[]';
    const pinnedUniverseHash = job.universeHash ?? 'unknown';

    // 캔들 로드 (스펙 §11). 요청의 timeframe 이 소비 기준이고, 미지정이면 데이터셋
    // timeframe (1m 수집·import 는 1h 로 사전 집계되어 '1h', 일봉 수집은 '1d').
    // 여기를 '1h' 로 고정하면 일봉 데이터셋은 파티션이 없어 0봉으로 실패한다 (D-024).
    // 데이터셋에 defaultTimeframe 이 없어졌다 — 요청이 소비 기준의 유일한 출처다.
    // 미지정이면 일봉으로 본다 (구 legacyConsumeDefault 의 '1d' 분기와 같은 값).
    const timeframe = (request.timeframe ?? '1d') as Timeframe;
    const repository = new ParquetCandleRepository(dataRoot, duckdb);
    const { fromTsMs, toTsMs } = periodToTsRange(request.period);
    const candles: Candle[] = [];
    for await (const candle of repository.getCandles({
      market: datasetMarket,
      timeframe,
      symbols: request.universe.symbols,
      fromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
      // 제출 검증의 추정 상한을 실측으로 다시 지킨다 — 제출 후 import 로 봉이 는 경우의 방어선
      if (candles.length > MAX_BACKTEST_BARS) {
        throw new Error(
          `봉 수가 상한(${MAX_BACKTEST_BARS.toLocaleString()})을 넘습니다. 기간이나 종목 수를 줄이거나 1h 봉을 사용하세요.`,
        );
      }
    }
    if (candles.length === 0) {
      // 어떤 timeframe 을 찾았는지 밝힌다 — 커버리지가 정상인데 실패하면 여기서 갈린다
      throw new Error(
        `선택한 기간·종목에 ${timeframe} 데이터가 없습니다. 데이터 커버리지를 확인하세요.`,
      );
    }

    // 일부 종목만 구간에 봉이 없는 경우 — 제출 검증은 통과시킨다(신규 상장 등 정상).
    // 조용히 빠지면 결과를 오해하므로 실측 기준으로 경고를 남긴다 (D-025).
    const symbolsWithBars = new Set(candles.map((candle) => candle.symbol));
    const emptySymbols = request.universe.symbols.filter((s) => !symbolsWithBars.has(s));
    if (emptySymbols.length > 0) {
      datasetWarnings.push(
        `선택한 기간에 ${timeframe} 봉이 없어 제외된 종목: ${emptySymbols.join(', ')}`,
      );
    }

    // 상장시점 팩트 로드 — 질의를 **둘로** 나눈다. 둘의 노출 규칙이 다르기 때문이다.
    //
    // 재무 팩트: 노출 시점 = 공시 접수일(asOf). 기간 종료 이후 접수분은 PitFactView 커서가
    // 어차피 흡수하지 않으므로 SQL 에서 잘라 메모리를 아낀다.
    //
    // 자본변동(SPLIT_RATIO): 노출 시점 = **효력발생일**이다 (설계 §3.4, 스펙 §9.2). 그래서
    // 접수일로 자르면 안 된다. 분할 수량은 사업보고서의 증자·감자 현황에서 읽으므로 접수일이
    // 효력발생일보다 최대 15개월 늦다 — 2025-03-14 기준 분할은 2026년 3월 접수라서
    // asOf 컷오프를 걸면 2025-12-31 로 끝나는 백테스트에는 행 자체가 들어오지 못한다.
    // 그러면 모멘텀은 미보정 가격에서 12개월 수익률 −50% 를 읽고 기본 절대 모멘텀 필터가
    // 그 종목을 1년간 조용히 떨어뜨린다. PitFactView 의 효력발생일 게이트가 존재하는
    // 이유가 바로 그 시나리오이므로, 여기서 잘라버리면 그 게이트가 프로덕션에 닿지 않는다.
    //
    // 봉 시점별 컷오프는 두 경우 모두 엔진의 PitFactView 가 담당한다.
    const factRepository = new ParquetFactRepository(dataRoot, duckdb);
    const financialFacts: Fact[] = (
      await factRepository.getFacts({
        scope: 'SYMBOL',
        keys: request.universe.symbols,
        asOfMaxTsMs: toTsMs,
      })
    ).filter((fact) => fact.field !== CORPORATE_ACTION_FIELD);
    const corporateActionFacts: Fact[] = await factRepository.getFacts({
      scope: 'SYMBOL',
      keys: request.universe.symbols,
      fields: [CORPORATE_ACTION_FIELD],
    });
    const facts: Fact[] = [...financialFacts, ...corporateActionFacts];
    // 아래 두 검사는 **재무** 팩트만 본다 — 분할만 기록된 종목은 재무가 없는 종목이다
    if (strategy.requiresFundamentals === true && financialFacts.length === 0) {
      // 제출 검증이 걸렀어야 하는 상태다. 실행 중 데이터가 지워진 경우의 뒤늦은 방어선.
      throw new Error(
        '이 전략은 상장시점 재무 데이터가 필요합니다. 데이터 화면에서 이 데이터셋을 동기화할 때 "재무" 를 함께 선택해 수집한 뒤 다시 실행하세요.',
      );
    }
    if (strategy.requiresFundamentals === true) {
      // "facts:sync 리포트를 확인하세요" 는 지금 어디에도 없는 것을 가리킨다 — 그 리포트는
      // 이미 닫혔을 수 있는 세션의 stdout 으로만 존재했다. 대신 실제로 로드된 팩트 키를
      // 요청 유니버스와 맞춰 재무가 **하나도 없는** 종목을 직접 이름으로 밝힌다.
      // (계정이 일부만 빠진 종목까지 여기서 가려내지는 못하므로 그 한계도 함께 남긴다.)
      const symbolsWithFacts = new Set(financialFacts.map((fact) => fact.key));
      const withoutFacts = request.universe.symbols.filter((s) => !symbolsWithFacts.has(s));
      // 유니버스 상한이 200종목이라 캡이 없으면 경고 한 줄이 종목코드 200개가 된다 —
      // 엔진의 포지션 상한 경고와 같은 10종목 캡을 쓴다 (engine.ts 의 buysDroppedByCap).
      const shown = withoutFacts.slice(0, 10).join(', ');
      datasetWarnings.push(
        (withoutFacts.length > 0
          ? `재무 데이터가 하나도 없어 랭킹에서 제외된 종목 ${withoutFacts.length}종목: ${shown}` +
            (withoutFacts.length > 10 ? ` 외 ${withoutFacts.length - 10}종목` : '') +
            '. '
          : '') +
          '재무 데이터는 수집 시점 기준입니다. 계정이 일부만 누락된 종목도 랭킹에서 조용히 빠질 수 있습니다 ' +
          '— 데이터 화면에서 재무를 다시 수집하면 누락 건수를 확인할 수 있습니다.',
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
      facts,
    }, {
      shouldCancel: () => cancellation.isRequested(),
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

    // 재현성 메타데이터 (스펙 §9.5) — 해시 규칙은 strategySourceHash 주석 참고
    const sourceHash = strategySourceHash(strategy);

    const insertResults = handle.sqlite.transaction(() => {
      db.insert(backtestRuns)
        .values({
          id: newId('run'),
          jobId,
          strategyId: strategy.id,
          strategyVersion: strategy.version,
          strategySourceHash: sourceHash,
          parameterJson: JSON.stringify(parameters),
          datasetId: resolvedDatasetId,
          universeJson: pinnedUniverseJson,
          universeHash: pinnedUniverseHash,
          engineVersion: ENGINE_VERSION,
          feeModelVersion: `${costProfile.id}@${costProfile.version}`,
          slippageModelVersion: `${slippageProfile.id}@${slippageProfile.version}`,
          randomSeed: request.randomSeed,
          gitCommitSha: readGitCommitSha(),
          // run 은 pin 원문을 그대로 복사한다 — job 이 사라져도(보존 정책 등) 실행
          // 기록 자체가 provenance 를 답할 수 있어야 한다.
          provenancePinJson: job.provenancePinJson,
          warningsJson: JSON.stringify([...datasetWarnings, ...result.warnings]),
          openPositionsJson: JSON.stringify(result.openPositions),
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
    finish(cancellation.isRequested() ? 'CANCELLED' : 'FAILED', cancellation.isRequested() ? undefined : reason);
    process.exitCode = cancellation.isRequested() ? 0 : 1;
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
