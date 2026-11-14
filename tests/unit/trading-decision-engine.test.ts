import { describe, expect, it } from "vitest";
import { DailyTradingEngine, latestClosedTradingDate } from "../../src/server/modules/trading/infrastructure/daily-trading-engine.js";
import type { StrategyArtifactStore } from "../../src/server/modules/trading/application/trading-service.js";

const artifacts = {} as StrategyArtifactStore;
const engine = new DailyTradingEngine({ databasePath: "/missing", dataPath: "/missing", artifacts, now: () => 0 });
describe("daily trading calendar gate", () => {
  it("opens only during the first ten minutes on an officially open day", () => {
    expect(engine.canTrade(Date.parse("2026-11-16T00:00:00Z"))).toBe(true);
    expect(engine.canTrade(Date.parse("2026-11-16T00:09:59Z"))).toBe(true);
    expect(engine.canTrade(Date.parse("2026-11-16T00:10:00Z"))).toBe(false);
    expect(engine.canTrade(Date.parse("2026-11-15T00:01:00Z"))).toBe(false);
    expect(engine.canTrade(Date.parse("2040-11-16T00:01:00Z"))).toBe(false);
  });
  it("uses the last confirmed trading day and rejects unknown calendar years", () => {
    expect(latestClosedTradingDate(Date.parse("2026-11-16T00:01:00Z"))).toBe("2026-11-13");
    expect(() => latestClosedTradingDate(Date.parse("2040-11-16T00:01:00Z"))).toThrow();
  });
});
