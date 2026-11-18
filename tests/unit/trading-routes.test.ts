import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { TradingError, type TradingService } from "../../src/server/modules/trading/application/trading-service.js";
import { registerTradingRoutes } from "../../src/server/modules/trading/presentation/trading-routes.js";

function fixture() {
  const app = Fastify();
  const service = {
    snapshot: vi.fn(() => ({ revision: 3 })),
    artifacts: vi.fn(() => []),
    source: vi.fn(async (id: string) => ({ id })),
    quote: vi.fn(async (symbol: string) => ({ symbol, price: 1000, timestampMs: 123 })),
    register: vi.fn(), update: vi.fn(), remove: vi.fn(), version: vi.fn(),
    activate: vi.fn(), resolveOrder: vi.fn(), deactivate: vi.fn(), refresh: vi.fn(), selectAccount: vi.fn(), prepareData: vi.fn(),
  };
  registerTradingRoutes(app, service as unknown as TradingService, async (request, reply) => {
    if (request.headers.authorization !== "test") { await reply.code(401).send({ error: "unauthorized" }); return; }
    request.authUser = { id: "user-1", username: "tester" };
  });
  return { app, service };
}
const auth = { authorization: "test" };
const mutations = [
  ["POST", "/trading/strategy"], ["PUT", "/trading/strategy"], ["DELETE", "/trading/strategy"],
  ["POST", "/trading/version"], ["POST", "/trading/activate"], ["POST", "/trading/deactivate"],
  ["POST", "/trading/orders/00000000-0000-4000-8000-000000000001/resolve"], ["POST", "/trading/refresh"],
  ["POST", "/trading/prepare"],
] as const;

describe("거래 경로 인증과 요청 계약", () => {
  it("초기 모의자금은 유효한 원화 정수만 받고 전략 파라미터와 분리해 전달한다", async () => {
    const {app,service}=fixture();
    const body={expectedRevision:3,strategyId:"alpha",artifactHash:"a".repeat(64),parameters:{},universeRule:{markets:["KOSPI"],stages:[{criterion:"MARKET_CAP",direction:"HIGH",limit:100}],rebalanceInterval:{unit:"MONTH",value:1}},timeframe:"1d",budgetKrw:1_000_000,maxPositions:10,maxPositionPercent:10,dailyLossLimitPercent:3,maxOrderKrw:100_000,maxSlippageBps:50,randomSeed:42,sourceJobId:null};
    for(const initialCashKrw of [0,-1,9999,10000.5,1_000_000_000_001,"50000"]) {
      expect((await app.inject({method:"POST",url:"/trading/strategy",headers:auth,payload:{...body,initialCashKrw}})).statusCode).toBe(400);
    }
    expect(service.register).not.toHaveBeenCalled();
    service.register.mockReturnValue({revision:4});
    service.update.mockReturnValue({revision:4});
    for(const method of ["POST","PUT"] as const)expect((await app.inject({method,url:"/trading/strategy",headers:auth,payload:{...body,initialCashKrw:50_000}})).statusCode).toBe(200);
    const {expectedRevision,...setup}=body;
    expect(service.register).toHaveBeenCalledWith(setup,expectedRevision,"user-1",50_000);
    expect(service.update).toHaveBeenCalledWith(setup,expectedRevision,"user-1",50_000);
    await app.close();
  });
  it("모든 변경 요청에 인증이 필요하다", async () => {
    const { app, service } = fixture();
    for (const [method, url] of mutations) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    for (const method of [service.register, service.update, service.remove, service.version, service.activate, service.resolveOrder, service.deactivate, service.refresh, service.selectAccount, service.prepareData]) expect(method).not.toHaveBeenCalled();
    await app.close();
  });
  it("데이터 복구는 리비전을 요구하고 서버가 결정한 대상만 비동기로 준비한다", async () => {
    const { app, service } = fixture();
    for (const payload of [{}, { expectedRevision: -1 }, { expectedRevision: 3, symbol: "005930" }]) {
      expect((await app.inject({ method: "POST", url: "/trading/prepare", headers: auth, payload })).statusCode).toBe(400);
    }
    expect(service.prepareData).not.toHaveBeenCalled();
    service.prepareData.mockReturnValue({ revision: 4, dataPreparation: { status: "RUNNING", message: "확인 중" } });
    const response = await app.inject({ method: "POST", url: "/trading/prepare", headers: auth, payload: { expectedRevision: 3 } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ revision: 4, dataPreparation: { status: "RUNNING" } });
    expect(service.prepareData).toHaveBeenCalledWith(3, "user-1");
    await app.close();
  });
  it.each(["activate", "deactivate"] as const)("%s는 명시적 확인과 리비전이 모두 필요하고 추가 필드를 거부한다", async (action) => {
    const { app, service } = fixture();
    for (const payload of [{ expectedRevision: 3, acknowledged: false }, { acknowledged: true }, { expectedRevision: 3, acknowledged: true, extra: 1 }]) {
      const response = await app.inject({ method: "POST", url: `/trading/${action}`, headers: auth, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(service[action]).not.toHaveBeenCalled();
    service[action].mockReturnValue({ revision: 4 });
    const response = await app.inject({ method: "POST", url: `/trading/${action}`, headers: auth, payload: { expectedRevision: 3, acknowledged: true } });
    expect(response.statusCode).toBe(200);
    expect(service[action]).toHaveBeenCalledWith(3, "user-1");
    await app.close();
  });
  it("시세는 인증된 유효 종목만 조회하고 계좌 연결 경로는 제공하지 않는다", async () => {
    const { app, service } = fixture();
    expect((await app.inject({ method: "GET", url: "/trading/quotes/005930" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/trading/quotes/invalid", headers: auth })).statusCode).toBe(400);
    expect(service.quote).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/trading/quotes/005930", headers: auth })).json()).toEqual({ symbol: "005930", price: 1000, timestampMs: 123 });
    expect((await app.inject({ method: "PUT", url: "/trading/account", headers: auth, payload: { expectedRevision: 3, accountId: "account" } })).statusCode).toBe(404);
    expect(service.selectAccount).not.toHaveBeenCalled();
    await app.close();
  });
  it("미확인 주문 대조는 확인 및 유효한 주문 ID를 요구한다", async () => {
    const { app, service } = fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    for (const payload of [{ expectedRevision: 3, acknowledged: false, brokerOrderId: null }, { expectedRevision: 3, acknowledged: true, brokerOrderId: "  " }, { acknowledged: true, brokerOrderId: null }]) {
      const response = await app.inject({ method: "POST", url: `/trading/orders/${id}/resolve`, headers: auth, payload });
      expect(response.statusCode).toBe(400);
    }
    const badId = await app.inject({ method: "POST", url: "/trading/orders/invalid/resolve", headers: auth, payload: { expectedRevision: 3, acknowledged: true, brokerOrderId: null } });
    expect(badId.statusCode).toBe(400);
    expect(service.resolveOrder).not.toHaveBeenCalled();
    service.resolveOrder.mockReturnValue({ revision: 4 });
    const response = await app.inject({ method: "POST", url: `/trading/orders/${id}/resolve`, headers: auth, payload: { expectedRevision: 3, acknowledged: true, brokerOrderId: "TOSS-1" } });
    expect(response.statusCode).toBe(200);
    expect(service.resolveOrder).toHaveBeenCalledWith(id, "TOSS-1", 3, "user-1");
    const absent = await app.inject({ method: "POST", url: `/trading/orders/${id}/resolve`, headers: auth, payload: { expectedRevision: 3, acknowledged: true, brokerOrderId: null } });
    expect(absent.statusCode).toBe(200);
    expect(service.resolveOrder).toHaveBeenCalledWith(id, null, 3, "user-1");
    await app.close();
  });
  it("충돌 코드를 전달하고 원본 작업 ID를 그대로 조회한다", async () => {
    const { app, service } = fixture();
    service.remove.mockImplementation(() => { throw new TradingError("다른 화면에서 변경됨", "STALE_REVISION", 409); });
    const conflict = await app.inject({ method: "DELETE", url: "/trading/strategy", headers: auth, payload: { expectedRevision: 3 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "다른 화면에서 변경됨", code: "STALE_REVISION" });
    expect(service.remove).toHaveBeenCalledWith(3, "user-1");
    const source = await app.inject({ method: "GET", url: "/trading/source/job-123", headers: auth });
    expect(source.statusCode).toBe(200);
    expect(service.source).toHaveBeenCalledWith("job-123");
    await app.close();
  });
});
