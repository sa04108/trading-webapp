import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { symbolFactsState } from '../../../shared/db/schema.js';
import { parseYears } from './fact-coverage-store.js';

export const CORPORATE_ACTION_COVERAGE_PROTOCOL_VERSION = 3;

export interface CorporateActionGapDetail {
  readonly year: number;
  readonly periodKey: string;
  readonly reason: string;
  readonly severity: 'BLOCKING' | 'INFORMATIONAL';
}

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

function parseGapDetails(raw: string | null): CorporateActionGapDetail[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate): CorporateActionGapDetail[] => {
      if (typeof candidate !== 'object' || candidate === null) return [];
      const row = candidate as Partial<CorporateActionGapDetail>;
      if (
        typeof row.year !== 'number'
        || !Number.isInteger(row.year)
        || row.year < 1900
        || row.year > 2200
        || typeof row.periodKey !== 'string'
        || typeof row.reason !== 'string'
        || (row.severity !== 'BLOCKING' && row.severity !== 'INFORMATIONAL')
      ) return [];
      return [{
        year: row.year,
        periodKey: row.periodKey,
        reason: row.reason,
        severity: row.severity,
      }];
    }).sort(compareGapDetails);
  } catch {
    return [];
  }
}

function compareGapDetails(left: CorporateActionGapDetail, right: CorporateActionGapDetail): number {
  return left.year - right.year
    || left.periodKey.localeCompare(right.periodKey)
    || left.reason.localeCompare(right.reason)
    || left.severity.localeCompare(right.severity);
}

function uniqueGapDetails(
  details: readonly CorporateActionGapDetail[],
): CorporateActionGapDetail[] {
  const unique = new Map<string, CorporateActionGapDetail>();
  for (const detail of details) {
    unique.set(
      `${detail.year}\u0000${detail.periodKey}\u0000${detail.reason}\u0000${detail.severity}`,
      detail,
    );
  }
  return [...unique.values()].sort(compareGapDetails);
}

function legacyGapDetail(year: number): CorporateActionGapDetail {
  return {
    year,
    periodKey: '-',
    reason: '상세 사유가 저장되지 않은 자본변동 gap',
    severity: 'BLOCKING',
  };
}

/**
 * 종목별 자본변동 수집 커버리지다. `symbolFactsState.coveredYearsJson`(재무용)과는
 * 다른 컬럼 세 개를 쓴다.
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
  /** 종목 → 자본변동 수집 실패 상세. 구버전 연도만 있으면 보수적인 상세를 합성한다. */
  getGapDetails?(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly CorporateActionGapDetail[]>;
  /** 종목 → 마지막 자본변동 coverage 기록 시각. 재무 watermark와 독립적이다. */
  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. */
  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void;
  /** 종목 하나의 gap 연도를 합집합으로 더한다. */
  addGapYears(symbol: string, years: readonly number[], nowMs: number): void;
  /** coverage는 합치고 완료 연도의 gap·상세는 최신 결과로 교체한다. */
  addCoverageResult(
    symbol: string,
    coveredYears: readonly number[],
    gapYears: readonly number[],
    nowMs: number,
    gapDetails?: readonly CorporateActionGapDetail[],
  ): void;
}

export class SqliteCorporateActionCoverageStore implements CorporateActionCoverageStore {
  constructor(private readonly db: AppDatabase) {}

  private readForCodes<T>(
    codes: readonly string[] | undefined,
    readBatch: (batch: readonly string[] | undefined) => readonly T[],
  ): readonly T[] {
    if (codes === undefined) return readBatch(undefined);
    const requested = [...new Set(codes)];
    if (requested.length === 0) return [];
    const rows: T[] = [];
    for (let offset = 0; offset < requested.length; offset += 500) {
      rows.push(...readBatch(requested.slice(offset, offset + 500)));
    }
    return rows;
  }

  getCoveredYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    const result = new Map<string, readonly number[]>();
    const rows = this.readForCodes(codes, (batch) => {
      const query = this.db
        .select({
          code: symbolFactsState.code,
          protocol: symbolFactsState.actionCoverageProtocolJson,
        })
        .from(symbolFactsState);
      return batch === undefined
        ? query.all()
        : query.where(inArray(symbolFactsState.code, batch)).all();
    });
    for (const row of rows) {
      // 구버전은 periodKey='-' gap을 버리고도 legacy coverage를 닫았다. 현재 프로토콜로
      // 실제 재수집한 연도만 신뢰해, 선택 유니버스의 필요한 연도만 on-demand로 연다.
      result.set(row.code, parseProtocolYears(row.protocol));
    }
    return result;
  }

  getGapYears(codes?: readonly string[]): ReadonlyMap<string, readonly number[]> {
    return this.readYears('actionGapYearsJson', codes);
  }

  getGapDetails(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly CorporateActionGapDetail[]> {
    const result = new Map<string, readonly CorporateActionGapDetail[]>();
    const rows = this.readForCodes(codes, (batch) => {
      const query = this.db
        .select({
          code: symbolFactsState.code,
          years: symbolFactsState.actionGapYearsJson,
          details: symbolFactsState.actionGapDetailsJson,
        })
        .from(symbolFactsState);
      return batch === undefined
        ? query.all()
        : query.where(inArray(symbolFactsState.code, batch)).all();
    });
    for (const row of rows) {
      const details = parseGapDetails(row.details);
      const detailedYears = new Set(details.map((detail) => detail.year));
      result.set(row.code, uniqueGapDetails([
        ...details,
        ...parseYears(row.years)
          .filter((year) => !detailedYears.has(year))
          .map(legacyGapDetail),
      ]));
    }
    return result;
  }

  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    const rows = this.readForCodes(codes, (batch) => {
      const query = this.db
        .select({
          code: symbolFactsState.code,
          updatedAtMs: symbolFactsState.actionUpdatedAtMs,
        })
        .from(symbolFactsState);
      return batch === undefined
        ? query.all()
        : query.where(inArray(symbolFactsState.code, batch)).all();
    });
    for (const row of rows) {
      if (row.updatedAtMs !== null) result.set(row.code, row.updatedAtMs);
    }
    return result;
  }

  addCoveredYears(symbol: string, years: readonly number[], nowMs: number): void {
    this.addCoverageResult(symbol, years, [], nowMs);
  }

  addGapYears(symbol: string, years: readonly number[], nowMs: number): void {
    if (years.length === 0) return;
    const existing = this.db
      .select()
      .from(symbolFactsState)
      .where(eq(symbolFactsState.code, symbol))
      .get();
    const mergedYears = [...new Set([
      ...(existing ? parseYears(existing.actionGapYearsJson) : []),
      ...years,
    ])].sort((a, b) => a - b);
    const details = uniqueGapDetails([
      ...(existing ? parseGapDetails(existing.actionGapDetailsJson) : []),
      ...years.map(legacyGapDetail),
    ]);
    const values = {
      actionGapYearsJson: JSON.stringify(mergedYears),
      actionGapDetailsJson: JSON.stringify(details),
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
      .values({
        code: symbol,
        coveredYearsJson: '[]',
        ...values,
      })
      .run();
  }

  addCoverageResult(
    symbol: string,
    coveredYears: readonly number[],
    gapYears: readonly number[],
    nowMs: number,
    gapDetails: readonly CorporateActionGapDetail[] = [],
  ): void {
    if (coveredYears.length === 0) return;
    const completed = new Set(coveredYears);
    if (gapYears.some((year) => !completed.has(year))) {
      throw new Error('자본변동 gap 연도는 이번에 완료한 coverage 연도 안에 있어야 합니다.');
    }
    if (gapDetails.some((detail) => !completed.has(detail.year) || !gapYears.includes(detail.year))) {
      throw new Error('자본변동 gap 상세는 이번에 발견한 gap 연도 안에 있어야 합니다.');
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
    // 팩트 저장소가 같은 work-unit 연도의 자본변동 snapshot을 먼저 교체하므로, 이번에
    // 완료한 연도의 옛 gap도 함께 제거한 뒤 최신 결과만 남길 수 있다. 다른 연도 gap은
    // 그 연도를 다시 받기 전까지 보존한다.
    const mergedGaps = [...new Set([
      ...(existing ? parseYears(existing.actionGapYearsJson) : [])
        .filter((year) => !completed.has(year)),
      ...gapYears,
    ])].sort((a, b) => a - b);
    const currentDetails = gapDetails.length > 0 ? gapDetails : gapYears.map(legacyGapDetail);
    const mergedGapDetails = uniqueGapDetails([
      ...(existing ? parseGapDetails(existing.actionGapDetailsJson) : [])
        .filter((detail) => !completed.has(detail.year)),
      ...currentDetails,
    ]);
    const values = {
      actionCoveredYearsJson: JSON.stringify(mergedCovered),
      actionGapYearsJson: JSON.stringify(mergedGaps),
      actionGapDetailsJson: JSON.stringify(mergedGapDetails),
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
    const rows = this.readForCodes(codes, (batch) => {
      const query = this.db
        .select({ code: symbolFactsState.code, years: symbolFactsState[column] })
        .from(symbolFactsState);
      return batch === undefined
        ? query.all()
        : query.where(inArray(symbolFactsState.code, batch)).all();
    });
    for (const row of rows) {
      result.set(row.code, parseYears(row.years));
    }
    return result;
  }
}
