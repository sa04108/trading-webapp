import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { symbolFactsState } from '../../../shared/db/schema.js';

/**
 * 종목별 재무 수집 완료 연도. 증분 수집이 "무엇이 아직 없는지" 를 알기 위한 유일한
 * 근거다 (설계 2026-07-29-web-facts-sync-design.md §3).
 *
 * **데이터셋 축이 없다** (설계 2026-07-31-symbol-as-first-class) — 같은 종목을 두
 * 데이터셋에서 각각 받던 중복이 여기서도 사라진다. 한 번 받은 연도는 어느 데이터셋을
 * 통해 요청해도 다시 받지 않는다.
 *
 * **`getCoveredYears()` 가 어떤 종목의 키를 돌려준다고 해서 재무를 수집했다는 뜻은
 * 아니다.** 자본변동 전용 수집이 먼저 행을 만들면 그 종목의 배열은 빈 채로 키만
 * 존재한다. 재무 수집 여부는 반드시 배열 길이로 판정한다(`symbolFactsState` 주석 참고).
 */
export interface FactCoverageStore {
  /** 종목 → 수집 완료 연도 (오름차순). 인자를 주면 그 종목만 */
  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. 팩트 저장 직후에 부른다. */
  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void;
  /**
   * 종목 → 마지막 coverage 기록 시각. 공시검색 재수집 판정의 watermark 다 — 이 시각
   * 이후 접수된 정기공시가 있으면 그 종목만 covered 연도를 다시 받는다. 기록이 없는
   * 종목은 키를 만들지 않는다 (0 을 주면 "1970년 이후 전부 재공시" 로 읽힌다).
   */
  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number>;
}

export class SqliteFactCoverageStore implements FactCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    const rows = this.db.select().from(symbolFactsState).all();
    const result = new Map<string, readonly number[]>();
    for (const row of rows) {
      if (codes !== undefined && !codes.includes(row.code)) continue;
      result.set(row.code, parseYears(row.coveredYearsJson));
    }
    return result;
  }

  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number> {
    const rows = this.db.select().from(symbolFactsState).all();
    const result = new Map<string, number>();
    for (const row of rows) {
      if (codes.includes(row.code)) result.set(row.code, row.updatedAtMs);
    }
    return result;
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    // 빈 목록은 기록하지 않는다 — 아무것도 수집하지 않은 종목에 행을 만들면
    // "수집됨" 과 "수집할 게 없었음" 이 구분되지 않는다
    if (years.length === 0) return;

    const existing = this.db
      .select()
      .from(symbolFactsState)
      .where(eq(symbolFactsState.code, symbol))
      .get();

    const merged = [...new Set([...(existing ? parseYears(existing.coveredYearsJson) : []), ...years])].sort(
      (a, b) => a - b,
    );
    const coveredYearsJson = JSON.stringify(merged);

    if (existing) {
      this.db
        .update(symbolFactsState)
        .set({ coveredYearsJson, updatedAtMs: nowMs })
        .where(eq(symbolFactsState.code, symbol))
        .run();
      return;
    }
    this.db
      .insert(symbolFactsState)
      .values({ code: symbol, coveredYearsJson, updatedAtMs: nowMs })
      .run();
  }
}

/**
 * 깨진 JSON 을 빈 목록으로 읽는다 — 여기서 던지면 수집 전체가 시작조차 못 한다.
 * 빈 목록이면 그 종목을 전 구간 다시 받으므로(멱등) 결과는 옳고 비용만 든다.
 *
 * `null` 도 여기로 들어온다 — `null` 을 허용하는 컬럼(예: 자본변동 커버리지)이
 * 아직 값을 받지 못한 행을 가리킨다. `SqliteCorporateActionCoverageStore` 가 재사용한다.
 */
export function parseYears(json: string | null): readonly number[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((year): year is number => typeof year === 'number').sort((a, b) => a - b);
  } catch {
    return [];
  }
}
