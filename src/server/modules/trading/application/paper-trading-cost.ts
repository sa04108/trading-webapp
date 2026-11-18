import { getCostProfile, getKrxExecutionRules, getSlippageProfile } from "../../../../runtime/modules/backtest/domain/cost-profiles.js";
import { simulateFill } from "../../../../runtime/modules/backtest/domain/execution.js";
import type { TradingSetup } from "../../../../shared/schemas/trading.js";

export const paperTradingCostProfile = getCostProfile("kr-equity-default")!;

export function paperFillPrice(setup: TradingSetup, side: "BUY" | "SELL", symbol: string, quote: number, time: number, venue?: "KOSPI" | "KOSDAQ"): number {
  const slippage = setup.paperSlippageProfileId ? getSlippageProfile(setup.paperSlippageProfileId) : null;
  if (!slippage) return quote;
  const cost = getCostProfile(setup.paperCommissionProfileId ?? paperTradingCostProfile.id)!;
  return simulateFill({ symbol, side, quantity: 1 }, quote, time, { cost, slippage, rules: getKrxExecutionRules(setup.universeRule.markets[0]!) }, venue).price;
}
