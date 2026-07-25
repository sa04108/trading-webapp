import { describe, expect, it } from 'vitest';
import { parseCandleCsv } from '../../src/server/modules/market-data/application/csv-parser.js';

const META = { market: 'KR' as const, timeframe: '1h' as const, symbol: '005930' };

describe('parseCandleCsv', () => {
  it('parses ISO timestamps and epoch milliseconds', () => {
    const csv = [
      'timestamp,open,high,low,close,volume',
      '2026-07-06T00:00:00Z,100,110,90,105,1000',
      '1751767200000,105,115,95,110,2000',
    ].join('\n');

    const result = parseCandleCsv(csv, META);
    expect(result.errors).toEqual([]);
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]!.tsMs).toBe(Date.UTC(2026, 6, 6, 0, 0));
    expect(result.candles[1]!.tsMs).toBe(1751767200000);
    expect(result.candles[0]!.symbol).toBe('005930');
  });

  it('fails on missing required columns', () => {
    const csv = 'time,open,high,low,close\n1,2,3,4,5';
    const result = parseCandleCsv(csv, META);
    expect(result.candles).toHaveLength(0);
    expect(result.errors[0]).toContain('필수 컬럼 누락');
  });

  it('skips invalid rows and reports errors', () => {
    const csv = [
      'timestamp,open,high,low,close,volume',
      '2026-07-06T00:00:00Z,100,110,90,105,1000',
      'not-a-date,100,110,90,105,1000',
      '2026-07-06T01:00:00Z,100,90,110,105,1000', // high < low
    ].join('\n');

    const result = parseCandleCsv(csv, META);
    expect(result.candles).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
  });
});
