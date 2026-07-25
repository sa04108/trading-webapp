import type { Candle } from './candle.js';
import { normalizeCandles } from './candle.js';
import {
  fromLocalTime,
  hourlyBucketStarts,
  toLocalTime,
  type ExchangeSession,
} from './exchange-session.js';

/**
 * 1분봉 → 시간봉 집계 (스펙 §13):
 *   open = 첫 1분봉 open, high = max, low = min, close = 마지막 close, volume = 합.
 * 거래소 세션 경계 기준으로 bucket 을 나눈다. 단순 60분 Unix bucket 을 쓰지 않는다.
 * 세션 밖(시간외) 봉과 주말 봉은 버린다.
 */
export function aggregateToHourly(
  minuteCandles: readonly Candle[],
  session: ExchangeSession,
): Candle[] {
  const sorted = normalizeCandles(minuteCandles);
  const bucketStarts = hourlyBucketStarts(session);

  interface Bucket {
    tsMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    symbol: string;
    market: Candle['market'];
  }

  const buckets = new Map<string, Bucket>();

  for (const candle of sorted) {
    const local = toLocalTime(candle.tsMs, session);
    if (local.dayOfWeek === 0 || local.dayOfWeek === 6) continue;
    if (local.minuteOfDay < session.openMinutes || local.minuteOfDay >= session.closeMinutes) {
      continue;
    }

    // 이 분봉이 속하는 세션 기준 시간 bucket 의 시작 분
    let bucketStart = bucketStarts[0] ?? session.openMinutes;
    for (const start of bucketStarts) {
      if (local.minuteOfDay >= start) bucketStart = start;
      else break;
    }

    const bucketTsMs = fromLocalTime(local.dayIndex, bucketStart, session);
    const key = `${candle.symbol}:${bucketTsMs}`;
    const existing = buckets.get(key);

    if (!existing) {
      buckets.set(key, {
        tsMs: bucketTsMs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        symbol: candle.symbol,
        market: candle.market,
      });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close; // sorted 순회이므로 마지막 봉의 close
      existing.volume += candle.volume;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => (a.symbol === b.symbol ? a.tsMs - b.tsMs : a.symbol < b.symbol ? -1 : 1))
    .map((bucket) => ({
      symbol: bucket.symbol,
      market: bucket.market,
      timeframe: '1h' as const,
      tsMs: bucket.tsMs,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,
    }));
}
