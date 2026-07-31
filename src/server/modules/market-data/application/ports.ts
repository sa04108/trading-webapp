import type { Candle, Market, Timeframe } from '../domain/candle.js';

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
  saveCandles(candles: readonly Candle[]): Promise<void>;
  /**
   * 종목의 물리 저장분 전체 삭제. 데이터셋 삭제는 참조만 끊으므로 봉을 지우지 않는다 —
   * 다른 데이터셋이 같은 종목을 참조할 수 있다. 존재하지 않아도 에러가 아니다.
   */
  deleteSymbol(market: Market, symbol: string): Promise<void>;
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

/** 종목 참조 정보 (코드 → 이름). 이름 검색(이름 → 코드)은 소스가 제공하지 않는다. */
export interface StockInfo {
  readonly symbol: string;
  readonly name: string;
  readonly englishName: string | null;
  readonly market: string;
  readonly status: string; // ACTIVE | DELISTED | ...
}

export interface StockInfoSource {
  /** 코드 목록의 기본 정보 조회. 모르는 심볼은 결과에서 빠진다. */
  getStockInfo(symbols: readonly string[]): Promise<StockInfo[]>;
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
