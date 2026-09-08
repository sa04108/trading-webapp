import { createQuarterlyValue, valuationSnapshot } from './quarterly-value.js';
import { createQuarterlyEarnings, hasEightQuarters, quarterlySnapshot } from './quarterly-earnings.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runBacktest, ENGINE_VERSION } from '../../src/server/modules/backtest/domain/engine.js';
import { getCostProfile, getKrxExecutionRules } from '../../src/server/modules/backtest/domain/cost-profiles.js';
import { StrategyRegistry } from '../../src/server/modules/strategy/application/strategy-registry.js';
import type { AnyTradingStrategy, StrategyBarContext } from '../../src/server/modules/strategy/domain/strategy.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';
import { momentumScore } from '../../src/server/modules/strategy/strategies/cross-sectional-momentum.js';
import { annualQuality, annualQualityParameters, createAnnualQualityMomentum } from './annual-quality-momentum.js';
import { createRecoveryRotation } from './recovery-rotation.js';
import type { Candidate, ResearchInput } from './quarter-engine.js';

const [inputPath, selectionPath, outputPath] = process.argv.slice(2);
if (!inputPath || !selectionPath || !outputPath) throw new Error('사용법: current-signals.ts input.gz selection.json output.json');
const bytes = readFileSync(inputPath);
const input = JSON.parse(gunzipSync(bytes).toString()) as ResearchInput & { currentSymbols: { symbol: string; name: string }[] };
if (!input.metadata.usage || !input.currentSymbols) throw new Error('현재 신호 전용으로 검증된 종목 입력이 필요합니다');
const candidates = JSON.parse(readFileSync(selectionPath, 'utf8')) as Candidate[];
const macro = new Map(input.macro.map((m) => [m.tsMs, m]));
const tsMs = Date.parse(input.asof);
const registry = new StrategyRegistry();
const signals: unknown[] = [];
let diagnostics: unknown[] = [];
const describe = (context: StrategyBarContext) => input.currentSymbols.map((symbol) => {
  const history = context.getHistory(symbol.symbol);
  const actions = context.corporateActions(symbol.symbol);
  const recent = history.slice(-21);
  const changes = recent.slice(1).map((c, i) => Math.log(c.close / recent[i]!.close));
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const quality = annualQuality((input.annualObservations ?? []).filter((r) => r.code === symbol.symbol), tsMs, annualQualityParameters.parse({}));
  const valuation = valuationSnapshot((input.valuationObservations ?? []).filter((r) => r.symbol === symbol.symbol), tsMs);
  return { ...symbol, valuation: valuation ? { netIncomeTtm: valuation.ttm('NET_INCOME'), totalEquity: valuation.get('TOTAL_EQUITY'), incomePeriod: valuation.periodKeyOf('NET_INCOME'), equityPeriod: valuation.periodKeyOf('TOTAL_EQUITY') } : null, close: history.at(-1)?.close, lastBarTsMs: history.at(-1)?.tsMs,
    return20: momentumScore(history, actions, 20, 0), return60: momentumScore(history, actions, 60, 0),
    return120: momentumScore(history, actions, 120, 0),
    annualVol20: Math.sqrt(changes.reduce((a, b) => a + (b - mean) ** 2, 0) / (changes.length - 1) * 252),
    adv20: recent.slice(-20).reduce((a, b) => a + b.close * b.volume, 0) / 20,
    sma20: recent.slice(-20).reduce((a, b) => a + b.close, 0) / 20, quality,
    quarterlyReady: hasEightQuarters(quarterlySnapshot((input.quarterlyObservations ?? []).filter((r) => r.symbol === symbol.symbol), tsMs), tsMs) };
});

for (const candidate of candidates) {
  const base = (candidate.strategyId === 'recovery-rotation' ? createRecoveryRotation(macro)
    : candidate.strategyId === 'annual-quality-momentum' ? createAnnualQualityMomentum(input.annualObservations ?? [], macro)
      : candidate.strategyId === 'quarterly-earnings-research' ? createQuarterlyEarnings(input.quarterlyObservations ?? [])
        : candidate.strategyId === 'low-per-quarterly-research' ? createQuarterlyValue(input.valuationObservations ?? [], input.capitalizations ?? [])
          : registry.get(candidate.strategyId)) as AnyTradingStrategy | undefined;
  if (!base) throw new Error(`전략 누락: ${candidate.strategyId}`);
  const parameters = base.parameterSchema.parse(candidate.parameters);
  const observer: AnyTradingStrategy = {
    ...base,
    onBars(context, state, p) {
      const decision = base.onBars(context, state, p);
      if (context.tsMs === tsMs) {
        const pending = state.pending ?? state.pendingTargets ?? state.momentum?.pendingTargets ?? null;
        signals.push({ candidate, parameters, ordersAtLatestClose: decision.orders, pendingTargets: pending,
          note: pending === null ? '전략이 낸 주문 의도이며 다음 거래일의 체결 순서·현금·최대 종목 수 제한으로 줄어들 수 있다' : '오늘은 목표 선정 단계이며 다음 종가에 자격·가격을 재확인한 후 매수를 예약한다' });
        if (diagnostics.length === 0) diagnostics = describe(context);
      }
      return decision;
    },
  };
  const result = runBacktest(observer, {
    candles: input.candles as Candle[], initialCash: 100_000_000, parameters, maxPositions: candidate.topN,
    randomSeed: 204, facts: input.facts, tradeFromTsMs: tsMs, resultPeriod: { fromTsMs: tsMs, toTsMs: tsMs },
    universeSchedule: [{ fromTsMs: tsMs, symbols: input.currentSymbols.map((s) => s.symbol) }],
    marketTradingTsMs: [tsMs],
    nonTradingSymbolsByTsMs: new Map(input.nontrading.map(([t, symbols]) => [t, new Set(symbols)])),
    nonTradingCoveredPeriod: { from: input.asof, to: input.asof },
    execution: { cost: getCostProfile('kr-equity-default')!,
      slippage: { id: 'quarter-research', version: '1', bps: 5, fixed: 0 },
      rules: { ...getKrxExecutionRules('KOSPI'), maxVolumeParticipationRate: .01 } },
  });
  if (result.fills.length > 0) throw new Error('현재 종가 다음의 체결이 만들어졌습니다');
}
const output = { asof: input.asof, inputSha256: createHash('sha256').update(bytes).digest('hex'),
  engineVersion: ENGINE_VERSION, initialCash: 100_000_000, signals, diagnostics,
  sources: input.metadata.currentSources,
  historyQuarantines: input.metadata.currentHistoryQuarantines ?? [],
  note: '연구 후보의 현재 신호이며 실전 채택이나 향후 수익 검증이 아니다. 미래 체결은 시뮬레이션하지 않았다.' };
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output: outputPath, candidates: signals.length, symbols: diagnostics.length })}\n`);
