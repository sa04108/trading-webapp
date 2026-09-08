import { rankRetentionMomentum } from './rank-retention-momentum.js';
import { withConfirmedEntry } from './confirmed-entry.js';
import { withUncertainHistory } from './uncertain-history.js';
import { createQuarterlyValue, type CapitalizationPoint, type ValuationObservation } from './quarterly-value.js';
import { createQuarterlyEarnings, type QuarterObservation } from './quarterly-earnings.js';
import { createAnnualQualityMomentum, type AnnualObservation } from './annual-quality-momentum.js';
import { createRecoveryRotation } from './recovery-rotation.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { runBacktest, ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import type { BacktestUniverseScheduleEntry, OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import { getCostProfile, getKrxExecutionRules } from '../../src/server/modules/backtest/domain/cost-profiles.js';
import type { Fact } from '../../src/server/modules/facts/domain/fact.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy } from '../../src/server/modules/strategy/domain/strategy.js';

export interface MacroPoint {
  date: string;
  tsMs: number;
  kospi: number;
  kospiSma20: number;
  kospiSma60: number;
  kospiSma120: number;
  kospiRet20: number;
  kospiRet60: number;
  kospiRet120: number;
  kospiVol20: number;
  kospiDrawdown60: number;
  kosdaqRet60: number;
  breadth60: number;
  vix: number;
  oilRet20: number;
  fxRet20: number;
  rate: number;
  rateChange60: number;
}
export interface ResearchInput {
  asof: string;
  candles: Candle[];
  days: string[];
  macro: MacroPoint[];
  members: string[][];
  nontrading: [number, string[]][];
  metadata: Record<string, unknown>;
  facts?: Fact[];
  annualObservations?: AnnualObservation[];
  quarterlyObservations?: QuarterObservation[];
  valuationObservations?: ValuationObservation[];
  capitalizations?: CapitalizationPoint[];
  delisted?: Record<string, number[]>;
  uncertainActions?: { symbol: string; date: string; ratio: number; type: string }[];
}
export interface Candidate {
  id: string;
  strategyId: string;
  parameters: Record<string, unknown>;
  topN: number;
  rebalanceBars?: number;
}
export const STAGES = {
  earlier: ['2011-01-01', '2014-12-31'],
  development: ['2016-01-01', '2019-12-31'],
  validation: ['2020-01-01', '2023-12-31'],
  confirmation: ['2024-01-01', '2026-09-08'],
} as const;

export function candidates(): Candidate[] {
  return [
    ...[20, 60, 120].flatMap((formationDays) => [3, 5].map((topN) => ({
      id: `momentum-${formationDays}-${topN}`, strategyId: 'cross-sectional-momentum', topN,
      parameters: { formationDays, skipDays: 0, topN },
    }))),
    ...[20, 40, 60].map((lookbackBars) => ({
      id: `breakout-${lookbackBars}`, strategyId: 'range-breakout', topN: 5, parameters: { lookbackBars },
    })),
  ];
}

/** 월말은 대상 달의 마지막 날짜로 제한하여 달력상 3개월을 계산한다. */
export function addMonths(date: string, months: number): string {
  const start = new Date(`${date}T00:00:00Z`);
  const result = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(start.getUTCDate(), last));
  return result.toISOString().slice(0, 10);
}

export function quarterWindows(days: readonly string[], from: string, to: string) {
  const firsts = days.filter((d, i) => d >= from && d <= to && (i === 0 || d.slice(0, 7) !== days[i - 1]!.slice(0, 7)));
  return windowsFromStarts(days, from, to, firsts);
}

/** 고정 시작일의 중복·미래 만기·거래일 오류를 조용히 제외하지 않는다. */
export function windowsFromStarts(days: readonly string[], from: string, to: string, starts: readonly string[], strict = false) {
  if (new Set(starts).size !== starts.length || starts.some((d, i) => i > 0 && d <= starts[i - 1]!)) throw new Error('시작일은 중복 없이 오름차순이어야 합니다');
  return starts.flatMap((start) => {
    const endExclusive = addMonths(start, 3);
    const end = new Date(Date.parse(endExclusive) - 86_400_000).toISOString().slice(0, 10);
    if (end > to || start < from || !days.includes(start)) {
      if (strict) throw new Error(`평가 범위를 벗어난 고정 시작일: ${start}`);
      return [];
    }
    const tradingDays = days.filter((d) => d >= start && d < endExclusive);
    if (tradingDays.length < 2) {
      if (strict) throw new Error(`청산할 실제 거래일이 부족한 시작점: ${start}`);
      return [];
    }
    return [{ start, end, tradingDays }];
  });
}

/** 생략한 계좌 중단 기준은 유지하고 잘못된 위험 설정은 실행 전에 거부한다. */
export function parseAccountStopPct(value: unknown = 10): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100) {
    throw new Error('계좌 낙폭 중단은 0 초과 100 미만의 백분율이어야 합니다');
  }
  return value;
}

/** 휴장일을 건너뛴 실제 거래일에서 회전 신호를 옮기되 만기는 바꾸지 않는다. */
export function rebalanceDates(days: readonly string[], period: number, offset: unknown = 0): string[] {
  if (!Number.isSafeInteger(period) || period <= 0) throw new Error('회전 주기는 양의 정수여야 합니다');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= period) {
    throw new Error('순위 선정 이동은 0 이상 회전 주기 미만의 정수여야 합니다');
  }
  if (days.length > 0 && offset >= days.length) throw new Error('이동 후 순위를 선정할 거래일이 없습니다');
  return days.filter((_, i) => i >= offset && (i - offset) % period === 0);
}

export interface QuarterRisk {
  initialCash: number;
  tradeFromTsMs: number;
  lastSignalTsMs: number;
  targetPct: number;
  stopPct: number;
  resumeAfterMissedTarget?: boolean;
}

/** 목표·낙폭 청산을 기록하고 선택한 정책에서만 실제 목표 미달 청산 뒤 재개한다. */
export function withQuarterRisk(strategy: AnyTradingStrategy, risk: QuarterRisk) {
  if (risk.resumeAfterMissedTarget !== undefined && typeof risk.resumeAfterMissedTarget !== 'boolean') {
    throw new Error('실제 목표 미달 후 재개 설정은 불리언이어야 합니다');
  }
  if (risk.resumeAfterMissedTarget && (!Number.isFinite(risk.targetPct) || risk.targetPct < 10)) {
    throw new Error('재개 정책의 평가 목표는 실제 수익 목표 10% 이상이어야 합니다');
  }
  let peak = risk.initialCash;
  let stopped: string | null = null;
  const issued = new Set<string>();
  const events: { date: string; reason: string; equity: number }[] = [];
  const wrapped: AnyTradingStrategy = {
    ...strategy,
    ...(risk.resumeAfterMissedTarget ? { version: `${strategy.version}+target-retry.1` } : {}),
    onBars(context, state, parameters) {
      const decision = strategy.onBars(context, state, parameters);
      if (context.tsMs < risk.tradeFromTsMs) return decision;
      peak = Math.max(peak, context.portfolio.equity);
      // 전량 매도 후에도 실제 10%를 확보하지 못했다면 원래 최고점과 만기 아래에서 재개한다.
      if (risk.resumeAfterMissedTarget && stopped === '계좌 목표 청산' && context.portfolio.positions.size === 0
        && (context.portfolio.equity / risk.initialCash - 1) * 100 < 10) {
        stopped = null;
        issued.clear();
        if (context.portfolio.equity > peak * (1 - risk.stopPct / 100) && context.tsMs < risk.lastSignalTsMs) {
          events.push({ date: new Date(context.tsMs).toISOString().slice(0, 10), reason: '실제 목표 미달 후 재개', equity: context.portfolio.equity });
        }
      }
      if (!stopped) {
        if (context.portfolio.equity >= risk.initialCash * (1 + risk.targetPct / 100)) stopped = '계좌 목표 청산';
        else if (context.portfolio.equity <= peak * (1 - risk.stopPct / 100)) stopped = '계좌 낙폭 중단';
        else if (context.tsMs >= risk.lastSignalTsMs) stopped = '3개월 만기 청산';
        if (stopped) events.push({ date: new Date(context.tsMs).toISOString().slice(0, 10), reason: stopped, equity: context.portfolio.equity });
      }
      if (!stopped) return decision;
      for (const symbol of issued) if (!context.portfolio.positions.has(symbol)) issued.delete(symbol);
      const orders: OrderIntent[] = [];
      for (const position of context.portfolio.positions.values()) {
        if (issued.has(position.symbol)) continue;
        issued.add(position.symbol);
        orders.push({ symbol: position.symbol, side: 'SELL', quantity: position.quantity, reason: stopped });
      }
      return { orders };
    },
  };
  return { strategy: wrapped, events };
}

/** 평가 종료 이후의 폐지 사건은 시간축에 넘기지 않고 과거 폐지 경계는 보존한다. */
export function delistingsThrough(delisted: Record<string, number[]>, toTsMs: number) {
  return new Map(Object.entries(delisted).flatMap(([symbol, dates]) => {
    const known = dates.filter((t) => t <= toTsMs);
    return known.length > 0 ? [[symbol, known] as const] : [];
  }));
}

function summarize(values: readonly { returnPct: number; drawdownPct: number; targetReached: boolean; closed: boolean }[]) {
  const sorted = values.map((v) => v.returnPct).sort((a, b) => a - b);
  const percentile = (p: number) => {
    const i = (sorted.length - 1) * p;
    const lower = Math.floor(i);
    return sorted[lower]! + (sorted[Math.ceil(i)]! - sorted[lower]!) * (i - lower);
  };
  if (values.length === 0) return { count: 0 };
  return { count: values.length, targetHits: values.filter((v) => v.targetReached).length,
    targetFrequencyPct: values.filter((v) => v.targetReached).length / values.length * 100,
    medianPct: percentile(.5), p10Pct: percentile(.1), worstPct: sorted[0],
    lossFrequencyPct: values.filter((v) => v.returnPct < 0).length / values.length * 100,
    worstDrawdownPct: Math.min(...values.map((v) => v.drawdownPct)),
    unclosed: values.filter((v) => !v.closed).length };
}

export function main(argv: string[]) {
  const [inputPath, outputPath, stage, selectionPath, slippageArg, seedArg, windowLimitArg, cashArg, optionsPath] = argv;
  if (!inputPath || !outputPath || !stage || !(stage in STAGES)) {
    throw new Error('사용법: quarter-engine.ts input.gz output-dir earlier|development|validation|confirmation [selection.json] [slippage-bps] [seed] [window-limit-or-0] [initial-cash] [options.json]');
  }
  const bytes = readFileSync(inputPath);
  const input = JSON.parse(gunzipSync(bytes).toString()) as ResearchInput;
  if (input.metadata.usage) throw new Error('현재 신호 전용 입력으로 과거 성과를 평가할 수 없습니다');
  const registry = new StrategyRegistry();
  const trials = selectionPath ? JSON.parse(readFileSync(selectionPath, 'utf8')) as Candidate[] : candidates();
  const [from, to] = STAGES[stage as keyof typeof STAGES];
  const effectiveTo = input.asof < to ? input.asof : to;
  const optionsBytes = optionsPath ? readFileSync(optionsPath) : null;
  const options = optionsBytes ? JSON.parse(optionsBytes.toString()) as { starts?: string[]; resetUncertainHistory?: boolean; activationConfirmationBars?: number; accountStopPct?: number; rebalanceOffsetBars?: number; resumeAfterMissedTarget?: boolean } : {};
  const accountStopPct = parseAccountStopPct(options.accountStopPct);
  const researchOptions = optionsBytes ? { options, optionsSha256: createHash('sha256').update(optionsBytes).digest('hex') } : {};
  const allWindows = options.starts ? windowsFromStarts(input.days, from, effectiveTo, options.starts, true)
    : quarterWindows(input.days, from, effectiveTo);
  const windowLimit = Number(windowLimitArg ?? 0);
  const windows = windowLimit > 0 ? allWindows.slice(0, windowLimit) : allWindows;
  const initialCash = Number(cashArg ?? 100_000_000);
  if (!Number.isFinite(initialCash) || initialCash <= 0) throw new Error('초기 자금 오류');
  const byDate = new Map(input.macro.map((p) => [p.date, p]));
  const dayIndex = new Map(input.days.map((d, i) => [d, i]));
  const stockMode = input.metadata.instrument === 'stock';
  const slippageBps = Number(slippageArg ?? 5);
  const seed = Number(seedArg ?? 204);
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || !Number.isSafeInteger(seed)) throw new Error('체결 설정 오류');
  mkdirSync(outputPath, { recursive: true });
  for (const candidate of trials) {
    if (candidate.strategyId === 'annual-quality-momentum' && !input.annualObservations?.length) {
      throw new Error('연간 실적 관측이 없는 입력입니다');
    }
    if (candidate.strategyId === 'quarterly-earnings-research' && !input.quarterlyObservations?.length) {
      throw new Error('분기 실적 관측이 없는 입력입니다');
    }
    if (candidate.strategyId === 'low-per-quarterly-research' && (!input.valuationObservations?.length || !input.capitalizations?.length)) {
      throw new Error('가치 평가에 필요한 분기 실적 또는 시가총액이 없는 입력입니다');
    }
    const base = candidate.strategyId === 'recovery-rotation'
      ? createRecoveryRotation(new Map(input.macro.map((m) => [m.tsMs, m]))) as AnyTradingStrategy
      : candidate.strategyId === 'rank-retention-momentum'
        ? rankRetentionMomentum as AnyTradingStrategy
        : candidate.strategyId === 'annual-quality-momentum'
        ? createAnnualQualityMomentum(input.annualObservations ?? [], new Map(input.macro.map((m) => [m.tsMs, m]))) as AnyTradingStrategy
        : candidate.strategyId === 'quarterly-earnings-research'
          ? createQuarterlyEarnings(input.quarterlyObservations ?? []) as AnyTradingStrategy
          : candidate.strategyId === 'low-per-quarterly-research'
            ? createQuarterlyValue(input.valuationObservations ?? [], input.capitalizations ?? []) as AnyTradingStrategy
            : registry.get(candidate.strategyId);
    if (!base) throw new Error(`전략 누락: ${candidate.strategyId}`);
    const parameters = base.parameterSchema.parse(candidate.parameters);
    const results = [];
    const started = performance.now();
    for (const window of windows) {
      const fromTsMs = Date.parse(window.start);
      const toTsMs = Date.parse(window.end);
      const warmupTs = fromTsMs - 400 * 86_400_000;
      const risk = { initialCash, tradeFromTsMs: fromTsMs,
        lastSignalTsMs: Date.parse(window.tradingDays.at(-2)!), targetPct: 10.5, stopPct: accountStopPct,
        ...(options.resumeAfterMissedTarget === undefined ? {} : { resumeAfterMissedTarget: options.resumeAfterMissedTarget }) };
      const history = options.resetUncertainHistory ? withUncertainHistory(base, input.uncertainActions ?? [], fromTsMs) : null;
      const activation = options.activationConfirmationBars === undefined ? null
        : withConfirmedEntry(history?.strategy ?? base, input.macro, fromTsMs, options.activationConfirmationBars);
      const wrapper = withQuarterRisk(activation?.strategy ?? history?.strategy ?? base, risk);
      // 첫 진입은 시작일 종가 신호 이후이며 일정은 고정된 리밸런싱 간격을 따른다.
      const schedule: BacktestUniverseScheduleEntry[] = rebalanceDates(window.tradingDays, candidate.rebalanceBars ?? 5, options.rebalanceOffsetBars).map((date) => ({
        fromTsMs: Date.parse(date), symbols: input.members[Math.max(0, dayIndex.get(date)! - 1)]!,
      }));
      try {
        const result = runBacktest(wrapper.strategy, {
          candles: input.candles.filter((c) => c.tsMs >= warmupTs && c.tsMs <= toTsMs),
          initialCash: risk.initialCash, randomSeed: seed, maxPositions: candidate.topN, parameters,
          ...(input.facts ? { facts: input.facts } : {}),
          ...(input.delisted ? { delistedTsMsBySymbol: delistingsThrough(input.delisted, toTsMs) } : {}),
          tradeFromTsMs: fromTsMs, resultPeriod: { fromTsMs, toTsMs }, universeSchedule: schedule,
          marketTradingTsMs: window.tradingDays.map((d) => Date.parse(d)),
          nonTradingSymbolsByTsMs: new Map(input.nontrading.map(([t, symbols]) => [t, new Set(symbols)])),
          nonTradingCoveredPeriod: { from: window.start, to: window.end },
          execution: {
            cost: stockMode ? getCostProfile('kr-equity-default')! : { id: 'domestic-equity-etf-research', version: '1', buyCommissionRate: .00015, sellCommissionRate: .00015, sellTaxRate: 0 },
            slippage: { id: 'quarter-research', version: '1', bps: slippageBps, fixed: 0 },
            rules: stockMode ? { ...getKrxExecutionRules('KOSPI'), maxVolumeParticipationRate: .01 }
              : { tickSize: 5, minOrderQty: 1, maxVolumeParticipationRate: .01 },
          },
        });
        const closed = result.openPositions.length === 0;
        const affectedActions = (input.uncertainActions ?? []).filter((a) =>
          result.trades.some((t) => t.symbol === a.symbol && t.entryTsMs < Date.parse(a.date) && t.exitTsMs >= Date.parse(a.date))
          || result.openPositions.some((p) => p.symbol === a.symbol && p.entryTsMs < Date.parse(a.date) && toTsMs >= Date.parse(a.date)));
        const summary = { start: window.start, end: window.end, returnPct: result.metrics.totalReturnPct,
          drawdownPct: result.metrics.maxDrawdownPct, targetReached: closed && affectedActions.length === 0 && result.metrics.totalReturnPct >= 10,
          affectedActions,
          closed, trades: result.trades.length, fills: result.fills.length,
          ...(history ? { historyResetAudit: history.audit() } : {}),
          ...(activation ? { activation: activation.audit() } : {}),
          riskEvents: wrapper.events, startState: byDate.get(window.start),
          benchmarkKospiPct: (byDate.get(window.tradingDays.at(-1)!)!.kospi / byDate.get(window.start)!.kospi - 1) * 100 };
        results.push(summary);
        writeFileSync(path.join(outputPath, `${candidate.id}__${window.start}.json`), JSON.stringify({
          candidate, stage, inputSha256: createHash('sha256').update(bytes).digest('hex'), parameters, risk, seed, slippageBps,
          ...researchOptions, engineVersion: ENGINE_VERSION, strategyVersion: wrapper.strategy.version, summary, result,
        }));
      } catch (error) {
        const failure = { candidate, stage, start: window.start, end: window.end, status: 'failed',
          error: error instanceof Error ? error.message : String(error) };
        writeFileSync(path.join(outputPath, `${candidate.id}__${window.start}.json`), JSON.stringify(failure));
        throw new Error(`분기 실행 실패: ${candidate.id} ${window.start}: ${failure.error}`, { cause: error });
      }
    }
    let lastIndependentEnd = "";
    const independent = results.filter((r) => {
      if (r.start <= lastIndependentEnd) return false;
      lastIndependentEnd = r.end;
      return true;
    });
    const summary = { candidate, stage, inputSha256: createHash('sha256').update(bytes).digest('hex'), parameters,
      ...researchOptions, all: summarize(results), nonoverlapping: summarize(independent),
      windows: results, elapsedMs: Math.round(performance.now() - started) };
    writeFileSync(path.join(outputPath, `${candidate.id}__summary.json`), JSON.stringify(summary));
    process.stdout.write(`${JSON.stringify({ id: candidate.id, stage, ...summary.all, ms: summary.elapsedMs })}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
