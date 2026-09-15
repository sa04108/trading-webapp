import { pino } from "pino";
import type { DatabaseHandle } from "../shared/db/database.js";
import { systemClock } from "../shared/clock.js";
import { createAuditLogService } from "../modules/audit/audit-service.js";
import { BacktestPreparationOrchestrator } from "../modules/backtest/application/backtest-preparation-orchestrator.js";
import { UniverseRuleResolver } from "../modules/backtest/application/universe-rule-resolver.js";
import { SqliteCorporateActionCoverageStore } from "../modules/facts/application/corporate-action-coverage.js";
import { SqliteFactCoverageStore } from "../modules/facts/application/fact-coverage-store.js";
import { FinancialFactAvailabilityService } from "../modules/facts/application/financial-fact-availability.js";
import { SqliteFactRepository } from "../modules/facts/infrastructure/sqlite-fact-repository.js";
import { planFactSync } from "../modules/facts/domain/sync-plan.js";
import type {
  FactSyncRequest,
  FactSyncReport,
} from "../modules/facts/application/fact-sync-port.js";
import { CandleCoverageService } from "../modules/market-data/application/candle-coverage-service.js";
import { SelectionMetricRepository } from "../modules/market-data/application/selection-metric-repository.js";
import { SymbolMasterService } from "../modules/market-data/application/symbol-master-service.js";
import { SymbolService } from "../modules/market-data/application/symbol-service.js";
import { kstDateOf } from "../modules/market-data/domain/kst-date.js";
import { KrxDailyCandleRepository } from "../modules/market-data/infrastructure/krx-daily-candle-repository.js";
import { StrategyRegistry } from "../modules/strategy/application/strategy-registry.js";
import { AgentDataRequired } from "../../shared/agent-protocol.js";

/** API 어댑터와 자격 증명 없이 같은 계산·결손 검증 코드를 실행한다. */
export function createPreparationWorkerRuntime(
  database: DatabaseHandle,
  options: {
    readonly collectionVersion: string;
    readonly onJobUpdated?: (jobId: string) => void;
  },
): BacktestPreparationOrchestrator {
  const { collectionVersion, onJobUpdated } = options;
  const clock = systemClock;
  const logger = pino({ level: "warn" });
  const audit = createAuditLogService(database.db, clock, logger);
  const symbols = new SymbolService(database.db, clock, audit);
  const candles = new KrxDailyCandleRepository(database.db);
  const facts = new SqliteFactRepository(database.db);
  const factCoverage = new SqliteFactCoverageStore(database.db, {
    collectionVersion,
  });
  const actionCoverage = new SqliteCorporateActionCoverageStore(database.db, {
    collectionVersion,
  });
  const selection = new SelectionMetricRepository(database.db, {
    collectionVersion,
  });
  const symbolMaster = new SymbolMasterService({
    db: database.db,
    clock,
    logger,
    collectionVersion,
    source: {
      todayMaxEndpointCallCount: () => 0,
      fetchDailyTrades: async (_market, date) => {
        throw new AgentDataRequired({ kind: "MARKET", dates: [date] });
      },
      fetchIssueBaseInfo: async (_market, date) => {
        throw new AgentDataRequired({ kind: "MARKET", dates: [date] });
      },
    },
  });
  const resolver = new UniverseRuleResolver({
    symbolMaster,
    selectionMetrics: selection,
    candles,
    facts,
    factCoverage,
    actionCoverage,
    logger,
  });
  const plan = (
    kind: "FINANCIAL" | "ACTIONS",
    codes: readonly string[],
    fromYear: number,
    toYear: number,
  ) =>
    planFactSync({
      symbols: codes,
      fromYear,
      toYear,
      mode: "INCREMENTAL",
      todayKstDate: kstDateOf(clock.now()),
      coveredBySymbol:
        kind === "FINANCIAL"
          ? factCoverage.getCoveredYears(codes)
          : actionCoverage.getCoveredYears(codes),
    });
  const requireFacts = async (
    kind: "FINANCIAL" | "ACTIONS",
    request: FactSyncRequest,
  ): Promise<FactSyncReport> => {
    const missing = [
      ...plan(kind, request.symbols, request.fromYear, request.toYear)
        .yearsBySymbol,
    ]
      .filter(([, years]) => years.length > 0)
      .map(([symbol]) => symbol);
    if (missing.length > 0)
      throw new AgentDataRequired({
        kind,
        symbols: missing,
        fromYear: request.fromYear,
        toYear: request.toYear,
      });
    return {
      savedFacts: 0,
      gapCount: 0,
      gaps: [],
      stoppedAtSymbol: null,
      stopReason: null,
      failureMessage: null,
    };
  };
  return new BacktestPreparationOrchestrator({
    database,
    snapshotMode: true,
    resolver,
    facts,
    factCoverage,
    actionCoverage,
    clock,
    logger,
    onJobUpdated,
    strategies: new StrategyRegistry(),
    symbolService: {
      exists: symbols.exists.bind(symbols),
      getRegisteredIdentity: symbols.getRegisteredIdentity.bind(symbols),
      getRegisteredIdentityByStandardCode:
        symbols.getRegisteredIdentityByStandardCode.bind(symbols),
      addSymbol: (code, _market, _name, standardCode) => {
        if (!standardCode)
          throw new Error("표준코드가 없는 종목을 등록할 수 없습니다");
        throw new AgentDataRequired({
          kind: "REGISTER",
          symbols: [{ symbol: code, standardCode }],
        });
      },
    },
    symbolMaster: {
      ensureTradingDay: symbolMaster.ensureTradingDay.bind(symbolMaster),
      ingestDate: symbolMaster.ingestDate.bind(symbolMaster),
      isRangeCovered: symbolMaster.isRangeCovered.bind(symbolMaster),
      nonTradingDaysBetween:
        symbolMaster.nonTradingDaysBetween.bind(symbolMaster),
      delistedEventsBetween:
        symbolMaster.delistedEventsBetween.bind(symbolMaster),
      sharesChangesBetween:
        symbolMaster.sharesChangesBetween.bind(symbolMaster),
      tradingDaysBetween: symbolMaster.tradingDaysBetween.bind(symbolMaster),
      ensureSelectionMetrics: async (dates) => {
        const missing = selection.findMissingTradingValueDates(dates);
        if (missing.length > 0)
          throw new AgentDataRequired({
            kind: "SELECTION",
            dates: [...missing],
          });
      },
    },
    factSync: {
      planFinancialSync: (codes, from, to) =>
        plan("FINANCIAL", codes, from, to),
      planCorporateActionSync: (codes, from, to) =>
        plan("ACTIONS", codes, from, to),
      sync: (request) => requireFacts("FINANCIAL", request),
      syncCorporateActions: (request) => requireFacts("ACTIONS", request),
    },
    candleCoverage: new CandleCoverageService(database.db),
    financialFacts: new FinancialFactAvailabilityService(database.db),
  });
}
