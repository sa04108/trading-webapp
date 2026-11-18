import { paperFillPrice, paperTradingCostProfile } from "../application/paper-trading-cost.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { getCostProfile, sellTaxAmount } from "../../../../runtime/modules/backtest/domain/cost-profiles.js";
import { PAPER_TRADING_ACCOUNT_ID, PAPER_TRADING_INITIAL_CASH_KRW, tradingSetupSchema } from "../../../../shared/schemas/trading.js";
import { BrokerHoldingsChangedError, BrokerRequestError, type BrokerOrder, type TradingBroker } from "../application/broker-port.js";

type Request = Parameters<TradingBroker["place"]>[1];
type Holding = { quantity: number; cost: number };
type StoredOrder = { request: Request; order: BrokerOrder };
type Account = { cash: number; holdings_json: string };

export function createPaperTradingBroker(deps: {
  database: DatabaseHandle;
  marketData: Pick<TradingBroker, "quotes" | "dailyCandles">;
  now?: () => number;
  getName?: (symbol: string) => string | undefined;
}): TradingBroker {
  const { sqlite } = deps.database;
  const now = deps.now ?? Date.now;
  const fail = (message: string): never => { throw new BrokerRequestError(message, false); };
  const account = (id: string) => { if (id !== PAPER_TRADING_ACCOUNT_ID) fail("모의 계좌가 아닙니다"); };
  const readAccount = (): Account => (sqlite.prepare("SELECT cash, holdings_json FROM paper_trading_account WHERE singleton = 1").get() as Account | undefined) ?? { cash: PAPER_TRADING_INITIAL_CASH_KRW, holdings_json: "{}" };
  const readOrder = (id: string): StoredOrder | undefined => {
    const row = sqlite.prepare("SELECT payload_json FROM paper_trading_orders WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as StoredOrder : undefined;
  };
  const same = (a: Request, b: Request) => a.clientOrderId === b.clientOrderId && a.symbol === b.symbol && a.side === b.side && a.quantity === b.quantity && a.price === b.price && a.venue === b.venue;
  const protect = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try { return await fn(); } catch (error) {
      if (error instanceof BrokerRequestError && !error.uncertain) throw error;
      throw new BrokerRequestError(error instanceof Error ? error.message : String(error), false, undefined, { cause: error });
    }
  };
  const quote = async (symbol: string) => {
    const quotes = await deps.marketData.quotes([symbol]);
    const q = quotes.find(item => item.symbol === symbol);
    const time = now();
    if (!q || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.timestampMs) || q.timestampMs < time - 30_000 || q.timestampMs > time + 5_000) fail("유효한 최신 시세가 없습니다");
    return q!;
  };
  return {
    mode: "PAPER", configured: true,
    accounts: () => protect(() => [{ id: PAPER_TRADING_ACCOUNT_ID, label: "모의투자" }]),
    buyingPower: id => protect(() => { account(id); return readAccount().cash; }),
    sellableQuantity: (id, symbol) => protect(() => { account(id); return (JSON.parse(readAccount().holdings_json) as Record<string, Holding>)[symbol]?.quantity ?? 0; }),
    holdings: id => protect(async () => {
      account(id);
      const initial = JSON.parse(readAccount().holdings_json) as Record<string, Holding>;
      const symbols = Object.keys(initial).filter(symbol => initial[symbol]!.quantity > 0);
      const prices = new Map<string, number>();
      for (let i = 0; i < symbols.length; i += 200) {
        for (const item of await deps.marketData.quotes(symbols.slice(i, i + 200))) {
          if (Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.timestampMs)) prices.set(item.symbol, item.price);
        }
      }
      const holdings = JSON.parse(readAccount().holdings_json) as Record<string, Holding>;
      return Object.entries(holdings).filter(([, h]) => h.quantity > 0).map(([symbol, h]) => {
        const price = prices.get(symbol);
        if (price === undefined) {
          if (!symbols.includes(symbol)) throw new BrokerHoldingsChangedError();
          return fail(`보유 종목의 시세가 없습니다: ${symbol}`);
        }
        let name = symbol;
        try { name = deps.getName?.(symbol) || symbol; } catch { /* 종목명은 잔고 계산에 영향을 주지 않는다. */ }
        const marketValue = h.quantity * price;
        return { symbol, name, quantity: h.quantity, availableQuantity: h.quantity, averagePrice: h.cost / h.quantity, price, marketValue, unrealizedPnl: marketValue - h.cost };
      });
    }),
    orders: (id, from, to) => protect(() => {
      account(id);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail("주문 조회 기간이 올바르지 않습니다");
      const start = Date.parse(`${from}T00:00:00+09:00`), end = Date.parse(`${to}T00:00:00+09:00`) + 86_400_000;
      return (sqlite.prepare("SELECT payload_json FROM paper_trading_orders WHERE created_at_ms >= ? AND created_at_ms < ? ORDER BY created_at_ms").all(start, end) as { payload_json: string }[]).map(row => (JSON.parse(row.payload_json) as StoredOrder).order);
    }),
    order: (id, orderId) => protect(() => { account(id); return readOrder(orderId)?.order ?? fail("주문을 찾을 수 없습니다"); }),
    place: (id, request, beforeSend) => protect(async () => {
      account(id);
      if (!request.clientOrderId || !/^[A-Za-z0-9]{6}$/.test(request.symbol) || !["BUY", "SELL"].includes(request.side) || !Number.isSafeInteger(request.quantity) || request.quantity <= 0 || !Number.isSafeInteger(request.price) || request.price <= 0) fail("주문이 올바르지 않습니다");
      const existing = readOrder(request.clientOrderId);
      if (existing) { if (!same(existing.request, request)) fail("중복 주문 ID가 다른 주문에 사용되었습니다"); return { orderId: request.clientOrderId }; }
      const q = await quote(request.symbol);
      return sqlite.transaction(() => {
        const prior = readOrder(request.clientOrderId);
        if (prior) { if (!same(prior.request, request)) fail("중복 주문 ID가 다른 주문에 사용되었습니다"); return { orderId: request.clientOrderId }; }
        const timestamp = now();
        if (q.timestampMs < timestamp - 30_000 || q.timestampMs > timestamp + 5_000) fail("유효한 최신 시세가 없습니다");
        const current = readAccount();
        const row = sqlite.prepare("SELECT setup_json FROM trading_deployments WHERE slot = 1 AND mode = 'PAPER'").get() as { setup_json: string } | undefined;
        const setup = row ? tradingSetupSchema.parse(JSON.parse(row.setup_json)) : null;
        const profile = getCostProfile(setup?.paperCommissionProfileId ?? paperTradingCostProfile.id) ?? paperTradingCostProfile;
        const fillPrice = setup ? paperFillPrice(setup,request.side,request.symbol,q.price,timestamp,request.venue) : q.price;
        const holdings = JSON.parse(current.holdings_json) as Record<string, Holding>;
        const gross = fillPrice * request.quantity;
        const commission = gross * (request.side === "BUY" ? profile.buyCommissionRate : profile.sellCommissionRate);
        const tax = request.side === "SELL" ? sellTaxAmount(profile, gross, timestamp, request.venue) : 0;
        if (!Number.isSafeInteger(gross) || gross + commission + tax > Number.MAX_SAFE_INTEGER) fail("주문 금액이 올바르지 않습니다");
        const within = request.side === "BUY" ? fillPrice <= request.price : fillPrice >= request.price;
        const holding = holdings[request.symbol] ?? { quantity: 0, cost: 0 };
        if (within && request.side === "BUY" && current.cash < gross + commission) fail("모의 잔고가 부족합니다");
        if (within && request.side === "SELL" && holding.quantity < request.quantity) fail("매도 가능 수량이 부족합니다");
        beforeSend?.({price:fillPrice,quotePrice:q.price});
        if (within) {
          if (request.side === "BUY") { current.cash -= gross + commission; holdings[request.symbol] = { quantity: holding.quantity + request.quantity, cost: holding.cost + gross }; }
          else { current.cash += gross - commission - tax; const quantity = holding.quantity - request.quantity; if (quantity === 0) delete holdings[request.symbol]; else holdings[request.symbol] = { quantity, cost: holding.cost * quantity / holding.quantity }; }
          sqlite.prepare("INSERT INTO paper_trading_account (singleton, cash, holdings_json) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET cash = excluded.cash, holdings_json = excluded.holdings_json").run(current.cash, JSON.stringify(holdings));
        }
        const order: BrokerOrder = { id: request.clientOrderId, clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, quantity: request.quantity, price: request.price, orderedAtMs: timestamp, filledQuantity: within ? request.quantity : 0, averageFillPrice: within ? fillPrice : null, commission: within ? commission : 0, tax: within ? tax : 0, ...(!within ? { error: "모의 예상 체결가가 지정가를 벗어났습니다. 호가 단위와 슬리피지 한도를 확인하세요." } : {}), status: within ? "FILLED" : "REJECTED" };
        sqlite.prepare("INSERT INTO paper_trading_orders (id, payload_json, created_at_ms) VALUES (?, ?, ?)").run(order.id, JSON.stringify({ request, order }), timestamp);
        return { orderId: order.id };
      }).immediate();
    }),
    cancel: (id, orderId) => protect(() => { account(id); sqlite.transaction(() => { const stored = readOrder(orderId); if (!stored) fail("주문을 찾을 수 없습니다"); if (stored!.order.status === "OPEN" || stored!.order.status === "PARTIAL") { stored!.order.status = "CANCELLED"; sqlite.prepare("UPDATE paper_trading_orders SET payload_json = ? WHERE id = ?").run(JSON.stringify(stored), orderId); } }).immediate(); }),
    quotes: symbols => protect(() => deps.marketData.quotes(symbols)),
    dailyCandles: (symbol, from, to) => protect(() => deps.marketData.dailyCandles(symbol, from, to)),
  };
}
