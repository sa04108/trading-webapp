import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import { addMonths, delistingsThrough, parseAccountStopPct, quarterWindows, rebalanceDates, withQuarterRisk } from '../../scripts/quarter-research/quarter-engine.js';

describe('3개월 연구의 기간과 실현 목표', () => {
  it('월말과 윤년을 포함해 3개월을 달력으로 계산한다', () => {
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30');
    expect(addMonths('2023-11-30', 3)).toBe('2024-02-29');
    expect(addMonths('2026-09-08', 3)).toBe('2026-12-08');
  });

  it('평가 구간 밖으로 끝나는 창을 미리 제외한다', () => {
    const days = ['2023-09-01', '2023-09-04', '2023-10-02', '2023-11-01', '2023-11-30', '2023-12-01', '2024-01-02'];
    const windows = quarterWindows(days, '2023-01-01', '2023-12-31');
    expect(windows.map((w) => [w.start, w.end])).toEqual([['2023-09-01', '2023-11-30']]);
  });

  it('중단 기준을 생략하면 10%를 유지하고 잘못된 값은 거부한다', () => {
    expect(parseAccountStopPct()).toBe(10);
    expect(parseAccountStopPct(15)).toBe(15);
    expect(parseAccountStopPct(20)).toBe(20);
    for (const value of [null, '20', 0, -1, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseAccountStopPct(value)).toThrow('계좌 낙폭 중단');
    }
  });

  it('휴일을 만들지 않고 순위 선정 일정만 옮긴다', () => {
    const days = ['2026-05-04', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-11', '2026-05-12'];
    expect(rebalanceDates(days, 3)).toEqual([days[0], days[3]]);
    expect(rebalanceDates(days, 3, 1)).toEqual([days[1], days[4]]);
    expect(rebalanceDates(days, 3, 2)).toEqual([days[2], days[5]]);
    expect(days.at(-1)).toBe('2026-05-12');
    for (const offset of [null, '1', -1, .5, 3, Number.NaN]) {
      expect(() => rebalanceDates(days, 3, offset)).toThrow('순위 선정 이동');
    }
    expect(() => rebalanceDates(days.slice(0, 2), 20, 2)).toThrow('거래일이 없습니다');
    expect(() => rebalanceDates(days, 0)).toThrow('회전 주기');
  });

  it('옮긴 최초 신호 이전에는 주문이 없고 다음 실제 시가에 체결한다', () => {
    const dates = ['2026-05-04', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-11'];
    const ts = dates.map((d) => Date.parse(d));
    const candles: Candle[] = ts.map((tsMs) => ({ symbol: 'A', tsMs, market: 'KR', venue: 'KOSPI', timeframe: '1d',
      open: 100, high: 100, low: 100, close: 100, volume: 100000 }));
    const strategy: AnyTradingStrategy = { id: 'shift-fixture', version: '1', name: '일정 검증', description: '일정 이전 주문 차단',
      parameterSchema: z.object({}), initialize: () => ({}), onBars: (c) => ({ orders: c.isRebalanceBar ? [{ symbol: 'A', side: 'BUY', quantity: 1 }] : [] }) };
    const result = runBacktest(strategy, { candles, initialCash: 10000, parameters: {}, maxPositions: 1, randomSeed: 204,
      tradeFromTsMs: ts[0]!, resultPeriod: { fromTsMs: ts[0]!, toTsMs: ts.at(-1)! }, marketTradingTsMs: ts,
      universeSchedule: rebalanceDates(dates, 20, 2).map((d) => ({ fromTsMs: Date.parse(d), symbols: ['A'] })),
      execution: { cost: { id: 'test', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
        slippage: { id: 'test', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.tsMs).toBe(ts[3]);
    expect(result.equityPoints.at(-1)?.tsMs).toBe(ts.at(-1));
  });

  const buyer: AnyTradingStrategy = {
    id: 'quarter-fixture', version: '1', name: '분기 검증', description: '다음 시가 체결 확인',
    parameterSchema: z.object({}), initialize: () => ({}),
    onBars: (context) => ({ orders: context.portfolio.positions.size === 0
      ? [{ symbol: 'A', side: 'BUY', quantity: 90 }] : [] }),
  };

  function run(prices: [number, number][], stopPct = 10) {
    const days = prices.map((_, i) => Date.UTC(2026, 0, 5 + i));
    const candles: Candle[] = prices.map(([open, close], i) => ({
      symbol: 'A', market: 'KR', venue: 'KOSPI', timeframe: '1d', tsMs: days[i]!,
      open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1_000_000,
    }));
    const risk = withQuarterRisk(buyer, { initialCash: 10_000, tradeFromTsMs: days[0]!,
      lastSignalTsMs: days.at(-2)!, targetPct: 10.5, stopPct });
    const result = runBacktest(risk.strategy, { candles, parameters: {}, initialCash: 10_000, maxPositions: 1,
      randomSeed: 1, tradeFromTsMs: days[0]!, marketTradingTsMs: days,
      execution: { cost: { id: 'test', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
        slippage: { id: 'test', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } },
    });
    return { result, events: risk.events, days };
  }

  it('평가액이 목표를 넘어도 다음 시가 하락으로 실현 수익은 10% 미만일 수 있다', () => {
    const { result, events, days } = run([[100, 100], [100, 115], [105, 105], [120, 120], [120, 120]]);
    expect(events[0]?.reason).toBe('계좌 목표 청산');
    expect(result.trades[0]?.exitTsMs).toBe(days[2]);
    expect(result.metrics.totalReturnPct).toBeCloseTo(4.5);
    expect(result.openPositions).toHaveLength(0);
    expect(result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
  });

  it('미래 폐지 사건 때문에 마지막 미청산 포지션의 성과 기간이 늘어나지 않는다', () => {
    const start = Date.parse('2026-09-07');
    const end = Date.parse('2026-09-08');
    const candles: Candle[] = [start, end].map((tsMs) => ({ symbol: 'A', tsMs,
      market: 'KR', venue: 'KOSPI', timeframe: '1d', open: 100, high: 100,
      low: 100, close: 100, volume: 1_000_000 }));
    const input = { candles, parameters: {}, initialCash: 10_000, maxPositions: 1,
      randomSeed: 1, tradeFromTsMs: start, resultPeriod: { fromTsMs: start, toTsMs: end },
      marketTradingTsMs: [start, end],
      execution: { cost: { id: 'test', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
        slippage: { id: 'test', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } };
    const delisted = { A: [end + 86_400_000] };
    expect(() => runBacktest(buyer, { ...input, delistedTsMsBySymbol: new Map(Object.entries(delisted)) }))
      .toThrow('결과 자산곡선이 resultPeriod 종료보다 늦게 끝났습니다');
    const result = runBacktest(buyer, { ...input, delistedTsMsBySymbol: delistingsThrough(delisted, end) });
    expect(result.openPositions).toHaveLength(1);
    expect(result.trades).toHaveLength(0);
    expect(result.equityPoints.at(-1)?.tsMs).toBe(end);
  });

  it('완화한 중단 기준은 같은 하락 경로의 청산 시점을 바꾼다', () => {
    const prices: [number, number][] = [[100, 100], [100, 105], [100, 90], [88, 90], [150, 150], [150, 150]];
    const tight = run(prices, parseAccountStopPct());
    const loose = run(prices, parseAccountStopPct(20));
    expect(tight.events[0]?.reason).toBe('계좌 낙폭 중단');
    expect(loose.events[0]?.reason).toBe('계좌 목표 청산');
    expect(loose.result.trades[0]?.exitTsMs).toBe(loose.days[5]);
    expect(loose.result.metrics.totalReturnPct).toBeCloseTo(45);
    expect(loose.result.openPositions).toHaveLength(0);
  });

  it('낙폭 중단 이후 반등해도 같은 계좌에서 재진입하지 않는다', () => {
    const { result, events } = run([[100, 100], [100, 105], [100, 90], [88, 90], [150, 150], [150, 150]]);
    expect(events[0]?.reason).toBe('계좌 낙폭 중단');
    expect(result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(result.metrics.totalReturnPct).toBeCloseTo(-10.8);
    expect(result.openPositions).toHaveLength(0);
  });
});
