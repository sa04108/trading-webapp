import { z } from 'zod';
import type { OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { TradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';
import { splitAdjustedClose } from '../../src/server/modules/strategy/strategies/shared/adjusted-price.js';
import type { MacroPoint } from './quarter-engine.js';

export const recoveryRotationParameters = z.object({
  formationDays: z.number().int().min(20).max(120).default(60),
  topN: z.number().int().min(2).max(5).default(3),
  targetAnnualVolatility: z.number().positive().max(1).default(.30),
  positionStopPct: z.number().positive().max(30).default(8),
});
type Parameters = z.infer<typeof recoveryRotationParameters>;
interface State {
  pending: { symbol: string; weight: number }[] | null;
  cooldownUntil: Map<string, number>;
  exitPending: Set<string>;
  bar: number;
}

/** 시장 회복을 확인하고 변동성과 거래 가능 금액으로 업종 비중을 제한한다. */
export function createRecoveryRotation(macro: ReadonlyMap<number, MacroPoint>): TradingStrategy<Parameters, State> {
  return {
    id: 'recovery-rotation', version: '0.1.0', name: '회복 확인 업종 순환 (연구)',
    description: '시장 회복과 업종 모멘텀을 확인하며 유가·환율 충격, 금리 인상, 변동성에 따라 비중을 줄이는 연구 전략',
    parameterSchema: recoveryRotationParameters, requiredRebalanceGapBars: 1,
    dataRequirements: { priceWarmupBars: (p) => Math.max(126, p.formationDays + 1), requiresCorporateActions: true },
    initialize: () => ({ pending: null, cooldownUntil: new Map(), exitPending: new Set(), bar: 0 }),
    onBars(context, state, p) {
      state.bar += 1;
      const m = macro.get(context.tsMs);
      const orders: OrderIntent[] = [];
      for (const symbol of state.exitPending) if (!context.portfolio.positions.has(symbol)) state.exitPending.delete(symbol);
      if (!m || !Number.isFinite(m.kospiSma60)) return { orders };
      const marketRecovering = m.kospi > m.kospiSma20 || m.kospi > m.kospiSma60;
      let exposure = marketRecovering && m.kospiRet20 > -.05 ? 1 : 0;
      if (m.oilRet20 > .20 || m.fxRet20 > .05 || m.vix >= 30) exposure = Math.min(exposure, .5);
      if (m.rateChange60 > 0 && m.oilRet20 > 0) exposure = Math.min(exposure, .85);
      for (const position of context.portfolio.positions.values()) {
        const close = context.bars.get(position.symbol)?.close;
        if (close === undefined || state.exitPending.has(position.symbol)) continue;
        if (exposure === 0 || close <= position.avgEntryPrice * (1 - p.positionStopPct / 100)) {
          orders.push({ symbol: position.symbol, side: 'SELL', quantity: position.quantity,
            reason: exposure === 0 ? '시장 회복 조건 이탈' : '종목 손절' });
          state.exitPending.add(position.symbol);
          state.cooldownUntil.set(position.symbol, state.bar + 10);
        }
      }
      if (exposure === 0) {
        state.pending = null;
        return { orders };
      }
      if (state.pending !== null) {
        let cash = context.portfolio.cash * .99;
        for (const target of state.pending) {
          if (state.exitPending.has(target.symbol) || (state.cooldownUntil.get(target.symbol) ?? 0) > state.bar) continue;
          if (context.tradableSymbols && !context.tradableSymbols.has(target.symbol)) continue;
          const close = context.bars.get(target.symbol)?.close;
          if (!close) continue;
          const held = context.portfolio.positions.get(target.symbol)?.quantity ?? 0;
          const wanted = Math.max(0, Math.floor(context.portfolio.equity * Math.min(target.weight, exposure / p.topN) / close) - held);
          const quantity = Math.min(wanted, Math.floor(cash / close));
          if (quantity > 0) {
            orders.push({ symbol: target.symbol, side: 'BUY', quantity, reason: '회복·변동성 조정 모멘텀' });
            cash -= quantity * close;
          }
        }
        state.pending = null;
        return { orders };
      }
      if (!context.isRebalanceBar) return { orders };
      const scored = [];
      for (const [symbol, bar] of context.bars) {
        if (context.tradableSymbols && !context.tradableSymbols.has(symbol)) continue;
        if (state.exitPending.has(symbol) || (state.cooldownUntil.get(symbol) ?? 0) > state.bar) continue;
        const original = context.getHistory(symbol);
        const needed = Math.max(126, p.formationDays + 1);
        if (original.length < needed) continue;
        const begin = original.length - needed;
        const actions = context.corporateActions(symbol);
        const history = original.slice(begin).map((b, i) => ({ ...b,
          close: splitAdjustedClose(original, actions, begin + i) ?? b.close }));
        const recent = history.slice(-21);
        const changes = recent.slice(1).map((v, i) => Math.log(v.close / recent[i]!.close));
        const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
        const vol = Math.sqrt(changes.reduce((a, b) => a + (b - mean) ** 2, 0) / (changes.length - 1) * 252);
        const long = bar.close / history.at(-1 - p.formationDays)!.close - 1;
        const short = bar.close / recent[0]!.close - 1;
        const sma = recent.slice(-20).reduce((a, b) => a + b.close, 0) / 20;
        if (long <= 0 || short <= 0 || bar.close <= sma || !Number.isFinite(vol) || vol < .01) continue;
        const adv = recent.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / 20;
        scored.push({ symbol, score: (.5 * long + .5 * short) / vol, vol, adv });
      }
      scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
      const chosen = scored.slice(0, p.topN);
      const vol = chosen.reduce((a, b) => a + b.vol / p.topN, 0);
      const gross = Math.min(exposure, p.targetAnnualVolatility / Math.max(.01, vol));
      // 3일치 평균 체결 가능 금액보다 큰 포지션을 쌓지 않는다.
      const targets = chosen.map((v) => ({ symbol: v.symbol,
        weight: Math.min(gross / p.topN, v.adv * .01 * 3 / context.portfolio.equity) }));
      const weights = new Map(targets.map((v) => [v.symbol, v.weight]));
      for (const position of context.portfolio.positions.values()) {
        if (state.exitPending.has(position.symbol)) continue;
        const close = context.bars.get(position.symbol)?.close;
        if (!close) continue;
        const target = Math.floor(context.portfolio.equity * (weights.get(position.symbol) ?? 0) / close);
        const quantity = Math.max(0, position.quantity - target);
        if (quantity > 0) orders.push({ symbol: position.symbol, side: 'SELL', quantity, reason: '업종 순위·비중 조정' });
      }
      state.pending = targets;
      return { orders };
    },
  };
}
