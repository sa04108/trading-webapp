import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  dailySelectionMetricCoverage,
  dailySelectionMetrics,
} from '../../../shared/db/schema.js';

export interface DailySelectionMetric {
  readonly date: string;
  readonly standardCode: string;
  readonly marketCapKrw: bigint | null;
  readonly volume: number | null;
  readonly tradingValueKrw: bigint | null;
}

function fromRow(row: typeof dailySelectionMetrics.$inferSelect): DailySelectionMetric {
  return {
    date: row.date,
    standardCode: row.standardCode,
    marketCapKrw: row.marketCapKrw === null ? null : BigInt(row.marketCapKrw),
    volume: row.volume,
    tradingValueKrw: row.tradingValueKrw === null ? null : BigInt(row.tradingValueKrw),
  };
}

/** portable SQLite 999-bind limit below; date 조건까지 고려해 여유를 둔다. */
const READ_BATCH_SIZE = 500;
// 날짜 PK 범위 한 번이 500-code IN 여러 번보다 싸지는 크기다. KOSDAQ 전체 후보처럼
// 큰 입력은 그 날짜의 두 시장 metric을 한 번 읽고 요청 코드만 남긴다.
const FULL_DATE_READ_THRESHOLD = 1_500;

/** KRX 선정 지표의 bigint/text 변환을 이 저장소 경계에 가둔다. */
export class SelectionMetricRepository {
  constructor(private readonly db: AppDatabase) {}

  markCoveredDates(dates: readonly string[], syncedAtMs: number): void {
    const uniqueDates = [...new Set(dates)];
    for (let index = 0; index < uniqueDates.length; index += READ_BATCH_SIZE) {
      this.db.insert(dailySelectionMetricCoverage)
        .values(uniqueDates.slice(index, index + READ_BATCH_SIZE).map((date) => ({
          date,
          syncedAtMs,
        })))
        .onConflictDoUpdate({
          target: dailySelectionMetricCoverage.date,
          set: { syncedAtMs },
        })
        .run();
    }
  }

  upsertMany(rows: readonly DailySelectionMetric[]): void {
    // 5개 컬럼을 쓰므로 SQLite 999 bind 한도 아래의 190개씩 처리한다.
    for (let index = 0; index < rows.length; index += 190) {
      const values = rows.slice(index, index + 190).map((row) => ({
        date: row.date,
        standardCode: row.standardCode,
        marketCapKrw: row.marketCapKrw?.toString() ?? null,
        volume: row.volume,
        tradingValueKrw: row.tradingValueKrw?.toString() ?? null,
      }));
      this.db.insert(dailySelectionMetrics)
        .values(values)
        .onConflictDoUpdate({
          target: [dailySelectionMetrics.date, dailySelectionMetrics.standardCode],
          set: {
            marketCapKrw: sql`excluded.market_cap_krw`,
            volume: sql`excluded.volume`,
            tradingValueKrw: sql`excluded.trading_value_krw`,
          },
        })
        .run();
    }
  }

  getAt(date: string, standardCodes: readonly string[]): ReadonlyMap<string, DailySelectionMetric> {
    const uniqueCodes = [...new Set(standardCodes)];
    const metrics = new Map<string, DailySelectionMetric>();
    if (uniqueCodes.length >= FULL_DATE_READ_THRESHOLD) {
      const requested = new Set(uniqueCodes);
      const rows = this.db.select()
        .from(dailySelectionMetrics)
        .where(eq(dailySelectionMetrics.date, date))
        .all();
      for (const row of rows) {
        if (requested.has(row.standardCode)) metrics.set(row.standardCode, fromRow(row));
      }
      return metrics;
    }
    for (let index = 0; index < uniqueCodes.length; index += READ_BATCH_SIZE) {
      const rows = this.db.select()
        .from(dailySelectionMetrics)
        .where(and(
          eq(dailySelectionMetrics.date, date),
          inArray(dailySelectionMetrics.standardCode, uniqueCodes.slice(index, index + READ_BATCH_SIZE)),
        ))
        .all();
      for (const row of rows) metrics.set(row.standardCode, fromRow(row));
    }
    return metrics;
  }

  /**
   * 선정 지표 API 조회 완료 표식이 없는 날짜만 돌려준다. 값 행으로 추론하면 모든
   * 거래대금이 '-'인 응답과 아직 조회하지 않은 날짜를 구분할 수 없다.
   */
  findMissingTradingValueDates(dates: readonly string[]): string[] {
    const requestedDates = [...new Set(dates)];
    if (requestedDates.length === 0) return [];
    const ingested = new Set<string>();
    for (let index = 0; index < requestedDates.length; index += READ_BATCH_SIZE) {
      const rows = this.db.select({ date: dailySelectionMetricCoverage.date })
        .from(dailySelectionMetricCoverage)
        .where(inArray(
          dailySelectionMetricCoverage.date,
          requestedDates.slice(index, index + READ_BATCH_SIZE),
        ))
        .all();
      for (const row of rows) ingested.add(row.date);
    }
    return requestedDates.filter((date) => !ingested.has(date));
  }
}
