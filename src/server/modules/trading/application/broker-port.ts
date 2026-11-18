import type { Candle } from "../../../../runtime/modules/market-data/domain/candle.js";

export interface BrokerAccount {
  id: string;
  label: string;
}

export interface BrokerHolding {
  symbol: string;
  name: string;
  quantity: number;
  availableQuantity: number | null;
  averagePrice: number;
  price: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  orderedAtMs?: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  commission: number;
  tax: number;
  error?: string;
  status: "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED" | "REJECTED";
}

export interface BrokerQuote {
  symbol: string;
  price: number;
  timestampMs: number;
}

/** 증권사 취소 응답은 체결 부재의 증거가 아니다. 최종 주문·잔고를 별도로 대조한다. */
export interface TradingBroker {
  readonly mode?: "LIVE" | "PAPER";
  readonly configured: boolean;
  accounts(): Promise<BrokerAccount[]>;
  holdings(accountId: string): Promise<BrokerHolding[]>;
  buyingPower(accountId: string): Promise<number>;
  sellableQuantity?(accountId: string, symbol: string): Promise<number>;
  orders(accountId: string, fromDate: string, toDate: string): Promise<BrokerOrder[]>;
  order(accountId: string, orderId: string): Promise<BrokerOrder>;
  place(accountId: string, request: {
    clientOrderId: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    venue?: "KOSPI" | "KOSDAQ";
  }, beforeSend?: (execution?: { price: number; quotePrice: number }) => void): Promise<{ orderId: string }>;
  cancel(accountId: string, orderId: string): Promise<void>;
  quotes(symbols: string[]): Promise<BrokerQuote[]>;
  dailyCandles(symbol: string, fromMs: number, toMs: number): Promise<Candle[]>;
}

/** 접수 여부가 불명확한 통신 실패는 거절과 구분하고 재주문하지 않는다. */
export class BrokerRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly statusCode?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrokerRequestError";
  }
}

/** 시세 조회 중 새 보유 종목이 생기면 잔고 스냅샷을 다시 읽는다. */
export class BrokerHoldingsChangedError extends BrokerRequestError {
  constructor() { super("시세 조회 중 보유 종목이 변경되었습니다.", false); }
}
