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
  /** 데이터셋의 물리 저장분 전체 삭제 (D 경로). 존재하지 않아도 에러가 아니다. */
  deleteDataset(datasetId: string): Promise<void>;
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

// 아래 에러들은 포트 계약의 일부다 — 어댑터(infrastructure)가 던지고 애플리케이션이
// 잡는다. broker 쪽에 정의하면 애플리케이션이 §7 방향을 어겨야만 잡을 수 있다.

export class MarketDataSourceNotConfiguredError extends Error {
  constructor() {
    super('증권사 API 자격 증명이 설정되지 않았습니다. CSV/Parquet import 를 사용하세요.');
    this.name = 'MarketDataSourceNotConfiguredError';
  }
}

export class UnsupportedTimeframeError extends Error {
  constructor(timeframe: Timeframe) {
    super(
      `데이터 소스가 ${timeframe} 봉을 제공하지 않습니다. 시간봉은 1분봉 집계로 생성하세요 (스펙 §13).`,
    );
    this.name = 'UnsupportedTimeframeError';
  }
}
