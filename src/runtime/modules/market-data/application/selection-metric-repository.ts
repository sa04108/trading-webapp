import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../../../shared/db/database.js";
import {
  dailySelectionMetricCoverage,
  dailySelectionMetrics,
} from "../../../shared/db/schema.js";

export interface DailySelectionMetric {
  readonly date: string;
  readonly standardCode: string;
  readonly marketCapKrw: bigint | null;
  readonly volume: number | null;
  readonly tradingValueKrw: bigint | null;
}

function fromRow(
  row: typeof dailySelectionMetrics.$inferSelect,
): DailySelectionMetric {
  return {
    date: row.date,
    standardCode: row.standardCode,
    marketCapKrw: row.marketCapKrw === null ? null : BigInt(row.marketCapKrw),
    volume: row.volume,
    tradingValueKrw:
      row.tradingValueKrw === null ? null : BigInt(row.tradingValueKrw),
  };
}

/** 날짜 조건을 포함해 구형 SQLite의 999개 바인딩 한도 아래로 나눈다. */
const READ_BATCH_SIZE = 500;
// 큰 입력에서는 날짜 전체를 한 번 조회하고 요청한 코드만 남긴다.
const FULL_DATE_READ_THRESHOLD = 1_500;

/** KRX 선정 지표의 bigint/text 변환을 이 저장소 경계에 가둔다. */
export class SelectionMetricRepository {
  constructor(
    private readonly db: AppDatabase,
    // 기존 호출부와 호환하되 실행 버전을 수집 이력 판정에 사용하지 않는다.
    _options?: { readonly collectionVersion: string },
  ) {}

  getAt(
    date: string,
    standardCodes: readonly string[],
  ): ReadonlyMap<string, DailySelectionMetric> {
    const uniqueCodes = [...new Set(standardCodes)];
    const metrics = new Map<string, DailySelectionMetric>();
    if (uniqueCodes.length >= FULL_DATE_READ_THRESHOLD) {
      const requested = new Set(uniqueCodes);
      const rows = this.db
        .select()
        .from(dailySelectionMetrics)
        .where(eq(dailySelectionMetrics.date, date))
        .all();
      for (const row of rows) {
        if (requested.has(row.standardCode))
          metrics.set(row.standardCode, fromRow(row));
      }
      return metrics;
    }
    for (let index = 0; index < uniqueCodes.length; index += READ_BATCH_SIZE) {
      const rows = this.db
        .select()
        .from(dailySelectionMetrics)
        .where(
          and(
            eq(dailySelectionMetrics.date, date),
            inArray(
              dailySelectionMetrics.standardCode,
              uniqueCodes.slice(index, index + READ_BATCH_SIZE),
            ),
          ),
        )
        .all();
      for (const row of rows) metrics.set(row.standardCode, fromRow(row));
    }
    return metrics;
  }

  /**
   * 값의 유무가 아니라 원천 요청 완료 이력을 확인한다.
   * NULL·이전 실행 해시의 정상 무자료 기록도 수집 이력이다.
   */
  findMissingTradingValueDates(dates: readonly string[]): string[] {
    const requestedDates = [...new Set(dates)];
    if (requestedDates.length === 0) return [];
    const ingested = new Set<string>();
    for (
      let index = 0;
      index < requestedDates.length;
      index += READ_BATCH_SIZE
    ) {
      const rows = this.db
        .select({ date: dailySelectionMetricCoverage.date })
        .from(dailySelectionMetricCoverage)
        .where(
          inArray(
            dailySelectionMetricCoverage.date,
            requestedDates.slice(index, index + READ_BATCH_SIZE),
          ),
        )
        .all();
      for (const row of rows) ingested.add(row.date);
    }
    return requestedDates.filter((date) => !ingested.has(date));
  }
}
