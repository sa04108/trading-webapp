import type { Candle } from '../runtime/modules/market-data/domain/candle.js';
import type { CorporateAction } from '../runtime/modules/facts/domain/fact.js';
import type { AnyTradingStrategy, StrategyBarContext } from '../runtime/modules/strategy/domain/strategy.js';
import { newEntryFilter, updateEntryFilter } from '../runtime/modules/strategy/strategies/shared/entry-filters.js';

type SymbolState = { holding: unknown; entryFilter: { wasHeld: boolean; cooldown: number } };
type SwingState = { bySymbol: Map<string, SymbolState>; warmup?: { closesBySymbol: Map<string, Map<number, number>> } };

/** 미보유 신규·재편입 종목의 가격 지표와 청산 후 대기를 이전 봉까지 재생한다. */
export function bootstrapTradingSymbolHistory(input: {
  strategy: AnyTradingStrategy;
  state: unknown;
  parameters: unknown;
  initialCash: number;
  beforeTsMs: number;
  histories: ReadonlyMap<string, readonly Candle[]>;
  actions: ReadonlyMap<string, readonly CorporateAction[]>;
  lastSeen?: Readonly<Record<string, number>>;
}): void {
  const { strategy, parameters, histories, actions, beforeTsMs } = input;
  if (!['range-breakout', 'ema-trend-switch', 'rsi-reversion'].includes(strategy.id)) throw new Error('가격 지표 재생을 지원하지 않는 전략입니다');
  if (!input.state || typeof input.state !== 'object' || !((input.state as SwingState).bySymbol instanceof Map)) throw new Error('전략 종목 상태가 올바르지 않습니다');
  const destination = input.state as SwingState;
  const symbols = [...histories.keys()].sort();
  if (!symbols.length) return;
  const filterParameters = parameters as { trendSmaBars: number; liquidityLookbackBars: number; cooldownBars: number };
  const cooldowns = new Map<string, { wasHeld: boolean; cooldown: number }>();
  for (const symbol of symbols) {
    const previous = destination.bySymbol.get(symbol);
    if (!previous || (!previous.entryFilter.wasHeld && previous.entryFilter.cooldown === 0)) continue;
    const lastSeen = input.lastSeen?.[symbol];
    const history = histories.get(symbol)!;
    if (!Number.isFinite(lastSeen) || !history.some(bar => bar.tsMs === lastSeen)) throw new Error(`${symbol}의 이전 처리 시각을 확인할 수 없어 재편입을 재생할 수 없습니다`);
    const filter = newEntryFilter();
    filter.wasHeld = previous.entryFilter.wasHeld;
    filter.cooldown = previous.entryFilter.cooldown;
    for (const bar of history) if (bar.tsMs > lastSeen!) updateEntryFilter(filter, bar.close, bar.volume, false, filterParameters);
    cooldowns.set(symbol, { wasHeld: filter.wasHeld, cooldown: filter.cooldown });
  }
  const noRandom = () => { throw new Error('가격 지표 준비 중 난수를 사용할 수 없습니다'); };
  const isolated = strategy.initialize({ symbols, initialCash: input.initialCash, rng: noRandom }) as SwingState;
  if (!(isolated.bySymbol instanceof Map)) throw new Error('전략 종목 상태가 올바르지 않습니다');
  const timeline = new Map<number, Map<string, Candle>>();
  const eventTimeline = new Map<number, Array<{ symbol: string; ratio: number }>>();
  for (const symbol of symbols) {
    const history = histories.get(symbol)!;
    if (!history.length) throw new Error(`${symbol}의 가격 지표 준비 이력이 없습니다`);
    let previous = -Infinity;
    for (const bar of history) {
      if (bar.symbol !== symbol || !Number.isFinite(bar.tsMs) || bar.tsMs >= beforeTsMs || bar.tsMs <= previous) throw new Error(`${symbol}의 가격 지표 준비 이력이 올바르지 않습니다`);
      previous = bar.tsMs;
      let bars = timeline.get(bar.tsMs);
      if (!bars) { bars = new Map(); timeline.set(bar.tsMs, bars); }
      bars.set(symbol, bar);
    }
    for (const action of actions.get(symbol) ?? []) {
      if (!Number.isFinite(action.effectiveTsMs) || action.effectiveTsMs >= beforeTsMs || !Number.isFinite(action.ratio) || action.ratio <= 0) throw new Error(`${symbol}의 자본변동 이력이 올바르지 않습니다`);
      const events = eventTimeline.get(action.effectiveTsMs) ?? [];
      events.push({ symbol, ratio: action.ratio }); eventTimeline.set(action.effectiveTsMs, events);
    }
  }
  const seen = new Map(symbols.map(symbol => [symbol, [] as Candle[]]));
  const dates = [...new Set([...timeline.keys(), ...eventTimeline.keys()])].sort((a, b) => a - b);
  const empty = new Set<string>();
  for (const tsMs of dates) {
    for (const action of eventTimeline.get(tsMs) ?? []) strategy.onCorporateAction?.(action.symbol, action.ratio, isolated);
    const bars = timeline.get(tsMs);
    if (!bars) continue;
    for (const [symbol, bar] of bars) seen.get(symbol)!.push(bar);
    const context: StrategyBarContext = { tsMs, bars, isRebalanceBar: false, getHistory: symbol => seen.get(symbol) ?? [], getMarketIndexHistory: () => [], portfolio: { cash: input.initialCash, equity: input.initialCash, positions: new Map() }, rng: noRandom, fundamentals: () => null, corporateActions: () => [], tradableSymbols: empty, activeUniverseSymbols: empty, selectionMetric: () => null };
    strategy.onBars(context, isolated, parameters);
  }
  if (destination.warmup && !(destination.warmup.closesBySymbol instanceof Map)) throw new Error('전략 상관 이력이 올바르지 않습니다');
  for (const symbol of symbols) {
    const fresh = isolated.bySymbol.get(symbol);
    if (!fresh) throw new Error(`${symbol}의 가격 지표 준비에 실패했습니다`);
    const cooldown = cooldowns.get(symbol);
    if (cooldown) {
      fresh.entryFilter.wasHeld = cooldown.wasHeld;
      fresh.entryFilter.cooldown = cooldown.cooldown;
    }
    destination.bySymbol.set(symbol, fresh);
    if (destination.warmup) {
      const closes = isolated.warmup?.closesBySymbol.get(symbol);
      if (!closes) throw new Error(`${symbol}의 상관 이력 준비에 실패했습니다`);
      destination.warmup.closesBySymbol.set(symbol, closes);
    }
  }
}
