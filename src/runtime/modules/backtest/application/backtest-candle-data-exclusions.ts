import type { BacktestDataExclusion } from './backtest-data-exclusion.js';
import { UniverseResolutionCancelledError } from './universe-rule-resolver.js';

const MAX_BATCH_CALENDAR_DAYS = 31;
const DAY_MS = 86_400_000;

interface CandleScheduleEntry {
  readonly fromTsMs: number;
  readonly members: readonly { readonly symbol: string }[];
}

interface DelistedEvent {
  readonly shortCode: string;
  readonly effectiveDate: string;
}

interface NonTradingDay {
  readonly shortCode: string;
  readonly date: string;
}

export interface CandleDataExclusionInput {
  readonly period: { readonly from: string; readonly to: string };
  readonly schedule: readonly CandleScheduleEntry[];
  readonly tradingDays: readonly string[];
  readonly delistedEvents: readonly DelistedEvent[];
  readonly readValidDates: (
    codes: readonly string[],
    from: string,
    to: string,
  ) => ReadonlyMap<string, readonly string[]>;
  readonly readNonTradingDays: (
    from: string,
    to: string,
    codes: readonly string[],
  ) => readonly NonTradingDay[];
  readonly shouldStop?: () => boolean;
  /** Test seam; production yields with setImmediate between bounded batches. */
  readonly yieldControl?: () => Promise<void>;
}

interface ActiveTradingDay {
  readonly date: string;
  readonly tsMs: number;
  readonly members: readonly string[];
  readonly queryCodes: readonly string[];
  readonly membershipKey: string;
}

/**
 * Checks only active symbol/date pairs and releases each batch's candle/non-trading rows before
 * continuing. The candle repository remains the single owner of worker-valid OHLC predicates.
 */
export async function findCandleDataExclusions(
  input: CandleDataExclusionInput,
): Promise<BacktestDataExclusion[]> {
  if (input.schedule.length === 0 || input.tradingDays.length === 0) return [];
  const sortedSchedule = [...input.schedule].sort((left, right) => left.fromTsMs - right.fromTsMs);
  const activeDays = activeTradingDays(input.tradingDays, sortedSchedule);
  const firstDelistedBySymbol = firstDelistedDates(input.delistedEvents);
  const missing = new Map<string, { firstDate: string; count: number }>();
  const yieldControl = input.yieldControl ?? yieldToEventLoop;

  let cursor = 0;
  while (cursor < activeDays.length) {
    if (input.shouldStop?.() === true) throw new UniverseResolutionCancelledError();
    const first = activeDays[cursor] as ActiveTradingDay;
    let end = cursor;
    while (end + 1 < activeDays.length) {
      const next = activeDays[end + 1] as ActiveTradingDay;
      if (next.membershipKey !== first.membershipKey) break;
      if (next.tsMs - first.tsMs >= MAX_BATCH_CALENDAR_DAYS * DAY_MS) break;
      end += 1;
    }
    const last = activeDays[end] as ActiveTradingDay;
    const validDatesByCode = input.readValidDates(first.queryCodes, first.date, last.date);
    const validSets = new Map(
      [...validDatesByCode].map(([symbol, dates]) => [symbol, new Set(dates)] as const),
    );
    const nonTrading = new Set(
      input.readNonTradingDays(first.date, last.date, first.queryCodes)
        .map((row) => `${row.date}\0${row.shortCode}`),
    );

    for (let index = cursor; index <= end; index += 1) {
      const day = activeDays[index] as ActiveTradingDay;
      for (const symbol of day.members) {
        if (nonTrading.has(`${day.date}\0${symbol}`)) continue;
        const delistedDate = firstDelistedBySymbol.get(symbol);
        if (delistedDate !== undefined && delistedDate <= day.date) continue;
        if (validSets.get(symbol)?.has(day.date) === true) continue;
        const previous = missing.get(symbol);
        missing.set(symbol, {
          firstDate: previous?.firstDate ?? day.date,
          count: (previous?.count ?? 0) + 1,
        });
      }
    }

    cursor = end + 1;
    if (cursor < activeDays.length) {
      await yieldControl();
      if (input.shouldStop?.() === true) throw new UniverseResolutionCancelledError();
    }
  }

  return [...missing].map(([symbol, detail]) => ({
    symbol,
    category: 'KRX_PRICE',
    periodKey: detail.firstDate,
    reason: `확정 유니버스 활성 기간의 KRX 일봉 ${detail.count}일 누락`,
  }));
}

function activeTradingDays(
  tradingDays: readonly string[],
  sortedSchedule: readonly CandleScheduleEntry[],
): ActiveTradingDay[] {
  const memberCache = new Map<CandleScheduleEntry, {
    readonly members: readonly string[];
    readonly queryCodes: readonly string[];
    readonly membershipKey: string;
  }>();
  const result: ActiveTradingDay[] = [];
  let scheduleIndex = 0;
  for (const date of tradingDays) {
    const tsMs = Date.parse(`${date}T00:00:00Z`);
    while (
      scheduleIndex + 1 < sortedSchedule.length
      && (sortedSchedule[scheduleIndex + 1] as CandleScheduleEntry).fromTsMs <= tsMs
    ) scheduleIndex += 1;
    const active = sortedSchedule[scheduleIndex] as CandleScheduleEntry;
    let cached = memberCache.get(active);
    if (cached === undefined) {
      const members = active.members.map((member) => member.symbol);
      const queryCodes = [...new Set(members)].sort();
      cached = { members, queryCodes, membershipKey: queryCodes.join('\0') };
      memberCache.set(active, cached);
    }
    result.push({ date, tsMs, ...cached });
  }
  return result;
}

function firstDelistedDates(events: readonly DelistedEvent[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    const previous = result.get(event.shortCode);
    if (previous === undefined || event.effectiveDate < previous) {
      result.set(event.shortCode, event.effectiveDate);
    }
  }
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
