import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

export interface UncertainEvent { symbol: string; date: string }

/** 현재 날짜까지 발생한 마지막 미확인 사건 이후의 실제 가격만 남긴다. */
export function historySinceEvent(history: readonly Candle[], eventDates: readonly number[], tsMs: number): readonly Candle[] {
  let boundary = -Infinity;
  for (const event of eventDates) if (event <= tsMs) boundary = Math.max(boundary, event);
  if (!history.length || boundary <= history[0]!.tsMs) return history;
  const first = history.findIndex((bar) => bar.tsMs >= boundary);
  return first < 0 ? [] : history.slice(first);
}

/** 보유 포지션의 시세·청산 경로를 유지하면서 새 신호의 불확실한 이력만 제한한다. */
export function withUncertainHistory(strategy: AnyTradingStrategy, events: readonly UncertainEvent[], auditFromTsMs: number) {
  const bySymbol = new Map<string, number[]>();
  for (const event of events) {
    const ts = Date.parse(event.date);
    if (!Number.isFinite(ts)) throw new Error('미확인 기업행위 날짜 오류');
    const list = bySymbol.get(event.symbol) ?? [];
    list.push(ts);
    bySymbol.set(event.symbol, list);
  }
  const blocked = new Map<string, { symbol: string; bars: number; first: string; last: string }>();
  const wrapped: AnyTradingStrategy = {
    ...strategy,
    version: `${strategy.version}+history-reset.1`,
    onBars(context, state, parameters) {
      const cache = new Map<string, readonly Candle[]>();
      const getHistory = (symbol: string) => {
        const cached = cache.get(symbol);
        if (cached) return cached;
        const original = context.getHistory(symbol);
        const history = historySinceEvent(original, bySymbol.get(symbol) ?? [], context.tsMs);
        cache.set(symbol, history);
        return history;
      };
      const needed = strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 0;
      const eligible = new Set<string>();
      for (const symbol of context.tradableSymbols ?? context.bars.keys()) {
        const history = getHistory(symbol);
        if (history.length >= needed) eligible.add(symbol);
        else if (context.tsMs >= auditFromTsMs && history.length !== context.getHistory(symbol).length) {
          const date = new Date(context.tsMs).toISOString().slice(0, 10);
          const record = blocked.get(symbol) ?? { symbol, bars: 0, first: date, last: date };
          record.bars += 1;
          record.last = date;
          blocked.set(symbol, record);
        }
      }
      return strategy.onBars({ ...context, getHistory, tradableSymbols: eligible }, state, parameters);
    },
  };
  return { strategy: wrapped, audit: () => [...blocked.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)) };
}
