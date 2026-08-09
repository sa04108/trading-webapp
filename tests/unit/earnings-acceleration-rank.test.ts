import { describe, expect, it } from 'vitest';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import { createRng } from '../../src/server/modules/backtest/domain/seeded-rng.js';
import type { ExecutionProfile, Position } from '../../src/server/modules/backtest/domain/types.js';
import type {
  Fact,
  FundamentalSnapshot,
} from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import {
  earningsAccelerationRankParameters,
  earningsAccelerationRankStrategy,
} from '../../src/server/modules/strategy/strategies/earnings-acceleration-rank.js';
import {
  combineRanks,
  isFreshQuarter,
  ordinalRank,
  scoreEarningsAcceleration,
  type EarningsAccelerationInput,
} from '../../src/server/modules/strategy/strategies/shared/fundamental-rank.js';

const DAY = 86_400_000;
const AT = Date.UTC(2025, 0, 2);

const BASE: EarningsAccelerationInput = {
  q0: 40,
  q1: 30,
  q2: 20,
  q3: 10,
  q4: 20,
  q5: 20,
  q6: 20,
  q7: 20,
  priceMomentum: 0.2,
};

function periodKeyAtOffset(offset: number): string {
  const ordinal = 2024 * 4 + 3 - offset;
  return `${Math.floor(ordinal / 4)}Q${(ordinal % 4) + 1}`;
}

function snapshotFor(input: EarningsAccelerationInput): FundamentalSnapshot {
  const values = [input.q0, input.q1, input.q2, input.q3, input.q4, input.q5, input.q6, input.q7];
  return {
    latestPeriodKey: '2024Q4',
    latestAsOfTsMs: AT,
    get: (field) => (field === 'OPERATING_INCOME' ? input.q0 : null),
    quarter: (field, offset = 0) => {
      const value = values[offset];
      return field === 'OPERATING_INCOME' && value !== undefined
        ? { periodKey: periodKeyAtOffset(offset), value }
        : null;
    },
    ttm: (field, endOffset = 0) => {
      if (field !== 'OPERATING_INCOME') return null;
      const window = values.slice(endOffset, endOffset + 4);
      return window.length === 4 ? window.reduce((sum, value) => sum + value, 0) : null;
    },
    periodKeyOf: (field) => (field === 'OPERATING_INCOME' ? '2024Q4' : null),
  };
}

function history(symbol: string, start: number, end: number): Candle[] {
  return Array.from({ length: 61 }, (_, index) => {
    const close = start + ((end - start) * index) / 60;
    return {
      symbol,
      market: 'KR',
      timeframe: '1d',
      tsMs: AT - (60 - index) * DAY,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    };
  });
}

function strategyContext(input: {
  inputs: Readonly<Record<string, EarningsAccelerationInput>>;
  histories: ReadonlyMap<string, readonly Candle[]>;
  isRebalanceBar: boolean;
  tsMs?: number;
  positions?: ReadonlyMap<string, Position>;
  actions?: ReadonlyMap<string, readonly { effectiveTsMs: number; ratio: number }[]>;
}): StrategyBarContext {
  const bars = new Map<string, Candle>();
  for (const [symbol, candles] of input.histories) {
    const latest = candles[candles.length - 1];
    if (latest) bars.set(symbol, latest);
  }
  return {
    tsMs: input.tsMs ?? AT,
    isRebalanceBar: input.isRebalanceBar,
    bars,
    getHistory: (symbol) => input.histories.get(symbol) ?? [],
    portfolio: {
      cash: 10_000,
      equity: 10_000,
      positions: input.positions ?? new Map(),
    },
    rng: createRng(1),
    fundamentals: (symbol) => {
      const candidate = input.inputs[symbol];
      return candidate ? snapshotFor(candidate) : null;
    },
    corporateActions: (symbol) => input.actions?.get(symbol) ?? [],
    tradableSymbols: new Set(Object.keys(input.inputs)),
    selectionMetric: () => null,
  };
}

describe('scoreEarningsAcceleration', () => {
  it('TTM 성장과 가격 모멘텀을 계산한다', () => {
    expect(scoreEarningsAcceleration(BASE)).toEqual({ ttmGrowth: 0.25, priceMomentum: 0.2 });
  });

  it.each(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'] as const)(
    '%s가 0 이하면 다른 조건이 좋아도 제외한다',
    (field) => {
      expect(scoreEarningsAcceleration({ ...BASE, [field]: field === 'q0' ? -1 : 0 })).toBeNull();
    },
  );

  it('현재 TTM이 전년 TTM보다 성장하지 않으면 제외한다', () => {
    expect(
      scoreEarningsAcceleration({ ...BASE, q0: 25, q1: 20, q2: 15, q3: 10 }),
    ).toBeNull();
  });

  it('최신 분기 YoY가 직전 분기 YoY보다 가속하지 않으면 제외한다', () => {
    expect(scoreEarningsAcceleration({ ...BASE, q0: 22, q1: 30, q2: 30, q3: 30 })).toBeNull();
  });

  it('가격 모멘텀이 0 이하면 제외한다', () => {
    expect(scoreEarningsAcceleration({ ...BASE, priceMomentum: 0 })).toBeNull();
    expect(scoreEarningsAcceleration({ ...BASE, priceMomentum: -0.01 })).toBeNull();
  });

  it('NaN과 Infinity를 순위에 넣지 않는다', () => {
    expect(scoreEarningsAcceleration({ ...BASE, q3: Number.NaN })).toBeNull();
    expect(scoreEarningsAcceleration({ ...BASE, priceMomentum: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('재무 공시 분기 freshness', () => {
  it('KST 유효 분기와 staleQuarters의 포함 경계를 쓴다', () => {
    // 2025-04-01 00:00 KST부터 Q2다. 2024Q4는 정확히 두 분기 전이라 포함된다.
    const q2StartKst = Date.UTC(2025, 2, 31, 15, 0);
    expect(isFreshQuarter('2024Q4', q2StartKst, 2)).toBe(true);
    expect(isFreshQuarter('2024Q3', q2StartKst, 2)).toBe(false);
    expect(isFreshQuarter('2025Q2', q2StartKst, 0)).toBe(true);
  });

  it('잘못된 분기와 유효 분기보다 미래인 분기는 거부한다', () => {
    expect(isFreshQuarter(null, AT, 2)).toBe(false);
    expect(isFreshQuarter('2024FY', AT, 2)).toBe(false);
    expect(isFreshQuarter('2025Q2', AT, 8)).toBe(false);
  });
});

describe('ordinal rank 결합', () => {
  const rows = [
    { symbol: 'AAA', growth: 0.8, momentum: 0.1 },
    { symbol: 'BBB', growth: 0.6, momentum: 0.3 },
    { symbol: 'CCC', growth: 0.2, momentum: 0.4 },
    { symbol: 'DDD', growth: 0.4, momentum: 0.2 },
  ];

  it('각 지표의 ordinal 합이 작은 종목을 고르고 최종 동점은 코드 순으로 깬다', () => {
    const growth = ordinalRank(rows, (row) => row.growth, 'DESC', (row) => row.symbol);
    const momentum = ordinalRank(rows, (row) => row.momentum, 'DESC', (row) => row.symbol);
    expect(combineRanks(rows, [growth, momentum], (row) => row.symbol).map((row) => row.symbol)).toEqual([
      'BBB',
      'AAA',
      'CCC',
      'DDD',
    ]);
  });

  it('지표 동점도 같은 순위를 공유하지 않고 코드 순으로 ordinal을 부여한다', () => {
    const tied = [
      { symbol: 'B', value: 1 },
      { symbol: 'A', value: 1 },
    ];
    const ranks = ordinalRank(tied, (row) => row.value, 'DESC', (row) => row.symbol);
    expect(ranks.get(tied[1] as (typeof tied)[number])).toBe(1);
    expect(ranks.get(tied[0] as (typeof tied)[number])).toBe(2);
  });
});

describe('이익 가속 전략', () => {
  it('스키마와 준비 데이터 요구가 정확하다', () => {
    expect(earningsAccelerationRankParameters.parse({})).toEqual({
      topN: 40,
      priceMomentumDays: 126,
      staleQuarters: 2,
    });
    expect(earningsAccelerationRankParameters.safeParse({ topN: 200, staleQuarters: 0 }).success).toBe(true);
    expect(earningsAccelerationRankParameters.safeParse({ topN: 201 }).success).toBe(false);
    expect(earningsAccelerationRankParameters.safeParse({ priceMomentumDays: 59 }).success).toBe(false);
    expect(earningsAccelerationRankParameters.safeParse({ priceMomentumDays: 253 }).success).toBe(false);
    expect(earningsAccelerationRankParameters.safeParse({ staleQuarters: 9 }).success).toBe(false);
    expect(earningsAccelerationRankStrategy.dataRequirements?.fundamentalLookbackQuarters).toBe(8);
    expect(
      earningsAccelerationRankStrategy.dataRequirements?.priceWarmupBars?.({
        topN: 40,
        priceMomentumDays: 60,
        staleQuarters: 2,
      }),
    ).toBe(60);
    expect(earningsAccelerationRankStrategy.dataRequirements?.requiresCorporateActions).toBe(true);
  });

  it('모든 재무·가격 조건을 통과한 종목만 실제 두 단계 리밸런스로 매수한다', () => {
    const inputs = {
      FAST_GROWTH: BASE,
      NEGATIVE_QUARTER: { ...BASE, q0: -1 },
      NO_ACCELERATION: { ...BASE, q0: 22, q1: 30, q2: 30, q3: 30 },
      NO_PRICE_CONFIRMATION: BASE,
    };
    const histories = new Map<string, readonly Candle[]>([
      ['FAST_GROWTH', history('FAST_GROWTH', 100, 130)],
      ['NEGATIVE_QUARTER', history('NEGATIVE_QUARTER', 100, 140)],
      ['NO_ACCELERATION', history('NO_ACCELERATION', 100, 150)],
      ['NO_PRICE_CONFIRMATION', history('NO_PRICE_CONFIRMATION', 100, 100)],
    ]);
    const state = earningsAccelerationRankStrategy.initialize({
      symbols: Object.keys(inputs),
      initialCash: 10_000,
      rng: createRng(1),
    });
    const parameters = { topN: 1, priceMomentumDays: 60, staleQuarters: 2 };

    expect(
      earningsAccelerationRankStrategy.onBars(
        strategyContext({ inputs, histories, isRebalanceBar: true }),
        state,
        parameters,
      ).orders,
    ).toEqual([]);
    const buyDecision = earningsAccelerationRankStrategy.onBars(
      strategyContext({ inputs, histories, isRebalanceBar: false }),
      state,
      parameters,
    );
    expect(buyDecision.orders.map((order) => order.symbol)).toEqual(['FAST_GROWTH']);
    expect(buyDecision.orders[0]).toMatchObject({ side: 'BUY', quantity: 76 });
  });

  it('실제 후보 선택도 성장률과 가격 모멘텀 ordinal 합을 쓰고 최종 동점은 코드 순이다', () => {
    const inputAtGrowth = (growth: number): EarningsAccelerationInput => ({
      ...BASE,
      q0: 20 + 80 * growth,
      q1: 20,
      q2: 20,
      q3: 20,
    });
    const inputs = {
      AAA: inputAtGrowth(0.8),
      BBB: inputAtGrowth(0.6),
      CCC: inputAtGrowth(0.2),
      DDD: inputAtGrowth(0.4),
    };
    const histories = new Map<string, readonly Candle[]>([
      ['AAA', history('AAA', 100, 110)],
      ['BBB', history('BBB', 100, 130)],
      ['CCC', history('CCC', 100, 140)],
      ['DDD', history('DDD', 100, 120)],
    ]);
    const state = earningsAccelerationRankStrategy.initialize({
      symbols: Object.keys(inputs),
      initialCash: 10_000,
      rng: createRng(1),
    });
    const parameters = { topN: 2, priceMomentumDays: 60, staleQuarters: 2 };
    earningsAccelerationRankStrategy.onBars(
      strategyContext({ inputs, histories, isRebalanceBar: true }),
      state,
      parameters,
    );
    const buy = earningsAccelerationRankStrategy.onBars(
      strategyContext({ inputs, histories, isRebalanceBar: false }),
      state,
      parameters,
    );
    // 합: BBB 4 < AAA 5 = CCC 5 < DDD 6 — 2위 동점은 코드가 앞선 AAA다.
    expect(buy.orders.map((order) => order.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('영업이익 최신 분기가 staleQuarters를 넘겨 뒤처지면 실제 후보에서 제외한다', () => {
    const inputs = { STALE: BASE };
    const histories = new Map([['STALE', history('STALE', 100, 130)]]);
    const state = earningsAccelerationRankStrategy.initialize({
      symbols: ['STALE'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    const staleContext = strategyContext({
      inputs,
      histories,
      isRebalanceBar: true,
      tsMs: Date.UTC(2025, 9, 1),
    });
    expect(
      earningsAccelerationRankStrategy.onBars(
        staleContext,
        state,
        { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
      ).orders,
    ).toEqual([]);
    expect(state.pendingBuys).toBeNull();
  });

  it('리밸런스 봉이 아니고 대기 매수도 없으면 주문을 내지 않는다', () => {
    const inputs = { FAST_GROWTH: BASE };
    const histories = new Map([['FAST_GROWTH', history('FAST_GROWTH', 100, 130)]]);
    const state = earningsAccelerationRankStrategy.initialize({
      symbols: ['FAST_GROWTH'],
      initialCash: 10_000,
      rng: createRng(1),
    });
    const decision = earningsAccelerationRankStrategy.onBars(
      strategyContext({ inputs, histories, isRebalanceBar: false }),
      state,
      { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
    );
    expect(decision.orders).toEqual([]);
  });

  it('분할보정 가격 수익률을 써서 원시 가격의 거짓 하락을 후보 탈락으로 오인하지 않는다', () => {
    const splitHistory = history('SPLIT', 200, 120);
    const splitAt = (splitHistory[30] as Candle).tsMs;
    const inputs = { SPLIT: BASE };
    const histories = new Map([['SPLIT', splitHistory]]);
    const state = earningsAccelerationRankStrategy.initialize({
      symbols: ['SPLIT'],
      initialCash: 12_000,
      rng: createRng(1),
    });
    const context = strategyContext({
      inputs,
      histories,
      isRebalanceBar: true,
      actions: new Map([['SPLIT', [{ effectiveTsMs: splitAt, ratio: 2 }]]]),
    });
    earningsAccelerationRankStrategy.onBars(
      context,
      state,
      { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
    );
    const buy = earningsAccelerationRankStrategy.onBars(
      { ...context, isRebalanceBar: false },
      state,
      { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
    );
    expect(buy.orders.map((order) => order.symbol)).toEqual(['SPLIT']);
  });
});

describe('이익 가속 PIT 공시 경계', () => {
  const START = Date.UTC(2025, 0, 1);
  const REBALANCE = START + 60 * DAY;
  const ZERO_COST: ExecutionProfile = {
    cost: { id: 'zero', version: '1', buyCommissionRate: 0, sellCommissionRate: 0, sellTaxRate: 0 },
    slippage: { id: 'zero', version: '1', bps: 0, fixed: 0 },
    rules: { tickSize: 0, minOrderQty: 1 },
  };

  function candles(): Candle[] {
    return Array.from({ length: 64 }, (_, index) => {
      const close = 100 + index;
      return {
        symbol: 'FAST',
        market: 'KR',
        timeframe: '1d',
        tsMs: START + index * DAY,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000,
      };
    });
  }

  function facts(asOfTsMs: number): Fact[] {
    return [40, 30, 20, 10, 20, 20, 20, 20].map((value, offset) => ({
      scope: 'SYMBOL' as const,
      key: 'FAST',
      field: 'OPERATING_INCOME' as const,
      periodKey: periodKeyAtOffset(offset),
      asOfTsMs,
      value,
      unit: 'KRW',
    }));
  }

  function run(asOfTsMs: number) {
    return runBacktest(earningsAccelerationRankStrategy, {
      candles: candles(),
      initialCash: 10_000,
      execution: ZERO_COST,
      parameters: { topN: 1, priceMomentumDays: 60, staleQuarters: 2 },
      randomSeed: 1,
      maxPositions: 1,
      facts: facts(asOfTsMs),
      universeSchedule: [{ fromTsMs: REBALANCE, symbols: ['FAST'] }],
    });
  }

  it('리밸런스 시각 1ms 뒤 공시는 미래라 볼 수 없다', () => {
    expect(run(REBALANCE + 1).fills).toEqual([]);
  });

  it('리밸런스 시각과 같은 공시는 보이고 매수는 그 이후 봉에서만 체결된다', () => {
    const buys = run(REBALANCE).fills.filter((fill) => fill.side === 'BUY');
    expect(buys).toHaveLength(1);
    expect(buys[0]?.tsMs).toBeGreaterThan(REBALANCE);
  });
});
