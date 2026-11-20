import { describe, expect, it } from "vitest";
import { cryptoBacktestInputSchema, type CryptoDailyBar } from "../../src/shared/crypto-backtest.js";
import {
  executeCryptoSession,
  runCryptoBacktest,
  selectCryptoTarget,
  type CryptoPortfolio,
} from "../../src/runtime/modules/crypto/backtest.js";

const input = {
  markets: ["KRW-BTC", "KRW-ETH"],
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  initialCash: 10000,
  universeSize: 1,
  lookbackDays: 1,
  feeBps: 100,
  slippageBps: 100,
};
function bars(market: string, turnover: number): CryptoDailyBar[] {
  return Array.from({ length: 33 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const price = i === 30 ? 110 : i >= 31 ? 120 : 100;
    return { market, date, open: price, high: price, low: price, close: price, turnover };
  });
}

describe("원화 일봉 백테스트", () => {
  it("완료된 30일 거래대금으로 종목을 고르고 다음 날 시가에 비용을 반영한다", () => {
    const result = runCryptoBacktest(input, [...bars("KRW-BTC", 200), ...bars("KRW-ETH", 100)]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      date: "2026-02-01",
      market: "KRW-BTC",
      side: "BUY",
      price: 121.2,
    });
    expect(result.trades[0]!.quantity).toBeCloseTo(10000 / (121.2 * 1.01), 10);
    expect(result.trades[0]!.fee).toBeCloseTo(10000 / 101, 10);
    expect(result.finalEquity).toBeCloseTo(10000 / (1.01 * 1.01), 8);
    expect(result.totalReturn).toBeCloseTo(1 / (1.01 * 1.01) - 1, 10);
    expect(result.maxDrawdown).toBeCloseTo(1 - 1 / (1.01 * 1.01), 10);
  });

  it("결손된 보유 종목을 마지막 종가로 평가한다", () => {
    const btc = bars("KRW-BTC", 200).filter((bar) => bar.date !== "2026-02-02");
    const result = runCryptoBacktest(input, [...btc, ...bars("KRW-ETH", 100)]);
    expect(result.trades.map(({ date, side }) => [date, side])).toEqual([["2026-02-01", "BUY"]]);
    expect(result.warnings).toEqual(["KRW-BTC: 일봉이 없는 1일은 마지막 종가로 평가했습니다"]);
    expect(result.equityCurve[1]!.equity).toBeCloseTo(result.equityCurve[0]!.equity, 10);
  });

  it("다음 세션에 시가가 없는 매수 신호를 이후 세션으로 이월하지 않는다", () => {
    const btc = bars("KRW-BTC", 200).filter((bar) => bar.date !== "2026-02-01");
    const result = runCryptoBacktest(input, [...btc, ...bars("KRW-ETH", 100)]);
    expect(result.trades.map(({ date, market, side }) => [date, market, side])).toEqual([
      ["2026-02-02", "KRW-ETH", "BUY"],
    ]);
  });

  it("판단할 수 있는 이력이 전혀 없으면 0% 성과 대신 오류를 반환한다", () => {
    const periodOnly = bars("KRW-BTC", 200).filter((bar) => bar.date >= input.startDate);
    expect(() => runCryptoBacktest({ ...input, markets: ["KRW-BTC"] }, periodOnly)).toThrow(
      "이력이 부족합니다",
    );
  });

  it("거래대금 상위 종목의 모멘텀 이력이 없어도 하위 종목으로 대체하지 않는다", () => {
    const reference = (market: string, price: number): CryptoDailyBar => ({
      market,
      date: "2025-12-31",
      open: price,
      high: price,
      low: price,
      close: price,
      turnover: 100,
    });
    const result = runCryptoBacktest(
      {
        ...input,
        markets: ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
        endDate: "2026-02-01",
        universeSize: 2,
        lookbackDays: 31,
      },
      [
        ...bars("KRW-BTC", 300),
        ...bars("KRW-ETH", 200),
        ...bars("KRW-SOL", 100),
        reference("KRW-ETH", 130),
        reference("KRW-SOL", 50),
      ],
    );
    expect(result.trades).toEqual([]);
    expect(result.warnings).toContain("판단 이력이 부족한 1일은 일부 마켓을 평가하지 못했습니다");
  });

  it("최소 주문금액 미만의 매수와 매도를 체결하지 않는다", () => {
    const small = runCryptoBacktest({ ...input, initialCash: 5000, endDate: "2026-02-01" }, [
      ...bars("KRW-BTC", 200),
      ...bars("KRW-ETH", 100),
    ]);
    expect(small.trades).toEqual([]);
    expect(small.finalEquity).toBe(5000);
    expect(small.warnings).toContain("최소 주문금액 5,000원 미만으로 1일 매수하지 못했습니다");

    const btc = bars("KRW-BTC", 200).map((bar) =>
      bar.date === "2026-02-01"
        ? { ...bar, close: 100, low: 100 }
        : bar.date === "2026-02-02"
          ? { ...bar, open: 40, high: 40, low: 40, close: 40 }
          : bar,
    );
    const result = runCryptoBacktest({ ...input, markets: ["KRW-BTC"], feeBps: 0, slippageBps: 0 }, btc);
    expect(result.trades.map(({ side }) => side)).toEqual(["BUY"]);
    expect(result.finalEquity).toBeCloseTo(10000 / 3, 8);
    expect(result.warnings).toContain("최소 주문금액 5,000원 미만으로 1일 매도하지 못했습니다");
  });

  it("일별 공통 판단·체결이 비용, 교체, 결손 세션을 포함한 전체 백테스트와 일치한다", () => {
    const btc = [
      ...bars("KRW-BTC", 200),
      ...["2026-02-03", "2026-02-04"].map((date) => ({
        market: "KRW-BTC",
        date,
        open: 120,
        high: 120,
        low: 120,
        close: 120,
        turnover: 200,
      })),
    ];
    const eth = [
      ...bars("KRW-ETH", 100),
      { market: "KRW-ETH", date: "2026-02-04", open: 180, high: 180, low: 180, close: 180, turnover: 100 },
    ].map((bar) =>
      bar.date === "2026-02-01"
        ? { ...bar, open: 160, high: 160, low: 160, close: 160 }
        : bar.date === "2026-02-02"
          ? { ...bar, open: 180, high: 180, low: 180, close: 180 }
          : bar,
    );
    const all = [...btc, ...eth];
    const request = { ...input, endDate: "2026-02-04", universeSize: 2 };
    let portfolio: CryptoPortfolio = { cash: request.initialCash, holding: null };
    const trades = [];
    const curve = [];
    for (const date of ["2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04"]) {
      const selection = selectCryptoTarget(request, all, date);
      const prices = new Map(all.filter((bar) => bar.date === date).map((bar) => [bar.market, bar.open]));
      const original = structuredClone(portfolio);
      const execution = executeCryptoSession(request, portfolio, selection, prices, date);
      expect(portfolio).toEqual(original);
      portfolio = execution.portfolio;
      trades.push(...execution.trades);
      if (portfolio.holding) {
        const closing = all.find((bar) => bar.market === portfolio.holding!.market && bar.date === date);
        if (closing) portfolio.holding.lastClose = closing.close;
      }
      curve.push({
        date,
        equity:
          portfolio.cash + (portfolio.holding ? portfolio.holding.quantity * portfolio.holding.lastClose : 0),
      });
    }
    const result = runCryptoBacktest(request, all);
    expect(trades.map(({ date, market, side }) => [date, market, side])).toEqual([
      ["2026-02-01", "KRW-BTC", "BUY"],
      ["2026-02-02", "KRW-BTC", "SELL"],
      ["2026-02-02", "KRW-ETH", "BUY"],
      ["2026-02-04", "KRW-ETH", "SELL"],
    ]);
    expect(result.trades).toEqual(trades);
    expect(result.equityCurve).toEqual(curve);
  });

  it("보유 중 판단 이력이 없거나 교체 대상 시가가 없으면 기존 보유를 유지한다", () => {
    const btc = bars("KRW-BTC", 200).filter((bar) => bar.date !== "2026-02-02");
    btc.push({
      market: "KRW-BTC",
      date: "2026-02-03",
      open: 120,
      high: 120,
      low: 120,
      close: 120,
      turnover: 200,
    });
    const noHistory = runCryptoBacktest({ ...input, markets: ["KRW-BTC"], endDate: "2026-02-03" }, btc);
    expect(noHistory.trades.map(({ date, side }) => [date, side])).toEqual([["2026-02-01", "BUY"]]);
    expect(noHistory.warnings).toContain("판단 이력이 부족한 1일은 일부 마켓을 평가하지 못했습니다");

    const other = bars("KRW-ETH", 100)
      .filter((bar) => bar.date !== "2026-02-02")
      .map((bar) =>
        bar.date === "2026-02-01" ? { ...bar, open: 160, high: 160, low: 160, close: 160 } : bar,
      );
    const rotation = runCryptoBacktest({ ...input, universeSize: 2 }, [...bars("KRW-BTC", 200), ...other]);
    expect(rotation.trades.map(({ date, market, side }) => [date, market, side])).toEqual([
      ["2026-02-01", "KRW-BTC", "BUY"],
    ]);
    expect(rotation.warnings).toContain("필요한 시가가 없는 1일은 매매하지 못했습니다");
    const portfolio = { cash: 0, holding: { market: "KRW-BTC", quantity: 100, lastClose: 120 } };
    const result = executeCryptoSession(
      input,
      portfolio,
      { target: "KRW-ETH", evaluated: true },
      new Map([["KRW-BTC", 120]]),
      "2026-02-02",
    );
    expect(result).toEqual({
      portfolio,
      trades: [],
      minimumBuy: false,
      minimumSell: false,
      skipped: "MISSING_PRICE",
    });
    expect(
      executeCryptoSession(
        input,
        portfolio,
        { target: null, evaluated: false },
        new Map([["KRW-BTC", 120]]),
        "2026-02-02",
      ),
    ).toEqual({
      portfolio,
      trades: [],
      minimumBuy: false,
      minimumSell: false,
      skipped: "INSUFFICIENT_HISTORY",
    });
  });

  it("기간 데이터 부재와 잘못된 요청을 거부한다", () => {
    expect(() => runCryptoBacktest(input, [])).toThrow("일봉 데이터가 없습니다");
    expect(cryptoBacktestInputSchema.safeParse({ ...input, markets: ["USD-BTC"] }).success).toBe(false);
    expect(cryptoBacktestInputSchema.safeParse({ ...input, startDate: "2026-02-30" }).success).toBe(false);
  });
});
