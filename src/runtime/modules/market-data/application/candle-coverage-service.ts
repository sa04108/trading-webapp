import { and, asc, count, eq, gt, gte, inArray, lte, max, min, or } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';

export interface CandleCoverageRow {
  readonly code: string;
  readonly firstTsMs: number | null;
  readonly lastTsMs: number | null;
  readonly barCount: number;
}

export interface CandleTimeWindow {
  readonly fromTsMs: number;
  readonly toTsMs: number;
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
   * 요청 구간 안에서 worker가 실제로 읽을 수 있는 유효 일봉만 종목별 집계한다.
   * 전체 이력 min/max로는 기간 밖의 옛 봉 한 개가 현재 기간의 결측을 가리는 문제가
   * 있어 제출·미리보기의 fail-closed 검사는 이 메서드를 써야 한다.
   */
  getCoverageBetween(
    codes: readonly string[],
    fromTsMs: number,
    toTsMs: number,
  ): CandleCoverageRow[] {
    if (codes.length === 0) return [];
    const from = new Date(fromTsMs).toISOString().slice(0, 10);
    const to = new Date(toTsMs).toISOString().slice(0, 10);
    const rows = this.db
      .select({
        code: krxDailyBars.shortCode,
        firstDate: min(krxDailyBars.date),
        lastDate: max(krxDailyBars.date),
        barCount: count(),
      })
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
      .groupBy(krxDailyBars.shortCode)
      .all();
    const byCode = new Map(rows.map((row) => [row.code, row]));
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

  /** 구간 안에서 worker 유효성 조건을 모두 만족하는 일봉 날짜를 종목별로 반환한다. */
  getValidDatesByCodeBetween(
    codes: readonly string[],
    from: string,
    to: string,
  ): ReadonlyMap<string, readonly string[]> {
    const result = new Map<string, string[]>();
    for (const code of codes) result.set(code, []);
    if (codes.length === 0) return result;
    const rows = this.db
      .select({ code: krxDailyBars.shortCode, date: krxDailyBars.date })
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
      .orderBy(asc(krxDailyBars.shortCode), asc(krxDailyBars.date))
      .all();
    for (const row of rows) result.get(row.code)?.push(row.date);
    return result;
  }

  /**
   * 종목별 닫힌 실행 구간 안에서 worker가 읽을 수 있는 마지막 유효 일봉을 찾는다.
   * 동적 유니버스에서 편출 뒤의 봉이나 상장폐지 뒤 재사용 코드의 봉을 재무 PIT 상한으로
   * 쓰지 않기 위한 조회다. SQLite 변수 상한을 넘지 않도록 구간을 묶어 조회한다.
   */
  getLastTsInWindows(
    windowsByCode: ReadonlyMap<string, readonly CandleTimeWindow[]>,
  ): ReadonlyMap<string, number> {
    const entries = [...windowsByCode].flatMap(([code, windows]) =>
      windows.flatMap((window) => (
        Number.isFinite(window.fromTsMs)
        && Number.isFinite(window.toTsMs)
        && window.fromTsMs <= window.toTsMs
          ? [{ code, window }]
          : []
      )),
    );
    const result = new Map<string, number>();
    const batchSize = 100;
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      const batch = entries.slice(offset, offset + batchSize);
      const windowClause = or(...batch.map(({ code, window }) => and(
        eq(krxDailyBars.shortCode, code),
        gte(krxDailyBars.date, new Date(window.fromTsMs).toISOString().slice(0, 10)),
        lte(krxDailyBars.date, new Date(window.toTsMs).toISOString().slice(0, 10)),
      )));
      if (windowClause === undefined) continue;
      const rows = this.db
        .select({
          code: krxDailyBars.shortCode,
          lastDate: max(krxDailyBars.date),
        })
        .from(krxDailyBars)
        .where(and(
          windowClause,
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
        .groupBy(krxDailyBars.shortCode)
        .all();
      for (const row of rows) {
        if (row.lastDate === null) continue;
        const tsMs = dateToTsMs(row.lastDate);
        const existing = result.get(row.code);
        if (existing === undefined || tsMs > existing) result.set(row.code, tsMs);
      }
    }
    return result;
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
