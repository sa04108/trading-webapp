import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rebalanceDates, withQuarterRisk, type QuarterRisk } from '../../scripts/quarter-research/quarter-engine.js';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import { crossSectionalMomentumStrategy } from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';

const buyer: AnyTradingStrategy = {
  id: 'retry-fixture', version: '1', name: '재개 검증', description: '전량 매도 뒤 실제 수익과 재개 확인',
  parameterSchema: z.object({}), initialize: () => ({}),
  onBars: (c) => ({ orders: c.portfolio.positions.size === 0 ? [{ symbol: 'A', side: 'BUY', quantity: 90 }] : [] }),
};
const execution = {
  cost: { id: 'test', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'test', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1, maxVolumeParticipationRate: .01 },
};

function simulate(prices: [number, number][], options: Partial<QuarterRisk> = {}, volumes: number[] = [], sellTaxRate = 0) {
  const days = prices.map((_, i) => Date.UTC(2026, 0, 5 + i));
  const candles: Candle[] = prices.map(([open, close], i) => ({ symbol: 'A', tsMs: days[i]!, market: 'KR', venue: 'KOSPI',
    timeframe: '1d', open, close, high: Math.max(open, close), low: Math.min(open, close), volume: volumes[i] ?? 1_000_000 }));
  const wrapper = withQuarterRisk(buyer, { initialCash: 10_000, tradeFromTsMs: days[0]!, lastSignalTsMs: days.at(-2)!,
    targetPct: 10.5, stopPct: 15, resumeAfterMissedTarget: true, ...options });
  const result = runBacktest(wrapper.strategy, { candles, parameters: {}, initialCash: 10_000, maxPositions: 1, randomSeed: 1,
    tradeFromTsMs: days[0]!, resultPeriod: { fromTsMs: days[0]!, toTsMs: days.at(-1)! }, marketTradingTsMs: days,
    execution: { ...execution, cost: { ...execution.cost, sellTaxRate } } });
  return { result, events: wrapper.events, days };
}

describe('실제 목표 미달 청산 뒤 재개', () => {
  it('매도 갭으로 목표에 못 미치면 다음 시가부터 재진입해 다시 목표를 청산한다', () => {
    const { result, events, days } = simulate([[100, 100], [100, 115], [105, 105], [105, 115], [115, 115], [115, 115], [115, 115]]);
    expect(result.fills.filter((f) => f.side === 'BUY').map((f) => f.tsMs)).toEqual([days[1], days[3]]);
    expect(events.map((e) => e.reason)).toEqual(['계좌 목표 청산', '실제 목표 미달 후 재개', '계좌 목표 청산']);
    expect(events[1]?.equity).toBe(10450);
    expect(result.metrics.totalReturnPct).toBeCloseTo(13.5);
    expect(result.openPositions).toHaveLength(0);
  });

  it('생략과 false는 기존 영구 중단 결과를 그대로 유지한다', () => {
    const prices: [number, number][] = [[100, 100], [100, 115], [105, 105], [105, 115], [115, 115], [115, 115]];
    const omitted = simulate(prices, { resumeAfterMissedTarget: undefined });
    const disabled = simulate(prices, { resumeAfterMissedTarget: false });
    expect(disabled.result).toEqual(omitted.result);
    expect(disabled.events).toEqual(omitted.events);
    expect(disabled.result.metrics.totalReturnPct).toBeCloseTo(4.5);
    expect(disabled.result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
  });

  it('실제 비용까지 뺀 청산 수익으로 재개 여부를 결정한다', () => {
    const prices: [number, number][] = [[100, 100], [100, 115], [112, 112], [112, 112], [112, 112], [112, 112]];
    const gross = simulate(prices);
    const net = simulate(prices, {}, [], .01);
    expect(gross.result.metrics.totalReturnPct).toBeCloseTo(10.8);
    expect(gross.events.map((e) => e.reason)).toEqual(['계좌 목표 청산']);
    expect(gross.result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(net.events[1]?.reason).toBe('실제 목표 미달 후 재개');
    expect(net.events[1]?.equity).toBeCloseTo(10979.2);
  });

  it('부분 청산 중에는 대기하고 전량 매도한 봉의 다음 시가부터 매수한다', () => {
    const { result, events, days } = simulate([[100, 100], [100, 115], [105, 105], [105, 105], [105, 105], [105, 105], [105, 105], [105, 105]],
      {}, [9000, 3000, 3000, 3000, 10000]);
    expect(result.fills.filter((f) => f.reason === '계좌 목표 청산').map((f) => [f.tsMs, f.quantity])).toEqual([
      [days[2], 30], [days[3], 30], [days[4], 30],
    ]);
    expect(events[1]?.date).toBe('2026-01-09');
    expect(result.fills.filter((f) => f.side === 'BUY').map((f) => f.tsMs)).toEqual([days[1], days[5]]);
    expect(result.openPositions).toHaveLength(0);
  });

  it('재개 후에도 이전 최고점을 유지하여 원래 낙폭 한도에서 중단한다', () => {
    const { result, events } = simulate([[100, 100], [100, 115], [100, 100], [100, 95], [90, 90], [150, 150], [150, 150]]);
    expect(events.map((e) => e.reason)).toEqual(['계좌 목표 청산', '실제 목표 미달 후 재개', '계좌 낙폭 중단']);
    expect(events[2]?.equity).toBe(9550);
    expect(result.fills.filter((f) => f.side === 'BUY')).toHaveLength(2);
    expect(result.metrics.totalReturnPct).toBeCloseTo(-9);
  });

  it('목표 청산 체결 때 이미 낙폭 한도를 넘으면 재개를 차단한다', () => {
    const { result, events } = simulate([[100, 100], [100, 115], [90, 90], [150, 150], [150, 150], [150, 150]]);
    expect(events.map((e) => e.reason)).toEqual(['계좌 목표 청산', '계좌 낙폭 중단']);
    expect(result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(result.metrics.totalReturnPct).toBeCloseTo(-9);
  });

  it('낙폭 중단 뒤 반등하거나 목표 청산이 만기 신호일에 끝나도 재개하지 않는다', () => {
    const stop = simulate([[100, 100], [100, 80], [90, 90], [150, 150], [150, 150], [150, 150]]);
    expect(stop.events.map((e) => e.reason)).toEqual(['계좌 낙폭 중단']);
    expect(stop.result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    const expiry = simulate([[100, 100], [100, 115], [105, 105], [150, 150]]);
    expect(expiry.events.map((e) => e.reason)).toEqual(['계좌 목표 청산', '3개월 만기 청산']);
    expect(expiry.result.fills.filter((f) => f.side === 'BUY')).toHaveLength(1);
    expect(expiry.result.equityPoints.at(-1)?.tsMs).toBe(expiry.days.at(-1));
  });

  it('재개 설정의 잘못된 자료형과 실제 목표보다 낮은 청산 목표를 거부한다', () => {
    expect(() => simulate([[100, 100], [100, 100]], { resumeAfterMissedTarget: 'true' as unknown as boolean })).toThrow('불리언');
    expect(() => simulate([[100, 100], [100, 100]], { targetPct: 9 })).toThrow('실제 수익 목표');
  });

  it('실제 모멘텀 전략은 재개 후에도 원래 회전일과 다음 봉 매수 단계를 따른다', () => {
    const start = Date.UTC(2026, 0, 5);
    const days = Array.from({ length: 10 }, (_, i) => start + i * 86400000);
    const prices = Array.from({ length: 21 }, (_, i) => 79 + i).concat([100, 100, 115, 105, 105, 105, 105, 105, 105, 105]);
    const candles: Candle[] = prices.map((close, i) => ({ symbol: 'A', tsMs: start + (i - 21) * 86400000,
      market: 'KR', venue: 'KOSPI', timeframe: '1d', open: i === 23 ? 100 : close, close,
      high: close, low: i === 23 ? 100 : close, volume: 1_000_000 }));
    const wrapper = withQuarterRisk(crossSectionalMomentumStrategy as AnyTradingStrategy, { initialCash: 10000,
      tradeFromTsMs: start, lastSignalTsMs: days.at(-2)!, targetPct: 10.5, stopPct: 15, resumeAfterMissedTarget: true });
    const result = runBacktest(wrapper.strategy, { candles, parameters: { formationDays: 20, skipDays: 0, topN: 1, absoluteMomentumFilter: true },
      initialCash: 10000, maxPositions: 1, randomSeed: 204, tradeFromTsMs: start, marketTradingTsMs: days,
      resultPeriod: { fromTsMs: start, toTsMs: days.at(-1)! }, execution,
      universeSchedule: rebalanceDates(days.map((ts) => new Date(ts).toISOString().slice(0, 10)), 4)
        .map((date) => ({ fromTsMs: Date.parse(date), symbols: ['A'] })) });
    expect(wrapper.events.map((e) => e.reason)).toEqual(['계좌 목표 청산', '실제 목표 미달 후 재개', '3개월 만기 청산']);
    expect(result.fills.filter((f) => f.side === 'BUY').map((f) => f.tsMs)).toEqual([days[2], days[6]]);
    expect(result.openPositions).toHaveLength(0);
    expect(result.equityPoints.at(-1)?.tsMs).toBe(days.at(-1));
  });
});
