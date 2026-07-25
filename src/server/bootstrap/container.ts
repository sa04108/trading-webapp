import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { openDatabase, type DatabaseHandle } from '../shared/db/database.js';
import { systemClock, type Clock } from '../shared/clock.js';
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
import { DatasetService } from '../modules/market-data/application/dataset-service.js';
import type { CandleRepository } from '../modules/market-data/application/ports.js';
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
  const logger = createLogger(config);

  for (const dir of [config.dataRoot, config.importRoot, config.exportRoot, config.tempRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const database = openDatabase(config.databasePath);
  const clock = systemClock;

  const auditLog = createAuditLogService(database.db, clock, logger);
  const userRepository = createSqliteUserRepository(database.db);
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
    gitCommitSha: process.env.BUILD_GIT_SHA ?? 'unknown',
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
    strategyRegistry: new StrategyRegistry(),
    jobQueue,
    jobOrchestrator,
    resultsService,
    close: () => {
      jobOrchestrator.stop();
      duckdb.close();
      database.close();
    },
  };
}
