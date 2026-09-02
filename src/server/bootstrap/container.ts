import fs from 'node:fs';
import { periodToTsRange } from '../../shared/schemas/backtest-request.js';
import type { AppConfig } from './config.js';
import { readGitCommitSha } from '../shared/build-info.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';
import { SqliteExternalApiUsage, type ExternalApiUsage } from '../shared/db/external-api-usage.js';
import { pruneExpiredRows } from '../shared/db/maintenance.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { configureZodLocale } from '../shared/zod-locale.js';
import { createAuditLogService, type AuditLogService } from '../modules/audit/audit-service.js';
import { NotificationService } from '../modules/notification/application/notification-service.js';
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import {
  createBacktestNotificationListener,
  createSeedCloneBatchNotificationListener,
} from './notification-wiring.js';
import { AuthService } from '../modules/auth/application/auth-service.js';
import type {
  LoginAttemptRepository,
  PasswordHasher,
  SessionRepository,
  TotpService,
  UserRepository,
} from '../modules/auth/application/ports.js';
import { argon2PasswordHasher } from '../modules/auth/infrastructure/argon2-password-hasher.js';
import { otpauthTotpService } from '../modules/auth/infrastructure/otpauth-totp.js';
import {
  createSqliteLoginAttemptRepository,
  createSqliteSessionRepository,
  createSqliteUserRepository,
} from '../modules/auth/infrastructure/sqlite-repositories.js';
import { SymbolInfoService } from '../modules/market-data/application/symbol-info-service.js';
import { SymbolService } from '../modules/market-data/application/symbol-service.js';
import { CandleCoverageService } from '../modules/market-data/application/candle-coverage-service.js';
import type { CandleRepository } from '../modules/market-data/application/ports.js';
import { createTossStockInfoSource } from '../modules/broker/infrastructure/toss/toss-stock-info-source.js';
import { KrxDailyCandleRepository } from '../modules/market-data/infrastructure/krx-daily-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { strategyRequiresFinancialData } from '../modules/strategy/domain/strategy.js';
import { JobOrchestrator, type JobEvent } from '../modules/backtest/application/job-orchestrator.js';
import { JobQueue } from '../modules/backtest/application/job-queue.js';
import { BacktestWizardDraftService } from '../modules/backtest/application/backtest-wizard-draft-service.js';
import { ResultsService } from '../modules/backtest/application/results-service.js';
import {
  createSeedCloneBatchJobListener,
  SeedCloneBatchService,
} from '../modules/backtest/application/seed-clone-batch-service.js';
import type { FactRepository } from '../modules/facts/application/ports.js';
import {
  SqliteCorporateActionCoverageStore,
  type CorporateActionCoverageStore,
} from '../modules/facts/application/corporate-action-coverage.js';
import {
  SqliteFactCoverageStore,
  type FactCoverageStore,
} from '../modules/facts/application/fact-coverage-store.js';
import { FactSyncService } from '../modules/facts/application/fact-sync-service.js';
import { FinancialFactAvailabilityService } from '../modules/facts/application/financial-fact-availability.js';
import { createDartFactSource } from '../modules/facts/infrastructure/dart/dart-fact-source.js';
import { SqliteDartRawSnapshotStore } from '../modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteFactRepository } from '../modules/facts/infrastructure/sqlite-fact-repository.js';
import { createKrxHistoricalUniverseSource } from '../modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { createFredBenchmarkSource } from '../modules/market-data/infrastructure/fred/fred-benchmark-source.js';
import { SymbolMasterService } from '../modules/market-data/application/symbol-master-service.js';
import { SymbolMasterBackfill } from '../modules/market-data/application/symbol-master-backfill.js';
import { SymbolMasterScheduler } from '../modules/market-data/application/symbol-master-scheduler.js';
import { SelectionMetricRepository } from '../modules/market-data/application/selection-metric-repository.js';
import { UniverseRuleResolver } from '../modules/backtest/application/universe-rule-resolver.js';
import { BacktestPreparationOrchestrator } from '../modules/backtest/application/backtest-preparation-orchestrator.js';
import {
  assertSafePinnedScheduleIdentities,
} from '../modules/backtest/application/backtest-symbol-identity.js';
import {
  financialCoverageGapMessage,
  findFinancialCoverageGap,
} from '../modules/backtest/application/backtest-financial-coverage.js';
import {
  delistedEventsToTsMsBySymbol,
  financialFactCutoffsFromCoverage,
} from '../modules/backtest/application/backtest-financial-execution-window.js';
import { BenchmarkService } from '../modules/market-data/application/benchmark-service.js';
import { RemoteWorkerService } from '../modules/backtest/application/remote-worker-service.js';
import { RemoteInputBundleManager } from '../modules/backtest/infrastructure/remote-input-bundle-manager.js';
import { RemoteResultUploadManager } from '../modules/backtest/infrastructure/remote-result-upload-manager.js';
import { ForkedRemoteResultCompleter } from '../modules/backtest/infrastructure/forked-remote-result-completer.js';
import { kstDateOf } from '../modules/market-data/domain/kst-date.js';

export interface SystemStatusProviders {
  queueLength: () => number;
  runningJobs: () => number;
}

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  readonly appVersion: string;
  readonly gitCommitSha: string;
  readonly systemStatus: SystemStatusProviders;
  readonly auditLog: AuditLogService;
  readonly notificationService: NotificationService;
  readonly externalApiUsage: ExternalApiUsage;
  readonly userRepository: UserRepository;
  readonly sessionRepository: SessionRepository;
  readonly loginAttemptRepository: LoginAttemptRepository;
  readonly passwordHasher: PasswordHasher;
  readonly totpService: TotpService;
  readonly authService: AuthService;
  readonly candleRepository: CandleRepository;
  readonly candleCoverageService: CandleCoverageService;
  readonly symbolService: SymbolService;
  readonly symbolInfoService: SymbolInfoService;
  readonly strategyRegistry: StrategyRegistry;
  readonly backtestWizardDraftService: BacktestWizardDraftService;
  readonly jobQueue: JobQueue;
  readonly jobOrchestrator: JobOrchestrator;
  readonly remoteWorkerService: RemoteWorkerService;
  readonly remoteInputBundleManager: RemoteInputBundleManager;
  readonly remoteResultUploadManager: RemoteResultUploadManager;
  readonly resultsService: ResultsService;
  readonly seedCloneBatchService: SeedCloneBatchService;
  readonly benchmarkService: BenchmarkService;
  readonly factRepository: FactRepository;
  readonly financialFactAvailabilityService: FinancialFactAvailabilityService;
  readonly factSyncService: FactSyncService;
  readonly symbolMasterService: SymbolMasterService;
  readonly symbolMasterBackfill: SymbolMasterBackfill;
  readonly symbolMasterScheduler: SymbolMasterScheduler;
  readonly universeRuleResolver: UniverseRuleResolver;
  /**
   * DECLINE stage 후보의 자본변동 수집 연도를 판정할 때 쓴다(`UniverseRuleResolver.
   * resolveOrDescribeNeeds`) — 준비(preparation) orchestrator 가 이 판정으로 아직
   * 못 채운 연도를 알아내 동기화 계획을 세운다. 제출 시점 게이트(Task 6)는 Task 10에서
   * 없앴다.
   */
  readonly actionCoverageStore: CorporateActionCoverageStore;
  /** 재무 수집 coverage. 실제 PIT 재무 행 존재 여부와는 별도 상태다. */
  readonly factCoverageStore: FactCoverageStore;
  readonly backtestPreparationOrchestrator: BacktestPreparationOrchestrator;
  close(): Promise<void>;
}

function readAppVersion(): string {
  try {
    const packageJsonUrl = new URL('../../../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8')) as {
      version?: string;
    };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createContainer(config: AppConfig): Container {
  configureZodLocale();
  const logger = createLogger(config);

  for (const dir of [config.dataRoot, config.importRoot, config.exportRoot, config.tempRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const database = openDatabase(config.databasePath);
  const clock = systemClock;

  // 무한 증가 방지: 만료 세션·오래된 로그인 시도·보존 기간 지난 감사 로그 정리.
  // 부팅 시 1회 + 6시간 주기. 정리는 정확성에 필요한 작업이 아니므로 어느 쪽도
  // 프로세스를 죽이지 않는다 — 부팅 시 남아있는 고아 자식 프로세스가 쓰기 잠금을
  // 쥐고 있으면(§10 복구 경로가 상정하는 상황) busy_timeout 5s 를 넘길 수 있고,
  // 그때 throw 하면 systemd Restart=on-failure 와 맞물려 재시작 루프가 된다.
  // DB 자체가 못 쓸 상태라면 첫 질의에서 드러나고 health check 가 걸러낸다.
  const pruneOptions = {
    idleTimeoutMs: config.sessionIdleTimeoutSeconds * 1000,
    absoluteTimeoutMs: config.sessionAbsoluteTimeoutSeconds * 1000,
    auditLogRetentionMs: config.auditLogRetentionDays * 86_400_000,
    notificationRetentionMs: config.notificationRetentionDays * 86_400_000,
  };
  if (pruneOptions.auditLogRetentionMs > 0) {
    logger.info(
      { module: 'maintenance', auditLogRetentionDays: config.auditLogRetentionDays },
      'audit log retention active',
    );
  }
  const prune = (phase: 'boot' | 'periodic'): void => {
    try {
      pruneExpiredRows(database.db, clock.now(), pruneOptions);
    } catch (error) {
      logger.warn({ module: 'maintenance', phase, err: error }, 'prune failed — skipping cycle');
    }
  };
  prune('boot');
  const pruneTimer = setInterval(() => prune('periodic'), 6 * 3_600_000);
  pruneTimer.unref();

  const auditLog = createAuditLogService(database.db, clock, logger);
  const notificationService = new NotificationService(database.db, clock);
  // 알림 생성 실패는 본 작업(백테스트·동기화)을 막지 않는다 — warn 만 남기고 삼킨다
  const safeNotify = (input: NotificationInput): void => {
    try {
      notificationService.create(input);
    } catch (error) {
      logger.warn(
        { module: 'notification', event: 'notify.failed', err: error },
        'notification create failed',
      );
    }
  };
  const externalApiUsage = new SqliteExternalApiUsage({
    database,
    clock,
    currentDateKst: kstDateOf,
    onQuotaExceeded: (event) => {
      safeNotify({
        type: 'data-sync',
        severity: 'error',
        title: `${event.api} API 호출 한도 초과`,
        body:
          `${event.message}\n` +
          `${event.usageDateKst} (KST) 기록 호출 수: ${event.callsUsed.toLocaleString('ko-KR')}회`,
        link: event.api === 'KRX' ? '/datasets/master' : null,
      });
    },
  });
  const userRepository = createSqliteUserRepository(database.db, logger);
  const sessionRepository = createSqliteSessionRepository(database.db);
  const loginAttemptRepository = createSqliteLoginAttemptRepository(database.db);

  const authService = new AuthService({
    users: userRepository,
    sessions: sessionRepository,
    loginAttempts: loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totp: otpauthTotpService,
    clock,
    audit: auditLog,
    idleTimeoutMs: config.sessionIdleTimeoutSeconds * 1000,
    absoluteTimeoutMs: config.sessionAbsoluteTimeoutSeconds * 1000,
  });

  // 봉은 KRX 일봉 하나뿐이다 — 쓰기는 SymbolMasterService.ingestDate 가 종목 마스터
  // 이벤트와 같은 트랜잭션에서 직접 한다.
  const candleRepository = new KrxDailyCandleRepository(database.db);
  // 백테스트 제출 검증용 커버리지 — 캐시 없이 krx_daily_bars 를 직접 집계한다(Task 6).
  const candleCoverageService = new CandleCoverageService(database.db);
  // 종목 등록·이름·재무 버전 체인만 SymbolService 가 맡는다.
  // 봉 수집·CSV 가져오기·슬라이스 커버리지는 이 커밋(Task 5,
  // 2026-08-07-price-data-removal)이 걷어냈다. 그래서 이제 봉 저장소를 주입받지 않는다.
  const symbolService = new SymbolService(database.db, clock, auditLog);

  const factRepository = new SqliteFactRepository(database.db);
  const financialFactAvailabilityService = new FinancialFactAvailabilityService(database.db);
  const dartRawSnapshots = new SqliteDartRawSnapshotStore(database.db);
  const factSource = createDartFactSource(
    config.dartApiKey ? { baseUrl: config.dartBaseUrl, apiKey: config.dartApiKey } : null,
    logger,
    // 미래 보고서 생략(filableReportCount)이 sync 계획과 같은 시각을 봐야 한다
    { clock, usage: externalApiUsage, rawSnapshots: dartRawSnapshots },
  );
  // 팩트도 백테스트 입력이다 — 캔들과 같은 버전 체인에 올린다 (§9.5).
  // SymbolService 를 통째로 넘기지 않고 좁은 포트(SymbolVersionBumper)로 받는다.
  // 팩트와 coverage가 같은 SQLite 백업·트랜잭션 경계에 있으므로 파일 교차 검사는 없다.
  const factCoverageStore = new SqliteFactCoverageStore(database.db);
  // 자본변동 전용 수집(Task 5)이 갱신하는 별도 커버리지 — 재무 커버리지와 컬럼이
  // 다르다 (corporate-action-coverage.ts 헤더 참고).
  const actionCoverageStore = new SqliteCorporateActionCoverageStore(database.db);
  const factSyncService = new FactSyncService(
    factSource,
    factRepository,
    logger,
    symbolService,
    clock,
    factCoverageStore,
    actionCoverageStore,
  );
  // 증권사 선택은 조립부 전용 지식 (§2.4) — 애플리케이션은 StockInfoSource 만 안다.
  // 자격 증명 미설정이면 어댑터가 포트 에러를 던지는 비활성 소스가 된다.
  const stockInfoSource = createTossStockInfoSource(
    config.tossClientId && config.tossClientSecret
      ? {
          baseUrl: config.tossBaseUrl,
          clientId: config.tossClientId,
          clientSecret: config.tossClientSecret,
        }
      : null,
    logger,
  );
  // 로컬 폴백(symbolService)을 함께 넘긴다 — 증권사가 모르거나 조회에 실패한 코드도
  // 종목 마스터가 채워 둔 이름이 있으면 그걸로 보여준다 (자격 증명 미설정 환경도 포함).
  const symbolInfoService = new SymbolInfoService(stockInfoSource, clock, logger, symbolService);

  // KRX 과거 시점 조회 (설계 2026-08-03-krx-historical-universe). API 키 미설정이면
  // 어댑터가 포트 에러를 던지는 비활성 소스가 된다 — 다른 데이터 경로와 같은 패턴
  // (§2.4 조립부 전용 지식). 과거 손으로 스냅샷을 확정하던 화면(데이터셋·유니버스
  // 스냅샷, 스펙 2026-08-05 Task 6 가 제거)은 사라졌고, 지금은 종목 마스터가 이
  // 소스를 직접 쓴다.
  const krxSource = createKrxHistoricalUniverseSource(
    config.krxApiKey
      ? { baseUrl: config.krxBaseUrl, apiKey: config.krxApiKey, approvalExpiry: config.krxApprovalExpiry }
      : null,
    clock,
    logger,
    { usage: externalApiUsage },
  );
  const fredSource = createFredBenchmarkSource(
    config.fredApiKey ? { baseUrl: config.fredBaseUrl, apiKey: config.fredApiKey } : null,
    logger,
  );

  const benchmarkService = new BenchmarkService({
    db: database.db,
    krxSource,
    fredSource,
    clock,
    logger,
  });

  // 종목 마스터 (설계 2026-08-05-symbol-master-core).
  const symbolMasterService = new SymbolMasterService({
    db: database.db,
    source: krxSource,
    clock,
    logger,
  });
  const symbolMasterBackfill = new SymbolMasterBackfill({
    service: symbolMasterService,
    source: krxSource,
    clock,
    logger,
    dailyCallBudget: config.krxDailyCallBudget,
  });
  const symbolMasterScheduler = new SymbolMasterScheduler({
    service: symbolMasterService,
    backfill: symbolMasterBackfill,
    clock,
    logger,
  });
  // 유니버스 규칙(시총 상위 N) → 리밸런스 날짜별 멤버십 일정 (스펙 2026-08-05) —
  // 백테스트 제출·미리보기가 공유한다.
  const selectionMetricRepository = new SelectionMetricRepository(database.db);
  const universeRuleResolver = new UniverseRuleResolver({
    symbolMaster: symbolMasterService,
    selectionMetrics: selectionMetricRepository,
    candles: candleRepository,
    facts: factRepository,
    factCoverage: factCoverageStore,
    actionCoverage: actionCoverageStore,
    logger,
  });

  // 알림 리스너와 라우트가 같은 인스턴스를 봐야 한다 — 두 개를 만들면 등록 목록이 갈라진다
  const strategyRegistry = new StrategyRegistry();
  const backtestPreparationOrchestrator = new BacktestPreparationOrchestrator({
    database,
    resolver: universeRuleResolver,
    factSync: factSyncService,
    factCoverage: factCoverageStore,
    actionCoverage: actionCoverageStore,
    symbolMaster: symbolMasterService,
    strategies: strategyRegistry,
    symbolService,
    candleCoverage: candleCoverageService,
    clock,
    logger,
    externalApiUsage,
  });
  const resultsService = new ResultsService(database.db);
  const backtestWizardDraftService = new BacktestWizardDraftService(database.db, clock);

  const jobQueue = new JobQueue(database, clock);
  const jobOrchestrator = new JobOrchestrator(jobQueue, config, logger, auditLog, clock);
  const remoteResultCompleter = new ForkedRemoteResultCompleter(config.databasePath);
  const remoteWorkerService = new RemoteWorkerService(
    jobQueue,
    config,
    readGitCommitSha(config.nodeEnv),
    clock,
    auditLog,
    logger,
    remoteResultCompleter,
  );
  const remoteInputBundleManager = new RemoteInputBundleManager(config.databasePath, config.tempRoot);
  const remoteResultUploadManager = new RemoteResultUploadManager(config.tempRoot);
  const seedCloneBatchService = new SeedCloneBatchService(
    database,
    jobQueue,
    config.maxQueuedBacktests,
    clock,
    (schedule, request) => {
      assertSafePinnedScheduleIdentities(schedule, {
        symbolMaster: symbolMasterService,
      });
      if (!symbolMasterService.isRangeCovered(request.period.from, request.period.to)) {
        throw new Error(
          '종목 마스터가 백테스트 기간 전체를 커버하지 않습니다 — '
            + '기간 전체 KRX 데이터를 동기화한 뒤 난수 시드 실험을 다시 시작하세요.',
        );
      }
      const symbols = [...new Set(schedule.flatMap((entry) => entry.symbols))].sort();
      const { fromTsMs, toTsMs } = periodToTsRange(request.period);
      const periodCoverage = candleCoverageService
        .getCoverageBetween(symbols, fromTsMs, toTsMs);
      const missingSymbols = periodCoverage
        .filter((row) => row.barCount === 0)
        .map((row) => row.code);
      if (missingSymbols.length > 0) {
        throw new Error(
          `선택한 기간에 일봉이 없는 유니버스 종목이 있습니다: ${missingSymbols.join(', ')} — `
            + '일봉을 동기화한 뒤 난수 시드 실험을 다시 시작하세요.',
        );
      }
      const strategy = strategyRegistry.get(request.strategyId);
      if (strategy === null) {
        throw new Error(`알 수 없는 전략입니다: ${request.strategyId}`);
      }
      const financialCoverageGap = findFinancialCoverageGap({
        request,
        strategy,
        symbols,
        coverage: factCoverageStore,
      });
      if (financialCoverageGap !== null) {
        throw new Error(financialCoverageGapMessage(financialCoverageGap));
      }
      if (!strategyRequiresFinancialData(strategy)) return;
      const financialCutoffs = financialFactCutoffsFromCoverage({
        period: request.period,
        schedule,
        delistedTsMsBySymbol: delistedEventsToTsMsBySymbol(
          symbolMasterService.delistedEventsBetween(request.period.from, request.period.to),
        ),
        candles: candleCoverageService,
      });
      const missingCutoffs = symbols.filter((symbol) => !financialCutoffs.has(symbol));
      if (missingCutoffs.length > 0) {
        throw new Error(
          `실제 편입 기간·상장폐지 이전에 실행 가능한 일봉이 없는 종목이 있습니다: ${missingCutoffs.join(', ')} — `
          + '일봉과 유니버스 데이터를 다시 준비한 뒤 난수 시드 실험을 다시 시작하세요.',
        );
      }
      if (financialFactAvailabilityService.symbolsWithFinancialFacts(financialCutoffs).size === 0) {
        throw new Error(
          '재무 coverage 기록은 있지만 마지막 실행 봉까지 사용 가능한 재무 데이터가 '
            + `유니버스 전체에 없습니다: ${symbols.join(', ')} — `
            + '기간 종료일·유니버스·전략을 조정한 뒤 난수 시드 실험을 다시 시작하세요.',
        );
      }
    },
  );
  const backtestNotificationListener = createBacktestNotificationListener({
    queue: jobQueue,
    strategyName: (strategyId) => strategyRegistry.describe(strategyId)?.name ?? null,
    totalReturnPct: (jobId) => resultsService.getTotalReturnPct(jobId),
    notify: safeNotify,
    logger,
  });
  const rawSeedBatchJobListener = createSeedCloneBatchJobListener(seedCloneBatchService);
  const seedBatchJobListener = (event: JobEvent): void => {
    try {
      rawSeedBatchJobListener(event);
    } catch (error) {
      logger.warn(
        { module: 'backtest', event: 'backtest.seed-batch-listener-failed', jobId: event.jobId, err: error },
        'seed batch job listener failed',
      );
    }
  };
  const cleanupRemoteInput = (event: JobEvent): void => {
    if (event.kind !== 'status') return;
    try {
      const job = jobQueue.getJob(event.jobId);
      if (
        job === null
        || job.attempt === 0
        || !['CANCELLED', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(job.status)
      ) return;
      void remoteInputBundleManager.removeJob(event.jobId).catch((error) => {
        logger.warn(
          { module: 'backtest', event: 'backtest.remote-input-cleanup-failed', jobId: event.jobId, err: error },
          'remote input bundle cleanup failed',
        );
      });
    } catch (error) {
      logger.warn(
        { module: 'backtest', event: 'backtest.remote-input-cleanup-failed', jobId: event.jobId, err: error },
        'remote input bundle cleanup failed',
      );
    }
  };
  for (const source of [jobOrchestrator.events, remoteWorkerService.events]) {
    source.on('job', backtestNotificationListener);
    source.on('job', seedBatchJobListener);
    source.on('job', cleanupRemoteInput);
  }
  seedCloneBatchService.events.on(
    'batch',
    createSeedCloneBatchNotificationListener({
      getBatch: (batchId) => seedCloneBatchService.get(batchId),
      strategyName: (strategyId) => strategyRegistry.describe(strategyId)?.name ?? null,
      notify: safeNotify,
      logger,
    }),
  );

  const systemStatus: SystemStatusProviders = {
    queueLength: () => jobQueue.countByStatus(['QUEUED']),
    runningJobs: () => jobQueue.countByStatus(['STARTING', 'RUNNING', 'CANCELLING']),
  };

  let closing: Promise<void> | null = null;
  return {
    config,
    logger,
    database,
    clock,
    appVersion: readAppVersion(),
    gitCommitSha: readGitCommitSha(config.nodeEnv),
    systemStatus,
    auditLog,
    notificationService,
    externalApiUsage,
    userRepository,
    sessionRepository,
    loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totpService: otpauthTotpService,
    authService,
    candleRepository,
    candleCoverageService,
    symbolService,
    symbolInfoService,
    strategyRegistry,
    backtestWizardDraftService,
    jobQueue,
    jobOrchestrator,
    remoteWorkerService,
    remoteInputBundleManager,
    remoteResultUploadManager,
    resultsService,
    seedCloneBatchService,
    benchmarkService,
    factRepository,
    financialFactAvailabilityService,
    factCoverageStore,
    factSyncService,
    symbolMasterService,
    symbolMasterBackfill,
    symbolMasterScheduler,
    universeRuleResolver,
    actionCoverageStore,
    backtestPreparationOrchestrator,
    close: () => {
      if (closing !== null) return closing;
      closing = (async () => {
        clearInterval(pruneTimer);
        jobOrchestrator.stop();
        remoteWorkerService.stop();
        // FactSync는 symbol 단위 저장이 끝난 뒤 멈춘다. 이 경계를 기다리기 전에
        // SQLite를 닫으면 저장 callback이 닫힌 자원을 다시 건드린다.
        await backtestPreparationOrchestrator.stop();
        database.close();
      })();
      return closing;
    },
  };
}
