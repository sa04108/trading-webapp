import { describe, expect, it, vi } from "vitest";
import { EcosRateSource } from "../../src/server/modules/market-data/infrastructure/ecos/ecos-rate-source.js";

const request = { statCode: "817Y002", itemCode: "010502000", startDate: "2020-01-01", endDate: "2024-12-31" };
const row = (date: string, value: string = "3.25") => ({ STAT_CODE: request.statCode, ITEM_CODE1: request.itemCode, TIME: date, DATA_VALUE: value });
const response = (rows: unknown[], total = rows.length) => new Response(JSON.stringify({ StatisticSearch: { list_total_count: total, row: rows } }));

describe("ECOS 일별 금리 조회", () => {
  it("1000개 단위로 읽어 날짜순으로 반환한다", async () => {
    const dates = Array.from({ length: 1001 }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10).replaceAll("-", ""));
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(dates.slice(0, 1000).reverse().map((date) => row(date)), 1001))
      .mockResolvedValueOnce(response([row(dates[1000]!)], 1001));
    const rates = await new EcosRateSource({ apiKey: "secret", fetchImpl }).fetchDailyRates(request);
    expect(rates).toHaveLength(1001);
    expect(rates[0]).toEqual({ date: "2020-01-01", annualRatePct: 3.25 });
    expect(rates[1000]!.date).toBe("2022-09-27");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/json/kr/1/1000/817Y002/D/20200101/20241231/010502000"),
      expect.stringContaining("/json/kr/1001/2000/817Y002/D/20200101/20241231/010502000"),
    ]);
  });

  it.each([
    ["빈 값", response([row("20200101", " ")])],
    ["중복 날짜", response([row("20200101"), row("20200101")])],
    ["다른 항목", response([{ ...row("20200101"), ITEM_CODE1: "wrong" }])],
    ["다른 통계표", response([{ ...row("20200101"), STAT_CODE: "wrong" }])],
    ["범위 밖 날짜", response([row("20250101")])],
    ["잘못된 날짜", response([row("20200230")])],
    ["빈 결과", response([], 0)],
    ["API 오류", new Response(JSON.stringify({ RESULT: { CODE: "INFO-200", MESSAGE: "secret" } }))],
    ["누락 행", response([row("20200101")], 2)],
    ["비정상 금리", response([row("20200101", "Infinity")])],
  ])("%s 응답을 거절한다", async (_label, result) => {
    const source = new EcosRateSource({ apiKey: "secret", fetchImpl: vi.fn().mockResolvedValue(result) });
    await expect(source.fetchDailyRates(request)).rejects.toThrow();
  });

  it("네트워크 오류와 공급자 오류에서 인증키와 URL을 노출하지 않는다", async () => {
    const source = new EcosRateSource({ apiKey: "sensitive-key", fetchImpl: vi.fn().mockRejectedValue(new Error("https://ecos.bok.or.kr/api/sensitive-key")) });
    await expect(source.fetchDailyRates(request)).rejects.toThrow("ECOS 금리 조회에 실패했습니다");
    await expect(source.fetchDailyRates(request)).rejects.not.toThrow(/sensitive-key|https:/);
  });
});
