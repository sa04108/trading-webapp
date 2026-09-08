import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { trendPullbackStrategy } from './trend-pullback.js';
import { runBacktest, ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import { getCostProfile, getKrxExecutionRules } from '../../src/server/modules/backtest/domain/cost-profiles.js';
import type { BacktestUniverseScheduleEntry, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

export type Regime = 'high_vol' | 'low_rate' | 'kr_uptrend' | 'high_vol_uptrend';
export interface MacroPoint {
  date: string;
  ndxUsd: number;
  ndxKrw: number;
  ndxDate: string;
  fxDate: string;
  vix: number;
  vixDate: string;
  rate: number;
  rateDate: string;
  kospi: number;
  regimes: Record<Regime, boolean>;
}
interface ResearchInput {
  candles: [string, number, number, number, number, number, number, number][];
  facts: Fact[];
  schedule: BacktestUniverseScheduleEntry[];
  macro: MacroPoint[];
  nontrading: [number, string[]][];
  delisted: Record<string, number[]>;
  suspectActions: { symbol: string; date: string; ratio: number }[];
  metadata: Record<string, unknown>;
}
export interface Candidate {
  strategyId: string;
  variant: string;
  parameters: Record<string, unknown>;
  regime: Regime;
}
export const PERIODS = {
  development: ['2016-01-01', '2019-12-31'],
  validation: ['2020-01-01', '2022-12-31'],
  confirmation: ['2023-01-01', '2026-08-28'],
} as const;

/** 원전략의 상태 갱신은 유지하고 국면·비중·보유기간만 공통 제한한다. */
export function withRegime(
  strategy: AnyTradingStrategy,
  allowed: ReadonlyMap<number, boolean>,
  tradingDays: readonly number[],
  lastSignalTs: number,
): AnyTradingStrategy {
  const indexes = new Map(tradingDays.map((ts, i) => [ts, i]));
  return {
    ...strategy,
    onBars(context, state, parameters) {
      const decision = strategy.onBars(context, state, parameters);
      const flatten = !allowed.get(context.tsMs) || context.tsMs >= lastSignalTs;
      const forced = new Map<string, OrderIntent>();
      for (const position of context.portfolio.positions.values()) {
        const age = (indexes.get(context.tsMs) ?? 0) - (indexes.get(position.entryTsMs) ?? 0);
        if (flatten || age >= 19) {
          forced.set(position.symbol, { symbol: position.symbol, side: 'SELL', quantity: position.quantity,
            reason: flatten ? '국면 종료 또는 연구 기간 종료' : '20거래일 보유 상한' });
        }
      }
      const orders: OrderIntent[] = [...forced.values()];
      for (const order of decision.orders) {
        if (forced.has(order.symbol)) continue;
        if (order.side === 'SELL') {
          orders.push(order);
        } else if (!flatten) {
          const close = context.bars.get(order.symbol)?.close;
          if (close === undefined || close <= 0) continue;
          const held = context.portfolio.positions.get(order.symbol)?.quantity ?? 0;
          const quantity = Math.min(order.quantity, Math.max(0, Math.floor(context.portfolio.equity * 0.2 / close) - held));
          if (quantity > 0) orders.push({ ...order, quantity });
        }
      }
      return { orders };
    },
  };
}

export function pullbackCandidates(): Candidate[] {
  return [10, 5, 15].flatMap((entryRsi, i) =>
    (['high_vol', 'low_rate', 'kr_uptrend', 'high_vol_uptrend'] as const).map((regime) => ({
      strategyId: 'trend-pullback', variant: ['base', 'nearby-a', 'nearby-b'][i]!,
      parameters: { entryRsi }, regime,
    })));
}

export function candidates(): Candidate[] {
  const variants: Record<string, Record<string, unknown>[]> = {
    'range-breakout': [{}, { lookbackBars: 10, trailAtrMultiplier: 1.5 }, { lookbackBars: 30, trailAtrMultiplier: 2.5 }],
    'rsi-reversion': [{}, { rsiPeriod: 7, entryRsi: 25, exitRsi: 60 }, { rsiPeriod: 21, entryRsi: 35, exitRsi: 60 }],
    'ema-trend-switch': [{}, { fastEmaBars: 8, slowEmaBars: 20 }, { fastEmaBars: 16, slowEmaBars: 40 }],
    'cross-sectional-momentum': [{}, { formationDays: 60, skipDays: 5 }, { formationDays: 120, skipDays: 10 }],
    'value-quality-rank': [{}, { staleQuarters: 1 }, { staleQuarters: 3 }],
    'low-per-high-roe-rank': [{}, { staleQuarters: 1 }, { staleQuarters: 3 }],
    'earnings-acceleration-rank': [{}, { priceMomentumDays: 60 }, { priceMomentumDays: 189 }],
  };
  return Object.entries(variants).flatMap(([strategyId, values]) => values.flatMap((parameters, i) =>
    (['high_vol', 'low_rate', 'kr_uptrend', 'high_vol_uptrend'] as const).map((regime) => ({
      strategyId, variant: ['base', 'nearby-a', 'nearby-b'][i]!, regime,
      parameters: { ...parameters, ...(strategyId.includes('rank') || strategyId === 'cross-sectional-momentum'
        ? { topN: 5 } : { maxHoldBars: 20 }) },
    }))));
}

/** 국면 진입 다음 날부터 국면 종료 다음 날까지 같은 구간을 양쪽에 적용한다. */
export function comparison(
  equity: readonly { tsMs: number; equity: number }[],
  macro: readonly MacroPoint[],
  regime: Regime,
  from: string,
  to: string,
  initialCash: number,
  holdingPeriods: readonly { entryTsMs: number; exitTsMs: number }[] = [],
) {
  const byTs = new Map(equity.map((point) => [point.tsMs, point.equity]));
  const rows: { date: string; strategy: number; ndxKrw: number; ndxUsd: number; active: boolean }[] = [];
  let previous = initialCash;
  let fullNdxKrw = 1;
  let fullNdxUsd = 1;
  let activeStrategy = 1;
  let activeNdxKrw = 1;
  let activeNdxUsd = 1;
  let activeDays = 0;
  let episodes = 0;
  let wasActive = false;
  for (let i = 1; i < macro.length; i += 1) {
    const point = macro[i]!;
    if (point.date < from || point.date > to) continue;
    const current = byTs.get(Date.parse(point.date));
    if (current === undefined) throw new Error(`자산 관측 누락: ${point.date}`);
    const prior = macro[i - 1]!;
    const active = (prior.date >= from && prior.regimes[regime])
      || ((macro[i - 2]?.date ?? '') >= from && (macro[i - 2]?.regimes[regime] ?? false))
      || holdingPeriods.some((trade) => trade.entryTsMs <= Date.parse(point.date) && trade.exitTsMs >= Date.parse(point.date));
    const strategyReturn = current / previous;
    // 최초 국내 관측 이전의 미국 연말 수익이 새 평가 기간에 섞이지 않게 한다.
    const krw = rows.length === 0 ? 1 : point.ndxKrw / prior.ndxKrw;
    const usd = rows.length === 0 ? 1 : point.ndxUsd / prior.ndxUsd;
    fullNdxKrw *= krw;
    fullNdxUsd *= usd;
    if (active) {
      activeDays += 1;
      if (!wasActive) episodes += 1;
      activeStrategy *= strategyReturn;
      activeNdxKrw *= krw;
      activeNdxUsd *= usd;
    }
    rows.push({ date: point.date, strategy: strategyReturn - 1, ndxKrw: krw - 1, ndxUsd: usd - 1, active });
    wasActive = active;
    previous = current;
  }
  return { activeDays, episodes, activeStrategyPct: (activeStrategy - 1) * 100,
    activeNdxKrwPct: (activeNdxKrw - 1) * 100, activeNdxUsdPct: (activeNdxUsd - 1) * 100,
    activeExcessPp: (activeStrategy - activeNdxKrw) * 100,
    fullNdxKrwPct: (fullNdxKrw - 1) * 100, fullNdxUsdPct: (fullNdxUsd - 1) * 100, rows };
}

export function main(argv: string[]) {
  const [inputPath, outputPath, stage, selectionPath, costArg, seedArg, overridePath] = argv;
  if (!inputPath || !outputPath || !stage || !(stage in PERIODS)) {
    throw new Error('사용법: tsx scripts/research/kr-regime-engine.ts input.gz output-dir development|validation|confirmation [selection.json] [cost-multiplier] [seed] [overrides.json]');
  }
  const period = PERIODS[stage as keyof typeof PERIODS];
  const [from, to] = period;
  const inputBytes = readFileSync(inputPath);
  const input = JSON.parse(gunzipSync(inputBytes).toString()) as ResearchInput;
  const overrideBytes = overridePath ? readFileSync(overridePath) : null;
  if (overrideBytes) {
    const corrections = z.object({ nontrading: z.array(z.tuple([
      z.number().int().nonnegative(), z.array(z.string().regex(/^[A-Za-z0-9._-]{1,20}$/)),
    ])) }).parse(JSON.parse(overrideBytes.toString()));
    // 독립 원문으로 확인한 체결 불가일만 보강하며 가격 봉은 만들지 않는다.
    const nontrading = new Map(input.nontrading.map(([ts, symbols]) => [ts, new Set(symbols)]));
    for (const [ts, symbols] of corrections.nontrading) {
      const existing = nontrading.get(ts) ?? new Set<string>();
      for (const symbol of symbols) existing.add(symbol);
      nontrading.set(ts, existing);
    }
    input.nontrading = [...nontrading].map(([ts, symbols]) => [ts, [...symbols]]);
  }
  const fromTs = Date.parse(from);
  const toTs = Date.parse(to);
  const warmupTs = fromTs - 460 * 86_400_000;
  const candles: Candle[] = input.candles.filter((r) => r[1] >= warmupTs && r[1] <= toTs).map(
    ([symbol, tsMs, venue, open, high, low, close, volume]) => ({
      symbol, tsMs, market: 'KR', venue: venue === 1 ? 'KOSPI' : 'KOSDAQ', timeframe: '1d', open, high, low, close, volume,
    }),
  );
  const tradingDays = input.macro.filter((r) => r.date >= from && r.date <= to).map((r) => Date.parse(r.date));
  const macro = input.macro.filter((r) => Date.parse(r.date) >= warmupTs && r.date <= to);
  const lastSignal = tradingDays.at(-2)!;
  const stageSchedule = input.schedule.filter((s) => s.fromTsMs >= tradingDays[2]! && s.fromTsMs <= toTs);
  const initialMembers = input.schedule.findLast((s) => s.fromTsMs <= fromTs)?.members ?? [];
  const schedule = [{ fromTsMs: fromTs, members: initialMembers }, ...stageSchedule.filter((s) => s.fromTsMs > fromTs)];
  const registry = new StrategyRegistry();
  const trials: Candidate[] = selectionPath ? JSON.parse(readFileSync(selectionPath, 'utf8')) as Candidate[] : candidates();
  const costMultiplier = Number(costArg ?? 1);
  const seed = Number(seedArg ?? 204);
  if (!Number.isFinite(costMultiplier) || costMultiplier <= 0 || !Number.isSafeInteger(seed)) throw new Error('비용 배수·시드가 유효하지 않습니다');
  const baseCost = getCostProfile('kr-equity-default')!;
  mkdirSync(outputPath, { recursive: true });
  for (const candidate of trials) {
    const strategy = candidate.strategyId === trendPullbackStrategy.id
      ? trendPullbackStrategy as AnyTradingStrategy : registry.get(candidate.strategyId);
    if (!strategy) throw new Error(`미등록 전략: ${candidate.strategyId}`);
    const parameters = strategy.parameterSchema.parse(candidate.parameters);
    const id = `${candidate.strategyId}__${candidate.regime}__${candidate.variant}`;
    const allowed = new Map(macro.map((m) => [Date.parse(m.date), m.regimes[candidate.regime]]));
    const started = performance.now();
    const common = { id, stage, candidate, parameters, engineVersion: ENGINE_VERSION, strategyVersion: strategy.version,
      inputSha256: createHash('sha256').update(inputBytes).digest('hex'),
      overrideSha256: overrideBytes ? createHash('sha256').update(overrideBytes).digest('hex') : null,
      from, to, costMultiplier, seed };
    try {
      const result = runBacktest(withRegime(strategy, allowed, input.macro.map((r) => Date.parse(r.date)), lastSignal), {
        candles, initialCash: 100_000_000, parameters, randomSeed: seed, maxPositions: 5,
        tradeFromTsMs: fromTs, resultPeriod: { fromTsMs: fromTs, toTsMs: toTs },
        execution: { cost: { ...baseCost, buyCommissionRate: baseCost.buyCommissionRate * costMultiplier,
          sellCommissionRate: baseCost.sellCommissionRate * costMultiplier },
        slippage: { id: 'research-slippage', version: '1', bps: 5 * costMultiplier, fixed: 0 },
        rules: { ...getKrxExecutionRules('KOSPI'), maxVolumeParticipationRate: 0.01 } },
        facts: input.facts, universeSchedule: schedule,
        nonTradingSymbolsByTsMs: new Map(input.nontrading.map(([ts, symbols]) => [ts, new Set(symbols)])),
        marketTradingTsMs: tradingDays,
        delistedTsMsBySymbol: new Map(Object.entries(input.delisted)),
        nonTradingCoveredPeriod: { from, to },
      });
      const compared = comparison(result.equityPoints, input.macro, candidate.regime, from, to, 100_000_000, result.trades);
      const dayIndex = new Map(input.macro.map((r, i) => [Date.parse(r.date), i]));
      const holdingBars = result.trades.map((t) => (dayIndex.get(t.exitTsMs) ?? 0) - (dayIndex.get(t.entryTsMs) ?? 0));
      const affectedActions = input.suspectActions.filter((a) => result.trades.some((t) =>
        t.symbol === a.symbol && t.entryTsMs < Date.parse(a.date) && t.exitTsMs >= Date.parse(a.date)));
      const summary = { ...common, status: 'completed', metrics: result.metrics, comparison: compared,
        averageHoldingBars: holdingBars.length ? holdingBars.reduce((a, b) => a + b, 0) / holdingBars.length : null,
        maxHoldingBars: holdingBars.length ? Math.max(...holdingBars) : null,
        affectedActions, openPositions: result.openPositions, warnings: result.warnings,
        delistingLiquidations: result.delistingLiquidations, equity: result.equityPoints,
        trades: result.trades, fills: result.fills, elapsedMs: Math.round(performance.now() - started) };
      writeFileSync(path.join(outputPath, `${id}.json`), JSON.stringify(summary));
      process.stdout.write(`${JSON.stringify({ id, return: result.metrics.totalReturnPct, excess: compared.activeExcessPp,
        trades: result.trades.length, affectedActions: affectedActions.length, ms: summary.elapsedMs })}\n`);
    } catch (error) {
      const failure = { ...common, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      writeFileSync(path.join(outputPath, `${id}.json`), JSON.stringify(failure));
      process.stdout.write(`${JSON.stringify({ id, error: failure.error })}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
