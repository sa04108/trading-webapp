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
  it("불완전한 집계 봉은 생략하고 누락은 경고하되 중복 입력은 거부한다", () => {
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
    const result = run(incomplete, { ...request(), timeframe: "5m" });
    expect(result.processedBars).toBe(379);
    expect(result.warnings.join(" ")).toContain("분봉 1개(1구간)가 누락");
    expect(result.signals.every((signal) => signal.atMs >= at("09:10"))).toBe(true);
    expect(result.equity.some((point) => point.endMs === at("09:03"))).toBe(false);
    expect(() => run([...data, data[0]!])).toThrow("중복");
  });
  // 날짜 예외를 제거해도 첫 수신 봉을 시초로 바꾸거나 빠진 시초 범위로 진입하면 안 된다.
  it.each(["2026-01-02", "2026-01-05"])("%s의 개장 구간 누락을 경고하고 ORB의 시초 범위를 이동하지 않는다", (day) => {
    const data = bars(day).slice(0, 320).map((bar) => ({ ...bar, endMs: bar.endMs + 60 * 60_000 }));
    const req = { ...request(), period: { from: day, to: day } };
    const result = run(data, req, [day]);
    expect(result.processedBars).toBe(320);
    expect(result.equity[0]!.endMs).toBe(at("10:01", day));
    expect(result.signals[0]).toMatchObject({ atMs: at("10:06", day), side: "BUY" });
    expect(result.fills.at(-1)).toMatchObject({ atMs: at("15:16", day), side: "SELL" });
    expect(result.warnings.join(" ")).toContain("분봉 60개(1구간)가 누락");
    const orb = run(data, {
      ...req,
      strategyId: "intraday-orb",
      parameters: { openingMinutes: 5, entryWindowMinutes: 15, breakoutBps: 0, volumeMultiplier: 1, allocationPct: 95, stopLossPct: 50, takeProfitPct: 100 },
    }, [day]);
    expect(orb.signals).toEqual([]);
    expect(orb.fills).toEqual([]);
    expect(orb.warnings.join(" ")).toContain("시초가 범위 돌파 진입을 생략");
    expect(aggregateIntradayBars(data, "5m")[0]!.endMs).toBe(at("10:05", day));
  });
  // 기존에는 결측 시 실행을 거부해 누락 뒤 체결·만료와 마지막 봉 누락 시 잔량 보존을 검사할 수 없었다.
  it.each([2, 5])("신호 뒤 %i분 누락 중에는 체결하지 않고 다음 봉에서 주문 유효시간을 적용한다", (missing) => {
    const data = bars().filter((_, i) => i < 6 || i >= 6 + missing);
    const result = run(data);
    expect(result.signals[0]).toMatchObject({ atMs: at("09:06"), side: "BUY" });
    expect(result.fills.every((fill) => data.some((bar) => bar.endMs - 60_000 === fill.atMs))).toBe(true);
    if (missing === 2) {
      expect(result.fills[0]).toMatchObject({ atMs: at("09:08"), side: "BUY" });
      expect(result.position.quantity).toBe(0);
    } else {
      expect(result.fills).toEqual([]);
      expect(result.orderEvents).toContainEqual(expect.objectContaining({ orderId: result.signals[0]!.id, status: "EXPIRED", atMs: at("09:09") + 1 }));
    }
  });
  it.each([
    { signalTime: "15:05", status: "EXPIRED", terminalAt: at("15:08") + 1 },
    { signalTime: "15:09", status: "CANCELLED", terminalAt: at("15:10") },
  ])("누락이 진입 마감을 넘겨도 $signalTime 매수의 첫 종료 조건을 기록한다", ({ signalTime, status, terminalAt }) => {
    const signalAt = at(signalTime);
    const beforeGap = bars().filter((bar) => bar.endMs <= signalAt).map((bar) => {
      const price = bar.endMs === signalAt ? 1010 : 1000;
      return { ...bar, open: price, high: price, low: price, close: price };
    });
    // 이후 봉이 아예 없어도, 마감 뒤에 다시 와도 같은 주문 종료 시각을 유지한다.
    for (const suffix of [[], bars().filter((bar) => bar.endMs >= at("15:12"))]) {
      const result = run([...beforeGap, ...suffix]);
      expect(result.signals).toHaveLength(1);
      expect(result.signals[0]).toMatchObject({ atMs: signalAt, side: "BUY" });
      expect(result.fills).toEqual([]);
      expect(result.orderEvents).toEqual([expect.objectContaining({ orderId: result.signals[0]!.id, status, atMs: terminalAt })]);
    }
  });
  it("마지막 봉 누락으로 청산하지 못하면 실제 잔량을 보존하고 다음 날 매매를 시작하지 않는다", () => {
    const nextDay = "2026-11-13";
    const data = bars().filter((bar) => bar.endMs <= at("15:15"));
    const result = run([...data, ...bars(nextDay)], { ...request(), period: { from: date, to: nextDay } }, [date, nextDay]);
    expect(result.processedBars).toBe(375);
    expect(result.fills).toHaveLength(1);
    expect(result.position).toMatchObject({ quantity: 94, lastPrice: 1010 });
    expect(result.orderEvents).toContainEqual(expect.objectContaining({ status: "EXPIRED", atMs: at("15:18") + 1, remainingQty: 94 }));
    expect(result.metrics.completedTrades).toBe(0);
    expect(result.metrics.pnl).toBe(0);
    expect(result.equity.at(-1)).toMatchObject({ endMs: at("15:15"), cash: 5060, quantity: 94, equity: 100000 });
    expect(result.warnings.join(" ")).toContain(`${date} 당일 청산에 실패해 94주가 남았습니다`);
  });
  // 봉 시가에서만 만료를 처리하면 봉 중간에 만료한 주문이 종가의 새 청산 신호를 막는다.
  it("봉 중간에 만료한 주문을 종가 신호 전에 종료해 청산을 다시 시도한다", () => {
    const data = bars().map((bar) => {
      const price = bar.endMs >= at("15:11") ? 900 : bar.close;
      const volume = bar.endMs >= at("15:12") && bar.endMs <= at("15:15") ? 0 : bar.volume;
      return { ...bar, open: price, high: price, low: price, close: price, volume };
    });
    const req = request();
    req.parameters.stopLossPct = 5;
    const result = run(data, req);
    expect(result.signals.filter((signal) => signal.side === "SELL").map((signal) => signal.atMs)).toEqual([at("15:11"), at("15:15")]);
    expect(result.orderEvents).toContainEqual(expect.objectContaining({ status: "EXPIRED", atMs: at("15:14") + 1 }));
    expect(result.fills.at(-1)).toMatchObject({ side: "SELL", signalAtMs: at("15:15"), atMs: at("15:16") });
    expect(result.position.quantity).toBe(0);
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
