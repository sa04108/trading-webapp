import { describe, expect, it } from "vitest";
import {
  aggregateIntradayBars,
  runIntradayBacktest,
} from "../../src/runtime/modules/intraday/domain/engine.js";
import {
  intradayRequestSchema,
  type IntradayBar,
  type IntradayRequest,
} from "../../src/shared/schemas/intraday.js";
import { backtestRequestSchema } from "../../src/shared/schemas/backtest-request.js";

const date = "2026-11-12";
const at = (time: string, day = date) => Date.parse(`${day}T${time}:00+09:00`);
function request(): IntradayRequest {
  return {
    mode: "intraday",
    strategyId: "intraday-ema",
    symbol: "005930",
    period: { from: date, to: date },
    timeframe: "1m",
    initialCash: 100_000,
    parameters: {
      fast: 2,
      slow: 3,
      allocationPct: 95,
      stopLossPct: 50,
      takeProfitPct: 100,
    },
    execution: {
      holdingPolicy: "DAY_ONLY",
      commissionBps: 0,
      taxBps: 0,
      slippageBps: 0,
      latencyMs: 1,
      orderExpiryMinutes: 3,
      maxParticipationPct: 10,
    },
  };
}
function bars(day = date): IntradayBar[] {
  return Array.from({ length: 380 }, (_, i) => ({
    endMs: at("09:00", day) + (i + 1) * 60_000,
    open: i < 5 ? 1000 : 1010,
    high: i < 5 ? 1000 : 1010,
    low: i < 5 ? 1000 : 1010,
    close: i < 5 ? 1000 : 1010,
    volume: 1000,
  }));
}
const run = (data = bars(), req = request(), tradingDates = [date]) =>
  runIntradayBacktest({
    request: req,
    bars: data,
    tradingDates,
    dataRevision: "pinned",
  });

describe("분봉 정보 시각과 주문 생명주기", () => {
  it("확정 봉 신호와 지연을 지난 시가 체결을 구별하며 현금과 청산을 보존한다", () => {
    const result = run();
    expect(result.signals[0]).toMatchObject({ atMs: at("09:06"), side: "BUY" });
    expect(result.fills[0]).toMatchObject({
      signalAtMs: at("09:06"),
      eligibleAtMs: at("09:06") + 1,
      atMs: at("09:07"),
      qty: 94,
      price: 1010,
    });
    expect(result.fills.at(-1)).toMatchObject({
      signalAtMs: at("15:15"),
      atMs: at("15:16"),
      side: "SELL",
    });
    expect(result.position.quantity).toBe(0);
    expect(result.metrics.pnl).toBe(0);
    expect(result.metrics.completedTrades).toBe(1);
    expect(result.equity.every((e) => e.cash >= 0)).toBe(true);
    expect(
      result.fills.every(
        (f) => f.atMs >= f.eligibleAtMs && f.atMs > f.signalAtMs,
      ),
    ).toBe(true);
  });
  it("미래 거래량으로 주문 수량을 늘리지 않고 부분체결 잔량을 만료시킨다", () => {
    const data = bars();
    data[5]!.volume = 100;
    for (let i = 7; i < data.length; i++) data[i]!.volume = i <= 9 ? 20 : 0;
    const result = run(
      [...data, ...bars("2026-11-13")],
      { ...request(), period: { from: date, to: "2026-11-13" } },
      [date, "2026-11-13"],
    );
    expect(
      result.fills.filter((f) => f.side === "BUY").map((f) => f.qty),
    ).toEqual([2, 2, 2]);
    expect(result.orderEvents).toContainEqual(
      expect.objectContaining({ status: "EXPIRED", remainingQty: 4 }),
    );
    expect(result.position.quantity).toBe(6);
    expect(result.processedBars).toBe(380);
    expect(result.warnings.join(" ")).toContain("당일 청산에 실패");
    const generous = bars();
    generous[5]!.volume = 100;
    generous[7]!.volume = 1_000_000;
    expect(run(generous).fills[0]!.qty).toBe(10);
  });
  it("매도 슬리피지가 최소 호가 아래로 내려가도 0원으로 체결하지 않는다", () => {
    const data = bars();
    for (let i = 10; i < data.length; i++)
      Object.assign(data[i]!, { open: 1, high: 1, low: 1, close: 1 });
    const req = request();
    req.execution.slippageBps = 5;
    const result = run(data, req),
      sells = result.fills.filter((f) => f.side === "SELL");
    expect(sells.length).toBeGreaterThan(0);
    expect(sells.every((f) => f.price === 1)).toBe(true);
  });
  it("세션을 넘겨 집계하지 않고 누락된 입력은 실행을 거부한다", () => {
    const data = bars();
    const first = aggregateIntradayBars(data, "5m")[0]!;
    expect(first).toMatchObject({
      endMs: at("09:05"),
      open: 1000,
      close: 1000,
      volume: 5000,
    });
    const incomplete = data.filter((_, i) => i !== 2);
    expect(aggregateIntradayBars(incomplete, "5m")[0]!.endMs).toBe(at("09:10"));
    expect(() => run(incomplete)).toThrow("분봉 1개가 없습니다");
    expect(() => run([...data, data[0]!])).toThrow("중복");
  });
  it("다음 날 가격 단절을 EMA 교차로 해석하지 않고 지원 모드를 검증한다", () => {
    const flat = (day: string, price: number) =>
      bars(day).map((b) => ({
        ...b,
        open: price,
        high: price,
        low: price,
        close: price,
      }));
    const result = run(
      [...flat(date, 1000), ...flat("2026-11-13", 10_000)],
      { ...request(), period: { from: date, to: "2026-11-13" } },
      [date, "2026-11-13"],
    );
    expect(result.signals).toEqual([]);
    expect(
      intradayRequestSchema.safeParse({ ...request(), mode: "daily" }).success,
    ).toBe(false);
    expect(backtestRequestSchema.safeParse(request()).success).toBe(false);
    expect(
      intradayRequestSchema.safeParse({
        ...request(),
        timeframe: "15m",
        parameters: { ...request().parameters, slow: 26 },
      }).success,
    ).toBe(false);
  });
});
