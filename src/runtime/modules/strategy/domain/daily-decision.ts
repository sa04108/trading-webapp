import type { OrderIntent, Position } from "../../backtest/domain/types.js";
import { shuffleInPlace, type Rng } from "../../backtest/domain/seeded-rng.js";
import type { AnyTradingStrategy, StrategyBarContext, StrategyDecision } from "./strategy.js";

/** 준비 기간과 종목별 이력 부족은 진입만 제한한다. 보유분과 지표에는 실제 봉을 전달한다. */
export function evaluateDailyBar(strategy: AnyTradingStrategy, state: unknown, parameters: unknown,
  context: StrategyBarContext, minimumBars: number, counts: ReadonlyMap<string, number>, preparing: boolean): StrategyDecision {
  const excluded = new Set<string>();
  for (const symbol of context.bars.keys()) {
    if ((counts.get(symbol) ?? 0) < minimumBars) excluded.add(symbol);
  }
  const tradable = preparing ? new Set<string>() : excluded.size
    ? new Set([...(context.tradableSymbols ?? context.bars.keys())].filter(symbol => !excluded.has(symbol)))
    : context.tradableSymbols;
  const result = strategy.onBars({ ...context, tradableSymbols: tradable }, state, parameters);
  if (preparing) return { orders: [] };
  return excluded.size ? { orders: result.orders.filter(order => order.side !== "BUY" || !excluded.has(order.symbol)) } : result;
}

export function requiredDailyBars(strategy: AnyTradingStrategy, parameters: unknown): number {
  return Math.max(1, strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 1, strategy.historyLookbackBars?.(parameters) ?? 1);
}

export function markedEquity(cash: number, positions: ReadonlyMap<string, Readonly<Position>>, price: (symbol: string) => number | undefined): number {
  let equity = cash;
  for (const [symbol, position] of positions) equity += position.quantity * (price(symbol) ?? 0);
  return equity;
}

export function membershipExits(positions: ReadonlyMap<string, Readonly<Position>>, members: ReadonlySet<string>): OrderIntent[] {
  const exits: OrderIntent[] = [];
  for (const [symbol, position] of positions) {
    if (position.quantity > 0 && !members.has(symbol)) exits.push({ symbol, quantity: position.quantity, side: "SELL", reason: "REBALANCE_EXIT" });
  }
  return exits;
}

/** 전략이 소비하는 난수와 독립된 매수 경쟁 순서를 두 실행기가 공유한다. */
export const BUY_PRIORITY_SEED_SALT = 0x9e3779b9;
export function prioritizeDailyOrders(orders: readonly OrderIntent[], rng: Rng): OrderIntent[] {
  const buys = orders.filter(order => order.side === "BUY");
  if (buys.length < 2) return [...orders];
  shuffleInPlace(buys, rng);
  let index = 0;
  return orders.map(order => order.side === "BUY" ? buys[index++]! : order);
}

export function priorVolumeCapacity(volume: number, rate: number): number {
  return Math.floor(volume * rate);
}
