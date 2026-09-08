import { describe, expect, it } from 'vitest';
import { rankRetentionMomentum, rankRetentionParameters } from '../../scripts/quarter-research/rank-retention-momentum.js';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { Position } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import { crossSectionalMomentumStrategy } from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';

const start = Date.UTC(2026, 0, 5);
const symbols = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
const parameters = rankRetentionParameters.parse({ formationDays: 20, skipDays: 0, topN: 5, retentionRank: 10 });
const candle = (symbol: string, i: number, close: number): Candle => ({ symbol, market: 'KR', timeframe: '1d',
  tsMs: start + i * 86400000, open: close, high: close, low: close, close, volume: 1_000_000 });

function context(held: string[] = []): StrategyBarContext {
  const histories = new Map(symbols.map((symbol, rank) => [symbol,
    Array.from({ length: 21 }, (_, i) => candle(symbol, i, 100 + i * (12 - rank)))]));
  const positions = new Map<string, Position>(held.map((symbol) => [symbol,
    { symbol, quantity: 1, avgEntryPrice: 100, entryCosts: 0, entryTsMs: start }]));
  return { tsMs: start + 20 * 86400000, isRebalanceBar: true,
    bars: new Map(symbols.map((symbol) => [symbol, histories.get(symbol)!.at(-1)!])),
    getHistory: (symbol) => histories.get(symbol) ?? [], portfolio: { cash: 10000, equity: 10000, positions },
    rng: createRng(204), fundamentals: () => null, corporateActions: () => [],
    tradableSymbols: new Set(symbols), activeUniverseSymbols: new Set(symbols), selectionMetric: () => null };
}

const initialize = () => rankRetentionMomentum.initialize({ symbols, initialCash: 10000, rng: createRng(204) });

describe('보유 순위 완충 모멘텀', () => {
  it('현금 시작에서는 상위 다섯 종목을 고르고 다음 봉에 매수를 판단한다', () => {
    const state = initialize();
    expect(rankRetentionMomentum.onBars(context(), state, parameters).orders).toEqual([]);
    expect(state.pendingTargets).toEqual(symbols.slice(0, 5));
    const buys = rankRetentionMomentum.onBars({ ...context(), isRebalanceBar: false }, state, parameters).orders;
    expect(buys.map((o) => [o.symbol, o.side])).toEqual(symbols.slice(0, 5).map((s) => [s, 'BUY']));
    expect(state.pendingTargets).toBeNull();
  });

  it('10위 보유는 유지하고 11위는 매도하며 빈 자리만 상위 순위로 채운다', () => {
    const state = initialize();
    const decision = rankRetentionMomentum.onBars(context(['S06', 'S10', 'S11']), state, parameters);
    expect(state.pendingTargets).toEqual(['S01', 'S02', 'S03', 'S06', 'S10']);
    expect(decision.orders).toEqual([{ symbol: 'S11', side: 'SELL', quantity: 1, reason: 'REBALANCE_EXIT' }]);
  });

  it('종목군 탈락·음수 모멘텀·이력 부족 보유를 유지하지 않는다', () => {
    const state = initialize();
    const c = context(['S01', 'S02', 'S03']);
    const decision = rankRetentionMomentum.onBars({ ...c,
      tradableSymbols: new Set(symbols.filter((s) => s !== 'S01')),
      getHistory: (s) => s === 'S02' ? Array.from({ length: 21 }, (_, i) => candle(s, i, 100 - i))
        : s === 'S03' ? c.getHistory(s).slice(-20) : c.getHistory(s),
    }, state, parameters);
    expect(state.pendingTargets).toEqual(['S04', 'S05', 'S06', 'S07', 'S08']);
    expect(decision.orders.map((o) => [o.symbol, o.side])).toEqual(['S01', 'S02', 'S03'].map((s) => [s, 'SELL']));
  });

  it('매수 단계에서 종목군을 벗어난 목표를 매수하지 않고 회전일 밖에 다시 선정하지 않는다', () => {
    const state = initialize();
    expect(rankRetentionMomentum.onBars({ ...context(), isRebalanceBar: false }, state, parameters).orders).toEqual([]);
    expect(state.pendingTargets).toBeNull();
    rankRetentionMomentum.onBars(context(['S10']), state, parameters);
    const buys = rankRetentionMomentum.onBars({ ...context(['S10']), isRebalanceBar: false,
      tradableSymbols: new Set(symbols.filter((s) => s !== 'S01')) }, state, parameters).orders;
    expect(buys.every((o) => o.side === 'BUY' && o.symbol !== 'S01')).toBe(true);
    expect(state.pendingTargets).toBeNull();
  });

  it('유지 경계가 보유 수와 같으면 동점·시드·부분 체결을 포함한 기존 엔진 결과와 같다', () => {
    const candles = Array.from({ length: 85 }, (_, i) => symbols.flatMap((s, j) =>
      [{ ...candle(s, i, 100 + i * (i < 45 ? Math.floor(j / 2) + 1 : 8 - Math.floor(j / 2))), volume: 7000 + i * 100 }])).flat();
    for (const seed of [204, 205]) {
      const config = { candles, initialCash: 1_000_000, maxPositions: 5, randomSeed: seed,
        parameters: { formationDays: 20, skipDays: 0, topN: 5, absoluteMomentumFilter: true },
        tradeFromTsMs: start + 21 * 86400000,
        universeSchedule: [21, 36, 51, 66, 81].map((i) => ({ fromTsMs: start + i * 86400000, symbols })),
        execution: { cost: { id: 'test', version: '1', buyCommissionRate: .00015, sellCommissionRate: .00015, sellTaxRate: .002 },
          slippage: { id: 'test', version: '1', bps: 5, fixed: 0 },
          rules: { tickSize: 1, minOrderQty: 1, maxVolumeParticipationRate: .01 } } };
      const native = runBacktest(crossSectionalMomentumStrategy, config);
      const neutral = runBacktest(rankRetentionMomentum, { ...config, parameters: { ...config.parameters, retentionRank: 5 } });
      expect(neutral).toEqual(native);
      expect(neutral.fills.some((f) => f.side === 'BUY')).toBe(true);
      expect(neutral.metrics.maxConcurrentPositions).toBeLessThanOrEqual(5);
    }
  });

  it('유지 순위의 범위·정수·보유 수 경계를 검증한다', () => {
    for (const retentionRank of [0, 4, 10.5, 201, '10']) {
      expect(rankRetentionParameters.safeParse({ ...parameters, retentionRank }).success).toBe(false);
    }
    expect(rankRetentionParameters.safeParse({ ...parameters, retentionRank: 5 }).success).toBe(true);
  });
});
