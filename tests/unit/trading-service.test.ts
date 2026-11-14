import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import type { AnyTradingStrategy } from "../../src/runtime/modules/strategy/domain/strategy.js";
import type { TradingArtifact, TradingSetup } from "../../src/shared/schemas/trading.js";
import { BrokerRequestError, type BrokerHolding, type BrokerOrder, type TradingBroker } from "../../src/server/modules/trading/application/broker-port.js";
import { TradingService, type StrategyArtifactStore, type TradingDecisionEngine } from "../../src/server/modules/trading/application/trading-service.js";

const oldHash = "a".repeat(64), newHash = "b".repeat(64);
const setup: TradingSetup = { strategyId: "alpha", artifactHash: oldHash, parameters: {}, universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } }, timeframe: "1d", budgetKrw: 1_000_000, maxPositions: 10, maxPositionPercent: 100, dailyLossLimitPercent: 5, maxOrderKrw: 100_000, maxSlippageBps: 0, randomSeed: 42, sourceJobId: null };
const artifact = (artifactHash: string, version: string, latest: boolean): TradingArtifact => ({ strategyId: "alpha", name: "알파", description: "", artifactHash, version, latest, executionVersion: "1", parameterSchema: {} });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function fixture() {
  const database = openDatabase(":memory:");
  let now = 1_800_000_000_000;
  let list = [artifact(oldHash, "1", true)];
  let holdings: BrokerHolding[] = [];
  let remote: BrokerOrder[] = [];
  const broker = {
    configured: true,
    accounts: vi.fn(async () => [{ id: "account", label: "계좌" }]),
    holdings: vi.fn(async () => holdings),
    buyingPower: vi.fn(async () => 1_000_000),
    orders: vi.fn(async () => remote),
    order: vi.fn(async (_account: string, id: string) => { const found = remote.find(o => o.id === id); if (!found) throw new Error("주문 없음"); return found; }),
    place: vi.fn(async (_account: string, request: { clientOrderId: string; symbol: string; side: "BUY" | "SELL"; quantity: number; price: number }, beforeSend?: () => void) => {
      beforeSend?.(); remote = [{ id: "broker-1", ...request, filledQuantity: 0, averageFillPrice: null, commission: 0, tax: 0, status: "OPEN" }]; return { orderId: "broker-1" };
    }),
    cancel: vi.fn(async (_account: string, id: string) => { remote = remote.map(o => o.id === id ? { ...o, status: "CANCELLED" } : o); }),
    quotes: vi.fn(async (symbols: string[]) => symbols.map(symbol => ({ symbol, price: 1_000, timestampMs: now }))),
    dailyCandles: vi.fn(async () => []),
  } satisfies TradingBroker;
  const strategy: AnyTradingStrategy = { id: "alpha", version: "1", name: "알파", description: "", parameterSchema: z.object({}).strict(), initialize: () => ({}), onBars: () => ({ orders: [] }) };
  const artifacts: StrategyArtifactStore = { list: () => list, load: async () => strategy, bundlePath: () => "" };
  const engine: TradingDecisionEngine = { canTrade: () => true, evaluate: vi.fn<TradingDecisionEngine["evaluate"]>(async ({ warmupOnly }) => ({ checkpoint: "checkpoint", barTsMs: warmupOnly ? 1 : 2, orders: warmupOnly ? [] : [{ symbol: "005930", side: "BUY", quantity: 10 }] })), close: async () => {} };
  const service = new TradingService({ database, broker, artifacts, engine, now: () => now });
  cleanup.push(async () => { await service.close(); database.close(); });
  return { service, broker, database, engine, artifacts, now: () => now, advance: (ms: number) => { now += ms; }, setArtifacts: (next: TradingArtifact[]) => { list = next; }, setHoldings: (next: BrokerHolding[]) => { holdings = next; }, setRemote: (next: BrokerOrder[]) => { remote = next; }, getRemote: () => remote };
}
async function prepare(f: ReturnType<typeof fixture>, config: TradingSetup = setup) {
  await f.service.tick();
  await f.service.refresh();
  await f.service.selectAccount("account", 0, "user");
  await f.service.register(config, 1, "user");
}
async function active(f: ReturnType<typeof fixture>, config: TradingSetup = setup) { await prepare(f, config); await f.service.activate(f.service.snapshot().revision, "user"); }
const holding = (quantity: number): BrokerHolding => ({ symbol: "005930", name: "삼성전자", quantity, availableQuantity: quantity, averagePrice: 1000, price: 1000, marketValue: quantity * 1000, unrealizedPnl: 0 });

describe("실매매 전략 생명주기", () => {
  it("동시 등록은 단일 슬롯과 리비전을 지키고 고정 버전은 최신 변경 후에도 유지된다", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.service.register(setup, 0, "a"), f.service.register(setup, 0, "b")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(f.service.snapshot().revision).toBe(1);
    f.setArtifacts([artifact(oldHash, "1", false), artifact(newHash, "2", true)]);
    expect(f.service.snapshot().deployment).toMatchObject({ artifactHash: oldHash, version: "1", latestArtifactHash: newHash });
    await expect(f.service.update(setup, 0, "a")).rejects.toMatchObject({ code: "STALE_REVISION" });
    await f.service.tick();
    expect(f.broker.place).not.toHaveBeenCalled();
  });
  it("활성 상태에서는 편집·제거·버전 변경을 거부한다", async () => {
    const f = fixture(); await active(f);
    f.setArtifacts([artifact(oldHash, "1", false), artifact(newHash, "2", true)]);
    const revision = f.service.snapshot().revision;
    await expect(f.service.update(setup, revision, "user")).rejects.toThrow();
    expect(() => f.service.remove(revision, "user")).toThrow();
    await expect(f.service.version(newHash, {}, revision, "user")).rejects.toThrow();
    expect(f.service.snapshot().deployment?.artifactHash).toBe(oldHash);
    await f.service.tick();
    expect(f.engine.evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ deployment: expect.objectContaining({ artifactHash: oldHash }), warmupOnly: false }));
  });
  it("부분 체결 누계를 한 번만 반영하고 중지 후 잔량 취소·수동 보유를 유지한다", async () => {
    const f = fixture(); await active(f); await f.service.tick();
    expect(f.broker.place).toHaveBeenCalledTimes(1);
    const order = f.getRemote()[0]!;
    f.setRemote([{ ...order, filledQuantity: 4, averageFillPrice: 1000, commission: 10, status: "PARTIAL" }]);
    f.setHoldings([holding(4)]);
    await f.service.refresh(); await f.service.refresh();
    expect(f.service.snapshot().positions[0]).toMatchObject({ quantity: 4, deploymentId: f.service.snapshot().deployment!.id });
    expect(f.service.snapshot().performance).toMatchObject({ realizedPnl: -10, unrealizedPnl: 0, totalPnl: -10 });
    f.service.deactivate(f.service.snapshot().revision, "user"); await f.service.tick();
    expect(f.broker.cancel).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.service.snapshot().orders[0]).toMatchObject({ status: "CANCELLED", filledQuantity: 4 });
    f.service.remove(f.service.snapshot().revision, "user");
    expect(f.service.snapshot().positions[0]).toMatchObject({ quantity: 4, deploymentId: null });
    await f.service.tick(); expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("접수 불명은 재전송하지 않고 시간과 증권사 내역을 확인해야 수동 미접수 처리한다", async () => {
    const f = fixture(); await active(f);
    f.broker.place.mockImplementationOnce(async (_account, _order, beforeSend) => { beforeSend?.(); throw new BrokerRequestError("응답 유실", true); });
    await f.service.tick();
    let snapshot = f.service.snapshot();
    expect(snapshot.deployment?.status).toBe("ERROR");
    expect(snapshot.orders[0]?.status).toBe("UNKNOWN");
    const order = snapshot.orders[0]!;
    await f.service.tick(); expect(f.broker.place).toHaveBeenCalledTimes(1);
    snapshot = f.service.snapshot();
    await expect(f.service.resolveOrder(order.id, null, snapshot.revision, "user")).rejects.toThrow(/10분/);
    f.advance(10 * 60_000);
    f.setRemote([{ id: "possible", clientOrderId: null, symbol: order.symbol, side: order.side, quantity: order.quantity, filledQuantity: 0, averageFillPrice: null, commission: 0, tax: 0, status: "OPEN" }]);
    await expect(f.service.resolveOrder(order.id, null, snapshot.revision, "user")).rejects.toThrow(/주문/);
    f.setRemote([]);
    snapshot = await f.service.resolveOrder(order.id, null, snapshot.revision, "user");
    expect(snapshot.orders[0]?.status).toBe("REJECTED");
    expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("미확인 주문은 종목·방향·수량·가격·시간이 맞는 증권사 주문에만 연결한다", async () => {
    const f = fixture(); await active(f);
    f.broker.place.mockImplementationOnce(async (_account, _order, beforeSend) => { beforeSend?.(); throw new BrokerRequestError("응답 유실", true); });
    await f.service.tick();
    const snapshot = f.service.snapshot(), order = snapshot.orders[0]!;
    const candidate: BrokerOrder = { id: "broker-1", clientOrderId: null, symbol: order.symbol, side: order.side, quantity: order.quantity, price: order.price + 1, orderedAtMs: order.createdAtMs, filledQuantity: 0, averageFillPrice: null, commission: 0, tax: 0, status: "OPEN" };
    f.setRemote([candidate]);
    await expect(f.service.resolveOrder(order.id, candidate.id, snapshot.revision, "user")).rejects.toThrow(/일치하지/);
    f.setRemote([{ ...candidate, price: order.price }]);
    const resolved = await f.service.resolveOrder(order.id, candidate.id, snapshot.revision, "user");
    expect(resolved.orders[0]).toMatchObject({ brokerOrderId: candidate.id, status: "OPEN" });
    expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("판단 중 수동 보유와 현금이 바뀌면 최신 계좌를 재조회해 해당 매수를 막는다", async () => {
    const f = fixture(); await active(f);
    vi.mocked(f.engine.evaluate).mockImplementationOnce(async () => {
      f.setHoldings([holding(2)]);
      f.broker.buyingPower.mockResolvedValue(0);
      return { checkpoint: "next", barTsMs: 2, orders: [{ symbol: "005930", side: "BUY", quantity: 10 }] };
    });
    await f.service.tick();
    expect(f.service.snapshot().positions[0]).toMatchObject({ quantity: 2, deploymentId: null });
    expect(f.service.snapshot().account?.cashBuyingPower).toBe(0);
    expect(f.broker.place).not.toHaveBeenCalled();
  });
  it("전송 직전 잔고·시세가 30초 넘게 지연되면 네트워크에 보내지 않고 미확인으로 남기지 않는다", async () => {
    const f = fixture(); await active(f);
    let sent = 0;
    f.broker.place.mockImplementationOnce(async (_account, _order, beforeSend) => {
      f.advance(30_001); beforeSend?.(); sent++; return { orderId: "unexpected" };
    });
    await f.service.tick();
    expect(sent).toBe(0);
    expect(f.service.snapshot().orders[0]?.status).toBe("REJECTED");
    expect(f.service.snapshot().orders[0]?.error).toMatch(/최신 상태/);
  });
  it("부분 매수 미체결 중 일일 손실 한도에 도달하면 잔량을 취소하고 체결 주식은 유지한다", async () => {
    const f = fixture(); await active(f, { ...setup, dailyLossLimitPercent: 0.1 }); await f.service.tick();
    const order = f.getRemote()[0]!;
    f.setRemote([{ ...order, filledQuantity: 4, averageFillPrice: 1000, status: "PARTIAL" }]);
    f.setHoldings([{ ...holding(4), price: 700, marketValue: 2800, unrealizedPnl: -1200 }]);
    await f.service.refresh(); await f.service.tick();
    expect(f.service.snapshot().deployment?.status).toBe("STOPPING");
    await f.service.tick();
    expect(f.broker.cancel).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.service.snapshot().orders[0]).toMatchObject({ status: "CANCELLED", filledQuantity: 4 });
    expect(f.service.snapshot().positions[0]).toMatchObject({ quantity: 4 });
    expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("다른 실행기의 임대 교체 뒤 다시 임대를 얻으면 고아 전송을 미확인으로 복구한다", async () => {
    const f = fixture(); await active(f); await f.service.tick();
    const order = f.service.snapshot().orders[0]!;
    const second = new TradingService({ database: f.database, broker: f.broker, artifacts: f.artifacts, engine: f.engine, now: f.now });
    try {
      f.advance(120_001); await second.tick();
      expect(f.service.snapshot().deployment?.status).toBe("ERROR");
      f.database.sqlite.prepare("UPDATE trading_orders SET status = 'SENDING', broker_order_id = NULL, payload_json = json_set(payload_json, '$.status', 'SENDING', '$.brokerOrderId', NULL) WHERE id = ?").run(order.id);
      f.advance(120_001); await f.service.tick();
      expect(f.service.snapshot().orders[0]?.status).toBe("UNKNOWN");
      expect(f.broker.place).toHaveBeenCalledTimes(1);
    } finally { await second.close(); }
  });
  it("취소 접수 후 원주문이 열려 있으면 중지 상태를 유지하고 종료 확인 후 비활성화한다", async () => {
    const f = fixture(); await active(f); await f.service.tick();
    f.broker.cancel.mockImplementation(async () => {});
    f.service.deactivate(f.service.snapshot().revision, "user"); await f.service.tick();
    expect(f.broker.cancel).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().deployment?.status).toBe("STOPPING");
    expect(f.service.snapshot().orders[0]?.status).not.toBe("CANCELLED");
    await f.service.tick();
    expect(f.service.snapshot().deployment?.status).toBe("STOPPING");
    expect(f.broker.place).toHaveBeenCalledTimes(1);
    f.setRemote(f.getRemote().map(order => ({ ...order, status: "CANCELLED" })));
    f.advance(15_001); await f.service.tick();
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.service.snapshot().orders[0]?.status).toBe("CANCELLED");
    expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("한 주문의 일시 취소 오류가 다른 주문의 취소를 막지 않으며 다음 재시도에 완료한다", async () => {
    const f = fixture(); await active(f);
    vi.mocked(f.engine.evaluate).mockImplementationOnce(async () => ({ checkpoint: "two", barTsMs: 2, orders: [{ symbol: "005930", side: "BUY", quantity: 2 }, { symbol: "000660", side: "BUY", quantity: 2 }] }));
    f.broker.place.mockImplementation(async (_account, request, beforeSend) => {
      beforeSend?.(); const id = `broker-${f.getRemote().length + 1}`;
      f.setRemote([...f.getRemote(), { id, ...request, filledQuantity: 0, averageFillPrice: null, commission: 0, tax: 0, status: "OPEN" }]);
      return { orderId: id };
    });
    await f.service.tick();
    expect(f.service.snapshot().orders).toHaveLength(2);
    const first = f.getRemote()[0]!.id, second = f.getRemote()[1]!.id;
    let firstFailed = false;
    f.broker.cancel.mockImplementation(async (_account, id) => {
      if (id === first && !firstFailed) { firstFailed = true; throw new Error("일시 오류"); }
      f.setRemote(f.getRemote().map(order => order.id === id ? { ...order, status: "CANCELLED" } : order));
    });
    f.service.deactivate(f.service.snapshot().revision, "user"); await f.service.tick();
    expect(f.broker.cancel.mock.calls.map(([, id]) => id)).toContain(second);
    expect(f.service.snapshot().deployment?.status).toBe("STOPPING");
    f.advance(15_001); await f.service.tick();
    expect(f.broker.cancel.mock.calls.filter(([, id]) => id === first).length).toBeGreaterThanOrEqual(2);
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.service.snapshot().orders.every(order => order.status === "CANCELLED")).toBe(true);
    expect(f.broker.place).toHaveBeenCalledTimes(2);
  });
  it("활성 미체결 중 계좌 동기화 오류가 나도 다음 틱에서 잔량을 취소하고 재매수하지 않는다", async () => {
    const f = fixture(); await active(f); await f.service.tick();
    f.broker.holdings.mockRejectedValueOnce(new Error("잔고 일시 오류"));
    await expect(f.service.refresh()).rejects.toThrow();
    expect(f.service.snapshot().deployment?.status).toBe("ERROR");
    await f.service.tick();
    expect(f.broker.cancel).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().orders[0]?.status).toBe("CANCELLED");
    expect(f.broker.place).toHaveBeenCalledTimes(1);
  });
  it("종결 체결의 후속 수수료를 한 번 반영하고 동일 수량의 체결 금액 변경을 거부한다", async () => {
    const f = fixture(); await active(f); await f.service.tick();
    const order = f.getRemote()[0]!;
    f.setRemote([{ ...order, filledQuantity: 10, averageFillPrice: 1000, commission: 0, status: "FILLED" }]);
    f.setHoldings([holding(10)]); await f.service.refresh();
    expect(f.service.snapshot().performance?.realizedPnl).toBe(0);
    f.setRemote(f.getRemote().map(o => ({ ...o, commission: 10 })));
    f.advance(300_001); await f.service.refresh();
    expect(f.service.snapshot().performance?.realizedPnl).toBe(-10);
    f.advance(300_001); await f.service.refresh();
    expect(f.service.snapshot().performance?.realizedPnl).toBe(-10);
    f.setRemote(f.getRemote().map(o => ({ ...o, averageFillPrice: 1100 })));
    f.advance(300_001);
    await expect(f.service.refresh()).rejects.toThrow();
    expect(f.service.snapshot().performance?.realizedPnl).toBe(-10);
    expect(f.service.snapshot().orders[0]?.averageFillPrice).toBe(1000);
  });
  it("전송 직전 비활성화는 네트워크 전송을 막고 중지 완료한다", async () => {
    const f = fixture(); await active(f);
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let networkCalls = 0;
    f.broker.place.mockImplementationOnce(async (_account, _order, beforeSend) => { entered(); await waiting; beforeSend?.(); networkCalls++; return { orderId: "unexpected" }; });
    const tick = f.service.tick(); await started;
    const stopping = f.service.deactivate(f.service.snapshot().revision, "user");
    expect(stopping.deployment?.status).toBe("STOPPING");
    release(); await tick; await f.service.tick();
    expect(networkCalls).toBe(0);
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.service.snapshot().orders[0]?.status).toBe("REJECTED");
  });
});
