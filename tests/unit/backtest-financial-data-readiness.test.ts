import { describe, expect, it } from 'vitest';
import { findIncompleteFundamentalCheckpoints } from '../../src/server/modules/backtest/application/backtest-financial-data-readiness.js';
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
