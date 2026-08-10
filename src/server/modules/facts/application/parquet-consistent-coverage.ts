import type { CorporateActionCoverageStore } from './corporate-action-coverage.js';
import type { FactCoverageStore } from './fact-coverage-store.js';
import type { FactRepository } from './ports.js';

/**
 * coverage 기록과 parquet 실체의 정합성 게이트 (운영 장애 2026-08-10).
 *
 * `symbol_facts_state` 는 "그 연도를 받았다" 고 말하는데 정작 그 종목의 parquet
 * 파티션이 없으면, INCREMENTAL sync 가 남은 작업이 없다고 판단해 영원히 건너뛰고
 * 재무·자본변동이 복구되지 않는다 — DB(app.sqlite)와 저장소(market-data)는 따로
 * 복원·삭제될 수 있으므로 이 어긋남은 실제로 일어난다. coverage 를 **읽는 경계**에서
 * 파일 존재(`hasFacts`, D-033: 존재만 본다)를 교차 확인해, 파티션이 사라진 종목은
 * "아예 수집하지 않은 종목" 으로 되돌린다. 다음 준비/동기화가 그 종목을 처음부터
 * 다시 받으면 저장이 파티션을 재생성해 정합성이 복구된다.
 *
 * 쓰기(addCoveredYears 등)는 그대로 위임한다 — 저장 직후에는 파일이 방금 생겼으므로
 * 확인할 것이 없다.
 */
type PartitionCheck = Pick<FactRepository, 'hasFacts'>;

function filterByPartition(
  years: ReadonlyMap<string, readonly number[]>,
  repository: PartitionCheck,
): ReadonlyMap<string, readonly number[]> {
  const result = new Map<string, readonly number[]>();
  for (const [code, list] of years) {
    if (repository.hasFacts('SYMBOL', code)) result.set(code, list);
  }
  return result;
}

export class ParquetConsistentFactCoverageStore implements FactCoverageStore {
  constructor(
    private readonly inner: FactCoverageStore,
    private readonly repository: PartitionCheck,
  ) {}

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return filterByPartition(this.inner.getCoveredYears(codes), this.repository);
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.inner.addCoveredYears(symbol, years, nowMs);
  }
}

export class ParquetConsistentActionCoverageStore implements CorporateActionCoverageStore {
  constructor(
    private readonly inner: CorporateActionCoverageStore,
    private readonly repository: PartitionCheck,
  ) {}

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return filterByPartition(this.inner.getCoveredYears(codes), this.repository);
  }

  getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return filterByPartition(this.inner.getGapYears(codes), this.repository);
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.inner.addCoveredYears(symbol, years, nowMs);
  }

  addGapYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.inner.addGapYears(symbol, years, nowMs);
  }
}
