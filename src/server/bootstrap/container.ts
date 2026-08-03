import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { readGitCommitSha } from '../shared/build-info.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';
import { pruneExpiredRows } from '../shared/db/maintenance.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { configureZodLocale } from '../shared/zod-locale.js';
import { createAuditLogService, type AuditLogService } from '../modules/audit/audit-service.js';
import { NotificationService } from '../modules/notification/application/notification-service.js';
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
import { SymbolMetricsService } from '../modules/market-data/application/symbol-metrics-service.js';
import { SymbolService } from '../modules/market-data/application/symbol-service.js';
import type { CandleRepository } from '../modules/market-data/application/ports.js';
import { createTossMarketDataSource } from '../modules/broker/infrastructure/toss/toss-market-data-source.js';
import { DuckDbService } from '../modules/market-data/infrastructure/duckdb-service.js';
import { ParquetCandleRepository } from '../modules/market-data/infrastructure/parquet-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { JobOrchestrator } from '../modules/backtest/application/job-orchestrator.js';
import { JobQueue } from '../modules/backtest/application/job-queue.js';
import { ResultsService } from '../modules/backtest/application/results-service.js';
import { createFactsPhase, createFactsSyncEstimator } from './facts-wiring.js';
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
  readonly notificationService: NotificationService;
  readonly userRepository: UserRepository;
  readonly sessionRepository: SessionRepository;
  readonly loginAttemptRepository: LoginAttemptRepository;
  readonly passwordHasher: PasswordHasher;
  readonly totpService: TotpService;
  readonly authService: AuthService;
  readonly duckdb: DuckDbService;
  readonly candleRepository: CandleRepository;
  readonly datasetService: DatasetService;
  readonly symbolService: SymbolService;
  readonly brokerSyncService: BrokerSyncService;
  readonly symbolInfoService: SymbolInfoService;
  readonly symbolMetricsService: SymbolMetricsService;
  readonly strategyRegistry: StrategyRegistry;
  readonly jobQueue: JobQueue;
  readonly jobOrchestrator: JobOrchestrator;
  readonly resultsService: ResultsService;
  readonly factRepository: FactRepository;
  readonly factSyncService: FactSyncService;
  readonly factsSyncEstimator: (codes: readonly string[]) => FactsSyncEstimate;
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
  // 종목이 데이터 소관, 데이터셋은 그 참조 묶음 (설계 2026-07-31-symbol-as-first-class).
  // DatasetService 가 SymbolService 에 의존하는 방향이다 — 버전 스냅샷을 만들 때 종목별
  // 버전을 읽어야 하고, 그 반대 방향(종목이 데이터셋을 아는 것)은 필요하지 않다.
  const symbolService = new SymbolService(
    database.db,
    candleRepository,
    clock,
    logger,
    auditLog,
  );
  const datasetService = new DatasetService(database.db, symbolService, clock, auditLog);

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
  // 팩트도 백테스트 입력이다 — 캔들과 같은 버전 체인에 올린다 (§9.5).
  // SymbolService 를 통째로 넘기지 않고 좁은 포트(SymbolVersionBumper)로 받는다.
  const factCoverageStore = new SqliteFactCoverageStore(database.db);
  const factSyncService = new FactSyncService(
    factSource,
    factRepository,
    logger,
    symbolService,
    clock,
    factCoverageStore,
  );

  // market-data ↔ facts 를 잇는 두 클로저는 facts-wiring.ts 에 있다 — 누적 처리와
  // plan 값 그대로 넘기기가 타입으로 잡히지 않는 종류의 버그라 테스트가 겨눌 수 있는
  // 자리에 두었다 (tests/unit/facts-wiring.test.ts).
  // config.dartApiKey 가 없으면 factsPhase 를 만들지 않는다 → BrokerSyncService 가
  // skipReason 을 남긴다.
  const factsPhase = config.dartApiKey ? createFactsPhase({ factSyncService }) : undefined;
  const factsSyncEstimator = createFactsSyncEstimator({
    dartApiKey: config.dartApiKey,
    symbolService,
    factCoverageStore,
    clock,
  });

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
    symbolService,
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
  // 발행주식수는 이름과 같은 응답에 있다 — SymbolInfoService 를 넘겨 24시간 캐시를
  // 나눠 쓴다. 소스를 직접 주면 /stocks 를 두 벌 부르게 된다.
  const symbolMetricsService = new SymbolMetricsService(
    symbolInfoService,
    marketDataSource,
    marketDataSource,
    clock,
    logger,
  );
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
    notificationService,
    userRepository,
    sessionRepository,
    loginAttemptRepository,
    passwordHasher: argon2PasswordHasher,
    totpService: otpauthTotpService,
    authService,
    duckdb,
    candleRepository,
    datasetService,
    symbolService,
    brokerSyncService,
    symbolInfoService,
    symbolMetricsService,
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
