import { adjustForRatio } from "../../backtest/domain/corporate-action-adjust.js";
import type { ActionGapEntryGate } from "../../backtest/domain/action-gap.js";
import type { OrderIntent, Position } from "../../backtest/domain/types.js";
import { shuffleInPlace, type Rng } from "../../backtest/domain/seeded-rng.js";
import type { AnyTradingStrategy, StrategyBarContext, StrategyDecision } from "./strategy.js";

/** 주문 후보의 우선순위와 매도 수량을 유지한 채 그 시점에 불가능한 매수만 제거한다. */
export function eligibleDailyOrders<T extends OrderIntent>(orders: readonly T[], blocked: ReadonlySet<string>): T[] {
  return orders.filter(order => order.side !== "BUY" || !blocked.has(order.symbol));
}

/** 시가 직전에 확인된 분할·병합은 대기 주문의 투자 금액을 보존하도록 수량에 반영한다. */
export function adjustDailyOrderUnits(orders: readonly OrderIntent[], symbol: string, ratio: number): OrderIntent[] {
  return orders.map(order => order.symbol === symbol
    ? { ...order, quantity: adjustForRatio(order.quantity, 0, ratio, 0).quantity } : order).filter(order => order.quantity > 0);
}

/** 같은 주문 묶음에서 기존 보유와 먼저 접수한 매수의 자리를 지킨다. 매도 완료는 다음 판단에 반영한다. */
export class DailyPositionSlots {
  private readonly occupied: Set<string>;
  constructor(held: Iterable<string>, private readonly limit: number) {
    this.occupied = new Set(held);
  }
  allows(symbol: string): boolean {
    return this.occupied.has(symbol) || this.occupied.size < this.limit;
  }
  reserve(symbol: string): void {
    this.occupied.add(symbol);
  }
}

/** 두 실행기가 동일한 시점의 자료와 포지션으로 일봉 전략의 입력, 매수·매도·보류를 결정한다. */
export function evaluateDailyBar(strategy: AnyTradingStrategy, state: unknown, parameters: unknown,
  context: StrategyBarContext, minimumBars: number, counts: ReadonlyMap<string, number>, preparing: boolean,
  gate?: ActionGapEntryGate): StrategyDecision {
  const gaps = gate?.atClose;
  const blocked = new Set(gaps);
  for (const symbol of context.bars.keys()) {
    if ((counts.get(symbol) ?? 0) < minimumBars) blocked.add(symbol);
  }
  const held = context.portfolio.positions;
  const bars = gaps?.size && gate ? new Map([...context.bars].filter(([symbol]) => context.tsMs > gate.priceCutoff(symbol))) : context.bars;
  const tradable = preparing ? new Set<string>() : blocked.size
    ? new Set([...(context.tradableSymbols ?? context.bars.keys())].filter(symbol => !blocked.has(symbol) || (gaps?.has(symbol) && held.has(symbol))))
    : context.tradableSymbols;
  const active = gaps?.size ? new Set([...(context.activeUniverseSymbols ?? counts.keys())].filter(symbol => !gaps.has(symbol) || held.has(symbol))) : context.activeUniverseSymbols;
  const result = strategy.onBars({ ...context, bars, tradableSymbols: tradable, activeUniverseSymbols: active,
    getHistory: symbol => {
      const history = context.getHistory(symbol);
      const cutoff = gate?.priceCutoff(symbol) ?? -Infinity;
      return !history.length || history[0]!.tsMs > cutoff ? history : history.filter(bar => bar.tsMs > cutoff);
    },
  }, state, parameters);
  if (preparing) return { orders: [] };
  const orders = eligibleDailyOrders(result.orders, blocked);
  // 보유 이후에 과거 가격 결손이 발견되어 순위를 계산할 수 없으면 그 사유만으로 전량 청산하지 않는다.
  // 실제 멤버십 이탈은 양쪽 실행기의 membershipExits에서 별도로 처리한다.
  return { orders: gaps?.size ? orders.filter(order => !(order.reason === "REBALANCE_EXIT" && gaps.has(order.symbol) &&
    held.has(order.symbol) && (context.activeUniverseSymbols === null || context.activeUniverseSymbols.has(order.symbol)))) : orders };
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
