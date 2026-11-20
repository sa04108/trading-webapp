import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { benchmarkDailyValues, symbolMasterTradingDays } from "../../src/runtime/shared/db/data-schema.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deserialize, serialize } from "node:v8";
import { createOfficialKrxTradingCalendar } from "../../src/server/modules/market-data/infrastructure/krx/krx-trading-calendar.js";
import { crossSectionalMomentumStrategy } from "../../src/runtime/modules/strategy/strategies/cross-sectional-momentum.js";
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
const run = (checkpoint: string | null, warmupOnly: boolean, currentDate = date) => calculate({ input: { deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint, warmupOnly }, date: currentDate, bundlePath: "" } as never, {} as never, bundle as never, runtime as never);
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
      const message = { input: { deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" };
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
  it("전략 갱신은 남은 매도 목표를 이어가고 이전 매수 의도는 버린다", async () => {
    const old = await run(null, true);
    const saved = deserialize(Buffer.from(old.checkpoint, "base64")) as Record<string, unknown>;
    saved.priorityCalls = 7;
    saved.pendingSells = [{ symbol: "005930", reason: "STOP_LOSS", target: 2 }];
    saved.pendingExits = ["005930"];
    saved.deferredBuys = [{ symbol: "000660", side: "BUY", quantity: 5 }];
    const previousArtifact = { hash: deployment.artifactHash, checkpoint: serialize(saved).toString("base64") };
    const upgradedDeployment = { ...deployment, artifactHash: "b".repeat(64) };
    const noOrders = { ...strategy, onBars: () => ({ orders: [] }) };
    const upgradedBundle = { ...bundle, getStrategy: () => noOrders };
    const portfolio = { "005930": { quantity: 7, cost: 700, enteredAtMs: ts - 86_400_000 } };
    const execute = (day: string, checkpoint: string | null, warmupOnly: boolean, previous?: typeof previousArtifact) => calculate({ input: {
      deployment: upgradedDeployment, cashKrw: 1000, portfolio, checkpoint, warmupOnly,
      ...(previous ? { throughBarMs: ts, previousArtifact: previous } : {}),
    }, date: day, bundlePath: "" } as never, {} as never, upgradedBundle as never, runtime as never);
    const warm = await execute(date, null, true, previousArtifact);
    expect(warm.orders).toEqual([]);
    const state = deserialize(Buffer.from(warm.checkpoint, "base64")) as { pendingSells: unknown[]; pendingExits: string[]; deferredBuys: unknown[]; priorityCalls: number };
    expect(state.pendingSells).toEqual([{ symbol: "005930", reason: "STOP_LOSS", target: 2 }]);
    expect(state.pendingExits).toEqual(["005930"]);
    expect(state.deferredBuys).toEqual([]);
    expect(state.priorityCalls).toBe(7);
    expect((await execute(date, warm.checkpoint, false)).orders).toEqual([]);
    bars.push({ ...bars.at(-1)!, tsMs: ts + 86_400_000 });
    try {
      expect((await execute("2026-11-14", warm.checkpoint, false)).orders).toEqual([
        { symbol: "005930", side: "SELL", reason: "STOP_LOSS", quantity: 5 },
      ]);
    } finally { bars.pop(); }
  });

  it("실제 순위 전략은 갱신으로 리밸런스하지 않고 다음 예정 주기에 매수한다", async () => {
    const calendar = createOfficialKrxTradingCalendar();
    const history: typeof bars = [];
    for (let ms = Date.parse("2026-09-01T00:00:00Z"); ms <= Date.parse("2026-11-17T00:00:00Z"); ms += 86_400_000) {
      const day = new Date(ms).toISOString().slice(0, 10);
      if (calendar.classify(day, "KOSPI").state === "OPEN") history.push({ ...bars[0]!, tsMs: ms });
    }
    const oldDate = "2026-11-12", oldMs = Date.parse(`${oldDate}T00:00:00Z`);
    const rankDeployment = { ...deployment, strategyId: crossSectionalMomentumStrategy.id, version: crossSectionalMomentumStrategy.version,
      createdAtMs: oldMs, parameters: { formationDays: 20, skipDays: 0, topN: 1, marketTrendBars: 0,
        minAverageTradingValueKrw: 0, minRebalanceBars: 1, absoluteMomentumFilter: false } };
    const entry = { symbol: "005930", marketCapKrw: "100", volume: 100, tradingValueKrw: "100" };
    const rankRuntime = { ...runtime,
      candles: { getCandlesArray: async ({ fromTsMs, toTsMs }: { fromTsMs: number; toTsMs: number }) => history.filter(bar => bar.tsMs >= fromTsMs && bar.tsMs <= toTsMs) },
      resolver: { resolveOrDescribeNeeds: async (_rule: unknown, period: { to: string }) => ({ kind: "READY", unionEntries: new Map(),
        schedule: [{ rebalanceDate: period.to >= "2026-11-16" ? "2026-11-16" : "2026-11-02", members: [entry] }], dataExclusions: [], corporateActionExclusions: [] }) },
    };
    const rankBundle = { ...bundle, getStrategy: () => crossSectionalMomentumStrategy, reconcileState };
    const execute = (day: string, checkpoint: string | null, previous?: { hash: string; checkpoint: string }) => calculate({ input: {
      deployment: previous || checkpoint ? { ...rankDeployment, artifactHash: "b".repeat(64) } : rankDeployment,
      cashKrw: rankDeployment.budgetKrw, portfolio: {}, checkpoint, warmupOnly: checkpoint === null,
      ...(previous ? { throughBarMs: oldMs, previousArtifact: previous } : {}),
    }, date: day, bundlePath: "" } as never, {} as never, rankBundle as never, rankRuntime as never);
    const warm = await execute(oldDate, null);
    const old = deserialize(Buffer.from(warm.checkpoint, "base64")) as { firstDecision: boolean; rebalanceDate: string };
    old.firstDecision = false;
    old.rebalanceDate = "2026-11-02";
    const upgraded = await execute(oldDate, null, { hash: rankDeployment.artifactHash, checkpoint: serialize(old).toString("base64") });
    const next = await execute("2026-11-13", upgraded.checkpoint);
    expect(next.orders).toEqual([]);
    const nextState = deserialize(Buffer.from(next.checkpoint, "base64")) as { state: { pendingTargets: unknown; lastRebalanceBar: unknown } };
    expect(nextState.state.pendingTargets).toBeNull();
    expect(nextState.state.lastRebalanceBar).toBeNull();
    const scheduled = await execute("2026-11-16", next.checkpoint);
    const scheduledState = deserialize(Buffer.from(scheduled.checkpoint, "base64")) as { state: { pendingTargets: unknown } };
    expect(scheduledState.state.pendingTargets).toEqual(["005930"]);
    expect((await execute("2026-11-17", scheduled.checkpoint)).orders).toMatchObject([{ symbol: "005930", side: "BUY" }]);
  });

  it("갱신할 이전 체크포인트의 전략과 봉 경계가 다르면 거부한다", async () => {
    const old = await run(null, true);
    const saved = deserialize(Buffer.from(old.checkpoint, "base64")) as Record<string, unknown>;
    for (const patch of [{ hash: "c".repeat(64) }, { strategyId: "other" }, { lastBar: ts - 86_400_000 }, { abi: 2 }, { priorityCalls: -1 }, { firstDecision: "false" }, { rebalanceDate: "2026-02-30" }, { pendingSells: [{ symbol: "005930", target: -1 }] }]) {
      const previousArtifact = { hash: deployment.artifactHash, checkpoint: serialize({ ...saved, ...patch }).toString("base64") };
      await expect(calculate({ input: { deployment: { ...deployment, artifactHash: "b".repeat(64) }, cashKrw: 1000,
        portfolio: {}, checkpoint: null, warmupOnly: true, throughBarMs: ts, previousArtifact }, date, bundlePath: "" } as never,
        {} as never, bundle as never, runtime as never)).rejects.toThrow(/이전 전략/);
    }
  });
  it("최근 확정 봉이 빠지면 가격 자료만 수집한다", async () => {
    await expect(run(null, true, "2026-11-14")).rejects.toMatchObject({
      message: expect.stringContaining("005930"), need: { priceRange: { to: "2026-11-14" }, financial: null, actions: null },
    });
  });
  it("200봉 미만인 신규 상장주만 매수를 보류하고 보유분은 매도할 수 있다", async () => {
    const calendar = createOfficialKrxTradingCalendar();
    const peer = "000660", ipo = "005930";
    const sessions: number[] = [];
    for (let day = ts; sessions.length < 201; day -= 86_400_000) {
      if (calendar.classify(new Date(day).toISOString().slice(0, 10), "KOSPI").state === "OPEN") sessions.unshift(day);
    }
    const history = sessions.flatMap((time, i) => (i >= 199 ? [peer, ipo] : [peer])
      .map(symbol => ({ ...bars[0]!, symbol, tsMs: time })));
    const entry = { shortCode: ipo, name: "신규상장주", market: "KOSPI", listedDate: "2026-11-12" };
    const recent = { ...runtime, candles: { getCandlesArray: async ({ toTsMs }: { toTsMs: number }) => history.filter(bar => bar.tsMs <= toTsMs) },
      actionCoverage: { ...runtime.actionCoverage, getCoveredYears: () => new Map([[peer, years], [ipo, years]]) },
      resolver: { resolveOrDescribeNeeds: async () => ({ kind: "READY", dataExclusions: [], corporateActionExclusions: [], unionEntries: new Map([[ipo, entry]]),
        schedule: [{ rebalanceDate: entry.listedDate, members: [peer, ipo].map(symbol => ({ symbol })) }] }) } };
    const probe = { ...strategy, dataRequirements: { priceWarmupBars: () => 200 },
      onBars: (ctx: import("../../src/runtime/modules/strategy/domain/strategy.js").StrategyBarContext) => ({ orders: [
        ...[...ctx.tradableSymbols!].map(symbol => ({ symbol, side: "BUY", quantity: 3 })),
        ...(ctx.portfolio.positions.has(ipo) ? [{ symbol: ipo, side: "SELL", quantity: 2 }] : []),
      ] }) };
    const execute = (day: string, checkpoint: string | null, portfolio = {}) => calculate({ input: {
      deployment, cashKrw: 100000, portfolio, checkpoint, warmupOnly: checkpoint === null }, date: day, bundlePath: "" } as never,
      {} as never, { ...bundle, getStrategy: () => probe } as never, recent as never);
    const warm = await execute(entry.listedDate, null);
    const next = await execute(date, warm.checkpoint);
    expect(next.orders).toEqual([{ symbol: peer, side: "BUY", quantity: 3 }]);
    expect(next.entryHolds).toEqual([{ symbol: ipo, bars: 2, requiredBars: 200 }]);
    expect((await execute(date, warm.checkpoint, { [ipo]: { quantity: 2, cost: 200, enteredAtMs: sessions[199] } })).orders)
      .toContainEqual({ symbol: ipo, side: "SELL", quantity: 2 });
    history.splice(history.findIndex(bar => bar.symbol === ipo), 1);
    await expect(execute(date, warm.checkpoint)).rejects.toMatchObject({ need: { priceRange: { to: date }, financial: null, actions: null } });
  });
  it("보유 종목의 자본변동 결손은 같은 봉의 재활성화도 복구 요청한다", async () => {
    const warm = await run(null, true);
    const incomplete = { ...runtime, actionCoverage: { ...runtime.actionCoverage, getGapYears: () => new Map([["005930", [2025, 2026]]]) } };
    for (const checkpoint of [null, warm.checkpoint]) {
      await expect(calculate(
        { input: { deployment, cashKrw: deployment.budgetKrw, portfolio: { "005930": { quantity: 1, cost: 100, enteredAtMs: ts - 86_400_000 } }, checkpoint, warmupOnly: true }, date, bundlePath: "" } as never,
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
      { input: { deployment, cashKrw: deployment.budgetKrw, portfolio: { "005930": { quantity: 1, cost: 100, enteredAtMs: ts - 86_400_000 } }, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, { ...bundle, getStrategy: () => financialStrategy } as never, incomplete as never,
    )).rejects.toMatchObject({ need: { repairs: [
      { kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 },
      { kind: "FINANCIAL", symbol: "005930", year: 2026 },
    ] } });
  });
  it("유니버스 선정에서 보유 종목의 자본변동 결손을 복구 요청한다", async () => {
    const result = await runtime.resolver.resolveOrDescribeNeeds();
    const incomplete = { ...runtime, resolver: { resolveOrDescribeNeeds: async () => ({ ...result,
      corporateActionExclusions: [{ symbol: "005930", year: 2026, periodKey: "2026-03-01", reason: "발행주식수 누락", severity: "BLOCKING" }],
      dataExclusions: [{ symbol: "005930", category: "DART_CORPORATE_ACTION", periodKey: "2026년/2026-03-01", reason: "발행주식수 누락" }],
    }) } };
    await expect(calculate({ input: { deployment, cashKrw: deployment.budgetKrw,
      portfolio: { "005930": { quantity: 1, cost: 100, enteredAtMs: Date.parse("2026-02-01") } }, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, bundle as never, incomplete as never)).rejects.toMatchObject({ need: {
      repairs: expect.arrayContaining([{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2026 }]),
    } });
  });
  it("확인된 자본변동 결손은 미보유 종목의 진입만 보류하고 복구 후 다시 허용한다", async () => {
    const peer = "000660", affected = "005930";
    const history = bars.flatMap(bar => [bar, { ...bar, symbol: peer }]);
    let gap = false;
    const custom = { ...runtime,
      candles: { getCandlesArray: async () => history },
      actionCoverage: { getCoveredYears: () => new Map([[affected, years], [peer, years]]),
        getGapYears: () => gap ? new Map([[affected, [2026]]]) : new Map() },
      resolver: { resolveOrDescribeNeeds: async () => ({ kind: "READY", unionEntries: new Map(), dataExclusions: [], corporateActionExclusions: [],
        schedule: [{ rebalanceDate: date, members: [affected, peer].map(symbol => ({ symbol })) }] }) },
    };
    const probe = { ...strategy, onBars: () => ({ orders: [affected, peer].map(symbol => ({ symbol, side: "BUY", quantity: 1 })) }) };
    const execute = (checkpoint: string | null, warmupOnly: boolean, day = date) => calculate({ input: {
      deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint, warmupOnly }, date: day, bundlePath: "" } as never,
      {} as never, { ...bundle, getStrategy: () => probe } as never, custom as never);
    const warm = await execute(null, true);
    gap = true;
    const sameBar = await execute(warm.checkpoint, false);
    expect(sameBar.orders).toEqual([]);
    expect(sameBar.actionGapHolds).toEqual([affected]);
    history.push(...history.slice(-2).map(bar => ({ ...bar, tsMs: ts + 86_400_000 })));
    const held = await execute(warm.checkpoint, false, "2026-11-14");
    expect(held.orders).toEqual([{ symbol: peer, side: "BUY", quantity: 1 }]);
    expect(held.actionGapHolds).toEqual([affected]);
    gap = false;
    history.push(...history.slice(-2).map(bar => ({ ...bar, tsMs: ts + 2 * 86_400_000 })));
    const recovered = await execute(held.checkpoint, false, "2026-11-15");
    expect(recovered.orders).toContainEqual({ symbol: affected, side: "BUY", quantity: 1 });
    expect(recovered.actionGapHolds ?? []).toEqual([]);
  });
  it.each(["2026-11-13", "2026.11.13"])("주식수 변경일 전에는 진입을 허용한다 (%s)", async periodKey => {
    const custom = { ...runtime,
      candles: { getCandlesArray: async ({ toTsMs }: { toTsMs: number }) => bars.filter(bar => bar.tsMs <= toTsMs) },
      actionCoverage: { ...runtime.actionCoverage, getGapYears: () => new Map([["005930", [2026]]]),
        getGapDetails: () => new Map([["005930", [{ year: 2026, periodKey, reason: "발행주식수 누락", severity: "BLOCKING" }]]]) },
      symbolMaster: { isRangeCovered: () => true, sharesChangesBetween: (from: string, to: string) => from <= date && date <= to ? [{ shortCode: "005930", effectiveDate: date, ratio: 2 }] : [] },
    };
    const execute = (day: string, checkpoint: string | null) => calculate({ input: { deployment,
      cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint, warmupOnly: checkpoint === null }, date: day, bundlePath: "" } as never,
      {} as never, bundle as never, custom as never);
    const before = await execute("2026-11-12", null);
    expect(before.actionGapHolds ?? []).toEqual([]);
    const effective = await execute(date, before.checkpoint);
    expect(effective.orders).toEqual([]);
    expect(effective.actionGapHolds).toEqual(["005930"]);
  });
  it("수집 여부가 확인되지 않은 자본변동 자료는 준비를 요청한다", async () => {
    const incomplete = { ...runtime, actionCoverage: { ...runtime.actionCoverage, getCoveredYears: () => new Map() } };
    await expect(calculate({ input: { deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: null, warmupOnly: true },
      date, bundlePath: "" } as never, {} as never, bundle as never, incomplete as never)).rejects.toMatchObject({
      need: { actions: expect.objectContaining({ symbols: ["005930"] }) },
    });
  });
  it("워밍업 구간 중간의 거래 봉이 없으면 데이터 준비를 요구한다", async () => {
    const incomplete = { ...runtime, candles: { getCandlesArray: async () => [bars[0]!, bars[2]!] } };
    await expect(calculate(
      { input: { deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint: null, warmupOnly: true }, date, bundlePath: "" } as never,
      {} as never, bundle as never, incomplete as never,
    )).rejects.toMatchObject({
      message: expect.stringContaining("준비 구간의 종목 거래 봉이 누락"),
      need: { priceRange: { to: date }, actions: null, financial: null },
    });
  });
  it("clears suppressed exit intents on missed bars for an actual held position", async () => {
    const actualDeployment = { ...deployment, strategyId: rangeBreakoutStrategy.id, version: rangeBreakoutStrategy.version, budgetKrw: 80, parameters: { lookbackBars: 2, atrPeriod: 2, stopAtrMultiplier: 0.1, trendSmaBars: 0, minAverageTradingValueKrw: 0 } };
    const actualBundle = { ...bundle, getStrategy: () => rangeBreakoutStrategy, reconcileState };
    const actualRun = (checkpoint: string | null, warmupOnly: boolean, day: string, portfolio: unknown) => calculate({ input: { deployment: actualDeployment, cashKrw: 0, portfolio, checkpoint, warmupOnly }, date: day, bundlePath: "" } as never, {} as never, actualBundle as never, runtime as never);
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
    const execute = (checkpoint: string | null, day: string, warmupOnly: boolean) => calculate({ input: { deployment, cashKrw: deployment.budgetKrw, portfolio: {}, checkpoint, warmupOnly }, date: day, bundlePath: "" } as never, {} as never, bundle as never, customRuntime as never);
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
    await expect(run(serialize(value).toString("base64"), false, "2026-11-14")).rejects.toThrow(/중단 기간/);
  });

});
