import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
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

  it('진입가 위에서 트레일링 스톱에 걸리면 TRAIL_STOP 이다 (수익 청산)', () => {
    // 고정 스톱은 진입가 − 2×ATR 로 **진입가 아래**다. 진입가보다 높은 종가에서
    // 스톱이 나오려면 손절선이 고점을 따라 올라와 있어야만 한다 — updateTrail 없이는
    // 이 경로에서 TREND_END 로 청산된다. 진입가 위 청산은 손절이 아니므로
    // STOP 이 아니라 TRAIL_STOP 으로 구분해 내보낸다.
    const candles: Candle[] = [];
    for (let index = 0; index < 46; index += 1) {
      const close =
        index < 25
          ? 1_000 + (index % 2 === 0 ? 10 : -10) // 워밍업 진동 (진입 신호 없음)
          : index <= 40
            ? 1_000 + (index - 24) * 40 // 급상승 — 고점 1_640
            : 1_300; // 급락하되 진입 체결가(1_080)보다 훨씬 높다
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
    const buy = result.fills.find((fill) => fill.side === 'BUY');
    const sell = result.fills.find((fill) => fill.side === 'SELL');
    expect(buy?.price).toBe(1_080); // 신호봉(index 25) 다음 봉 시가
    expect(sell?.reason).toBe('TRAIL_STOP');
    // 체결가가 진입가보다 높다 = 고정 스톱으로는 설명되지 않는 수익 청산이다
    expect(sell?.price as number).toBeGreaterThan(buy?.price as number);
  });

  it('진입가 아래로 떨어져 스톱에 걸리면 STOP 이다 (손실 청산)', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 46; index += 1) {
      const close =
        index < 25
          ? 1_000 + (index % 2 === 0 ? 10 : -10) // 워밍업 진동
          : index <= 40
            ? 1_000 + (index - 24) * 40 // 급상승
            : 900; // 진입 체결가(1_080) 아래로 급락
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
    const buy = result.fills.find((fill) => fill.side === 'BUY');
    const sell = result.fills.find((fill) => fill.side === 'SELL');
    expect(sell?.reason).toBe('STOP');
    expect(sell?.price as number).toBeLessThan(buy?.price as number);
  });

  it('추세가 꺾이면 청산한다 (TREND_END 또는 스톱 계열)', () => {
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
    expect(['STOP', 'TRAIL_STOP', 'TREND_END']).toContain(sells[0]?.reason);
  });
});

// --- 자본변동(액면분할)을 걸친 EMA 누적 ---------------------------------------
//
// 두 EMA 는 가격 그 자체다.
// 조정하지 않으면 분할 봉에서 짧은 쪽이 긴 쪽보다 훨씬 빨리 내려간다.
// 그 간격이 음수가 되어 없던 하락 추세가 보이고 `TREND_END` 로 허위 청산한다.

const SPLIT_START = Date.UTC(2026, 6, 6, 0, 0);

function splitCandle(index: number, close: number): Candle {
  return {
    symbol: 'LEV',
    market: 'KR',
    timeframe: '1d',
    tsMs: SPLIT_START + index * DAY,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  };
}

/**
 * 효력발생일을 봉 인덱스에서 만든다.
 * `periodKey` 는 거래소 현지 날짜라 뷰가 UTC 로 옮기며 9시간 당긴다.
 * 그래서 봉 `index` 의 날짜를 그대로 쓰면 효력 시각이 직전 봉과 그 봉 사이에 떨어진다.
 * 달의 길이를 손으로 세지 않으려고 날짜 문자열을 계산해서 만든다.
 */
function splitFactAtBar(index: number, ratio: number): Fact {
  return {
    scope: 'SYMBOL',
    key: 'LEV',
    field: CORPORATE_ACTION_FIELD,
    periodKey: new Date(SPLIT_START + index * DAY).toISOString().slice(0, 10),
    asOfTsMs: SPLIT_START,
    value: ratio,
    unit: 'ratio',
  };
}

/**
 * 봉 0~19: 워밍업 진동 — 상관 그룹 확정에 필요한 20봉을 채운다.
 * 봉 20~29: 상승 추세 — 간격이 벌어져 진입한다.
 * 봉 30 이후: 5대 1 분할이 걸려 원본 종가만 1/5 이 된다. 실제 흐름은 그대로 상승이다.
 */
function riseThroughSplit(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 36; index += 1) {
    const truePrice =
      index < 20 ? 100_000 + (index % 2 === 0 ? 500 : -500) : 100_000 + (index - 19) * 3_000;
    candles.push(splitCandle(index, index < 30 ? truePrice : truePrice / 5));
  }
  return candles;
}

describe('ema-trend-switch 분할 후 EMA 누적 조정', () => {
  it('분할 봉에서 추세가 꺾인 것으로 읽지 않는다 (허위 청산 방지)', () => {
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles: riseThroughSplit(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      facts: [splitFactAtBar(30, 5)],
    });

    // 진입은 있어야 한다 — 진입조차 없으면 아래 단언이 공허해진다
    expect(result.fills.filter((fill) => fill.side === 'BUY').length).toBeGreaterThan(0);
    // 실제 흐름은 끝까지 상승이므로 청산 사유가 없다
    expect(result.fills.filter((fill) => fill.side === 'SELL')).toHaveLength(0);
    expect(result.openPositions).toHaveLength(1);
  });

  it('분할 뒤 실제로 추세가 꺾이면 정상적으로 청산한다', () => {
    // 훅이 청산 경로를 무력화한 것이 아니라 단위만 맞춘 것임을 확인한다
    const candles = riseThroughSplit();
    let close = (100_000 + 16 * 3_000) / 5;
    for (let index = 36; index < 50; index += 1) {
      close -= 1_200;
      candles.push(splitCandle(index, close));
    }
    const result = runBacktest(emaTrendSwitchStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      facts: [splitFactAtBar(30, 5)],
    });

    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    // 분할 봉(30)이 아니라 실제 하락 구간에서 청산해야 한다
    expect(sells[0]!.tsMs).toBeGreaterThan(SPLIT_START + 36 * DAY);
  });
});
