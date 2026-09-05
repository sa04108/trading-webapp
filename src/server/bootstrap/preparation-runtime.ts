import type { AppConfig } from './config.js';
import { createAuditLogService } from '../modules/audit/audit-service.js';
import { BacktestPreparationOrchestrator } from '../modules/backtest/application/backtest-preparation-orchestrator.js';
import { UniverseRuleResolver } from '../modules/backtest/application/universe-rule-resolver.js';
import { SqliteCorporateActionCoverageStore } from '../modules/facts/application/corporate-action-coverage.js';
import { SqliteFactCoverageStore } from '../modules/facts/application/fact-coverage-store.js';
import { FactSyncService } from '../modules/facts/application/fact-sync-service.js';
import { FinancialFactAvailabilityService } from '../modules/facts/application/financial-fact-availability.js';
import { createDartFactSource } from '../modules/facts/infrastructure/dart/dart-fact-source.js';
import { SqliteDartRawSnapshotStore } from '../modules/facts/infrastructure/dart/sqlite-dart-raw-snapshot-store.js';
import { SqliteFactRepository } from '../modules/facts/infrastructure/sqlite-fact-repository.js';
import { CandleCoverageService } from '../modules/market-data/application/candle-coverage-service.js';
import { SelectionMetricRepository } from '../modules/market-data/application/selection-metric-repository.js';
import { SymbolMasterService } from '../modules/market-data/application/symbol-master-service.js';
import { SymbolService } from '../modules/market-data/application/symbol-service.js';
import { kstDateOf } from '../modules/market-data/domain/kst-date.js';
import { createKrxHistoricalUniverseSource } from '../modules/market-data/infrastructure/krx/krx-historical-universe-source.js';
import { KrxDailyCandleRepository } from '../modules/market-data/infrastructure/krx-daily-candle-repository.js';
import { StrategyRegistry } from '../modules/strategy/application/strategy-registry.js';
import { NotificationService } from '../modules/notification/application/notification-service.js';
import type { NotificationRow } from '../modules/notification/application/notification-service.js';
import { createPreparationNotificationListener } from './preparation-notification-wiring.js';
import { systemClock } from '../shared/clock.js';
import { openDatabase } from '../shared/db/database.js';
import { SqliteExternalApiUsage } from '../shared/db/external-api-usage.js';
import { createLogger } from '../shared/logger.js';
import { configureZodLocale } from '../shared/zod-locale.js';

export interface PreparationRuntime {
  readonly orchestrator: BacktestPreparationOrchestrator;
  close(): Promise<void>;
}

/**
 * 자식 프로세스에는 준비 작업과 종료·호출 한도 알림에 필요한 의존성만 구성한다.
 * 유지보수 타이머, HTTP 서버, 백테스트 스케줄러, 원격 워커나 중첩 실행기는 만들지 않는다.
 */
export function createPreparationRuntime(
  config: AppConfig,
  onJobUpdated?: (jobId: string) => void,
  onNotificationCreated?: (notification: NotificationRow) => void,
): PreparationRuntime {
  configureZodLocale();
  const logger = createLogger(config);
  const database = openDatabase(config.databasePath);
  const clock = systemClock;
  const audit = createAuditLogService(database.db, clock, logger);
  const notifications = new NotificationService(database.db, clock);
  const strategyRegistry = new StrategyRegistry();
  const preparationNotificationListener = createPreparationNotificationListener({
    database,
    strategyName: (strategyId) => strategyRegistry.describe(strategyId)?.name ?? null,
    notify: (input) => {
      const notification = notifications.create(input);
      onNotificationCreated?.(notification);
    },
    logger,
  });
  const externalApiUsage = new SqliteExternalApiUsage({
    database,
    clock,
    currentDateKst: kstDateOf,
    onQuotaExceeded: (event) => {
      try {
        const notification = notifications.create({
          type: 'data-sync',
          severity: 'error',
          title: `${event.api} API 호출 한도 초과`,
          body: `${event.message}\n${event.usageDateKst} (KST) 기록 호출 수: `
            + `${event.callsUsed.toLocaleString('ko-KR')}회`,
          link: event.api === 'KRX' ? '/datasets/master' : null,
        });
        onNotificationCreated?.(notification);
      } catch (error) {
        logger.warn(
          { module: 'preparation-child', event: 'notify.failed', err: error },
          'quota notification create failed',
        );
      }
    },
  });
  const symbolService = new SymbolService(database.db, clock, audit);
  const candles = new KrxDailyCandleRepository(database.db);
  const candleCoverage = new CandleCoverageService(database.db);
  const facts = new SqliteFactRepository(database.db);
  const financialFacts = new FinancialFactAvailabilityService(database.db);
  const rawSnapshots = new SqliteDartRawSnapshotStore(database.db);
  const factCoverage = new SqliteFactCoverageStore(database.db);
  const actionCoverage = new SqliteCorporateActionCoverageStore(database.db);
  const dartSource = createDartFactSource(
    config.dartApiKey ? { baseUrl: config.dartBaseUrl, apiKey: config.dartApiKey } : null,
    logger,
    { clock, usage: externalApiUsage, rawSnapshots },
  );
  const factSync = new FactSyncService(
    dartSource,
    facts,
    logger,
    symbolService,
    clock,
    factCoverage,
    actionCoverage,
  );
  const krxSource = createKrxHistoricalUniverseSource(
    config.krxApiKey
      ? {
          baseUrl: config.krxBaseUrl,
          apiKey: config.krxApiKey,
          approvalExpiry: config.krxApprovalExpiry,
        }
      : null,
    clock,
    logger,
    { usage: externalApiUsage },
  );
  const symbolMaster = new SymbolMasterService({ db: database.db, source: krxSource, clock, logger });
  const resolver = new UniverseRuleResolver({
    symbolMaster,
    selectionMetrics: new SelectionMetricRepository(database.db),
    candles,
    facts,
    factCoverage,
    actionCoverage,
    logger,
  });
  const orchestrator = new BacktestPreparationOrchestrator({
    database,
    resolver,
    factSync,
    facts,
    factCoverage,
    actionCoverage,
    symbolMaster,
    strategies: strategyRegistry,
    symbolService,
    candleCoverage,
    clock,
    logger,
    externalApiUsage,
    financialFacts,
    onJobUpdated,
    onJobFinished: preparationNotificationListener,
  });

  return {
    orchestrator,
    async close() {
      await orchestrator.stop();
      database.close();
    },
  };
}
