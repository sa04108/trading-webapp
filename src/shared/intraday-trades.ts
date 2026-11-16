import type { IntradayResult, IntradaySignal } from "./schemas/intraday.js";

export interface IntradayTrade {
  id: string;
  symbol: string;
  quantity: number;
  entryTsMs: number;
  exitTsMs: number;
  entryPrice: number;
  exitPrice: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  holdingTimeMs: number;
  exitReason: IntradaySignal["reason"];
}

export interface IntradayOpenPosition {
  symbol: string;
  quantity: number;
  entryTsMs: number;
  entryPrice: number;
  lastPrice: number;
  lastPriceTsMs: number;
  unrealizedPnl: number;
  returnPct: number;
  holdingTimeMs: number;
  entryCosts: number;
}

export function summarizeIntradayTrades(
  result: Pick<IntradayResult, "request" | "fills" | "position" | "equity">,
): {
  trades: IntradayTrade[];
  openPosition: IntradayOpenPosition | null;
  tradeCount: number;
  winRate: number | null;
  averageHoldingMinutes: number | null;
} {
  const trades: IntradayTrade[] = [];
  let quantity = 0;
  let entryPrice = 0;
  let entryTsMs = 0;
  let entryCosts = 0;

  result.fills.forEach((fill, index) => {
    if (fill.side === "BUY") {
      if (quantity === 0) entryTsMs = fill.atMs;
      entryPrice = (entryPrice * quantity + fill.price * fill.qty) / (quantity + fill.qty);
      quantity += fill.qty;
      entryCosts += fill.commission;
      return;
    }

    const entryCostsShare = entryCosts * (fill.qty / quantity);
    const costs = entryCostsShare + fill.commission + fill.tax;
    const netPnl = (fill.price - entryPrice) * fill.qty - costs;
    const costBasis = entryPrice * fill.qty;
    trades.push({
      id: String(index), symbol: result.request.symbol, quantity: fill.qty,
      entryTsMs, exitTsMs: fill.atMs, entryPrice, exitPrice: fill.price,
      costs, netPnl, returnPct: costBasis > 0 ? netPnl / costBasis * 100 : 0,
      holdingTimeMs: fill.atMs - entryTsMs, exitReason: fill.reason,
    });
    quantity -= fill.qty;
    entryCosts -= entryCostsShare;
    if (quantity === 0) {
      entryPrice = 0;
      entryCosts = 0;
    }
  });

  let openPosition: IntradayOpenPosition | null = null;
  if (quantity > 0) {
    const lastPrice = result.position.lastPrice;
    const lastPriceTsMs = result.equity.at(-1)?.endMs ?? entryTsMs;
    const unrealizedPnl = quantity * (lastPrice - entryPrice) - entryCosts;
    const costBasis = quantity * entryPrice;
    openPosition = {
      symbol: result.request.symbol, quantity, entryTsMs, entryPrice, lastPrice,
      lastPriceTsMs, unrealizedPnl,
      returnPct: costBasis > 0 ? unrealizedPnl / costBasis * 100 : 0,
      holdingTimeMs: lastPriceTsMs - entryTsMs, entryCosts,
    };
  }
  const tradeCount = trades.length;
  return {
    trades, openPosition, tradeCount,
    winRate: tradeCount ? trades.filter((trade) => trade.netPnl > 0).length / tradeCount * 100 : null,
    averageHoldingMinutes: tradeCount ? trades.reduce((sum, trade) => sum + trade.holdingTimeMs, 0) / tradeCount / 60_000 : null,
  };
}
