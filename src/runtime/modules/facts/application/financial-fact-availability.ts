import { and, eq, inArray, lte, min, ne } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { facts as factRows } from '../../../shared/db/schema.js';
import { CORPORATE_ACTION_FIELD } from '../domain/fact.js';

/** 자본변동을 제외한 실제 재무 fact 행을 PIT 시각까지 보유한 종목. */
export class FinancialFactAvailabilityService {
  constructor(private readonly db: AppDatabase) {}

  symbolsWithFinancialFacts(
    asOfMaxTsMsByCode: ReadonlyMap<string, number>,
  ): ReadonlySet<string> {
    const result = new Set<string>();
    const unique = [...asOfMaxTsMsByCode.keys()];
    // 현재 유니버스 상한은 200이지만, 서비스 자체는 SQLite 바인드 상한을
    // 전제하지 않도록 나눈다.
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      if (chunk.length === 0) continue;
      const chunkMaxTsMs = Math.max(...chunk.map((code) => asOfMaxTsMsByCode.get(code)!));
      const rows = this.db
        .select({ code: factRows.key, firstAsOfTsMs: min(factRows.asOfTsMs) })
        .from(factRows)
        .where(and(
          eq(factRows.scope, 'SYMBOL'),
          inArray(factRows.key, chunk),
          ne(factRows.field, CORPORATE_ACTION_FIELD),
          lte(factRows.asOfTsMs, chunkMaxTsMs),
        ))
        .groupBy(factRows.key)
        .all();
      for (const row of rows) {
        const cutoff = asOfMaxTsMsByCode.get(row.code);
        if (cutoff !== undefined && row.firstAsOfTsMs !== null && row.firstAsOfTsMs <= cutoff) {
          result.add(row.code);
        }
      }
    }
    return result;
  }
}
