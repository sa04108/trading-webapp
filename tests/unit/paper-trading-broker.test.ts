import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../src/runtime/shared/db/database.js";
import { createPaperTradingBroker } from "../../src/server/modules/trading/infrastructure/paper-trading-broker.js";

const time = Date.parse("2026-11-17T03:00:00Z");
const buy = { clientOrderId: "one", symbol: "005930", side: "BUY" as const, quantity: 10, price: 1000 };
let database: DatabaseHandle;
afterEach(() => database?.close());
function setup() {
  database = openDatabase(":memory:");
  const quotes = vi.fn(async (symbols: string[]) => symbols.map(symbol => ({ symbol, price: 1000, timestampMs: time })));
  const dailyCandles = vi.fn(async () => []);
  const marketData = { quotes, dailyCandles };
  const make = () => createPaperTradingBroker({ database, marketData, now: () => time });
  return { broker: make(), make, quotes, dailyCandles };
}

describe("paper trading broker", () => {
  it("persists a fill and makes retries idempotent across broker instances", async () => {
    const { broker, make } = setup();
    await broker.place("PAPER", buy);
    const reopened = make();
    await reopened.place("PAPER", buy);
    expect(await reopened.buyingPower("PAPER")).toBe(100_000_000 - 10_000 - 1.5);
    expect(await reopened.holdings("PAPER")).toMatchObject([{ quantity: 10, averagePrice: 1000 }]);
    const order = await reopened.order("PAPER", "one");
    expect(order).toMatchObject({ status: "FILLED", filledQuantity: 10 });
    expect(order.commission).toBeCloseTo(1.5);
    await expect(reopened.place("PAPER", { ...buy, quantity: 11 })).rejects.toMatchObject({ uncertain: false });
    expect(await reopened.orders("PAPER", "2026-11-17", "2026-11-17")).toHaveLength(1);
  });
  it("enforces cash, holdings, limit and quote freshness", async () => {
    const { broker, quotes } = setup();
    await expect(broker.place("PAPER", { ...buy, quantity: 100_000 })).rejects.toMatchObject({ uncertain: false });
    await expect(broker.place("PAPER", { ...buy, side: "SELL" })).rejects.toMatchObject({ uncertain: false });
    await broker.place("PAPER", { ...buy, price: 999 });
    expect(await broker.order("PAPER", "one")).toMatchObject({ status: "REJECTED", filledQuantity: 0 });
    expect(await broker.buyingPower("PAPER")).toBe(100_000_000);
    quotes.mockResolvedValueOnce([{ symbol: buy.symbol, price: 1000, timestampMs: time - 30_001 }]);
    await expect(broker.place("PAPER", { ...buy, clientOrderId: "stale" })).rejects.toMatchObject({ uncertain: false });
  });
  it("checks the gate after the quote resolves and never mutates when disabled", async () => {
    const { broker, quotes } = setup();
    let resolve!: (value: { symbol: string; price: number; timestampMs: number }[]) => void;
    quotes.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    let enabled = true;
    const pending = broker.place("PAPER", buy, () => { if (!enabled) throw new Error("disabled"); });
    enabled = false;
    resolve([{ symbol: buy.symbol, price: 1000, timestampMs: time }]);
    await expect(pending).rejects.toMatchObject({ uncertain: false, message: "disabled" });
    expect(await broker.buyingPower("PAPER")).toBe(100_000_000);
    await expect(broker.order("PAPER", "one")).rejects.toMatchObject({ uncertain: false });
  });
  it("does not invent prices or let name lookup failures affect fills", async () => {
    const { broker, quotes, dailyCandles } = setup();
    const named = createPaperTradingBroker({ database, marketData: { quotes, dailyCandles }, now: () => time, getName: () => { throw new Error("name unavailable"); } });
    await named.place("PAPER", buy);
    expect(await named.holdings("PAPER")).toMatchObject([{ symbol: buy.symbol, name: buy.symbol, quantity: 10 }]);
    quotes.mockResolvedValueOnce([{ symbol: buy.symbol, price: 1000, timestampMs: time - 86_400_000 }]);
    expect(await named.holdings("PAPER")).toMatchObject([{ price: 1000 }]);
    quotes.mockResolvedValueOnce([{ symbol: buy.symbol, price: 1000, timestampMs: time - 86_400_000 }]);
    await expect(named.place("PAPER", { ...buy, clientOrderId: "old" })).rejects.toMatchObject({ uncertain: false });
    quotes.mockResolvedValueOnce([]);
    await expect(named.holdings("PAPER")).rejects.toMatchObject({ uncertain: false });
    await expect(broker.buyingPower("LIVE")).rejects.toMatchObject({ uncertain: false });
    expect(await named.order("PAPER", "one")).toMatchObject({ status: "FILLED" });
  });
  it("delegates only market-data reads", async () => {
    const { broker, quotes, dailyCandles } = setup();
    await broker.place("PAPER", buy);
    await broker.quotes([buy.symbol]);
    await broker.dailyCandles(buy.symbol, 1, 2);
    expect(quotes).toHaveBeenCalledWith([buy.symbol]);
    expect(dailyCandles).toHaveBeenCalledWith(buy.symbol, 1, 2);
  });
});
