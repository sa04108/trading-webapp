import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { datasetFactsState } from '../../../shared/db/schema.js';

/**
 * 종목별 재무 수집 완료 연도. 증분 수집이 "무엇이 아직 없는지" 를 알기 위한 유일한
 * 근거다 (설계 2026-07-29-web-facts-sync-design.md §3).
 */
export interface FactCoverageStore {
  /** 데이터셋의 종목 → 수집 완료 연도 (오름차순) */
  getCoveredYears(datasetId: string): ReadonlyMap<string, readonly number[]>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. 팩트 저장 직후에 부른다. */
  addCoveredYears(
    datasetId: string,
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void;
}

export class SqliteFactCoverageStore implements FactCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  getCoveredYears(datasetId: string): ReadonlyMap<string, readonly number[]> {
    const rows = this.db
      .select()
      .from(datasetFactsState)
      .where(eq(datasetFactsState.datasetId, datasetId))
      .all();
    const result = new Map<string, readonly number[]>();
    for (const row of rows) {
      result.set(row.symbol, parseYears(row.coveredYearsJson));
    }
    return result;
  }

  addCoveredYears(
    datasetId: string,
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void {
    // 빈 목록은 기록하지 않는다 — 아무것도 수집하지 않은 종목에 행을 만들면
    // "수집됨" 과 "수집할 게 없었음" 이 구분되지 않는다
    if (years.length === 0) return;

    const existing = this.db
      .select()
      .from(datasetFactsState)
      .where(and(eq(datasetFactsState.datasetId, datasetId), eq(datasetFactsState.symbol, symbol)))
      .get();

    const merged = [...new Set([...(existing ? parseYears(existing.coveredYearsJson) : []), ...years])].sort(
      (a, b) => a - b,
    );
    const coveredYearsJson = JSON.stringify(merged);

    if (existing) {
      this.db
        .update(datasetFactsState)
        .set({ coveredYearsJson, updatedAtMs: nowMs })
        .where(eq(datasetFactsState.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(datasetFactsState)
      .values({ datasetId, symbol, coveredYearsJson, updatedAtMs: nowMs })
      .run();
  }
}

/**
 * 깨진 JSON 을 빈 목록으로 읽는다 — 여기서 던지면 수집 전체가 시작조차 못 한다.
 * 빈 목록이면 그 종목을 전 구간 다시 받으므로(멱등) 결과는 옳고 비용만 든다.
 */
function parseYears(json: string): readonly number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((year): year is number => typeof year === 'number').sort((a, b) => a - b);
  } catch {
    return [];
  }
}
