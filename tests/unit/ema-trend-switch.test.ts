import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  emaTrendSwitchParameters,
  emaTrendSwitchStrategy,
} from '../../src/server/modules/strategy/strategies/ema-trend-switch.js';

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 2);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candle(symbol: string, index: number, close: number): Candle {
  return {
    symbol,
    market: 'KR',
    timeframe: '1d',
    tsMs: START + index * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  };
}

/**
 * 역상관 쌍: LEV 가 진동하며 오르내리면 INV = 1e6/LEV 는 정확히 반대로 움직인다.
 * 워밍업(진동, 추세 없음) 뒤 LEV 만 상승 추세 — LEV 만 진입해야 한다.
 */
function pairCandles(bars: number, warmupBars: number): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < bars; index += 1) {
    const lev =
      index < warmupBars
        ? 1_000 + (index % 2 === 0 ? 10 : -10) // 진동 — 추세 없음, 상관은 뚜렷
        : 1_000 + (index - warmupBars + 1) * 15; // 상승 추세
    candles.push(candle('LEV', index, lev));
    candles.push(candle('INV', index, 1_000_000 / lev));
  }
  return candles.sort((a, b) => a.tsMs - b.tsMs);
}

const FAST_PARAMS = {
  fastEmaBars: 3,
  slowEmaBars: 6,
  entryThresholdPercent: 0.3,
  atrPeriod: 3,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

describe('emaTrendSwitchParameters', () => {
  it('기본값만으로 파싱된다 (maxHoldBars 는 선택)', () => {
    const parsed = emaTrendSwitchParameters.parse({});
    expect(parsed.fastEmaBars).toBe(12);
    expect(parsed.slowEmaBars).toBe(26);
    expect(parsed.maxHoldBars).toBeUndefined();
  });

  it('fastEmaBars ≥ slowEmaBars 를 거부한다', () => {
    expect(
      emaTrendSwitchParameters.safeParse({ fastEmaBars: 26, slowEmaBars: 26 }).success,
    ).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('목록에 노출되고 JSON 스키마가 라벨과 함께 나온다 (refine 이 스키마 생성을 깨지 않는다)', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('ema-trend-switch');
    const schema = registry.getParameterJsonSchema('ema-trend-switch');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.fastEmaBars?.title).toBe('단기 이동평균 봉 수');
    expect(properties.fastEmaBars?.default).toBe(12);
  });
});

describe('실행 동작', () => {
  it('상승 추세인 쪽만 사고, 역상관 짝은 같은 그룹이라 사지 않는다', () => {
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles: pairCandles(60, 25),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['LEV']));
  });

  it('상관 워밍업이 차기 전에는 진입하지 않는다', () => {
    // 전 구간 상승 추세 — 워밍업 20봉 없이는 진입 불가여야 한다
    const candles: Candle[] = [];
    for (let index = 0; index < 15; index += 1) {
      candles.push(candle('LEV', index, 1_000 + index * 15));
    }
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    expect(result.fills).toHaveLength(0);
  });

  it('추세가 꺾이면 청산한다 (TREND_END 또는 STOP)', () => {
    // 워밍업 25 + 상승 20 + 급락 15
    const candles: Candle[] = [];
    for (let index = 0; index < 60; index += 1) {
      const close =
        index < 25
          ? 1_000 + (index % 2 === 0 ? 10 : -10)
          : index < 45
            ? 1_000 + (index - 24) * 15
            : 1_300 - (index - 44) * 40;
      candles.push(candle('LEV', index, close));
    }
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(['STOP', 'TREND_END']).toContain(sells[0]?.reason);
  });
});
