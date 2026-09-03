import type { Fact } from '../../facts/domain/fact.js';
import { PitFactView } from '../../facts/domain/pit-fact-view.js';
import type { AnyTradingStrategy } from '../../strategy/domain/strategy.js';

export interface FinancialReadinessScheduleEntry {
  readonly rebalanceDate: string;
  readonly symbols: readonly string[];
}

export interface IncompleteFundamentalCheckpoint {
  readonly symbol: string;
  readonly date: string;
}

/**
 * 엔진이 리밸런스를 실행하는 첫 실제 봉마다 전략의 최소 PIT 재무 입력을 확인한다.
 * 해당 봉이 없는 종목은 그 리밸런스에서 tradable 후보가 아니므로 검사하지 않는다.
 *
 * 상장 직후나 첫 공시 전처럼 초반 checkpoint만 준비되지 않은 것은 정상적인 PIT 상태다.
 * 실제 편입 구간에서 한 번도 완전한 입력을 만들 수 없는 종목만 API 정보 결손으로 보고
 * 전 기간 제외한다.
 */
export function findIncompleteFundamentalCheckpoints(input: {
  readonly strategy: AnyTradingStrategy;
  readonly parameters: unknown;
  readonly facts: readonly Fact[];
  readonly schedule: readonly FinancialReadinessScheduleEntry[];
  readonly validDatesBySymbol: ReadonlyMap<string, readonly string[]>;
}): IncompleteFundamentalCheckpoint[] {
  const fundamentalsReady = input.strategy.dataRequirements?.fundamentalsReady;
  if (fundamentalsReady === undefined) return [];
  const parameters = input.strategy.parameterSchema.parse(input.parameters);
  const datesBySymbol = new Map(
    [...input.validDatesBySymbol].map(([symbol, dates]) => [
      symbol,
      [...new Set(dates)].sort(),
    ] as const),
  );
  const dateSetsBySymbol = new Map(
    [...datesBySymbol].map(([symbol, dates]) => [symbol, new Set(dates)] as const),
  );
  const schedule = [...input.schedule].sort((left, right) => (
    left.rebalanceDate.localeCompare(right.rebalanceDate)
  ));
  const checkpoints = new Map<string, IncompleteFundamentalCheckpoint & { readonly tsMs: number }>();

  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index]!;
    const nextDate = schedule[index + 1]?.rebalanceDate;
    let executionDate: string | undefined;
    for (const symbol of entry.symbols) {
      const candidate = firstDateOnOrAfter(
        datesBySymbol.get(symbol) ?? [],
        entry.rebalanceDate,
      );
      if (candidate === undefined || (nextDate !== undefined && candidate >= nextDate)) continue;
      if (executionDate === undefined || candidate < executionDate) executionDate = candidate;
    }
    if (executionDate === undefined) continue;
    const tsMs = Date.parse(`${executionDate}T00:00:00Z`);
    for (const symbol of entry.symbols) {
      if (dateSetsBySymbol.get(symbol)?.has(executionDate) !== true) continue;
      checkpoints.set(`${tsMs}\0${symbol}`, { symbol, date: executionDate, tsMs });
    }
  }

  const view = new PitFactView(input.facts);
  const firstIncomplete = new Map<string, IncompleteFundamentalCheckpoint>();
  const readySymbols = new Set<string>();
  for (const checkpoint of [...checkpoints.values()].sort((left, right) => (
    left.tsMs - right.tsMs || left.symbol.localeCompare(right.symbol)
  ))) {
    view.advanceTo(checkpoint.tsMs);
    const snapshot = view.fundamentals(checkpoint.symbol);
    if (snapshot !== null && fundamentalsReady(snapshot, checkpoint.tsMs, parameters)) {
      readySymbols.add(checkpoint.symbol);
      continue;
    }
    if (!firstIncomplete.has(checkpoint.symbol)) {
      firstIncomplete.set(checkpoint.symbol, {
        symbol: checkpoint.symbol,
        date: checkpoint.date,
      });
    }
  }
  return [...firstIncomplete.values()]
    .filter((checkpoint) => !readySymbols.has(checkpoint.symbol))
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function firstDateOnOrAfter(dates: readonly string[], target: string): string | undefined {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dates[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return dates[low];
}
