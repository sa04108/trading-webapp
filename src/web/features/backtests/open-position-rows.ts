import type { OpenPositionSnapshot } from './types.js';

/** 거래 내역 테이블 상단에 고정 표시할 미청산 행 모델 */
export interface OpenPositionRow {
  symbol: string;
  quantity: number;
  entryTsMs: number;
  entryPrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  returnPct: number;
  holdingTimeMs: number;
}

/**
 * 미청산 스냅샷 JSON → 테이블 행. 보유 시간은 기간 종료일의 장 마감 이후
 * 시각(당일 23:59:59 KST)을 기준으로 계산한다 — 스냅샷에는 기말 타임스탬프가 없다.
 */
export function openPositionRows(
  openPositionsJson: string | null,
  symbolFilter: string,
  periodTo: string,
): OpenPositionRow[] {
  if (!openPositionsJson) return [];
  let positions: OpenPositionSnapshot[];
  try {
    positions = JSON.parse(openPositionsJson) as OpenPositionSnapshot[];
  } catch {
    return [];
  }
  const periodEndMs = Date.parse(`${periodTo}T23:59:59+09:00`);
  return positions
    .filter((p) => symbolFilter === 'ALL' || p.symbol === symbolFilter)
    .map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      entryTsMs: p.entryTsMs,
      entryPrice: p.avgEntryPrice,
      lastPrice: p.lastPrice,
      unrealizedPnl: p.unrealizedPnl,
      returnPct: p.returnPct,
      holdingTimeMs: Math.max(0, periodEndMs - p.entryTsMs),
    }));
}
