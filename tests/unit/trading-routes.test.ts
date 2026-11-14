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
    register: vi.fn(), update: vi.fn(), remove: vi.fn(), version: vi.fn(),
    activate: vi.fn(), resolveOrder: vi.fn(), deactivate: vi.fn(), refresh: vi.fn(), selectAccount: vi.fn(),
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
  ["POST", "/trading/orders/00000000-0000-4000-8000-000000000001/resolve"], ["POST", "/trading/refresh"], ["PUT", "/trading/account"],
] as const;

describe("거래 경로 인증과 요청 계약", () => {
  it("모든 변경 요청에 인증이 필요하다", async () => {
    const { app, service } = fixture();
    for (const [method, url] of mutations) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    for (const method of [service.register, service.update, service.remove, service.version, service.activate, service.resolveOrder, service.deactivate, service.refresh, service.selectAccount]) expect(method).not.toHaveBeenCalled();
    await app.close();
  });
  it("활성화는 명시적 확인과 리비전이 모두 필요하고 추가 필드를 거부한다", async () => {
    const { app, service } = fixture();
    for (const payload of [{ expectedRevision: 3, acknowledged: false }, { acknowledged: true }, { expectedRevision: 3, acknowledged: true, extra: 1 }]) {
      const response = await app.inject({ method: "POST", url: "/trading/activate", headers: auth, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(service.activate).not.toHaveBeenCalled();
    service.activate.mockReturnValue({ revision: 4 });
    const response = await app.inject({ method: "POST", url: "/trading/activate", headers: auth, payload: { expectedRevision: 3, acknowledged: true } });
    expect(response.statusCode).toBe(200);
    expect(service.activate).toHaveBeenCalledWith(3, "user-1");
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
