import { and, asc, count, gt, gte, inArray, lte, max, min } from 'drizzle-orm';
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
 * 있어 집계가 인덱스 스캔 하나로 끝난다. 조회가 충분히 저렴하고 캐시는 어긋날 수
 * 있는 사본일 뿐이다.
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

  /**
   * 선택 종목 중 하나라도 유효한 일봉 행이 있는 실제 날짜 타임라인.
   * 리밸런스 간격 검증은 종목별 OHLCV 전체를 다시 읽을 필요가 없어 날짜만 DISTINCT한다.
   */
  getTimeline(codes: readonly string[], fromTsMs: number, toTsMs: number): number[] {
    if (codes.length === 0) return [];
    const from = new Date(fromTsMs).toISOString().slice(0, 10);
    const to = new Date(toTsMs).toISOString().slice(0, 10);
    return this.db
      .select({ date: krxDailyBars.date })
      .from(krxDailyBars)
      .where(and(
        inArray(krxDailyBars.shortCode, [...codes]),
        gte(krxDailyBars.date, from),
        lte(krxDailyBars.date, to),
        inArray(krxDailyBars.market, ['KOSPI', 'KOSDAQ']),
        gt(krxDailyBars.open, 0),
        gt(krxDailyBars.high, 0),
        gt(krxDailyBars.low, 0),
        gt(krxDailyBars.close, 0),
        gte(krxDailyBars.volume, 0),
        gte(krxDailyBars.high, krxDailyBars.low),
        gte(krxDailyBars.high, krxDailyBars.open),
        gte(krxDailyBars.high, krxDailyBars.close),
        lte(krxDailyBars.low, krxDailyBars.open),
        lte(krxDailyBars.low, krxDailyBars.close),
      ))
      .groupBy(krxDailyBars.date)
      .orderBy(asc(krxDailyBars.date))
      .all()
      .map((row) => dateToTsMs(row.date))
      .filter((tsMs) => Number.isFinite(tsMs) && tsMs > 0);
  }
}
