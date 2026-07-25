import { describe, expect, it } from 'vitest';
import { aggregateToHourly } from '../../src/server/modules/market-data/domain/aggregate.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { KR_SESSION } from '../../src/server/modules/market-data/domain/exchange-session.js';

/** KST 09:00 = UTC 00:00 (KST = UTC+9) */
const MONDAY_0900_KST_UTC = Date.UTC(2026, 6, 6, 0, 0); // 2026-07-06(월) 09:00 KST

function minuteCandle(offsetMinutes: number, overrides: Partial<Candle> = {}): Candle {
  return {
    symbol: '005930',
    market: 'KR',
    timeframe: '1m',
    tsMs: MONDAY_0900_KST_UTC + offsetMinutes * 60_000,
    open: 100 + offsetMinutes,
    high: 105 + offsetMinutes,
    low: 95 + offsetMinutes,
    close: 102 + offsetMinutes,
    volume: 10,
    ...overrides,
  };
}

describe('aggregateToHourly (스펙 §13 세션 경계 집계)', () => {
  it('aggregates a full KR session day into 7 hourly bars (last bar 30min)', () => {
    // 09:00 ~ 15:29 = 390 분봉
    const minutes = Array.from({ length: 390 }, (_, i) => minuteCandle(i));
    const hourly = aggregateToHourly(minutes, KR_SESSION);

    expect(hourly).toHaveLength(7); // 09,10,11,12,13,14,15시 (15시 봉은 30분)
    const first = hourly[0]!;
    expect(first.tsMs).toBe(MONDAY_0900_KST_UTC);
    expect(first.open).toBe(100); // 첫 분봉 open
    expect(first.close).toBe(102 + 59); // 09:59 분봉 close
    expect(first.high).toBe(105 + 59); // max high
    expect(first.low).toBe(95); // min low
    expect(first.volume).toBe(600); // 60개 × 10

    const last = hourly[6]!;
    expect(last.tsMs).toBe(MONDAY_0900_KST_UTC + 360 * 60_000); // 15:00 KST
    expect(last.volume).toBe(300); // 30개 × 10 (15:00~15:29)
  });

  it('drops out-of-session and weekend candles', () => {
    const preMarket = minuteCandle(-1); // 08:59 KST
    const postMarket = minuteCandle(391); // 15:31 KST
    const sunday = minuteCandle(0, { tsMs: MONDAY_0900_KST_UTC - 24 * 3600_000 }); // 일요일 09:00
    const valid = minuteCandle(0);

    const hourly = aggregateToHourly([preMarket, postMarket, sunday, valid], KR_SESSION);
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.tsMs).toBe(MONDAY_0900_KST_UTC);
    expect(hourly[0]!.volume).toBe(10);
  });

  it('deduplicates same-timestamp minute bars (last wins)', () => {
    const original = minuteCandle(0, { close: 100, volume: 10 });
    const revised = minuteCandle(0, { close: 200, high: 300, volume: 99 });
    const hourly = aggregateToHourly([original, revised], KR_SESSION);
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.close).toBe(200);
    expect(hourly[0]!.volume).toBe(99);
  });

  it('separates buckets per symbol', () => {
    const a = minuteCandle(0, { symbol: 'AAA' });
    const b = minuteCandle(0, { symbol: 'BBB' });
    const hourly = aggregateToHourly([a, b], KR_SESSION);
    expect(hourly.map((c) => c.symbol)).toEqual(['AAA', 'BBB']);
  });
});
