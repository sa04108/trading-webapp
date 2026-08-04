import { describe, expect, it } from 'vitest';
import { OperatingIncomeSortSource } from '../../src/server/modules/facts/application/operating-income-sort-source.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { FactRepository, FactQuery } from '../../src/server/modules/facts/application/ports.js';

function fakeRepo(facts: Fact[]): FactRepository {
  return {
    async getFacts(query: FactQuery) {
      return facts.filter(
        (f) =>
          (query.keys === undefined || query.keys.includes(f.key)) &&
          (query.fields === undefined || query.fields.includes(f.field)) &&
          (query.asOfMaxTsMs === undefined || f.asOfTsMs <= query.asOfMaxTsMs),
      );
    },
    async saveFacts() {},
    hasFacts: () => true,
    symbolsWithFacts: () => new Set(),
  };
}

function oi(key: string, periodKey: string, asOfTsMs: number, value: number): Fact {
  return { scope: 'SYMBOL', key, field: 'OPERATING_INCOME', periodKey, asOfTsMs, value, unit: 'KRW' };
}

describe('OperatingIncomeSortSource', () => {
  const CUTOFF = Date.parse('2020-06-15T15:00:00Z'); // 임의 컷오프

  it('직전 4개 분기 TTM 을 합산한다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([
      oi('005930', '2019Q3', 1_000, 10),
      oi('005930', '2019Q4', 2_000, 20),
      oi('005930', '2020Q1', 3_000, 30),
      oi('005930', '2020Q2', 4_000, 40),
    ]));
    const result = await source.ttmOperatingIncomeAsOf(['005930'], CUTOFF);
    expect(result.get('005930')).toBe(100);
  });

  it('컷오프 이후 공시는 보이지 않는다 — 4분기가 안 채워지면 키가 없다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([
      oi('005930', '2019Q3', 1_000, 10),
      oi('005930', '2019Q4', 2_000, 20),
      oi('005930', '2020Q1', 3_000, 30),
      oi('005930', '2020Q2', CUTOFF + 1, 40), // 미래 공시
    ]));
    const result = await source.ttmOperatingIncomeAsOf(['005930'], CUTOFF);
    // 컷오프 시점 최신 분기 2020Q1 기준 직전 4개(2019Q2~2020Q1) 중 2019Q2 가 없다
    expect(result.has('005930')).toBe(false);
  });

  it('팩트가 전혀 없는 종목은 키가 없다', async () => {
    const source = new OperatingIncomeSortSource(fakeRepo([]));
    const result = await source.ttmOperatingIncomeAsOf(['005930', '035720'], CUTOFF);
    expect(result.size).toBe(0);
  });
});
