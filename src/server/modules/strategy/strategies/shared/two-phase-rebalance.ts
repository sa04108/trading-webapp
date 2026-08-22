import type { OrderIntent, Position } from '../../../backtest/domain/types.js';
import type { Candle } from '../../../market-data/domain/candle.js';

export interface SellPhaseInput {
  /** 이번 리밸런스의 목표 보유 종목 */
  readonly targets: readonly string[];
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
  readonly bars: ReadonlyMap<string, Candle>;
  readonly equity: number;
  readonly topN: number;
}

export interface BuyPhaseInput {
  readonly positions: ReadonlyMap<string, Readonly<Position>>;
  readonly bars: ReadonlyMap<string, Candle>;
  readonly equity: number;
  readonly topN: number;
  /**
   * 멤버십 일정(스펙 2026-08-05, §9.5)의 활성 유니버스. 지정하지 않거나 null 이면
   * 제한 없이 모든 후보를 매수한다 — 전략이 일정을 전달하지 않으면 엔진의 리스크
   * 검증 안전망만 적용된다.
   */
  readonly tradableSymbols?: ReadonlySet<string> | null;
}

/**
 * 2단계 리밸런스 1단계 — 탈락 종목을 전량 매도하고 목표보다 큰 보유분을 줄인다.
 *
 * 같은 봉에서 매수까지 내지 않는 이유: 엔진의 동시 포지션 상한 검증은 청산 주문을
 * 낸 포지션도 체결 전까지 슬롯을 쓰는 것으로 센다 (engine.ts validateOrder).
 * topN 과 maxPositions 가 같으면 전량 회전이 통째로 거부된다. 매도와 매수를 두 봉으로
 * 나누면 엔진을 고치지 않고도 회전이 되고, 실제 대금 결제와도 부합한다.
 */
export function planSellPhase(input: SellPhaseInput): readonly OrderIntent[] {
  const targetSet = new Set(input.targets);
  const budgetPerSymbol = input.topN > 0 ? input.equity / input.topN : null;
  const orders: OrderIntent[] = [];

  for (const position of [...input.positions.values()].sort((a, b) =>
    a.symbol < b.symbol ? -1 : 1,
  )) {
    if (position.quantity <= 0) continue;
    if (!targetSet.has(position.symbol)) {
      orders.push({
        symbol: position.symbol,
        side: 'SELL',
        quantity: position.quantity,
        reason: 'REBALANCE_EXIT',
      });
      continue;
    }

    if (budgetPerSymbol === null) continue;
    const bar = input.bars.get(position.symbol);
    if (!bar || bar.close <= 0) continue;
    const targetQuantity = Math.floor(budgetPerSymbol / bar.close);
    const excessQuantity = Math.floor(position.quantity - targetQuantity);
    if (excessQuantity < 1) continue;
    orders.push({
      symbol: position.symbol,
      side: 'SELL',
      quantity: excessQuantity,
      reason: 'REBALANCE_TRIM',
    });
  }

  return orders;
}

/**
 * 2단계 — 이전 봉에서 넘어온 목표 종목의 부족 수량을 동일가중까지 매수한다.
 * 비중은 목표 종목 수가 아니라 `topN` 으로 나눈다 — 후보가 부족하면 그만큼 현금이 남는
 * 것이 의도된 동작이다 (절대 모멘텀 필터가 후보를 걸러낸 경우 등).
 */
export function planBuyPhase(
  targets: readonly string[],
  input: BuyPhaseInput,
): readonly OrderIntent[] {
  if (input.topN <= 0) return [];
  const budgetPerSymbol = input.equity / input.topN;
  const orders: OrderIntent[] = [];

  for (const symbol of [...new Set(targets)].sort()) {
    // 유니버스에서 빠진 종목은 여기서 걸러낸다 — 청산은 이 함수가 아니라
    // planSellPhase 의 몫이라 그대로 둔다(타깃 미포함 자동 청산, 이 함수 주석 상단 참고)
    if (input.tradableSymbols && !input.tradableSymbols.has(symbol)) continue;
    const bar = input.bars.get(symbol);
    if (!bar || bar.close <= 0) continue; // 이번 봉에 거래가 없으면 다음 리밸런스로 넘긴다
    const targetQuantity = Math.floor(budgetPerSymbol / bar.close);
    const heldQuantity = input.positions.get(symbol)?.quantity ?? 0;
    const quantity = Math.floor(targetQuantity - heldQuantity);
    if (quantity < 1) continue;
    orders.push({ symbol, side: 'BUY', quantity, reason: 'REBALANCE_ENTRY' });
  }
  return orders;
}
