import { MINUTE_MS, type IntradayBar, type IntradayGap, type IntradayTimeframe } from "../../../../shared/schemas/intraday.js";

export const OPEN = 9 * 60;
export const CLOSE = 15 * 60 + 20;
export function minuteOfDay(ms: number): number {
  return (((ms / MINUTE_MS + 540) % 1440) + 1440) % 1440;
}
export function isIntradaySessionBar(bar: IntradayBar): boolean {
  const minute = minuteOfDay(bar.endMs);
  return minute > OPEN && minute <= CLOSE;
}

/** 봉 종료 시각을 유지한다. 누락된 1분봉이 있는 구간은 집계 봉을 만들지 않는다. */
export function aggregateIntradayBars(
  input: readonly IntradayBar[],
  timeframe: IntradayTimeframe,
): IntradayBar[] {
  const minutes = Number.parseInt(timeframe, 10);
  const bars = input
    .filter(isIntradaySessionBar)
    .sort((a, b) => a.endMs - b.endMs);
  if (minutes === 1) return bars;
  const groups = new Map<number, IntradayBar[]>();
  for (const bar of bars) {
    const elapsed = minuteOfDay(bar.endMs) - OPEN;
    const end =
      bar.endMs +
      (Math.ceil(elapsed / minutes) * minutes - elapsed) * MINUTE_MS;
    // 종가 단일가 구간과 이어지는 짧은 마지막 봉은 초기 전략 입력에서 제외한다.
    if (minuteOfDay(end) > CLOSE) continue;
    const group = groups.get(end) ?? [];
    group.push(bar);
    groups.set(end, group);
  }
  const result: IntradayBar[] = [];
  for (const [endMs, group] of groups) {
    if (
      group.length !== minutes ||
      group.some((b, i) => b.endMs !== endMs - (minutes - 1 - i) * MINUTE_MS)
    )
      continue;
    result.push({
      endMs,
      open: group[0]!.open,
      close: group.at(-1)!.close,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      volume: group.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

/** 무거래·정지인지 확인할 수 없는 빈 분은 정상 봉으로 간주하지 않는다. */
export function intradayGaps(
  input: readonly IntradayBar[],
  dates: readonly string[],
): IntradayGap[] {
  const times = new Set(input.map((b) => b.endMs));
  const gaps: IntradayGap[] = [];
  for (const date of dates) {
    const start = Date.parse(`${date}T09:00:00+09:00`);
    let gap: IntradayGap | null = null;
    for (let i = 1; i <= CLOSE - OPEN; i++) {
      const end = start + i * MINUTE_MS;
      if (!times.has(end)) {
        if (!gap) {
          gap = { fromMs: end - MINUTE_MS, toMs: end, missingMinutes: 1 };
          gaps.push(gap);
        } else {
          gap.toMs = end;
          gap.missingMinutes++;
        }
      } else gap = null;
    }
  }
  return gaps;
}
