import { describe, expect, it } from 'vitest';
import {
  findCandleDataExclusions,
  type CandleDataExclusionInput,
} from '../../src/server/modules/backtest/application/backtest-candle-data-exclusions.js';
import type { BacktestDataExclusion } from '../../src/server/modules/backtest/application/backtest-data-exclusion.js';
import { UniverseResolutionCancelledError } from '../../src/server/modules/backtest/application/universe-rule-resolver.js';
import { CandleCoverageService } from '../../src/server/modules/market-data/application/candle-coverage-service.js';
import { openDatabase } from '../../src/server/shared/db/database.js';
import { krxDailyBars } from '../../src/server/shared/db/schema.js';

const ts = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const members = (...symbols: string[]) => symbols.map((symbol) => ({ symbol }));

describe('bounded candle data exclusions', () => {
  it('legacy 전체조회와 mixed membership 결과가 같고 active 종목만 31 calendar-day 이하로 읽는다', async () => {
    const tradingDays = calendarDates('2026-01-01', '2026-02-15');
    const schedule = [
      { fromTsMs: ts('2026-01-01'), members: members('A', 'B') },
      // 같은 membership의 새 일정은 query batch를 불필요하게 쪼개지 않는다.
      { fromTsMs: ts('2026-01-10'), members: members('B', 'A') },
      { fromTsMs: ts('2026-02-05'), members: members('C', 'D') },
    ];
    const validDates = new Map<string, readonly string[]>([
      ['A', tradingDays.filter((date) => (
        date <= '2026-02-04'
        && date !== '2026-01-03'
        && date !== '2026-01-04'
        && date !== '2026-02-02'
      ))],
      ['B', tradingDays.filter((date) => (
        date < '2026-01-20' && date !== '2026-01-02' && date !== '2026-01-06'
      ))],
      ['C', tradingDays.filter((date) => date >= '2026-02-05' && date !== '2026-02-07')],
      ['D', tradingDays.filter((date) => date >= '2026-02-05')],
    ]);
    const nonTradingDays = [
      { date: '2026-01-02', shortCode: 'B' },
      { date: '2026-01-04', shortCode: 'A' },
    ];
    const delistedEvents = [
      { shortCode: 'B', effectiveDate: '2026-01-20' },
      { shortCode: 'B', effectiveDate: '2026-01-25' },
    ];
    const validCalls: Array<{ codes: readonly string[]; from: string; to: string }> = [];
    const nonTradingCalls: Array<{ codes: readonly string[]; from: string; to: string }> = [];
    const input: CandleDataExclusionInput = {
      period: { from: '2026-01-01', to: '2026-02-15' },
      schedule,
      tradingDays,
      delistedEvents,
      readValidDates: (codes, from, to) => {
        validCalls.push({ codes, from, to });
        return new Map(codes.map((code) => [
          code,
          (validDates.get(code) ?? []).filter((date) => date >= from && date <= to),
        ]));
      },
      readNonTradingDays: (from, to, codes) => {
        nonTradingCalls.push({ codes, from, to });
        return nonTradingDays.filter((row) => (
          codes.includes(row.shortCode) && row.date >= from && row.date <= to
        ));
      },
      yieldControl: () => Promise.resolve(),
    };

    const actual = await findCandleDataExclusions(input);

    expect(actual).toEqual(legacyCandleDataExclusions({
      tradingDays,
      schedule,
      validDates,
      nonTradingDays,
      delistedEvents,
    }));
    expect(actual).toEqual([
      priceExclusion('A', '2026-01-03', 2),
      priceExclusion('B', '2026-01-06', 1),
      priceExclusion('C', '2026-02-07', 1),
    ]);
    expect(validCalls).toEqual([
      { codes: ['A', 'B'], from: '2026-01-01', to: '2026-01-31' },
      { codes: ['A', 'B'], from: '2026-02-01', to: '2026-02-04' },
      { codes: ['C', 'D'], from: '2026-02-05', to: '2026-02-15' },
    ]);
    expect(nonTradingCalls).toEqual(validCalls);
    expect(validCalls.every((call) => ts(call.to) - ts(call.from) < 31 * 86_400_000)).toBe(true);
  });

  it('A→B→A 재편입은 A의 inactive 공백을 무시하고 재편입 뒤 누락만 센다', async () => {
    const tradingDays = calendarDates('2026-01-01', '2026-01-09');
    const schedule = [
      { fromTsMs: ts('2026-01-01'), members: members('A') },
      { fromTsMs: ts('2026-01-04'), members: members('B') },
      { fromTsMs: ts('2026-01-07'), members: members('A') },
    ];
    const validDates = new Map<string, readonly string[]>([
      ['A', ['2026-01-01', '2026-01-02', '2026-01-03']],
      ['B', ['2026-01-04', '2026-01-05', '2026-01-06']],
    ]);
    const calls: Array<{ codes: readonly string[]; from: string; to: string }> = [];

    const result = await findCandleDataExclusions({
      period: { from: '2026-01-01', to: '2026-01-09' },
      schedule,
      tradingDays,
      delistedEvents: [],
      readValidDates: (codes, from, to) => {
        calls.push({ codes, from, to });
        return new Map(codes.map((code) => [
          code,
          (validDates.get(code) ?? []).filter((date) => date >= from && date <= to),
        ]));
      },
      readNonTradingDays: () => [],
      yieldControl: () => Promise.resolve(),
    });

    expect(result).toEqual([priceExclusion('A', '2026-01-07', 3)]);
    expect(calls).toEqual([
      { codes: ['A'], from: '2026-01-01', to: '2026-01-03' },
      { codes: ['B'], from: '2026-01-04', to: '2026-01-06' },
      { codes: ['A'], from: '2026-01-07', to: '2026-01-09' },
    ]);
  });

  it('CandleCoverageService의 worker-valid predicate가 invalid OHLC를 활성 누락으로 센다', async () => {
    const database = openDatabase(':memory:');
    try {
      database.db.insert(krxDailyBars).values([
        {
          shortCode: 'A', date: '2026-01-05', market: 'KOSPI',
          open: 100, high: 110, low: 90, close: 105, volume: 100,
        },
        {
          shortCode: 'A', date: '2026-01-06', market: 'KOSPI',
          open: 100, high: 90, low: 80, close: 105, volume: 100,
        },
      ]).run();
      const coverage = new CandleCoverageService(database.db);

      const result = await findCandleDataExclusions({
        period: { from: '2026-01-05', to: '2026-01-06' },
        schedule: [{ fromTsMs: ts('2026-01-05'), members: members('A') }],
        tradingDays: ['2026-01-05', '2026-01-06'],
        delistedEvents: [],
        readValidDates: coverage.getValidDatesByCodeBetween.bind(coverage),
        readNonTradingDays: () => [],
      });

      expect(result).toEqual([priceExclusion('A', '2026-01-06', 1)]);
    } finally {
      database.close();
    }
  });

  it('batch 사이 yield 뒤 cancellation을 확인하고 다음 DB 범위를 읽지 않는다', async () => {
    const tradingDays = calendarDates('2026-01-01', '2026-02-05');
    let stopped = false;
    let readCount = 0;

    await expect(findCandleDataExclusions({
      period: { from: '2026-01-01', to: '2026-02-05' },
      schedule: [{ fromTsMs: ts('2026-01-01'), members: members('A') }],
      tradingDays,
      delistedEvents: [],
      readValidDates: (codes, from, to) => {
        readCount += 1;
        return new Map(codes.map((code) => [
          code,
          tradingDays.filter((date) => date >= from && date <= to),
        ]));
      },
      readNonTradingDays: () => [],
      shouldStop: () => stopped,
      yieldControl: async () => { stopped = true; },
    })).rejects.toBeInstanceOf(UniverseResolutionCancelledError);
    expect(readCount).toBe(1);
  });
});

function calendarDates(from: string, to: string): string[] {
  const result: string[] = [];
  for (let cursor = ts(from); cursor <= ts(to); cursor += 86_400_000) {
    result.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return result;
}

function priceExclusion(symbol: string, firstDate: string, count: number): BacktestDataExclusion {
  return {
    symbol,
    category: 'KRX_PRICE',
    periodKey: firstDate,
    reason: `확정 유니버스 활성 기간의 KRX 일봉 ${count}일 누락`,
  };
}

function legacyCandleDataExclusions(input: {
  readonly tradingDays: readonly string[];
  readonly schedule: readonly {
    readonly fromTsMs: number;
    readonly members: readonly { readonly symbol: string }[];
  }[];
  readonly validDates: ReadonlyMap<string, readonly string[]>;
  readonly nonTradingDays: readonly { readonly date: string; readonly shortCode: string }[];
  readonly delistedEvents: readonly { readonly shortCode: string; readonly effectiveDate: string }[];
}): BacktestDataExclusion[] {
  const nonTrading = new Set(
    input.nonTradingDays.map((row) => `${row.date}\0${row.shortCode}`),
  );
  const firstDelisted = new Map<string, string>();
  for (const event of input.delistedEvents) {
    const previous = firstDelisted.get(event.shortCode);
    if (previous === undefined || event.effectiveDate < previous) {
      firstDelisted.set(event.shortCode, event.effectiveDate);
    }
  }
  const validSets = new Map(
    [...input.validDates].map(([symbol, dates]) => [symbol, new Set(dates)] as const),
  );
  const sortedSchedule = [...input.schedule].sort((left, right) => left.fromTsMs - right.fromTsMs);
  const missing = new Map<string, { firstDate: string; count: number }>();
  let scheduleIndex = 0;
  for (const date of input.tradingDays) {
    const dateTs = ts(date);
    while (
      scheduleIndex + 1 < sortedSchedule.length
      && (sortedSchedule[scheduleIndex + 1]?.fromTsMs ?? Number.POSITIVE_INFINITY) <= dateTs
    ) scheduleIndex += 1;
    const active = sortedSchedule[scheduleIndex];
    if (active === undefined) continue;
    for (const member of active.members) {
      if (nonTrading.has(`${date}\0${member.symbol}`)) continue;
      const delistedDate = firstDelisted.get(member.symbol);
      if (delistedDate !== undefined && delistedDate <= date) continue;
      if (validSets.get(member.symbol)?.has(date) === true) continue;
      const previous = missing.get(member.symbol);
      missing.set(member.symbol, {
        firstDate: previous?.firstDate ?? date,
        count: (previous?.count ?? 0) + 1,
      });
    }
  }
  return [...missing].map(([symbol, detail]) => (
    priceExclusion(symbol, detail.firstDate, detail.count)
  ));
}
