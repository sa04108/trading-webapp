import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { symbolFactsState } from '../../../shared/db/schema.js';
import { parseYears } from './fact-coverage-store.js';

/**
 * 종목별 자본변동 수집 커버리지. `symbolFactsState.coveredYearsJson` (재무용) 과는
 * 다른 컬럼 두 개를 쓴다 — 자본변동만 받는 경로가 생기면 재무 커버리지 목록에 그
 * 연도를 적는 순간 재무 전략이 "데이터 있음" 으로 오판하기 때문이다.
 *
 * 팩트 0건이 세 가지 상태를 가릴 수 있다: (1) 수집했고 분할이 없었다,
 * (2) 수집했는데 DART 가 응답하지 못했다, (3) 아예 수집하지 않았다. 커버리지가
 * (3) 을 나머지 둘과 가르고, gap 이 (1) 과 (2) 를 가른다.
 */
export interface CorporateActionCoverageStore {
  /** 종목 → 자본변동 수집 완료 연도 (오름차순). 인자를 주면 그 종목만 */
  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]>;
  /** 종목 → 자본변동 수집이 실패한 연도 (오름차순). 인자를 주면 그 종목만 */
  getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. */
  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void;
  /** 종목 하나의 gap 연도를 합집합으로 더한다. */
  addGapYears(symbol: string, years: readonly number[], nowMs: number): void;
}

export class SqliteCorporateActionCoverageStore implements CorporateActionCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return this.readYears('actionCoveredYearsJson', codes);
  }

  getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return this.readYears('actionGapYearsJson', codes);
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.addYears('actionCoveredYearsJson', symbol, years, nowMs);
  }

  addGapYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.addYears('actionGapYearsJson', symbol, years, nowMs);
  }

  private readYears(
    column: 'actionCoveredYearsJson' | 'actionGapYearsJson',
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]> {
    const rows = this.db.select().from(symbolFactsState).all();
    const result = new Map<string, readonly number[]>();
    for (const row of rows) {
      if (codes !== undefined && !codes.includes(row.code)) continue;
      result.set(row.code, parseYears(row[column]));
    }
    return result;
  }

  private addYears(
    column: 'actionCoveredYearsJson' | 'actionGapYearsJson',
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void {
    // 재무 커버리지(addCoveredYears)와 같은 판단이다: 빈 목록은 기록하지 않는다.
    // 아무것도 수집하지 않은 종목에 행을 만들면 "수집됨" 과 "수집할 게 없었음" 이
    // 구분되지 않는다. gap 도 마찬가지다 — gap 이 없다는 사실 자체는 기록할 값이
    // 아니라 기본 상태다.
    if (years.length === 0) return;

    const existing = this.db
      .select()
      .from(symbolFactsState)
      .where(eq(symbolFactsState.code, symbol))
      .get();

    const merged = [...new Set([...(existing ? parseYears(existing[column]) : []), ...years])].sort(
      (a, b) => a - b,
    );
    const json = JSON.stringify(merged);

    if (existing) {
      this.db
        .update(symbolFactsState)
        .set({ [column]: json, updatedAtMs: nowMs })
        .where(eq(symbolFactsState.code, symbol))
        .run();
      return;
    }
    // 신규 행이다. 재무 컬럼(coveredYearsJson)은 NOT NULL 이다.
    // 자본변동만 먼저 도착해 행을 새로 만드는 경우 재무는 아직 하나도 받지 않았으므로
    // 빈 목록이 정확한 값이다. 재무가 나중에 도착하면
    // SqliteFactCoverageStore.addCoveredYears 가 그 값을 갱신한다.
    this.db
      .insert(symbolFactsState)
      .values({ code: symbol, coveredYearsJson: '[]', [column]: json, updatedAtMs: nowMs })
      .run();
  }
}
