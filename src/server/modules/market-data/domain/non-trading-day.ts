import type { KrxDailyTradeRow } from './krx-universe-types.js';

/**
 * KRX 일별매매정보 행이 "그날 거래할 수 없었던" 행인지 본다.
 *
 * 2026-08-08 KRX 실응답에서 확인한 모양이다 —
 * 시·고·저가 "0", 종가는 직전 종가 유지, 거래량 0. `null` 로 오지 않는다.
 *
 * 거래정지와 무거래를 나누지 않는다. KRX 응답이 둘을 구분해 주지 않고,
 * 체결 관점에서 둘은 같은 사건이다 — 어느 쪽이든 그날 살 수도 팔 수도 없다.
 * 사유를 알려면 KIND 매매거래정지 공시가 따로 필요하다.
 *
 * 종가가 0 이하이거나 `null` 이 섞인 행은 여기서 걸러지지 않는다.
 * 그런 행은 원인이 다르므로 `invalidCount` 로 남아 파싱 버그를 드러내야 한다.
 */
export function isNonTradingRow(row: KrxDailyTradeRow): boolean {
  return (
    row.open === 0
    && row.high === 0
    && row.low === 0
    && row.volume === 0
    && row.close !== null
    && row.close > 0
  );
}
