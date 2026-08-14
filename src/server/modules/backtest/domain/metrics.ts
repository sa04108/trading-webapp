import type {
  BacktestMetrics,
  DrawdownPoint,
  EquityPoint,
  Fill,
  MonthlyReturn,
  Trade,
} from './types.js';

const MS_PER_DAY = 86_400_000;
const TRADING_DAYS_PER_YEAR = 252;

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

export function computeDrawdownSeries(equityPoints: readonly EquityPoint[]): DrawdownPoint[] {
  let peak = -Infinity;
  return equityPoints.map((point) => {
    peak = Math.max(peak, point.equity);
    return { tsMs: point.tsMs, drawdown: peak > 0 ? point.equity / peak - 1 : 0 };
  });
}

interface DrawdownStats {
  maxDrawdownPct: number;
  maxDrawdownDurationMs: number;
}

/** 최대 낙폭과 낙폭 기간(peak → 회복 또는 마지막 시점) */
export function computeDrawdownStats(equityPoints: readonly EquityPoint[]): DrawdownStats {
  let peak = -Infinity;
  let peakTs = 0;
  let maxDrawdown = 0;
  let maxDuration = 0;

  for (const point of equityPoints) {
    if (point.equity >= peak) {
      if (peak > 0) maxDuration = Math.max(maxDuration, point.tsMs - peakTs);
      peak = point.equity;
      peakTs = point.tsMs;
    } else if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
    }
  }
  const last = equityPoints[equityPoints.length - 1];
  if (last && last.equity < peak) {
    maxDuration = Math.max(maxDuration, last.tsMs - peakTs);
  }

  return { maxDrawdownPct: maxDrawdown * 100, maxDrawdownDurationMs: maxDuration };
}

/** UTC 일 단위 마지막 equity 로 리샘플한 일별 수익률 (변동성·Sharpe·Sortino 용) */
function dailyReturns(equityPoints: readonly EquityPoint[], initialCash: number): number[] {
  const lastByDay = new Map<number, number>();
  for (const point of equityPoints) {
    lastByDay.set(Math.floor(point.tsMs / MS_PER_DAY), point.equity);
  }
  const days = [...lastByDay.keys()].sort((a, b) => a - b);
  const returns: number[] = [];
  let previous = initialCash;
  for (const day of days) {
    const equity = lastByDay.get(day) as number;
    if (previous > 0) returns.push(equity / previous - 1);
    previous = equity;
  }
  return returns;
}

export function computeMonthlyReturns(
  equityPoints: readonly EquityPoint[],
  initialCash: number,
): MonthlyReturn[] {
  const lastByMonth = new Map<string, { year: number; month: number; equity: number }>();
  for (const point of equityPoints) {
    const date = new Date(point.tsMs);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    lastByMonth.set(`${year}-${month}`, { year, month, equity: point.equity });
  }
  const months = [...lastByMonth.values()].sort((a, b) =>
    a.year === b.year ? a.month - b.month : a.year - b.year,
  );
  const result: MonthlyReturn[] = [];
  let previous = initialCash;
  for (const entry of months) {
    result.push({
      year: entry.year,
      month: entry.month,
      returnPct: previous > 0 ? (entry.equity / previous - 1) * 100 : 0,
    });
    previous = entry.equity;
  }
  return result;
}

export function computeMetrics(
  equityPoints: readonly EquityPoint[],
  trades: readonly Trade[],
  fills: readonly Fill[],
  initialCash: number,
  maxConcurrentPositions: number,
): BacktestMetrics {
  const finalEquity = equityPoints[equityPoints.length - 1]?.equity ?? initialCash;
  const totalReturnPct = (finalEquity / initialCash - 1) * 100;

  const firstTs = equityPoints[0]?.tsMs ?? 0;
  const lastTs = equityPoints[equityPoints.length - 1]?.tsMs ?? 0;
  const elapsedDays = (lastTs - firstTs) / MS_PER_DAY;
  const cagrPct =
    elapsedDays >= 1 && finalEquity > 0
      ? ((finalEquity / initialCash) ** (365 / elapsedDays) - 1) * 100
      : null;

  const { maxDrawdownPct, maxDrawdownDurationMs } = computeDrawdownStats(equityPoints);

  const daily = dailyReturns(equityPoints, initialCash);
  const dailyStd = std(daily);
  const volatilityPct = daily.length >= 2 ? dailyStd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100 : null;
  const sharpe =
    daily.length >= 2 && dailyStd > 0
      ? (mean(daily) / dailyStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : null;
  const downside = daily.filter((r) => r < 0);
  const downsideStd = std(downside);
  const sortino =
    daily.length >= 2 && downsideStd > 0
      ? (mean(daily) / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : null;
  const calmar =
    cagrPct !== null && maxDrawdownPct < 0 ? cagrPct / Math.abs(maxDrawdownPct) : null;

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnl, 0));

  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let winStreak = 0;
  let lossStreak = 0;
  for (const trade of trades) {
    if (trade.netPnl > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else {
      lossStreak += 1;
      winStreak = 0;
    }
    maxConsecutiveWins = Math.max(maxConsecutiveWins, winStreak);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, lossStreak);
  }

  return {
    initialCash,
    finalEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    maxDrawdownDurationMs,
    volatilityPct,
    sharpe,
    sortino,
    calmar,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    tradeCount: trades.length,
    avgHoldingTimeMs:
      trades.length > 0 ? mean(trades.map((t) => t.holdingTimeMs)) : null,
    maxConcurrentPositions,
    totalCommission: fills.reduce((sum, f) => sum + f.commission, 0),
    totalTax: fills.reduce((sum, f) => sum + f.tax, 0),
    totalSlippage: fills.reduce((sum, f) => sum + f.slippageCost, 0),
  };
}
