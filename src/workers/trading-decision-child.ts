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
interface Checkpoint { abi: 1; hash: string; strategyId: string; state: unknown; lastBar: number; rngCalls: number; firstDecision: boolean; rebalanceDate: string; members: Array<{ symbol: string; marketCapKrw: string | null; volume: number | null; tradingValueKrw: string | null }>; }
class DecisionDataRequired extends Error { constructor(message: string, readonly need: TradingDataNeed) { super(message); } }
interface Bundle { formatVersion: number; nodeMajor: number; lifecycleAbi: number; getStrategy(id: string): AnyTradingStrategy | null; reconcileState(id: string, state: unknown, input: { interrupted: boolean; positions: readonly string[]; symbols: readonly string[] }): void; }

export async function calculate(message: { input: Input; date: string; bundlePath: string }, database: DatabaseHandle, bundle: Bundle, testRuntime?: ReturnType<typeof createUniverseRuntime>): Promise<Output> {
  const { deployment, portfolio, warmupOnly } = message.input;
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
    if (!warmupOnly) return { checkpoint: message.input.checkpoint!, barTsMs: latest, orders: [] };
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
  const warmup = Math.max(1, strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 1, strategy.historyLookbackBars?.(parameters) ?? 1);
  if (!Number.isSafeInteger(warmup) || warmup > 3000) throw new Error("전략 준비 봉 수가 올바르지 않습니다");
  const warmupFrom = Date.parse(`${addCalendarDays(message.date, -(warmup * 3 + 30))}T00:00:00Z`);
  if (checkpoint && (checkpoint.lastBar % 86_400_000 !== 0 || latest - checkpoint.lastBar > 5 * 366 * 86_400_000)) throw new Error("전략 중단 기간이 너무 길거나 저장 시각이 올바르지 않아 안전하게 재생할 수 없습니다");
  const from = checkpoint ? Math.min(warmupFrom, checkpoint.lastBar) : warmupFrom;
  const fromDate = new Date(from).toISOString().slice(0, 10);
  const actionFromYear = Number(addCalendarDays(fromDate, -CORPORATE_ACTION_ALIGNMENT_WINDOW.afterDays).slice(0, 4));
  const actionToYear = Number(addCalendarDays(message.date, CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays).slice(0, 4));
  const lookback = Math.max(strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0, deployment.universeRule.stages.some((stage) => stage.criterion === "PER" || stage.criterion === "ROE") ? 4 : 0);
  const financialYears = derivePreparationFactYearRange({ from: fromDate, to: message.date }, lookback);
  const needsFinancial = strategy.requiresFundamentals === true || lookback > 0;
  let need: TradingDataNeed = { masterDates: computeRebalanceDates(period, deployment.universeRule.rebalanceInterval), priceRange: { from: fromDate, to: message.date }, financial: needsFinancial ? { symbols: [...held], ...financialYears } : null, actions: { symbols: [...held], fromYear: actionFromYear, toYear: actionToYear }, entries: [], ...(indexRequirement ? { marketIndex: indexRequirement } : {}) };
  const runtime = testRuntime ?? createUniverseRuntime(database, readRuntimeVersions().collectionVersion);
  const marketIndex = indexRequirement ? readMarketIndex(database.db, indexRequirement) : undefined;
  if (indexRequirement && (!runtime.symbolMaster.isRangeCovered(indexRequirement.from, indexRequirement.to) || !marketIndex)) throw new DecisionDataRequired("KOSPI 지수 이력이 부족합니다", need);
  let resolution: Awaited<ReturnType<typeof runtime.resolver.resolveOrDescribeNeeds>>;
  try { resolution = await runtime.resolver.resolveOrDescribeNeeds(deployment.universeRule, period); }
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
  if (resolution.dataExclusions.length || resolution.corporateActionExclusions.length) {
    const repairs: NonNullable<TradingDataNeed["repairs"]> = resolution.corporateActionExclusions.map((gap) => ({ kind: "CORPORATE_ACTION", symbol: gap.symbol, year: gap.year }));
    for (const gap of resolution.dataExclusions) {
      if (gap.category !== "DART_FINANCIAL" && gap.category !== "DART_CORPORATE_ACTION") continue;
      for (const year of new Set(gap.periodKey.match(/(?:19|20)\d{2}/g) ?? [])) repairs.push({ kind: gap.category === "DART_FINANCIAL" ? "FINANCIAL" : "CORPORATE_ACTION", symbol: gap.symbol, year: Number(year) });
    }
    const details = resolution.dataExclusions.slice(0, 5).map((gap) => `${gap.symbol} ${gap.periodKey}: ${gap.reason}`).join("; ");
    if (repairs.length) throw new DecisionDataRequired(`유니버스 입력 결손을 복구합니다: ${details}`, { masterDates: [], priceRange: null, financial: null, actions: null, entries: [...resolution.unionEntries.values()], repairs });
    throw new Error(`유니버스 입력에 확인되지 않은 데이터 결손이 있습니다: ${details}`);
  }
  const latestSchedule = resolution.schedule.at(-1);
  if (!latestSchedule || latestSchedule.members.length === 0 || latestSchedule.members.length > 200) throw new Error("유니버스 선정 결과가 비었거나 한도를 초과합니다");
  const members = checkpoint && checkpoint.rebalanceDate === latestSchedule.rebalanceDate ? checkpoint.members : latestSchedule.members;
  if (!Array.isArray(members) || !members.length || members.length > 200) throw new Error("저장된 유니버스 상태가 올바르지 않습니다");
  const selected = members.map((member) => member.symbol);
  const symbols = [...new Set([...selected, ...held])].sort();
  need = { ...need, financial: needsFinancial ? { symbols, ...financialYears } : null, actions: { symbols, fromYear: actionFromYear, toYear: actionToYear }, entries: [...resolution.unionEntries.values()] };
  const candles = await runtime.candles.getCandlesArray({ market: "KR", timeframe: "1d", symbols, fromTsMs: from, toTsMs: latest });
  const calendar = createOfficialKrxTradingCalendar();
  const priceNeed: TradingDataNeed = { masterDates: [], priceRange: need.priceRange, actions: null, financial: null, entries: [] };
  const histories = new Map<string, Candle[]>();
  for (const symbol of symbols) histories.set(symbol, []);
  for (const bar of candles) histories.get(bar.symbol)?.push(bar);
  for (const symbol of symbols) {
    const history = histories.get(symbol)!; history.sort((a, b) => a.tsMs - b.tsMs);
    if (history.length < warmup) {
      const entry = resolution.unionEntries.get(symbol);
      const listed = entry?.listedDate;
      const first = history[0];
      if (entry && listed && listed >= fromDate && listed <= message.date &&
          (!first || first.tsMs >= Date.parse(`${listed}T00:00:00Z`))) {
        // 미확인 달력일도 개장 가능일로 세어 확보 가능한 봉 수를 과소평가하지 않는다.
        let possibleBars = 0;
        for (let day = listed; day <= message.date && possibleBars < warmup; day = addCalendarDays(day, 1)) {
          if (calendar.classify(day, entry.market).state !== "CLOSED") possibleBars++;
        }
        if (possibleBars < warmup && history.length <= possibleBars) {
          throw new Error(`${symbol} ${entry.name}의 상장일은 ${listed}입니다. ${message.date}까지 가능한 일봉은 최대 ${possibleBars}개로 전략 준비에 필요한 ${warmup}개에 미달합니다.`);
        }
      }
    }
    if (history.length < warmup || history.at(-1)?.tsMs !== latest) {
      throw new DecisionDataRequired(`확정 일봉 또는 준비 이력이 부족합니다: ${symbol} (확보 ${history.length}개, 필요 ${warmup}개, 기준일 ${message.date})`, priceNeed);
    }
    if (!checkpoint) histories.set(symbol, history.slice(-warmup));
  }
  if (!checkpoint) {
    for (const symbol of symbols) {
      const history = histories.get(symbol)!;
      const observed = new Set(history.map((bar) => bar.tsMs));
      const firstDay = new Date(history[0]!.tsMs).toISOString().slice(0, 10);
      for (let day = firstDay; day <= message.date; day = addCalendarDays(day, 1)) {
        const state = calendar.classify(day, "KOSPI").state;
        if (state === "UNKNOWN") throw new Error(`준비 구간의 공식 거래일이 확인되지 않았습니다: ${day}`);
        if (state === "OPEN" && !observed.has(Date.parse(`${day}T00:00:00Z`))) throw new DecisionDataRequired(`준비 구간의 종목 거래 봉이 누락되었습니다: ${symbol} ${day}`, priceNeed);
      }
    }
  }
  const firstYear = actionFromYear, lastYear = actionToYear;
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
  const actionCoverage = runtime.actionCoverage.getCoveredYears(symbols), actionGaps = runtime.actionCoverage.getGapYears(symbols);
  const repairs: NonNullable<TradingDataNeed["repairs"]> = [];
  for (const symbol of symbols) {
    for (const year of years) if (actionGaps.get(symbol)?.includes(year)) repairs.push({ kind: "CORPORATE_ACTION", symbol, year });
  }
  if (strategy.requiresFundamentals || (strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0) > 0) {
    const coverage = runtime.factCoverage.getCoverageState(symbols);
    const financialRequiredYears = Array.from({ length: financialYears.toYear - financialYears.fromYear + 1 }, (_, i) => financialYears.fromYear + i);
    for (const symbol of symbols) {
      for (const year of financialRequiredYears) if (coverage.get(symbol)?.blockingGapYears.includes(year)) repairs.push({ kind: "FINANCIAL", symbol, year });
    }
  }
  if (repairs.length) {
    const details = repairs.slice(0, 10).map((repair) => `${repair.symbol} ${repair.year}년 ${repair.kind === "CORPORATE_ACTION" ? "자본변동" : "재무"}`).join(", ");
    throw new DecisionDataRequired(`이력에 결손이 있습니다: ${details}`, { masterDates: [], priceRange: null, financial: null, actions: null, entries: need.entries, repairs });
  }
  for (const symbol of symbols) if (years.some((year) => !actionCoverage.get(symbol)?.includes(year))) throw new DecisionDataRequired(`자본변동 이력이 준비되지 않았습니다: ${symbol}`, need);
  if (strategy.requiresFundamentals || (strategy.dataRequirements?.fundamentalLookbackQuarters ?? 0) > 0) {
    const coverage = runtime.factCoverage.getCoverageState(symbols);
    for (const symbol of symbols) for (let year = financialYears.fromYear; year <= financialYears.toYear; year++) {
      if (!coverage.get(symbol)?.verifiedYears.includes(year)) throw new DecisionDataRequired(`재무 이력이 준비되지 않았습니다: ${symbol}`, need);
    }
  }
  const facts = await runtime.facts.getFacts({ scope: "SYMBOL", keys: symbols, asOfMaxTsMs: latest + 6.5 * 3_600_000 });
  const actions = facts.filter((fact) => fact.field === CORPORATE_ACTION_FIELD);
  const range = corporateActionRawDateRange(actions);
  const changes = range ? runtime.symbolMaster.sharesChangesBetween(addCalendarDays(range.from, -CORPORATE_ACTION_ALIGNMENT_WINDOW.beforeDays), message.date) : [];
  const aligned = alignCorporateActionEffectiveDates(actions, changes);
  if (aligned.unaligned.length) throw new Error("자본변동의 거래일 정렬을 확인할 수 없습니다");
  const factsView = new PitFactView([...facts.filter((fact) => fact.field !== CORPORATE_ACTION_FIELD), ...aligned.facts]);
  const rawRng = createRng(deployment.randomSeed); let calls = 0;
  for (; calls < (checkpoint?.rngCalls ?? 0); calls++) rawRng();
  const rng = () => { calls++; return rawRng(); };
  const state = checkpoint?.state ?? strategy.initialize({ symbols, initialCash: deployment.budgetKrw, rng });
  const positions = new Map<string, Position>();
  for (const [symbol, position] of Object.entries(portfolio)) positions.set(symbol, { symbol, quantity: position.quantity, avgEntryPrice: position.cost / position.quantity, entryCosts: 0, entryTsMs: position.enteredAtMs });
  const timeline = [...new Set([...histories.values()].flatMap((history) => history.map((bar) => bar.tsMs)))].sort((a, b) => a - b);
  const barsBySymbol = new Map(symbols.map((symbol) => [symbol, new Map(histories.get(symbol)!.map((bar) => [bar.tsMs, bar]))]));
  if (checkpoint) {
    const observed = new Set(timeline);
    const datesBySymbol = barsBySymbol;
    for (let day = addCalendarDays(new Date(checkpoint.lastBar).toISOString().slice(0, 10), 1); day <= message.date; day = addCalendarDays(day, 1)) {
      const state = calendar.classify(day, "KOSPI").state;
      if (state === "UNKNOWN") throw new Error(`중단 구간의 공식 거래일이 확인되지 않았습니다: ${day}`);
      if (state === "OPEN") {
        const dayTs = Date.parse(`${day}T00:00:00Z`);
        if (!observed.has(dayTs)) throw new DecisionDataRequired(`중단 구간의 거래 봉이 누락되었습니다: ${day}`, priceNeed);
        for (const symbol of symbols) if (!datesBySymbol.get(symbol)!.has(dayTs)) throw new DecisionDataRequired(`중단 구간의 종목 거래 봉이 누락되었습니다: ${symbol} ${day}`, priceNeed);
      }
    }
  }
  const first = checkpoint?.lastBar ?? -Infinity;
  const timelineToRun = timeline.filter((ts) => ts > first && ts <= latest);
  const targets = new Set(selected);
  const metrics = new Map(members.map((member) => [member.symbol, { marketCapKrw: member.marketCapKrw, volume: member.volume, tradingValueKrw: member.tradingValueKrw }]));
  let orders: Output["orders"] = [];
  let previousTs = checkpoint?.lastBar ?? -Infinity;
  for (const ts of timelineToRun) {
    const isLast = ts === latest; const activePositions = checkpoint ? positions : new Map<string, Position>();
    const bars = new Map<string, Candle>();
    for (const symbol of symbols) { const bar = barsBySymbol.get(symbol)!.get(ts); if (bar) bars.set(symbol, bar); }
    if (isLast && symbols.some((symbol) => !bars.has(symbol))) throw new DecisionDataRequired("최근 거래일의 확정 봉이 누락되었습니다", priceNeed);
    factsView.advanceTo(ts + 6.5 * 3_600_000);
    for (const symbol of symbols) {
      const todayActions = factsView.corporateActions(symbol, ts).filter((action) => action.effectiveTsMs > previousTs);
      for (const action of todayActions) {
        if (!Number.isFinite(action.ratio) || action.ratio <= 0) throw new Error(`자본변동 비율이 올바르지 않습니다: ${symbol}`);
        strategy.onCorporateAction?.(symbol, action.ratio, state);
      }
    }
    previousTs = ts;
    const marketValue = [...activePositions].reduce((sum, [symbol, pos]) => { const bar = bars.get(symbol); if (!bar) throw new DecisionDataRequired(`보유 종목의 봉이 누락되었습니다: ${symbol}`, priceNeed); return sum + pos.quantity * bar.close; }, 0);
    const interrupted = warmupOnly || !checkpoint || !isLast;
    bundle.reconcileState(strategy.id, state, { interrupted, positions: [...activePositions.keys()], symbols });
    const ctx: StrategyBarContext = { getMarketIndexHistory: () => (marketIndex ?? []).filter((point) => point.tsMs <= ts), tsMs: ts, isRebalanceBar: isLast && !warmupOnly && (checkpoint?.firstDecision === true || latestSchedule.rebalanceDate !== checkpoint?.rebalanceDate), bars, getHistory: (symbol) => (histories.get(symbol) ?? []).filter((bar) => bar.tsMs <= ts), portfolio: { cash: Math.max(0, deployment.budgetKrw - marketValue), equity: deployment.budgetKrw, positions: activePositions }, rng, fundamentals: (symbol) => factsView.fundamentals(symbol), corporateActions: (symbol) => factsView.corporateActions(symbol, ts), tradableSymbols: targets, activeUniverseSymbols: targets, selectionMetric: (symbol) => metrics.get(symbol) ?? null };
    const decision = strategy.onBars(ctx, state, parameters);
    if (isLast && !warmupOnly && checkpoint) orders = decision.orders;
    else bundle.reconcileState(strategy.id, state, { interrupted: true, positions: [...activePositions.keys()], symbols });
  }
  if (warmupOnly || (!checkpoint && held.length)) bundle.reconcileState(strategy.id, state, { interrupted: true, positions: held, symbols });
  const next: Checkpoint = { abi: 1, hash: deployment.artifactHash, strategyId: strategy.id, state, lastBar: latest, rngCalls: calls, firstDecision: warmupOnly, rebalanceDate: latestSchedule.rebalanceDate, members: [...members] };
  return { checkpoint: serialize(next).toString("base64"), barTsMs: latest, orders };
}

const isChildEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isChildEntry) process.on("disconnect", () => process.exit(1));
if (isChildEntry) process.once("message", async (message: { input: Input; date: string; bundlePath: string }) => {
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
