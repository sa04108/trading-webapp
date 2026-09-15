import type { BacktestRequest } from '../../../../shared/schemas/backtest-request.js';
import type {
  CandleCoverageService,
  CandleTimeWindow,
} from '../../market-data/application/candle-coverage-service.js';
import type { Candle } from '../../market-data/domain/candle.js';
import type { LegacyUniverseScheduleEntry } from './universe-rule-resolver.js';

/** 종목별로 전략이 실제 봉과 재무를 함께 볼 수 있는 닫힌 UTC 시각 구간. */
export type FinancialExecutionWindows = ReadonlyMap<string, readonly CandleTimeWindow[]>;

export function delistedEventsToTsMsBySymbol(
  events: readonly { readonly shortCode: string; readonly effectiveDate: string }[],
): ReadonlyMap<string, readonly number[]> {
  const result = new Map<string, number[]>();
  for (const event of events) {
    const tsMs = Date.parse(`${event.effectiveDate}T00:00:00Z`);
    if (!Number.isFinite(tsMs)) continue;
    const current = result.get(event.shortCode) ?? [];
    current.push(tsMs);
    result.set(event.shortCode, current);
  }
  return result;
}

/**
 * 엔진과 같은 멤버십 활성화·최초 폐지 규칙으로 종목별 실행 창을 만든다.
 * 첫 schedule entry는 엔진처럼 첫 activation 전에도 활성으로 보되 결과 기간 밖은 자른다.
 */
export function buildFinancialExecutionWindows(input: {
  readonly period: BacktestRequest['period'];
  readonly schedule: readonly Pick<LegacyUniverseScheduleEntry, 'rebalanceDate' | 'symbols'>[];
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, readonly number[]>;
}): FinancialExecutionWindows {
  const periodFromTsMs = Date.parse(`${input.period.from}T00:00:00Z`);
  const periodToTsMs = Date.parse(`${input.period.to}T00:00:00Z`);
  const schedule = input.schedule
    .map((entry) => ({
      activationTsMs: Date.parse(`${entry.rebalanceDate}T00:00:00Z`),
      symbols: [...new Set(entry.symbols)],
    }))
    .filter((entry) => Number.isFinite(entry.activationTsMs))
    .sort((left, right) => left.activationTsMs - right.activationTsMs);
  if (schedule.length === 0 || periodFromTsMs > periodToTsMs) return new Map();

  const firstDelistedTsMsBySymbol = new Map<string, number>();
  for (const [symbol, events] of input.delistedTsMsBySymbol ?? []) {
    for (const eventTsMs of events) {
      if (!Number.isFinite(eventTsMs)) continue;
      const existing = firstDelistedTsMsBySymbol.get(symbol);
      if (existing === undefined || eventTsMs < existing) {
        firstDelistedTsMsBySymbol.set(symbol, eventTsMs);
      }
    }
  }

  const mutable = new Map<string, CandleTimeWindow[]>();
  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index]!;
    const next = schedule[index + 1];
    const segmentFromTsMs = index === 0
      ? periodFromTsMs
      : Math.max(periodFromTsMs, entry.activationTsMs);
    const segmentToTsMs = Math.min(
      periodToTsMs,
      next === undefined ? periodToTsMs : next.activationTsMs - 1,
    );
    if (segmentFromTsMs > segmentToTsMs) continue;

    for (const symbol of entry.symbols) {
      const delistedTsMs = firstDelistedTsMsBySymbol.get(symbol);
      const executableToTsMs = delistedTsMs === undefined
        ? segmentToTsMs
        : Math.min(segmentToTsMs, delistedTsMs - 1);
      if (segmentFromTsMs > executableToTsMs) continue;
      const windows = mutable.get(symbol) ?? [];
      const previous = windows.at(-1);
      if (previous !== undefined && previous.toTsMs + 1 >= segmentFromTsMs) {
        windows[windows.length - 1] = {
          fromTsMs: previous.fromTsMs,
          toTsMs: Math.max(previous.toTsMs, executableToTsMs),
        };
      } else {
        windows.push({ fromTsMs: segmentFromTsMs, toTsMs: executableToTsMs });
      }
      mutable.set(symbol, windows);
    }
  }
  return mutable;
}

/** 서버 경로: 실행 창 안의 마지막 유효 DB 일봉을 종목별 PIT cutoff로 쓴다. */
export function financialFactCutoffsFromCoverage(input: {
  readonly period: BacktestRequest['period'];
  readonly schedule: readonly Pick<LegacyUniverseScheduleEntry, 'rebalanceDate' | 'symbols'>[];
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, readonly number[]>;
  readonly candles: Pick<CandleCoverageService, 'getLastTsInWindows'>;
}): ReadonlyMap<string, number> {
  return input.candles.getLastTsInWindows(buildFinancialExecutionWindows(input));
}

/** worker 경로: 실제 로드된 봉 중 실행 창 안의 마지막 봉을 종목별 PIT cutoff로 쓴다. */
export function financialFactCutoffsFromCandles(input: {
  readonly period: BacktestRequest['period'];
  readonly schedule: readonly Pick<LegacyUniverseScheduleEntry, 'rebalanceDate' | 'symbols'>[];
  readonly delistedTsMsBySymbol?: ReadonlyMap<string, readonly number[]>;
  readonly candles: readonly Candle[];
}): ReadonlyMap<string, number> {
  const windows = buildFinancialExecutionWindows(input);
  const result = new Map<string, number>();
  for (const candle of input.candles) {
    const symbolWindows = windows.get(candle.symbol);
    if (symbolWindows === undefined || !containsTs(symbolWindows, candle.tsMs)) continue;
    const existing = result.get(candle.symbol);
    if (existing === undefined || candle.tsMs > existing) result.set(candle.symbol, candle.tsMs);
  }
  return result;
}

function containsTs(windows: readonly CandleTimeWindow[], tsMs: number): boolean {
  let low = 0;
  let high = windows.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const window = windows[middle]!;
    if (tsMs < window.fromTsMs) high = middle - 1;
    else if (tsMs > window.toTsMs) low = middle + 1;
    else return true;
  }
  return false;
}
