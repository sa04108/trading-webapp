import { isValidCandle, type Candle } from "../../../../../runtime/modules/market-data/domain/candle.js";
import type { Logger } from "../../../../shared/logger.js";
import { BrokerRequestError, type BrokerOrder, type TradingBroker } from "../../../trading/application/broker-port.js";
import { createTossClient, type TossClient, type TossClientOptions } from "./toss-client.js";
import type { TossConfig } from "./toss-stock-info-source.js";

/** 토스 OpenAPI 1.2.28 기준. https://openapi.tossinvest.com/openapi-docs/latest/openapi.json */
const MAX_PAGES = 100;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("토스 응답 객체가 올바르지 않습니다");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("토스 응답 문자열이 올바르지 않습니다");
  return value;
}
function decimal(value: unknown, negative = false): number {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) throw new Error("토스 숫자 응답이 올바르지 않습니다");
  const n = Number(value);
  if (!Number.isFinite(n) || (!negative && n < 0) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw new Error("토스 숫자 응답 범위가 올바르지 않습니다");
  return n;
}
function quantity(value: unknown): number {
  const n = decimal(value);
  if (!Number.isSafeInteger(n)) throw new Error("국내 주식 수량이 정수가 아닙니다");
  return n;
}
function krSymbol(value: unknown): string {
  const s = string(value);
  if (!/^[A-Za-z0-9]{6}$/.test(s)) throw new Error("국내 주식이 아닌 종목은 지원하지 않습니다");
  return s;
}
function accountHeaders(id: string): Record<string, string> {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("계좌 식별자가 올바르지 않습니다");
  return { "X-Tossinvest-Account": id };
}
function result(value: unknown): unknown { return object(value).result; }
function parseOrder(value: unknown, group?: "OPEN" | "CLOSED"): BrokerOrder {
  const row = object(value); const execution = object(row.execution);
  if (row.currency !== "KRW") throw new Error("해외 주문은 지원하지 않습니다");
  const qty = quantity(row.quantity), filled = quantity(execution.filledQuantity);
  if (qty <= 0 || filled > qty) throw new Error("토스 주문 수량이 올바르지 않습니다");
  let status: BrokerOrder["status"];
  switch (row.status) {
    case "PENDING": case "PENDING_CANCEL": case "PENDING_REPLACE": status = filled ? "PARTIAL" : "OPEN"; break;
    case "PARTIAL_FILLED":
      if (filled <= 0 || filled >= qty || !group) throw new Error("부분 체결 주문의 종료 여부를 확인할 수 없습니다");
      // 종료 목록의 부분 체결은 잔량이 종료된 상태이며, 취소 사유를 추정하지 않는다.
      status = group === "CLOSED" ? "CANCELLED" : "PARTIAL"; break;
    case "CANCEL_REJECTED": case "REPLACE_REJECTED":
      // 거부 레코드와 원주문은 별개다. 원주문 상태가 불명확하면 종료 처리하지 않는다.
      if (group !== "OPEN") throw new Error("취소·정정 거부 후 원주문을 대조해야 합니다");
      status = filled ? "PARTIAL" : "OPEN"; break;
    case "REPLACED": throw new Error("외부 정정으로 대체된 주문을 대조해야 합니다");
    case "FILLED": if (filled !== qty) throw new Error("체결 수량이 올바르지 않습니다"); status = "FILLED"; break;
    case "CANCELED": status = "CANCELLED"; break;
    case "REJECTED": status = "REJECTED"; break;
    default: throw new Error("지원하지 않는 토스 주문 상태입니다");
  }
  if (row.side !== "BUY" && row.side !== "SELL") throw new Error("토스 주문 방향이 올바르지 않습니다");
  const averageFillPrice = execution.averageFilledPrice == null ? null : decimal(execution.averageFilledPrice);
  if (filled > 0 && (averageFillPrice === null || averageFillPrice <= 0)) throw new Error("체결 가격이 올바르지 않습니다");
  if (filled > 0 && (execution.commission == null || execution.tax == null)) throw new Error("체결 수수료·세금이 아직 확인되지 않았습니다");
  const orderedAtMs = typeof row.orderedAt === "string" ? Date.parse(row.orderedAt) : undefined;
  if (orderedAtMs !== undefined && !Number.isFinite(orderedAtMs)) throw new Error("주문 접수 시각이 올바르지 않습니다");
  return { id: string(row.orderId), clientOrderId: row.clientOrderId == null ? null : string(row.clientOrderId), symbol: krSymbol(row.symbol), side: row.side, quantity: qty, ...(row.price == null ? {} : { price: decimal(row.price) }), ...(orderedAtMs === undefined ? {} : { orderedAtMs }), filledQuantity: filled, averageFillPrice, commission: execution.commission == null ? 0 : decimal(execution.commission), tax: execution.tax == null ? 0 : decimal(execution.tax), status };
}

export function createTossTradingBroker(config: TossConfig | null, logger: Logger, options: TossClientOptions & { client?: TossClient } = {}): TradingBroker {
  const client = config ? options.client ?? createTossClient(config, logger, options) : null;
  function requireClient(): TossClient { if (!client) throw new BrokerRequestError("토스 연결이 설정되지 않았습니다", false); return client; }
  async function get(path: string, accountId?: string): Promise<unknown> {
    return result(await requireClient().request(path, { ...(accountId ? { headers: accountHeaders(accountId) } : {}) }));
  }
  return {
    configured: client !== null,
    async accounts() {
      const rows = await get("/api/v1/accounts");
      if (!Array.isArray(rows)) throw new Error("계좌 목록이 올바르지 않습니다");
      return rows.map((value) => { const row = object(value); if (row.accountType !== "BROKERAGE" || typeof row.accountSeq !== "number" || !Number.isSafeInteger(row.accountSeq) || row.accountSeq <= 0) throw new Error("지원하지 않는 토스 계좌입니다"); const no = string(row.accountNo); return { id: String(row.accountSeq), label: `토스증권 ••••${no.slice(-4)}` }; });
    },
    async holdings(accountId) {
      const data = object(await get("/api/v1/holdings", accountId));
      if (!Array.isArray(data.items)) throw new Error("보유 종목 목록이 올바르지 않습니다");
      const holdings = data.items.map((item: unknown) => { const row = object(item); if (row.marketCountry !== "KR" || row.currency !== "KRW") throw new Error("해외 보유 종목은 지원하지 않습니다"); return { symbol: krSymbol(row.symbol), name: string(row.name), quantity: quantity(row.quantity), availableQuantity: null, averagePrice: decimal(row.averagePurchasePrice), price: decimal(row.lastPrice), marketValue: decimal(object(row.marketValue).amount), unrealizedPnl: decimal(object(row.profitLoss).amount, true) }; });
      return holdings;
    },
    async sellableQuantity(accountId, symbol) {
      krSymbol(symbol); accountHeaders(accountId);
      const data = object(await get(`/api/v1/sellable-quantity?${new URLSearchParams({ symbol })}`, accountId));
      return quantity(data.sellableQuantity);
    },
    async buyingPower(accountId) { const data = object(await get("/api/v1/buying-power?currency=KRW", accountId)); if (data.currency !== "KRW") throw new Error("매수 가능 금액 통화가 올바르지 않습니다"); return decimal(data.cashBuyingPower); },
    async orders(accountId, fromDate, toDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) throw new Error("주문 조회 기간이 올바르지 않습니다");
      const orders: BrokerOrder[] = []; const ids = new Set<string>();
      for (const status of ["OPEN", "CLOSED"] as const) {
        let cursor: string | undefined; const cursors = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page++) {
          const query = new URLSearchParams({ status, from: fromDate, to: toDate, limit: "100" }); if (cursor) query.set("cursor", cursor);
          const data = object(await get(`/api/v1/orders?${query}`, accountId));
          if (!Array.isArray(data.orders) || typeof data.hasNext !== "boolean") throw new Error("주문 페이지가 올바르지 않습니다");
          for (const raw of data.orders) { const order = parseOrder(raw, status); if (ids.has(order.id)) throw new Error("중복 주문 응답입니다"); ids.add(order.id); orders.push(order); }
          if (!data.hasNext) { if (data.nextCursor != null) throw new Error("주문 페이지 커서가 올바르지 않습니다"); break; }
          if (status === "OPEN" || typeof data.nextCursor !== "string" || !data.nextCursor || cursors.has(data.nextCursor) || page === MAX_PAGES - 1) throw new Error("주문 페이지를 모두 조회하지 못했습니다");
          cursor = data.nextCursor; cursors.add(cursor);
        }
      }
      return orders;
    },
    async order(accountId, orderId) { return parseOrder(await get(`/api/v1/orders/${encodeURIComponent(string(orderId))}`, accountId)); },
    async place(accountId, request, beforeSend) {
      krSymbol(request.symbol); if (!/^[A-Za-z0-9_-]{1,36}$/.test(request.clientOrderId) || !Number.isSafeInteger(request.quantity) || request.quantity <= 0 || !Number.isSafeInteger(request.price) || request.price <= 0 || !["BUY", "SELL"].includes(request.side)) throw new BrokerRequestError("주문 입력이 올바르지 않습니다", false);
      const raw = await requireClient().request("/api/v1/orders", { method: "POST", headers: accountHeaders(accountId), beforeSend, body: { clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, orderType: "LIMIT", timeInForce: "DAY", quantity: String(request.quantity), price: String(request.price) } });
      let response: Record<string, unknown>;
      try { response = object(result(raw)); } catch { throw new BrokerRequestError("주문 접수 응답을 확인할 수 없습니다", true); }
      if (typeof response.orderId !== "string" || !response.orderId || response.clientOrderId !== request.clientOrderId) throw new BrokerRequestError("주문 접수 응답을 확인할 수 없습니다", true);
      return { orderId: response.orderId };
    },
    async cancel(accountId, orderId) { const raw = await requireClient().request(`/api/v1/orders/${encodeURIComponent(string(orderId))}/cancel`, { method: "POST", headers: accountHeaders(accountId) }); try { string(object(result(raw)).orderId); } catch { throw new BrokerRequestError("주문 취소 응답을 확인할 수 없습니다", true); } },
    async quotes(symbols) {
      if (symbols.length > 200 || new Set(symbols).size !== symbols.length) throw new Error("시세 조회 종목이 올바르지 않습니다"); symbols.forEach(krSymbol); if (!symbols.length) return [];
      const data = await get(`/api/v1/prices?${new URLSearchParams({ symbols: symbols.join(",") })}`); if (!Array.isArray(data)) throw new Error("시세 응답이 올바르지 않습니다");
      const rows = data.map((value) => { const row = object(value); const symbol = krSymbol(row.symbol); const timestampMs = Date.parse(string(row.timestamp)); if (row.currency !== "KRW" || !Number.isFinite(timestampMs) || !symbols.includes(symbol)) throw new Error("시세 정보가 올바르지 않습니다"); const price = decimal(row.lastPrice); if (price <= 0) throw new Error("시세가 올바르지 않습니다"); return { symbol, price, timestampMs }; });
      if (rows.length !== symbols.length || new Set(rows.map((row) => row.symbol)).size !== symbols.length) throw new Error("시세가 누락되었습니다"); return rows;
    },
    async dailyCandles(symbol, fromMs, toMs) {
      krSymbol(symbol); if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) throw new Error("봉 조회 기간이 올바르지 않습니다");
      const rows = new Map<number, Candle>(); let before: string | undefined; const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ symbol, interval: "1d", count: "200", adjusted: "false" }); if (before) query.set("before", before);
        const data = object(await get(`/api/v1/candles?${query}`)); if (!Array.isArray(data.candles) || !(data.nextBefore === null || typeof data.nextBefore === "string")) throw new Error("봉 페이지가 올바르지 않습니다");
        let oldest = Infinity;
        for (const value of data.candles) { const row = object(value); const stamp = string(row.timestamp); if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?\+09:00$/.test(stamp) || row.currency !== "KRW") throw new Error("일봉 시각 또는 통화가 올바르지 않습니다"); const tsMs = Date.parse(stamp) + 9 * 3600_000; const candle: Candle = { symbol, market: "KR", timeframe: "1d", tsMs, open: decimal(row.openPrice), high: decimal(row.highPrice), low: decimal(row.lowPrice), close: decimal(row.closePrice), volume: decimal(row.volume) }; if (!isValidCandle(candle)) throw new Error("일봉 값이 올바르지 않습니다"); oldest = Math.min(oldest, tsMs); if (tsMs >= fromMs && tsMs <= toMs) { const prior = rows.get(tsMs); if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) throw new Error("중복 일봉이 일치하지 않습니다"); rows.set(tsMs, candle); } }
        if (oldest <= fromMs || data.nextBefore === null) return [...rows.values()].sort((a, b) => a.tsMs - b.tsMs);
        if (!data.candles.length || seen.has(data.nextBefore) || page === MAX_PAGES - 1) throw new Error("일봉 페이지를 모두 조회하지 못했습니다"); before = data.nextBefore; seen.add(before);
      }
      throw new Error("일봉 페이지를 모두 조회하지 못했습니다");
    },
  };
}
