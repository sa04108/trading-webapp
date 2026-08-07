import type { Candle, Market, Timeframe } from '../domain/candle.js';
import type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../domain/krx-universe-types.js';

export type {
  KrxDailyTradeRow,
  KrxIssueBaseInfoRow,
  KrxMarket,
} from '../domain/krx-universe-types.js';

/** 스펙 §8 시장 데이터 Port */
export interface CandleQuery {
  /**
   * 데이터셋 축이 없다 — 봉은 종목에 종속되고 데이터셋은 참조만 갖는다
   * (설계 2026-07-31-symbol-as-first-class). 같은 종목을 여러 데이터셋이 참조해도
   * 물리 사본은 하나다.
   */
  readonly market: Market;
  readonly timeframe: Timeframe;
  readonly symbols: readonly string[];
  readonly fromTsMs?: number;
  readonly toTsMs?: number;
}

export interface CandleRepository {
  getCandles(query: CandleQuery): AsyncIterable<Candle>;
  /** 저장된 봉의 시작 시각 목록 (coverage 계산용) */
  getTimestamps(market: Market, timeframe: Timeframe, symbol: string): Promise<number[]>;
}

export interface FetchCandleRequest {
  readonly market: Market;
  readonly timeframe: Timeframe;
  readonly symbol: string;
  readonly fromTsMs: number;
  readonly toTsMs: number;
}

export interface FetchCandleResult {
  readonly candles: readonly Candle[];
  /** 이어받기용: 더 과거 데이터가 남아 있는지 */
  readonly hasMore: boolean;
}

export interface MarketDataSource {
  fetchCandles(request: FetchCandleRequest): Promise<FetchCandleResult>;
}

export interface KrxHistoricalUniverseSource {
  fetchIssueBaseInfo(market: KrxMarket, isoDate: string): Promise<readonly KrxIssueBaseInfoRow[]>;
  fetchDailyTrades(market: KrxMarket, isoDate: string): Promise<readonly KrxDailyTradeRow[]>;
  /**
   * 오늘(KST) 가장 많이 부른 엔드포인트의 호출 수. KRX 한도가 엔드포인트마다 따로 걸려 있어
   * 총합으로 재면 남은 여력을 실제보다 적게 본다.
   */
  todayMaxEndpointCallCount(): number;
}

/** 종목 참조 정보 (코드 → 이름). 이름 검색(이름 → 코드)은 소스가 제공하지 않는다. */
export interface StockInfo {
  readonly symbol: string;
  readonly name: string;
  readonly englishName: string | null;
  readonly market: string;
  readonly status: string; // ACTIVE | DELISTED | ...
  /**
   * 발행주식수. 시가총액을 만드는 절반이다 (나머지 절반은 `StockQuote.lastPrice`).
   * 소스가 주지 않으면 null — 0 으로 채우면 시가총액 0원인 종목이 되어 정렬 맨 끝에
   * 조용히 박힌다. "모른다" 와 "작다" 는 구분돼야 한다.
   */
  readonly sharesOutstanding: number | null;
}

/**
 * `getStockInfo` 배치 조회 결과. "모른다"(stocks 에 없음)와 "못 물어봤다"(failedSymbols)
 * 를 구분한다 — 청크 하나가 네트워크·레이트리밋으로 실패한 코드는 소스가 실제로
 * 모르는 게 아니므로, 호출부(SymbolInfoService)가 이 둘을 다르게 다뤄야 한다
 * (전자만 부정 캐시 대상이다).
 */
export interface StockInfoBatchResult {
  readonly stocks: readonly StockInfo[];
  /** 조회 자체가 실패해 결과를 알 수 없게 된 코드 — 다음 조회에서 재시도돼야 한다 */
  readonly failedSymbols: readonly string[];
}

export interface StockInfoSource {
  /** 코드 목록의 기본 정보 조회. 성공한 조회에서 모르는 심볼은 stocks 에서 빠진다. */
  getStockInfo(symbols: readonly string[]): Promise<StockInfoBatchResult>;
}

/** 현재가 스냅샷 — 시가총액 계산의 나머지 절반 */
export interface StockQuote {
  readonly symbol: string;
  readonly lastPrice: number;
}

export interface StockQuoteSource {
  /** 코드 목록의 현재가 조회. 시세를 못 받은 심볼은 결과에서 빠진다. */
  getQuotes(symbols: readonly string[]): Promise<StockQuote[]>;
}

/** 랭킹 기준 — 소스가 제공하는 집계 축이다 */
export type MarketRankingMetric = 'TRADING_VALUE' | 'TRADING_VOLUME';

export interface MarketRankingEntry {
  readonly symbol: string;
  /** 거래대금 (기간 누적) */
  readonly tradingValue: number;
  /** 거래량 (기간 누적) */
  readonly tradingVolume: number;
}

export interface MarketRankingSource {
  /**
   * 시장 상위 랭킹. **시장 전체의 상위 일부만** 답한다 — 등록 종목을 받아 그것만
   * 집계해 주는 API 가 아니다. 랭킹 밖 종목의 거래대금·거래량은 알 수 없고,
   * 호출부는 그 사실을 "모름" 으로 다뤄야 한다.
   */
  getRanking(market: Market, metric: MarketRankingMetric): Promise<MarketRankingEntry[]>;
}

// 아래 에러들은 포트 계약의 일부다 — 어댑터(infrastructure)가 던지고 애플리케이션이
// 잡는다. broker 쪽에 정의하면 애플리케이션이 §7 방향을 어겨야만 잡을 수 있다.

export class MarketDataSourceNotConfiguredError extends Error {
  constructor() {
    super('증권사 API 자격 증명이 설정되지 않았습니다. 자격 증명을 설정하거나 CSV 가져오기로 데이터를 넣으세요.');
    this.name = 'MarketDataSourceNotConfiguredError';
  }
}

export class UnsupportedTimeframeError extends Error {
  constructor(timeframe: Timeframe) {
    super(
      `데이터 소스가 ${timeframe} 봉을 제공하지 않습니다. 시간봉은 1분봉을 모아 만듭니다.`,
    );
    this.name = 'UnsupportedTimeframeError';
  }
}

export class KrxNotConfiguredError extends Error {
  constructor() {
    super('KRX Open API 키와 API별 승인이 필요합니다. 키를 설정하고 필요한 API 사용 승인을 받으세요.');
    this.name = 'KrxNotConfiguredError';
  }
}

export class KrxApprovalExpiredError extends Error {
  constructor(message = 'KRX Open API 사용 승인이 만료되었습니다. API별 승인 상태를 확인하세요.') {
    super(message);
    this.name = 'KrxApprovalExpiredError';
  }
}

export class KrxContractError extends Error {
  constructor(message = 'KRX 응답이 예상한 계약과 다릅니다.') {
    super(message);
    this.name = 'KrxContractError';
  }
}

export class KrxQuotaError extends Error {
  constructor(message = 'KRX Open API 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요.') {
    super(message);
    this.name = 'KrxQuotaError';
  }
}
