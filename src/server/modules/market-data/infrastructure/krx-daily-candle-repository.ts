import { and, asc, eq, gt, gte, inArray, lte } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';
import {
  isValidCandle,
  SYMBOL_PATTERN,
  type Candle,
  type Market,
  type Timeframe,
} from '../domain/candle.js';
import type { KrxMarket } from '../domain/krx-universe-types.js';
import type {
  CandleQuery,
  CandleRepository,
  ClosePricePoint,
} from '../application/ports.js';

const MS_PER_DAY = 86_400_000;
/**
 * 시총 상위 200 후보는 한 SELECT로 유지하되 장기간 worker가 동시에 잡는 raw row를
 * 제한한다. 날짜 경계 bind 두 개를 더해도 SQLite의 보수적인 999 bind 한도 아래다.
 */
const READ_SYMBOL_BATCH_SIZE = 200;

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

function toCandle(
  row: typeof krxDailyBars.$inferSelect,
  symbol: string,
  market: Market,
  timeframe: Timeframe,
): Candle {
  return {
    symbol,
    market,
    venue: row.market as KrxMarket,
    timeframe,
    tsMs: dateToTsMs(row.date),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
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
   * 본다. `Timeframe` 은 '1d' 하나뿐이라 더 볼 것이 없다.
   */
  private supports(market: Market): boolean {
    return market === 'KR';
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

  /**
   * 다종목 조회를 종목별 SELECT로 풀면 유니버스 미리보기 한 번에
   * `리밸런싱 날짜 수 × 후보 종목 수`만큼 SQLite 왕복이 생긴다. 종목을 bind 한도
   * 안에서 묶어 읽고 입력 종목 순서로 내보낼 수 있게 Map으로 접는다. 호출 전체가
   * 아니라 한 batch만 담아야 장기간 worker 조회도 첫 봉 전에 전부 메모리에 쌓지 않는다.
   */
  private rowsBySymbol(
    symbols: readonly string[],
    fromTsMs?: number,
    toTsMs?: number,
  ): ReadonlyMap<string, typeof krxDailyBars.$inferSelect[]> {
    const uniqueSymbols = [...new Set(symbols)];
    const grouped = new Map<string, typeof krxDailyBars.$inferSelect[]>();
    if (uniqueSymbols.length === 0) return grouped;
    const conditions = [inArray(krxDailyBars.shortCode, uniqueSymbols)];
    if (fromTsMs !== undefined) conditions.push(gte(krxDailyBars.date, ceilToDate(fromTsMs)));
    if (toTsMs !== undefined) conditions.push(lte(krxDailyBars.date, floorToDate(toTsMs)));
    const rows = this.db
      .select()
      .from(krxDailyBars)
      .where(and(...conditions))
      .orderBy(asc(krxDailyBars.shortCode), asc(krxDailyBars.date))
      .all();
    for (const row of rows) {
      const values = grouped.get(row.shortCode) ?? [];
      values.push(row);
      grouped.set(row.shortCode, values);
    }
    return grouped;
  }

  private *candlesForSymbols(query: CandleQuery, symbols: readonly string[]): Iterable<Candle> {
    const rowsBySymbol = this.rowsBySymbol(symbols, query.fromTsMs, query.toTsMs);
    for (const symbol of symbols) {
      for (const row of rowsBySymbol.get(symbol) ?? []) {
        const candle = toCandle(row, symbol, query.market, query.timeframe);
        if (isValidCandle(candle)) yield candle;
      }
    }
  }

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    if (!this.supports(query.market)) return;

    for (let index = 0; index < query.symbols.length; index += READ_SYMBOL_BATCH_SIZE) {
      const symbols = query.symbols.slice(index, index + READ_SYMBOL_BATCH_SIZE);
      yield* this.candlesForSymbols(query, symbols);
    }
  }

  async getCandlesArray(query: CandleQuery): Promise<readonly Candle[]> {
    if (!this.supports(query.market)) return [];
    const candles: Candle[] = [];
    for (let index = 0; index < query.symbols.length; index += READ_SYMBOL_BATCH_SIZE) {
      const batch = query.symbols.slice(index, index + READ_SYMBOL_BATCH_SIZE);
      for (const candle of this.candlesForSymbols(query, batch)) candles.push(candle);
    }
    return candles;
  }

  async getClosePricesBySymbol(
    query: CandleQuery,
  ): Promise<ReadonlyMap<string, readonly ClosePricePoint[]>> {
    const grouped = new Map<string, ClosePricePoint[]>();
    if (!this.supports(query.market)) return grouped;
    const uniqueSymbols = [...new Set(query.symbols)];
    for (let index = 0; index < uniqueSymbols.length; index += READ_SYMBOL_BATCH_SIZE) {
      const symbols = uniqueSymbols.slice(index, index + READ_SYMBOL_BATCH_SIZE);
      if (symbols.length === 0) continue;
      const conditions = [
        inArray(krxDailyBars.shortCode, symbols),
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
      ];
      if (query.fromTsMs !== undefined) {
        conditions.push(gte(krxDailyBars.date, ceilToDate(query.fromTsMs)));
      }
      if (query.toTsMs !== undefined) {
        conditions.push(lte(krxDailyBars.date, floorToDate(query.toTsMs)));
      }
      const rows = this.db
        .select({
          symbol: krxDailyBars.shortCode,
          date: krxDailyBars.date,
          close: krxDailyBars.close,
        })
        .from(krxDailyBars)
        .where(and(...conditions))
        .orderBy(asc(krxDailyBars.shortCode), asc(krxDailyBars.date))
        .all();
      for (const row of rows) {
        const tsMs = dateToTsMs(row.date);
        if (!SYMBOL_PATTERN.test(row.symbol) || !Number.isFinite(tsMs) || tsMs <= 0) continue;
        const values = grouped.get(row.symbol) ?? [];
        values.push({ symbol: row.symbol, tsMs, close: row.close });
        grouped.set(row.symbol, values);
      }
    }
    return grouped;
  }

  async getTimestamps(market: Market, _timeframe: Timeframe, symbol: string): Promise<number[]> {
    if (!this.supports(market)) return [];
    return this.rows(symbol)
      .map((row) => toCandle(row, symbol, market, _timeframe))
      .filter(isValidCandle)
      .map((candle) => candle.tsMs);
  }
}
