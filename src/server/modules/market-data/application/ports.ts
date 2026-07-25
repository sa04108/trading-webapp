import type { Candle, Market, Timeframe } from '../domain/candle.js';

/** 스펙 §8 시장 데이터 Port */
export interface CandleQuery {
  /** 데이터셋 단위로 물리 격리 — 다른 데이터셋의 같은 심볼과 섞이지 않는다 (§11) */
  readonly datasetId: string;
  readonly market: Market;
  readonly timeframe: Timeframe;
  readonly symbols: readonly string[];
  readonly fromTsMs?: number;
  readonly toTsMs?: number;
}

export interface CandleRepository {
  getCandles(query: CandleQuery): AsyncIterable<Candle>;
  /** 저장된 봉의 시작 시각 목록 (coverage 계산용) */
  getTimestamps(
    datasetId: string,
    market: Market,
    timeframe: Timeframe,
    symbol: string,
  ): Promise<number[]>;
  saveCandles(datasetId: string, candles: readonly Candle[]): Promise<void>;
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
