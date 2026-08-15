import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import { CORPORATE_ACTION_FIELD, type Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  rsiReversionParameters,
  rsiReversionStrategy,
} from '../../src/server/modules/strategy/strategies/rsi-reversion.js';

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

const FAST_PARAMS = {
  rsiPeriod: 3,
  entryRsi: 30,
  exitRsi: 55,
  atrPeriod: 3,
  stopAtrMultiplier: 5, // 되돌림 전에 스톱에 걸리지 않게 넉넉히
  riskPerTradePercent: 1,
  correlationBars: 20,
  correlationThreshold: 0.5,
};

/** 워밍업 진동(25봉) → 연속 하락(RSI 과매도) → 반등(RSI 회복) */
function vShapeCandles(): Candle[] {
  const candles: Candle[] = [];
  let close = 1_000;
  for (let index = 0; index < 55; index += 1) {
    if (index < 25) close = 1_000 + (index % 2 === 0 ? 10 : -10);
    else if (index < 35) close -= 20; // 하락 — RSI 0 근처
    else close += 40; // 가파른 반등 — RSI 가 확실히 청산선 위로 회복
    candles.push(candle('AAA', index, close));
  }
  return candles;
}

describe('rsiReversionParameters', () => {
  it('기본값만으로 파싱된다', () => {
    const parsed = rsiReversionParameters.parse({});
    expect(parsed.rsiPeriod).toBe(14);
    expect(parsed.entryRsi).toBe(30);
    expect(parsed.exitRsi).toBe(55);
    expect(parsed.maxHoldBars).toBeUndefined();
  });

  it('entryRsi ≥ exitRsi 를 거부한다', () => {
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 50 }).success).toBe(true);
    expect(rsiReversionParameters.safeParse({ entryRsi: 45, exitRsi: 45 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('목록에 노출되고 JSON 스키마에 한국어 라벨이 실린다', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('rsi-reversion');
    const schema = registry.getParameterJsonSchema('rsi-reversion');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.entryRsi?.title).toBe('진입 RSI');
    expect(rsiReversionStrategy.version).toBe('1.1.0');
  });
});

describe('실행 동작', () => {
  it('과매도에 사서 RSI 회복에 판다', () => {
    const result = runBacktest(rsiReversionStrategy, {
      candles: vShapeCandles(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });
    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(buys.length).toBeGreaterThan(0);
    expect(buys[0]?.reason).toBe('REVERSION');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('RSI_EXIT');
    expect(result.warnings.join('\n')).not.toContain('상관 그룹 워밍업 부족');
  });

  it('같은 상관 그룹에서 동시에 과매도면 seed가 선점 종목을 결정한다', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 45; index += 1) {
      const aaa = index < 20
        ? 1_000 + (index % 2 === 0 ? 10 : -10)
        : 1_000 - (index - 19) * 20;
      const bbb = index < 20
        ? 1_000_000 / aaa
        : 1_000 - (index - 19) * 20;
      candles.push(candle('AAA', index, aaa), candle('BBB', index, bbb));
    }
    const winner = (randomSeed: number) => runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...FAST_PARAMS, stopAtrMultiplier: 20 },
      randomSeed,
      maxPositions: 5,
    }).fills.find((fill) => fill.side === 'BUY')?.symbol;

    expect(winner(42)).toBe(winner(42));
    expect(new Set(Array.from({ length: 8 }, (_, seed) => winner(seed))).size).toBeGreaterThan(1);
  });

  it('편출로 취소된 진입 예약이 봉 없는 재편입 뒤 같은 그룹 종목을 막지 않는다', () => {
    const rising = Array.from({ length: 20 }, (_, index) =>
      index < 15
        ? 1_000 + (index % 2 === 0 ? 10 : -10)
        : 1_000 + (index - 15 + 1) * 15,
    );
    const aaa = rising.map((close) => 1_000_000 / close);
    const bbb = [...rising, 1_100, 500, 500];
    const candles = [
      ...aaa.map((close, index) => candle('AAA', index, close)),
      ...bbb.map((close, index) => candle('BBB', index, close)),
    ].sort((left, right) => left.tsMs - right.tsMs || left.symbol.localeCompare(right.symbol));

    const result = runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [
        { fromTsMs: START, symbols: ['AAA', 'BBB'] },
        { fromTsMs: START + 20 * DAY, symbols: ['BBB'] },
        { fromTsMs: START + 21 * DAY, symbols: ['AAA', 'BBB'] },
      ],
    });

    expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
      'BBB',
    ]);
  });

  it('maxHoldBars 를 지정하면 그 봉 수 뒤 TIME 으로 판다', () => {
    // 하락이 계속되어 RSI 회복이 없는 경로 — 시간 상한만이 청산 경로다
    const candles: Candle[] = [];
    let close = 2_000;
    for (let index = 0; index < 50; index += 1) {
      if (index < 25) close = 2_000 + (index % 2 === 0 ? 10 : -10);
      else close -= 8; // 완만한 하락 지속 (스톱 넉넉해서 안 걸림)
      candles.push(candle('AAA', index, close));
    }
    const result = runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...FAST_PARAMS, stopAtrMultiplier: 20, maxHoldBars: 3 },
      randomSeed: 1,
      maxPositions: 5,
    });
    const sells = result.fills.filter((fill) => fill.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]?.reason).toBe('TIME');
    // 체결 봉에서 barsHeld 1 시작 → 3봉째에 TIME 신호 → 다음 봉 시가 체결.
    // 매수 체결 봉과 매도 체결 봉의 간격 = 3봉.
    const buyTs = result.fills.find((fill) => fill.side === 'BUY')?.tsMs as number;
    expect((sells[0]?.tsMs as number) - buyTs).toBe(3 * DAY);
  });

  it('비활성 종목의 과매도 신호가 활성 종목의 진입을 선점하지 않는다', () => {
    const inactiveFirst: Candle[] = [];
    const activeSecond: Candle[] = [];
    let aaa = 1_000;
    let zzz = 1_000;
    for (let index = 0; index < 55; index += 1) {
      if (index < 25) {
        aaa = 1_000 + (index % 2 === 0 ? 10 : -10);
        zzz = 1_000_000 / aaa;
      } else {
        aaa -= 20;
        zzz -= 20;
      }
      inactiveFirst.push(candle('AAA', index, aaa));
      activeSecond.push(candle('ZZZ', index, zzz));
    }

    const result = runBacktest(rsiReversionStrategy, {
      candles: [...inactiveFirst, ...activeSecond].sort(
        (left, right) => left.tsMs - right.tsMs || (left.symbol < right.symbol ? -1 : 1),
      ),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['ZZZ'] }],
    });

    const buySymbols = result.fills
      .filter((fill) => fill.side === 'BUY')
      .map((fill) => fill.symbol);
    expect(buySymbols.length).toBeGreaterThan(0);
    expect(new Set(buySymbols)).toEqual(new Set(['ZZZ']));
    expect(result.warnings.some((warning) => warning.includes('AAA 매수 거부'))).toBe(false);
  });

  it('상관 워밍업이 부족해 진입을 평가하지 못하면 원인을 경고한다', () => {
    const result = runBacktest(rsiReversionStrategy, {
      candles: Array.from({ length: 10 }, (_, index) => candle('AAA', index, 1_000 - index * 10)),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
    });

    expect(result.fills).toHaveLength(0);
    expect(result.warnings.join('\n')).toContain('상관 그룹 워밍업 부족');
    expect(result.warnings.join('\n')).toContain('필요 20봉, 확보 최대 10봉');
  });

  it('보유 중인 역상관 종목이 거래정지여도 같은 그룹 종목을 추가 매수하지 않는다', () => {
    const candles: Candle[] = [];
    let aaa = 1_000;
    let bbb = 1_000;
    for (let index = 0; index < 50; index += 1) {
      if (index < 25) {
        aaa = 1_000 + (index % 2 === 0 ? 10 : -10);
        bbb = 1_000_000 / aaa;
      } else if (index < 31) {
        aaa -= 20;
        bbb += 20;
      } else {
        bbb -= 30;
      }
      candles.push(candle('AAA', index, aaa));
      candles.push(candle('BBB', index, bbb));
    }

    const result = runBacktest(rsiReversionStrategy, {
      candles: candles.sort(
        (left, right) => left.tsMs - right.tsMs || (left.symbol < right.symbol ? -1 : 1),
      ),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...FAST_PARAMS, stopAtrMultiplier: 20 },
      randomSeed: 1,
      maxPositions: 5,
      universeSchedule: [{ fromTsMs: START, symbols: ['AAA', 'BBB'] }],
      nonTradingSymbolsByTsMs: new Map([
        [START + 36 * DAY, new Set(['AAA'])],
      ]),
    });

    expect(result.fills.filter((fill) => fill.side === 'BUY').map((fill) => fill.symbol)).toEqual([
      'AAA',
    ]);
  });
});

// --- 자본변동(액면분할)을 걸친 RSI 누적 ---------------------------------------
//
// RSI 값 자체는 비율이라 분할에 영향받지 않는다.
// 그러나 그 값을 만드는 `prevClose` 는 가격이다.
// 조정하지 않으면 5대 1 분할 봉이 −80% 짜리 하락 한 번으로 들어간다.
// 그 한 번이 RSI 를 과매도 문턱 아래로 끌어내려 없던 진입을 만든다.

const SPLIT_START = Date.UTC(2026, 6, 6, 0, 0);

function splitCandle(index: number, close: number): Candle {
  return {
    symbol: 'AAA',
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

/** 효력 시각은 봉 인덱스 (`day`−7)과 (`day`−6) 사이에 떨어진다 — KST 자정을 UTC 로 바꾸며 하루 밀린다 */
function splitFact(day: number, ratio: number): Fact {
  return {
    scope: 'SYMBOL',
    key: 'AAA',
    field: CORPORATE_ACTION_FIELD,
    periodKey: `2026-07-${String(day).padStart(2, '0')}`,
    asOfTsMs: SPLIT_START,
    value: ratio,
    unit: 'ratio',
  };
}

/**
 * 봉 0~24: 꾸준한 상승 — RSI 는 100 근처라 진입선(30) 과 멀다.
 * 봉 25 이후: 5대 1 분할이 걸려 원본 종가만 1/5 이 된다. 실제 흐름은 그대로 상승이다.
 */
function steadyRiseWithSplit(): Candle[] {
  const candles: Candle[] = [];
  for (let index = 0; index < 30; index += 1) {
    const truePrice = 100_000 + index * 1_000;
    candles.push(splitCandle(index, index < 25 ? truePrice : truePrice / 5));
  }
  return candles;
}

describe('rsi-reversion 분할 후 RSI 누적 조정', () => {
  it('분할 봉을 과매도로 읽지 않는다 (허위 진입 방지)', () => {
    const result = runBacktest(rsiReversionStrategy, {
      candles: steadyRiseWithSplit(),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      facts: [splitFact(31, 5)],
    });

    // 전 구간이 상승이라 과매도는 한 번도 없다.
    // 조정하지 않으면 봉 25 의 −80% 가 RSI 를 2 근처로 떨어뜨려 매수가 나간다.
    expect(result.fills.filter((fill) => fill.side === 'BUY')).toHaveLength(0);
  });

  it('실제로 과매도가 오면 정상적으로 진입한다 (훅이 진입을 막은 것이 아니다)', () => {
    // 분할 뒤에 진짜 급락을 붙인다 — 조정이 RSI 를 무디게 만들지 않았음을 확인한다
    const candles = steadyRiseWithSplit();
    let close = (100_000 + 29 * 1_000) / 5;
    for (let index = 30; index < 40; index += 1) {
      close -= 800;
      candles.push(splitCandle(index, close));
    }
    const result = runBacktest(rsiReversionStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: FAST_PARAMS,
      randomSeed: 1,
      maxPositions: 5,
      facts: [splitFact(31, 5)],
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    // 분할 봉(25)이 아니라 실제 하락 구간에서 진입해야 한다
    expect(buys[0]!.tsMs).toBeGreaterThan(SPLIT_START + 30 * DAY);
  });
});
