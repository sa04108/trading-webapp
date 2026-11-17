import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTossClient } from "../../src/server/modules/broker/infrastructure/toss/toss-client.js";
import { createLogger } from "../../src/server/shared/logger.js";
import { loadConfig } from "../../src/server/bootstrap/config.js";

const logger = createLogger(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }));
const config = { baseUrl: "https://toss.test", clientId: "client", clientSecret: "secret" };
const json = (body: unknown = {}, status = 200, headers?: RequestInit["headers"]) => new Response(JSON.stringify(body), { status, headers });
const token = () => json({ access_token: "token", expires_in: 86400 });
const clients: ReturnType<typeof createTossClient>[] = [];
function client(fetchImpl: typeof fetch) {
  const value = createTossClient(config, logger, { fetchImpl, sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)) });
  clients.push(value);
  return value;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T01:00:00Z")); });
afterEach(() => { clients.splice(0).forEach(c => c.close()); vi.clearAllTimers(); vi.useRealTimers(); });

// 어댑터의 응답 파싱 테스트는 동시 호출의 실제 전송 간격·429 대기·인증 취소를 검증하지 않는다.
describe("토스 공통 요청 한도와 재시도", () => {
  it("종목·계좌·조회 조건이 달라도 같은 API 그룹은 한도를 공유하고 다른 그룹은 독립적으로 진행한다", async () => {
    const start = Date.now();
    const sends: { path: string; at: number }[] = [];
    const c = client(vi.fn(async (url) => {
      const path = String(url).replace(config.baseUrl, "");
      if (path === "/oauth2/token") return token();
      sends.push({ path, at: Date.now() - start });
      return json();
    }));
    const cases = [
      ["/api/v1/accounts", "/api/v1/accounts", 1000],
      ["/api/v1/holdings", "/api/v1/holdings", 200],
      ["/api/v1/stocks?symbols=005930", "/api/v1/stocks?symbols=000660", 200],
      ["/api/v1/prices?symbols=005930", "/api/v1/orderbook?symbol=000660", 67],
      ["/api/v1/candles?interval=1m", "/api/v1/candles?interval=1d", 50],
      ["/api/v1/orders?status=OPEN", "/api/v1/orders/order-1", 200],
      ["/api/v1/buying-power?currency=KRW", "/api/v1/sellable-quantity?symbol=005930", 167],
    ] as const;
    const requests = cases.flatMap(([a, b]) => [c.request(a, { headers: { "X-Tossinvest-Account": "a" } }), c.request(b, { headers: { "X-Tossinvest-Account": "b" } })]);
    requests.push(c.request("/api/v1/orders", { method: "POST" }), c.request("/api/v1/orders/one/cancel", { method: "POST" }));
    await vi.runAllTimersAsync();
    await Promise.all(requests);
    for (const [a, b, interval] of cases) {
      expect(sends.filter(s => s.path === a || s.path === b).map(s => s.at)).toEqual([0, interval]);
    }
    expect(sends.filter(s => s.path === "/api/v1/orders" || s.path.endsWith("/cancel")).map(s => s.at)).toEqual([0, 100]);
  });

  it("주문 가능 정보의 대기 중 KST 09시 경계를 지나면 3 TPS로 낮추고 09:10에 6 TPS로 복원한다", async () => {
    vi.setSystemTime(new Date("2026-11-17T08:59:59.900+09:00"));
    const sends: number[] = [];
    const c = client(vi.fn(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return token();
      sends.push(Date.now()); return json();
    }));
    const first = c.request("/api/v1/buying-power");
    const second = c.request("/api/v1/sellable-quantity");
    await vi.runAllTimersAsync(); await Promise.all([first, second]);
    expect(sends[1]! - sends[0]!).toBe(334);
    vi.setSystemTime(new Date("2026-11-17T09:10:00+09:00"));
    const next = [c.request("/api/v1/buying-power"), c.request("/api/v1/sellable-quantity")];
    await vi.runAllTimersAsync(); await Promise.all(next);
    expect(sends[3]! - sends[2]!).toBe(167);
  });

  it("429 Retry-After를 같은 그룹의 대기 요청에도 적용하고 다른 그룹은 막지 않는다", async () => {
    const start = Date.now();
    const sends: { path: string; at: number }[] = [];
    let limited = false;
    const c = client(vi.fn(async (url) => {
      const path = String(url).replace(config.baseUrl, "");
      if (path === "/oauth2/token") return token();
      sends.push({ path, at: Date.now() - start });
      if (path.startsWith("/api/v1/stocks") && !limited) {
        limited = true;
        return json({ error: { code: "TOO_MANY_REQUESTS" } }, 429, { "Retry-After": "2", "X-RateLimit-Reset": "1" });
      }
      return json({ path });
    }));
    const result = Promise.all([c.request("/api/v1/stocks?symbols=005930"), c.request("/api/v1/stocks?symbols=000660"), c.request("/api/v1/candles")]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sends).toEqual([{ path: "/api/v1/stocks?symbols=005930", at: 0 }, { path: "/api/v1/candles", at: 0 }]);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toHaveLength(3);
    expect(sends.filter(s => s.path.includes("stocks")).map(s => s.at)).toEqual([0, 2000, 2200]);
  });

  it.each([
    [{ "X-RateLimit-Reset": "2" }, 2000],
    [{ "Retry-After": "Tue, 17 Nov 2026 01:00:03 GMT" }, 3000],
  ])("재시도 헤더 %j의 대기시간을 따른다", async (headers, expected) => {
    let attempts = 0;
    const start = Date.now();
    const c = client(vi.fn(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return token();
      return ++attempts === 1 ? json({}, 429, headers) : json();
    }));
    const result = c.request("/api/v1/stocks");
    await vi.runAllTimersAsync(); await result;
    expect(Date.now() - start).toBe(expected);
  });

  it("연속 429는 횟수 제한으로 실패시키지 않고 헤더가 없으면 최대 30초 간격으로 이어간다", async () => {
    let attempts = 0;
    const sends: number[] = [];
    const start = Date.now();
    const c = client(vi.fn(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return token();
      sends.push(Date.now() - start);
      return ++attempts <= 7 ? json({}, 429) : json({ ok: true });
    }));
    const result = c.request("/api/v1/stocks");
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ ok: true });
    expect(sends).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
  });

  it("429 주문은 같은 본문으로 재시도하며 실제 전송마다 마지막 안전 검사를 실행한다", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return token();
      return ++attempts === 1 ? json({}, 429) : json({ orderId: "accepted" });
    });
    const c = client(fetchImpl);
    const beforeSend = vi.fn();
    const body = { clientOrderId: "unique", symbol: "005930", side: "BUY", quantity: "1", price: "1000" };
    const result = c.request("/api/v1/orders", { method: "POST", body, beforeSend });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ orderId: "accepted" });
    expect(beforeSend).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/orders")).map(([, init]) => init?.body)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
  });

  it("인증 429 대기를 공유하고 한 호출의 취소가 다른 호출의 인증을 중단하지 않는다", async () => {
    let authCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return ++authCalls === 1 ? json({}, 429) : token();
      return json();
    });
    const c = client(fetchImpl);
    const controller = new AbortController();
    const cancelled = c.request("/api/v1/stocks", { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ uncertain: false });
    const remaining = c.request("/api/v1/holdings");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejection;
    await vi.runAllTimersAsync(); await remaining;
    expect(authCalls).toBe(2);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/stocks"))).toHaveLength(0);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/holdings"))).toHaveLength(1);
  });

  it("공유 인증의 마지막 호출이 취소되면 재시도를 멈추고 다음 호출은 다시 인증한다", async () => {
    let authCalls = 0;
    const c = client(vi.fn(async (url) => {
      if (String(url).endsWith("/oauth2/token")) return ++authCalls === 1 ? json({}, 429) : token();
      return json();
    }));
    const controller = new AbortController();
    const cancelled = c.request("/api/v1/stocks", { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ uncertain: false });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejection;
    await vi.runAllTimersAsync();
    expect(authCalls).toBe(1);
    await c.request("/api/v1/stocks");
    expect(authCalls).toBe(2);
  });

  it("이미 전송한 인증은 호출자 취소 후에도 응답까지 공유해 중복 발급하지 않는다", async () => {
    let finish!: (value: Response) => void;
    const issuing = new Promise<Response>(resolve => { finish = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/oauth2/token") ? issuing : json());
    const c = client(fetchImpl);
    const controller = new AbortController();
    const cancelled = c.request("/api/v1/stocks", { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toMatchObject({ uncertain: false });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejection;
    const next = c.request("/api/v1/holdings");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finish(token()); await next;
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("대기 중 다른 그룹이 토큰을 재발급하면 최신 토큰으로 주문을 보낸다", async () => {
    let authCalls = 0, orderCalls = 0;
    const authorizations: unknown[] = [];
    const c = client(vi.fn(async (url, init) => {
      if (String(url).endsWith("/oauth2/token")) return json({ access_token: `token-${++authCalls}`, expires_in: 3600 });
      if (String(url).endsWith("/accounts")) return json({}, 401);
      if (String(url).endsWith("/orders")) {
        authorizations.push((init?.headers as Record<string, string>).authorization);
        return ++orderCalls === 1 ? json({}, 429, { "Retry-After": "10" }) : json();
      }
      return json();
    }));
    const order = c.request("/api/v1/orders", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(c.request("/api/v1/accounts")).rejects.toMatchObject({ statusCode: 401 });
    const stock = c.request("/api/v1/stocks");
    await vi.advanceTimersByTimeAsync(200); await stock;
    await vi.runAllTimersAsync(); await order;
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(authCalls).toBe(2);
  });

  it("서버 종료 시 429 재시도와 같은 그룹의 대기 요청을 실패 전송 없이 중단한다", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/oauth2/token") ? token() : json({}, 429, { "Retry-After": "60" }));
    const c = client(fetchImpl);
    const requests = [c.request("/api/v1/stocks"), c.request("/api/v1/stocks?symbols=005930")];
    const results = Promise.allSettled(requests);
    await vi.advanceTimersByTimeAsync(0);
    c.close();
    expect(await results).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ uncertain: false }) })));
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("오래 기다린 429 요청은 만료된 토큰을 재발급한 후 재전송한다", async () => {
    let authCalls = 0, calls = 0;
    const authorizations: unknown[] = [];
    const c = client(vi.fn(async (url, init) => {
      if (String(url).endsWith("/oauth2/token")) return json({ access_token: `token-${++authCalls}`, expires_in: 5 });
      authorizations.push((init?.headers as Record<string, string>).authorization);
      return ++calls === 1 ? json({}, 429, { "Retry-After": "10" }) : json();
    }));
    const result = c.request("/api/v1/candles");
    await vi.runAllTimersAsync(); await result;
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(authCalls).toBe(2);
  });
});
