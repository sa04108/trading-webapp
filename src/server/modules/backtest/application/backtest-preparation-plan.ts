import { createHash } from 'node:crypto';
import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import { computeRebalanceDates } from '../../../../shared/schemas/rebalance-interval.js';
import { CORPORATE_ACTION_ALIGNMENT_WINDOW } from '../../facts/domain/corporate-action-effective-date.js';
import { derivePreparationFactYearRange } from '../../market-data/domain/fact-year-range.js';
import { addCalendarDays } from '../../market-data/domain/kst-date.js';
import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';
import type { UniverseDataNeed } from './universe-rule-resolver.js';

/** 데이터 필요 범위의 의미가 바뀌면 완료된 이전 preparation을 재사용하지 않는다. */
export const BACKTEST_PREPARATION_PLAN_VERSION = '3.0.0';

export interface BacktestPreparationPlan {
  readonly requestHash: string;
  readonly rebalanceDates: readonly string[];
  readonly financial: {
    readonly symbols: readonly string[];
    readonly fromYear: number;
    readonly toYear: number;
  };
  readonly actions: {
    readonly symbols: readonly string[];
    readonly fromYear: number;
    readonly toYear: number;
  };
  readonly price: {
    readonly symbols: readonly string[];
    readonly from: string;
    readonly to: string;
  };
}

export function buildBacktestPreparationPlan(input: {
  readonly request: BacktestRequest;
  readonly resolutionNeeds: UniverseDataNeed;
  readonly finalUniverseSymbols?: readonly string[];
  readonly strategy: AnyTradingStrategy;
}): BacktestPreparationPlan {
  const { request, resolutionNeeds, strategy } = input;
  const finalSymbols = sortedUnique(input.finalUniverseSymbols ?? []);
  const universeLookback = request.universeRule.stages.some(
    (stage) => stage.criterion === 'PER' || stage.criterion === 'ROE',
  )
    ? 4
    : 0;
  const strategyLookback = strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0;
  const fundamentalLookbackQuarters = Math.max(universeLookback, strategyLookback);

  const financialSymbols = new Set(resolutionNeeds.factSymbols);
  if (strategyLookback > 0) for (const symbol of finalSymbols) financialSymbols.add(symbol);
  const financialRange = derivePreparationFactYearRange(
    request.period,
    fundamentalLookbackQuarters,
  );

  const priceSymbols = new Set(resolutionNeeds.priceSymbols);
  let priceRange = resolutionNeeds.priceRange;

  // HTTP 요청은 기본값 필드를 생략할 수 있다. 전략 구현이 실제로 받는 것과 같은
  // Zod 파싱 결과를 메타데이터에도 넘겨야 undefined/NaN 워밍업이 되지 않는다.
  const parsedParameters = strategy.parameterSchema.safeParse(request.parameters);
  if (!parsedParameters.success) {
    throw new Error(
      parsedParameters.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  const priceWarmupBars = strategy.dataRequirements?.priceWarmupBars?.(parsedParameters.data) ?? 0;
  const declineWarmupBars = request.universeRule.stages.reduce(
    (maximum, stage) => stage.criterion === 'DECLINE'
      ? Math.max(maximum, stage.lookbackTradingDays)
      : maximum,
    0,
  );
  if (priceWarmupBars > 0) {
    for (const symbol of finalSymbols) priceSymbols.add(symbol);
    const strategyRange = {
      from: addCalendarDays(request.period.from, -(Math.ceil(priceWarmupBars) * 2 + 14)),
      to: request.period.to,
    };
    priceRange = widenRange(priceRange, strategyRange);
  }

  const actionSymbols = new Set(resolutionNeeds.actionSymbols);
  if (strategy.dataRequirements?.requiresCorporateActions === true) {
    for (const symbol of finalSymbols) actionSymbols.add(symbol);
  }
  // Worker는 전략 워밍업뿐 아니라 DECLINE stage의 최대 lookback만큼 실제 거래일을
  // 거슬러 올라가 그 봉들에도 자본변동을 적용한다. final preparation에서는 아직
  // 정확한 거래일 달력을 알 수 없으므로 기존 가격 계획과 같은 보수적 달력 범위를 쓴다.
  const executionWarmupBars = Math.ceil(Math.max(0, priceWarmupBars, declineWarmupBars));
  const conservativeExecutionFrom = executionWarmupBars === 0
    ? request.period.from
    : addCalendarDays(request.period.from, -(executionWarmupBars * 2 + 14));
  const plannedExecutionFrom = priceRange?.from ?? request.period.from;
  const actionExecutionFrom = plannedExecutionFrom < conservativeExecutionFrom
    ? plannedExecutionFrom
    : conservativeExecutionFrom;
  const actionExecutionTo = priceRange?.to ?? request.period.to;
  // 실제 변경일 E가 엔진 입력 구간에 들어오려면 DART 기준일 R은
  // E-90일~E+30일일 수 있다. 이 인접 연도를 준비하지 않으면 raw action 자체가 없어
  // worker의 미정렬 fail-closed도 작동할 수 없다.
  const actionFrom = addCalendarDays(
    actionExecutionFrom,
    -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays,
  );
  const actionTo = addCalendarDays(
    actionExecutionTo,
    CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays,
  );

  return {
    requestHash: backtestPreparationRequestHash(request, strategy),
    rebalanceDates: computeRebalanceDates(request.period, request.universeRule.rebalanceInterval),
    financial: {
      symbols: sortedUnique(financialSymbols),
      ...financialRange,
    },
    actions: {
      symbols: sortedUnique(actionSymbols),
      fromYear: Number(actionFrom.slice(0, 4)),
      toYear: Number(actionTo.slice(0, 4)),
    },
    price: {
      symbols: sortedUnique(priceSymbols),
      from: priceRange?.from ?? request.period.from,
      to: priceRange?.to ?? request.period.to,
    },
  };
}

export function backtestPreparationRequestHash(
  request: Pick<BacktestRequest, 'period' | 'universeRule' | 'strategyId' | 'parameters'>,
  strategy: Pick<AnyTradingStrategy, 'version'>,
): string {
  const canonicalInput = {
    preparationPlanVersion: BACKTEST_PREPARATION_PLAN_VERSION,
    period: request.period,
    universeRule: request.universeRule,
    strategyId: request.strategyId,
    strategyVersion: strategy.version,
    parameters: request.parameters,
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(canonicalInput))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function widenRange(
  left: { readonly from: string; readonly to: string } | null,
  right: { readonly from: string; readonly to: string },
): { from: string; to: string } {
  if (left === null) return { ...right };
  return {
    from: left.from < right.from ? left.from : right.from,
    to: left.to > right.to ? left.to : right.to,
  };
}
