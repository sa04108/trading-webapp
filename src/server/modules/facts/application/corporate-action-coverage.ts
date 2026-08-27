import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { symbolFactsState } from '../../../shared/db/schema.js';
import { parseYears } from './fact-coverage-store.js';

export const CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION = 2;

interface ActionCoverageProtocol {
  readonly version: number;
  readonly years: readonly number[];
}

function parseProtocolYears(raw: string | null): number[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<ActionCoverageProtocol>;
    if (
      parsed.version !== CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION
      || !Array.isArray(parsed.years)
    ) return [];
    return [...new Set(parsed.years.filter(
      (year): year is number => Number.isInteger(year) && year >= 1900 && year <= 2200,
    ))].sort((left, right) => left - right);
  } catch {
    return [];
  }
}

/**
 * 종목별 자본변동 수집 커버리지다. `symbolFactsState.coveredYearsJson`(재무용)과는
 * 다른 컬럼 두 개를 쓴다.
 *
 * 자본변동만 받는 경로가 생기면 재무 커버리지 목록이 거짓말을 한다.
 * 그 연도를 재무 커버리지에도 적으면 재무 전략이 데이터가 있다고 오판한다.
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
  /** 종목 → 마지막 자본변동 coverage 기록 시각. 재무 watermark와 독립적이다. */
  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. */
  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void;
  /** 종목 하나의 gap 연도를 합집합으로 더한다. */
  addGapYears(symbol: string, years: readonly number[], nowMs: number): void;
  /** 완료 coverage와 발견한 gap을 한 SQLite write로 함께 합집합 기록한다. */
  addCoverageResult(
    symbol: string,
    coveredYears: readonly number[],
    gapYears: readonly number[],
    nowMs: number,
  ): void;
}

export class SqliteCorporateActionCoverageStore implements CorporateActionCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  private rowsForCodes(
    codes?: readonly string[],
  ): readonly (typeof symbolFactsState.$inferSelect)[] {
    if (codes === undefined) return this.db.select().from(symbolFactsState).all();
    const requested = [...new Set(codes)];
    if (requested.length === 0) return [];
    const rows: (typeof symbolFactsState.$inferSelect)[] = [];
    for (let offset = 0; offset < requested.length; offset += 500) {
      rows.push(...this.db
        .select()
        .from(symbolFactsState)
        .where(inArray(symbolFactsState.code, requested.slice(offset, offset + 500)))
        .all());
    }
    return rows;
  }

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    const result = new Map<string, readonly number[]>();
    for (const row of this.rowsForCodes(codes)) {
      // 구버전은 periodKey='-' gap을 버리고도 legacy coverage를 닫았다. 현재 프로토콜로
      // 실제 재수집한 연도만 신뢰해, 선택 유니버스의 필요한 연도만 on-demand로 연다.
      result.set(row.code, parseProtocolYears(row.actionCoverageProtocolJson));
    }
    return result;
  }

  getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return this.readYears('actionGapYearsJson', codes);
  }

  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    for (const row of this.rowsForCodes(codes)) {
      if (row.actionUpdatedAtMs !== null) result.set(row.code, row.actionUpdatedAtMs);
    }
    return result;
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.addCoverageResult(symbol, years, [], nowMs);
  }

  addGapYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.addYears('actionGapYearsJson', symbol, years, nowMs);
  }

  addCoverageResult(
    symbol: string,
    coveredYears: readonly number[],
    gapYears: readonly number[],
    nowMs: number,
  ): void {
    if (coveredYears.length === 0) return;
    const completed = new Set(coveredYears);
    if (gapYears.some((year) => !completed.has(year))) {
      throw new Error('자본변동 gap 연도는 이번에 완료한 coverage 연도 안에 있어야 합니다.');
    }
    const existing = this.db
      .select()
      .from(symbolFactsState)
      .where(eq(symbolFactsState.code, symbol))
      .get();
    const mergedCovered = [...new Set([
      ...(existing ? parseYears(existing.actionCoveredYearsJson) : []),
      ...coveredYears,
    ])].sort((a, b) => a - b);
    const verifiedYears = [...new Set([
      ...(existing ? parseProtocolYears(existing.actionCoverageProtocolJson) : []),
      ...coveredYears,
    ])].sort((a, b) => a - b);
    // gap은 일부러 지우지 않는다. DART 누적 snapshot에서 사라진 사건의 옛 fact도
    // repository에 남아 있으므로, snapshot 교체 없이 gap만 지우면 stale fact가 다시
    // 실행될 수 있다. 해소 프로토콜은 별도 정합성 작업이다.
    const mergedGaps = [...new Set([
      ...(existing ? parseYears(existing.actionGapYearsJson) : []),
      ...gapYears,
    ])].sort((a, b) => a - b);
    const values = {
      actionCoveredYearsJson: JSON.stringify(mergedCovered),
      actionGapYearsJson: JSON.stringify(mergedGaps),
      actionCoverageProtocolJson: JSON.stringify({
        version: CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION,
        years: verifiedYears,
      }),
      updatedAtMs: nowMs,
      actionUpdatedAtMs: nowMs,
    };

    if (existing) {
      this.db
        .update(symbolFactsState)
        .set(values)
        .where(eq(symbolFactsState.code, symbol))
        .run();
      return;
    }
    this.db
      .insert(symbolFactsState)
      .values({ code: symbol, coveredYearsJson: '[]', ...values })
      .run();
  }

  private readYears(
    column: 'actionCoveredYearsJson' | 'actionGapYearsJson',
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]> {
    const result = new Map<string, readonly number[]>();
    for (const row of this.rowsForCodes(codes)) {
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
        .set({ [column]: json, updatedAtMs: nowMs, actionUpdatedAtMs: nowMs })
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
      .values({
        code: symbol,
        coveredYearsJson: '[]',
        [column]: json,
        updatedAtMs: nowMs,
        actionUpdatedAtMs: nowMs,
      })
      .run();
  }
}
