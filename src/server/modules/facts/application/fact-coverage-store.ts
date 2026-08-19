import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  dartFinancialFilingReceipts,
  symbolFactsState,
} from '../../../shared/db/schema.js';

/** 재무 수집으로 반영을 끝낸 정기공시 한 건의 체크포인트 */
export interface FinancialFilingCheckpoint {
  readonly receiptNo: string;
  readonly symbol: string;
  readonly businessYear: number;
  readonly receiptDate: string;
}

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
   * 종목 → 마지막 재무 coverage 기록 시각. 재무 공시검색만의 watermark 다.
   * 기록이 없는 종목은 키를 만들지 않는다.
   */
  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number>;
  /** 후보 중 이미 재무 수집에 반영한 DART 접수번호 */
  getProcessedFilingReceiptNos(receiptNos: readonly string[]): ReadonlySet<string>;
  /** 팩트 저장과 버전 반영에 성공한 공시만 멱등하게 기록한다 */
  addProcessedFilings(
    filings: readonly FinancialFilingCheckpoint[],
    processedAtMs: number,
  ): void;
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
    const rows = this.db
      .select({ code: symbolFactsState.code, updatedAtMs: symbolFactsState.financialUpdatedAtMs })
      .from(symbolFactsState)
      .all();
    const result = new Map<string, number>();
    for (const row of rows) {
      if (codes.includes(row.code) && row.updatedAtMs !== null) result.set(row.code, row.updatedAtMs);
    }
    return result;
  }

  getProcessedFilingReceiptNos(receiptNos: readonly string[]): ReadonlySet<string> {
    const result = new Set<string>();
    // SQLite 빌드별 바인드 변수 상한보다 충분히 작게 나눠 조회한다.
    for (let offset = 0; offset < receiptNos.length; offset += 500) {
      const chunk = receiptNos.slice(offset, offset + 500);
      if (chunk.length === 0) continue;
      const rows = this.db
        .select({ receiptNo: dartFinancialFilingReceipts.receiptNo })
        .from(dartFinancialFilingReceipts)
        .where(inArray(dartFinancialFilingReceipts.receiptNo, chunk))
        .all();
      for (const row of rows) result.add(row.receiptNo);
    }
    return result;
  }

  addProcessedFilings(
    filings: readonly FinancialFilingCheckpoint[],
    processedAtMs: number,
  ): void {
    const unique = [...new Map(filings.map((filing) => [filing.receiptNo, filing])).values()];
    // 한 행이 바인드 변수 5개를 쓰므로 100건씩 넣어 구형 SQLite의 상한도 넘지 않는다.
    for (let offset = 0; offset < unique.length; offset += 100) {
      const chunk = unique.slice(offset, offset + 100);
      if (chunk.length === 0) continue;
      this.db
        .insert(dartFinancialFilingReceipts)
        .values(
          chunk.map((filing) => ({
            receiptNo: filing.receiptNo,
            code: filing.symbol,
            businessYear: filing.businessYear,
            receiptDate: filing.receiptDate,
            processedAtMs,
          })),
        )
        .onConflictDoNothing()
        .run();
    }
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
        .set({ coveredYearsJson, updatedAtMs: nowMs, financialUpdatedAtMs: nowMs })
        .where(eq(symbolFactsState.code, symbol))
        .run();
      return;
    }
    this.db
      .insert(symbolFactsState)
      .values({ code: symbol, coveredYearsJson, updatedAtMs: nowMs, financialUpdatedAtMs: nowMs })
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
