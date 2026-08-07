import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';
import type { Candle, Market, Timeframe } from '../domain/candle.js';
import type { CandleQuery, CandleRepository } from '../application/ports.js';

const MS_PER_DAY = 86_400_000;

/**
 * 봉의 tsMs 규약은 "그 거래일의 UTC 자정"이다. `periodToTsRange` 가 만드는 조회
 * 범위와 같은 기준이라야 그 날의 봉이 범위 안에 들어온다 (설계 2026-08-06-krx-daily-bars).
 */
function dateToTsMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function tsMsToDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * `midnight(D) >= tsMs` 를 만족하는 가장 이른 날짜 D.
 *
 * 경계를 SQL 로 내리려면 tsMs 를 날짜로 바꿔야 하는데, 하한은 그냥 자르면 안 된다 —
 * 08-07T05:00 을 08-07 로 자르면 범위 밖인 08-07 자정 봉이 딸려 들어온다. 자정이
 * 아닌 하한은 다음 날로 올려야 정확하다.
 */
export function ceilToDate(tsMs: number): string {
  const remainder = ((tsMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return tsMsToDate(remainder === 0 ? tsMs : tsMs + (MS_PER_DAY - remainder));
}

/** `midnight(D) <= tsMs` 를 만족하는 가장 늦은 날짜 D — 상한은 자르기만 하면 된다 */
export function floorToDate(tsMs: number): string {
  return tsMsToDate(tsMs);
}

/**
 * KRX 일봉(`krx_daily_bars`)을 읽는 유일한 봉 저장소.
 *
 * 쓰기는 `SymbolMasterService.ingestDate` 가 종목 마스터 이벤트·coverage 와 같은
 * 트랜잭션 안에서 직접 한다. 저장소가 쓰기를 갖지 않는 이유가 그것이다 — 봉만 따로
 * 쓰는 경로가 생기면 그 원자성이 깨진다.
 */
export class KrxDailyCandleRepository implements CandleRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * `krx_daily_bars` 는 국내 종목만 담는다. `Market` 은 세션 축(KR/US)이고 테이블의
   * market 컬럼은 KOSPI/KOSDAQ 이라 값 체계가 달라 직접 비교할 수 없다 — KR 인지만
   * 본다.
   */
  private supports(market: Market, timeframe: Timeframe): boolean {
    return market === 'KR' && timeframe === '1d';
  }

  private rows(symbol: string, fromTsMs?: number, toTsMs?: number) {
    const conditions = [eq(krxDailyBars.shortCode, symbol)];
    if (fromTsMs !== undefined) conditions.push(gte(krxDailyBars.date, ceilToDate(fromTsMs)));
    if (toTsMs !== undefined) conditions.push(lte(krxDailyBars.date, floorToDate(toTsMs)));

    return this.db
      .select()
      .from(krxDailyBars)
      .where(and(...conditions))
      .orderBy(asc(krxDailyBars.date))
      .all();
  }

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    if (!this.supports(query.market, query.timeframe)) return;

    for (const symbol of query.symbols) {
      for (const row of this.rows(symbol, query.fromTsMs, query.toTsMs)) {
        yield {
          symbol,
          market: query.market,
          timeframe: query.timeframe,
          tsMs: dateToTsMs(row.date),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        };
      }
    }
  }

  async getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]> {
    if (!this.supports(market, timeframe)) return [];
    return this.rows(symbol).map((row) => dateToTsMs(row.date));
  }
}
