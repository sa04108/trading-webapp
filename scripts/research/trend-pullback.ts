import { z } from 'zod';
import type { OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import {
  newAtr, newRsi, rsiValue, scaleAtr, scaleRsi, updateAtr, updateRsi,
  type AtrState, type RsiState,
} from '../../src/server/modules/strategy/strategies/shared/indicators.js';
import {
  confirmEntry, newHolding, scaleHoldingPrices, type HoldingState,
} from '../../src/server/modules/strategy/strategies/shared/trailing-stop.js';

export const trendPullbackParameters = z.object({
  trendBars: z.number().int().min(20).max(252).default(60),
  rsiPeriod: z.number().int().min(2).max(14).default(2),
  entryRsi: z.number().min(5).max(30).default(10),
  exitRsi: z.number().min(50).max(95).default(60),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  stopAtrMultiplier: z.number().positive().max(5).default(2),
  maxHoldBars: z.number().int().min(1).max(20).default(5),
  topN: z.number().int().min(1).max(20).default(5),
  maxPositionWeightPercent: z.number().min(1).max(100).default(20),
});
type Parameters = z.infer<typeof trendPullbackParameters>;
interface SymbolState {
  rsi: RsiState;
  atr: AtrState;
  closes: number[];
  holding: HoldingState;
}
export interface TrendPullbackState {
  bySymbol: Map<string, SymbolState>;
}

/** 검증 전용 후보다. 성과가 확인되지 않아 운영 전략 목록에는 등록하지 않는다. */
export const trendPullbackStrategy: TradingStrategy<Parameters, TrendPullbackState> = {
  id: 'trend-pullback', version: '0.1.0', name: '단기 추세 눌림목 (연구)',
  description: '종목의 상승 추세 안에서 RSI(2) 과매도를 매수하고 회복·고정 손절·5봉 상한으로 청산하는 연구 후보',
  parameterSchema: trendPullbackParameters,
  dataRequirements: {
    priceWarmupBars: (p) => Math.max(p.trendBars, p.rsiPeriod + 1, p.atrPeriod),
    requiresCorporateActions: true,
  },
  initialize: () => ({ bySymbol: new Map() }),
  onBars(context, state, p) {
    const orders: OrderIntent[] = [];
    const candidates: { symbol: string; rsi: number; close: number; atr: number }[] = [];
    let pendingCount = 0;
    for (const [symbol, bar] of context.bars) {
      let current = state.bySymbol.get(symbol);
      if (!current) {
        current = { rsi: newRsi(), atr: newAtr(), closes: [], holding: newHolding() };
        state.bySymbol.set(symbol, current);
      }
      updateRsi(current.rsi, bar.close, p.rsiPeriod);
      updateAtr(current.atr, bar, p.atrPeriod);
      current.closes.push(bar.close);
      if (current.closes.length > p.trendBars) current.closes.shift();
      const rsi = rsiValue(current.rsi);
      const position = context.portfolio.positions.get(symbol);
      if (position && position.quantity > 0) {
        current.holding.pendingEntry = false;
        current.holding.barsHeld += 1;
        if (current.holding.stopLevel === null) {
          confirmEntry(current.holding, position.avgEntryPrice, p.stopAtrMultiplier);
        }
        if (current.holding.exitPending) continue;
        const stop = current.holding.stopLevel;
        const reason = rsi !== null && rsi >= p.exitRsi ? '눌림 회복'
          : stop !== null && bar.close < stop ? '고정 ATR 손절'
            : current.holding.barsHeld >= p.maxHoldBars ? '단기 보유 상한' : null;
        if (reason) {
          orders.push({ symbol, side: 'SELL', quantity: position.quantity, reason });
          current.holding.exitPending = true;
        }
        continue;
      }
      if (current.holding.pendingEntry) {
        // 전날 예약이 체결되지 않았으면 한 봉 기다려 중복 매수를 피한다.
        current.holding = newHolding();
        pendingCount += 1;
        continue;
      }
      current.holding = newHolding();
      if (context.tradableSymbols !== null && !context.tradableSymbols.has(symbol)) continue;
      if (current.closes.length < p.trendBars || rsi === null || rsi > p.entryRsi || current.atr.atr === null) continue;
      const average = current.closes.reduce((sum, close) => sum + close, 0) / p.trendBars;
      if (bar.close <= average) continue;
      candidates.push({ symbol, rsi, close: bar.close, atr: current.atr.atr });
    }
    const slots = Math.max(0, p.topN - context.portfolio.positions.size - pendingCount);
    let availableCash = context.portfolio.cash * 0.99;
    candidates.sort((a, b) => a.rsi - b.rsi || a.symbol.localeCompare(b.symbol));
    for (const candidate of candidates.slice(0, slots)) {
      const budget = Math.min(availableCash, context.portfolio.equity * p.maxPositionWeightPercent / 100);
      const quantity = Math.floor(budget / candidate.close);
      if (quantity < 1) continue;
      orders.push({ symbol: candidate.symbol, side: 'BUY', quantity, reason: '상승 추세 속 단기 과매도' });
      const holding = state.bySymbol.get(candidate.symbol)!.holding;
      holding.entryAtr = candidate.atr;
      holding.pendingEntry = true;
      availableCash -= quantity * candidate.close;
    }
    return { orders };
  },
  onCorporateAction(symbol, ratio, state) {
    const current = state.bySymbol.get(symbol);
    if (!current) return;
    scaleRsi(current.rsi, ratio);
    scaleAtr(current.atr, ratio);
    scaleHoldingPrices(current.holding, ratio);
    current.closes = current.closes.map((close) => close / ratio);
  },
};
