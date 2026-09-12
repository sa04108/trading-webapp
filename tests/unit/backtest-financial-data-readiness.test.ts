import { describe, expect, it, vi } from 'vitest';
import { findIncompleteFundamentalCheckpoints, findIncompleteFundamentalCheckpointsFromCoverage } from '../../src/server/modules/backtest/application/backtest-financial-data-readiness.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import { valueQualityRankStrategy } from '../../src/server/modules/strategy/strategies/value-quality-rank.js';

const schedule = [
  { rebalanceDate: '2025-01-02', symbols: ['LATER', 'NEVER'] },
  { rebalanceDate: '2025-02-02', symbols: ['LATER', 'NEVER'] },
];

function valueFacts(symbol: string, asOfTsMs: number): Fact[] {
  const rows: Fact[] = ['2024Q1', '2024Q2', '2024Q3', '2024Q4'].map((periodKey) => ({
    scope: 'SYMBOL',
    key: symbol,
    field: 'OPERATING_INCOME',
    periodKey,
    asOfTsMs,
    value: 100,
    unit: 'KRW',
  }));
  for (const field of ['CURRENT_ASSETS', 'CURRENT_LIABILITIES', 'TANGIBLE_ASSETS'] as const) {
    rows.push({
      scope: 'SYMBOL',
      key: symbol,
      field,
      periodKey: '2024Q4',
      asOfTsMs,
      value: 100,
      unit: 'KRW',
    });
  }
  return rows;
}

describe('findIncompleteFundamentalCheckpoints', () => {
  it('초반 공시 전이어도 실제 편입 구간 중 한 번 온전해지면 전 기간 제외하지 않는다', () => {
    const disclosedBeforeSecondRebalance = Date.parse('2025-01-20T00:00:00Z');
    const incomplete = findIncompleteFundamentalCheckpoints({
      strategy: valueQualityRankStrategy,
      parameters: { topN: 1, staleQuarters: 2 },
      facts: [
        ...valueFacts('LATER', disclosedBeforeSecondRebalance),
        {
          scope: 'SYMBOL', key: 'NEVER', field: 'NET_INCOME', periodKey: '2024Q4',
          asOfTsMs: disclosedBeforeSecondRebalance, value: 100, unit: 'KRW',
        },
      ],
      schedule,
      validDatesBySymbol: new Map([
        ['LATER', ['2025-01-02', '2025-02-03']],
        ['NEVER', ['2025-01-02', '2025-02-03']],
      ]),
    });

    expect(incomplete).toEqual([{ symbol: 'NEVER', date: '2025-01-02' }]);
  });

  it('실행 봉이 없는 일정은 재무 결손으로 오인하지 않는다', () => {
    expect(findIncompleteFundamentalCheckpoints({
      strategy: valueQualityRankStrategy,
      parameters: { topN: 1, staleQuarters: 2 },
      facts: [],
      schedule: [{ rebalanceDate: '2025-01-02', symbols: ['NO_BAR'] }],
      validDatesBySymbol: new Map([['NO_BAR', []]]),
    })).toEqual([]);
  });
});

function coverageFromDates(datesBySymbol: ReadonlyMap<string, readonly string[]>) {
  return {
    getCoverageBetween: vi.fn((symbols: readonly string[], from: number, to: number) => (
      symbols.map((code) => {
        const dates = [...new Set(datesBySymbol.get(code) ?? [])]
          .map((date) => Date.parse(`${date}T00:00:00Z`))
          .filter((tsMs) => tsMs >= from && tsMs <= to).sort((a, b) => a - b);
        return {
          code, firstTsMs: dates[0] ?? null, lastTsMs: dates.at(-1) ?? null, barCount: dates.length,
        };
      })
    )),
  };
}

describe('findIncompleteFundamentalCheckpointsFromCoverage', () => {
  it('휴장일·편출 경계·거래정지·재편입·정정 공시에서 기존 PIT 판정과 같다', async () => {
    const dates = new Map([
      ['LATER', ['2025-01-03', '2025-02-03', '2025-02-03', '2025-03-03']],
      ['NEVER', ['2025-01-03', '2025-02-03', '2025-03-03']],
      ['SUSPENDED', ['2025-01-06', '2025-02-04', '2025-03-04']],
      ['REENTER', ['2025-01-03', '2025-02-03', '2025-03-03']],
      ['NEXT_ONLY', ['2025-02-02']],
    ]);
    const localSchedule = [
      { rebalanceDate: '2025-03-02', symbols: ['LATER', 'NEVER', 'SUSPENDED', 'REENTER'] },
      { rebalanceDate: '2025-01-02', symbols: ['LATER', 'NEVER', 'SUSPENDED', 'REENTER', 'NEXT_ONLY'] },
      { rebalanceDate: '2025-02-02', symbols: ['LATER', 'NEVER', 'SUSPENDED'] },
    ];
    const facts = [
      ...valueFacts('LATER', Date.parse('2025-01-20T00:00:00Z')),
      ...valueFacts('REENTER', Date.parse('2025-02-20T00:00:00Z')),
      // 최종 실행일 이후 공시는 과거 결손을 가리지 못한다.
      ...valueFacts('NEVER', Date.parse('2025-03-04T00:00:00Z')),
      ...valueFacts('LATER', Date.parse('2025-02-20T00:00:00Z')).map((fact) => ({ ...fact, value: 200 })),
    ];
    const getFacts = vi.fn(async (query: { keys?: readonly string[]; asOfMaxTsMs?: number }) => (
      facts.filter((fact) => query.keys!.includes(fact.key) && fact.asOfTsMs <= query.asOfMaxTsMs!)
    ));
    const common = { strategy: valueQualityRankStrategy, parameters: { topN: 1, staleQuarters: 2 } };
    const actual = await findIncompleteFundamentalCheckpointsFromCoverage({
      ...common,
      period: { from: '2025-01-02', to: '2025-03-03' },
      schedule: localSchedule,
      candles: coverageFromDates(dates),
      facts: { getFacts },
    });
    expect(actual).toEqual([{ symbol: 'NEVER', date: '2025-01-03' }]);
    expect(actual).toEqual(findIncompleteFundamentalCheckpoints({
      ...common, schedule: localSchedule, facts, validDatesBySymbol: dates,
    }));
    expect(getFacts.mock.calls.flatMap(([query]) => query.keys ?? [])).not.toContain('SUSPENDED');
    expect(getFacts.mock.calls.flatMap(([query]) => query.keys ?? [])).not.toContain('NEXT_ONLY');
  });

  it('기간 밖 봉과 실행 봉이 없는 일정은 facts를 조회하지 않는다', async () => {
    const getFacts = vi.fn(async () => []);
    const result = await findIncompleteFundamentalCheckpointsFromCoverage({
      strategy: valueQualityRankStrategy,
      parameters: { topN: 1, staleQuarters: 2 },
      period: { from: '2025-01-02', to: '2025-01-31' },
      schedule: [{ rebalanceDate: '2025-01-02', symbols: ['OUTSIDE'] }],
      candles: coverageFromDates(new Map([['OUTSIDE', ['2025-01-01', '2025-02-01']]])),
      facts: { getFacts },
    });
    expect(result).toEqual([]);
    expect(getFacts).not.toHaveBeenCalled();
  });

  it('종목이 많아도 facts를 32종목 이하로 읽고 모든 결손을 보존한다', async () => {
    const symbols = Array.from({ length: 101 }, (_, index) => String(index).padStart(6, '0'));
    const getFacts = vi.fn(async () => []);
    const result = await findIncompleteFundamentalCheckpointsFromCoverage({
      strategy: valueQualityRankStrategy,
      parameters: { topN: 1, staleQuarters: 2 },
      period: { from: '2016-01-01', to: '2026-01-31' },
      schedule: [{ rebalanceDate: '2016-01-01', symbols }],
      candles: coverageFromDates(new Map(symbols.map((symbol) => [symbol, ['2016-01-04']]))),
      facts: { getFacts },
    });
    expect(result).toEqual(symbols.map((symbol) => ({ symbol, date: '2016-01-04' })));
    expect(getFacts).toHaveBeenCalledTimes(4);
    for (const [query] of getFacts.mock.calls as unknown as [{ keys: string[] }][]) {
      expect(query.keys.length).toBeLessThanOrEqual(32);
    }
  });

  it('SQL 구간 사이에 취소되면 후속 facts 평가를 시작하지 않는다', async () => {
    let cancelled = false;
    const getFacts = vi.fn(async () => []);
    const localSchedule = Array.from({ length: 40 }, (_, index) => ({
      rebalanceDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      symbols: ['NEVER'],
    }));
    const candles = coverageFromDates(new Map([['NEVER', localSchedule.map((entry) => entry.rebalanceDate)]]));
    setImmediate(() => { cancelled = true; });
    await expect(findIncompleteFundamentalCheckpointsFromCoverage({
      strategy: valueQualityRankStrategy,
      parameters: { topN: 1, staleQuarters: 2 },
      period: { from: '2025-01-01', to: '2025-02-28' },
      schedule: localSchedule,
      candles,
      facts: { getFacts },
      throwIfStopped: () => { if (cancelled) throw new Error('취소됨'); },
    })).rejects.toThrow('취소됨');
    expect(candles.getCoverageBetween.mock.calls.length).toBeLessThan(40);
    expect(getFacts).not.toHaveBeenCalled();
  });
});
