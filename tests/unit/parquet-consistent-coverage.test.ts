import { describe, expect, it } from 'vitest';
import {
  ParquetConsistentFactCoverageStore,
  ParquetConsistentActionCoverageStore,
} from '../../src/server/modules/facts/application/parquet-consistent-coverage.js';
import type { FactCoverageStore } from '../../src/server/modules/facts/application/fact-coverage-store.js';
import type { CorporateActionCoverageStore } from '../../src/server/modules/facts/application/corporate-action-coverage.js';
import type { FactRepository } from '../../src/server/modules/facts/application/ports.js';

function fakeRepository(present: readonly string[]): Pick<FactRepository, 'hasFacts'> {
  const set = new Set(present);
  return { hasFacts: (_scope, key) => set.has(key) };
}

function fakeFactStore(covered: ReadonlyMap<string, readonly number[]>): FactCoverageStore {
  const added: unknown[] = [];
  return {
    getCoveredYears: (codes?: readonly string[]) =>
      codes === undefined
        ? covered
        : new Map([...covered].filter(([code]) => codes.includes(code))),
    getUpdatedAtMs: () => new Map<string, number>(),
    addCoveredYears: (symbol, years, nowMs) => {
      added.push([symbol, years, nowMs]);
    },
  };
}

describe('ParquetConsistentFactCoverageStore', () => {
  // 운영 장애(2026-08-10): symbol_facts_state 는 "받았다" 고 말하는데 parquet
  // 파티션이 없어 INCREMENTAL sync 가 영원히 건너뛰고 재무가 복구되지 않았다.
  it('parquet 파티션이 없는 종목의 coverage 는 없는 것으로 돌려준다', () => {
    const inner = fakeFactStore(new Map([
      ['005930', [2021, 2022, 2023]],
      ['000660', [2021, 2022]],
    ]));
    const store = new ParquetConsistentFactCoverageStore(inner, fakeRepository(['000660']));

    const covered = store.getCoveredYears(['005930', '000660']);

    expect(covered.get('005930')).toBeUndefined();
    expect(covered.get('000660')).toEqual([2021, 2022]);
  });

  it('인자 없는 전체 조회도 같은 기준으로 거른다', () => {
    const inner = fakeFactStore(new Map([
      ['005930', [2021]],
      ['000660', [2022]],
    ]));
    const store = new ParquetConsistentFactCoverageStore(inner, fakeRepository(['000660']));

    expect([...store.getCoveredYears().keys()]).toEqual(['000660']);
  });

  it('addCoveredYears 는 그대로 위임한다', () => {
    const calls: unknown[][] = [];
    const inner: FactCoverageStore = {
      getCoveredYears: () => new Map(),
      getUpdatedAtMs: () => new Map<string, number>(),
      addCoveredYears: (...args) => {
        calls.push(args);
      },
    };
    const store = new ParquetConsistentFactCoverageStore(inner, fakeRepository([]));

    store.addCoveredYears('005930', [2024], 42);

    expect(calls).toEqual([['005930', [2024], 42]]);
  });
});

describe('ParquetConsistentActionCoverageStore', () => {
  it('parquet 파티션이 없는 종목은 coverage·gap 모두 미수집으로 돌려준다', () => {
    const inner: CorporateActionCoverageStore = {
      getCoveredYears: () => new Map([['005930', [2023]], ['000660', [2023]]]),
      getGapYears: () => new Map([['005930', [2022]], ['000660', [2022]]]),
      addCoveredYears: () => undefined,
      addGapYears: () => undefined,
    };
    const store = new ParquetConsistentActionCoverageStore(inner, fakeRepository(['000660']));

    expect(store.getCoveredYears(['005930', '000660']).get('005930')).toBeUndefined();
    expect(store.getCoveredYears(['005930', '000660']).get('000660')).toEqual([2023]);
    expect(store.getGapYears(['005930', '000660']).get('005930')).toBeUndefined();
    expect(store.getGapYears(['005930', '000660']).get('000660')).toEqual([2022]);
  });
});
