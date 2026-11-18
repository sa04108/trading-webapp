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
