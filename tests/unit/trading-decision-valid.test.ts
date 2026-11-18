import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { benchmarkDailyValues, symbolMasterTradingDays } from "../../src/runtime/shared/db/data-schema.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deserialize } from "node:v8";
import { createOfficialKrxTradingCalendar } from "../../src/server/modules/market-data/infrastructure/krx/krx-trading-calendar.js";
import { rangeBreakoutStrategy } from "../../src/runtime/modules/strategy/strategies/range-breakout.js";
import { reconcileState } from "../../src/server/modules/trading/infrastructure/strategy-lifecycle.js";
import { calculate } from "../../src/workers/trading-decision-child.js";

const date = "2026-11-13";
const ts = Date.parse(`${date}T00:00:00Z`);
const bars = [0, 1, 2].map((n) => ({ symbol: "005930", market: "KR", timeframe: "1d", tsMs: ts - (2 - n) * 86_400_000, open: 100, high: 110, low: 90, close: 100, volume: 100 }));
const years = [2025, 2026];
const runtime = {
  resolver: { resolveOrDescribeNeeds: async () => ({ kind: "READY", unionEntries: new Map(), schedule: [{ rebalanceDate: date, members: [{ symbol: "005930", marketCapKrw: "100", volume: 100, tradingValueKrw: "100" }] }], dataExclusions: [], corporateActionExclusions: [] }) },
  candles: { getCandlesArray: async () => bars },
  actionCoverage: { getCoveredYears: () => new Map([["005930", years]]), getGapYears: () => new Map() },
  factCoverage: { getCoverageState: () => new Map() },
  facts: { getFacts: async () => [] },
};
const strategy = { id: "test", version: "1", parameterSchema: z.object({}), dataRequirements: { priceWarmupBars: () => 2 }, initialize: () => ({ seen: 0 }), onBars: (ctx: { tsMs: number; getHistory: (symbol: string) => { tsMs: number }[] }, state: { seen: number }) => { expect(ctx.getHistory("005930").every((bar) => bar.tsMs <= ctx.tsMs)).toBe(true); state.seen++; return { orders: [{ symbol: "005930", side: "BUY", quantity: 1 }] }; } };
const bundle = { formatVersion: 1, nodeMajor: 24, lifecycleAbi: 1, getStrategy: () => strategy, reconcileState: () => {} };
const deployment = { strategyId: "test", artifactHash: "a".repeat(64), version: "1", parameters: {}, createdAtMs: ts, activatedAtMs: null, budgetKrw: 100000, randomSeed: 1, universeRule: { stages: [], rebalanceInterval: { unit: "NONE", value: 1 } } };
const run = (checkpoint: string | null, warmupOnly: boolean, currentDate = date) => calculate({ input: { deployment, portfolio: {}, checkpoint, warmupOnly }, date: currentDate, bundlePath: "" } as never, {} as never, bundle as never, runtime as never);
describe("daily decision", () => {
  it("replays only index history available on each bar and requests missing index data", async () => {
    const database = openDatabase(":memory:");
    try {
      const dates = ["2026-11-11", "2026-11-12", "2026-11-13"];
      database.db.insert(symbolMasterTradingDays).values(dates.map((day) => ({ date: day }))).run();
      database.db.insert(benchmarkDailyValues).values(dates.map((day, index) => ({ benchmarkId: "KOSPI", date: day, close: 100 + index, syncedAtMs: 1 }))).run();
      const seen: number[][] = [];
      const indexStrategy = { ...strategy, dataRequirements: { ...strategy.dataRequirements, marketIndexBars: () => 1 }, onBars: (ctx: { getMarketIndexHistory: () => readonly { close: number }[] }) => { seen.push(ctx.getMarketIndexHistory().map((point) => point.close)); return { orders: [] }; } };
      const indexBundle = { ...bundle, getStrategy: () => indexStrategy };
      const indexRuntime = { ...runtime, symbolMaster: { isRangeCovered: () => true } };
      const message = { input: { deployment, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" };
      await calculate(message as never, database, indexBundle as never, indexRuntime as never);
      expect(seen).toEqual([[100, 101], [100, 101, 102]]);
      database.sqlite.prepare("DELETE FROM benchmark_daily_values WHERE date = ? AND benchmark_id = 'KOSPI'").run(date);
      await expect(calculate(message as never, database, indexBundle as never, indexRuntime as never)).rejects.toMatchObject({ message: expect.stringContaining("KOSPI"), need: { marketIndex: { minimumBars: 1 } } });
    } finally { database.close(); }
  });

  it("discards warmup orders, does not repeat the same bar, and emits the next new signal", async () => {
    const warm = await run(null, true);
    expect(warm.orders).toEqual([]);
    expect((await run(warm.checkpoint, false)).orders).toEqual([]);
    const next = "2026-11-14";
    bars.push({ ...bars.at(-1)!, tsMs: ts + 86_400_000 });
    try { expect((await run(warm.checkpoint, false, next)).orders).toHaveLength(1); } finally { bars.pop(); }
  });
  it("refuses missing latest data", async () => { await expect(run(null, true, "2026-11-14")).rejects.toThrow(/일봉/); });
  it("이미 수집한 자본변동 결손은 해당 종목·연도만 복구 요청하며 같은 봉의 재활성화도 검사한다", async () => {
    const warm = await run(null, true);
    const incomplete = { ...runtime, actionCoverage: { ...runtime.actionCoverage, getGapYears: () => new Map([["005930", [2025, 2026]]]) } };
    for (const checkpoint of [null, warm.checkpoint]) {
      await expect(calculate(
        { input: { deployment, portfolio: {}, checkpoint, warmupOnly: true }, date, bundlePath: "" } as never,
        {} as never, bundle as never, incomplete as never,
      )).rejects.toMatchObject({
        message: expect.stringContaining("005930 2026년 자본변동"),
        need: { masterDates: [], priceRange: null, financial: null, actions: null, repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 }] },
      });
    }
  });
  it("재무와 자본변동의 결손을 함께 복구 요청해 정상 연도는 다시 수집하지 않는다", async () => {
    const financialStrategy = { ...strategy, requiresFundamentals: true };
    const incomplete = { ...runtime,
      actionCoverage: { ...runtime.actionCoverage, getGapYears: () => new Map([["005930", [2026]]]) },
      factCoverage: { getCoverageState: () => new Map([["005930", { verifiedYears: [2025, 2026], blockingGapYears: [2026] }]]) },
    };
    await expect(calculate(
      { input: { deployment, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, { ...bundle, getStrategy: () => financialStrategy } as never, incomplete as never,
    )).rejects.toMatchObject({ need: { repairs: [
      { kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 },
      { kind: "FINANCIAL", symbol: "005930", year: 2026 },
    ] } });
  });
  it("유니버스 선정에서 제외된 자본변동 결손도 종목을 버리지 않고 복구 요청한다", async () => {
    const result = await runtime.resolver.resolveOrDescribeNeeds();
    const incomplete = { ...runtime, resolver: { resolveOrDescribeNeeds: async () => ({ ...result,
      corporateActionExclusions: [{ symbol: "005930", year: 2026, periodKey: "2026-03-01", reason: "발행주식수 누락", severity: "BLOCKING" }],
      dataExclusions: [{ symbol: "005930", category: "DART_CORPORATE_ACTION", periodKey: "2026년/2026-03-01", reason: "발행주식수 누락" }],
    }) } };
    await expect(calculate(
      { input: { deployment, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, bundle as never, incomplete as never,
    )).rejects.toMatchObject({ message: expect.stringContaining("발행주식수 누락"), need: {
      priceRange: null,
      repairs: expect.arrayContaining([{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 }]),
    } });
  });
  it("워밍업 구간 중간의 거래 봉이 없으면 데이터 준비를 요구한다", async () => {
    const incomplete = { ...runtime, candles: { getCandlesArray: async () => [bars[0]!, bars[2]!] } };
    await expect(calculate(
      { input: { deployment, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, bundle as never, incomplete as never,
    )).rejects.toMatchObject({
      message: expect.stringContaining("준비 구간의 종목 거래 봉이 누락"),
      need: { priceRange: { to: date }, actions: { symbols: ["005930"] } },
    });
  });
  it("clears suppressed exit intents on missed bars for an actual held position", async () => {
    const actualDeployment = { ...deployment, strategyId: rangeBreakoutStrategy.id, version: rangeBreakoutStrategy.version, budgetKrw: 80, parameters: { lookbackBars: 2, atrPeriod: 2, stopAtrMultiplier: 0.1, trendSmaBars: 0, minAverageTradingValueKrw: 0 } };
    const actualBundle = { ...bundle, getStrategy: () => rangeBreakoutStrategy, reconcileState };
    const actualRun = (checkpoint: string | null, warmupOnly: boolean, day: string, portfolio: unknown) => calculate({ input: { deployment: actualDeployment, portfolio, checkpoint, warmupOnly }, date: day, bundlePath: "" } as never, {} as never, actualBundle as never, runtime as never);
    const warm = await actualRun(null, true, date, { "005930": { quantity: 1, cost: 100, enteredAtMs: ts - 1000 } });
    expect(warm.orders).toEqual([]);
    bars.push({ ...bars.at(-1)!, tsMs: ts + 86_400_000, open: 90, high: 95, low: 85, close: 90 });
    bars.push({ ...bars.at(-1)!, tsMs: ts + 2 * 86_400_000 });
    try {
      const result = await actualRun(warm.checkpoint, false, "2026-11-15", { "005930": { quantity: 1, cost: 100, enteredAtMs: ts - 1000 } });
      expect(result.orders).toMatchObject([{ symbol: "005930", side: "SELL" }]);
    } finally { bars.splice(-2); }
  });

  it("replays the entire interval after a long interruption and rejects a missing session", async () => {
    const calendar = createOfficialKrxTradingCalendar();
    const firstDate = "2026-09-01", finalDate = "2026-11-13";
    const allBars: typeof bars = [];
    for (let ms = Date.parse("2026-08-25T00:00:00Z"); ms <= ts; ms += 86_400_000) {
      const day = new Date(ms).toISOString().slice(0, 10);
      if (calendar.classify(day, "KOSPI").state === "OPEN") allBars.push({ ...bars[0]!, tsMs: ms });
    }
    const requested: number[] = [];
    const customRuntime = { ...runtime, candles: { getCandlesArray: async (query: { fromTsMs: number; toTsMs: number }) => { requested.push(query.fromTsMs); return allBars.filter((bar) => bar.tsMs >= query.fromTsMs && bar.tsMs <= query.toTsMs); } } };
    const execute = (checkpoint: string | null, day: string, warmupOnly: boolean) => calculate({ input: { deployment, portfolio: {}, checkpoint, warmupOnly }, date: day, bundlePath: "" } as never, {} as never, bundle as never, customRuntime as never);
    const initial = await execute(null, firstDate, true);
    const resumed = await execute(initial.checkpoint, finalDate, false);
    expect(requested.at(-1)).toBeLessThanOrEqual(Date.parse(`${firstDate}T00:00:00Z`));
    const before = deserialize(Buffer.from(initial.checkpoint, "base64")) as { state: { seen: number } };
    const after = deserialize(Buffer.from(resumed.checkpoint, "base64")) as { state: { seen: number } };
    expect(after.state.seen - before.state.seen).toBeGreaterThan(40);
    const removed = allBars.splice(10, 1)[0]!;
    try { await expect(execute(initial.checkpoint, finalDate, false)).rejects.toThrow(/거래 봉이 누락/); }
    finally { allBars.push(removed); allBars.sort((a, b) => a.tsMs - b.tsMs); }
  });
  it("fails safely when a checkpoint is older than the bounded replay window", async () => {
    const warm = await run(null, true);
    const value = deserialize(Buffer.from(warm.checkpoint, "base64")) as { lastBar: number };
    value.lastBar = ts - 6 * 366 * 86_400_000;
    const { serialize } = await import("node:v8");
    await expect(run(serialize(value).toString("base64"), false, "2026-11-14")).rejects.toThrow(/중단 기간/);
  });

});
