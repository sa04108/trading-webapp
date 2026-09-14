import { pino } from 'pino';
import type { DatabaseHandle } from '../server/shared/db/database.js';
import { systemClock } from '../server/shared/clock.js';
import { createAuditLogService } from '../server/modules/audit/audit-service.js';
import { BacktestPreparationOrchestrator } from '../server/modules/backtest/application/backtest-preparation-orchestrator.js';
import { UniverseRuleResolver } from '../server/modules/backtest/application/universe-rule-resolver.js';
import { SqliteCorporateActionCoverageStore } from '../server/modules/facts/application/corporate-action-coverage.js';
import { SqliteFactCoverageStore } from '../server/modules/facts/application/fact-coverage-store.js';
import { FinancialFactAvailabilityService } from '../server/modules/facts/application/financial-fact-availability.js';
import { SqliteFactRepository } from '../server/modules/facts/infrastructure/sqlite-fact-repository.js';
import { planFactSync } from '../server/modules/facts/domain/sync-plan.js';
import type { FactSyncRequest, FactSyncReport } from '../server/modules/facts/application/fact-sync-service.js';
import { CandleCoverageService } from '../server/modules/market-data/application/candle-coverage-service.js';
import { SelectionMetricRepository } from '../server/modules/market-data/application/selection-metric-repository.js';
import { SymbolMasterService } from '../server/modules/market-data/application/symbol-master-service.js';
import { SymbolService } from '../server/modules/market-data/application/symbol-service.js';
import { kstDateOf } from '../server/modules/market-data/domain/kst-date.js';
import { KrxDailyCandleRepository } from '../server/modules/market-data/infrastructure/krx-daily-candle-repository.js';
import { StrategyRegistry } from '../server/modules/strategy/application/strategy-registry.js';
import { AgentDataRequired } from '../shared/agent-protocol.js';

/** API 어댑터와 자격 증명 없이 같은 계산·결손 검증 코드를 실행한다. */
export function createPreparationWorkerRuntime(database: DatabaseHandle, onJobUpdated?: (jobId: string) => void): BacktestPreparationOrchestrator {
  const clock = systemClock;
  const logger = pino({ level: 'warn' });
  const audit = createAuditLogService(database.db, clock, logger);
  const symbols = new SymbolService(database.db, clock, audit);
  const candles = new KrxDailyCandleRepository(database.db);
  const facts = new SqliteFactRepository(database.db);
  const factCoverage = new SqliteFactCoverageStore(database.db);
  const actionCoverage = new SqliteCorporateActionCoverageStore(database.db);
  const selection = new SelectionMetricRepository(database.db);
  const symbolMaster = new SymbolMasterService({ db: database.db, clock, logger, source: {
    todayMaxEndpointCallCount: () => 0,
    fetchDailyTrades: async (_market, date) => { throw new AgentDataRequired({ kind: 'MARKET', dates: [date] }); },
    fetchIssueBaseInfo: async (_market, date) => { throw new AgentDataRequired({ kind: 'MARKET', dates: [date] }); },
  } });
  const resolver = new UniverseRuleResolver({ symbolMaster, selectionMetrics: selection, candles, facts, factCoverage, actionCoverage, logger });
  const plan = (kind: 'FINANCIAL' | 'ACTIONS', codes: readonly string[], fromYear: number, toYear: number) => planFactSync({
    symbols: codes, fromYear, toYear, mode: 'INCREMENTAL', todayKstDate: kstDateOf(clock.now()),
    coveredBySymbol: kind === 'FINANCIAL' ? factCoverage.getCoveredYears(codes) : actionCoverage.getCoveredYears(codes),
  });
  const requireFacts = async (kind: 'FINANCIAL' | 'ACTIONS', request: FactSyncRequest): Promise<FactSyncReport> => {
    const missing = [...plan(kind, request.symbols, request.fromYear, request.toYear).yearsBySymbol]
      .filter(([, years]) => years.length > 0).map(([symbol]) => symbol);
    if (missing.length > 0) throw new AgentDataRequired({ kind, symbols: missing, fromYear: request.fromYear, toYear: request.toYear });
    return { savedFacts: 0, gapCount: 0, gaps: [], stoppedAtSymbol: null, stopReason: null, failureMessage: null };
  };
  return new BacktestPreparationOrchestrator({
    database, snapshotMode: true, resolver, facts, factCoverage, actionCoverage, clock, logger, onJobUpdated,
    strategies: new StrategyRegistry(),
    symbolService: {
      exists: symbols.exists.bind(symbols),
      getRegisteredIdentity: symbols.getRegisteredIdentity.bind(symbols),
      getRegisteredIdentityByStandardCode: symbols.getRegisteredIdentityByStandardCode.bind(symbols),
      addSymbol: (code, _market, _name, standardCode) => {
        if (!standardCode) throw new Error('표준코드가 없는 종목을 등록할 수 없습니다');
        throw new AgentDataRequired({ kind: 'REGISTER', symbols: [{ symbol: code, standardCode }] });
      },
    },
    symbolMaster: {
      ensureTradingDay: symbolMaster.ensureTradingDay.bind(symbolMaster),
      ingestDate: symbolMaster.ingestDate.bind(symbolMaster),
      isRangeCovered: symbolMaster.isRangeCovered.bind(symbolMaster),
      nonTradingDaysBetween: symbolMaster.nonTradingDaysBetween.bind(symbolMaster),
      delistedEventsBetween: symbolMaster.delistedEventsBetween.bind(symbolMaster),
      sharesChangesBetween: symbolMaster.sharesChangesBetween.bind(symbolMaster),
      tradingDaysBetween: symbolMaster.tradingDaysBetween.bind(symbolMaster),
      ensureSelectionMetrics: async (dates) => {
        const missing = selection.findMissingTradingValueDates(dates);
        if (missing.length > 0) throw new AgentDataRequired({ kind: 'SELECTION', dates: [...missing] });
      },
    },
    factSync: {
      planFinancialSync: (codes, from, to) => plan('FINANCIAL', codes, from, to),
      planCorporateActionSync: (codes, from, to) => plan('ACTIONS', codes, from, to),
      sync: (request) => requireFacts('FINANCIAL', request),
      syncCorporateActions: (request) => requireFacts('ACTIONS', request),
    },
    candleCoverage: new CandleCoverageService(database.db),
    financialFacts: new FinancialFactAvailabilityService(database.db),
  });
}
