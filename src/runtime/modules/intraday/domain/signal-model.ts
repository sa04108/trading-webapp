import {
  intradayDate,
  type IntradayBar,
  type IntradayRequest,
  type IntradaySignal,
} from "../../../../shared/schemas/intraday.js";
import { intradaySession } from "../../../../shared/intraday-session.js";

type Decision = {
  entry: IntradaySignal["reason"] | null;
  exit: IntradaySignal["reason"] | null;
};
const none = (): Decision => ({ entry: null, exit: null });

/** 확정된 분봉과 신호 봉만 사용하며 모든 지표는 거래일마다 초기화한다. */
export function createIntradaySignalModel(request: IntradayRequest) {
  let day = "";
  let count = 0,
    fast = 0,
    slow = 0,
    previousDifference: number | null = null;
  let rangeHigh = -Infinity,
    rangeLow = Infinity,
    openingVolume = 0,
    openingCount = 0,
    fired = false;
  let previousClose: number | null = null,
    previousVwap: number | null = null;
  let weightedPrice = 0,
    totalVolume = 0,
    trend = 0;
  let volumes: number[] = [],
    closes: number[] = [];
  let previousLower: number | null = null,
    previousRsi: number | null = null;
  let gains = 0,
    losses = 0,
    changes = 0;
  const reset = () => {
    count = 0;
    fast = 0;
    slow = 0;
    previousDifference = null;
    rangeHigh = -Infinity;
    rangeLow = Infinity;
    openingVolume = 0;
    openingCount = 0;
    fired = false;
    previousClose = null;
    previousVwap = null;
    weightedPrice = 0;
    totalVolume = 0;
    trend = 0;
    volumes = [];
    closes = [];
    previousLower = null;
    previousRsi = null;
    gains = 0;
    losses = 0;
    changes = 0;
  };
  return {
    onMinute(bar: IntradayBar, signalBar?: IntradayBar): Decision {
      const nextDay = intradayDate(bar.endMs);
      if (nextDay !== day) {
        reset();
        day = nextDay;
      }
      const elapsed =
        ((((bar.endMs / 60_000 + 540) % 1440) + 1440) % 1440) - intradaySession(nextDay).openMinute;
      if (
        request.strategyId === "intraday-orb" &&
        elapsed <= request.parameters.openingMinutes
      ) {
        rangeHigh = Math.max(rangeHigh, bar.high);
        rangeLow = Math.min(rangeLow, bar.low);
        openingVolume += bar.volume;
        openingCount++;
        if (
          elapsed === request.parameters.openingMinutes &&
          previousClose === null
        )
          previousClose = bar.close;
      }
      if (request.strategyId === "intraday-vwap-reclaim") {
        // 분봉의 대표 가격으로 체결 가격을 근사한다.
        weightedPrice += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
        totalVolume += bar.volume;
      }
      if (!signalBar) return none();
      const close = signalBar.close;
      count++;
      if (request.strategyId === "intraday-ema") {
        const { fast: fastPeriod, slow: slowPeriod } = request.parameters;
        fast =
          count === 1 ? close : fast + (2 / (fastPeriod + 1)) * (close - fast);
        slow =
          count === 1 ? close : slow + (2 / (slowPeriod + 1)) * (close - slow);
        const difference = fast - slow;
        const entry =
          count >= slowPeriod &&
          previousDifference !== null &&
          previousDifference <= 0 &&
          difference > 0
            ? "EMA"
            : null;
        const exit = count >= slowPeriod && difference < 0 ? "EMA" : null;
        previousDifference = difference;
        return { entry, exit };
      }
      if (request.strategyId === "intraday-orb") {
        const {
          openingMinutes,
          entryWindowMinutes,
          breakoutBps,
          volumeMultiplier,
        } = request.parameters;
        const threshold = rangeHigh * (1 + breakoutBps / 10_000);
        const eligible =
          elapsed > openingMinutes && openingCount === openingMinutes;
        const entry =
          eligible &&
          elapsed <= entryWindowMinutes &&
          !fired &&
          previousClose !== null &&
          previousClose <= threshold &&
          close > threshold &&
          signalBar.volume > 0 &&
          signalBar.volume >=
            (openingVolume / openingCount) *
              Number.parseInt(request.timeframe, 10) *
              volumeMultiplier
            ? "ORB"
            : null;
        const exit =
          eligible && close < (rangeHigh + rangeLow) / 2 ? "ORB" : null;
        if (entry) fired = true;
        previousClose = close;
        return { entry, exit };
      }
      if (request.strategyId === "intraday-vwap-reclaim") {
        const { trendPeriod, volumePeriod, volumeMultiplier } =
          request.parameters;
        const previousTrend = trend;
        trend =
          count === 1
            ? close
            : trend + (2 / (trendPeriod + 1)) * (close - trend);
        const vwap = totalVolume > 0 ? weightedPrice / totalVolume : null;
        const meanVolume =
          volumes.reduce((sum, value) => sum + value, 0) / volumePeriod;
        const entry =
          count >= trendPeriod &&
          volumes.length === volumePeriod &&
          previousClose !== null &&
          previousVwap !== null &&
          vwap !== null &&
          previousClose <= previousVwap &&
          close > vwap &&
          close > trend &&
          trend > previousTrend &&
          signalBar.volume > 0 &&
          signalBar.volume >= meanVolume * volumeMultiplier
            ? "VWAP"
            : null;
        const exit = vwap !== null && close < vwap ? "VWAP" : null;
        volumes.push(signalBar.volume);
        if (volumes.length > volumePeriod) volumes.shift();
        previousClose = close;
        previousVwap = vwap;
        return { entry, exit };
      }
      const { bandPeriod, bandStdDev, rsiPeriod, oversold } =
        request.parameters;
      if (previousClose !== null) {
        const change = close - previousClose;
        const gain = Math.max(change, 0),
          loss = Math.max(-change, 0);
        changes++;
        if (changes <= rsiPeriod) {
          gains += gain;
          losses += loss;
        } else {
          gains = (gains * (rsiPeriod - 1) + gain) / rsiPeriod;
          losses = (losses * (rsiPeriod - 1) + loss) / rsiPeriod;
        }
        if (changes === rsiPeriod) {
          gains /= rsiPeriod;
          losses /= rsiPeriod;
        }
      }
      const rsi =
        changes < rsiPeriod
          ? null
          : gains === 0 && losses === 0
            ? 50
            : losses === 0
              ? 100
              : 100 - 100 / (1 + gains / losses);
      closes.push(close);
      if (closes.length > bandPeriod) closes.shift();
      const middle =
        closes.length === bandPeriod
          ? closes.reduce((sum, value) => sum + value, 0) / bandPeriod
          : null;
      const lower =
        middle === null
          ? null
          : middle -
            bandStdDev *
              Math.sqrt(
                closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) /
                  bandPeriod,
              );
      const entry =
        signalBar.volume > 0 &&
        previousClose !== null &&
        previousLower !== null &&
        previousRsi !== null &&
        lower !== null &&
        middle !== null &&
        close < middle &&
        rsi !== null &&
        previousClose <= previousLower &&
        previousRsi <= oversold &&
        close > lower &&
        rsi > previousRsi
          ? "BOLLINGER_RSI"
          : null;
      const exit = middle !== null && close >= middle ? "BOLLINGER_RSI" : null;
      previousClose = close;
      previousLower = lower;
      previousRsi = rsi;
      return { entry, exit };
    },
  };
}
