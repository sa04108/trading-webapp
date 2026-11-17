import { describe, expect, it, vi } from "vitest";
import { createTossClient } from "../../src/server/modules/broker/infrastructure/toss/toss-client.js";
import { createTossTradingBroker } from "../../src/server/modules/broker/infrastructure/toss/toss-trading-broker.js";
import { createTossStockInfoSource } from "../../src/server/modules/broker/infrastructure/toss/toss-stock-info-source.js";
import { createLogger } from "../../src/server/shared/logger.js";
import { loadConfig } from "../../src/server/bootstrap/config.js";

const config = { baseUrl: "https://toss.test", clientId: "client", clientSecret: "secret" };
const logger = createLogger(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const token = { access_token: "token", expires_in: 86400 };
let time = Date.now();
const now = () => time;
const noop = async (ms: number) => { time += ms; };

describe("Toss trading adapter", () => {
  it("shares one token across concurrent stock and account requests", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/oauth2/token") ? json(token) : String(url).includes("/stocks?") ? json({ result: [] }) : json({ result: [] }));
    const client = createTossClient(config, logger, { fetchImpl: fetchImpl as typeof fetch, sleep: noop, now });
    const stock = createTossStockInfoSource(config, logger, { client });
    const trading = createTossTradingBroker(config, logger, { client });
    await Promise.all([stock.getStockInfo(["005930"]), trading.accounts()]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/oauth2/token"))).toHaveLength(1);
  });
  it("never retries an ambiguous submission and respects the last-moment guard", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token)).mockRejectedValueOnce(new Error("network"));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    const req = { clientOrderId: "a", symbol: "005930", side: "BUY" as const, quantity: 1, price: 100 };
    await expect(broker.place("1", req)).rejects.toMatchObject({ uncertain: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const guard = new Error("disabled");
    await expect(broker.place("1", req, () => { throw guard; })).rejects.toBe(guard);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([408, 500, 503])("treats HTTP %s after order submission as uncertain and never retries", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ error: "timeout" }, status));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.place("1", { clientOrderId: "request-1", symbol: "005930", side: "BUY", quantity: 1, price: 100 })).rejects.toMatchObject({ uncertain: true, statusCode: status });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("rejects a filled order whose commission or tax is not yet known", async () => {
    const filled = { orderId: "order1", symbol: "005930", side: "BUY", currency: "KRW", status: "FILLED", quantity: "1", execution: { filledQuantity: "1", averageFilledPrice: "100", commission: null, tax: "0" } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ result: filled })).mockResolvedValueOnce(json({ result: { ...filled, execution: { ...filled.execution, commission: "0", tax: null } } }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.order("1", "order1")).rejects.toThrow(/수수료·세금/);
    await expect(broker.order("1", "order1")).rejects.toThrow(/수수료·세금/);
  });
  it("fetches holdings once and requests sellable quantity only on demand", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ symbol: String(index).padStart(6, "0"), name: "종목", marketCountry: "KR", currency: "KRW", quantity: "10", averagePurchasePrice: "100", lastPrice: "110", marketValue: { amount: "1100" }, profitLoss: { amount: "100" } }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ result: { items } }))
      .mockResolvedValueOnce(json({ result: { sellableQuantity: "4" } }))
      .mockResolvedValueOnce(json({ result: { sellableQuantity: "-1" } }))
      .mockResolvedValueOnce(json({ result: { sellableQuantity: "1.5" } }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    const holdings = await broker.holdings("1");
    expect(holdings).toHaveLength(40);
    expect(holdings.every(h => h.availableQuantity === null)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(broker.sellableQuantity!("1", "000001")).resolves.toBe(4);
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("/api/v1/sellable-quantity?symbol=000001");
    await expect(broker.sellableQuantity!("1", "000001")).rejects.toThrow();
    await expect(broker.sellableQuantity!("1", "000001")).rejects.toThrow();
    await expect(broker.sellableQuantity!("1", "bad")).rejects.toThrow();
    await expect(broker.sellableQuantity!("", "000001")).rejects.toThrow();
  });
  it("rejects malformed pagination and foreign holdings", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token)).mockResolvedValueOnce(json({ result: { items: [{ symbol: "AAPL", marketCountry: "US", currency: "USD" }] } })).mockResolvedValueOnce(json({ result: { orders: [], hasNext: true, nextCursor: null } }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.holdings("1")).rejects.toThrow();
    await expect(broker.orders("1", "2026-01-01", "2026-01-02")).rejects.toThrow();
  });
  it("preserves partial fills on open orders and cancel response ambiguity", async () => {
    const partial = { orderId: "order1", symbol: "005930", side: "SELL", currency: "KRW", status: "PARTIAL_FILLED", quantity: "10", execution: { filledQuantity: "4", averageFilledPrice: "100", commission: "2", tax: "1" } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ result: { orders: [partial], hasNext: false, nextCursor: null } }))
      .mockResolvedValueOnce(json({ result: { orders: [], hasNext: false, nextCursor: null } }))
      .mockResolvedValueOnce(json({ result: {} }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.orders("1", "2026-01-01", "2026-01-02")).resolves.toMatchObject([{ status: "PARTIAL", filledQuantity: 4, commission: 2, tax: 1 }]);
    await expect(broker.cancel("1", "order1")).rejects.toMatchObject({ uncertain: true });
  });

  it("distinguishes terminal and live partial fills while preserving quantities", async () => {
    const base = { symbol: "005930", side: "SELL", currency: "KRW", status: "PARTIAL_FILLED", quantity: "10", execution: { filledQuantity: "4", averageFilledPrice: "100", commission: "2", tax: "1" } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ result: { orders: [{ ...base, orderId: "open" }], hasNext: false, nextCursor: null } }))
      .mockResolvedValueOnce(json({ result: { orders: [{ ...base, orderId: "closed" }], hasNext: false, nextCursor: null } }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.orders("1", "2026-01-01", "2026-01-02")).resolves.toMatchObject([
      { id: "open", status: "PARTIAL", filledQuantity: 4 },
      { id: "closed", status: "CANCELLED", filledQuantity: 4 },
    ]);
  });
  it("does not treat rejected cancellation records or replaced orders as settled", async () => {
    const base = { symbol: "005930", side: "SELL", currency: "KRW", quantity: "10", execution: { filledQuantity: "0", averageFilledPrice: null, commission: null, tax: null } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ result: { orders: [{ ...base, orderId: "open", status: "CANCEL_REJECTED" }], hasNext: false, nextCursor: null } }))
      .mockResolvedValueOnce(json({ result: { orders: [], hasNext: false, nextCursor: null } }))
      .mockResolvedValueOnce(json({ result: { ...base, orderId: "old", status: "REPLACED" } }));
    const broker = createTossTradingBroker(config, logger, { fetchImpl, sleep: noop, now });
    await expect(broker.orders("1", "2026-01-01", "2026-01-02")).resolves.toMatchObject([{ status: "OPEN" }]);
    await expect(broker.order("1", "old")).rejects.toThrow();
  });

});
