import { describe, expect, it } from 'vitest';
import { RecentCandleHistory } from '../../src/runtime/modules/backtest/domain/recent-candle-history.js';
import type { Candle } from '../../src/runtime/modules/market-data/domain/candle.js';

function candle(index: number): Candle {
  return {
    symbol: '005930', market: 'KR', venue: index % 2 === 0 ? 'KOSPI' : 'KOSDAQ',
    timeframe: '1d', tsMs: Date.UTC(2026, 0, index + 1),
    open: 100 + index, high: 110 + index, low: 90 + index,
    close: 105 + index, volume: 1000 + index,
  };
}

describe('고정 길이 봉 이력', () => {
  it('배열 읽기 계약을 유지하면서 가장 최근 봉만 보존한다', () => {
    const history = new RecentCandleHistory('005930', 3);
    for (let index = 0; index < 5; index += 1) history.append(candle(index));

    const view = history.asArray();
    expect(Array.isArray(view)).toBe(true);
    expect(view.length).toBe(3);
    expect(view[0]).toEqual(candle(2));
    expect(view.at(-1)).toEqual(candle(4));
    expect([...view]).toEqual([candle(2), candle(3), candle(4)]);
    expect(view.slice(1)).toEqual([candle(3), candle(4)]);
    expect(JSON.parse(JSON.stringify(view))).toEqual([candle(2), candle(3), candle(4)]);
    expect(history.lastVolume()).toBe(1004);
  });

  it('다른 종목 봉과 잘못된 길이를 거부한다', () => {
    expect(() => new RecentCandleHistory('005930', 0)).toThrow(RangeError);
    const history = new RecentCandleHistory('005930', 1);
    expect(() => history.append({ ...candle(0), symbol: '000660' })).toThrow('종목 코드');
  });
});
