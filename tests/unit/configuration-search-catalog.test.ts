import { describe, expect, it } from "vitest";
import { dailySearchCatalog, intradaySearchCatalog, sampleConfigurations } from "../../src/server/modules/backtest/application/configuration-search-catalog.js";
import { StrategyRegistry } from "../../src/runtime/modules/strategy/application/strategy-registry.js";
import { backtestRequestSchema } from "../../src/shared/schemas/backtest-request.js";
import { intradayRequestSchema } from "../../src/shared/schemas/intraday.js";

const registry = new StrategyRegistry();
const daily = backtestRequestSchema.parse({ strategyId: "range-breakout", parameters: registry.get("range-breakout")!.parameterSchema.parse({}),
  universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } },
  period: { from: "2021-01-04", to: "2025-12-30" }, capital: { initialCash: 10000000, currency: "KRW" }, execution: { fillTiming: "NEXT_BAR_OPEN", commissionProfileId: "kr-equity-default", slippageProfileId: "fixed-5bps" }, risk: { maxPositions: 40 }, randomSeed: 42 });

describe("설정 탐색의 유효 조합 추출", () => {
  // 시드 복제 테스트에는 숫자·비용·필터 조합이나 고정 시드의 중복 허용 계약이 없다.
  it("이산 조합을 중복 없이 뽑고 원본의 전략·기간·고정값을 유지한다", () => {
    const source = structuredClone(daily), catalog = dailySearchCatalog("original", source, registry);
    const samples = sampleConfigurations(source, catalog, { count: 8, settings: {
      "parameters.stopAtrMultiplier": { kind: "RANGE", min: 1, max: 1.03 },
      "execution.commissionProfileId": { kind: "CHOICE", values: ["kr-equity-default", "zero-cost"] },
    } }, registry);
    expect(samples).toHaveLength(8);
    expect(new Set(samples.map(s => JSON.stringify(s.values))).size).toBe(8);
    for (const { request } of samples) {
      if (request.mode === "intraday") throw new Error("일봉 요청이어야 합니다.");
      expect(request).toMatchObject({ strategyId: daily.strategyId, period: daily.period, randomSeed: 42, universeRule: daily.universeRule });
      expect(request.parameters.stopAtrMultiplier).toBeGreaterThanOrEqual(1);
      expect(request.parameters.stopAtrMultiplier).toBeLessThanOrEqual(1.03);
    }
    expect(source).toEqual(daily);
    expect(() => sampleConfigurations(source, catalog, { count: 1, settings: { "period.from": { kind: "CHOICE", values: ["2020-01-01"] } } }, registry)).toThrow("탐색할 수 없는 설정");
    expect(() => sampleConfigurations(source, catalog, { count: 1, settings: { "parameters.stopAtrMultiplier": { kind: "RANGE", min: 0, max: 1 } } }, registry)).toThrow("범위");
  });

  it("유니버스 단계 순서·기준 중복·topN 상한을 함께 검증한다", () => {
    const source = backtestRequestSchema.parse({ ...daily, strategyId: "cross-sectional-momentum", parameters: registry.get("cross-sectional-momentum")!.parameterSchema.parse({ topN: 10 }),
      universeRule: { ...daily.universeRule, stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 20 }, { criterion: "ROE", direction: "HIGH", limit: 10 }] } });
    const catalog = dailySearchCatalog("original", source, registry);
    expect(catalog.fields.find(f => f.key === "parameters.absoluteMomentumFilter")).toMatchObject({ kind: "choice", current: true });
    const samples = sampleConfigurations(source, catalog, { count: 2, settings: {
      "universeRule.stages.1.criterion": { kind: "CHOICE", values: ["MARKET_CAP", "ROE"] },
      "universeRule.stages.1.limit": { kind: "RANGE", min: 9, max: 11 },
    } }, registry);
    expect(samples.map(sample => sample.values["universeRule.stages.1.limit"]).sort()).toEqual([10, 11]);
    expect(samples.every(sample => sample.values["universeRule.stages.1.criterion"] === "ROE")).toBe(true);
  });

  // 분봉은 같은 숫자 범위라도 봉 주기에 따라 거래시간 내 준비 가능한 조합이 달라진다.
  it("분봉 EMA 관계와 당일 준비 시간 조건을 적용하고 없는 시드는 받지 않는다", () => {
    const source = intradayRequestSchema.parse({ mode: "intraday", strategyId: "intraday-ema", symbol: "005930", timeframe: "15m", period: { from: "2026-10-01", to: "2026-10-30" }, initialCash: 10000000,
      parameters: { fast: 10, slow: 20, allocationPct: 95, stopLossPct: 3, takeProfitPct: 6 }, execution: { holdingPolicy: "DAY_ONLY", commissionBps: 1.5, taxBps: 20, slippageBps: 5, latencyMs: 100, orderExpiryMinutes: 1, maxParticipationPct: 1 } });
    const catalog = intradaySearchCatalog("original", source);
    expect(catalog.fields.some(field => field.group === "universe" || field.group === "seed")).toBe(false);
    const samples = sampleConfigurations(source, catalog, { count: 10, settings: { "parameters.fast": { kind: "RANGE", min: 10, max: 30 }, "parameters.slow": { kind: "RANGE", min: 20, max: 40 } } }, registry);
    for (const sample of samples) {
      const request = intradayRequestSchema.parse(sample.request);
      if (request.strategyId !== "intraday-ema") throw new Error("EMA 전략이어야 합니다.");
      expect(request.parameters.slow).toBeLessThanOrEqual(24);
      expect(request.parameters.fast!).toBeLessThan(request.parameters.slow!);
    }
    expect(() => sampleConfigurations(source, catalog, { count: 1, settings: { "parameters.slow": { kind: "RANGE", min: 25, max: 26 } } }, registry)).toThrow("유효 조합을 0개");
  });
});
