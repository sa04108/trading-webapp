import { INTRADAY_STRATEGIES } from "../../src/shared/schemas/intraday-strategies.js";
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
  // 일반 결측 검사는 지연 개장을 허용했을 때 시초 범위까지 실제 개장에 맞추는지 확인하지 못한다.
  it("확인된 지연 개장 전 구간만 제외하고 실제 첫 분과 장중 누락은 계속 거부한다", () => {
    const day = "2026-01-02";
    const data = bars(day).slice(0, 320).map((bar) => ({ ...bar, endMs: bar.endMs + 60 * 60_000 }));
    const req: IntradayRequest = {
      ...request(),
      period: { from: day, to: day },
      strategyId: "intraday-orb",
      parameters: { openingMinutes: 5, entryWindowMinutes: 15, breakoutBps: 0, volumeMultiplier: 1, allocationPct: 95, stopLossPct: 50, takeProfitPct: 100 },
    };
    const result = run([...bars(day).slice(0, 60), ...data], req, [day]);
    expect(result.processedBars).toBe(320);
    expect(result.equity[0]!.endMs).toBe(at("10:01", day));
    expect(result.signals[0]).toMatchObject({ atMs: at("10:06", day), side: "BUY", reason: "ORB" });
    expect(result.fills.at(-1)).toMatchObject({ atMs: at("15:16", day), side: "SELL" });
    expect(result.warnings.join(" ")).toContain("2026-01-02: 연초 개장식으로 10:00 개장");
    for (const missingIndex of [0, 75]) {
      expect(() => run(data.filter((_, i) => i !== missingIndex), req, [day])).toThrow("분봉 1개가 없습니다");
    }
    expect(aggregateIntradayBars(data, "5m")[0]!.endMs).toBe(at("10:05", day));
    const normalDay = "2026-01-05";
    expect(() => run(bars(normalDay).slice(60), { ...request(), period: { from: normalDay, to: normalDay } }, [normalDay])).toThrow("분봉 60개가 없습니다");
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
  it.each([
    {
      strategyId: "intraday-orb",
      reason: "ORB",
      at: "09:06",
      parameters: {
        openingMinutes: 5,
        entryWindowMinutes: 15,
        breakoutBps: 0,
        volumeMultiplier: 1,
      },
      closes: [1000, 1000, 1000, 1000, 1000, 1010],
    },
    {
      strategyId: "intraday-vwap-reclaim",
      reason: "VWAP",
      at: "09:04",
      parameters: { trendPeriod: 3, volumePeriod: 2, volumeMultiplier: 1 },
      closes: [1000, 900, 800, 1000],
    },
    {
      strategyId: "intraday-bollinger-rsi",
      reason: "BOLLINGER_RSI",
      at: "09:04",
      parameters: { bandPeriod: 3, bandStdDev: 1, rsiPeriod: 2, oversold: 30 },
      closes: [1000, 1000, 800, 850, 900],
    },
  ])("$strategyId의 신호를 지연 체결과 결과에 연결한다", (fixture) => {
    const req = intradayRequestSchema.parse({
      ...request(),
      strategyId: fixture.strategyId,
      parameters: {
        ...fixture.parameters,
        allocationPct: 95,
        stopLossPct: 50,
        takeProfitPct: 100,
      },
    });
    const data = bars().map((b, i) => {
      const close = fixture.closes[i] ?? fixture.closes.at(-1)!;
      return { ...b, open: close, high: close, low: close, close };
    });
    const result = run(data, req);
    expect(result.request.strategyId).toBe(fixture.strategyId);
    expect(result.strategyVersion).toBe("1.0.0");
    expect(result.signals[0]).toMatchObject({
      reason: fixture.reason,
      atMs: at(fixture.at),
      side: "BUY",
    });
    expect(result.fills[0]).toMatchObject({
      reason: fixture.reason,
      atMs: at(fixture.at) + 60_000,
      side: "BUY",
    });
    expect(result.position.quantity).toBe(0);
    expect(result.metrics.pnl).toBe(0);
  });
  it("새 전략 기본값과 기존 EMA 요청을 보존하고 잘못 섞인 파라미터와 불가능한 준비 시간을 거부한다", () => {
    for (const definition of INTRADAY_STRATEGIES) {
      const parsed = intradayRequestSchema.parse({
        ...request(),
        timeframe: "5m",
        strategyId: definition.id,
        parameters: definition.defaults,
      });
      expect(parsed.parameters).toEqual(definition.defaults);
    }
    expect(intradayRequestSchema.parse(request())).toEqual(request());
    expect(
      intradayRequestSchema.safeParse({
        ...request(),
        strategyId: "intraday-orb",
      }).success,
    ).toBe(false);
    const bb = INTRADAY_STRATEGIES.find(
      (s) => s.id === "intraday-bollinger-rsi",
    )!;
    const boundary = {
      ...request(),
      timeframe: "15m",
      strategyId: bb.id,
      parameters: { ...bb.defaults, bandPeriod: 24 },
    };
    expect(intradayRequestSchema.safeParse(boundary).success).toBe(false);
    expect(
      intradayRequestSchema.safeParse({
        ...boundary,
        parameters: { ...boundary.parameters, bandPeriod: 23 },
      }).success,
    ).toBe(true);
  });
});
