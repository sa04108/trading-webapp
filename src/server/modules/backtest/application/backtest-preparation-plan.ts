import { createHash } from 'node:crypto';
import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import { computeRebalanceDates } from '../../../../shared/schemas/rebalance-interval.js';
import { derivePreparationFactYearRange } from '../../market-data/domain/fact-year-range.js';
import { addCalendarDays } from '../../market-data/domain/kst-date.js';
import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';
import type { UniverseDataNeed } from './universe-rule-resolver.js';

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
  const universeLookback = request.universeRule.stages.some((stage) => stage.criterion === 'PER')
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

  const priceWarmupBars = strategy.dataRequirements?.priceWarmupBars?.(request.parameters) ?? 0;
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
  const actionFrom = priceRange?.from ?? request.period.from;
  const actionTo = priceRange?.to ?? request.period.to;

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
