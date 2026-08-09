import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { dailySelectionMetrics } from '../../../shared/db/schema.js';

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

/** KRX 선정 지표의 bigint/text 변환을 이 저장소 경계에 가둔다. */
export class SelectionMetricRepository {
  constructor(private readonly db: AppDatabase) {}

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
    if (standardCodes.length === 0) return new Map();
    const rows = this.db.select()
      .from(dailySelectionMetrics)
      .where(and(
        eq(dailySelectionMetrics.date, date),
        inArray(dailySelectionMetrics.standardCode, [...new Set(standardCodes)]),
      ))
      .all();
    return new Map(rows.map((row) => [row.standardCode, fromRow(row)]));
  }

  findMissingTradingValueDates(dates: readonly string[]): string[] {
    const requestedDates = [...new Set(dates)];
    if (requestedDates.length === 0) return [];
    const rows = this.db.select({
      date: dailySelectionMetrics.date,
      tradingValueKrw: dailySelectionMetrics.tradingValueKrw,
    })
      .from(dailySelectionMetrics)
      .where(inArray(dailySelectionMetrics.date, requestedDates))
      .all();
    const complete = new Map<string, boolean>();
    for (const row of rows) {
      complete.set(row.date, complete.get(row.date) !== false && row.tradingValueKrw !== null);
    }
    return requestedDates.filter((date) => complete.get(date) !== true);
  }
}
