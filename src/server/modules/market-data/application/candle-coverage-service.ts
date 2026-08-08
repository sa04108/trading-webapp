import { count, inArray, max, min } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';

export interface CandleCoverageRow {
  readonly code: string;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

const dateToTsMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/**
 * 종목별 일봉 보유 구간. 캐시 테이블을 두지 않는 이유: `(short_code, date)` PK 가
 * 있어 집계가 인덱스 스캔 하나로 끝난다. 캐시가 필요했던 건 parquet 조회가 비쌌기
 * 때문이고, 그 비용이 사라지면 캐시는 어긋날 수 있는 사본일 뿐이다.
 */
export class CandleCoverageService {
  constructor(private readonly db: AppDatabase) {}

  getCoverage(codes: readonly string[]): CandleCoverageRow[] {
    if (codes.length === 0) return [];

    const rows = this.db
      .select({
        code: krxDailyBars.shortCode,
        firstDate: min(krxDailyBars.date),
        lastDate: max(krxDailyBars.date),
        barCount: count(),
      })
      .from(krxDailyBars)
      .where(inArray(krxDailyBars.shortCode, [...codes]))
      .groupBy(krxDailyBars.shortCode)
      .all();

    const byCode = new Map(rows.map((row) => [row.code, row]));

    // 봉이 없는 종목도 결과에 넣는다 — 호출부가 "없음" 과 "안 물어봄" 을 구분해야 한다
    return codes.map((code) => {
      const row = byCode.get(code);
      if (row === undefined || row.firstDate === null || row.lastDate === null) {
        return { code, firstTsMs: null, lastTsMs: null, barCount: 0 };
      }
      return {
        code,
        firstTsMs: dateToTsMs(row.firstDate),
        lastTsMs: dateToTsMs(row.lastDate),
        barCount: row.barCount,
      };
    });
  }
}
