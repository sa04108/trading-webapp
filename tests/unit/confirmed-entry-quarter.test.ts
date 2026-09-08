import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { AnyTradingStrategy, StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import { recoveryStreaks, withConfirmedEntry } from '../../scripts/quarter-research/confirmed-entry.js';
import { withQuarterRisk, type MacroPoint } from '../../scripts/quarter-research/quarter-engine.js';

describe('연속 확인 대기와 원래 계좌 만기', () => {
  const start = Date.parse('2026-09-07');
  const points: MacroPoint[] = Array.from({ length: 5 }, (_, i) => ({ date: `2026-09-${7 + i}`, tsMs: start + i * 86_400_000,
    kospi: 110, kospiSma20: 100, kospiSma60: 100, kospiSma120: 100, kospiRet20: .1, kospiRet60: -.1,
    kospiRet120: .1, kospiVol20: .4, kospiDrawdown60: -.2, kosdaqRet60: .1, breadth60: .5,
    vix: 15, oilRet20: 0, fxRet20: 0, rate: 3, rateChange60: 0 }));
  const candles: Candle[] = points.map((m) => ({ symbol: 'A', tsMs: m.tsMs, market: 'KR', venue: 'KOSPI',
    timeframe: '1d', open: 100, high: 100, low: 100, close: 100, volume: 10000 }));
  const buyer: AnyTradingStrategy = { id: 'confirmation-fixture', version: '1', name: '확인 대기 검증', description: '원래 만기 유지',
    parameterSchema: z.object({}), initialize: () => ({}),
    onBars: (context) => ({ orders: context.isRebalanceBar ? [{ symbol: 'A', side: 'BUY', quantity: 50 }] : [] }) };
  const context: StrategyBarContext = { tsMs: start, isRebalanceBar: false, bars: new Map([['A', candles[0]!]]), getHistory: () => candles,
    portfolio: { cash: 10000, equity: 10000, positions: new Map() }, rng: () => .5, fundamentals: () => null,
    corporateActions: () => [], selectionMetric: () => null, tradableSymbols: new Set(['A']), activeUniverseSymbols: new Set(['A']) };

  it('연속 일수는 이탈일에 초기화하고 미래 가격은 앞선 결과를 바꾸지 않는다', () => {
    const changed = points.map((p, i) => i === 2 ? { ...p, kospiRet20: -.01 } : p);
    expect([...recoveryStreaks(changed, .3).values()]).toEqual([1, 2, 0, 1, 2]);
    const prefix = recoveryStreaks(changed.slice(0, 2), .3);
    expect(recoveryStreaks(changed, .3).get(points[1]!.tsMs)).toBe(prefix.get(points[1]!.tsMs));
  });

  it('원래 시작일보다 앞서 활성화하지 않고 확인 첫날에만 최초 순위를 정한다', () => {
    const wrapped = withConfirmedEntry(buyer, points, points[2]!.tsMs, 2);
    expect(wrapped.strategy.onBars({ ...context, tsMs: points[1]!.tsMs }, {}, {}).orders).toEqual([]);
    expect(wrapped.strategy.onBars({ ...context, tsMs: points[2]!.tsMs }, {}, {}).orders).toHaveLength(1);
    expect(wrapped.strategy.onBars({ ...context, tsMs: points[3]!.tsMs }, {}, {}).orders).toEqual([]);
    expect(wrapped.audit()).toEqual({ date: '2026-09-09', streak: 3 });
  });

  it('늦게 활성화돼도 원래 만기 청산 신호를 뒤로 미루지 않는다', () => {
    const confirmed = withConfirmedEntry(buyer, points, start, 4);
    const risk = withQuarterRisk(confirmed.strategy, { initialCash: 10000, tradeFromTsMs: start,
      lastSignalTsMs: points[3]!.tsMs, targetPct: 10.5, stopPct: 10 });
    const result = runBacktest(risk.strategy, { candles, parameters: {}, initialCash: 10000, maxPositions: 1,
      randomSeed: 204, tradeFromTsMs: start, resultPeriod: { fromTsMs: start, toTsMs: points[4]!.tsMs },
      marketTradingTsMs: points.map((p) => p.tsMs), execution: {
        cost: { id: 'test', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
        slippage: { id: 'test', version: '1', bps: 0, fixed: 0 }, rules: { tickSize: 0, minOrderQty: 1 } } });
    expect(confirmed.audit()?.date).toBe('2026-09-10');
    expect(risk.events[0]?.reason).toBe('3개월 만기 청산');
    expect(result.fills).toEqual([]);
    expect(result.equityPoints.at(-1)?.tsMs).toBe(points[4]!.tsMs);
  });
});
