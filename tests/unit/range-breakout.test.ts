import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import {
  rangeBreakoutParameters,
  rangeBreakoutStrategy,
  type RangeBreakoutParameters,
} from '../../src/server/modules/strategy/strategies/range-breakout.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';

describe('range-breakout parameters (스펙 §32)', () => {
  it('공유 ATR 계산 방식을 전략 버전에 반영한다', () => {
    expect(rangeBreakoutStrategy.version).toBe('2.0.3');
  });

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
    timeframe: '1d',
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
  it('ATR period번째 봉에 시드가 완성되면 그 봉의 적법한 신호를 버리지 않는다', () => {
    const result = run([
      candle(0, { open: 100, high: 101, low: 99, close: 100 }),
      candle(1, { open: 100, high: 101, low: 99, close: 100 }),
      candle(2, { open: 100, high: 106, low: 100, close: 105 }),
      candle(3, { open: 105, high: 106, low: 104, close: 105 }),
    ], {
      ...BASE,
      lookbackBars: 2,
      atrPeriod: 3,
    });
    expect(result.fills.some((fill) => fill.side === 'BUY' && fill.tsMs === START + 3 * HOUR))
      .toBe(true);
  });

  it('돌파 기준선 창이 lookbackBars 개로 차기 전에는 진입하지 않는다', () => {
    // 창을 채우려면 30봉이 필요한데 21봉만 준다 — 돌파해도 기준선이 없다
    const result = run([...flatWarmup(), SIGNAL_BAR], { ...BASE, lookbackBars: 30 });
    expect(result.fills).toHaveLength(0);
  });

  it('유니버스 밖 거부 주문을 pending으로 남기지 않아 첫 편입 신호를 놓치지 않는다', () => {
    const candles = [
      ...flatWarmup(),
      SIGNAL_BAR, // 아직 유니버스 밖이므로 신호 상태를 만들면 안 된다
      candle(21, { open: 105, high: 108, low: 104, close: 107 }), // 편입 뒤 첫 유효 돌파
      candle(22, { open: 108, high: 109, low: 107, close: 108 }), // 정상 체결 시점
      candle(23, { open: 109, high: 110, low: 108, close: 109 }),
    ];
    const result = runBacktest(rangeBreakoutStrategy as never, {
      candles,
      initialCash: 1_000_000,
      execution: ZERO_COST,
      parameters: BASE,
      randomSeed: 42,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: [] },
        { fromTsMs: START + 21 * HOUR, symbols: ['A'] },
      ],
    });

    expect(result.fills.filter((fill) => fill.side === 'BUY')).toHaveLength(1);
    expect(result.fills.find((fill) => fill.side === 'BUY')?.tsMs).toBe(START + 22 * HOUR);
    expect(result.warnings.some((warning) => warning.includes('활성 멤버십 일정'))).toBe(false);
  });
});

// ── 분할이 걸린 보유 종목의 스톱 조정 ──────────────────────────────
//
// 엔진은 포지션 수량·평균단가를 분할에 맞춰 조정한다.
// 하지만 전략이 봉 사이에 들고 다니는 `HoldingState` 의 가격 필드
// (`entryAtr`·`stopLevel`·`highestClose`)는 그대로 두면 분할 전 단위로 남는다.
// 자본변동 훅이 이 필드도 같은 비율로 나눠야 한다.
// 그래야 5:1 분할로 원본 종가가 1/5 로 떨어져도 허위로 스톱에 걸리지 않는다.

const SPLIT_DAY = 86_400_000;
const SPLIT_START = Date.UTC(2026, 6, 6, 0, 0);

function splitCandle(index: number, ohlc: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): Candle {
  return {
    symbol: 'A',
    market: 'KR',
    timeframe: '1d',
    tsMs: SPLIT_START + index * SPLIT_DAY,
    volume: 100,
    ...ohlc,
  };
}

/** `periodKey` 의 효력 시각은 봉 인덱스 (`day`−7)과 (`day`−6) 사이에 떨어진다. KST 자정을 UTC 로 바꾸며 하루 밀린다. */
function splitFact(symbol: string, day: number, ratio: number): Fact {
  return {
    scope: 'SYMBOL',
    key: symbol,
    field: CORPORATE_ACTION_FIELD,
    periodKey: `2026-07-${String(day).padStart(2, '0')}`,
    asOfTsMs: SPLIT_START,
    value: ratio,
    unit: 'ratio',
  };
}

/**
 * 진입가 100_000 · 손절 폭 2×ATR(5_000) = 스톱 90_000 을 만드는 픽스처.
 * 봉 0~5: 평탄 워밍업(TR 5_000 고정 → ATR 5_000).
 * 봉 6: 전고점(102_500) 돌파 신호.
 * 봉 7: 체결(시가 100_000) — `confirmEntry` 로 스톱 90_000 확정.
 * 봉 8: 5:1 분할 효력 — 종가 20_000 (조정 없으면 `stopLevel` 90_000 에 걸려 즉시 청산).
 */
function splitStopFixture(): Candle[] {
  return [
    ...Array.from({ length: 6 }, (_, i) =>
      splitCandle(i, { open: 100_000, high: 102_500, low: 97_500, close: 100_000 }),
    ),
    splitCandle(6, { open: 100_000, high: 105_000, low: 100_000, close: 104_000 }), // 돌파 신호
    splitCandle(7, { open: 100_000, high: 100_500, low: 99_500, close: 100_000 }), // 체결
    splitCandle(8, { open: 20_000, high: 20_100, low: 19_900, close: 20_000 }), // 분할 효력 봉
  ];
}

const SPLIT_PARAMS: RangeBreakoutParameters = {
  lookbackBars: 5,
  atrPeriod: 5,
  stopAtrMultiplier: 2,
  trailAtrMultiplier: 2,
  riskPerTradePercent: 1,
  maxPositionWeightPercent: 100,
};

function runWithFacts(candles: readonly Candle[], facts: readonly Fact[]) {
  return runBacktest(rangeBreakoutStrategy as never, {
    candles,
    initialCash: 1_000_000,
    execution: ZERO_COST,
    parameters: SPLIT_PARAMS,
    randomSeed: 42,
    maxPositions: 5,
    facts,
  });
}

describe('range-breakout 분할 후 스톱 조정', () => {
  it('분할 후에도 스톱이 발동하지 않는다 (허위 청산 방지)', () => {
    const result = runWithFacts([...splitStopFixture(), splitCandle(9, { open: 20_000, high: 20_100, low: 19_900, close: 20_000 })], [
      splitFact('A', 14, 5),
    ]);

    // 분할 조정이 없으면 봉 8(종가 20_000)에서 `stopLevel`(90_000) 에 걸린다.
    // 그러면 엔진이 봉 9에 SELL 을 체결한다 — 이 테스트가 잡으려는 회귀다.
    expect(result.trades).toHaveLength(0);
    expect(result.openPositions).toHaveLength(1);
    expect(result.openPositions[0]!.symbol).toBe('A');
    expect(result.openPositions[0]!.quantity).toBe(5); // 1주 × 5 — 분할로 조정된 수량
    expect(result.openPositions[0]!.avgEntryPrice).toBe(20_000);
  });

  it('분할로 조정된 스톱(18_000) 아래로 실제로 내려가면 정상적으로 청산한다', () => {
    // 조정 후 스톱은 90_000 ÷ 5 = 18_000 이다. 종가가 그 아래로 떨어지면
    // 훅이 스톱을 무력화한 게 아니라 재보정만 했다는 것을 확인한다.
    const candles = [
      ...splitStopFixture(),
      splitCandle(9, { open: 20_000, high: 20_050, low: 16_900, close: 17_000 }), // 18_000 이탈
      splitCandle(10, { open: 17_000, high: 17_100, low: 16_900, close: 17_000 }), // 청산 체결
    ];
    const result = runWithFacts(candles, [splitFact('A', 14, 5)]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe('STOP');
    expect(result.trades[0]!.exitPrice).toBe(17_000);
  });
});

// --- 자본변동(액면분할)을 걸친 돌파 기준선 -----------------------------------
//
// 돌파 기준선은 직전 `lookbackBars` 개 봉의 고가로 만든다.
// 창에 담긴 값은 전부 가격이라 분할 비율만큼 내려야 한다.
// 내리지 않으면 기준선이 분할 전 고가에 남아 분할된 종가가 영영 못 넘는다.
// 창이 새 가격으로 다 갈릴 때까지 돌파 진입이 통째로 막힌다.

/**
 * 봉 0~5: 평탄 워밍업. 종가 100_000 은 전고점 102_500 을 못 넘어 진입이 없다.
 * 봉 6: 5:1 분할 효력. 조정하면 기준선은 20_500 이 된다.
 * 봉 7: 종가 21_000 — 조정된 기준선은 넘고 조정 전 기준선(102_500)은 못 넘는다.
 * 봉 8: 진입 체결.
 */
function splitChannelFixture(): Candle[] {
  return [
    ...Array.from({ length: 6 }, (_, i) =>
      splitCandle(i, { open: 100_000, high: 102_500, low: 97_500, close: 100_000 }),
    ),
    splitCandle(6, { open: 20_000, high: 20_500, low: 19_500, close: 20_000 }),
    splitCandle(7, { open: 20_100, high: 21_200, low: 20_000, close: 21_000 }),
    splitCandle(8, { open: 21_000, high: 21_100, low: 20_900, close: 21_000 }),
  ];
}

describe('range-breakout 분할 후 돌파 기준선 조정', () => {
  it('분할 뒤 첫 돌파를 놓치지 않는다 (진입 봉쇄 방지)', () => {
    const result = runWithFacts(splitChannelFixture(), [splitFact('A', 12, 5)]);

    // 조정하지 않으면 기준선이 102_500 에 남아 종가 21_000 이 못 넘는다 — 매수가 없다.
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys).toHaveLength(1);
    expect(buys[0]!.tsMs).toBe(SPLIT_START + 8 * SPLIT_DAY);
  });

  it('조정된 기준선을 못 넘으면 진입하지 않는다 (훅이 기준선을 없앤 것이 아니다)', () => {
    const candles = splitChannelFixture();
    // 봉 7 종가를 조정된 기준선(20_500) 아래로 낮춘다
    candles[7] = splitCandle(7, { open: 20_100, high: 20_400, low: 20_000, close: 20_300 });
    const result = runWithFacts(candles, [splitFact('A', 12, 5)]);

    expect(result.fills.filter((fill) => fill.side === 'BUY')).toHaveLength(0);
  });
});
