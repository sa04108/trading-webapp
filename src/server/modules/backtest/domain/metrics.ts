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
  let drawdownStartTs: number | null = null;
  let maxDrawdown = 0;
  let maxDuration = 0;

  for (const point of equityPoints) {
    if (point.equity >= peak) {
      if (drawdownStartTs !== null) {
        maxDuration = Math.max(maxDuration, point.tsMs - drawdownStartTs);
        drawdownStartTs = null;
      }
      peak = point.equity;
      peakTs = point.tsMs;
    } else if (peak > 0) {
      // 고점과 같거나 더 높은 point 사이의 평탄·상승 구간은 drawdown이 아니다.
      // 실제로 고점 아래로 내려온 첫 순간에만 직전 고점부터 기간을 열어 둔다.
      if (drawdownStartTs === null) drawdownStartTs = peakTs;
      maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
    }
  }
  const last = equityPoints[equityPoints.length - 1];
  if (last && drawdownStartTs !== null) {
    maxDuration = Math.max(maxDuration, last.tsMs - drawdownStartTs);
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
  const lastByMonth = new Map<
    string,
    { year: number; month: number; equity: number; tsMs: number }
  >();
  for (const point of equityPoints) {
    const date = new Date(point.tsMs);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    const previous = lastByMonth.get(key);
    if (previous === undefined || point.tsMs >= previous.tsMs) {
      lastByMonth.set(key, { year, month, equity: point.equity, tsMs: point.tsMs });
    }
  }
  const months = [...lastByMonth.values()].sort((a, b) =>
    a.year === b.year ? a.month - b.month : a.year - b.year,
  );
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return [];

  const result: MonthlyReturn[] = [];
  let previous = initialCash;
  let year = first.year;
  let month = first.month;
  while (year < last.year || (year === last.year && month <= last.month)) {
    const entry = lastByMonth.get(`${year}-${month}`);
    // 요청 기간 anchor 사이에 실제 관측점이 없는 달은 직전 월말 평가액을 이월한다.
    // 행 자체를 빼면 범주형 월 차트에서 긴 데이터 공백이 정상적인 연속 월처럼 보인다.
    const equity = entry?.equity ?? previous;
    result.push({
      year,
      month,
      returnPct: previous > 0 ? (equity / previous - 1) * 100 : 0,
    });
    previous = equity;
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return result;
}

export function computeMetrics(
  equityPoints: readonly EquityPoint[],
  trades: readonly Trade[],
  fills: readonly Fill[],
  initialCash: number,
  maxConcurrentPositions: number,
  /**
   * 변동성·Sharpe·Sortino를 계산할 실제 시장 관측점. 요청 기간 경계를 표현하려고
   * 합성한 현금/평가 anchor는 CAGR·MDD에는 필요하지만, 이를 0% 거래일 표본으로
   * 세면 긴 데이터 공백일수록 위험지표가 인위적으로 좋아진다.
   */
  dailyReturnEquityPoints: readonly EquityPoint[] = equityPoints,
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

  const daily = dailyReturns(dailyReturnEquityPoints, initialCash);
  const dailyStd = std(daily);
  const volatilityPct = daily.length >= 2 ? dailyStd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100 : null;
  const sharpe =
    daily.length >= 2 && dailyStd > 0
      ? (mean(daily) / dailyStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : null;
  // Sortino의 downside deviation은 음수 표본끼리의 표준편차가 아니라,
  // 전체 관측일에서 목표수익률(0)을 밑돈 편차의 제곱평균제곱근이다.
  // 하락일이 한 번뿐이거나 같은 하락률이 반복돼도 위험이 0이 되지 않는다.
  const downsideDeviation = daily.length > 0
    ? Math.sqrt(mean(daily.map((value) => Math.min(value, 0) ** 2)))
    : 0;
  const sortino =
    daily.length >= 2 && downsideDeviation > 0
      ? (mean(daily) / downsideDeviation) * Math.sqrt(TRADING_DAYS_PER_YEAR)
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
