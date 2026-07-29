import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { readGitCommitSha } from '../shared/build-info.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';
import { pruneExpiredRows } from '../shared/db/maintenance.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { configureZodLocale } from '../shared/zod-locale.js';
import { createAuditLogService, type AuditLogService } from '../modules/audit/audit-service.js';
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
import { BrokerSyncService } from '../modules/market-data/application/broker-sync-service.js';
import {
  DatasetService,
  type FactsSyncEstimate,
} from '../modules/market-data/application/dataset-service.js';
import { SymbolInfoService } from '../modules/market-data/application/symbol-info-service.js';
import type { CandleRepository } from '../modules/market-data/application/ports.js';
import { createTossMarketDataSource } from '../modules/broker/infrastructure/toss/toss-market-data-source.js';
import { DuckDbService } from '../modules/market-data/infrastructure/duckdb-service.js';
import { ParquetCandleRepository } from '../modules/market-data/infrastructure/parquet-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { JobOrchestrator } from '../modules/backtest/application/job-orchestrator.js';
import { JobQueue } from '../modules/backtest/application/job-queue.js';
import { ResultsService } from '../modules/backtest/application/results-service.js';
import { deriveFactYearRange } from '../modules/market-data/domain/fact-year-range.js';
import { planFactSync } from '../modules/facts/domain/sync-plan.js';
import type { FactRepository } from '../modules/facts/application/ports.js';
import { SqliteFactCoverageStore } from '../modules/facts/application/fact-coverage-store.js';
import { FactSyncService } from '../modules/facts/application/fact-sync-service.js';
import { createDartFactSource } from '../modules/facts/infrastructure/dart/dart-fact-source.js';
import { ParquetFactRepository } from '../modules/facts/infrastructure/parquet-fact-repository.js';

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
  readonly userRepository: UserRepository;
  readonly sessionRepository: SessionRepository;
  readonly loginAttemptRepository: LoginAttemptRepository;
  readonly passwordHasher: PasswordHasher;
  readonly totpService: TotpService;
  readonly authService: AuthService;
  readonly duckdb: DuckDbService;
  readonly candleRepository: CandleRepository;
  readonly datasetService: DatasetService;
  readonly brokerSyncService: BrokerSyncService;
  readonly symbolInfoService: SymbolInfoService;
  readonly strategyRegistry: StrategyRegistry;
  readonly jobQueue: JobQueue;
  readonly jobOrchestrator: JobOrchestrator;
  readonly resultsService: ResultsService;
  readonly factRepository: FactRepository;
  readonly factSyncService: FactSyncService;
  readonly factsSyncEstimator: (datasetId: string) => FactsSyncEstimate;
  close(): void;
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

  const duckdb = new DuckDbService({
    threads: config.duckdbThreads,
    memoryLimit: config.duckdbMemoryLimit,
  });
  const candleRepository = new ParquetCandleRepository(config.dataRoot, duckdb);
  const datasetService = new DatasetService(
    database.db,
    candleRepository,
    clock,
    logger,
    auditLog,
  );

  // 재무(facts) 블록은 brokerSyncService 보다 **앞에** 온다. BrokerSyncDeps 는 생성 시
  // 고정이므로 factsPhase 가 그때 이미 있어야 한다 — 반대로 brokerSyncService 를 뒤로
  // 미루면 바로 아래의 recoverInterrupted() 부팅 정리 경로가 깨진다.
  // duckdb 는 위에서 만든 인스턴스를 재사용한다 — 새로 만들면 DuckDB 메모리 상한이
  // 두 배로 잡힌다
  const factRepository = new ParquetFactRepository(config.dataRoot, duckdb);
  const factSource = createDartFactSource(
    config.dartApiKey ? { baseUrl: config.dartBaseUrl, apiKey: config.dartApiKey } : null,
    logger,
  );
  // 팩트도 데이터셋 내용이다 — 캔들과 같은 버전 체인에 올린다 (§9.5).
  // DatasetService 를 통째로 넘기지 않고 좁은 포트(DatasetVersionBumper)로 받는다.
  const factCoverageStore = new SqliteFactCoverageStore(database.db);
  const factSyncService = new FactSyncService(
    factSource,
    factRepository,
    logger,
    datasetService,
    clock,
    factCoverageStore,
  );

  // 재무 단계 — market-data 는 facts 를 import 하지 않는다. 조립부가 잇는다.
  // config.dartApiKey 가 없으면 넘기지 않는다 → BrokerSyncService 가 skipReason 을 남긴다.
  const factsPhase = config.dartApiKey
    ? async (args: {
        datasetId: string;
        fromYear: number;
        toYear: number;
        onProgress: (progress: {
          symbolsDone: number;
          symbolTotal: number;
          savedFacts: number;
          gapCount: number;
        }) => void;
        shouldStop: () => boolean;
      }) => {
        const dataset = datasetService.getDataset(args.datasetId);
        const symbols = dataset?.symbols ?? [];
        // FactPhaseProgress 는 **누적**, FactSyncProgress 는 **종목 단위**다. 필드를
        // 1:1 로 옮기면 (둘 다 number 라 타입으로는 잡히지 않는다) 화면 카운터가
        // 종목마다 12 → 0 → 8 → 0 으로 튄다 — 여기서 누적해서 넘긴다.
        let savedFacts = 0;
        let gapCount = 0;
        const report = await factSyncService.sync(
          {
            datasetId: args.datasetId,
            symbols,
            fromYear: args.fromYear,
            toYear: args.toYear,
            consolidated: true,
            // 웹은 증분이다 — 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
            // 과거 연도 정정공시 전체 재수집은 CLI(facts:sync --from --to)가 담당한다.
            mode: 'INCREMENTAL',
          },
          {
            shouldStop: args.shouldStop,
            onSymbolDone: (progress) => {
              savedFacts += progress.savedFacts;
              gapCount += progress.gapCount;
              args.onProgress({
                symbolsDone: progress.index,
                symbolTotal: progress.total,
                savedFacts,
                gapCount,
              });
            },
          },
        );
        return {
          savedFacts: report.savedFacts,
          // 리포트는 누락을 목록으로 돌려준다 — 잡 상태에는 개수만 싣는다
          gapCount: report.gaps.length,
          stopReason: report.stopReason,
          failureMessage: report.failureMessage,
        };
      }
    : undefined;

  /**
   * 재무 수집 예상. 실행 경로(BrokerSyncService → factsPhase)와 **같은 두 함수** 를
   * 부른다 — deriveFactYearRange 로 연도를, planFactSync 로 호출 수·시간을. 갈라지면
   * 화면의 숫자만 조용히 틀려진다.
   */
  const factsSyncEstimator = (datasetId: string): FactsSyncEstimate => {
    if (!config.dartApiKey) {
      return { basis: 'UNSUPPORTED', reason: 'DART_API_KEY 가 설정되지 않았습니다.' };
    }
    const dataset = datasetService.getDataset(datasetId);
    if (!dataset) return { basis: 'UNSUPPORTED', reason: '데이터셋을 찾을 수 없습니다.' };
    if (dataset.market !== 'KR') {
      return { basis: 'UNSUPPORTED', reason: 'DART 재무 수집은 KR 시장 데이터셋만 지원합니다.' };
    }
    const range = deriveFactYearRange(datasetService.getCoverage(datasetId), dataset.market);
    if (range === null) return { basis: 'AFTER_CANDLES' };

    // 호출 수·시간은 plan 이 준 값을 그대로 쓴다 — 상수로 다시 계산하면 앵커가
    // 연속 구간마다 붙는 불연속 증분에서 과소 추정이 된다 (sync-plan.ts 참고).
    const plan = planFactSync({
      symbols: dataset.symbols,
      fromYear: range.fromYear,
      toYear: range.toYear,
      currentYear: new Date(clock.now()).getUTCFullYear(),
      coveredBySymbol: factCoverageStore.getCoveredYears(datasetId),
      mode: 'INCREMENTAL',
    });
    return {
      basis: 'PLANNED',
      fromYear: range.fromYear,
      toYear: range.toYear,
      calls: plan.calls,
      estimatedMs: plan.estimatedMs,
      overDailyLimit: plan.overDailyLimit,
    };
  };

  // 증권사 선택은 조립부 전용 지식 (§2.4) — 애플리케이션은 MarketDataSource 만 안다.
  // 자격 증명 미설정이면 어댑터가 포트 에러를 던지는 비활성 소스가 된다.
  const marketDataSource = createTossMarketDataSource(
    config.tossClientId && config.tossClientSecret
      ? {
          baseUrl: config.tossBaseUrl,
          clientId: config.tossClientId,
          clientSecret: config.tossClientSecret,
        }
      : null,
    logger,
  );
  const brokerSyncService = new BrokerSyncService({
    db: database.db,
    source: marketDataSource,
    candleRepository,
    datasetService,
    clock,
    logger,
    audit: auditLog,
    minFreeDiskBytes: config.syncMinFreeDiskMb * 1024 * 1024,
    freeDiskBytes: () => {
      const stats = fs.statfsSync(config.dataRoot);
      return stats.bavail * stats.bsize;
    },
    // DART 미설정이면 키 자체를 뺀다 — `factsPhase: undefined` 로 넘기면 "주입했지만
    // 값이 없다" 와 "주입하지 않았다" 가 호출부에서 구분되지 않는다
    ...(factsPhase ? { factsPhase } : {}),
  });
  const symbolInfoService = new SymbolInfoService(marketDataSource, clock, logger);
  // 프로세스 재시작으로 고아가 된 동기화 잡 정리 — 이어받기는 재실행이 담당한다 (§13)
  const interrupted = brokerSyncService.recoverInterrupted();
  if (interrupted > 0) {
    logger.warn(
      { module: 'market-data', event: 'data.sync.interrupted', count: interrupted },
      'recovered orphaned broker sync jobs',
    );
  }

  const jobQueue = new JobQueue(database, clock);
  const jobOrchestrator = new JobOrchestrator(jobQueue, config, logger, auditLog, clock);
  const resultsService = new ResultsService(database.db);

  const systemStatus: SystemStatusProviders = {
    queueLength: () => jobQueue.countByStatus(['QUEUED']),
    runningJobs: () => jobQueue.countByStatus(['STARTING', 'RUNNING', 'CANCELLING']),
  };

  return {
    config,
    logger,
    database,
    clock,
    appVersion: readAppVersion(),
    gitCommitSha: readGitCommitSha(),
    systemStatus,
    auditLog,
    userRepository,
    sessionRepository,
    loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totpService: otpauthTotpService,
    authService,
    duckdb,
    candleRepository,
    datasetService,
    brokerSyncService,
    symbolInfoService,
    strategyRegistry: new StrategyRegistry(),
    jobQueue,
    jobOrchestrator,
    resultsService,
    factRepository,
    factSyncService,
    factsSyncEstimator,
    close: () => {
      clearInterval(pruneTimer);
      jobOrchestrator.stop();
      duckdb.close();
      database.close();
    },
  };
}
