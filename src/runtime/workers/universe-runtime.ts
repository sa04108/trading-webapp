import { UniverseRuleResolver } from "../modules/backtest/application/universe-rule-resolver.js";
import { SqliteCorporateActionCoverageStore } from "../modules/facts/application/corporate-action-coverage.js";
import { SqliteFactCoverageStore } from "../modules/facts/application/fact-coverage-store.js";
import { SqliteFactRepository } from "../modules/facts/infrastructure/sqlite-fact-repository.js";
import { SelectionMetricRepository } from "../modules/market-data/application/selection-metric-repository.js";
import { SymbolMasterService } from "../modules/market-data/application/symbol-master-service.js";
import { KrxDailyCandleRepository } from "../modules/market-data/infrastructure/krx-daily-candle-repository.js";
import { pino } from "pino";
import { systemClock } from "../shared/clock.js";
import type { DatabaseHandle } from "../shared/db/database.js";
import { AgentDataRequired } from "../../shared/agent-protocol.js";

/** 동일한 읽기 전용 스냅샷에서 선정에 필요한 의존성만 만든다. */
export function createUniverseRuntime(database: DatabaseHandle, collectionVersion: string) {
  const clock = systemClock;
  const logger = pino({ level: "warn" });
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
  return { resolver, symbolMaster, selection, candles, facts, factCoverage, actionCoverage };
}
