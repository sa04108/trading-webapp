import {
  cryptoBacktestInputSchema,
  type CryptoBacktestInput,
  type CryptoBacktestResult,
  type CryptoDailyBar,
} from "../../../shared/crypto-backtest.js";
import { isCalendarDate } from "../../../shared/schemas/rebalance-interval.js";

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateString = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export interface CryptoPortfolio {
  cash: number;
  holding: { market: string; quantity: number; lastClose: number } | null;
}

type BarIndex = Map<string, Map<number, CryptoDailyBar>>;

function indexBars(input: CryptoBacktestInput, bars: CryptoDailyBar[]): BarIndex {
  const markets = new Set(input.markets);
  const byMarket = new Map<string, Map<number, CryptoDailyBar>>();
  for (const bar of bars) {
    if (!markets.has(bar.market)) continue;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
      !isCalendarDate(bar.date) ||
      ![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isFinite(bar.turnover) ||
      bar.turnover < 0 ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close)
    ) {
      throw new Error(`잘못된 일봉 데이터: ${bar.market} ${bar.date}`);
    }
    const day = dayNumber(bar.date);
    let series = byMarket.get(bar.market);
    if (!series) {
      series = new Map();
      byMarket.set(bar.market, series);
    }
    if (series.has(day)) throw new Error(`중복 일봉 데이터: ${bar.market} ${bar.date}`);
    series.set(day, bar);
  }
  return byMarket;
}

function selectIndexed(
  input: CryptoBacktestInput,
  byMarket: BarIndex,
  sessionDay: number,
): {
  target: string | null;
  evaluated: boolean;
  incomplete: boolean;
} {
  const day = sessionDay - 1;
  const candidates: { market: string; turnover: number; close: number }[] = [];
  let incomplete = false;
  for (const market of input.markets) {
    const series = byMarket.get(market);
    const current = series?.get(day);
    if (!series || !current) {
      incomplete = true;
      continue;
    }
    let turnover = 0;
    let complete = true;
    for (let offset = 0; offset < 30; offset++) {
      const bar = series.get(day - offset);
      if (!bar) {
        complete = false;
        break;
      }
      turnover += bar.turnover / 30;
    }
    if (complete) candidates.push({ market, turnover, close: current.close });
    else incomplete = true;
  }
  candidates.sort((a, b) => b.turnover - a.turnover || a.market.localeCompare(b.market));
  const eligible: { market: string; momentum: number }[] = [];
  let evaluated = false;
  for (const candidate of candidates.slice(0, input.universeSize)) {
    const previous = byMarket.get(candidate.market)?.get(day - input.lookbackDays);
    if (!previous) {
      incomplete = true;
      continue;
    }
    evaluated = true;
    const momentum = candidate.close / previous.close - 1;
    if (momentum > 0) eligible.push({ market: candidate.market, momentum });
  }
  eligible.sort((a, b) => b.momentum - a.momentum || a.market.localeCompare(b.market));
  return { target: eligible[0]?.market ?? null, evaluated, incomplete };
}

export function selectCryptoTarget(
  input: CryptoBacktestInput,
  bars: CryptoDailyBar[],
  sessionDate: string,
): {
  target: string | null;
  evaluated: boolean;
  incomplete: boolean;
} {
  if (!isCalendarDate(sessionDate)) throw new Error("판단 날짜가 올바르지 않습니다");
  return selectIndexed(input, indexBars(input, bars), dayNumber(sessionDate));
}

export function executeCryptoOpen(
  input: CryptoBacktestInput,
  portfolio: CryptoPortfolio,
  target: string | null,
  prices: ReadonlyMap<string, number>,
  date: string,
): {
  portfolio: CryptoPortfolio;
  trades: CryptoBacktestResult["trades"];
  minimumBuy: boolean;
  minimumSell: boolean;
} {
  if (!isCalendarDate(date)) throw new Error("체결 날짜가 올바르지 않습니다");
  for (const price of prices.values()) {
    if (!Number.isFinite(price) || price <= 0) throw new Error("체결 가격이 올바르지 않습니다");
  }
  let cash = portfolio.cash;
  let holding = portfolio.holding ? { ...portfolio.holding } : null;
  const trades: CryptoBacktestResult["trades"] = [];
  let minimumBuy = false,
    minimumSell = false;
  const feeRate = input.feeBps / 10_000;
  const slipRate = input.slippageBps / 10_000;
  const heldPrice = holding && prices.get(holding.market);
  if (holding && target !== holding.market && heldPrice !== undefined && heldPrice !== null) {
    const price = heldPrice * (1 - slipRate);
    if (holding.quantity * price >= 5000) {
      const fee = holding.quantity * price * feeRate;
      cash += holding.quantity * price - fee;
      trades.push({ date, market: holding.market, side: "SELL", quantity: holding.quantity, price, fee });
      holding = null;
    } else minimumSell = true;
  }
  const targetPrice = target ? prices.get(target) : undefined;
  if (!holding && target && targetPrice !== undefined) {
    const price = targetPrice * (1 + slipRate);
    if (cash / (1 + feeRate) >= 5000) {
      const quantity = cash / (price * (1 + feeRate));
      const fee = quantity * price * feeRate;
      trades.push({ date, market: target, side: "BUY", quantity, price, fee });
      holding = { market: target, quantity, lastClose: price };
      cash = 0;
    } else minimumBuy = true;
  }
  return { portfolio: { cash, holding }, trades, minimumBuy, minimumSell };
}

export function executeCryptoSession(
  input: CryptoBacktestInput,
  portfolio: CryptoPortfolio,
  decision: { target: string | null; evaluated: boolean },
  prices: ReadonlyMap<string, number>,
  date: string,
): {
  portfolio: CryptoPortfolio;
  trades: CryptoBacktestResult["trades"];
  minimumBuy: boolean;
  minimumSell: boolean;
  skipped: "INSUFFICIENT_HISTORY" | "MISSING_PRICE" | null;
} {
  const unchanged = (skipped: "INSUFFICIENT_HISTORY" | "MISSING_PRICE") => ({
    portfolio: { cash: portfolio.cash, holding: portfolio.holding ? { ...portfolio.holding } : null },
    trades: [],
    minimumBuy: false,
    minimumSell: false,
    skipped,
  });
  if (!decision.evaluated) return unchanged("INSUFFICIENT_HISTORY");
  if (
    portfolio.holding?.market !== decision.target &&
    ((portfolio.holding && !prices.has(portfolio.holding.market)) ||
      (decision.target && !prices.has(decision.target)))
  )
    return unchanged("MISSING_PRICE");
  return { ...executeCryptoOpen(input, portfolio, decision.target, prices, date), skipped: null };
}

export function runCryptoBacktest(
  rawInput: CryptoBacktestInput,
  bars: CryptoDailyBar[],
): CryptoBacktestResult {
  const input = cryptoBacktestInputSchema.parse(rawInput);
  const byMarket = indexBars(input, bars);
  const start = dayNumber(input.startDate);
  const end = dayNumber(input.endDate);
  if (![...byMarket.values()].some((series) => [...series.keys()].some((day) => day >= start && day <= end)))
    throw new Error("백테스트 기간의 일봉 데이터가 없습니다");

  const trades: CryptoBacktestResult["trades"] = [];
  const equityCurve: CryptoBacktestResult["equityCurve"] = [];
  const missingValuations = new Map<string, number>();
  let portfolio: CryptoPortfolio = { cash: input.initialCash, holding: null };
  let peak = input.initialCash;
  let maxDrawdown = 0;
  let evaluatedSignals = 0;
  let incompleteHistoryDays = 0;
  let minimumBuyDays = 0;
  let minimumSellDays = 0;
  let missingPriceDays = 0;

  for (let day = start; day <= end; day++) {
    const date = dateString(day);
    const signal = selectIndexed(input, byMarket, day);
    if (signal.evaluated) evaluatedSignals++;
    if (signal.incomplete) incompleteHistoryDays++;
    const prices = new Map<string, number>();
    for (const market of input.markets) {
      const bar = byMarket.get(market)?.get(day);
      if (bar) prices.set(market, bar.open);
    }
    const execution = executeCryptoSession(input, portfolio, signal, prices, date);
    if (execution.skipped === "MISSING_PRICE") missingPriceDays++;
    portfolio = execution.portfolio;
    trades.push(...execution.trades);
    if (execution.minimumBuy) minimumBuyDays++;
    if (execution.minimumSell) minimumSellDays++;
    if (portfolio.holding) {
      const bar = byMarket.get(portfolio.holding.market)?.get(day);
      if (bar) portfolio.holding.lastClose = bar.close;
      else
        missingValuations.set(
          portfolio.holding.market,
          (missingValuations.get(portfolio.holding.market) ?? 0) + 1,
        );
    }
    const equity =
      portfolio.cash + (portfolio.holding ? portfolio.holding.quantity * portfolio.holding.lastClose : 0);
    equityCurve.push({ date, equity });
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  if (evaluatedSignals === 0) throw new Error("거래대금 및 모멘텀 판단에 필요한 일봉 이력이 부족합니다");
  const finalEquity = equityCurve.at(-1)!.equity;
  const warnings = [...missingValuations].map(
    ([market, count]) => `${market}: 일봉이 없는 ${count}일은 마지막 종가로 평가했습니다`,
  );
  if (incompleteHistoryDays)
    warnings.push(`판단 이력이 부족한 ${incompleteHistoryDays}일은 일부 마켓을 평가하지 못했습니다`);
  if (missingPriceDays) warnings.push(`필요한 시가가 없는 ${missingPriceDays}일은 매매하지 못했습니다`);
  if (minimumBuyDays) warnings.push(`최소 주문금액 5,000원 미만으로 ${minimumBuyDays}일 매수하지 못했습니다`);
  if (minimumSellDays)
    warnings.push(`최소 주문금액 5,000원 미만으로 ${minimumSellDays}일 매도하지 못했습니다`);
  return {
    equityCurve,
    trades,
    totalReturn: finalEquity / input.initialCash - 1,
    maxDrawdown,
    finalEquity,
    warnings,
  };
}
