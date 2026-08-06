import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { krxDailyBars } from '../../../shared/db/schema.js';
import type { Candle, Market, Timeframe } from '../domain/candle.js';
import type { CandleQuery, CandleRepository } from '../application/ports.js';

/**
 * krxDailyBars.date(KST 거래일, 'YYYY-MM-DD')를 tsMs 로 바꾼다.
 *
 * 기존 1일봉과 tsMs 기준을 반드시 맞춰야 한다(설계 2026-08-06-krx-daily-bars Task 3
 * 규약 3). 확인한 근거:
 * - `Candle.tsMs` 주석(domain/candle.ts): "봉 시작 시각의 UTC epoch milliseconds".
 * - `periodToTsRange`(src/shared/schemas/backtest-request.ts)는 요청 기간의 날짜를
 *   그 날짜의 UTC 자정(`T00:00:00Z`) ~ UTC 23:59:59.999 로 바꾼다. 백테스트가 던지는
 *   조회 범위가 이 값을 기준으로 만들어지므로, 그 날짜의 일봉도 같은 UTC 자정이어야
 *   그 날짜의 조회 범위 안에 들어온다.
 * - 기존 1일봉 테스트 고정값도 이 규칙을 그대로 쓴다: broker-sync-service.test.ts 의
 *   `dailyCandle` 헬퍼가 쓰는 `MON_0900_KST = Date.UTC(2026, 6, 6, 0, 0)`은 UTC 자정이고,
 *   토스가 실제로 주는 1일봉 tsMs 를 흉내낸 값이다(그 파일의 이름은 09:00 KST 이지만
 *   값 자체는 자정 기준 계산이다 — 09:00 KST 는 UTC 로 그 날 00:00 이기 때문이다).
 * - toss-market-data-source.ts 의 `parseTimestamp`는 인터벌(1m/1d)에 관계없이 API가
 *   준 ISO 타임스탬프를 그대로 `Date.parse`한다 — 1일봉만 따로 KST 자정으로 접거나
 *   보정하는 코드가 없다.
 *
 * KST 자정(UTC-9h)으로 변환했다면 하루 앞선 tsMs 가 되어 periodToTsRange 의 범위를
 * 벗어난다 — 엔진이 그 날의 봉을 못 보거나 다른 날의 봉으로 착각한다.
 */
function dateToTsMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

interface KrxBarRow {
  readonly tsMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * 1일봉은 KRX 테이블을, 그 밖의 슬라이스는 기존 저장소(delegate, 실제로는 parquet)를
 * 읽는다(설계 2026-08-06-krx-daily-bars Task 3). 쓰기(saveCandles)·삭제(deleteSymbol)는
 * 항상 delegate 로 간다 — KRX 테이블은 SymbolMasterService.ingestDate 가 직접 채우고,
 * 봉 수집(BrokerSyncService)은 이 감싼 인스턴스를 받아도 여전히 parquet 에 쓴다.
 */
export class CompositeCandleRepository implements CandleRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly delegate: CandleRepository,
  ) {}

  /**
   * 종목 하나의 KRX 일봉을 읽어 [fromTsMs, toTsMs] 로 거른다. 경계를 SQL 로 내리지 않고
   * 여기서 tsMs 로 변환한 뒤 비교하는 이유: krxDailyBars.date 는 텍스트라서, 경계값이
   * 자정이 아닌 값(CandleQuery 계약상 가능하다)으로 와도 정확히 맞추려면 결국 tsMs 로
   * 바꿔 비교해야 한다. 종목 하나의 일봉 행 수는 상장 기간 전체라도 많아야 수천 건이라
   * SQL 조건 없이 걸러도 가볍다.
   */
  private krxRows(symbol: string, fromTsMs?: number, toTsMs?: number): KrxBarRow[] {
    return this.db
      .select()
      .from(krxDailyBars)
      .where(eq(krxDailyBars.shortCode, symbol))
      .all()
      .map((row) => ({
        tsMs: dateToTsMs(row.date),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }))
      .filter(
        (row) =>
          (fromTsMs === undefined || row.tsMs >= fromTsMs) &&
          (toTsMs === undefined || row.tsMs <= toTsMs),
      )
      .sort((a, b) => a.tsMs - b.tsMs);
  }

  /**
   * KRX 테이블을 쓸지 판단한다. market 은 컬럼 비교에 넣지 않는다 — CandleQuery.market
   * ('KR'/'US')과 krxDailyBars.market('KOSPI'/'KOSDAQ')은 서로 다른 값 체계라 직접
   * 비교할 수 없다. 대신 krxDailyBars 자체가 국내(KR) 종목만 갖고 있으므로, market 이
   * 'KR' 이 아니면 애초에 KRX 를 볼 이유가 없다 — 이 한 번의 분기로 충분하다.
   */
  private usesKrx(market: Market, timeframe: Timeframe): boolean {
    return timeframe === '1d' && market === 'KR';
  }

  async *getCandles(query: CandleQuery): AsyncIterable<Candle> {
    if (!this.usesKrx(query.market, query.timeframe)) {
      yield* this.delegate.getCandles(query);
      return;
    }

    // 종목별로 KRX 행 유무를 먼저 가른다 — 있으면 KRX 만, 없으면 위임만. 섞지 않는다.
    const krxSymbols: string[] = [];
    const delegateSymbols: string[] = [];
    const rowsBySymbol = new Map<string, KrxBarRow[]>();
    for (const symbol of query.symbols) {
      const rows = this.krxRows(symbol, query.fromTsMs, query.toTsMs);
      if (rows.length > 0) {
        krxSymbols.push(symbol);
        rowsBySymbol.set(symbol, rows);
      } else {
        delegateSymbols.push(symbol);
      }
    }

    for (const symbol of krxSymbols) {
      for (const row of rowsBySymbol.get(symbol) ?? []) {
        yield {
          symbol,
          market: query.market,
          timeframe: query.timeframe,
          tsMs: row.tsMs,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        };
      }
    }

    if (delegateSymbols.length > 0) {
      yield* this.delegate.getCandles({ ...query, symbols: delegateSymbols });
    }
  }

  async getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]> {
    if (this.usesKrx(market, timeframe)) {
      const rows = this.krxRows(symbol);
      if (rows.length > 0) return rows.map((row) => row.tsMs);
    }
    return this.delegate.getTimestamps(market, timeframe, symbol);
  }

  /** 쓰기는 항상 delegate(parquet)로 간다 — KRX 테이블은 수집기(ingestDate)가 직접 채운다 */
  async saveCandles(candles: readonly Candle[]): Promise<void> {
    await this.delegate.saveCandles(candles);
  }

  /**
   * 물리 삭제는 항상 delegate(parquet)로 가고, KRX 일봉 행은 지우지 않는다. KRX 일봉은
   * 시장 전체가 공유하는 자산이다 — 사용자가 종목을 목록에서 빼는 일(deleteSymbol)과
   * "그 날짜의 시장 전체 일봉이 잘못됐다"는 서로 다른 사건이다. 종목 삭제로 다른 화면·
   * 다른 백테스트가 참조할 수 있는 KRX 데이터까지 지우면 그 참조가 조용히 깨진다.
   */
  async deleteSymbol(market: Market, symbol: string): Promise<void> {
    await this.delegate.deleteSymbol(market, symbol);
  }
}
