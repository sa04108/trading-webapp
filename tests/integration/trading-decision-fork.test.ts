import { UNFILTERED_BREAKOUT_CONTROLS } from "../helpers/swing-controls.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TradingDataRequired } from "../../src/server/modules/trading/application/trading-data.js";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { readRuntimeVersions } from "../../src/runtime/shared/runtime-versions.js";
import { krxDailyBars, symbols } from "../../src/runtime/shared/db/schema.js";
import { SqliteCorporateActionCoverageStore } from "../../src/runtime/modules/facts/application/corporate-action-coverage.js";
import { seedSymbolMasterUniverse } from "../helpers/symbol-master-seed.js";
import { StrategyArtifacts } from "../../src/server/modules/trading/infrastructure/strategy-artifacts.js";
import { DailyTradingEngine } from "../../src/server/modules/trading/infrastructure/daily-trading-engine.js";

describe("daily decision worker integration", () => {
  it("uses the archived strategy and real data, and requests preparation only when data is missing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "decision-fork-"));
    const databasePath = path.join(root, "app.sqlite");
    const database = openDatabase(databasePath);
    let engine: DailyTradingEngine | undefined;
    try {
      const collectionVersion = readRuntimeVersions().collectionVersion;
      const fakeContainer = { database, clock: { now: () => Date.now() } };
      seedSymbolMasterUniverse(fakeContainer as never, ["2026-11-13"], [{ standardCode: "KR7005930003", shortCode: "005930", name: "삼성전자", market: "KOSPI", marketCapKrw: "5000000000" }]);
      database.db.insert(symbols).values({ code: "005930", market: "KR", name: "삼성전자", standardCode: "KR7005930003", createdAtMs: Date.now() }).run();
      new SqliteCorporateActionCoverageStore(database.db, { collectionVersion }).addCoverageResult("005930", [2025, 2026, 2027], [], Date.now());
      const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
      database.db.insert(krxDailyBars).values(days.map((date, i) => ({ shortCode: "005930", date, market: "KOSPI" as const, open: 100, high: i === 5 ? 140 : 105, low: 95, close: i === 5 ? 130 : 100, volume: 10000 }))).run();
      const versionsPath = path.join(root, "versions.json"), buildRoot = path.join(root, "build");
      writeFileSync(versionsPath, JSON.stringify(readRuntimeVersions()));
      execFileSync(process.execPath, ["--input-type=module", "-e", 'import {buildTradingArtifacts} from "./scripts/build-trading-artifacts.mjs"; await buildTradingArtifacts({outputRoot:process.argv[1],runtimeVersionsPath:process.argv[2]})', buildRoot, versionsPath], { cwd: process.cwd(), stdio: "pipe" });
      const artifacts = new StrategyArtifacts({ dataRoot: root, buildRoot });
      const artifact = artifacts.list().find((a) => a.strategyId === "range-breakout" && a.latest)!;
      let now = Date.parse("2026-11-16T00:01:00Z");
      engine = new DailyTradingEngine({ databasePath, dataPath: database.dataPath, artifacts, now: () => now });
      const deployment = { strategyId: artifact.strategyId, artifactHash: artifact.artifactHash, version: artifact.version, parameters: { ...UNFILTERED_BREAKOUT_CONTROLS, lookbackBars: 2, atrPeriod: 2 }, createdAtMs: Date.parse("2026-11-13T00:00:00Z"), activatedAtMs: null, budgetKrw: 100000, randomSeed: 1, universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 1 }], rebalanceInterval: { unit: "NONE", value: 1 } } };
      const warm = await engine.evaluate({ deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: null, warmupOnly: true } as never);
      expect(warm.orders).toEqual([]);
      now = Date.parse("2026-11-17T00:01:00Z");
      const decision = await engine.evaluate({ deployment: { ...deployment, activatedAtMs: deployment.createdAtMs }, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: warm.checkpoint, warmupOnly: false } as never);
      expect(decision.orders).toMatchObject([{ symbol: "005930", side: "BUY" }]);
      const coverage = new SqliteCorporateActionCoverageStore(database.db, { collectionVersion });
      coverage.addCoverageResult("005930", [2026], [2026], Date.now());
      await expect(engine.evaluate({ deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: warm.checkpoint, warmupOnly: true } as never)).rejects.toMatchObject({
        constructor: TradingDataRequired,
        need: { repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 }], priceRange: null },
      });
      coverage.addCoverageResult("005930", [2026], [], Date.now());
      database.db.delete(krxDailyBars).where(eq(krxDailyBars.date, "2026-11-16")).run();
      await expect(engine.evaluate({ deployment: { ...deployment, activatedAtMs: deployment.createdAtMs }, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: warm.checkpoint, warmupOnly: false } as never)).rejects.toMatchObject({
        constructor: TradingDataRequired,
        need: { masterDates: [], priceRange: { to: "2026-11-16" }, financial: null, actions: null },
      });
    } finally { await engine?.close(); database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
});
