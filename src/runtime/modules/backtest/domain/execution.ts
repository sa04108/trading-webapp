import type { ExecutionProfile, Fill, OrderIntent } from "./types.js";
import { sellTaxAmount, tickSizeAt } from "./cost-profiles.js";

/**
 * 다음 봉 시가 체결 (스펙 §9.1):
 * BUY: 시가 × (1+슬리피지) 를 호가 단위로 올림, SELL: 시가 × (1-슬리피지) 를 내림.
 * 수수료·세금은 체결 금액 기준.
 */
export function simulateFill(
  intent: OrderIntent,
  nextBarOpen: number,
  tsMs: number,
  profile: ExecutionProfile,
  venue?: "KOSPI" | "KOSDAQ",
): Fill {
  const { cost, slippage, rules } = profile;
  const slip = nextBarOpen * (slippage.bps / 10_000) + slippage.fixed;
  const slippedPrice =
    intent.side === "BUY" ? nextBarOpen + slip : nextBarOpen - slip;
  const tickSize = tickSizeAt(rules, slippedPrice, tsMs, venue);

  let price: number;
  if (intent.side === "BUY") {
    price = roundToTick(slippedPrice, tickSize, "up");
  } else {
    price = roundToTick(
      Math.max(slippedPrice, tickSize || 0.0001),
      tickSize,
      "down",
    );
  }

  const grossAmount = price * intent.quantity;
  const commission =
    grossAmount *
    (intent.side === "BUY" ? cost.buyCommissionRate : cost.sellCommissionRate);
  const tax =
    intent.side === "SELL"
      ? sellTaxAmount(
          cost,
          grossAmount,
          tsMs,
          venue ?? rules.tickSizeProfile?.market,
        )
      : 0;
  const slippageCost = Math.abs(price - nextBarOpen) * intent.quantity;

  return {
    symbol: intent.symbol,
    side: intent.side,
    quantity: intent.quantity,
    price,
    grossAmount,
    commission,
    tax,
    slippageCost,
    tsMs,
    ...(intent.reason !== undefined ? { reason: intent.reason } : {}),
  };
}

/** BUY 체결에 필요한 현금 (체결 금액 + 수수료) */
export function requiredCashForBuy(fill: Fill): number {
  return fill.grossAmount + fill.commission;
}

/** SELL 체결로 유입되는 현금 (체결 금액 - 수수료 - 세금) */
export function proceedsFromSell(fill: Fill): number {
  return fill.grossAmount - fill.commission - fill.tax;
}

export function roundToTick(
  price: number,
  tickSize: number,
  direction: "up" | "down",
): number {
  if (tickSize <= 0) return price;
  const ticks = price / tickSize;
  const rounded =
    direction === "up" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return rounded * tickSize;
}

/** 수수료와 호가 반올림으로 감소할 평가액까지 반영해 종목당 상한 안에서 살 수 있는 수량을 구한다. */
export function weightLimitedBuyQuantity(equity: number, heldValue: number, basePrice: number,
  fillPrice: number, buyCostFactor: number, weight: number): number {
  const targetValue = equity * weight;
  const valuePerShare = basePrice + weight * (fillPrice * buyCostFactor - basePrice);
  const rawQuantity = (targetValue - heldValue) / valuePerShare;
  // 정확히 한도인 한 주가 부동소수점 상쇄 오차로 탈락하지 않게 한다.
  const tolerance = 4 * Number.EPSILON * (
    (Math.abs(targetValue) + Math.abs(heldValue)) / valuePerShare + Math.abs(rawQuantity)
  );
  return Math.max(0, Math.floor(rawQuantity + tolerance));
}

/** 체결 원장과 같은 순서로 총 매수 금액에 수수료를 더한다. */
export function buyCashWithCommission(gross: number, commissionRate: number): number {
  return gross + gross * commissionRate;
}

/** 동일 시가·가용 현금·평가액에서 두 실행기가 주문할 수 있는 수량을 계산한다. */
export function sizeDailyBuyAtOpen(input: {
  quantity: number; cash: number; equity: number; heldValue: number; basePrice: number;
  fillPrice: number; commissionRate: number; weight?: number;
}): { quantity: number; cashQuantity: number } {
  const factor = 1 + input.commissionRate;
  const outlay = (quantity: number) => buyCashWithCommission(quantity * input.fillPrice, input.commissionRate);
  let cashQuantity = input.quantity;
  if (outlay(cashQuantity) > input.cash) {
    cashQuantity = Math.min(cashQuantity, Math.max(0, Math.floor(input.cash / outlay(1))));
    // 나눗셈이 정수 경계에서 한 주를 벗어나면 실제 원장 차감액으로 확인한다.
    if (cashQuantity < input.quantity && outlay(cashQuantity + 1) <= input.cash) cashQuantity++;
    if (cashQuantity > 0 && outlay(cashQuantity) > input.cash) cashQuantity--;
  }
  const quantity = input.weight === undefined ? cashQuantity : Math.min(cashQuantity, weightLimitedBuyQuantity(
    input.equity, input.heldValue, input.basePrice, input.fillPrice, factor, input.weight,
  ));
  return { quantity, cashQuantity };
}
