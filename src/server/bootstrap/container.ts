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
import type { NotificationInput } from '../modules/notification/application/notification-service.js';
import { createBacktestNotificationListener } from './notification-wiring.js';
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
import { DuckDbService } from '../modules/market-data/infrastructure/duckdb-service.js';
import { KrxDailyCandleRepository } from '../modules/market-data/infrastructure/krx-daily-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { JobOrchestrator } from '../modules/backtest/application/job-orchestrator.js';
import { JobQueue } from '../modules/backtest/application/job-queue.js';
import { ResultsService } from '../modules/backtest/application/results-service.js';
import type { FactRepository } from '../modules/facts/application/ports.js';
import { SqliteFactCoverageStore } from '../modules/facts/application/fact-coverage-store.js';
import { FactSyncService } from '../modules/facts/application/fact-sync-service.js';
import { createDartFactSource } from '../modules/facts/infrastructure/dart/dart-fact-source.js';
import { ParquetFactRepository } from '../modules/facts/infrastructure/parquet-fact-repository.js';
import { createKrxHistoricalUniverseSource } from '../modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { SymbolMasterService } from '../modules/market-data/application/symbol-master-service.js';
import { SymbolMasterBackfill } from '../modules/market-data/application/symbol-master-backfill.js';
import { SymbolMasterScheduler } from '../modules/market-data/application/symbol-master-scheduler.js';
import { UniverseRuleResolver } from '../modules/backtest/application/universe-rule-resolver.js';

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
  readonly candleCoverageService: CandleCoverageService;
  readonly symbolService: SymbolService;
  readonly symbolInfoService: SymbolInfoService;
  readonly strategyRegistry: StrategyRegistry;
  readonly jobQueue: JobQueue;
  readonly jobOrchestrator: JobOrchestrator;
  readonly resultsService: ResultsService;
  readonly factRepository: FactRepository;
  readonly factSyncService: FactSyncService;
  readonly symbolMasterService: SymbolMasterService;
  readonly symbolMasterBackfill: SymbolMasterBackfill;
  readonly symbolMasterScheduler: SymbolMasterScheduler;
  readonly universeRuleResolver: UniverseRuleResolver;
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
  // 봉은 KRX 일봉 하나뿐이다 — 쓰기는 SymbolMasterService.ingestDate 가 종목 마스터
  // 이벤트와 같은 트랜잭션에서 직접 한다.
  const candleRepository = new KrxDailyCandleRepository(database.db);
  // 백테스트 제출 검증용 커버리지 — 캐시 없이 krx_daily_bars 를 직접 집계한다(Task 6).
  const candleCoverageService = new CandleCoverageService(database.db);
  // 종목 등록·이름·재무 버전 체인만 SymbolService 가 맡는다.
  // 봉 수집·CSV 가져오기·슬라이스 커버리지는 이 커밋(Task 5,
  // 2026-08-07-price-data-removal)이 걷어냈다. 그래서 이제 봉 저장소를 주입받지 않는다.
  const symbolService = new SymbolService(database.db, clock, auditLog);

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
  );

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
  const universeRuleResolver = new UniverseRuleResolver({ symbolMaster: symbolMasterService, logger });

  const jobQueue = new JobQueue(database, clock);
  const jobOrchestrator = new JobOrchestrator(jobQueue, config, logger, auditLog, clock);
  jobOrchestrator.events.on(
    'job',
    createBacktestNotificationListener({ queue: jobQueue, notify: safeNotify, logger }),
  );
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
    candleCoverageService,
    symbolService,
    symbolInfoService,
    strategyRegistry: new StrategyRegistry(),
    jobQueue,
    jobOrchestrator,
    resultsService,
    factRepository,
    factSyncService,
    symbolMasterService,
    symbolMasterBackfill,
    symbolMasterScheduler,
    universeRuleResolver,
    close: () => {
      clearInterval(pruneTimer);
      jobOrchestrator.stop();
      duckdb.close();
      database.close();
    },
  };
}
