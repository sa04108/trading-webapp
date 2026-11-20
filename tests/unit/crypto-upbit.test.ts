import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchUpbitDailyBars,
  fetchUpbitQuotes,
  listUpbitKrwMarkets,
} from "../../src/server/modules/crypto/upbit.js";

function candle(date: string, market = "KRW-BTC") {
  return {
    market,
    candle_date_time_utc: `${date}T00:00:00`,
    opening_price: 10,
    high_price: 15,
    low_price: 8,
    trade_price: 12,
    candle_acc_trade_price: 120,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Upbit public daily data", () => {
  it("현재가가 생성된 시각과 마지막 실제 체결 시각을 구분한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response([
          {
            market: "KRW-BTC",
            trade_price: 120_000_000,
            timestamp: 1750000050000,
            trade_timestamp: 1750000000000,
          },
        ]),
      ),
    );
    const quotes = await fetchUpbitQuotes(["KRW-BTC"]);
    expect(quotes.get("KRW-BTC")).toEqual({ price: 120_000_000, atMs: 1750000000000 });
  });

  it("lists KRW markets with their Korean names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response([
          { market: "BTC-ETH", korean_name: "이더리움" },
          { market: "KRW-BTC", korean_name: "비트코인" },
        ]),
      ),
    );
    await expect(listUpbitKrwMarkets()).resolves.toEqual([{ market: "KRW-BTC", name: "비트코인" }]);
  });

  it("paginates backwards with exclusive UTC cursors and returns inclusive ordered bars", async () => {
    const dates = Array.from({ length: 200 }, (_, i) =>
      new Date(Date.UTC(2024, 6, 20 - i)).toISOString().slice(0, 10),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(dates.map((date) => candle(date))))
      .mockResolvedValueOnce(response([candle("2024-01-02"), candle("2024-01-01"), candle("2023-12-31")]));
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchUpbitDailyBars(["KRW-BTC"], "2024-01-01", "2024-07-20");
    expect(bars[0]).toEqual({
      market: "KRW-BTC",
      date: "2024-01-01",
      open: 10,
      high: 15,
      low: 8,
      close: 12,
      turnover: 120,
    });
    expect(bars.at(-1)?.date).toBe("2024-07-20");
    expect(bars.some((bar) => bar.date === "2023-12-31")).toBe(false);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("to")).toBe("2024-07-21T00:00:00.000Z");
    expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("to")).toBe(`${dates[199]}T00:00:00.000Z`);
  });

  it("excludes the current unclosed UTC day and accepts gaps", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fetchMock = vi.fn().mockResolvedValue(response([candle("2020-01-03"), candle("2020-01-01")]));
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchUpbitDailyBars(["KRW-BTC"], "2020-01-01", today);
    expect(bars.map((bar) => bar.date)).toEqual(["2020-01-01", "2020-01-03"]);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("to")).toBe(`${today}T00:00:00.000Z`);
    expect(await fetchUpbitDailyBars(["KRW-BTC"], today, today)).toEqual([]);
  });

  it("rejects invalid input and malformed provider data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([candle("2024-01-02"), candle("2024-01-02")]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchUpbitDailyBars(["KRW-BTC"], "2024-02-30", "2024-03-01")).rejects.toThrow(
      "유효하지 않은 UTC 날짜",
    );
    await expect(fetchUpbitDailyBars(["KRW-BTC"], "2024-01-01", "2024-01-03")).rejects.toThrow(
      "업비트 일봉 순서가 올바르지 않습니다",
    );
  });

  it("retries a transient response and honors cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({}, 429))
      .mockResolvedValueOnce(response([candle("2024-01-01")]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchUpbitDailyBars(["KRW-BTC"], "2024-01-01", "2024-01-01")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchUpbitDailyBars(["KRW-BTC"], "2024-01-01", "2024-01-01", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
