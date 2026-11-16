import { intradayDate, MINUTE_MS, type IntradayBar, type IntradayChartTimeframe } from "../../../../shared/schemas/intraday.js";
import { isIntradaySessionBar } from "../../../../runtime/modules/intraday/domain/engine.js";
import { intradaySession } from "../../../../shared/intraday-session.js";

/** 조회 범위에 실제로 저장된 봉만 합친다. 누락·진행 중인 구간을 가상의 거래로 채우지 않는다. */
export function aggregateChartBars(input: readonly IntradayBar[], timeframe: IntradayChartTimeframe): IntradayBar[] {
  const bars = input.filter(isIntradaySessionBar).sort((a, b) => a.endMs - b.endMs);
  if (timeframe === "1m") return bars;
  const groups = new Map<string, IntradayBar>();
  for (const bar of bars) {
    const date = intradayDate(bar.endMs);
    let key: string;
    if (timeframe === "1mo") key = date.slice(0, 7);
    else if (timeframe === "1w") {
      const day = Date.parse(`${date}T00:00:00Z`);
      const weekday = new Date(day).getUTCDay();
      key = new Date(day - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    } else if (timeframe === "1d") key = date;
    else {
      const minutes = timeframe === "1h" ? 60 : Number.parseInt(timeframe, 10);
      const open = Date.parse(`${date}T${intradaySession(date).openTime}:00+09:00`);
      key = `${date}:${Math.floor((bar.endMs - open - MINUTE_MS) / (minutes * MINUTE_MS))}`;
    }
    const previous = groups.get(key);
    if (!previous) groups.set(key, { ...bar });
    else {
      previous.endMs = bar.endMs;
      previous.high = Math.max(previous.high, bar.high);
      previous.low = Math.min(previous.low, bar.low);
      previous.close = bar.close;
      previous.volume += bar.volume;
    }
  }
  return [...groups.values()];
}
