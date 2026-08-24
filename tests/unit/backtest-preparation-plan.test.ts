import { describe, expect, it } from 'vitest';
import type { BacktestRequest } from '../../src/shared/schemas/backtest-request.js';
import type { UniverseDataNeed } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';
import { buildBacktestPreparationPlan } from '../../src/server/modules/backtest/application/backtest-preparation-plan.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

const BASE_REQUEST = {
  strategyId: 'test-strategy',
  parameters: {},
  universeRule: {
    markets: ['KOSPI'],
    stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 20 }],
    rebalanceInterval: { unit: 'MONTH', value: 1 },
  },
  timeframe: '1d',
  period: { from: '2026-01-02', to: '2026-03-31' },
  capital: { initialCash: 100_000_000, currency: 'KRW' },
  execution: {
    fillTiming: 'NEXT_BAR_OPEN',
    commissionProfileId: 'default',
    slippageProfileId: 'default',
  },
  risk: { maxPositions: 40 },
  randomSeed: 42,
} satisfies BacktestRequest;

const EMPTY_NEEDS: UniverseDataNeed = {
  factSymbols: [],
  actionSymbols: [],
  priceSymbols: [],
  selectionMetricDates: [],
  priceRange: null,
};

function strategy(
  id: string,
  dataRequirements?: AnyTradingStrategy['dataRequirements'],
  version = '1.2.3',
): AnyTradingStrategy {
  return {
    id,
    version,
    name: id,
    description: id,
    parameterSchema: {
      parse: (value: unknown) => value,
      safeParse: (value: unknown) => ({ success: true, data: value }),
    },
    dataRequirements,
    initialize: () => ({}),
    onBars: () => ({ orders: [] }),
  } as unknown as AnyTradingStrategy;
}

describe('buildBacktestPreparationPlan', () => {
  it.each([
    {
      strategyId: 'range-breakout',
      financial: { symbols: [], fromYear: 2026, toYear: 2026 },
      actions: { symbols: ['000660', '005930'], fromYear: 2025, toYear: 2026 },
      price: { symbols: ['000660', '005930'], from: '2025-11-09', to: '2026-03-31' },
    },
    {
      strategyId: 'cross-sectional-momentum',
      financial: { symbols: [], fromYear: 2026, toYear: 2026 },
      actions: { symbols: ['000660', '005930'], fromYear: 2024, toYear: 2026 },
      price: { symbols: ['000660', '005930'], from: '2024-06-19', to: '2026-03-31' },
    },
    {
      strategyId: 'value-quality-rank',
      financial: { symbols: ['000660', '005930'], fromYear: 2025, toYear: 2026 },
      actions: { symbols: ['000660', '005930'], fromYear: 2025, toYear: 2026 },
      price: { symbols: [], from: '2026-01-02', to: '2026-03-31' },
    },
    {
      strategyId: 'ema-trend-switch',
      financial: { symbols: [], fromYear: 2026, toYear: 2026 },
      actions: { symbols: ['000660', '005930'], fromYear: 2025, toYear: 2026 },
      price: { symbols: ['000660', '005930'], from: '2025-08-21', to: '2026-03-31' },
    },
    {
      strategyId: 'rsi-reversion',
      financial: { symbols: [], fromYear: 2026, toYear: 2026 },
      actions: { symbols: ['000660', '005930'], fromYear: 2025, toYear: 2026 },
      price: { symbols: ['000660', '005930'], from: '2025-08-21', to: '2026-03-31' },
    },
  ])('$strategyId 실전 기본값의 final-union 데이터 요구를 계획한다', ({
    strategyId,
    financial,
    actions,
    price,
  }) => {
    const registry = new StrategyRegistry();
    const selected = registry.get(strategyId);
    expect(selected).not.toBeNull();

    const plan = buildBacktestPreparationPlan({
      request: { ...BASE_REQUEST, strategyId, parameters: {} },
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: ['005930', '000660', '005930'],
      strategy: selected!,
    });

    expect(plan.financial).toEqual(financial);
    expect(plan.actions).toEqual(actions);
    expect(plan.price).toEqual(price);
  });

  it('PER stage 후보에 4분기 재무만 준비한다', () => {
    const plan = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        universeRule: {
          ...BASE_REQUEST.universeRule,
          stages: [{ criterion: 'PER', direction: 'LOW', limit: 20 }],
        },
      },
      resolutionNeeds: { ...EMPTY_NEEDS, factSymbols: ['005930', '000660'] },
      strategy: strategy('price-only'),
    });

    expect(plan.financial).toEqual({
      symbols: ['000660', '005930'],
      fromYear: 2025,
      toYear: 2026,
    });
    expect(plan.actions.symbols).toEqual([]);
    expect(plan.price.symbols).toEqual([]);
  });

  it('ROE stage 후보에 4분기 재무를 준비한다', () => {
    const plan = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        universeRule: {
          ...BASE_REQUEST.universeRule,
          stages: [{ criterion: 'ROE', direction: 'HIGH', limit: 20 }],
        },
      },
      resolutionNeeds: { ...EMPTY_NEEDS, factSymbols: ['005930', '000660'] },
      strategy: strategy('price-only'),
    });
    expect(plan.financial).toEqual({
      symbols: ['000660', '005930'],
      fromYear: 2025,
      toYear: 2026,
    });
  });

  it('저PER·고ROE는 최종 유니버스의 4분기 재무와 자본변동을 준비한다', () => {
    const plan = buildBacktestPreparationPlan({
      request: BASE_REQUEST,
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: ['005930', '000660', '005930'],
      strategy: strategy('low-per-high-roe', {
        fundamentalLookbackQuarters: 4,
        requiresCorporateActions: true,
      }),
    });

    expect(plan.financial).toEqual({
      symbols: ['000660', '005930'],
      fromYear: 2025,
      toYear: 2026,
    });
    expect(plan.actions).toEqual({
      symbols: ['000660', '005930'],
      fromYear: 2025,
      toYear: 2026,
    });
    expect(plan.price.symbols).toEqual([]);
  });

  it.each([
    {
      period: { from: '2026-01-02', to: '2026-01-31' },
      expected: { fromYear: 2025, toYear: 2026 },
    },
    {
      period: { from: '2026-12-01', to: '2026-12-20' },
      expected: { fromYear: 2026, toYear: 2027 },
    },
  ])('정렬 후보가 기간 경계를 넘을 수 있어 $period 인접 DART 연도도 준비한다', ({
    period,
    expected,
  }) => {
    const plan = buildBacktestPreparationPlan({
      request: { ...BASE_REQUEST, period },
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: ['005930'],
      strategy: strategy('action-boundary', { requiresCorporateActions: true }),
    });

    expect(plan.actions).toEqual({ symbols: ['005930'], ...expected });
  });

  it('이익 가속은 8분기 재무와 가격 momentum, 최종 유니버스 자본변동을 준비한다', () => {
    const request = {
      ...BASE_REQUEST,
      parameters: { priceMomentumDays: 60, nested: { z: 1, a: 2 } },
    } satisfies BacktestRequest;
    const plan = buildBacktestPreparationPlan({
      request,
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: ['005930', '000660'],
      strategy: strategy('earnings-acceleration', {
        fundamentalLookbackQuarters: 8,
        priceWarmupBars: (parameters) =>
          (parameters as { priceMomentumDays: number }).priceMomentumDays,
        requiresCorporateActions: true,
      }),
    });

    expect(plan.financial).toEqual({
      symbols: ['000660', '005930'],
      fromYear: 2024,
      toYear: 2026,
    });
    expect(plan.actions.symbols).toEqual(['000660', '005930']);
    expect(plan.actions.fromYear).toBe(2025);
    expect(plan.price).toEqual({
      symbols: ['000660', '005930'],
      from: '2025-08-21',
      to: '2026-03-31',
    });
  });

  it('급하락 stage는 Task 4의 후보와 정확한 가격 범위를 그대로 준비한다', () => {
    const plan = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        universeRule: {
          ...BASE_REQUEST.universeRule,
          stages: [{ criterion: 'DECLINE', direction: 'LOW', limit: 10, lookbackTradingDays: 20 }],
        },
      },
      resolutionNeeds: {
        ...EMPTY_NEEDS,
        priceSymbols: ['035720', '005930'],
        priceRange: { from: '2025-11-09', to: '2026-01-02' },
      },
      finalUniverseSymbols: ['000660'],
      strategy: strategy('price-only'),
    });

    expect(plan.financial.symbols).toEqual([]);
    expect(plan.actions.symbols).toEqual([]);
    expect(plan.price).toEqual({
      symbols: ['005930', '035720'],
      from: '2025-11-09',
      to: '2026-01-02',
    });
  });

  it('최종 DECLINE 유니버스의 worker 워밍업까지 정렬 가능한 자본변동 연도를 준비한다', () => {
    const plan = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        universeRule: {
          ...BASE_REQUEST.universeRule,
          stages: [{ criterion: 'DECLINE', direction: 'LOW', limit: 10, lookbackTradingDays: 200 }],
        },
      },
      resolutionNeeds: EMPTY_NEEDS,
      finalUniverseSymbols: ['005930'],
      strategy: strategy('action-only', { requiresCorporateActions: true }),
    });

    expect(plan.price).toEqual({ symbols: [], ...BASE_REQUEST.period });
    expect(plan.actions).toEqual({
      symbols: ['005930'],
      fromYear: 2024,
      toYear: 2026,
    });
  });

  it('hash는 canonical data 필요 필드만 포함하고 객체 키 순서에는 무관하다', () => {
    const strategyUnderTest = strategy('hash-strategy');
    const first = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        parameters: { b: 2, nested: { z: true, a: false }, a: 1 },
      },
      resolutionNeeds: EMPTY_NEEDS,
      strategy: strategyUnderTest,
    });
    const second = buildBacktestPreparationPlan({
      request: {
        ...BASE_REQUEST,
        parameters: { a: 1, nested: { a: false, z: true }, b: 2 },
        capital: { ...BASE_REQUEST.capital, initialCash: 999 },
        execution: {
          ...BASE_REQUEST.execution,
          commissionProfileId: 'expensive',
          slippageProfileId: 'wide',
        },
        risk: { maxPositions: 1 },
        randomSeed: 999,
      },
      resolutionNeeds: EMPTY_NEEDS,
      strategy: strategyUnderTest,
    });

    expect(second.requestHash).toBe(first.requestHash);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rebalanceDates).toEqual(['2026-01-02', '2026-02-02', '2026-03-02']);
  });

  it('hash는 데이터 필요량을 바꾸는 다섯 canonical 필드를 모두 포함한다', () => {
    const baseStrategy = strategy('hash-strategy');
    const hash = (
      request: BacktestRequest,
      selectedStrategy: AnyTradingStrategy = baseStrategy,
    ): string => buildBacktestPreparationPlan({
      request,
      resolutionNeeds: EMPTY_NEEDS,
      strategy: selectedStrategy,
    }).requestHash;
    const baseline = hash(BASE_REQUEST);

    expect(new Set([
      hash({ ...BASE_REQUEST, period: { ...BASE_REQUEST.period, to: '2026-04-30' } }),
      hash({
        ...BASE_REQUEST,
        universeRule: {
          ...BASE_REQUEST.universeRule,
          stages: [{ criterion: 'MARKET_CAP', direction: 'HIGH', limit: 19 }],
        },
      }),
      hash({ ...BASE_REQUEST, strategyId: 'another-strategy' }),
      hash(BASE_REQUEST, strategy('hash-strategy', undefined, '1.2.4')),
      hash({ ...BASE_REQUEST, parameters: { threshold: 1 } }),
    ])).not.toContain(baseline);
  });
});
