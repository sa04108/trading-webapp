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
  it('설명이 분할 보정을 무조건 약속하지 않는다', () => {
    const registry = new StrategyRegistry();
    // 사용자에게 보이는 설명은 분할 보정을 무조건 약속하면 안 된다 — 분할 이력이
    // 수집되지 않은 데이터셋에서는 원 종가로 계산되고, 그 수집을 강제하는 것은 없다.
    const description =
      registry.list().find((s) => s.id === 'cross-sectional-momentum')?.description ?? '';
    expect(description).toContain('분할 이력이 수집된 데이터셋에서만');
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


  it('1위 종목이 다음 리밸런스에서 바뀌면 매도 뒤 다음 봉에서 매수해 회전한다', () => {
    // AAA 는 index 18 까지 오르다 급락, BBB 는 계속 내리다 index 18 부터 급등한다.
    // 창[0,20](첫 리밸런스, index 20)에서는 AAA 가 유일한 양(+)의 후보라 AAA 를 편입한다.
    // 창[10,30](둘째 리밸런스, 2월 1일 = index 30)에서는 역전되어 BBB 만 후보가 된다.
    // topN == maxPositions == 1 인 상태에서 실제로 회전(청산 → 신규 편입)이 일어나는지를
    // 확인한다 — 매도·매수를 같은 봉에 함께 내는 순진한(단일 단계) 구현이라면 동시
    // 포지션 상한에 걸려 회전 자체가 막히거나, 매도·매수가 같은 봉에서 함께 체결된 것처럼
    // 보여 이 테스트를 구분하지 못한다.
    function buildRotationCandles(bars: number): Candle[] {
      const candles: Candle[] = [];
      for (let index = 0; index < bars; index += 1) {
        const aaaClose = index <= 18 ? 1_000 + index * 10 : 1_180 - (index - 18) * 15;
        const bbbClose = index <= 18 ? 1_000 - index * 5 : 910 + (index - 18) * 20;
        candles.push(candle('AAA', index, aaaClose));
        candles.push(candle('BBB', index, bbbClose));
      }
      return candles;
    }

    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildRotationCandles(40),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 1,
    });

    const sellAaa = result.fills.find((fill) => fill.symbol === 'AAA' && fill.side === 'SELL');
    const buyBbb = result.fills.find((fill) => fill.symbol === 'BBB' && fill.side === 'BUY');
    expect(sellAaa).toBeDefined();
    expect(buyBbb).toBeDefined();
    // 매수는 매도가 결정된 봉보다 반드시 나중 봉에서 체결된다
    expect((buyBbb as { tsMs: number }).tsMs).toBeGreaterThan((sellAaa as { tsMs: number }).tsMs);
    // 매도·매수가 겹치는 봉이 없어 상한(1)을 절대 넘지 않는다
    expect(result.metrics.maxConcurrentPositions).toBeLessThanOrEqual(1);
  });

  it('절대 모멘텀 필터가 모두 걸러내면 현금으로 남는다 (리밸런스 경계 전까지는 재평가하지 않는다)', () => {
    // AAA 는 index 18 까지 하락하다 급반등한다. 첫 리밸런스 판정 봉(index 20)의 창[0,20]은
    // 아직 마이너스라 AAA·BBB 둘 다 걸러져 후보가 없다. 하지만 index 21 부터는 롤링 창이
    // 곧 플러스로 바뀐다 — '후보 없음'을 워밍업으로 오인해 lastRebalanceMonthKey 를 못
    // 박지 않는 버그가 있다면, 다음 캘린더 리밸런스(2월 1일 = index 30)를 기다리지 않고
    // 반등 직후(index 21 부근)에 곧바로 매수했을 것이다. BBB 는 끝까지 하락해 항상 걸러진다.
    const candles: Candle[] = [];
    for (let index = 0; index < 40; index += 1) {
      const aaaClose = index <= 18 ? 1_000 - index * 5 : 910 + (index - 18) * 40;
      candles.push(candle('AAA', index, aaaClose));
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
    // 2월 1일(index 30) 이전에는 어떤 체결도 없어야 한다 — 반등에 즉시 반응하지 않는다
    expect(result.fills.every((fill) => fill.tsMs >= START + 30 * DAY)).toBe(true);
    // 다만 영원히 무거래인 것은 아니다 — 경계 이후 실제로 매수가 일어난다
    expect(result.fills.length).toBeGreaterThan(0);
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

});

describe('멤버십 일정 반영 랭킹 (리뷰 fix — 2026-08-05)', () => {
  /**
   * A·B·C 세 종목. A 는 첫 리밸런스(index20) 창[0,20]에서는 원 모멘텀으로도 최하위지만,
   * 둘째 리밸런스(index30) 창[10,30]에서는 급등해 원 모멘텀만으로는 1위가 된다.
   * 그런데 A 는 2구간(index30 이후)부터 일정에서 빠진다.
   *
   * 랭킹 후보를 tradableSymbols 로 거르지 않으면: A 가 원 모멘텀만으로 topN 에 들어
   * targets=[A, B] 가 되고, 이미 보유 중이던 C 가 팔리는데 A 매수는 엔진이 거부해
   * 그 몫의 예산이 그대로 현금으로 논다 — topN=2 인데 실제 보유는 B 하나로 준다.
   * 걸러내면 후보는 {B, C} 뿐이라 이미 topN(=2) 을 정확히 채우고 있어 아무 것도
   * 바뀌지 않는다 — 이 테스트가 검증하는 동작.
   */
  function priceAt(anchors: ReadonlyArray<readonly [number, number]>, index: number): number {
    for (let i = 0; i < anchors.length - 1; i += 1) {
      const [i0, v0] = anchors[i] as [number, number];
      const [i1, v1] = anchors[i + 1] as [number, number];
      if (index <= i1) {
        if (index <= i0) return v0;
        return v0 + ((v1 - v0) * (index - i0)) / (i1 - i0);
      }
    }
    return (anchors[anchors.length - 1] as [number, number])[1];
  }

  const A_ANCHORS = [[0, 100], [10, 105], [20, 110], [30, 300]] as const;
  const B_ANCHORS = [[0, 100], [10, 115], [20, 140], [30, 160]] as const;
  const C_ANCHORS = [[0, 100], [10, 108], [20, 125], [30, 145]] as const;

  function buildMembershipCandles(bars: number): Candle[] {
    const candles: Candle[] = [];
    for (let index = 0; index < bars; index += 1) {
      candles.push(candle('A', index, priceAt(A_ANCHORS, index)));
      candles.push(candle('B', index, priceAt(B_ANCHORS, index)));
      candles.push(candle('C', index, priceAt(C_ANCHORS, index)));
    }
    return candles;
  }

  const parameters = {
    formationDays: 20,
    skipDays: 0,
    topN: 2,
    rebalanceMonths: 1,
    absoluteMomentumFilter: true,
  };

  it('2구간에서 유니버스 탈락 종목은 랭킹 후보에서도 빠져 차순위가 슬롯을 지킨다', () => {
    const result = runBacktest(crossSectionalMomentumStrategy, {
      candles: buildMembershipCandles(33),
      initialCash: 10_000_000,
      execution: ZERO_COST,
      parameters,
      randomSeed: 1,
      maxPositions: 2,
      universeSchedule: [
        { fromTsMs: START, symbols: ['A', 'B', 'C'] },
        { fromTsMs: START + 30 * DAY, symbols: ['B', 'C'] },
      ],
    });

    // 1구간 리밸런스(index20) — A 는 원 모멘텀으로도 최하위라 필터 유무와 무관하게
    // B·C 만 편입된다.
    const buys = result.fills.filter((f) => f.side === 'BUY');
    expect(new Set(buys.map((f) => f.symbol))).toEqual(new Set(['B', 'C']));

    // 2구간 전환(index30) 이후 — A 는 원 모멘텀만 보면 1위이지만 일정에서 빠져
    // 랭킹 후보에도 들지 못한다: A 매수 시도도, 그로 인한 C 매도도 일어나지 않는다.
    expect(result.fills.some((f) => f.symbol === 'A')).toBe(false);
    expect(result.fills.filter((f) => f.symbol === 'C' && f.side === 'SELL')).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('A') && w.includes('멤버십 일정'))).toBe(false);

    // topN(=2) 슬롯이 그대로 유지된다 — 필터링하지 않으면 C 가 팔리고 A 매수가
    // 거부돼 보유 종목이 1개로 줄어든다(그만큼 예산이 현금으로 논다).
    expect(result.openPositions).toHaveLength(2);
    expect(new Set(result.openPositions.map((p) => p.symbol))).toEqual(new Set(['B', 'C']));
  });
});
