import { describe, expect, it } from "vitest";
import { createIntradaySignalModel } from "../../src/runtime/modules/intraday/domain/signal-model.js";
import {
  intradayRequestSchema,
  type IntradayBar,
  type IntradayRequest,
} from "../../src/shared/schemas/intraday.js";

const base = {
  mode: "intraday",
  symbol: "005930",
  period: { from: "2024-01-02", to: "2024-01-03" },
  timeframe: "1m",
  initialCash: 100000,
  execution: {
    holdingPolicy: "DAY_ONLY",
    commissionBps: 0,
    taxBps: 0,
    slippageBps: 0,
    latencyMs: 1,
    orderExpiryMinutes: 1,
    maxParticipationPct: 10,
  },
};
const risk = { allocationPct: 100, stopLossPct: 1, takeProfitPct: 1 };
const request = (strategyId: string, parameters: object): IntradayRequest =>
  intradayRequestSchema.parse({
    ...base,
    strategyId,
    parameters: { ...risk, ...parameters },
  });
const bar = (
  minute: number,
  close: number,
  volume = 10,
  day = "2024-01-02",
): IntradayBar => ({
  endMs: Date.parse(`${day}T09:00:00+09:00`) + minute * 60000,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});
const run = (r: IntradayRequest, bars: IntradayBar[]) => {
  const model = createIntradaySignalModel(r);
  return bars.map((b) => model.onMinute(b, b));
};

describe("intraday signal models", () => {
  it("retains EMA warmup, crossing and daily reset", () => {
    const r = request("intraday-ema", { fast: 2, slow: 3, volumePeriod: 2, volumeMultiplier: 1 });
    const bars = [
      bar(1, 100),
      bar(2, 90),
      bar(3, 110),
      bar(4, 80),
      bar(1, 110, 10, "2024-01-03"),
    ];
    expect(run(r, bars)).toEqual([
      { entry: null, exit: null },
      { entry: null, exit: null },
      { entry: "EMA", exit: null },
      { entry: null, exit: "EMA" },
      { entry: null, exit: null },
    ]);
  });
  it("requires a positive volume confirmation against prior signal bars for EMA entry", () => {
    const r = request("intraday-ema", { fast: 2, slow: 3, volumePeriod: 2, volumeMultiplier: 1.3 });
    const history = [bar(1, 100), bar(2, 90)];
    expect(run(r, [...history, bar(3, 110, 12)])[2]!.entry).toBeNull();
    expect(run(r, [...history, bar(3, 110, 13)])[2]!.entry).toBe("EMA");
  });
  it("uses the completed opening range and allows only one breakout per day", () => {
    const r = request("intraday-orb", {
      openingMinutes: 5,
      entryWindowMinutes: 15,
      breakoutBps: 0,
      volumeMultiplier: 1,
    });
    const bars = [1, 2, 3, 4, 5]
      .map((i) => bar(i, 100))
      .concat([
        bar(6, 101, 0),
        bar(7, 100),
        bar(8, 101),
        bar(9, 99),
        bar(10, 101),
        ...[1, 2, 3, 4, 5].map((i) => bar(i, 100, 10, "2024-01-03")),
        bar(6, 101, 10, "2024-01-03"),
      ]);
    const out = run(r, bars);
    expect(out[5]?.entry).toBeNull();
    expect(out[7]?.entry).toBe("ORB");
    expect(out[8]?.exit).toBe("ORB");
    expect(out[9]?.entry).toBeNull();
    expect(out[15]?.entry).toBe("ORB");
  });
  it("allows the first 15-minute signal after a five-minute opening range", () => {
    const r = intradayRequestSchema.parse({
      ...base,
      timeframe: "15m",
      strategyId: "intraday-orb",
      parameters: {
        ...risk,
        openingMinutes: 5,
        entryWindowMinutes: 15,
        breakoutBps: 0,
        volumeMultiplier: 1,
      },
    });
    const model = createIntradaySignalModel(r);
    for (let i = 1; i < 15; i++) model.onMinute(bar(i, i <= 5 ? 100 : 110));
    const last = bar(15, 110);
    const aggregated = { ...last, open: 100, high: 110, low: 100, volume: 150 };
    expect(model.onMinute(last, aggregated).entry).toBe("ORB");
  });
  it("uses cumulative typical-price VWAP and prior signal volumes", () => {
    const r = request("intraday-vwap-reclaim", {
      trendPeriod: 3,
      volumePeriod: 2,
      volumeMultiplier: 1,
    });
    // 100, 90, 80의 VWAP는 90이며 100이 추가되면 92.5다.
    const bars = [bar(1, 100), bar(2, 90), bar(3, 80), bar(4, 100), bar(5, 80)];
    const out = run(r, bars);
    expect(out[3]).toEqual({ entry: "VWAP", exit: null });
    expect(out[4]!.exit).toBe("VWAP");
    expect(run(r, [...bars.slice(0, 3), bar(4, 100, 0)])[3]!.entry).toBeNull();
    expect(run(r, bars.slice(0, 4))).toEqual(out.slice(0, 4));
    expect(
      run(r, [...bars.slice(0, 3), bar(1, 100, 10, "2024-01-03")])[3]!.entry,
    ).toBeNull();
  });
  it("allows a delayed oversold recovery only within its daily expiry", () => {
    const params = { bandPeriod: 4, bandStdDev: 1, rsiPeriod: 2, oversold: 30 };
    const bars = [bar(1, 100), bar(2, 100), bar(3, 100), bar(4, 80), bar(5, 81, 0), bar(6, 82)];
    const active = request("intraday-bollinger-rsi", { ...params, recoveryBars: 2 });
    const expired = request("intraday-bollinger-rsi", { ...params, recoveryBars: 1 });
    expect(run(active, bars)[5]!.entry).toBe("BOLLINGER_RSI");
    expect(run(expired, bars)[5]!.entry).toBeNull();
    const nextDay = bars.slice(0, 5).concat(bar(1, 82, 10, "2024-01-03"));
    expect(run(active, nextDay)[5]!.entry).toBeNull();
  });
  it("confirms recovery using the previous population band and Wilder RSI", () => {
    const r = request("intraday-bollinger-rsi", {
      bandPeriod: 3,
      bandStdDev: 1,
      rsiPeriod: 2,
      oversold: 30,
    });
    // [100, 100, 80]의 하단 밴드는 93.33 - sqrt(800/9), RSI는 0이며 다음 RSI는 33.33이다.
    const bars = [
      bar(1, 100),
      bar(2, 100),
      bar(3, 80),
      bar(4, 85),
      bar(5, 100),
    ];
    const out = run(r, bars);
    expect(out[3]!.entry).toBe("BOLLINGER_RSI");
    expect(out[4]!.exit).toBe("BOLLINGER_RSI");
    expect(run(r, [...bars.slice(0, 3), bar(4, 110)])[3]).toEqual({
      entry: null,
      exit: "BOLLINGER_RSI",
    });
    expect(run(r, [...bars.slice(0, 3), bar(4, 85, 0)])[3]!.entry).toBeNull();
    expect(run(r, bars.slice(0, 4))).toEqual(out.slice(0, 4));
    expect(
      run(r, [...bars.slice(0, 3), bar(1, 85, 10, "2024-01-03")])[3]!.entry,
    ).toBeNull();
  });
});
