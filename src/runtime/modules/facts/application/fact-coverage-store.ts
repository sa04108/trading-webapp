import { createHash, type Hash } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { AppDatabase } from "../../../shared/db/database.js";
import { readRuntimeVersions } from "../../../shared/runtime-versions.js";
import {
  dartFinancialFilingReceipts,
  facts as factRows,
  symbolFactsState,
} from "../../../shared/db/schema.js";
import { CORPORATE_ACTION_FIELD } from "../domain/fact.js";
import type { FactIngestionGap } from "./ports.js";

export const FINANCIAL_COVERAGE_PROTOCOL_VERSION = 2;
const GAP_EXAMPLE_LIMIT = 10;
const GAP_EXAMPLE_MAX_CHARS = 240;

export interface FinancialCoverageState {
  /** 현재 protocol manifest와 실제 fact snapshot이 일치하는 연도. */
  readonly verifiedYears: readonly number[];
  /** 검증은 끝났지만 parser/source gap 때문에 실행에 쓰면 안 되는 연도. */
  readonly blockingGapYears: readonly number[];
  /** 사용자 오류 메시지에 노출할 제한된 원인 예시. */
  readonly blockingGapDetails: readonly {
    readonly year: number;
    readonly examples: readonly string[];
  }[];
}

interface FinancialYearManifest {
  readonly year: number;
  readonly factCount: number;
  readonly factContentHash: string;
  readonly blockingGapCount: number;
  readonly blockingGapHash: string;
  readonly blockingGapExamples: readonly string[];
  readonly informationalGapCount: number;
  readonly informationalGapHash: string;
}

interface FinancialCoverageProtocol {
  readonly version: number;
  /** 진단용 출처이며 재사용·재수집 권한과 무관하다. 없는 과거 기록도 허용한다. */
  readonly collectionVersion?: string | null;
  readonly manifests: readonly FinancialYearManifest[];
}

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
  getCoveredYears(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]>;
  /**
   * protocol 검증과 무관하게 과거에 원천 수집을 완료한 연도.
   * 검증 실패를 최초 수집으로 오인하지 않도록 수집 이력과 실행 가능 상태를 구분한다.
   */
  getCollectedYears?(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]>;
  /** manifest 무결성과 blocking ingestion gap을 한 번에 읽는다. */
  getCoverageState(
    codes?: readonly string[],
  ): ReadonlyMap<string, FinancialCoverageState>;
  /** 종목 하나의 완료 연도를 합집합으로 더한다. 팩트 저장 직후에 부른다. */
  addCoveredYears(
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void;
  /** 실제 수집 gap과 현재 fact snapshot manifest를 coverage와 함께 기록한다. */
  addCoverageResult(
    symbol: string,
    years: readonly number[],
    gaps: readonly FactIngestionGap[],
    nowMs: number,
  ): void;
  /**
   * 종목 → 마지막 재무 coverage 기록 시각. 재무 공시검색만의 watermark 다.
   * 기록이 없는 종목은 키를 만들지 않는다.
   */
  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number>;
  /** 후보 중 이미 재무 수집에 반영한 DART 접수번호 */
  getProcessedFilingReceiptNos(
    receiptNos: readonly string[],
  ): ReadonlySet<string>;
  /** 팩트 저장과 버전 반영에 성공한 공시만 멱등하게 기록한다 */
  addProcessedFilings(
    filings: readonly FinancialFilingCheckpoint[],
    processedAtMs: number,
  ): void;
}

export class SqliteFactCoverageStore implements FactCoverageStore {
  private readonly collectionVersion: string;

  constructor(
    private readonly db: AppDatabase,
    options?: { readonly collectionVersion: string },
  ) {
    // 실행 버전은 새 manifest의 진단용 출처로만 기록한다.
    this.collectionVersion =
      options?.collectionVersion ?? readRuntimeVersions().collectionVersion;
  }

  getCoveredYears(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]> {
    return new Map(
      [...this.getCoverageState(codes)].map(([code, state]) => [
        code,
        state.verifiedYears,
      ]),
    );
  }

  getCollectedYears(
    codes?: readonly string[],
  ): ReadonlyMap<string, readonly number[]> {
    const requested = codes === undefined ? null : new Set(codes);
    return new Map(
      this.db
        .select({
          code: symbolFactsState.code,
          years: symbolFactsState.coveredYearsJson,
        })
        .from(symbolFactsState)
        .all()
        .filter((row) => requested === null || requested.has(row.code))
        .map((row) => [row.code, parseYears(row.years)]),
    );
  }

  getCoverageState(
    codes?: readonly string[],
  ): ReadonlyMap<string, FinancialCoverageState> {
    const requested = codes === undefined ? null : new Set(codes);
    const rows = this.db
      .select()
      .from(symbolFactsState)
      .all()
      .filter((row) => requested === null || requested.has(row.code));
    const protocols = new Map(
      rows.map((row) => [
        row.code,
        parseFinancialCoverageProtocol(row.financialCoverageProtocolJson),
      ]),
    );
    const actual = this.actualFactManifests(
      new Map(
        [...protocols].map(([code, protocol]) => [
          code,
          protocol?.manifests.map((manifest) => manifest.year) ?? [],
        ]),
      ),
    );
    const result = new Map<string, FinancialCoverageState>();
    for (const row of rows) {
      const protocol = protocols.get(row.code);
      if (protocol === null || protocol === undefined) {
        result.set(row.code, {
          verifiedYears: [],
          blockingGapYears: [],
          blockingGapDetails: [],
        });
        continue;
      }
      const verified: number[] = [];
      const blocking: number[] = [];
      const blockingDetails: Array<{
        year: number;
        examples: readonly string[];
      }> = [];
      // 기존 컬럼과 protocol의 교집합만 완료로 인정한다. 내용·건수 검사도 유지한다.
      const legacyCovered = new Set(parseYears(row.coveredYearsJson));
      for (const manifest of protocol.manifests) {
        if (!legacyCovered.has(manifest.year)) continue;
        const current = actual.get(`${row.code}:${manifest.year}`);
        if (
          current === undefined ||
          current.factCount !== manifest.factCount ||
          current.factContentHash !== manifest.factContentHash
        )
          continue;
        verified.push(manifest.year);
        if (manifest.blockingGapCount > 0) {
          blocking.push(manifest.year);
          blockingDetails.push({
            year: manifest.year,
            examples: manifest.blockingGapExamples,
          });
        }
      }
      result.set(row.code, {
        verifiedYears: verified.sort((left, right) => left - right),
        blockingGapYears: blocking.sort((left, right) => left - right),
        blockingGapDetails: blockingDetails.sort(
          (left, right) => left.year - right.year,
        ),
      });
    }
    return result;
  }

  getUpdatedAtMs(codes: readonly string[]): ReadonlyMap<string, number> {
    const rows = this.db
      .select({
        code: symbolFactsState.code,
        updatedAtMs: symbolFactsState.financialUpdatedAtMs,
      })
      .from(symbolFactsState)
      .all();
    const result = new Map<string, number>();
    for (const row of rows) {
      if (codes.includes(row.code) && row.updatedAtMs !== null)
        result.set(row.code, row.updatedAtMs);
    }
    return result;
  }

  getProcessedFilingReceiptNos(
    receiptNos: readonly string[],
  ): ReadonlySet<string> {
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
    const unique = [
      ...new Map(filings.map((filing) => [filing.receiptNo, filing])).values(),
    ];
    // 한 행이 바인드 변수 5개를 쓰므로 100건씩 넣어 구형 SQLite의 상한도 넘지 않는다.
    for (let offset = 0; offset < unique.length; offset += 100) {
      const chunk = unique.slice(offset, offset + 100);
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

  addCoveredYears(
    symbol: string,
    years: readonly number[],
    nowMs: number,
  ): void {
    this.addCoverageResult(symbol, years, [], nowMs);
  }

  addCoverageResult(
    symbol: string,
    years: readonly number[],
    gaps: readonly FactIngestionGap[],
    nowMs: number,
  ): void {
    // 빈 목록은 기록하지 않는다 — "수집됨"과 "수집할 게 없었음"은 다른 상태다.
    if (years.length === 0) return;
    if (years.some((year) => !validYear(year))) {
      throw new Error(
        `재무 coverage 연도가 유효하지 않습니다: ${years.join(", ")}`,
      );
    }
    const normalizedYears = [...new Set(years)].sort((a, b) => a - b);
    if (gaps.some((gap) => gap.symbol !== symbol)) {
      throw new Error(
        `재무 coverage gap의 종목코드가 요청 종목 ${symbol}과 다릅니다.`,
      );
    }
    // 실제 fact snapshot을 읽은 직후 같은 동기 연결에서 manifest를 기록한다.
    const actual = this.actualFactManifests(
      new Map([[symbol, normalizedYears]]),
    );
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(symbolFactsState)
        .where(eq(symbolFactsState.code, symbol))
        .get();
      const existingProtocol = parseFinancialCoverageProtocol(
        existing?.financialCoverageProtocolJson ?? null,
      );
      const byYear = new Map(
        (existingProtocol?.manifests ?? []).map((manifest) => [
          manifest.year,
          manifest,
        ]),
      );
      for (const year of normalizedYears) {
        const current = actual.get(`${symbol}:${year}`) ?? emptyFactManifest();
        const yearGaps = gaps.filter((gap) => gapAppliesToYear(gap, year));
        const blocking = yearGaps.filter((gap) => gap.severity === "BLOCKING");
        const informational = yearGaps.filter(
          (gap) => gap.severity === "INFORMATIONAL",
        );
        byYear.set(year, {
          year,
          ...current,
          blockingGapCount: blocking.length,
          blockingGapHash: gapHash(blocking),
          blockingGapExamples: gapExamples(blocking),
          informationalGapCount: informational.length,
          informationalGapHash: gapHash(informational),
        });
      }
      const merged = [
        ...new Set([
          ...(existing ? parseYears(existing.coveredYearsJson) : []),
          ...normalizedYears,
        ]),
      ].sort((a, b) => a - b);
      const values = {
        coveredYearsJson: JSON.stringify(merged),
        financialCoverageProtocolJson: JSON.stringify({
          version: FINANCIAL_COVERAGE_PROTOCOL_VERSION,
          collectionVersion: this.collectionVersion,
          manifests: [...byYear.values()].sort(
            (left, right) => left.year - right.year,
          ),
        } satisfies FinancialCoverageProtocol),
        financialUpdatedAtMs: nowMs,
      };

      if (existing) {
        tx.update(symbolFactsState)
          .set(values)
          .where(eq(symbolFactsState.code, symbol))
          .run();
        return;
      }
      tx.insert(symbolFactsState)
        .values({ code: symbol, ...values })
        .run();
    });
  }

  private actualFactManifests(
    yearsByCode: ReadonlyMap<string, readonly number[]>,
  ): ReadonlyMap<
    string,
    Pick<FinancialYearManifest, "factCount" | "factContentHash">
  > {
    const requested = new Map(
      [...yearsByCode].map(([code, years]) => [
        code,
        new Set(years.filter(validYear)),
      ]),
    );
    // 정렬된 조회를 순서대로 해시해 전체 facts와 직렬화 문자열의 중복 적재를 피한다.
    const manifests = new Map<string, { factCount: number; hash: Hash }>();
    for (const [code, years] of requested) {
      for (const year of years) {
        manifests.set(`${code}:${year}`, {
          factCount: 0,
          hash: createHash("sha256"),
        });
      }
    }
    const codes = [...requested.keys()];
    for (let offset = 0; offset < codes.length; offset += 32) {
      const chunk = codes.slice(offset, offset + 32);
      if (chunk.length === 0) continue;
      const rows = this.db
        .select({
          code: factRows.key,
          field: factRows.field,
          periodKey: factRows.periodKey,
          asOfTsMs: factRows.asOfTsMs,
          value: factRows.value,
          unit: factRows.unit,
        })
        .from(factRows)
        .where(
          and(
            eq(factRows.scope, "SYMBOL"),
            inArray(factRows.key, chunk),
            ne(factRows.field, CORPORATE_ACTION_FIELD),
          ),
        )
        .orderBy(
          asc(factRows.key),
          asc(factRows.field),
          asc(factRows.periodKey),
          asc(factRows.asOfTsMs),
        )
        .all();
      for (const row of rows) {
        const year = periodKeyYear(row.periodKey);
        if (year === null || !requested.get(row.code)?.has(year)) continue;
        const manifest = manifests.get(`${row.code}:${year}`)!;
        if (manifest.factCount > 0) manifest.hash.update("\n");
        manifest.hash.update(
          JSON.stringify([
            row.field,
            row.periodKey,
            row.asOfTsMs,
            row.value,
            row.unit,
          ]),
        );
        manifest.factCount += 1;
      }
    }
    return new Map(
      [...manifests].map(([key, manifest]) => [
        key,
        {
          factCount: manifest.factCount,
          factContentHash: manifest.hash.digest("hex"),
        },
      ]),
    );
  }
}

function parseFinancialCoverageProtocol(
  raw: string | null,
): FinancialCoverageProtocol | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FinancialCoverageProtocol>;
    // 실행 해시와 달리 해석 protocol·manifest 형식은 실제 호환성 조건이다.
    if (
      parsed.version !== FINANCIAL_COVERAGE_PROTOCOL_VERSION ||
      !Array.isArray(parsed.manifests)
    )
      return null;
    const manifests = parsed.manifests.filter(isFinancialYearManifest);
    if (manifests.length !== parsed.manifests.length) return null;
    if (
      new Set(manifests.map((manifest) => manifest.year)).size !==
      manifests.length
    )
      return null;
    return {
      version: FINANCIAL_COVERAGE_PROTOCOL_VERSION,
      ...(typeof parsed.collectionVersion === "string" || parsed.collectionVersion === null
        ? { collectionVersion: parsed.collectionVersion }
        : {}),
      manifests,
    };
  } catch {
    return null;
  }
}

function isFinancialYearManifest(
  value: unknown,
): value is FinancialYearManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<FinancialYearManifest>;
  return (
    validYear(manifest.year) &&
    Number.isInteger(manifest.factCount) &&
    manifest.factCount! >= 0 &&
    typeof manifest.factContentHash === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.factContentHash) &&
    Number.isInteger(manifest.blockingGapCount) &&
    manifest.blockingGapCount! >= 0 &&
    typeof manifest.blockingGapHash === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.blockingGapHash) &&
    Array.isArray(manifest.blockingGapExamples) &&
    manifest.blockingGapExamples.every(
      (example) => typeof example === "string",
    ) &&
    Number.isInteger(manifest.informationalGapCount) &&
    manifest.informationalGapCount! >= 0 &&
    typeof manifest.informationalGapHash === "string" &&
    /^[a-f0-9]{64}$/.test(manifest.informationalGapHash)
  );
}

function validYear(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 1900 && Number(value) <= 2200
  );
}

function periodKeyYear(periodKey: string): number | null {
  const match = /^(\d{4})/.exec(periodKey);
  if (!match) return null;
  const year = Number(match[1]);
  return validYear(year) ? year : null;
}

function gapAppliesToYear(gap: FactIngestionGap, year: number): boolean {
  const gapYear = periodKeyYear(gap.periodKey);
  return gapYear === null || gapYear === year;
}

function gapHash(gaps: readonly FactIngestionGap[]): string {
  return createHash("sha256")
    .update(
      [...gaps]
        .sort(
          (left, right) =>
            left.periodKey.localeCompare(right.periodKey) ||
            left.reason.localeCompare(right.reason),
        )
        .map((gap) => JSON.stringify([gap.severity, gap.periodKey, gap.reason]))
        .join("\n"),
    )
    .digest("hex");
}

function gapExamples(gaps: readonly FactIngestionGap[]): string[] {
  return [
    ...new Set(
      gaps.map((gap) => {
        const example = `${gap.periodKey}: ${gap.reason}`;
        return example.length <= GAP_EXAMPLE_MAX_CHARS
          ? example
          : `${example.slice(0, GAP_EXAMPLE_MAX_CHARS - 1)}…`;
      }),
    ),
  ]
    .sort()
    .slice(0, GAP_EXAMPLE_LIMIT);
}

function emptyFactManifest(): Pick<
  FinancialYearManifest,
  "factCount" | "factContentHash"
> {
  return {
    factCount: 0,
    factContentHash: createHash("sha256").update("").digest("hex"),
  };
}

/**
 * NULL 또는 읽을 수 없는 JSON을 빈 연도 목록으로 읽는다.
 * 빈 목록 자체가 원천 HTTP 허가는 아니다. 호출자는 수집 이력·원문 상태도 구분해야 한다.
 */
export function parseYears(json: string | null): readonly number[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((year): year is number => typeof year === "number")
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
