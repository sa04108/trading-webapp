import { describe, expect, it } from "vitest";
import { summarizeIntradayTrades } from "../../src/shared/intraday-trades.js";
import type { IntradayFill, IntradayResult } from "../../src/shared/schemas/intraday.js";

const fill = (side: "BUY" | "SELL", qty: number, price: number, commission: number, atMs: number, tax = 0): IntradayFill => ({
  orderId: "order", signalAtMs: atMs, eligibleAtMs: atMs, atMs, side, qty, price, commission, tax, reason: "EMA",
});
const result = (fills: IntradayFill[], lastPrice = 100, endMs = 600_000): Pick<IntradayResult, "request" | "fills" | "position" | "equity"> => ({
  request: { symbol: "005930" } as IntradayResult["request"],
  fills, position: { quantity: 0, averagePrice: 0, lastPrice },
  equity: [{ endMs, equity: 0, cash: 0, quantity: 0 }],
});

describe("분봉 매도 체결별 거래 요약", () => {
  it("부분 매도와 추가 매수의 비용을 배분하고 완전 청산 후 진입 시각을 초기화한다", () => {
    const input = result([
      fill("BUY", 10, 100, 10, 0),
      fill("SELL", 4, 120, 4, 60_000, 2),
      fill("BUY", 4, 150, 8, 60_000),
      fill("SELL", 10, 140, 10, 180_000, 5),
      fill("BUY", 2, 200, 2, 240_000),
    ], 210, 300_000);
    const before = structuredClone(input);
    const summary = summarizeIntradayTrades(input);
    expect(summary.trades).toEqual([
      { id: "1", symbol: "005930", quantity: 4, entryTsMs: 0, exitTsMs: 60_000, entryPrice: 100, exitPrice: 120, costs: 10, netPnl: 70, returnPct: 17.5, holdingTimeMs: 60_000, exitReason: "EMA" },
      { id: "3", symbol: "005930", quantity: 10, entryTsMs: 0, exitTsMs: 180_000, entryPrice: 120, exitPrice: 140, costs: 29, netPnl: 171, returnPct: expect.closeTo(14.25), holdingTimeMs: 180_000, exitReason: "EMA" },
    ]);
    expect(summary.openPosition).toEqual({ symbol: "005930", quantity: 2, entryTsMs: 240_000, entryPrice: 200, lastPrice: 210, lastPriceTsMs: 300_000, unrealizedPnl: 18, returnPct: 4.5, holdingTimeMs: 60_000, entryCosts: 2 });
    expect(summary).toMatchObject({ tradeCount: 2, winRate: 100, averageHoldingMinutes: 2 });
    expect(input).toEqual(before);
  });

  it("체결이 없거나 수수료로 손실인 매도를 승리로 세지 않는다", () => {
    expect(summarizeIntradayTrades(result([]))).toEqual({ trades: [], openPosition: null, tradeCount: 0, winRate: null, averageHoldingMinutes: null });
    const summary = summarizeIntradayTrades(result([fill("BUY", 2, 100, 2, 0), fill("SELL", 1, 101, 1, 60_000)], 100));
    expect(summary.trades[0]).toMatchObject({ costs: 2, netPnl: -1, returnPct: -1 });
    expect(summary.openPosition).toMatchObject({ quantity: 1, entryCosts: 1, unrealizedPnl: -1, returnPct: -1 });
    expect(summary).toMatchObject({ tradeCount: 1, winRate: 0, averageHoldingMinutes: 1 });
  });
});
