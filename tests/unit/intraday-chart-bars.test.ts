import { describe, expect, it } from "vitest";
import { aggregateChartBars } from "../../src/server/modules/intraday/application/chart-bars.js";
import type { IntradayBar } from "../../src/shared/schemas/intraday.js";

const bar = (day: string, minute: number, price: number, volume: number): IntradayBar => ({
  endMs: Date.parse(`${day}T09:00:00+09:00`) + minute * 60_000,
  open: price, high: price + 20, low: price - 10, close: price + 5, volume,
});
describe("시세 전용 분봉 집계", () => {
  // 전략 집계 검사는 일·주·월 경계와 마지막 짧은 시간봉의 보존을 다루지 않는다.
  it("개장 기준 시간 구간을 나누고 누락을 채우지 않으며 마지막 짧은 봉도 보존한다", () => {
    const input = [bar("2026-11-12", 1, 100, 2), bar("2026-11-12", 10, 200, 3), bar("2026-11-12", 11, 300, 5), bar("2026-11-12", 380, 400, 7)];
    expect(aggregateChartBars(input, "10m")).toEqual([
      { endMs: input[1]!.endMs, open: 100, high: 220, low: 90, close: 205, volume: 5 }, input[2], input[3],
    ]);
    expect(aggregateChartBars(input, "1h")).toEqual([
      { endMs: input[2]!.endMs, open: 100, high: 320, low: 90, close: 305, volume: 10 }, input[3],
    ]);
    expect(aggregateChartBars(input, "1m")).toEqual(input);
  });
  it("서울 날짜·월요일 시작 주·월 경계에서 실제 OHLCV와 거래량을 보존한다", () => {
    const input = [bar("2026-10-30", 1, 100, 2), bar("2026-10-30", 380, 200, 3), bar("2026-11-02", 1, 300, 5), bar("2026-11-03", 380, 400, 7)];
    const daily = aggregateChartBars(input, "1d");
    expect(daily).toHaveLength(3);
    expect(daily[0]).toEqual({ endMs: input[1]!.endMs, open: 100, high: 220, low: 90, close: 205, volume: 5 });
    for (const timeframe of ["1w", "1mo"] as const) expect(aggregateChartBars(input, timeframe)).toEqual([
      daily[0], { endMs: input[3]!.endMs, open: 300, high: 420, low: 290, close: 405, volume: 12 },
    ]);
  });
});
