/**
 * 백테스트 자식 프로세스 (스펙 §5):
 * 부모의 HTTP 이벤트 루프·메모리와 격리되어 입력 로드 → 엔진 실행 → 결과 저장을 수행한다.
 * 환경변수는 §5 화이트리스트만 받는다. 종료 전 최종 상태를 DB 에 직접 기록한다.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { readGitCommitSha } from '../server/shared/build-info.js';
import { systemClock } from '../server/shared/clock.js';
import { openDatabase } from '../server/shared/db/database.js';
import {
  backtestJobs,
  symbolMasterStorageState,
  symbolMasterTradingDays,
  symbolVersions,
  symbols as symbolsTable,
} from '../server/shared/db/schema.js';
import {
  sumExcludedNonTrading,
  type LegacyUniverseScheduleEntry,
} from '../server/modules/backtest/application/universe-rule-resolver.js';
import type {
  BacktestExecutionOutcome,
  BacktestExecutionStage,
} from '../server/modules/backtest/application/backtest-execution-telemetry.js';
import {
  measureBacktestArtifact,
  type BacktestArtifactSize,
} from '../server/modules/backtest/application/backtest-result-artifact.js';
import { BacktestRunner } from '../server/modules/backtest/application/backtest-runner.js';
import {
  assertPinnedScheduleHash,
  assertPinnedScheduleExecutionDates,
  assertSafePinnedScheduleIdentities,
  calculatePinnedScheduleHash,
  UnsafeBacktestSymbolIdentityError,
} from '../server/modules/backtest/application/backtest-symbol-identity.js';
import { MAX_BACKTEST_BARS } from '../server/modules/backtest/domain/bar-estimate.js';
import { ENGINE_VERSION } from '../server/modules/backtest/domain/engine.js';
import {
  getCostProfile,
  getKrxExecutionRules,
  getSlippageProfile,
} from '../server/modules/backtest/domain/cost-profiles.js';
import { SqliteFactRepository } from '../server/modules/facts/infrastructure/sqlite-fact-repository.js';
import { SqliteCorporateActionCoverageStore } from '../server/modules/facts/application/corporate-action-coverage.js';
import { SqliteFactCoverageStore } from '../server/modules/facts/application/fact-coverage-store.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../server/modules/facts/domain/fact.js';
import {
  alignCorporateActionEffectiveDates,
  CORPORATE_ACTION_ALIGNMENT_WINDOW,
  corporateActionRawDateRange,
} from '../server/modules/facts/domain/corporate-action-effective-date.js';
import type { Candle, Market, Timeframe } from '../server/modules/market-data/domain/candle.js';
import { addCalendarDays } from '../server/modules/market-data/domain/kst-date.js';
import { KrxDailyCandleRepository } from '../server/modules/market-data/infrastructure/krx-daily-candle-repository.js';
import type { KrxHistoricalUniverseSource } from '../server/modules/market-data/application/ports.js';
import { SymbolMasterService } from '../server/modules/market-data/application/symbol-master-service.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { strategyRequiresFinancialData } from '../server/modules/strategy/domain/strategy.js';
import { strategySourceHash } from '../server/modules/strategy/application/strategy-source-hash.js';
import { SqliteBacktestResultWriter } from '../server/modules/backtest/infrastructure/sqlite-backtest-result-writer.js';
import { SqliteBacktestResultArtifactWriter } from '../server/modules/backtest/infrastructure/sqlite-backtest-result-artifact-writer.js';
import { backtestRequestSchema, periodToTsRange } from '../shared/schemas/backtest-request.js';
import type { ProvenancePin } from '../shared/schemas/provenance-pin.js';
import { installCancellationHandlers } from './cancellation.js';
import {
  financialCoverageGapMessage,
  findFinancialCoverageGap,
} from '../server/modules/backtest/application/backtest-financial-coverage.js';
import { financialFactCutoffsFromCandles } from '../server/modules/backtest/application/backtest-financial-execution-window.js';

const cancellation = installCancellationHandlers();

function send(message: unknown): void {
  process.send?.(message);
}

async function main(): Promise<void> {
  const workerStartedAtMs = Date.now();
  let loadCompletedAtMs: number | null = null;
  let runCompletedAtMs: number | null = null;
  let persistCompletedAtMs: number | null = null;
  let activeStage: BacktestExecutionStage | null = 'LOAD';
  let outcome: BacktestExecutionOutcome = 'FAILED';
  let inputSize: { candleCount: number; factCount: number; symbolCount: number } | null = null;
  let outputSize: BacktestArtifactSize | null = null;

  const jobId = process.env.BACKTEST_JOB_ID ?? process.argv[2];
  const databasePath = process.env.DATABASE_PATH;
  if (!jobId || !databasePath) {
    throw new Error('BACKTEST_JOB_ID / DATABASE_PATH 환경변수가 필요합니다');
  }

  const handle = openDatabase(databasePath);
  const db = handle.db;

  const finish = (
    requestedStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    error?: string,
  ): 'COMPLETED' | 'FAILED' | 'CANCELLED' | null => {
    // 취소 요청과 오류 처리를 한 UPDATE에서 판정한다. 상태를 SELECT한 뒤 FAILED를
    // 쓰는 두 단계라면 그 사이 부모가 CANCELLING으로 바꿔도 실패가 취소를 덮어쓴다.
    const updated = handle.sqlite.prepare(
      `UPDATE backtest_jobs
       SET status = CASE WHEN status = 'CANCELLING' THEN 'CANCELLED' ELSE ? END,
           error = CASE WHEN status = 'CANCELLING' THEN NULL ELSE ? END,
           completed_at_ms = ?
       WHERE id = ?
         AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED', 'INTERRUPTED')
       RETURNING status`,
    ).get(
      requestedStatus,
      error ?? null,
      Date.now(),
      jobId,
    ) as { status: 'COMPLETED' | 'FAILED' | 'CANCELLED' } | undefined;
    if (updated !== undefined) return updated.status;

    // 부모 exit handler가 아주 먼저 terminal로 확정한 경우에도 telemetry/exit code가
    // 실제 상태를 따르도록 이미 저장된 결론을 읽는다.
    const existing = db.select({ status: backtestJobs.status })
      .from(backtestJobs)
      .where(eq(backtestJobs.id, jobId))
      .get()?.status;
    return existing === 'COMPLETED' || existing === 'FAILED' || existing === 'CANCELLED'
      ? existing
      : null;
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
    const parameters = validated.value as Record<string, unknown>;

    const costProfile = getCostProfile(request.execution.commissionProfileId);
    const slippageProfile = getSlippageProfile(request.execution.slippageProfileId);
    if (!costProfile || !slippageProfile) throw new Error('unknown cost/slippage profile');

    // 워커·엔진의 유일한 유니버스 소스는 제출 시점에 pin 한 멤버십 일정이다 (스펙
    // 2026-08-05) — `request.universeRule` 은 규칙일 뿐, 실제로 어떤 종목이었는지는
    // 여기 job.universeScheduleJson 에 이미 확정돼 있다. 워커가 규칙을 다시 해석하면
    // 대기 중 종목 마스터가 갱신됐을 때 제출 시점과 다른 유니버스로 돌게 된다.
    const schedule = JSON.parse(job.universeScheduleJson) as LegacyUniverseScheduleEntry[];
    // Date.parse 결과가 NaN인 일정을 엔진에 넘기면 리밸런스가 영원히 실행되지 않은 채
    // 0-trade 결과가 정상 완료될 수 있으므로 flatMap/map보다 먼저 막는다.
    assertPinnedScheduleExecutionDates(schedule);
    const loadedScheduleHash = calculatePinnedScheduleHash(schedule);
    const unionSymbols = [...new Set(schedule.flatMap((entry) => entry.symbols))].sort();
    // 엔진에 넘길 멤버십 일정 — rebalanceDate 를 periodToTsRange 와 같은 자정 규칙으로
    // ms 로 바꾼다. 두 곳이 각자 계산하면 제출·미리보기는 맞는데 실행부만 하루 어긋나는
    // D-024 류의 불일치가 생긴다. entry.effectiveTradingDate 는 resolver 가 유니버스·
    // 시총을 실제로 읽은 거래일일 뿐이다 — 리밸런스가 일어나는 시점은 언제나
    // rebalanceDate(요청 날짜)이므로 fromTsMs 는 그대로 rebalanceDate 로 계산한다.
    const universeSchedule = schedule.map((entry) => ({
      fromTsMs: Date.parse(`${entry.rebalanceDate}T00:00:00Z`),
      symbols: entry.symbols,
      ...(entry.members === undefined
        ? {}
        : {
            members: entry.members.map((member) => ({
              symbol: member.symbol,
              marketCapKrw: member.marketCapKrw,
              volume: member.volume,
              tradingValueKrw: member.tradingValueKrw,
            })),
          }),
    }));

    // SCD 이행이 끝났는지 먼저 확인한다. SymbolMasterService 생성자가
    // ensureScdStorageReady 를 부르므로, 이 검사가 없으면 백테스트 잡 하나가 워커
    // 프로세스 안에서 스키마 이행 전체(버전 테이블 재작성 + legacy 테이블 삭제)를
    // 수행하거나 그 도중에 죽어 백테스트 실패로 둔갑한다. busy_timeout 이 5초라
    // 워커 둘이 겹치면 큰 DB 에서 SQLITE_BUSY 로 갈린다. 이행은 서버만 한다.
    const storagePhase = db
      .select({ phase: symbolMasterStorageState.phase })
      .from(symbolMasterStorageState)
      .where(eq(symbolMasterStorageState.singleton, 1))
      .get()?.phase;
    if (storagePhase !== 'ACTIVE') {
      throw new Error(
        `종목 마스터 저장소가 아직 SCD 로 이행되지 않았습니다 (현재 ${storagePhase ?? '기록 없음'}). `
          + '서버를 먼저 한 번 띄워 이행을 끝낸 뒤 다시 실행하세요 — 워커는 이행하지 않습니다.',
      );
    }

    // 종목 마스터 읽기 전용 조회 — 워커는 db handle 을 재사용하고 KRX 를 직접 부르지
    // 않는다(ingestDate 류는 호출하지 않는다). 위 phase 검사가 통과했으므로 생성자의
    // ensureScdStorageReady 는 곧바로 돌아온다 — 이 경로에서 쓰기가 일어나지 않는다.
    // source 는 계약을 채우기 위한 자리표시일 뿐이며 실제로 불리면 버그이므로 던진다.
    // clock 도 쓰기 경로 전용이라 systemClock 이면 충분하다.
    const unusedKrxSource: KrxHistoricalUniverseSource = {
      fetchIssueBaseInfo: () =>
        Promise.reject(new Error('워커는 종목 마스터를 읽기 전용으로만 쓴다 — KRX 를 부르지 않는다')),
      fetchDailyTrades: () =>
        Promise.reject(new Error('워커는 종목 마스터를 읽기 전용으로만 쓴다 — KRX 를 부르지 않는다')),
      todayMaxEndpointCallCount: () => 0,
    };
    const symbolMaster = new SymbolMasterService({
      db,
      source: unusedKrxSource,
      clock: systemClock,
      logger: pino({ level: 'warn' }),
    });
    // HTTP 제출을 거치지 않은 직접 enqueue, 배포 전 QUEUED, 지연 seed 승격과
    // 원격 bundle 모두 이 최종 경계를 지난다. standardCode가 엔진 입력에서 사라지기
    // 전에 전체 SCD 생애와 현재 등록 행을 함께 확인한다.
    const pin: ProvenancePin | null = job.provenancePinJson
      ? (JSON.parse(job.provenancePinJson) as ProvenancePin)
      : null;
    if (job.provenancePinJson !== null) {
      // provenance 행이 있으면 hash는 필수다. `{}`/null hash 손상을 legacy 무-pin
      // 작업처럼 허용하면 결과에 `unknown`을 남기고 재현성 검증을 우회한다.
      assertPinnedScheduleHash(schedule, pin?.scheduleHash);
    }
    assertSafePinnedScheduleIdentities(schedule, { symbolMaster });
    // 제출 이후 coverage가 지워진 로컬 job, 배포 전에 대기 중이던 job, HTTP 제출을
    // 거치지 않은 직접 enqueue와 원격 bundle을 같은 최종 경계에서 막는다. 리밸런스
    // 날짜만 안다고 기간 사이의 상장폐지·거래정지·코드 변경까지 안다고 볼 수 없다.
    if (!symbolMaster.isRangeCovered(request.period.from, request.period.to)) {
      throw new Error(
        '종목 마스터가 백테스트 기간 전체를 커버하지 않습니다 — '
          + '기간 전체 KRX 데이터를 동기화한 뒤 다시 실행하세요.',
      );
    }

    // 거래불가일 — 봉 tsMs 로 접어 엔진에 넘긴다. Candle.tsMs 규약은 거래일의 UTC 자정이다
    // (krx-daily-candle-repository.ts). 여기서 같은 규칙을 쓰지 않으면 하루 어긋난다(D-024 류).
    const unionSymbolSet = new Set(unionSymbols);
    const nonTradingSymbolsByTsMs = new Map<number, Set<string>>();
    const strategyWarmupBars = strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 0;
    const declineWarmupBars = request.universeRule.stages.reduce(
      (maximum, stage) => stage.criterion === 'DECLINE'
        ? Math.max(maximum, stage.lookbackTradingDays)
        : maximum,
      0,
    );
    const warmupBars = Math.ceil(Math.max(0, strategyWarmupBars, declineWarmupBars));
    const priorTradingDays = warmupBars === 0
      ? []
      : db
          .select({ date: symbolMasterTradingDays.date })
          .from(symbolMasterTradingDays)
          .where(and(
            lt(symbolMasterTradingDays.date, request.period.from),
            // 0005 legacy 이행의 주말 경계를 warm-up N일로 세지 않는다.
            sql`strftime('%w', ${symbolMasterTradingDays.date}) NOT IN ('0', '6')`,
          ))
          .orderBy(desc(symbolMasterTradingDays.date))
          .limit(warmupBars)
          .all();
    const warmupFromDate = priorTradingDays[priorTradingDays.length - 1]?.date
      ?? request.period.from;
    const marketTradingTsMs = db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(and(
        gte(symbolMasterTradingDays.date, warmupFromDate),
        lte(symbolMasterTradingDays.date, request.period.to),
        sql`strftime('%w', ${symbolMasterTradingDays.date}) NOT IN ('0', '6')`,
      ))
      .orderBy(asc(symbolMasterTradingDays.date))
      .all()
      .map((row) => Date.parse(`${row.date}T00:00:00Z`));

    for (const row of symbolMaster.nonTradingDaysBetween(warmupFromDate, request.period.to)) {
      if (!unionSymbolSet.has(row.shortCode)) continue;
      const ts = Date.parse(`${row.date}T00:00:00Z`);
      const set = nonTradingSymbolsByTsMs.get(ts) ?? new Set<string>();
      set.add(row.shortCode);
      nonTradingSymbolsByTsMs.set(ts, set);
    }
    const nonTradingCoveredPeriod = symbolMaster.isNonTradingRangeCovered(
      request.period.from,
      request.period.to,
    )
      ? { from: request.period.from, to: request.period.to }
      : null;

    // 상장폐지 — 기간 안에 효력이 발생한 것만. 기간이 끝난 뒤 폐지된 종목은 그 시점에는
    // 아직 폐지가 아니므로 청산하지 않는다. 유니버스 밖 종목은 엔진이 모르는 심볼이라 걸러낸다.
    //
    // 코드당 폐지를 **전부** 담는다. KRX 가 폐지된 단축코드를 다른 회사에 다시 주므로
    // 한 코드가 기간 안에서 두 번 폐지될 수 있다. 하나만 남기면 뒤 폐지가 앞 폐지를
    // 덮어써, 앞 회사를 들고 있던 포지션이 뒷 회사의 종가로 청산된다.
    const delistedTsMsBySymbol = new Map<string, number[]>();
    for (const event of symbolMaster.delistedEventsBetween(request.period.from, request.period.to)) {
      if (!unionSymbolSet.has(event.shortCode)) continue;
      const list = delistedTsMsBySymbol.get(event.shortCode) ?? [];
      list.push(Date.parse(`${event.effectiveDate}T00:00:00Z`));
      delistedTsMsBySymbol.set(event.shortCode, list);
    }

    // market 은 이제 종목의 속성이다 — 유니버스 종목들에서 읽는다. 여러 시장이
    // 섞이면 세션·집계 기준이 하나로 정해지지 않아 실행 자체가 성립하지 않는다.
    const universeMarkets = [
      ...new Set(
        db
          .select({ market: symbolsTable.market })
          .from(symbolsTable)
          .where(inArray(symbolsTable.code, unionSymbols))
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
    // 다르면 대기 중 동기화가 데이터를 바꿨다는 뜻이다. 현재 데이터를 실행하는 구조라
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
    // 리밸런스 기준일에 거래정지·무거래로 후보에서 빠진 종목 — resolve() 가 이미 세어
    // schedule 에 담아 뒀다(Task 6). 조용히 빠지면 "그날 왜 이 종목을 안 샀는지" 를
    // 사용자가 결과만 보고는 알 수 없다.
    const excludedNonTradingTotal = sumExcludedNonTrading(schedule);
    if (excludedNonTradingTotal > 0) {
      datasetWarnings.push(
        `리밸런스 기준일에 거래정지·무거래여서 유니버스 후보에서 제외된 종목 ${excludedNonTradingTotal}건 `
          + '(중복 포함). 그날 실제로 매수할 수 없는 종목입니다.',
      );
    }
    // warm-up 봉이 모자라면 전략이 첫 리밸런스 bar 를 지표 미준비로 건너뛰어
    // 한 주기 동안 현금이 놀 수 있다 — 조용히 지나가면 결과만 보고는 알 수 없다.
    if (warmupBars > 0 && priorTradingDays.length < warmupBars) {
      datasetWarnings.push(
        `기간 시작 전 warm-up 거래일이 부족합니다 (필요 ${warmupBars}일, 확보 ${priorTradingDays.length}일). `
          + '첫 리밸런스에서 지표가 준비되지 않아 주문이 나가지 않을 수 있습니다.',
      );
    }
    // 서버가 제출 시점에 조립한 pin(Task 12)은 위에서 일정 원문과 대조했다.
    // run 에는 원문 그대로 복사한다(아래 provenancePinJson).
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

    // 캔들 로드 (스펙 §11).
    // 새 요청은 스키마가 timeframe 을 '1d' 하나로만 허용한다(D-041, backtest-request.ts).
    // 아래 repository(KrxDailyCandleRepository)는 어차피 봉 주기를 보지 않고 KRX
    // 일봉만 돌려준다 — timeframe 은 이제 표시·에러 메시지용 값이다.
    const timeframe = (request.timeframe ?? '1d') as Timeframe;
    // 봉은 KRX 일봉 하나뿐이다(container.ts 조립부와 같은 모양) — db 는 위에서 이미 연
    // handle 을 재사용한다. 워커가 잡 조회로 이미 DB 를 열어 둔 상태라 새로 열 이유가 없다.
    const repository = new KrxDailyCandleRepository(db);
    const { fromTsMs, toTsMs } = periodToTsRange(request.period);
    const candleFromTsMs = Date.parse(`${warmupFromDate}T00:00:00Z`);
    const candles: Candle[] = [];
    for await (const candle of repository.getCandles({
      market: datasetMarket,
      timeframe,
      symbols: unionSymbols,
      fromTsMs: candleFromTsMs,
      toTsMs,
    })) {
      candles.push(candle);
      // 제출 검증의 추정 상한을 실측으로 다시 지킨다 — 제출 후 import 로 봉이 는 경우의 방어선
      if (candles.length > MAX_BACKTEST_BARS) {
        throw new Error(
          `봉 수가 상한(${MAX_BACKTEST_BARS.toLocaleString()})을 넘습니다. 기간이나 종목 수를 줄이세요.`,
        );
      }
    }
    const tradeCandles = candles
      .filter((candle) => candle.tsMs >= fromTsMs && candle.tsMs <= toTsMs);
    if (tradeCandles.length === 0) {
      // 어떤 timeframe 을 찾았는지 밝힌다 — 커버리지가 정상인데 실패하면 여기서 갈린다
      throw new Error(
        `선택한 기간·종목에 ${timeframe} 데이터가 없습니다. 데이터 커버리지를 확인하세요.`,
      );
    }
    // 거래 시작 경계는 "처음 발견된 봉"이 아니라 사용자가 요청한 기간 시작이다.
    // 모든 선택 종목의 앞쪽 봉이 함께 누락되면 최초 봉 기준은 그 결측 구간을 warm-up처럼
    // 숨긴다. 휴일은 marketTradingTsMs에 없으므로 요청 경계를 써도 전략 호출이 생기지 않는다.
    const tradeFromTsMs = fromTsMs;

    // 일정에 선정됐는데 기간 내 봉이 하나도 없는 종목만 빼고 실행하면 유니버스가
    // 달라진다. 급락 종목이 누락된 경우 특히 낙관 편향이므로 전체 실행을 중단한다.
    const symbolsWithBars = new Set(
      tradeCandles.map((candle) => candle.symbol),
    );
    const emptySymbols = unionSymbols.filter((s) => !symbolsWithBars.has(s));
    if (emptySymbols.length > 0) {
      throw new Error(
        `선택한 기간에 ${timeframe} 봉이 없는 유니버스 종목이 있어 백테스트를 중단했습니다: `
          + `${emptySymbols.join(', ')}. 기간 전체 KRX 데이터를 동기화하거나 유니버스를 조정하세요.`,
      );
    }

    // 제출 뒤 coverage가 지워진 대기 job, 직접 enqueue, 지연 seed 승격과 remote bundle도
    // 같은 마지막 경계를 지난다. 일부 종목만 빠진 채 실행하면 랭킹 유니버스가 달라진다.
    const financialCoverageGap = findFinancialCoverageGap({
      request,
      strategy,
      symbols: unionSymbols,
      coverage: new SqliteFactCoverageStore(db),
    });
    if (financialCoverageGap !== null) {
      throw new Error(financialCoverageGapMessage(financialCoverageGap));
    }

    // 상장시점 팩트 로드 — 질의를 **둘로** 나눈다. 둘의 노출 규칙이 다르기 때문이다.
    //
    // 재무 팩트: 노출 시점 = 공시 접수일(asOf). 종목별 마지막 실행 봉 뒤 접수분은 그
    // 종목을 다시 평가할 봉이 없으므로 SQL 상한과 메모리 필터에서 잘라낸다.
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
    const factRepository = new SqliteFactRepository(db);
    const financialCutoffBySymbol = financialFactCutoffsFromCandles({
      period: request.period,
      schedule,
      delistedTsMsBySymbol,
      candles: tradeCandles,
    });
    const missingExecutionSymbols = unionSymbols.filter(
      (symbol) => !financialCutoffBySymbol.has(symbol),
    );
    if (missingExecutionSymbols.length > 0) {
      throw new Error(
        '실제 편입 기간·상장폐지 이전에 실행 가능한 일봉이 없는 유니버스 종목이 있어 '
        + `백테스트를 중단했습니다: ${missingExecutionSymbols.join(', ')}. `
        + '일봉과 유니버스 데이터를 다시 준비하세요.',
      );
    }
    const lastExecutionTsMs = Math.max(...financialCutoffBySymbol.values());
    const financialFacts: Fact[] = (
      await factRepository.getFacts({
        scope: 'SYMBOL',
        keys: unionSymbols,
        asOfMaxTsMs: lastExecutionTsMs,
      })
    ).filter((fact) => (
      fact.field !== CORPORATE_ACTION_FIELD
      && fact.asOfTsMs <= (financialCutoffBySymbol.get(fact.key) ?? Number.NEGATIVE_INFINITY)
    ));
    const rawCorporateActionFacts: Fact[] = await factRepository.getFacts({
      scope: 'SYMBOL',
      keys: unionSymbols,
      fields: [CORPORATE_ACTION_FIELD],
    });

    // 자본변동 효력발생일을 KRX 가 주가를 조정한 날로 옮긴다.
    //
    // DART 가 주는 날짜는 액면분할의 **기준일**이고, 일봉 주가가 분할 후 값이 되는 날은
    // **변경상장일**이다. 그 사이(주권교체 정지 구간)에는 엔진이 수량만 ×비율 해 놓고
    // 단가는 분할 전 값을 쓰므로 평가금액이 비율 배로 뛰었다가 재개 봉에서 되돌아온다
    // — 자산곡선에 없던 봉우리가 서고 MDD·변동성이 그 봉우리에서 계산된다.
    //
    // resolver와 같은 전체 raw fact/change 그래프를 정렬해야 주변 사건이 같은 change를
    // 요구해도 schedule 계산과 실제 실행에서 효력일 배정이 갈리지 않는다.
    const rawActionRange = corporateActionRawDateRange(rawCorporateActionFacts);
    const sharesChanges = rawActionRange === null
      ? []
      : symbolMaster.sharesChangesBetween(
          addCalendarDays(
            rawActionRange.from,
            -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
          ),
          addCalendarDays(
            rawActionRange.to,
            CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
          ),
        );
    const aligned = alignCorporateActionEffectiveDates(rawCorporateActionFacts, sharesChanges);

    // 실제 효력일을 확인하지 못한 자본변동은 원래 DART 기준일로 실행하지 않는다.
    // 기준일에는 분할 전 가격인데 수량만 늘어 자산·수익률이 비율 배로 튈 수 있기 때문이다.
    //
    // raw 기준일 자체가 warm-up~종료 밖이어도 정렬 후보는 기준일 -30~+90일에 있다.
    // 따라서 실제 변경일이 엔진 입력 구간에 들어올 수 있는 역방향 범위까지 막는다.
    // 이보다 오래된 미정렬 이력은 첫 warm-up 봉보다도 먼저 끝났고, 훨씬 뒤 이력은
    // 결과 종료 뒤라 이번 실행의 가격·전략 상태·포지션 수량을 바꿀 수 없다.
    // 달력 warm-up 하한에 실제 봉이 없을 수 있다(상장 전, 장기 정지, 불완전한 옛
    // 거래일 캘린더). 자본변동이 신호/보유에 영향을 줄 수 있는 시작은 실제로 로드한
    // 첫 봉이다. 빈 수년을 기준으로 coverage를 요구하면 준비 plan보다 과도한 옛 연도를
    // 막으면서도 결과 정확도는 늘지 않는다.
    const firstLoadedCandleDate = new Date(
      candles.reduce((minimum, candle) => Math.min(minimum, candle.tsMs), Number.POSITIVE_INFINITY),
    ).toISOString().slice(0, 10);
    const potentiallyRelevantFrom = addCalendarDays(
      firstLoadedCandleDate,
      -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
    );
    const potentiallyRelevantTo = addCalendarDays(
      request.period.to,
      CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
    );
    // 파서가 자본변동 행을 보았지만 비율을 만들지 못하면 raw fact 자체가 없다.
    // aligner만 보면 "사건 없음"과 구분할 수 없으므로 coverage의 gap 연도를 마지막
    // 실행 경계에서도 확인한다. 연도 단위 기록이라 관련 역투영 범위와 겹치면 보수적으로
    // 전체 실행을 막는다 — 종목만 빼면 유니버스와 성과가 낙관적으로 바뀔 수 있다.
    const relevantActionFromYear = Number(potentiallyRelevantFrom.slice(0, 4));
    const relevantActionToYear = Number(potentiallyRelevantTo.slice(0, 4));
    const requiredActionYears: number[] = [];
    for (let year = relevantActionFromYear; year <= relevantActionToYear; year += 1) {
      requiredActionYears.push(year);
    }
    const actionCoverage = new SqliteCorporateActionCoverageStore(db);
    const coveredActionYears = actionCoverage.getCoveredYears(unionSymbols);
    const actionCoverageMissingSymbols = unionSymbols.filter((symbol) => {
      const covered = new Set(coveredActionYears.get(symbol) ?? []);
      return requiredActionYears.some((year) => !covered.has(year));
    }).sort();
    if (actionCoverageMissingSymbols.length > 0) {
      throw new Error(
        '자본변동 coverage가 부족해 백테스트를 중단했습니다 — '
          + `대상 ${actionCoverageMissingSymbols.length}종목: `
          + `${actionCoverageMissingSymbols.join(', ')}. 필요한 연도 데이터를 다시 준비하세요.`,
      );
    }
    const actionGapSymbols = [
      ...actionCoverage.getGapYears(unionSymbols),
    ].flatMap(([symbol, years]) => years.some(
      (year) => year >= relevantActionFromYear && year <= relevantActionToYear,
    ) ? [symbol] : []).sort();
    if (actionGapSymbols.length > 0) {
      throw new Error(
        '자본변동 보정 비율을 만들 수 없는 연도가 있어 백테스트를 중단했습니다 — '
          + `대상 ${actionGapSymbols.length}종목: ${actionGapSymbols.join(', ')}. `
          + 'DART gap을 해소하고 자본변동 데이터를 다시 준비하세요.',
      );
    }
    const unalignedForExecution = aligned.unaligned.filter(
      (action) => (
        action.periodKey >= potentiallyRelevantFrom
        && action.periodKey <= potentiallyRelevantTo
      ),
    );
    if (unalignedForExecution.length > 0) {
      const unalignedSymbols = [
        ...new Set(unalignedForExecution.map((action) => action.symbol)),
      ].sort();
      const shown = unalignedSymbols.slice(0, 10).join(', ');
      throw new Error(
        `자본변동 ${unalignedForExecution.length}건의 실제 효력일을 KRX 상장주식수 변경과 정렬할 수 없어 `
          + `백테스트를 중단했습니다 — 대상 ${unalignedSymbols.length}종목: ${shown}`
          + (unalignedSymbols.length > 10 ? ` 외 ${unalignedSymbols.length - 10}종목` : '')
          + '. DART 기준일로 그대로 실행하면 수량과 가격 단위가 어긋나 수익이 왜곡됩니다. '
          + '종목 마스터를 기준일 전후 구간까지 수집한 뒤 다시 실행하세요.',
      );
    }

    const corporateActionFacts = aligned.facts;
    const facts: Fact[] = [...financialFacts, ...corporateActionFacts];
    // 아래 두 검사는 **재무** 팩트만 본다 — 분할만 기록된 종목은 재무가 없는 종목이다
    if (strategyRequiresFinancialData(strategy) && financialFacts.length === 0) {
      // 제출 검증이 걸렀어야 하는 상태다. 실행 중 데이터가 지워진 경우의 뒤늦은 방어선.
      throw new Error(
        '재무 coverage 기록은 있지만 마지막 실행 봉까지 사용 가능한 재무 데이터가 '
          + '유니버스 전체에 없습니다. 수집 gap을 확인하거나 기간·유니버스·전략을 조정하세요.',
      );
    }
    if (strategyRequiresFinancialData(strategy)) {
      // "facts:sync 리포트를 확인하세요" 는 지금 어디에도 없는 것을 가리킨다 — 그 리포트는
      // 이미 닫혔을 수 있는 세션의 stdout 으로만 존재했다. 대신 실제로 로드된 팩트 키를
      // 요청 유니버스와 맞춰 재무가 **하나도 없는** 종목을 직접 이름으로 밝힌다.
      // (계정이 일부만 빠진 종목까지 여기서 가려내지는 못하므로 그 한계도 함께 남긴다.)
      const symbolsWithFacts = new Set(financialFacts.map((fact) => fact.key));
      const withoutFacts = unionSymbols.filter((s) => !symbolsWithFacts.has(s));
      // 유니버스 상한이 200종목이라 캡이 없으면 경고 한 줄이 종목코드 200개가 된다 —
      // 엔진의 포지션 상한 경고와 같은 10종목 캡을 쓴다 (engine.ts 의 buysDroppedByCap).
      const shown = withoutFacts.slice(0, 10).join(', ');
      datasetWarnings.push(
        (withoutFacts.length > 0
          ? `재무 데이터가 하나도 없어 랭킹에서 제외된 종목 ${withoutFacts.length}종목: ${shown}` +
            (withoutFacts.length > 10 ? ` 외 ${withoutFacts.length - 10}종목` : '') +
            '. '
          : '') +
          '재무 데이터는 공시 시점 기준입니다. 계정이 일부만 공시된 종목도 랭킹에서 빠질 수 있습니다.',
      );
    }

    // 로컬 서버가 입력을 읽는 동안 master/등록 행이 갱신된 TOCTOU도 결과 생성 전에
    // 닫는다. 원격 bundle은 불변이지만 같은 실행 코드를 유지한다.
    assertSafePinnedScheduleIdentities(schedule, { symbolMaster });

    inputSize = {
      candleCount: candles.length,
      factCount: facts.length,
      symbolCount: unionSymbols.length,
    };
    loadCompletedAtMs = Date.now();
    activeStage = 'RUN';
    const startedAtMs = Date.now();
    let lastProgressSentAt = 0;

    // 우아한 취소를 위해 주기적으로 이벤트 루프에 양보하는 버전을 쓴다 —
    // 근거는 engine.ts 의 CANCEL_YIELD_INTERVAL_BARS 주석 참고.
    const runner = new BacktestRunner();
    const runOutcome = await runner.run(strategy, {
      candles,
      initialCash: request.capital.initialCash,
      execution: {
        cost: costProfile,
        slippage: slippageProfile,
        rules: getKrxExecutionRules(request.universeRule.markets[0]!),
      },
      parameters,
      randomSeed: request.randomSeed,
      maxPositions: request.risk.maxPositions,
      facts,
      tradeFromTsMs,
      // 조회 구간의 toTsMs는 23:59:59.999라 일봉 날짜와 중복된다. 성과 기간은
      // Candle.tsMs와 같은 UTC 자정 날짜로 넘겨 실제 point가 경계에 있으면 재사용한다.
      resultPeriod: {
        fromTsMs,
        toTsMs: Date.parse(`${request.period.to}T00:00:00Z`),
      },
      universeSchedule,
      nonTradingSymbolsByTsMs,
      marketTradingTsMs,
      nonTradingCoveredPeriod,
      delistedTsMsBySymbol,
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
    }, datasetWarnings);
    runCompletedAtMs = Date.now();

    if (runOutcome.status === 'CANCELLED') {
      activeStage = null;
      outcome = 'CANCELLED';
      finish('CANCELLED');
      return;
    }
    const artifact = runOutcome.artifact;
    activeStage = 'PERSIST';
    outputSize = measureBacktestArtifact(artifact);

    // 계산이 오래 걸리는 동안 중앙 종목 마스터 수집이 과거 alias를 새로 발견할 수
    // 있다. 시작 직전 검사만으로는 그 결과를 정상 완료로 저장하므로, short-key 입력을
    // 소비한 결과가 DB/artifact에 닿기 직전에 최신 snapshot으로 한 번 더 막는다.
    assertSafePinnedScheduleIdentities(schedule, { symbolMaster });

    // 재현성 메타데이터 (스펙 §9.5) — 해시 규칙은 strategySourceHash 주석 참고
    const sourceHash = strategySourceHash(strategy);
    const resultPath = process.env.BACKTEST_RESULT_PATH;
    const resultCompletedAtMs = Date.now();
    const assertCurrentExecutionIdentity = (): void => {
      const current = db.select({
        requestJson: backtestJobs.requestJson,
        strategyId: backtestJobs.strategyId,
        universeRuleJson: backtestJobs.universeRuleJson,
        universeScheduleJson: backtestJobs.universeScheduleJson,
        provenancePinJson: backtestJobs.provenancePinJson,
        universeJson: backtestJobs.universeJson,
        universeHash: backtestJobs.universeHash,
      }).from(backtestJobs).where(eq(backtestJobs.id, jobId)).get();
      if (
        current === undefined
        || current.requestJson !== job.requestJson
        || current.strategyId !== job.strategyId
        || current.universeRuleJson !== job.universeRuleJson
        || current.universeScheduleJson !== job.universeScheduleJson
        || current.provenancePinJson !== job.provenancePinJson
        || current.universeJson !== job.universeJson
        || current.universeHash !== job.universeHash
      ) {
        throw new UnsafeBacktestSymbolIdentityError(
          '결과 저장 전에 백테스트 실행 pin이 변경됐습니다.',
        );
      }
      // 이 callback은 local writer의 IMMEDIATE transaction 안에서 실행된다.
      // 따라서 row와 SCD를 확인한 뒤 결과/COMPLETED까지 다른 writer가 끼어들 수 없다.
      assertSafePinnedScheduleIdentities(schedule, { symbolMaster });
    };
    const resultWriter = resultPath
      ? new SqliteBacktestResultArtifactWriter(resultPath)
      : new SqliteBacktestResultWriter(
          handle,
          assertCurrentExecutionIdentity,
          () => db.update(backtestJobs)
            .set({
              status: 'COMPLETED',
              error: null,
              progressBars: artifact.processedBars,
              totalBars: artifact.processedBars,
              completedAtMs: resultCompletedAtMs,
            })
            .where(and(
              eq(backtestJobs.id, jobId),
              inArray(backtestJobs.status, ['STARTING', 'RUNNING']),
            ))
            .run().changes === 1,
        );
    resultWriter.write({
      jobId,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      strategySourceHash: sourceHash,
      parameterJson: JSON.stringify(parameters),
      universeRuleJson: job.universeRuleJson,
      // provenance pin이 없는 legacy/direct job도 실제 소비 schedule hash는 반드시 남긴다.
      scheduleHash: loadedScheduleHash,
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
      startedAtMs,
      completedAtMs: resultCompletedAtMs,
    }, artifact);
    persistCompletedAtMs = Date.now();

    // 로컬 DB writer는 결과와 COMPLETED를 같은 transaction에서 확정했다. 원격
    // artifact 모드는 bundle 안의 상태를 부모 supervisor가 읽으므로 여기서 끝낸다.
    outcome = 'COMPLETED';
    if (resultPath) {
      db.update(backtestJobs)
        .set({
          progressBars: artifact.processedBars,
          totalBars: artifact.processedBars,
        })
        .where(eq(backtestJobs.id, jobId))
        .run();
      finish('COMPLETED');
    }
    activeStage = null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cancellationRequested = cancellation.isRequested();
    const finalStatus = finish(
      cancellationRequested ? 'CANCELLED' : 'FAILED',
      cancellationRequested ? undefined : reason,
    );
    const cancelled = finalStatus === 'CANCELLED';
    outcome = finalStatus === 'COMPLETED' ? 'COMPLETED' : cancelled ? 'CANCELLED' : 'FAILED';
    // 원격 supervisor는 input.sqlite의 FAILED 행을 볼 수 없고 stderr를 중앙 finish
    // 사유로 전달한다. 자체 메시지만 쓰고 수신 측이 2KB로 자른다.
    if (outcome === 'FAILED') process.stderr.write(`${reason}\n`);
    process.exitCode = outcome === 'FAILED' ? 1 : 0;
  } finally {
    const finishedAtMs = Date.now();
    const loadEnd = loadCompletedAtMs ?? finishedAtMs;
    const runEnd = runCompletedAtMs ?? finishedAtMs;
    const persistEnd = persistCompletedAtMs
      ?? (outcome === 'FAILED' && runCompletedAtMs !== null ? finishedAtMs : runEnd);
    send({
      type: 'telemetry',
      telemetry: {
        schemaVersion: 1,
        outcome,
        failedStage: outcome === 'FAILED' ? activeStage : null,
        durationsMs: {
          load: Math.max(0, loadEnd - workerStartedAtMs),
          run: loadCompletedAtMs === null ? 0 : Math.max(0, runEnd - loadCompletedAtMs),
          persist: runCompletedAtMs === null ? 0 : Math.max(0, persistEnd - runCompletedAtMs),
          total: Math.max(0, finishedAtMs - workerStartedAtMs),
        },
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        input: inputSize,
        output: outputSize,
      },
    });
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
