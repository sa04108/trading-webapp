import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import type { AnyTradingStrategy } from "../../src/runtime/modules/strategy/domain/strategy.js";
import type { TradingArtifact, TradingSetup } from "../../src/shared/schemas/trading.js";
import { BrokerRequestError, type BrokerHolding, type BrokerOrder, type TradingBroker } from "../../src/server/modules/trading/application/broker-port.js";
import { TradingService, type StrategyArtifactStore, type TradingDecisionEngine } from "../../src/server/modules/trading/application/trading-service.js";
import { backtestJobs } from "../../src/runtime/shared/db/operations-schema.js";
import { backtestRuns } from "../../src/server/shared/db/backtest-result-schema.js";
import { createPaperTradingBroker } from "../../src/server/modules/trading/infrastructure/paper-trading-broker.js";
import { kstDateOf } from "../../src/runtime/modules/market-data/domain/kst-date.js";
import { TradingDataRequired, type TradingDataNeed } from "../../src/server/modules/trading/application/trading-data.js";

const oldHash = "a".repeat(64), newHash = "b".repeat(64);
const setup: TradingSetup = { strategyId: "alpha", artifactHash: oldHash, parameters: {}, universeRule: { markets: ["KOSPI"], stages: [{ criterion: "MARKET_CAP", direction: "HIGH", limit: 100 }], rebalanceInterval: { unit: "MONTH", value: 1 } }, timeframe: "1d", budgetKrw: 1_000_000, maxPositions: 10, maxPositionPercent: 100, dailyLossLimitPercent: 5, maxOrderKrw: 100_000, maxSlippageBps: 0, randomSeed: 42, sourceJobId: null };
const artifact = (artifactHash: string, version: string, latest: boolean): TradingArtifact => ({ strategyId: "alpha", name: "알파", description: "", artifactHash, version, latest, executionVersion: "1", parameterSchema: {} });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function fixture(paper = false) {
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
  const executionBroker = paper ? createPaperTradingBroker({ database, marketData: broker, now: () => now }) : broker;
  const prepareData = vi.fn(async (_need: TradingDataNeed, _progress: (message: string) => void, _shouldStop: () => boolean): Promise<string | void> => {});
  const service = new TradingService({ database, broker: executionBroker, artifacts, engine, prepareData, now: () => now });
  cleanup.push(async () => { await service.close(); database.close(); });
  return { service, broker, database, engine, prepareData, artifacts, now: () => now, advance: (ms: number) => { now += ms; }, setArtifacts: (next: TradingArtifact[]) => { list = next; }, setHoldings: (next: BrokerHolding[]) => { holdings = next; }, setRemote: (next: BrokerOrder[]) => { remote = next; }, getRemote: () => remote };
}
async function prepare(f: ReturnType<typeof fixture>, config: TradingSetup = setup) {
  await f.service.tick();
  await f.service.refresh();
  await f.service.selectAccount("account", 0, "user");
  await f.service.register(config, 1, "user");
}
async function active(f: ReturnType<typeof fixture>, config: TradingSetup = setup) { await prepare(f, config); await f.service.activate(f.service.snapshot().revision, "user"); }
const holding = (quantity: number): BrokerHolding => ({ symbol: "005930", name: "삼성전자", quantity, availableQuantity: quantity, averagePrice: 1000, price: 1000, marketValue: quantity * 1000, unrealizedPnl: 0 });

describe("모의투자 실행 경계", () => {
  async function paperActive(f: ReturnType<typeof fixture>) {
    await f.service.tick();
    await f.service.register(setup, f.service.snapshot().revision, "user");
    await f.service.activate(f.service.snapshot().revision, "user");
  }
  const repairNeed: TradingDataNeed = { masterDates: [], priceRange: null, financial: null, actions: null, entries: [], repairs: [{ kind: "CORPORATE_ACTION", symbol: "005930", year: 2025 }] };
  it("활성화 중 결손은 자동 수집·재검증하고 완료 후에도 OFF와 잔고를 유지한다", async () => {
    const f = fixture(true); await f.service.tick();
    await f.service.register(setup, f.service.snapshot().revision, "user");
    const evaluate = vi.mocked(f.engine.evaluate);
    evaluate.mockRejectedValueOnce(new TradingDataRequired("005930 2025년 자본변동 결손", repairNeed));
    let release!: () => void;
    const gate = { promise: new Promise<void>((resolve) => { release = resolve; }), resolve: () => release() };
    cleanup.unshift(async () => gate.resolve());
    f.prepareData.mockImplementationOnce(async (_need, progress) => { progress("005930 2025년 자본변동 복구 중"); await gate.promise; });
    const started = await f.service.activate(f.service.snapshot().revision, "user");
    expect(started.deployment?.status).toBe("INACTIVE");
    expect(started.dataPreparation?.status).toBe("RUNNING");
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.message).toContain("005930 2025년"));
    expect(f.prepareData.mock.calls[0]?.[0]).toEqual(repairNeed);
    expect(f.service.prepareData(f.service.snapshot().revision, "user").dataPreparation?.status).toBe("RUNNING");
    await expect(f.service.activate(f.service.snapshot().revision, "user")).rejects.toThrow("데이터 준비 중");
    gate.resolve();
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("READY"));
    expect(f.prepareData).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls.at(-1)?.[0].warmupOnly).toBe(true);
    expect(f.service.snapshot()).toMatchObject({ deployment: { status: "INACTIVE", lastDecisionAtMs: null, lastError: null }, orders: [], positions: [], account: { cashBuyingPower: 100_000_000 } });
    expect(f.broker.place).not.toHaveBeenCalled();
    await f.service.activate(f.service.snapshot().revision, "user");
    expect(f.service.snapshot().deployment?.status).toBe("ACTIVE");
  });
  it("동일 결손을 반복 수집하지 않으며 명시적 재시도에서 다시 검증한다", async () => {
    const f = fixture(true); await f.service.tick();
    await f.service.register(setup, f.service.snapshot().revision, "user");
    vi.mocked(f.engine.evaluate).mockRejectedValue(new TradingDataRequired("005930 2025년 자본변동 결손", repairNeed));
    f.prepareData.mockResolvedValueOnce("005930 2025년 자본변동: 직전 발행주식수 앵커가 없습니다.");
    f.service.prepareData(f.service.snapshot().revision, "user");
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("FAILED"));
    expect(f.prepareData).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot()).toMatchObject({ deployment: { status: "INACTIVE", lastError: expect.stringContaining("005930 2025년 자본변동: 직전 발행주식수 앵커가 없습니다.") }, orders: [] });
    vi.mocked(f.engine.evaluate).mockResolvedValue({ checkpoint: "checked", barTsMs: 1, orders: [] });
    f.service.prepareData(f.service.snapshot().revision, "user");
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("READY"));
    expect(f.service.snapshot().deployment?.lastError).toBeNull();
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
  });
  it("복구 중 설정 변경은 이전 작업을 중단하고 늦은 진행·완료를 새 설정에 반영하지 않는다", async () => {
    const f = fixture(true); await f.service.tick();
    await f.service.register(setup, f.service.snapshot().revision, "user");
    vi.mocked(f.engine.evaluate).mockRejectedValueOnce(new TradingDataRequired("결손", repairNeed));
    let release!: () => void;
    const gate = { promise: new Promise<void>((resolve) => { release = resolve; }), resolve: () => release() };
    cleanup.unshift(async () => gate.resolve());
    f.prepareData.mockImplementationOnce(async (_need, progress, shouldStop) => {
      await gate.promise;
      expect(shouldStop()).toBe(true);
      progress("이전 작업 완료");
    });
    f.service.prepareData(f.service.snapshot().revision, "user");
    await vi.waitFor(() => expect(f.prepareData).toHaveBeenCalledOnce());
    await f.service.update({ ...setup, budgetKrw: 2_000_000 }, f.service.snapshot().revision, "user");
    gate.resolve();
    await f.service.close();
    expect(f.service.snapshot()).toMatchObject({ dataPreparation: null, deployment: { budgetKrw: 2_000_000, status: "INACTIVE", activity: "설정 변경 · 비활성 유지", lastError: null }, orders: [] });
  });
  it("운용 중 데이터 결손은 주문을 중지하고 복구하되 자동으로 재활성화하지 않는다", async () => {
    const f = fixture(true); await paperActive(f);
    vi.mocked(f.engine.evaluate).mockRejectedValueOnce(new TradingDataRequired("005930 2025년 자본변동 결손", repairNeed));
    await f.service.tick();
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("READY"));
    expect(f.service.snapshot()).toMatchObject({ deployment: { status: "INACTIVE" }, orders: [], positions: [], account: { cashBuyingPower: 100_000_000 } });
    expect(f.prepareData.mock.calls[0]?.[0]).toEqual(repairNeed);
    expect(f.broker.place).not.toHaveBeenCalled();
  });
  it("이전 실행의 늦은 결손 응답이 다시 활성화한 전략을 중지하지 않는다", async () => {
    const f = fixture(true); await paperActive(f);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    cleanup.unshift(async () => release());
    const evaluate = vi.mocked(f.engine.evaluate);
    evaluate.mockImplementationOnce(async () => { await pending; throw new TradingDataRequired("이전 실행 결손", repairNeed); });
    const tick = f.service.tick();
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2));
    f.service.deactivate(f.service.snapshot().revision, "user");
    await f.service.activate(f.service.snapshot().revision, "user");
    const revision = f.service.snapshot().revision;
    release(); await tick;
    expect(f.service.snapshot()).toMatchObject({ revision, deployment: { status: "ACTIVE", lastError: null }, dataPreparation: null, orders: [] });
    expect(f.prepareData).not.toHaveBeenCalled();
  });
  it("복구 중 실행기 임대가 만료되면 늦은 완료를 저장하지 않고 재시도를 허용한다", async () => {
    const f = fixture(true); await f.service.tick();
    await f.service.register(setup, f.service.snapshot().revision, "user");
    vi.mocked(f.engine.evaluate).mockRejectedValueOnce(new TradingDataRequired("결손", repairNeed));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    cleanup.unshift(async () => release());
    f.prepareData.mockImplementationOnce(async (_need, progress) => { await pending; progress("잘못된 완료"); });
    f.service.prepareData(f.service.snapshot().revision, "user");
    await vi.waitFor(() => expect(f.prepareData).toHaveBeenCalledOnce());
    const activity = f.service.snapshot().deployment?.activity;
    f.advance(120_001); release();
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("FAILED"));
    expect(f.service.snapshot().deployment?.activity).toBe(activity);
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    f.service.prepareData(f.service.snapshot().revision, "user");
    await vi.waitFor(() => expect(f.service.snapshot().dataPreparation?.status).toBe("READY"));
    expect(f.service.snapshot().orders).toEqual([]);
  });
  it("초기 자금을 설정과 함께 저장하고 재조회·다른 설정 변경에도 유지한다", async () => {
    const f=fixture(true);await f.service.tick();
    await f.service.register(setup,f.service.snapshot().revision,"user",5_000_000);
    await f.service.refresh();
    expect(f.service.snapshot()).toMatchObject({paperCapital:{initialCashKrw:5_000_000,canEdit:true},account:{cashBuyingPower:5_000_000}});
    const revision=f.service.snapshot().revision;
    await expect(f.service.update(setup,revision-1,"user",2_000_000)).rejects.toMatchObject({code:"STALE_REVISION"});
    expect(f.service.snapshot().paperCapital?.initialCashKrw).toBe(5_000_000);
    await f.service.update(setup,revision,"user",3_000_000);
    await f.service.update({...setup,dailyLossLimitPercent:4},f.service.snapshot().revision,"user");
    const reopened=createPaperTradingBroker({database:f.database,marketData:f.broker,now:f.now});
    expect(await reopened.buyingPower("PAPER")).toBe(3_000_000);
    expect(f.service.snapshot().paperCapital?.initialCashKrw).toBe(3_000_000);
  });
  it("ON 또는 첫 체결 이후에는 원금을 바꿀 수 없고 전략 교체로도 잔고가 초기화되지 않는다", async () => {
    const f=fixture(true);await f.service.tick();
    await f.service.register(setup,f.service.snapshot().revision,"user",50_000);
    await f.service.activate(f.service.snapshot().revision,"user");
    expect(f.service.snapshot().paperCapital?.canEdit).toBe(false);
    await expect(f.service.update(setup,f.service.snapshot().revision,"user",70_000)).rejects.toThrow();
    await f.service.tick();await f.service.refresh();
    f.service.deactivate(f.service.snapshot().revision,"user");await f.service.tick();
    let cash=50_000-10_000-1.5;
    expect(f.service.snapshot()).toMatchObject({paperCapital:{initialCashKrw:50_000,canEdit:false},account:{cashBuyingPower:cash}});
    await expect(f.service.update({...setup,dailyLossLimitPercent:4},f.service.snapshot().revision,"user",70_000)).rejects.toThrow(/첫 체결/);
    expect(f.service.snapshot().deployment?.dailyLossLimitPercent).toBe(5);
    await f.service.update({...setup,dailyLossLimitPercent:4},f.service.snapshot().revision,"user");
    vi.mocked(f.engine.evaluate).mockImplementation(async ({warmupOnly})=>({checkpoint:"sold",barTsMs:warmupOnly?3:4,orders:warmupOnly?[]:[{symbol:"005930",side:"SELL",quantity:10}]}));
    await f.service.activate(f.service.snapshot().revision,"user");
    await f.service.tick();await f.service.refresh();
    f.service.deactivate(f.service.snapshot().revision,"user");await f.service.tick();
    cash=f.service.snapshot().account!.cashBuyingPower;
    expect(cash).toBeLessThan(50_000);
    expect(f.service.snapshot().positions).toEqual([]);
    f.service.remove(f.service.snapshot().revision,"user");
    await expect(f.service.register(setup,f.service.snapshot().revision,"user",70_000)).rejects.toThrow(/첫 체결/);
    expect(f.service.snapshot().deployment).toBeNull();
    await f.service.register(setup,f.service.snapshot().revision,"user");
    await f.service.refresh();
    expect(f.service.snapshot()).toMatchObject({paperCapital:{initialCashKrw:50_000,canEdit:false},account:{cashBuyingPower:cash},positions:[]});
  });
  it("계좌 연결 없이 모의 체결하며 OFF와 전략 제거 후에도 잔고를 유지한다", async () => {
    const f=fixture(true);
    await paperActive(f);
    await f.service.tick();
    await f.service.refresh();
    expect(f.service.snapshot()).toMatchObject({ broker:{provider:"PAPER"}, blockers:[], positions:[{quantity:10}], performance:{unrealizedPnl:0} });
    expect(f.service.snapshot().performance?.realizedPnl).toBeCloseTo(-1.5);
    expect(f.service.snapshot().account?.cashBuyingPower).toBeCloseTo(100_000_000-10_000-1.5);
    const revision=f.service.snapshot().revision;
    await expect(f.service.update(setup, revision, "user")).rejects.toThrow();
    f.service.deactivate(revision,"user");
    await f.service.tick();
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    f.service.remove(f.service.snapshot().revision,"user");
    expect(f.service.snapshot().positions).toMatchObject([{quantity:10,deploymentId:null}]);
    for(const method of [f.broker.accounts,f.broker.holdings,f.broker.buyingPower,f.broker.orders,f.broker.place,f.broker.cancel])expect(method).not.toHaveBeenCalled();
  });
  it("실계좌 이력과 미체결을 보존하되 모의 상태에 섞거나 실계좌를 호출하지 않는다", async () => {
    const f=fixture();await active(f);await f.service.tick();
    const previous=f.service.snapshot();
    await f.service.close();
    const paper=createPaperTradingBroker({database:f.database,marketData:f.broker,now:f.now});
    const service=new TradingService({database:f.database,broker:paper,artifacts:f.artifacts,engine:f.engine,now:f.now});
    cleanup.unshift(()=>service.close());
    await service.tick();
    expect(service.snapshot()).toMatchObject({deployment:{status:"INACTIVE",artifactHash:oldHash},positions:[],orders:[],blockers:[]});
    expect(service.snapshot().deployment?.id).not.toBe(previous.deployment?.id);
    expect(f.database.sqlite.prepare("SELECT status FROM trading_orders WHERE id = ?").get(previous.orders[0]!.id)).toEqual({status:"OPEN"});
    expect(f.broker.place).toHaveBeenCalledTimes(1);
    expect(f.broker.cancel).not.toHaveBeenCalled();
    expect(()=>new TradingService({database:f.database,broker:f.broker,artifacts:f.artifacts,engine:f.engine})).toThrow(/실매매 실행기/);
  });
  it("시세 대기 중 OFF 전환을 원장에 반영하고 체결을 만들지 않는다", async () => {
    const f=fixture(true);await paperActive(f);
    const original=f.broker.quotes.getMockImplementation()!;
    let reached!:()=>void;
    const ready=new Promise<void>(resolve=>{reached=resolve;});
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    let count=0;
    f.broker.quotes.mockImplementation(async symbols=>{
      if(++count===3){reached();await wait;}
      return original(symbols);
    });
    const ticking=f.service.tick();await ready;
    f.service.deactivate(f.service.snapshot().revision,"user");release();await ticking;await f.service.tick();
    expect(f.service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.database.sqlite.prepare("SELECT count(*) AS n FROM paper_trading_orders").get()).toEqual({n:0});
    expect(f.service.snapshot().positions).toEqual([]);
  });
  it("모의 체결 중 잔고 조회가 들어와도 정상 체결을 수량 불일치로 중지하지 않는다", async () => {
    const f=fixture(true);await paperActive(f);
    const original=f.broker.quotes.getMockImplementation()!;
    let reached!:()=>void, release!:()=>void;
    const ready=new Promise<void>(resolve=>{reached=resolve;});
    const wait=new Promise<void>(resolve=>{release=resolve;});
    let count=0;
    f.broker.quotes.mockImplementation(async symbols=>{if(++count===3){reached();await wait;}return original(symbols);});
    const ticking=f.service.tick();await ready;
    const refreshing=f.service.refresh();release();
    await Promise.all([ticking,refreshing]);
    expect(f.service.snapshot()).toMatchObject({deployment:{status:"ACTIVE",lastError:null},positions:[{quantity:10}],orders:[{status:"FILLED"}]});
  });
  it("다른 서비스의 잔고 조회 중 체결해도 원장과 전략 수량을 함께 대조한다", async () => {
    const f=fixture(true);await paperActive(f);await f.service.tick();await f.service.refresh();
    const broker=createPaperTradingBroker({database:f.database,marketData:f.broker,now:f.now});
    const other=new TradingService({database:f.database,broker,artifacts:f.artifacts,engine:f.engine,now:f.now});
    cleanup.unshift(()=>other.close());
    const original=f.broker.quotes.getMockImplementation()!;
    let reached!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{reached=resolve;});
    const wait=new Promise<void>(resolve=>{release=resolve;});
    f.broker.quotes.mockImplementationOnce(async symbols=>{reached();await wait;return original(symbols);});
    const refreshing=other.refresh();await ready;
    const previous=f.service.snapshot().orders[0]!;
    const id="22222222-2222-4222-8222-222222222222";
    const order={...previous,id,brokerOrderId:null,status:"SENDING",quantity:1,filledQuantity:0,averageFillPrice:null};
    f.database.sqlite.prepare("INSERT INTO trading_orders (id,deployment_id,account_id,decision_key,payload_json,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)").run(id,previous.deploymentId,"PAPER","second",JSON.stringify(order),"SENDING",f.now(),f.now());
    await broker.place("PAPER",{clientOrderId:id,symbol:"005930",side:"BUY",quantity:1,price:1000});
    release();await refreshing;
    expect(other.snapshot()).toMatchObject({deployment:{status:"ACTIVE",lastError:null},positions:[{quantity:11}]});
    expect(other.snapshot().orders.find(item=>item.id===id)).toMatchObject({status:"FILLED",filledQuantity:1});
  });
  it("체결 직전 손실 한도에 걸리면 주문 롤백 뒤 OFF 상태를 확정한다", async () => {
    const f=fixture(true);await paperActive(f);
    const original=f.broker.quotes.getMockImplementation()!;
    let count=0;
    f.broker.quotes.mockImplementation(async symbols=>{
      if(++count===3)f.database.sqlite.prepare("UPDATE trading_deployments SET daily_base_json = ? WHERE slot = 1").run(JSON.stringify({date:kstDateOf(f.now()),pnl:999_999}));
      return original(symbols);
    });
    await f.service.tick();
    expect(f.service.snapshot().deployment).toMatchObject({status:"INACTIVE",lastError:null});
    expect(f.database.sqlite.prepare("SELECT count(*) AS n FROM paper_trading_orders").get()).toEqual({n:0});
  });
  it("체결 직후 프로세스가 중단되어도 원장과 대조하여 중복 없이 복구한다", async () => {
    const f=fixture(true);await paperActive(f);await f.service.tick();
    const order=f.service.snapshot().orders[0]!;
    f.database.sqlite.prepare("UPDATE trading_orders SET status = 'SENDING', broker_order_id = NULL, payload_json = ? WHERE id = ?").run(JSON.stringify({...order,status:"SENDING",brokerOrderId:null}),order.id);
    await f.service.close();
    const broker=createPaperTradingBroker({database:f.database,marketData:f.broker,now:f.now});
    const service=new TradingService({database:f.database,broker,artifacts:f.artifacts,engine:f.engine,now:f.now});
    cleanup.unshift(()=>service.close());
    await service.tick();await service.refresh();
    expect(service.snapshot()).toMatchObject({deployment:{status:"INACTIVE"},positions:[{quantity:10}],orders:[{status:"FILLED"}]});
    service.deactivate(service.snapshot().revision,"user");
    expect(service.snapshot().deployment?.status).toBe("INACTIVE");
    expect(f.database.sqlite.prepare("SELECT count(*) AS n FROM paper_trading_orders").get()).toEqual({n:1});
  });
});

describe("실매매 전략 생명주기", () => {
  it.each([undefined, 12.5])("백테스트 비중 %s를 실매매 설정으로 가져오고 미설정은 100%%로 유지한다", async (cap) => {
    const f = fixture();
    const request = {
      strategyId: "alpha", parameters: {}, universeRule: setup.universeRule,
      period: { from: "2026-01-01", to: "2026-12-31" },
      capital: { initialCash: setup.budgetKrw, currency: "KRW" },
      execution: { fillTiming: "NEXT_BAR_OPEN", commissionProfileId: "kr-equity-default", slippageProfileId: "fixed-5bps" },
      risk: { maxPositions: 10, maxPositionWeightPercent: cap }, randomSeed: 42,
    };
    f.database.db.insert(backtestJobs).values({
      id: "source", status: "COMPLETED", requestJson: JSON.stringify(request), strategyId: "alpha",
      universeRuleJson: JSON.stringify(setup.universeRule), universeScheduleJson: "[]",
      runnerVersion: "1", createdAtMs: 1,
    }).run();
    f.database.db.insert(backtestRuns).values({
      id: "run", jobId: "source", strategyId: "alpha", strategyVersion: "1", strategySourceHash: "test",
      parameterJson: "{}", universeRuleJson: JSON.stringify(setup.universeRule), scheduleHash: "test",
      universeHash: "test", universeJson: "[]", engineVersion: "1", executionVersion: "1",
      feeModelVersion: "1", slippageModelVersion: "1", randomSeed: 42, gitCommitSha: "test", startedAtMs: 1,
    }).run();
    expect((await f.service.source("source")).setup?.maxPositionPercent).toBe(cap ?? 100);
  });

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
  it.each([false, true])("전송 직전 잔고·시세가 지연되면 미확인으로 남기지 않는다 (429 이후: %s)", async (rateLimited) => {
    const f = fixture(); await active(f);
    let sent = 0;
    f.broker.place.mockImplementationOnce(async (_account, _order, beforeSend) => {
      if (rateLimited) { beforeSend?.(); sent++; }
      f.advance(30_001); beforeSend?.(); sent++; return { orderId: "unexpected" };
    });
    await f.service.tick();
    expect(sent).toBe(Number(rateLimited));
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

  it.each(["잔고 조회", "미체결 취소"])("서버 종료가 %s 대기를 끊어도 오류 알림을 남기지 않는다", async (phase) => {
    const f = fixture(); await active(f);
    let entered!: () => void, abort!: (error: Error) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<never>((_resolve, reject) => { abort = reject; });
    if (phase === "미체결 취소") {
      await f.service.tick();
      f.broker.cancel.mockImplementationOnce(async () => { entered(); return blocked; });
      f.service.deactivate(f.service.snapshot().revision, "user");
    } else {
      f.advance(30_001);
      f.broker.accounts.mockImplementationOnce(async () => { entered(); return blocked; });
    }
    const tick = f.service.tick(); await waiting;
    const events = f.service.snapshot().events;
    const closing = f.service.close();
    abort(new BrokerRequestError("토스 요청 대기가 취소되었습니다", false));
    await Promise.all([tick, closing]);
    expect(f.service.snapshot().broker.error).toBeNull();
    expect(f.service.snapshot().events).toEqual(events);
    expect(f.service.snapshot().deployment).toMatchObject({ status: phase === "미체결 취소" ? "STOPPING" : "ACTIVE", lastError: null });
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
