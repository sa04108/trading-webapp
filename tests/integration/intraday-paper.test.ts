import { afterEach, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { readRuntimeVersions } from "../../src/runtime/shared/runtime-versions.js";
import { runIntradayBacktest } from "../../src/runtime/modules/intraday/domain/engine.js";
import { TradingPresets } from "../../src/server/modules/trading/application/trading-presets.js";
import { TradingService, type StrategyArtifactStore, type TradingDecisionEngine } from "../../src/server/modules/trading/application/trading-service.js";
import { createPaperTradingBroker } from "../../src/server/modules/trading/infrastructure/paper-trading-broker.js";
import type { IntradayBar, IntradayRequest, IntradayRun } from "../../src/shared/schemas/intraday.js";

const date = "2026-11-12";
const at = (time: string) => Date.parse(`${date}T${time}:00+09:00`);
const request: IntradayRequest = {
  mode: "intraday", strategyId: "intraday-ema", symbol: "005930", period: { from: date, to: date },
  timeframe: "15m", initialCash: 100_000,
  parameters: { fast: 2, slow: 3, volumePeriod: 2, volumeMultiplier: 1, maxDailyEntries: 10, cooldownMinutes: 0, maxHoldingMinutes: 380, allocationPct: 95, stopLossPct: 50, takeProfitPct: 100 },
  execution: { holdingPolicy: "DAY_ONLY", commissionBps: 2, taxBps: 10, slippageBps: 0, latencyMs: 1, orderExpiryMinutes: 3, maxParticipationPct: 10 },
};
const bars: IntradayBar[] = Array.from({ length: 380 }, (_, i) => ({
  endMs: at("09:00") + (i + 1) * 60_000, open: i < 15 ? 1000 : i < 30 ? 990 : i < 45 ? 980 : 1010,
  high: i < 15 ? 1000 : i < 30 ? 990 : i < 45 ? 980 : 1010, low: i < 15 ? 1000 : i < 30 ? 990 : i < 45 ? 980 : 1010,
  close: i < 15 ? 1000 : i < 30 ? 990 : i < 45 ? 980 : 1010, volume: i === 61 ? 100 : 1000,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function fixture() {
  const database = openDatabase(":memory:");
  let now = at("08:59");
  const marketData = { quotes: vi.fn(async (symbols: string[]) => symbols.map(symbol => ({ symbol, price: 1010, timestampMs: now }))), dailyCandles: vi.fn(async () => []) };
  const artifacts: StrategyArtifactStore = { list: () => [], load: async () => { throw new Error("일봉 전략은 호출하지 않습니다."); }, bundlePath: () => "" };
  const engine: TradingDecisionEngine = { canTrade: () => true, evaluate: async () => { throw new Error("일봉 엔진은 호출하지 않습니다."); }, close: async () => {} };
  const intraday = { paperDataConfigured: true, paperBars: vi.fn(async (_symbol: string, from: number, through: number) => bars.filter(bar => bar.endMs >= from && bar.endMs <= through)) };
  const result = runIntradayBacktest({ request, bars, tradingDates: [date], dataRevision: "pinned" });
  result.executionVersion = readRuntimeVersions().executionVersion;
  const run: IntradayRun = { id: "run-1", request, status: "COMPLETED", error: null, createdAtMs: now, updatedAtMs: now, result };
  const services: TradingService[] = [];
  const createService = (slot: number) => {
    const service = new TradingService({ database, accountSlot: slot, artifacts, engine, intraday, now: () => now,
      broker: createPaperTradingBroker({ database, accountSlot: slot, marketData, now: () => now }) });
    services.push(service); return service;
  };
  const presets = new TradingPresets(database, createService, error => { throw error; }, (ownerId, id) => {
    if (ownerId !== "owner" || id !== run.id) throw new Error("원본 실행이 없습니다.");
    return run;
  });
  cleanup.push(async () => { await presets.close(); for (const service of services) await service.close(); database.close(); });
  return { database, presets, createService, intraday, result, setNow: (time: number) => { now = time; } };
}

// 부분 체결 중 재시작해도 배치 계산의 주문·비용·잔고와 일치해야 한다.
it("분봉 백테스트를 가져와 부분 체결 뒤 재시작해도 같은 포트폴리오를 만든다", async () => {
  const f = fixture();
  const created = await f.presets.createIntraday({ sourceRunId: "run-1", requestId: "a26fe604-8498-4b73-a93f-f9eb07c20001" }, "owner");
  const first = f.presets.forPreset(created.id);
  await first.activate(created.snapshot.revision, "owner");
  f.setNow(at("10:03"));
  // 아직 도착하지 않은 최신 봉을 건너뛰면 10주 부분 체결이 영구히 사라진다.
  f.intraday.paperBars.mockImplementationOnce(async (_symbol, from, through) => bars.filter(bar => bar.endMs >= from && bar.endMs < through));
  await first.tick();
  expect(first.snapshot().positions).toEqual([]);
  f.setNow(at("10:03") + 15_000);
  await first.tick();
  const partial = first.snapshot();
  expect(partial.orders).toMatchObject([{ side: "BUY", quantity: 94, filledQuantity: 10, status: "PARTIAL" }]);
  expect(partial.positions).toMatchObject([{ symbol: "005930", quantity: 10 }]);
  await first.close();
  const resumed = f.createService(1);
  f.setNow(at("15:21"));
  await resumed.tick();
  const snapshot = await resumed.refresh();
  const grouped = new Map<string, { side: "BUY" | "SELL"; qty: number; amount: number }>();
  for (const fill of f.result.fills) {
    const previous = grouped.get(fill.orderId) ?? { side: fill.side, qty: 0, amount: 0 };
    previous.qty += fill.qty;
    previous.amount += fill.qty * fill.price;
    grouped.set(fill.orderId, previous);
  }
  const expected = [...grouped.values()].map(order => ({ side: order.side, quantity: order.qty, filledQuantity: order.qty, averageFillPrice: order.amount / order.qty }));
  expect(snapshot.orders.map(({ side, quantity, filledQuantity, averageFillPrice }) => ({ side, quantity, filledQuantity, averageFillPrice })).sort((a, b) => a.side.localeCompare(b.side)))
    .toEqual(expected.sort((a, b) => a.side.localeCompare(b.side)));
  expect(snapshot.account?.cashBuyingPower).toBeCloseTo(request.initialCash + f.result.metrics.pnl, 6);
  expect(snapshot.performance?.totalPnl).toBeCloseTo(f.result.metrics.pnl, 6);
  expect(snapshot.positions).toEqual([]);
  const costs = f.database.sqlite.prepare("SELECT sum(applied_costs) AS costs FROM trading_orders WHERE deployment_id = ?").get(created.id) as { costs: number };
  expect(costs.costs).toBeCloseTo(f.result.metrics.totalCosts, 6);
});

// OFF 이후 도착한 오래된 시세 응답이 주문이나 보유 수량을 만들지 않아야 한다.
it("분봉 조회 도중 OFF하면 늦게 도착한 응답을 적용하지 않는다", async () => {
  const f = fixture();
  const created = await f.presets.createIntraday({ sourceRunId: "run-1", requestId: "a26fe604-8498-4b73-a93f-f9eb07c20002" }, "owner");
  const service = f.presets.forPreset(created.id);
  await service.activate(created.snapshot.revision, "owner");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.intraday.paperBars.mockImplementationOnce(async (_symbol, from, through) => { entered(); await gate; return bars.filter(bar => bar.endMs >= from && bar.endMs <= through); });
  f.setNow(at("10:03"));
  const ticking = service.tick();
  await waiting;
  service.deactivate(service.snapshot().revision, "owner");
  release();
  await ticking;
  const snapshot = service.snapshot();
  expect(snapshot.deployment?.status).toBe("INACTIVE");
  expect(snapshot.orders).toEqual([]);
  expect(snapshot.positions).toEqual([]);
  expect(snapshot.account?.cashBuyingPower).toBe(request.initialCash);
});

it("부분 체결 뒤 시세 오류로 정지하면 체결된 잔고만 보존하고 잔량을 취소한다", async () => {
  const f = fixture();
  const created = await f.presets.createIntraday({ sourceRunId: "run-1", requestId: "a26fe604-8498-4b73-a93f-f9eb07c20003" }, "owner");
  const service = f.presets.forPreset(created.id);
  await service.activate(created.snapshot.revision, "owner");
  f.setNow(at("10:03"));
  await service.tick();
  const cash = service.snapshot().account?.cashBuyingPower;
  f.intraday.paperBars.mockRejectedValueOnce(new Error("분봉 공급자 오류"));
  f.setNow(at("10:04"));
  await service.tick();
  const stopped = service.snapshot();
  expect(stopped.deployment).toMatchObject({ status: "INACTIVE", lastError: "분봉 공급자 오류" });
  expect(stopped.orders).toMatchObject([{ status: "CANCELLED", filledQuantity: 10, quantity: 94 }]);
  expect(stopped.positions).toMatchObject([{ quantity: 10 }]);
  expect(stopped.account?.cashBuyingPower).toBe(cash);
});

it("장중 ON 전의 매수 신호는 지표 준비에만 사용한다", async () => {
  const f = fixture();
  expect(f.result.signals[0]).toMatchObject({ side: "BUY", atMs: at("10:00") });
  const created = await f.presets.createIntraday({ sourceRunId: "run-1", requestId: "a26fe604-8498-4b73-a93f-f9eb07c20004" }, "owner");
  const service = f.presets.forPreset(created.id);
  f.setNow(at("10:01"));
  await service.activate(created.snapshot.revision, "owner");
  f.setNow(at("10:06"));
  await service.tick();
  expect(service.snapshot().orders).toEqual([]);
  expect(service.snapshot().account?.cashBuyingPower).toBe(request.initialCash);
});
