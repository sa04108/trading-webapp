import type { FactRepository } from './ports.js';
import { PitFactView } from '../domain/pit-fact-view.js';
import type { FundamentalSortValueSource } from '../../market-data/application/ports.js';

/**
 * 과거 기준일 유니버스 정렬용 TTM 영업이익 (설계 2026-08-04-krx-universe-sort-dataset).
 *
 * PitFactView 를 그대로 쓴다 — point-in-time 컷오프·재집계 우선순위·TTM 4분기 합산
 * 규칙이 value-quality-rank 전략과 같은 코드를 타야 화면의 순위와 백테스트의 순위가
 * 다른 규칙으로 갈리지 않는다.
 */
export class OperatingIncomeSortSource implements FundamentalSortValueSource {
  constructor(private readonly facts: FactRepository) {}

  async ttmOperatingIncomeAsOf(
    shortCodes: readonly string[],
    asOfMaxTsMs: number,
  ): Promise<ReadonlyMap<string, number>> {
    const facts = await this.facts.getFacts({
      scope: 'SYMBOL',
      keys: shortCodes,
      fields: ['OPERATING_INCOME'],
      asOfMaxTsMs,
    });
    const view = new PitFactView(facts);
    view.advanceTo(asOfMaxTsMs);

    const result = new Map<string, number>();
    for (const code of new Set(shortCodes)) {
      const ttm = view.fundamentals(code)?.ttm('OPERATING_INCOME');
      if (ttm !== null && ttm !== undefined) result.set(code, ttm);
    }
    return result;
  }
}
