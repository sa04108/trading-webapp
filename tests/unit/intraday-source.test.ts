import { describe, expect, it, vi } from "vitest";
import { TossIntradaySource } from "../../src/server/modules/intraday/infrastructure/toss-intraday-source.js";

const stamp = (minute: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const row = (minute: number) => ({
  timestamp: stamp(minute),
  openPrice: "100",
  highPrice: "110",
  lowPrice: "90",
  closePrice: "105",
  volume: "12",
  currency: "KRW",
});

describe("토스 분봉", () => {
  it("종료 시각과 중복 페이지를 보존하고 미확정 시간을 제외한다", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: { candles: [row(4), row(3)], nextBefore: stamp(3) },
      })
      .mockResolvedValueOnce({
        result: { candles: [row(3), row(2)] },
      });
    const source = new TossIntradaySource({ request }, () =>
      Date.parse(stamp(5)),
    );
    const bars = await source.fetch(
      "005930",
      Date.parse(stamp(1)),
      Date.parse(stamp(5)),
    );
    expect(bars.map((bar) => bar.endMs)).toEqual(
      [2, 3, 4].map((n) => Date.parse(stamp(n))),
    );
    const query = new URL(request.mock.calls[0]![1], "https://example.test")
      .searchParams;
    expect(Object.fromEntries(query)).toEqual({
      symbol: "005930",
      interval: "1m",
      count: "200",
      adjusted: "false",
      before: stamp(4),
    });
  });
  it("진행하지 않는 커서와 잘못된 봉을 거부한다", async () => {
    const request = vi.fn().mockResolvedValue({
      result: { candles: [row(3)], nextBefore: stamp(3) },
    });
    const source = new TossIntradaySource({ request }, () =>
      Date.parse(stamp(5)),
    );
    await expect(
      source.fetch("005930", Date.parse(stamp(1)), Date.parse(stamp(4))),
    ).rejects.toThrow(/진행/);
    request.mockReset().mockResolvedValue({
      result: {
        candles: [{ ...row(3), timestamp: "2026-01-01T00:03:01Z" }],
        nextBefore: null,
      },
    });
    await expect(
      source.fetch("005930", Date.parse(stamp(1)), Date.parse(stamp(4))),
    ).rejects.toThrow();
    request
      .mockReset()
      .mockResolvedValue({
        result: {
          candles: [{ ...row(3), volume: "12.000000000000000001" }],
          nextBefore: null,
        },
      });
    await expect(
      source.fetch("005930", Date.parse(stamp(1)), Date.parse(stamp(4))),
    ).rejects.toThrow("숫자");
  });
});
