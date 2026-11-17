/** 토스 API 소개의 클라이언트 × 그룹별 TPS. 2026-11-17 공식 표 기준.
 * https://openapi.tossinvest.com/openapi-docs/overview.md
 */
export const TOSS_RATE_LIMITS = {
  AUTH: 5, ACCOUNT: 1, ASSET: 5, TRANSACTION: 5, STOCK: 5, STOCK_ALL: 1,
  STOCK_TRADING_TREND: 10, MARKET_INFO: 3, MARKET_DATA: 15, MARKET_DATA_CHART: 20,
  RANKING: 5, MARKET_INDICATOR_PRICE: 10, MARKET_INDICATOR: 10, MARKET_INDICATOR_CHART: 5,
  SECTOR: 5, SECTOR_RANKING: 5, ORDER: 10, ORDER_HISTORY: 5, ORDER_INFO: 6,
  CONDITIONAL_ORDER: 5, CONDITIONAL_ORDER_HISTORY: 10,
} as const;
export type TossRateLimitGroup = keyof typeof TOSS_RATE_LIMITS;

export function tossRequestInterval(group: TossRateLimitGroup, now: number): number {
  const kstMinutes = new Date(now + 9 * 3_600_000).getUTCHours() * 60
    + new Date(now + 9 * 3_600_000).getUTCMinutes();
  const tps = group === "ORDER_INFO" && kstMinutes >= 540 && kstMinutes < 550 ? 3 : TOSS_RATE_LIMITS[group];
  return Math.ceil(1000 / tps);
}

/** 호출부의 임의 이름·종목·계좌·조회 조건으로 공통 한도가 분리되지 않게 한다. */
export function tossRequestGroup(method: string, path: string): TossRateLimitGroup {
  const pathname = path.split("?")[0];
  if (method === "POST") {
    if (pathname === "/oauth2/token") return "AUTH";
    if (pathname === "/api/v1/orders" || /^\/api\/v1\/orders\/[^/]+\/(cancel|modify)$/.test(pathname!)) return "ORDER";
  }
  if (method === "GET") {
    switch (pathname) {
      case "/api/v1/accounts": return "ACCOUNT";
      case "/api/v1/holdings": return "ASSET";
      case "/api/v1/stocks": return "STOCK";
      case "/api/v1/candles": return "MARKET_DATA_CHART";
      case "/api/v1/prices":
      case "/api/v1/orderbook":
      case "/api/v1/trades":
      case "/api/v1/price-limits": return "MARKET_DATA";
      case "/api/v1/buying-power":
      case "/api/v1/sellable-quantity": return "ORDER_INFO";
      case "/api/v1/orders": return "ORDER_HISTORY";
    }
    if (/^\/api\/v1\/orders\/[^/]+$/.test(pathname!)) return "ORDER_HISTORY";
  }
  throw new Error(`토스 API 호출 한도 그룹이 등록되지 않았습니다: ${method} ${pathname}`);
}
