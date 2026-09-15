import { setImmediate } from 'node:timers/promises';
import type { FactQuery, FactRepository } from '../../facts/application/ports.js';
import type { CandleCoverageService } from '../../market-data/application/candle-coverage-service.js';
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

interface FundamentalCheckpoint extends IncompleteFundamentalCheckpoint {
  readonly tsMs: number;
}

const FACT_SYMBOL_BATCH_SIZE = 32;
const DAY_MS = 86_400_000;

interface CoverageReadinessInput {
  readonly strategy: AnyTradingStrategy;
  readonly parameters: unknown;
  readonly period: { readonly from: string; readonly to: string };
  readonly schedule: readonly FinancialReadinessScheduleEntry[];
  readonly candles: Pick<CandleCoverageService, 'getCoverageBetween'>;
  readonly throwIfStopped?: () => void;
}

interface ReadinessBatch {
  readonly query: FactQuery;
  readonly checkpoints: readonly FundamentalCheckpoint[];
}

/** SQL 집계와 종목 묶음 사이에 취소 IPC를 처리하고 이전 facts와 PIT 뷰를 해제한다. */
export async function findIncompleteFundamentalCheckpointsFromCoverage(
  input: CoverageReadinessInput & { readonly facts: Pick<FactRepository, 'getFacts'> },
): Promise<IncompleteFundamentalCheckpoint[]> {
  if (input.strategy.dataRequirements?.fundamentalsReady === undefined) return [];
  const parameters = input.strategy.parameterSchema.parse(input.parameters);
  const incomplete: IncompleteFundamentalCheckpoint[] = [];
  for (const batch of readinessBatches(input)) {
    if (batch !== null) incomplete.push(...await evaluateBatch(batch));
    await setImmediate();
  }
  input.throwIfStopped?.();
  return incomplete.sort((left, right) => left.symbol.localeCompare(right.symbol));

  async function evaluateBatch(batch: ReadinessBatch): Promise<IncompleteFundamentalCheckpoint[]> {
    const facts = await input.facts.getFacts(batch.query);
    input.throwIfStopped?.();
    return evaluateCheckpoints(input.strategy, parameters, facts, batch.checkpoints);
  }
}

/** 동기 큐 승격 관문도 같은 SQL 집계와 종목별 메모리 상한을 적용한다. */
export function findIncompleteFundamentalCheckpointsFromCoverageSync(
  input: CoverageReadinessInput & { readonly readFacts: (query: FactQuery) => readonly Fact[] },
): IncompleteFundamentalCheckpoint[] {
  if (input.strategy.dataRequirements?.fundamentalsReady === undefined) return [];
  const parameters = input.strategy.parameterSchema.parse(input.parameters);
  const incomplete: IncompleteFundamentalCheckpoint[] = [];
  for (const batch of readinessBatches(input)) {
    if (batch === null) continue;
    incomplete.push(...evaluateCheckpoints(
      input.strategy, parameters, input.readFacts(batch.query), batch.checkpoints,
    ));
  }
  return incomplete.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

/** 전체 날짜 대신 첫 실행일만 보존한다. null은 비동기 호출자의 이벤트 루프 양보 지점이다. */
function* readinessBatches(input: CoverageReadinessInput): Generator<ReadinessBatch | null> {
  const schedule = [...input.schedule].sort((left, right) => (
    left.rebalanceDate.localeCompare(right.rebalanceDate)
  ));
  const checkpointsBySymbol = new Map<string, FundamentalCheckpoint[]>();
  const periodFrom = Date.parse(`${input.period.from}T00:00:00Z`);
  const periodTo = Date.parse(`${input.period.to}T00:00:00Z`);
  for (let index = 0; index < schedule.length; index += 1) {
    input.throwIfStopped?.();
    if (index % 16 === 15) yield null;
    input.throwIfStopped?.();
    const entry = schedule[index]!;
    const next = schedule[index + 1];
    const from = Math.max(periodFrom, Date.parse(`${entry.rebalanceDate}T00:00:00Z`));
    const to = next === undefined ? periodTo : Math.min(
      periodTo, Date.parse(`${next.rebalanceDate}T00:00:00Z`) - DAY_MS,
    );
    if (from > to || entry.symbols.length === 0) continue;
    // 집계 결과는 구간 길이에 관계없이 종목 수 이하의 행만 반환한다.
    const coverage = input.candles.getCoverageBetween([...new Set(entry.symbols)], from, to);
    let executionTsMs = Number.POSITIVE_INFINITY;
    for (const row of coverage) {
      if (row.firstTsMs !== null) executionTsMs = Math.min(executionTsMs, row.firstTsMs);
    }
    if (!Number.isFinite(executionTsMs)) continue;
    const date = new Date(executionTsMs).toISOString().slice(0, 10);
    for (const row of coverage) {
      if (row.firstTsMs !== executionTsMs) continue;
      const checkpoints = checkpointsBySymbol.get(row.code) ?? [];
      checkpoints.push({ symbol: row.code, date, tsMs: executionTsMs });
      checkpointsBySymbol.set(row.code, checkpoints);
    }
  }

  const symbols = [...checkpointsBySymbol.keys()].sort();
  for (let offset = 0; offset < symbols.length; offset += FACT_SYMBOL_BATCH_SIZE) {
    input.throwIfStopped?.();
    const keys = symbols.slice(offset, offset + FACT_SYMBOL_BATCH_SIZE);
    const checkpoints = keys.flatMap((symbol) => checkpointsBySymbol.get(symbol)!);
    let asOfMaxTsMs = Number.NEGATIVE_INFINITY;
    for (const checkpoint of checkpoints) asOfMaxTsMs = Math.max(asOfMaxTsMs, checkpoint.tsMs);
    yield { query: { scope: 'SYMBOL', keys, asOfMaxTsMs }, checkpoints };
  }
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
  const checkpoints = new Map<string, FundamentalCheckpoint>();

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

  return evaluateCheckpoints(input.strategy, parameters, input.facts, [...checkpoints.values()]);
}

/** 메모리 입력을 가진 worker와 SQL 집계 경로가 같은 PIT 판정 규칙을 사용한다. */
function evaluateCheckpoints(
  strategy: AnyTradingStrategy,
  parameters: unknown,
  facts: readonly Fact[],
  checkpoints: readonly FundamentalCheckpoint[],
): IncompleteFundamentalCheckpoint[] {
  const fundamentalsReady = strategy.dataRequirements!.fundamentalsReady!;
  const view = new PitFactView(facts);
  const firstIncomplete = new Map<string, IncompleteFundamentalCheckpoint>();
  const readySymbols = new Set<string>();
  for (const checkpoint of [...checkpoints].sort((left, right) => (
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
