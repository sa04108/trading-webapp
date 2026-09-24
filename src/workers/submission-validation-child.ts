import Database from "better-sqlite3";
import fs from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pino } from "pino";
import * as schema from "../runtime/shared/db/schema.js";
import type { DatabaseHandle } from "../runtime/shared/db/database.js";
import { createAuditLogService } from "../runtime/modules/audit/audit-service.js";
import { SymbolService } from "../runtime/modules/market-data/application/symbol-service.js";
import { SymbolMasterService } from "../runtime/modules/market-data/application/symbol-master-service.js";
import { CandleCoverageService } from "../runtime/modules/market-data/application/candle-coverage-service.js";
import { SqliteFactCoverageStore } from "../runtime/modules/facts/application/fact-coverage-store.js";
import { SqliteFactRepository } from "../runtime/modules/facts/infrastructure/sqlite-fact-repository.js";
import { FinancialFactAvailabilityService } from "../runtime/modules/facts/application/financial-fact-availability.js";
import { StrategyRegistry } from "../runtime/modules/strategy/application/strategy-registry.js";
import { createSubmissionValidator, type SubmissionValidationInput } from "../server/modules/backtest/application/submission-validation.js";
import { assertSubmissionSnapshot } from "../server/modules/backtest/application/submission-snapshot.js";
import { PreparationReferenceError } from "../server/modules/backtest/application/preparation-reference-service.js";

// 부모가 사라지면 동기 SQL 실행도 OS 기본 종료 처리로 중단한다.
process.on("disconnect", () => process.exit(1));
process.once("message", async (input: SubmissionValidationInput) => {
  let database: DatabaseHandle | undefined;
  try {
    const operationsPath = process.env.DATABASE_PATH!;
    const dataPath = process.env.DATA_DATABASE_PATH!;
    if (!fs.statSync(dataPath).isFile()) throw new Error("계산 DB가 없습니다");
    const sqlite = new Database(operationsPath, { readonly: true, fileMustExist: true });
    database = { sqlite, dataPath, db: drizzle(sqlite, { schema }), close: () => sqlite.close() };
    // 마이그레이션·WAL 모드 변경·수집을 수행하지 않는다. 연결 전체를 읽기 전용으로 고정한다.
    sqlite.pragma("query_only = ON");
    sqlite.pragma("busy_timeout = 1000");
    sqlite.prepare("ATTACH DATABASE ? AS data").run(dataPath);
    sqlite.pragma("data.cache_size = -8192");
    sqlite.exec("BEGIN");
    assertSubmissionSnapshot(database, input.snapshot);
    const clock = { now: () => input.nowMs };
    const logger = pino({ level: "silent" });
    const audit = createAuditLogService(database.db, clock, logger);
    const symbolMaster = new SymbolMasterService({
      db: database.db, clock, logger,
      source: {
        todayMaxEndpointCallCount: () => 0,
        fetchDailyTrades: async () => { throw new Error("제출 검증 중 수집은 허용되지 않습니다"); },
        fetchIssueBaseInfo: async () => { throw new Error("제출 검증 중 수집은 허용되지 않습니다"); },
      },
    });
    const output = await createSubmissionValidator({
      database, clock, symbolMaster,
      strategies: new StrategyRegistry(),
      symbolService: new SymbolService(database.db, clock, audit),
      candleCoverage: new CandleCoverageService(database.db),
      factCoverage: new SqliteFactCoverageStore(database.db),
      financialFacts: new FinancialFactAvailabilityService(database.db),
      facts: new SqliteFactRepository(database.db),
      maxBacktestBars: () => input.maxBars,
    }).validate(input.body, input.preview);
    sqlite.exec("ROLLBACK");
    database.close();
    database = undefined;
    process.send?.({ type: "completed", output }, () => process.exit(0));
  } catch (error) {
    database?.close();
    process.send?.({ type: error instanceof PreparationReferenceError ? "stale" : "failed", error: error instanceof Error ? error.message : "제출 검증 실패" }, () => process.exit(0));
  }
});
