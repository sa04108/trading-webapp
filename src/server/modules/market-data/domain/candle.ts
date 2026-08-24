import type { KrxMarket } from './krx-universe-types.js';

export type Market = 'KR' | 'US';
/** 선언된 시장 전체. 타입과 값 목록이 떨어져 있으면 시장을 추가할 때 한쪽만 고쳐진다. */
export const ALL_MARKETS: readonly Market[] = ['KR', 'US'];
/** 봉 주기. KRX 일별매매가 유일한 봉 출처라 일봉뿐이다. */
export type Timeframe = '1d';

/** tsMs 는 봉 시작 시각의 UTC epoch milliseconds (스펙 §11: UTC 저장) */
export interface Candle {
  readonly symbol: string;
  readonly market: Market;
  /** 국내 일봉의 실제 거래시장. 해외·레거시 봉에는 없을 수 있다. */
  readonly venue?: KrxMarket;
  readonly timeframe: Timeframe;
  readonly tsMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export const SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

export function isValidCandle(candle: Candle): boolean {
  const { open, high, low, close, volume, tsMs, symbol } = candle;
  if (!SYMBOL_PATTERN.test(symbol)) return false;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return false;
  for (const value of [open, high, low, close]) {
    if (!Number.isFinite(value) || value <= 0) return false;
  }
  if (!Number.isFinite(volume) || volume < 0) return false;
  if (candle.venue !== undefined && candle.venue !== 'KOSPI' && candle.venue !== 'KOSDAQ') return false;
  if (high < low) return false;
  if (high < open || high < close) return false;
  if (low > open || low > close) return false;
  return true;
}

/** 시간순 정렬 + 같은 (심볼, ts) 중복 제거(뒤에 온 것이 이긴다 — idempotent 재수집, 스펙 §11) */
export function normalizeCandles(candles: readonly Candle[]): Candle[] {
  const byKey = new Map<string, Candle>();
  for (const candle of candles) {
    byKey.set(`${candle.symbol}:${candle.market}:${candle.timeframe}:${candle.tsMs}`, candle);
  }
  return [...byKey.values()].sort((a, b) =>
    a.symbol === b.symbol ? a.tsMs - b.tsMs : a.symbol < b.symbol ? -1 : 1,
  );
}
