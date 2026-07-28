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
import { DatasetService } from '../modules/market-data/application/dataset-service.js';
import { SymbolInfoService } from '../modules/market-data/application/symbol-info-service.js';
import type { CandleRepository } from '../modules/market-data/application/ports.js';
import { createTossMarketDataSource } from '../modules/broker/infrastructure/toss/toss-market-data-source.js';
import { DuckDbService } from '../modules/market-data/infrastructure/duckdb-service.js';
import { ParquetCandleRepository } from '../modules/market-data/infrastructure/parquet-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { JobOrchestrator } from '../modules/backtest/application/job-orchestrator.js';
import { JobQueue } from '../modules/backtest/application/job-queue.js';
import { ResultsService } from '../modules/backtest/application/results-service.js';

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
    close: () => {
      clearInterval(pruneTimer);
      jobOrchestrator.stop();
      duckdb.close();
      database.close();
    },
  };
}
