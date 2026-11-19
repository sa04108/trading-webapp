import { ActionGapEntryGate, type ActionGapPeriods, latestActionGap, holdingActionGap, resetUnheldPriceState } from "../runtime/modules/backtest/domain/action-gap.js";
import { corporateActionGapPeriods } from "../runtime/modules/backtest/application/backtest-corporate-action-gaps.js";
import { blockingFinancialGapExamples } from "../runtime/modules/backtest/application/backtest-financial-coverage.js";
import { bootstrapTradingSymbolHistory } from "./trading-symbol-history.js";
import { BUY_PRIORITY_SEED_SALT, evaluateDailyBar, adjustDailyOrderUnits, eligibleDailyOrders, markedEquity, membershipExits, prioritizeDailyOrders, requiredDailyBars } from "../runtime/modules/strategy/domain/daily-decision.js";
import { readMarketIndex } from "../runtime/modules/market-data/application/market-index-history.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { serialize, deserialize } from "node:v8";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../runtime/shared/db/schema.js";
import type { DatabaseHandle } from "../runtime/shared/db/database.js";
import type { TradingDecisionEngine } from "../server/modules/trading/application/trading-service.js";
import type { AnyTradingStrategy, StrategyBarContext } from "../runtime/modules/strategy/domain/strategy.js";
import type { Candle } from "../runtime/modules/market-data/domain/candle.js";
import type { Position } from "../runtime/modules/backtest/domain/types.js";
import { CORPORATE_ACTION_FIELD } from "../runtime/modules/facts/domain/fact.js";
import { alignCorporateActionEffectiveDates, corporateActionRawDateRange, CORPORATE_ACTION_ALIGNMENT_WINDOW } from "../runtime/modules/facts/domain/corporate-action-effective-date.js";
import { PitFactView } from "../runtime/modules/facts/domain/pit-fact-view.js";
import { createUniverseRuntime } from "../runtime/workers/universe-runtime.js";
import { readRuntimeVersions } from "../runtime/shared/runtime-versions.js";
import { createOfficialKrxTradingCalendar } from "../server/modules/market-data/infrastructure/krx/krx-trading-calendar.js";
import { createRng } from "../runtime/modules/backtest/domain/seeded-rng.js";
import { AgentDataRequired } from "../shared/agent-protocol.js";
import type { TradingDataNeed } from "../server/modules/trading/application/trading-data.js";
import { computeRebalanceDates } from "../shared/schemas/rebalance-interval.js";
import { derivePreparationFactYearRange } from "../runtime/modules/market-data/domain/fact-year-range.js";
import { addCalendarDays, kstDateOf } from "../runtime/modules/market-data/domain/kst-date.js";

type Input = Parameters<TradingDecisionEngine["evaluate"]>[0];
type Output = Awaited<ReturnType<TradingDecisionEngine["evaluate"]>>;
interface Checkpoint {
  abi: 1;
  hash: string;
  strategyId: string;
  state: unknown;
  lastBar: number;
  rngCalls: number;
  priorityCalls?: number;
  pendingExits?: string[];
  deferredBuys?: Output["orders"];
  originBar?: number;
  lastSeen?: Record<string, number>;
  tracked?: string[];
  actionCutoffs?: Record<string, number>;
  pendingSells?: Array<{ symbol: string; reason?: string; target: number }>;
  firstDecision: boolean;
  rebalanceDate: string;
  members: Array<{ symbol: string; marketCapKrw: string | null; volume: number | null; tradingValueKrw: string | null }>;
}
class DecisionDataRequired extends Error { constructor(message: string, readonly need: TradingDataNeed) { super(message); } }
interface Bundle { formatVersion: number; nodeMajor: number; lifecycleAbi: number; getStrategy(id: string): AnyTradingStrategy | null; reconcileState(id: string, state: unknown, input: { interrupted: boolean; positions: readonly string[]; symbols: readonly string[] }): void; }

export async function calculate(message: { input: Input; date: string; executionDate?: string; bundlePath: string }, database: DatabaseHandle, bundle: Bundle, testRuntime?: ReturnType<typeof createUniverseRuntime>): Promise<Output> {
  const { deployment, portfolio, warmupOnly } = message.input;
  if (!Number.isFinite(message.input.cashKrw)) throw new Error("전략 현금을 확인할 수 없습니다");
  const strategy = bundle.getStrategy(deployment.strategyId);
  if (!strategy || strategy.id !== deployment.strategyId || strategy.version !== deployment.version) throw new Error("고정된 전략 버전이 일치하지 않습니다");
  const parsed = strategy.parameterSchema.safeParse(deployment.parameters);
  if (!parsed.success) throw new Error("고정된 전략 파라미터가 올바르지 않습니다");
  const parameters: unknown = parsed.data;
  const checkpoint = message.input.checkpoint ? deserialize(Buffer.from(message.input.checkpoint, "base64")) as Checkpoint : null;
  if (checkpoint && (checkpoint.abi !== 1 || checkpoint.hash !== deployment.artifactHash || checkpoint.strategyId !== strategy.id || !Number.isSafeInteger(checkpoint.rngCalls) || checkpoint.rngCalls < 0 || checkpoint.rngCalls > 10_000_000 || !Number.isFinite(checkpoint.lastBar))) throw new Error("저장된 전략 상태가 호환되지 않습니다");
  const latest = Date.parse(`${message.date}T00:00:00Z`);
  if (checkpoint && checkpoint.lastBar > latest) throw new Error("전략 상태가 최근 확정 봉보다 앞서 있습니다");
  if (checkpoint && checkpoint.lastBar === latest) {
    if (!Array.isArray(checkpoint.members)) throw new Error("저장된 유니버스 상태가 올바르지 않습니다");
    // 같은 확정 봉이라도 활성화·복구 전에는 현재 coverage와 결손을 다시 확인한다.
  }
  const anchor = kstDateOf(deployment.activatedAtMs ?? deployment.createdAtMs);
  const period = { from: anchor > message.date ? message.date : anchor, to: message.date };
  const held = Object.keys(portfolio);
  const indexBars = strategy.dataRequirements?.marketIndexBars?.(parameters) ?? 0;
  if (!Number.isSafeInteger(indexBars) || indexBars < 0 || indexBars > 3000) throw new Error("시장 지수 준비 봉 수가 올바르지 않습니다");
  const indexTradeFrom = checkpoint ? new Date(checkpoint.lastBar).toISOString().slice(0, 10) : message.date;
  const indexRequirement = indexBars ? { from: addCalendarDays(indexTradeFrom, -(indexBars * 3 + 30)), to: message.date, tradeFrom: indexTradeFrom, minimumBars: indexBars } : undefined;
  const minimumBars = requiredDailyBars(strategy, parameters);
  const warmup = deployment.universeRule.stages.reduce((limit, stage) =>
    stage.criterion === "DECLINE" ? Math.max(limit, stage.lookbackTradingDays) : limit, minimumBars);
  if (!Number.isSafeInteger(warmup) || warmup > 3000) throw new Error("전략 준비 봉 수가 올바르지 않습니다");
  const calendar = createOfficialKrxTradingCalendar();
  function preparationStart(end: string): number {
    let remaining = warmup;
    for (let day = end; ; day = addCalendarDays(day, -1)) {
      const status = calendar.classify(day, "KOSPI").state;
      if (status === "UNKNOWN") throw new Error(`준비 구간의 공식 거래일이 확인되지 않았습니다: ${day}`);
      if (status === "OPEN" && --remaining === 0) return Date.parse(`${day}T00:00:00Z`);
    }
  }
  const originBar = checkpoint?.originBar ?? preparationStart(checkpoint ? kstDateOf(Math.min(checkpoint.lastBar, deployment.activatedAtMs ?? deployment.createdAtMs)) : message.date);
  const warmupFrom = Date.parse(`${addCalendarDays(message.date, -(warmup * 3 + 30))}T00:00:00Z`);
  if (checkpoint && (checkpoint.lastBar % 86_400_000 !== 0 || latest - checkpoint.lastBar > 5 * 366 * 86_400_000)) throw new Error("전략 중단 기간이 너무 길거나 저장 시각이 올바르지 않아 안전하게 재생할 수 없습니다");
  const from = checkpoint ? Math.max(originBar, Math.min(warmupFrom, checkpoint.lastBar)) : originBar;
  let fromDate = new Date(from).toISOString().slice(0, 10);
  let actionFromYear = Number(addCalendarDays(fromDate, -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays).slice(0, 4));
  const executionDate = message.executionDate ?? message.date;
  const actionToYear = Number(addCalendarDays(executionDate, CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays).slice(0, 4));
  const lookback = Math.max(strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0, deployment.universeRule.stages.some((stage) => stage.criterion === "PER" || stage.criterion === "ROE") ? 4 : 0);
  const financialYears = derivePreparationFactYearRange({ from: fromDate, to: message.date }, lookback);
  const needsFinancial = strategy.requiresFundamentals === true || lookback > 0;
  let need: TradingDataNeed = { masterDates: computeRebalanceDates(period, deployment.universeRule.rebalanceInterval), priceRange: { from: fromDate, to: message.date }, financial: needsFinancial ? { symbols: [...held], ...financialYears } : null, actions: { symbols: [...held], fromYear: actionFromYear, toYear: actionToYear }, entries: [], ...(indexRequirement ? { marketIndex: indexRequirement } : {}) };
  const runtime = testRuntime ?? createUniverseRuntime(database, readRuntimeVersions().collectionVersion);
  const marketIndex = indexRequirement ? readMarketIndex(database.db, indexRequirement) : undefined;
  if (indexRequirement && (!runtime.symbolMaster.isRangeCovered(indexRequirement.from, indexRequirement.to) || !marketIndex)) throw new DecisionDataRequired("KOSPI 지수 이력이 부족합니다", need);
  let resolution: Awaited<ReturnType<typeof runtime.resolver.resolveOrDescribeNeeds>>;
  try {
    const excludedSymbols = new Set<string>();
    for (;;) {
      resolution = await runtime.resolver.resolveOrDescribeNeeds(deployment.universeRule, period, { excludedSymbols });
      if (resolution.kind !== "READY") break;
      const gaps = resolution.dataExclusions.filter(gap => gap.category !== "DART_CORPORATE_ACTION");
      if (gaps.some(gap => held.includes(gap.symbol))) break;
      const newlyExcluded = gaps.filter(gap => !excludedSymbols.has(gap.symbol));
      if (!newlyExcluded.length) break;
      for (const gap of newlyExcluded) excludedSymbols.add(gap.symbol);
    }
  }
  catch (error) {
    if (error instanceof AgentDataRequired) {
      if (error.request.kind === "MARKET") need.masterDates = [...new Set([...need.masterDates, ...error.request.dates])].sort();
      throw new DecisionDataRequired("유니버스 선정 데이터가 준비되지 않았습니다", need);
    }
    throw error;
  }
  if (resolution.kind !== "READY") {
    const resolutionNeeds = resolution.needs;
    const needFrom = resolutionNeeds.priceRange && resolutionNeeds.priceRange.from < fromDate ? resolutionNeeds.priceRange.from : fromDate;
    const resolverFinancialYears = derivePreparationFactYearRange({ from: needFrom, to: message.date }, lookback);
    const resolverActionFromYear = Number(addCalendarDays(needFrom, -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays).slice(0, 4));
    need = { ...need,
      masterDates: [...new Set([...need.masterDates, ...resolutionNeeds.selectionMetricDates])].sort(),
      priceRange: resolutionNeeds.priceRange ? { from: resolutionNeeds.priceRange.from < fromDate ? resolutionNeeds.priceRange.from : fromDate, to: resolutionNeeds.priceRange.to > message.date ? resolutionNeeds.priceRange.to : message.date } : need.priceRange,
      financial: need.financial || resolutionNeeds.factSymbols.length ? { symbols: [...new Set([...held, ...resolutionNeeds.factSymbols])].sort(), ...resolverFinancialYears } : null,
      actions: { symbols: [...new Set([...held, ...resolutionNeeds.actionSymbols])].sort(), fromYear: resolverActionFromYear, toYear: actionToYear },
      entries: [...resolution.unionEntries.values()],
    };
    throw new DecisionDataRequired("유니버스 선정 데이터가 준비되지 않았습니다", need);
  }
  const otherExclusions = resolution.dataExclusions.filter(gap => gap.category !== "DART_CORPORATE_ACTION");
  if (otherExclusions.length) {
    const repairs: NonNullable<TradingDataNeed["repairs"]> = [];
    for (const gap of otherExclusions) {
      if (gap.category !== "DART_FINANCIAL") continue;
      for (const year of new Set(gap.periodKey.match(/(?:19|20)\d{2}/g) ?? [])) repairs.push({ kind: "FINANCIAL", symbol: gap.symbol, year: Number(year) });
    }
    const details = otherExclusions.slice(0, 5).map((gap) => `${gap.symbol} ${gap.periodKey}: ${gap.reason}`).join("; ");
    if (repairs.length) throw new DecisionDataRequired(`유니버스 입력 결손을 복구합니다: ${details}`, { masterDates: [], priceRange: null, financial: null, actions: null, entries: [...resolution.unionEntries.values()], repairs });
    throw new Error(`유니버스 입력에 확인되지 않은 데이터 결손이 있습니다: ${details}`);
  }
  const latestSchedule = resolution.schedule.at(-1);
  if (!latestSchedule || latestSchedule.members.length > 200) throw new Error("유니버스 선정 결과가 비었거나 한도를 초과합니다");
  const members = checkpoint && checkpoint.rebalanceDate === latestSchedule.rebalanceDate ? checkpoint.members : latestSchedule.members;
  if (!Array.isArray(members) || members.length > 200) throw new Error("저장된 유니버스 상태가 올바르지 않습니다");
  const included = checkpoint
    ? resolution.schedule.filter((entry, i, schedule) =>
      i === schedule.length - 1 || schedule[i + 1]!.fromTsMs > checkpoint.lastBar)
    : [latestSchedule];
  const symbols = [...new Set([...members.map(member => member.symbol), ...held,
    ...included.flatMap(entry => entry.members.map(member => member.symbol))])].sort();
  const retired = new Map<string, number>();
  for (const event of runtime.symbolMaster?.delistedEventsBetween?.(period.from, message.date) ?? []) {
    if (retired.has(event.shortCode)) continue;
    if (held.includes(event.shortCode)) throw new Error(`보유 종목 ${event.shortCode}의 상장폐지(${event.effectiveDate})가 확인됐습니다. 최종 정산 수량과 대금을 대조해야 합니다.`);
    retired.set(event.shortCode, Date.parse(`${event.effectiveDate}T00:00:00Z`));
  }
  const previousSymbols = new Set(checkpoint?.tracked ?? checkpoint?.members.map(member => member.symbol));
  const swing = ["range-breakout", "ema-trend-switch", "rsi-reversion"].includes(strategy.id);
  const entrants = new Set(checkpoint && swing ? symbols.filter(symbol => !previousSymbols.has(symbol)) : []);
  const actions = (await runtime.facts.getFacts({ scope: "SYMBOL", keys: symbols, fields: [CORPORATE_ACTION_FIELD] })).filter(fact => fact.field === CORPORATE_ACTION_FIELD);
  const range = corporateActionRawDateRange(actions);
  const changes = range ? runtime.symbolMaster.sharesChangesBetween(addCalendarDays(range.from, -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays), addCalendarDays(range.to, CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays), symbols) : [];
  const aligned = alignCorporateActionEffectiveDates(actions, changes);
  const gapFrom = kstDateOf(Math.min(originBar, ...held.map(symbol => portfolio[symbol]!.enteredAtMs)));
  const resolutionGaps = resolution.corporateActionExclusions;
  // 주문일에 새로 확인한 변경은 전일 종가 신호의 입력과 분리한다.
  function periodsFor(from: string, to: string) {
    const verified = runtime.symbolMaster?.coverageRanges?.() ?? runtime.symbolMaster?.isRangeCovered?.(from, to) ?? false;
    const rows = runtime.symbolMaster?.sharesChangesBetween?.(from, to, symbols) ?? [];
    return corporateActionGapPeriods(runtime.actionCoverage, symbols, aligned.unaligned, rows, verified, { from, to }, resolutionGaps);
  }
  const periods = periodsFor(gapFrom, message.date);
  const nextOpenPeriods: ActionGapPeriods = executionDate > message.date ? periodsFor(addCalendarDays(message.date, 1), executionDate) : new Map();
  const executionTs = Date.parse(executionDate);
  const changedPriceHistory = new Set<string>();
  if (checkpoint && swing) {
    for (const symbol of symbols) {
      const cutoff = latestActionGap(periods.get(symbol) ?? [], checkpoint.lastBar)?.to ?? -Infinity;
      if (!held.includes(symbol) && cutoff !== (checkpoint.actionCutoffs?.[symbol] ?? -Infinity)) {
        changedPriceHistory.add(symbol);
        entrants.add(symbol);
      }
    }
  }
  const candles = await runtime.candles.getCandlesArray({ market: "KR", timeframe: "1d", symbols, fromTsMs: from, toTsMs: latest });
  const histories = new Map<string, Candle[]>(symbols.map(symbol => [symbol, []]));
  function addHistory(batch: readonly Candle[]) {
    for (const bar of batch) {
      if (bar.tsMs >= originBar && bar.tsMs < (retired.get(bar.symbol) ?? Infinity)) histories.get(bar.symbol)?.push(bar);
    }
  }
  addHistory(candles);
  if (originBar < from) {
    // 장기 정지 후 거래 재개·신규 편입 종목만 최초 준비 경계까지 거슬러 올라간다.
    const older = symbols.filter(symbol => entrants.has(symbol) || histories.get(symbol)!.length < minimumBars);
    if (older.length) {
      fromDate = kstDateOf(originBar);
      actionFromYear = Number(addCalendarDays(fromDate, -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays).slice(0, 4));
      addHistory(await runtime.candles.getCandlesArray({ market: "KR", timeframe: "1d", symbols: older, fromTsMs: originBar, toTsMs: from - 1 }));
    }
  }
  need = { ...need, priceRange: { from: fromDate, to: message.date }, financial: needsFinancial ? { symbols, ...financialYears } : null, actions: { symbols, fromYear: actionFromYear, toYear: actionToYear }, entries: [...resolution.unionEntries.values()] };
  const priceNeed: TradingDataNeed = { masterDates: [], priceRange: need.priceRange, actions: null, financial: null, entries: [] };
  const nonTrading = new Map<string, Map<number, number>>();
  for (const row of runtime.symbolMaster?.nonTradingDaysBetween?.(fromDate, message.date, symbols) ?? []) {
    const dates = nonTrading.get(row.shortCode) ?? new Map<number, number>();
    dates.set(Date.parse(`${row.date}T00:00:00Z`), row.lastClose);
    nonTrading.set(row.shortCode, dates);
  }
  for (const symbol of symbols) {
    const history = histories.get(symbol)!;
    history.sort((a, b) => a.tsMs - b.tsMs);
    const listed = resolution.unionEntries.get(symbol)?.listedDate;
    const recentListing = listed && listed >= fromDate && listed <= message.date;
    const paused = nonTrading.get(symbol);
    const observed = new Set(history.map(bar => bar.tsMs));
    const retiredAt = retired.get(symbol) ?? Infinity;
    if (retiredAt > latest && !observed.has(latest) && !paused?.has(latest)) {
      throw new DecisionDataRequired(`확정 일봉이 누락되었습니다: ${symbol} ${message.date}`, priceNeed);
    }
    const window = checkpoint ? history.slice(-warmup) : history.filter(bar => bar.tsMs >= originBar);
    const windowStart = window[0] ? kstDateOf(window[0].tsMs) : message.date;
    // 상장 첫날이나 최근 준비 구간의 중간이 비었으면 실제 결손을 복구한다.
    let checkFrom = history.length < minimumBars ? (recentListing ? listed : kstDateOf(Math.max(from, originBar))) : windowStart;
    if (checkpoint) {
      const resumed = addCalendarDays(kstDateOf(checkpoint.lastBar), 1);
      if (resumed < checkFrom) checkFrom = resumed;
    }
    if (!checkpoint || entrants.has(symbol)) checkFrom = kstDateOf(originBar);
    if (listed && listed > checkFrom) checkFrom = listed;
    for (let day = checkFrom; day <= message.date; day = addCalendarDays(day, 1)) {
      const state = calendar.classify(day, resolution.unionEntries.get(symbol)?.market ?? "KOSPI").state;
      if (state === "UNKNOWN") throw new Error(`준비 구간의 공식 거래일이 확인되지 않았습니다: ${day}`);
      const ts = Date.parse(`${day}T00:00:00Z`);
      if (state === "OPEN" && ts < retiredAt && !observed.has(ts) && !paused?.has(ts)) {
        throw new DecisionDataRequired(`준비 구간의 종목 거래 봉이 누락되었습니다: ${symbol} ${day}`, priceNeed);
      }
    }
    if (retiredAt > latest && history.length < minimumBars && !recentListing && !paused?.size && !checkpoint) {
      throw new DecisionDataRequired(`준비 이력이 부족합니다: ${symbol} (확보 ${history.length}개, 필요 ${minimumBars}개)`, priceNeed);
    }
    if (!checkpoint) histories.set(symbol, window);
  }
  const firstYear = actionFromYear, lastYear = actionToYear;
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
  const actionCoverage = runtime.actionCoverage.getCoveredYears(symbols);
  const repairs: NonNullable<TradingDataNeed["repairs"]> = [];
  for (const symbol of held) {
    const entered = portfolio[symbol]!.enteredAtMs;
    for (const source of [periods, nextOpenPeriods]) {
      for (const gap of source.get(symbol) ?? []) {
        if (gap.from <= executionTs && gap.to >= entered && !repairs.some(repair => repair.symbol === symbol && repair.year === gap.year)) {
          repairs.push({ kind: "CORPORATE_ACTION", symbol, year: gap.year });
        }
      }
    }
  }
  for (const symbol of held) {
    const firstHeldYear = Number(addCalendarDays(kstDateOf(portfolio[symbol]!.enteredAtMs), -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays).slice(0, 4));
    for (let year = firstHeldYear; year < firstYear; year++) {
      if (!actionCoverage.get(symbol)?.includes(year) && !repairs.some(repair => repair.symbol === symbol && repair.year === year)) {
        repairs.push({ kind: "CORPORATE_ACTION", symbol, year });
      }
    }
  }
  if (strategy.requiresFundamentals || (strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0) > 0) {
    const coverage = runtime.factCoverage.getCoverageState(symbols);
    const financialRequiredYears = Array.from({ length: financialYears.toYear - financialYears.fromYear + 1 }, (_, i) => financialYears.fromYear + i);
    for (const symbol of symbols) {
      const info = coverage.get(symbol);
      for (const year of financialRequiredYears) {
        if (!info?.blockingGapYears.includes(year)) continue;
        const details = (info.blockingGapDetails ?? []).filter(detail => detail.year === year);
        if (!details.length || blockingFinancialGapExamples(details, { fields: strategy.dataRequirements?.fundamentalFields,
          fromYear: year, toYear: year, asOfMaxTsMs: latest }).length) repairs.push({ kind: "FINANCIAL", symbol, year });
      }
    }
  }
  if (repairs.length) {
    const details = repairs.slice(0, 10).map((repair) => `${repair.symbol} ${repair.year}년 ${repair.kind === "CORPORATE_ACTION" ? "자본변동" : "재무"}`).join(", ");
    const cause = repairs.some(repair => repair.kind === "CORPORATE_ACTION") ? "보유 종목의 자본변동 수량·정산을 확인해야 합니다" : "재무 이력에 결손이 있습니다";
    throw new DecisionDataRequired(`${cause}: ${details}`, { masterDates: [], priceRange: null, financial: null, actions: null, entries: need.entries, repairs });
  }
  for (const symbol of symbols) if (years.some((year) => !actionCoverage.get(symbol)?.includes(year))) throw new DecisionDataRequired(`자본변동 이력이 준비되지 않았습니다: ${symbol}`, need);
  if (strategy.requiresFundamentals || (strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0) > 0) {
    const coverage = runtime.factCoverage.getCoverageState(symbols);
    for (const symbol of symbols) for (let year = financialYears.fromYear; year <= financialYears.toYear; year++) {
      if (!coverage.get(symbol)?.verifiedYears.includes(year)) throw new DecisionDataRequired(`재무 이력이 준비되지 않았습니다: ${symbol}`, need);
    }
  }
  const facts = needsFinancial ? await runtime.facts.getFacts({ scope: "SYMBOL", keys: symbols, asOfMaxTsMs: latest }) : [];
  const factsView = new PitFactView([...facts.filter((fact) => fact.field !== CORPORATE_ACTION_FIELD), ...aligned.matchedFacts]);
  const rawRng = createRng(deployment.randomSeed); let calls = 0;
  for (; calls < (checkpoint?.rngCalls ?? 0); calls++) rawRng();
  const rng = () => { calls++; return rawRng(); };
  const state = checkpoint?.state ?? strategy.initialize({ symbols, initialCash: deployment.budgetKrw, rng });
  const positions = new Map<string, Position>();
  for (const [symbol, position] of Object.entries(portfolio)) positions.set(symbol, { symbol, quantity: position.quantity, avgEntryPrice: position.cost / position.quantity, entryCosts: 0, entryTsMs: position.enteredAtMs });
  const timeline = [...new Set([...histories.values()].flatMap((history) => history.map((bar) => bar.tsMs)))].sort((a, b) => a - b);
  const barsBySymbol = new Map(symbols.map((symbol) => [symbol, new Map(histories.get(symbol)!.map((bar) => [bar.tsMs, bar]))]));
  const first = checkpoint?.lastBar ?? -Infinity;
  const gate = new ActionGapEntryGate(periods, minimumBars);
  const barsAt = (ts: number) => {
    const result = new Map<string, Candle>();
    for (const symbol of symbols) {
      const bar = barsBySymbol.get(symbol)!.get(ts);
      if (bar) result.set(symbol, bar);
    }
    return result;
  };
  if (checkpoint && (periods.size || changedPriceHistory.size)) {
    for (const ts of timeline) {
      if (ts > first) break;
      gate.advance(ts, barsAt(ts));
    }
    if (!timeline.includes(first)) gate.advance(first, new Map());
    // 과거 공시가 정정되면 변경된 미보유 종목만 최초 준비 경계부터 다시 계산한다.
    for (const symbol of changedPriceHistory) resetUnheldPriceState(state, symbol);
  }
  if (checkpoint && entrants.size) {
    const bootstrap = new Map<string, Candle[]>();
    for (const symbol of entrants) {
      const prior = histories.get(symbol)!.filter(bar => bar.tsMs >= originBar && bar.tsMs > gate.priceCutoff(symbol) && bar.tsMs <= checkpoint.lastBar);
      if (prior.length) bootstrap.set(symbol, prior);
    }
    bootstrapTradingSymbolHistory({ strategy, state, parameters, initialCash: deployment.budgetKrw, beforeTsMs: checkpoint.lastBar + 1,
      histories: bootstrap, cleanAfter: symbol => gate.priceCutoff(symbol), lastSeen: checkpoint.lastSeen, actions: new Map([...bootstrap.keys()].map(symbol =>
        [symbol, factsView.corporateActions(symbol, checkpoint.lastBar).filter(action => action.effectiveTsMs >= originBar && action.effectiveTsMs > gate.priceCutoff(symbol))])) });
  }
  const timelineToRun = timeline.filter((ts) => ts > first && ts <= latest);
  const priorityCalls = checkpoint?.priorityCalls ?? 0;
  if (!Number.isSafeInteger(priorityCalls) || priorityCalls < 0 || priorityCalls > 10_000_000) throw new Error("저장된 매수 우선순위 상태가 올바르지 않습니다");
  const priorityRng = createRng(deployment.randomSeed ^ BUY_PRIORITY_SEED_SALT);
  let priorityCount = 0;
  for (; priorityCount < priorityCalls; priorityCount++) priorityRng();
  const nextPriority = () => { priorityCount++; return priorityRng(); };
  const counts = new Map<string, number>();
  const lastCloses = new Map<string, number>();
  for (const [symbol, history] of histories) {
    const prior = history.filter(bar => bar.tsMs <= first);
    counts.set(symbol, prior.length);
    if (prior.length) lastCloses.set(symbol, prior.at(-1)!.close);
  }
  // 중단 중 이미 지나간 시가에 속한 주문은 재활성화 시 소급 집행하지 않는다.
  const continueOrders = !warmupOnly && !timelineToRun.some(ts => ts < latest);
  let pendingExits = new Set(continueOrders ? checkpoint?.pendingExits : []);
  let deferredBuys = (continueOrders && checkpoint?.deferredBuys) || [];
  let pendingSells = (continueOrders && checkpoint?.pendingSells) || [];
  let venues: Record<string, "KOSPI" | "KOSDAQ"> = {};
  const lastSeen = { ...checkpoint?.lastSeen };
  let priorVolumes: Record<string, number> = {};
  let activeRebalanceDate = checkpoint?.rebalanceDate;
  let firstDecision = checkpoint?.firstDecision ?? true;
  let orders: Output["orders"] = [];
  let previousTs = checkpoint?.lastBar ?? -Infinity;
  for (const ts of timelineToRun) {
    const isLast = ts === latest;
    const activePositions = checkpoint ? positions : new Map<string, Position>();
    const bars = barsAt(ts);
    gate.advance(ts, bars, symbol => {
      if (!activePositions.has(symbol)) resetUnheldPriceState(state, symbol);
    });
    for (const [symbol, bar] of bars) {
      lastSeen[symbol] = ts;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      lastCloses.set(symbol, bar.close);
    }
    factsView.advanceTo(ts);
    for (const symbol of symbols) {
      const todayActions = factsView.corporateActions(symbol, ts).filter((action) => action.effectiveTsMs > previousTs);
      const ratio = todayActions.reduce((value, action) => value * action.ratio, 1);
      if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`자본변동 비율이 올바르지 않습니다: ${symbol}`);
      if (ratio !== 1) {
        const holding = portfolio[symbol];
        if (holding && holding.enteredAtMs < ts) throw new Error(`보유 종목 ${symbol}에 자본변동이 있습니다. 변경 수량과 단주 정산 대금을 대조해야 합니다.`);
        deferredBuys = adjustDailyOrderUnits(deferredBuys, symbol, ratio);
        strategy.onCorporateAction?.(symbol, ratio, state);
      }
    }
    previousTs = ts;
    const interrupted = warmupOnly || !checkpoint || !isLast;
    const schedule = resolution.schedule.findLast(item => (item.fromTsMs ?? Date.parse(`${item.rebalanceDate}T00:00:00Z`)) <= ts) ?? resolution.schedule[0]!;
    const currentMembers = schedule.rebalanceDate === checkpoint?.rebalanceDate ? checkpoint.members : schedule.members;
    const targets = new Set(currentMembers.map(member => member.symbol).filter(symbol => ts < (retired.get(symbol) ?? Infinity)));
    const tradable = new Set([...targets].filter(symbol => bars.has(symbol) && !nonTrading.get(symbol)?.has(ts)));
    const metrics = new Map(currentMembers.map(member => [member.symbol, member]));
    const rebalance = !interrupted && (firstDecision || schedule.rebalanceDate !== activeRebalanceDate);
    const cash = checkpoint ? message.input.cashKrw : deployment.budgetKrw;
    const equity = markedEquity(cash, activePositions, symbol => {
      const price = lastCloses.get(symbol) ?? nonTrading.get(symbol)?.get(ts);
      if (!(price && price > 0)) throw new DecisionDataRequired(`보유 종목의 평가 가격이 누락되었습니다: ${symbol}`, priceNeed);
      return price;
    });
    if (interrupted) {
      bundle.reconcileState(strategy.id, state, { interrupted: true, positions: [...activePositions.keys()], symbols });
    } else if (state && Array.isArray(state.symbols)) {
      // 정상 거래일에는 직전 신호의 대기 상태를 전략이 실제 포지션으로 판정한다.
      state.symbols = [...new Set([...state.symbols, ...symbols])].sort();
    }
    const ctx: StrategyBarContext = {
      tsMs: ts, isRebalanceBar: rebalance, bars, rng,
      getMarketIndexHistory: () => (marketIndex ?? []).filter(point => point.tsMs <= ts),
      getHistory: symbol => (histories.get(symbol) ?? []).filter(bar => bar.tsMs <= ts),
      portfolio: { cash, equity, positions: activePositions },
      fundamentals: symbol => factsView.fundamentals(symbol),
      corporateActions: symbol => factsView.corporateActions(symbol, ts),
      tradableSymbols: tradable, activeUniverseSymbols: targets,
      selectionMetric: symbol => metrics.get(symbol) ?? null,
    };
    if (!interrupted) for (const symbol of pendingExits) {
      if (!positions.has(symbol)) strategy.onForcedExit?.(symbol, state);
    }
    const decision = evaluateDailyBar(strategy, state, parameters, ctx, minimumBars, counts, interrupted, gate);
    if (!interrupted) {
      const exits = membershipExits(positions, targets);
      const newExit = exits.some(exit => !pendingExits.has(exit.symbol));
      pendingExits = new Set(exits.map(exit => exit.symbol));
      const prioritized = prioritizeDailyOrders(decision.orders.filter(order => !pendingExits.has(order.symbol)), nextPriority);
      const currentBuys = prioritized.filter(order => order.side === "BUY");
      const currentBuySymbols = new Set(currentBuys.map(order => order.symbol));
      deferredBuys = eligibleDailyOrders(deferredBuys, gate.atClose).filter(order => tradable.has(order.symbol) && !currentBuySymbols.has(order.symbol));
      if (newExit) {
        deferredBuys = [...deferredBuys, ...currentBuys];
        orders = [...exits, ...prioritized.filter(order => order.side === "SELL")];
      } else {
        orders = [...exits, ...deferredBuys, ...prioritized];
        deferredBuys = [];
      }
      // 이전 청산이 수량·유동성 상한으로 부분 체결됐으면 실제 잔고에서 남은 목표 수량만 재주문한다.
      const bySymbol = new Map(orders.map(order => [order.symbol, order]));
      for (const pending of pendingSells) {
        if (pending.reason === "REBALANCE_EXIT" && targets.has(pending.symbol)) continue;
        const remaining = (positions.get(pending.symbol)?.quantity ?? 0) - pending.target;
        const current = bySymbol.get(pending.symbol);
        if (remaining > 0 && (!current || current.side === "BUY" || current.quantity < remaining))
          bySymbol.set(pending.symbol, { symbol: pending.symbol, side: "SELL", reason: pending.reason, quantity: remaining });
      }
      orders = [...bySymbol.values()];
      pendingSells = orders.filter(order => order.side === "SELL").map(order => ({ symbol: order.symbol, reason: order.reason,
        target: Math.max(0, (positions.get(order.symbol)?.quantity ?? 0) - order.quantity) }));
      venues = {};
      for (const order of orders) {
        const venue = bars.get(order.symbol)?.venue ?? resolution.unionEntries.get(order.symbol)?.market;
        if (venue) venues[order.symbol] = venue;
      }
      priorVolumes = Object.fromEntries(orders.map(order => [order.symbol, bars.get(order.symbol)?.volume ?? 0]));
      activeRebalanceDate = schedule.rebalanceDate;
      firstDecision = false;
    } else {
      bundle.reconcileState(strategy.id, state, { interrupted: true, positions: [...activePositions.keys()], symbols });
    }
  }
  if (warmupOnly || (!checkpoint && held.length)) bundle.reconcileState(strategy.id, state, { interrupted: true, positions: held, symbols });
  if (latest > first && !timeline.includes(latest)) gate.advance(latest, new Map(), symbol => {
    if (!positions.has(symbol)) resetUnheldPriceState(state, symbol);
  });
  const blockedAtOpen = new Set([...nextOpenPeriods.keys()].filter(symbol => holdingActionGap(nextOpenPeriods, symbol, latest + 1, executionTs)));
  orders = eligibleDailyOrders(orders, blockedAtOpen);
  deferredBuys = eligibleDailyOrders(deferredBuys, new Set([...blockedAtOpen, ...gate.atClose]));
  if (executionTs > latest) {
    for (const symbol of new Set([...held, ...orders.map(order => order.symbol)])) {
      const due = factsView.corporateActions(symbol, executionTs).filter(action => action.effectiveTsMs > latest);
      if (!due.length) continue;
      if (portfolio[symbol] && due.some(action => portfolio[symbol]!.enteredAtMs < action.effectiveTsMs)) {
        throw new Error(`보유 종목 ${symbol}에 자본변동이 있습니다. 변경 수량과 단주 정산 대금을 대조해야 합니다.`);
      }
      const ratio = due.reduce((value, action) => value * action.ratio, 1);
      orders = adjustDailyOrderUnits(orders, symbol, ratio);
      if (priorVolumes[symbol] !== undefined) priorVolumes[symbol] *= ratio;
    }
  }
  const actionCutoffs = Object.fromEntries(symbols.filter(symbol => Number.isFinite(gate.priceCutoff(symbol))).map(symbol => [symbol, gate.priceCutoff(symbol)]));
  const actionGapHolds = members.map(member => member.symbol).filter(symbol => gate.atClose.has(symbol) || blockedAtOpen.has(symbol)).sort();
  const next: Checkpoint = { abi: 1, hash: deployment.artifactHash, strategyId: strategy.id, state, actionCutoffs, lastBar: latest, rngCalls: calls, priorityCalls: priorityCount, pendingExits: [...pendingExits], deferredBuys, originBar, lastSeen, tracked: symbols, pendingSells, firstDecision: firstDecision || activeRebalanceDate !== latestSchedule.rebalanceDate, rebalanceDate: latestSchedule.rebalanceDate, members: [...members] };
  const entryHolds = members.flatMap(({ symbol }) => {
    const bars = counts.get(symbol) ?? 0;
    return bars < minimumBars && !retired.has(symbol) ? [{ symbol, bars, requiredBars: minimumBars }] : [];
  });
  return { checkpoint: serialize(next).toString("base64"), barTsMs: latest, orders, priorVolumes, venues, entryHolds, actionGapHolds };
}

const isChildEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isChildEntry) process.on("disconnect", () => process.exit(1));
if (isChildEntry) process.once("message", async (message: { input: Input; date: string; executionDate?: string; bundlePath: string }) => {
  let sqlite: Database.Database | undefined;
  try {
    const { deployment } = message.input;
    if (!/^[a-f0-9]{64}$/.test(deployment.artifactHash)) throw new Error("전략 해시가 올바르지 않습니다");
    if (createHash("sha256").update(readFileSync(message.bundlePath)).digest("hex") !== deployment.artifactHash) throw new Error("전략 번들의 해시가 일치하지 않습니다");
    const bundle = await import(pathToFileURL(message.bundlePath).href) as Bundle;
    if (bundle.lifecycleAbi !== 1 || typeof bundle.reconcileState !== "function" || bundle.formatVersion !== 1 || bundle.nodeMajor !== 24 || Number(process.versions.node.split(".")[0]) !== 24 || typeof bundle.getStrategy !== "function") throw new Error("전략 실행 버전이 호환되지 않습니다");
    const dataPath = process.env.DATA_DATABASE_PATH, databasePath = process.env.DATABASE_PATH;
    if (!dataPath || !databasePath || !statSync(dataPath).isFile()) throw new Error("전략 계산 DB가 없습니다");
    sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
    sqlite.pragma("query_only = ON"); sqlite.pragma("busy_timeout = 1000"); sqlite.prepare("ATTACH DATABASE ? AS data").run(dataPath); sqlite.exec("BEGIN");
    const database: DatabaseHandle = { sqlite, dataPath, db: drizzle(sqlite, { schema }), close: () => sqlite!.close() };
    const output = await calculate(message, database, bundle);
    sqlite.exec("ROLLBACK"); sqlite.close(); sqlite = undefined;
    process.send?.({ type: "completed", output }, () => process.exit(0));
  } catch (error) {
    sqlite?.close(); process.send?.({ type: error instanceof DecisionDataRequired ? "needs-data" : "failed", ...(error instanceof DecisionDataRequired ? { need: error.need } : {}), error: error instanceof Error ? error.message : "전략 판단에 실패했습니다" }, () => process.exit(0));
  }
});
