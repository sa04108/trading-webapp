import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import type { ExecutionProfile } from '../../src/server/modules/backtest/domain/types.js';
import type { CorporateAction } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import {
  crossSectionalMomentumParameters,
  crossSectionalMomentumStrategy,
  momentumScore,
} from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';

const DAY = 86_400_000;
/** 2025-01-02 09:00 KST = 2025-01-02 00:00 UTC */
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
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

describe('momentumScore 창 인덱싱', () => {
  // close = index 로 두면 인덱스를 값으로 직접 읽을 수 있다
  const history = Array.from({ length: 100 }, (_, index) => candle('A', index, 100 + index));

  it('skipDays 만큼 뒤로 물러난 지점에서 formationDays 창을 잡는다', () => {
    // history.length - 1 = 99. skipDays 5 → end index 94 (=194), formation 10 → start 84 (=184)
    expect(momentumScore(history, [], 10, 5)).toBeCloseTo(194 / 184 - 1);
  });

  it('skipDays 0 이면 마지막 봉이 종점이다', () => {
    expect(momentumScore(history, [], 10, 0)).toBeCloseTo(199 / 189 - 1);
  });

  it('이력이 formationDays + skipDays 보다 짧으면 null', () => {
    expect(momentumScore(history.slice(0, 12), [], 10, 5)).toBeNull();
  });

  it('경계: 이력이 정확히 formationDays + skipDays + 1 개면 계산된다', () => {
    // 창 시작 index 0 을 쓸 수 있는 최소 길이
    const exact = history.slice(0, 16);
    expect(momentumScore(exact, [], 10, 5)).toBeCloseTo(110 / 100 - 1);
  });

  it('분할을 보정해 거짓 하락을 없앤다', () => {
    // index 90 에 2:1 분할 — 그 이후 종가가 절반이 된 이력
    const split: Candle[] = history.map((bar, index) =>
      index >= 90 ? { ...bar, close: bar.close / 2 } : bar,
    );
    const actions: CorporateAction[] = [{ effectiveTsMs: START + 90 * DAY, ratio: 2 }];
    const unadjusted = momentumScore(split, [], 10, 5) as number;
    const adjusted = momentumScore(split, actions, 10, 5) as number;
    expect(unadjusted).toBeLessThan(-0.4); // 거짓 -50% 근처
    expect(adjusted).toBeCloseTo(194 / 184 - 1); // 원래 신호로 복원
  });
});

describe('crossSectionalMomentumParameters', () => {
  it('기본값만으로 파싱된다', () => {
    const parsed = crossSectionalMomentumParameters.parse({});
    expect(parsed).toEqual({
      formationDays: 252,
      skipDays: 21,
      topN: 10,
      rebalanceMonths: 1,
      absoluteMomentumFilter: true,
    });
  });

  it('범위 밖 값을 거부한다', () => {
    expect(crossSectionalMomentumParameters.safeParse({ formationDays: 19 }).success).toBe(false);
    expect(crossSectionalMomentumParameters.safeParse({ skipDays: 64 }).success).toBe(false);
    expect(crossSectionalMomentumParameters.safeParse({ topN: 0 }).success).toBe(false);
  });
});

describe('레지스트리 등록', () => {
  it('전략 목록에 노출된다', () => {
    const registry = new StrategyRegistry();
    expect(registry.list().map((s) => s.id)).toContain('cross-sectional-momentum');
  });

  it('JSON 스키마에 한국어 라벨과 기본값이 실린다', () => {
    const schema = new StrategyRegistry().getParameterJsonSchema('cross-sectional-momentum');
    const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.topN?.title).toBe('보유 종목 수');
    expect(properties.topN?.default).toBe(10);
    expect(typeof properties.formationDays?.description).toBe('string');
  });
});

describe('2단계 리밸런스 실행', () => {
  /**
   * A 는 계속 오르고 B 는 계속 내린다. 워밍업 30봉 뒤 첫 리밸런스에서 A 만 목표가 된다.
   * formationDays·skipDays 를 작게 줄여 테스트 봉 수를 줄인다.
   */
  function buildCandles(bars: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      candles.push(candle('AAA', index, 1_000 + index * 10));
      candles.push(candle('BBB', index, 1_000 - index * 5));
    }
    return candles;
  }

  const parameters = {
    formationDays: 20,
    skipDays: 0,
    topN: 1,
    rebalanceMonths: 1,
    absoluteMomentumFilter: true,
  };

  it('topN 과 maxPositions 가 같아도 전량 회전이 막히지 않는다', () => {
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });

    const buys = result.fills.filter((fill) => fill.side === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    // 오르는 종목만 산다 — 절대 모멘텀 필터가 BBB 를 걸러낸다
    expect(new Set(buys.map((fill) => fill.symbol))).toEqual(new Set(['AAA']));
  });

  it('매수는 매도 봉이 아니라 그 다음 봉에서 체결된다', () => {
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });
    const firstBuy = result.fills.find((fill) => fill.side === 'BUY');
    expect(firstBuy).toBeDefined();
    // 리밸런스 판정 봉 + 1(매수 주문 봉) + 1(체결 봉) — 워밍업 이후 최소 2봉 뒤
    expect((firstBuy as { tsMs: number }).tsMs).toBeGreaterThanOrEqual(START + 21 * DAY);
  });

  it('절대 모멘텀 필터가 모두 걸러내면 현금으로 남는다', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 70; index += 1) {
      candles.push(candle('AAA', index, 1_000 - index * 5));
      candles.push(candle('BBB', index, 1_000 - index * 3));
    }
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });
    expect(result.fills).toEqual([]);
    expect(result.metrics.finalEquity).toBe(10_000_000);
  });

  it('필터를 끄면 하락장에서도 상대적 상위를 산다', () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 70; index += 1) {
      candles.push(candle('AAA', index, 1_000 - index * 5));
      candles.push(candle('BBB', index, 1_000 - index * 3));
    }
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles,
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters: { ...parameters, absoluteMomentumFilter: false },
      randomSeed: 1,
      maxPositions: 1,
    });
    // 덜 빠진 BBB 가 1위
    expect(result.fills.filter((f) => f.side === 'BUY').map((f) => f.symbol)).toContain('BBB');
  });

  it('같은 입력을 두 번 돌리면 같은 결과가 나온다 (재현성 §9.5)', () => {
    const input = {
      candles: buildCandles(70),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    };
    const first = runBacktest(crossSectionalMomentumStrategy, input);
    const second = runBacktest(crossSectionalMomentumStrategy, input);
    expect(second.fills).toEqual(first.fills);
    expect(second.metrics.finalEquity).toBe(first.metrics.finalEquity);
  });
});
