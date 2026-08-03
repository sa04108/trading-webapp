import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import {
  rangeBreakoutParameters,
  rangeBreakoutStrategy,
  type RangeBreakoutParameters,
} from '../../src/server/modules/strategy/strategies/range-breakout.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';

describe('range-breakout parameters (스펙 §32)', () => {
  it('생략된 파라미터는 기본값으로 채운다 — 추적 손절과 비중 상한이 기본 동작이다', () => {
    const result = rangeBreakoutParameters.parse({});
    expect(result.trailAtrMultiplier).toBe(2);
    expect(result.maxPositionWeightPercent).toBe(20);
    // 익절·보유 상한은 선택 — 비우면 추적 손절이 이익 확정을 맡는다
    expect(result.takeProfitAtrMultiplier).toBeUndefined();
    expect(result.maxHoldBars).toBeUndefined();
  });

  it('rejects out-of-range parameters', () => {
    expect(
      rangeBreakoutParameters.safeParse({
        lookbackBars: 1, // min 2
        atrPeriod: 14,
        stopAtrMultiplier: 2,
        riskPerTradePercent: 1,
      }).success,
    ).toBe(false);
    expect(
      rangeBreakoutParameters.safeParse({
        lookbackBars: 20,
        atrPeriod: 14,
        stopAtrMultiplier: 2,
        riskPerTradePercent: 10, // max 5
      }).success,
    ).toBe(false);
    expect(
      rangeBreakoutParameters.safeParse({ maxPositionWeightPercent: 0 }).success, // min 1
    ).toBe(false);
  });
});

describe('StrategyRegistry', () => {
  it('lists registered strategies and validates parameters', () => {
    const registry = new StrategyRegistry();
    const list = registry.list();
    expect(list.map((s) => s.id)).toContain('range-breakout');

    const valid = registry.validateParameters('range-breakout', {
      lookbackBars: 20,
      atrPeriod: 14,
      stopAtrMultiplier: 2,
      riskPerTradePercent: 1,
    });
    expect(valid.ok).toBe(true);

    const invalid = registry.validateParameters('range-breakout', { lookbackBars: 'x' });
    expect(invalid.ok).toBe(false);

    const unknown = registry.validateParameters('nope', {});
    expect(unknown.ok).toBe(false);
  });

});

// ── 청산·수량 동작 ────────────────────────────────────────────────
//
// 봉은 OHLC 를 전부 지정한다 — ATR 이 정확히 얼마인지 손으로 계산할 수 있어야
// 기대값이 "돌려보고 맞춘 숫자" 가 되지 않는다.

const HOUR = 3_600_000;
const START = Date.UTC(2026, 6, 6, 0, 0);

const ZERO_COST: ExecutionProfile = {
  cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
  slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
  rules: { tickSize: 0, minOrderQty: 1 },
};

function candle(index: number, ohlc: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): Candle {
  return {
    symbol: 'A',
    market: 'KR',
    timeframe: '1h',
    tsMs: START + index * HOUR,
    volume: 100,
    ...ohlc,
  };
}

/** 20봉 평탄 구간 — TR 이 매 봉 2 라 ATR(5) 이 정확히 2 가 된다 */
function flatWarmup(): Candle[] {
  return Array.from({ length: 20 }, (_, i) =>
    candle(i, { open: 100, high: 101, low: 99, close: 100 }),
  );
}

/** 평탄 구간(고가 101)을 뚫는 신호봉 — TR = 6 이라 ATR 이 (2×4+6)/5 = 2.8 로 올라간다 */
const SIGNAL_BAR = candle(20, { open: 100, high: 106, low: 100, close: 105 });

const BASE: RangeBreakoutParameters = {
  lookbackBars: 10,
  atrPeriod: 5,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 2,
  maxPositionWeightPercent: 100,
};

function run(candles: readonly Candle[], parameters: RangeBreakoutParameters) {
  return runBacktest(rangeBreakoutStrategy as never, {
    candles,
    initialCash: 1_000_000,
    execution: ZERO_COST,
    parameters,
    randomSeed: 42,
    maxPositions: 5,
  });
}

describe('range-breakout 추적 손절', () => {
  // 진입가 110, 같은 봉 종가 120 → 손절선이 120 − 2×2.8 = 114.4 로 올라간다.
  // 고정 손절이면 110 − 2×2.8 = 104.4 라 종가 113 에 걸리지 않는다.
  const candles = [
    ...flatWarmup(),
    SIGNAL_BAR,
    candle(21, { open: 110, high: 121, low: 109, close: 120 }), // 체결 + 고점 갱신
    candle(22, { open: 119, high: 120, low: 112, close: 113 }), // 114.4 이탈
    candle(23, { open: 113, high: 114, low: 112, close: 113 }), // 청산 체결
  ];

  it('고점을 따라 올라간 손절선에 걸리면 TRAIL_STOP 으로 이익을 확정한다', () => {
    const result = run(candles, BASE);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryPrice).toBe(110);
    expect(trade.exitPrice).toBe(113);
    // 진입가 위에서 걸린 손절선은 손절이 아니다 — 라벨과 손익 부호가 일치해야 한다
    expect(trade.exitReason).toBe('TRAIL_STOP');
    expect(trade.netPnl).toBeGreaterThan(0);
  });

  it('추적 폭을 넓히면 같은 구간에서 청산되지 않는다 — 청산 원인이 추적 손절임을 확인', () => {
    const result = run(candles, { ...BASE, trailAtrMultiplier: 20 });

    expect(result.trades).toHaveLength(0);
    expect(result.openPositions).toHaveLength(1); // 기간 끝까지 보유
  });

});

describe('range-breakout 보유 상한', () => {
  it('maxHoldBars 를 넘기면 신호와 무관하게 TIME 으로 청산한다', () => {
    // 체결 후 종가가 105 로 평탄 — 고점 갱신이 없어 손절선은 105−5.6 = 99.4 에 머문다.
    // 진입 후 고가는 105.5 로 두어 신호봉 고가(106)가 기준선으로 남게 한다 (재진입 방지).
    const flatHold = (index: number) =>
      candle(index, { open: 105, high: 105.5, low: 104.5, close: 105 });
    const result = run([...flatWarmup(), SIGNAL_BAR, ...[21, 22, 23, 24, 25].map(flatHold)], {
      ...BASE,
      maxHoldBars: 3,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe('TIME');
  });
});

describe('range-breakout 종목당 비중 상한', () => {
  // 변동성이 작은 종목: TR 0.4 → ATR 0.4. 신호봉 TR 0.6 → ATR (0.4×4+0.6)/5 = 0.44.
  // 리스크 기준 수량 = floor(1,000,000×1% ÷ (2×0.44)) = 11,363 주 → 명목 114만원으로
  // 자본을 넘어선다. 상한이 없으면 엔진이 현금 한도로 깎아 사실상 전액 매수가 된다.
  const lowVol = [
    ...Array.from({ length: 20 }, (_, i) =>
      candle(i, { open: 100, high: 100.2, low: 99.8, close: 100 }),
    ),
    candle(20, { open: 100, high: 100.6, low: 100, close: 100.5 }),
    candle(21, { open: 100.5, high: 100.7, low: 100.3, close: 100.5 }),
  ];
  const parameters: RangeBreakoutParameters = {
    ...BASE,
    riskPerTradePercent: 1,
    maxPositionWeightPercent: 20,
  };

  it('리스크 기준 수량이 자본을 넘어서면 비중 상한이 수량을 깎는다', () => {
    const capped = run(lowVol, parameters)
      .fills.filter((fill) => fill.side === 'BUY')
      .at(0);
    // floor(1,000,000×20% ÷ 100.5) = 1,990 주
    expect(capped?.quantity).toBe(1990);
  });

  it('상한을 100% 로 두면 자본 전액이 한 종목에 들어간다 (상한이 막는 상태)', () => {
    const uncapped = run(lowVol, { ...parameters, maxPositionWeightPercent: 100 })
      .fills.filter((fill) => fill.side === 'BUY')
      .at(0);
    // floor(1,000,000 ÷ 100.5) = 9,950 주 → 명목 999,975원 ≈ 자본 전액
    expect(uncapped?.quantity).toBe(9950);
  });
});

describe('range-breakout 워밍업', () => {
  it('돌파 기준선 창이 lookbackBars 개로 차기 전에는 진입하지 않는다', () => {
    // 창을 채우려면 30봉이 필요한데 21봉만 준다 — 돌파해도 기준선이 없다
    const result = run([...flatWarmup(), SIGNAL_BAR], { ...BASE, lookbackBars: 30 });
    expect(result.fills).toHaveLength(0);
  });
});
