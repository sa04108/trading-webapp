import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { buildCurrentSignals } from '../../scripts/quarter-research/current-signals.js';
import { runBacktest } from '../../src/server/modules/backtest/domain/engine.js';
import { getCostProfile, getKrxExecutionRules } from '../../src/server/modules/backtest/domain/cost-profiles.js';
import { rankRetentionMomentum } from '../../scripts/quarter-research/rank-retention-momentum.js';
import { withUncertainHistory } from '../../scripts/quarter-research/uncertain-history.js';
import { withQuarterRisk } from '../../scripts/quarter-research/quarter-engine.js';
import type { OrderIntent } from '../../src/server/modules/backtest/domain/types.js';
import type { Candidate, ResearchInput } from '../../scripts/quarter-research/quarter-engine.js';
import type { Candle } from '../../src/server/modules/market-data/domain/candle.js';

const start = Date.UTC(2026, 0, 1);
const symbols = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'];
const candidate: Candidate = { id: 'rank-retention-20', strategyId: 'rank-retention-momentum', topN: 5,
  rebalanceBars: 20, parameters: { formationDays: 20, skipDays: 0, topN: 5, retentionRank: 10 } };
const encode = (input: unknown) => gzipSync(JSON.stringify(input));

function fixture(): ResearchInput & { currentSymbols: { symbol: string; name: string }[] } {
  const days = Array.from({ length: 21 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
  const candles: Candle[] = days.flatMap((day, i) => symbols.map((symbol, j) => {
    const close = 10000 + i * (600 - j * 100);
    return { symbol, market: 'KR', timeframe: '1d', tsMs: Date.parse(day), open: close, high: close, low: close, close, volume: 1000000 };
  }));
  return { asof: days.at(-1)!, candles, days, macro: [], members: days.map(() => symbols), nontrading: [],
    metadata: { usage: '현재 신호 테스트 전용' }, currentSymbols: symbols.map((symbol) => ({ symbol, name: symbol })) };
}

describe('현재 분기 후보 신호', () => {
  it('새 후보를 직접 실행하고 현금 시작의 순위 선정 결과가 기존 모멘텀과 같다', () => {
    const bytes = encode(fixture());
    const native: Candidate = { ...candidate, id: 'native', strategyId: 'cross-sectional-momentum',
      parameters: { formationDays: 20, skipDays: 0, topN: 5 } };
    const result = buildCurrentSignals(bytes, [candidate, native]);
    expect(result.signals).toHaveLength(2);
    for (const signal of result.signals) {
      expect(signal).toMatchObject({ ordersAtLatestClose: [], pendingTargets: symbols.slice(0, 5) });
    }
    expect(result.signals[0]).toMatchObject({ candidate, parameters: { retentionRank: 10 } });
    expect(result.diagnostics).toHaveLength(6);
  });

  it('분기 엔진에서도 선정·다음 거래 봉 매수 판단·그 다음 봉 체결을 구분한다', () => {
    const input = fixture();
    const latest = Date.parse(input.asof);
    const trading = [latest, latest + 2 * 86400000, latest + 5 * 86400000];
    const futureFixture = trading.slice(1).flatMap((tsMs) => input.candles.filter((bar) => bar.tsMs === latest)
      .map((bar) => ({ ...bar, tsMs })));
    const history = withUncertainHistory(rankRetentionMomentum, [], latest);
    const wrapped = withQuarterRisk(history.strategy, { initialCash: 100000000, tradeFromTsMs: latest,
      lastSignalTsMs: latest + 90 * 86400000, targetPct: 10.5, stopPct: 15, resumeAfterMissedTarget: true });
    const observed: { tsMs: number; orders: readonly OrderIntent[]; pendingTargets: unknown }[] = [];
    const result = runBacktest({ ...wrapped.strategy, onBars(context, state, parameters) {
      const decision = wrapped.strategy.onBars(context, state, parameters);
      if (context.tsMs >= latest) observed.push({ tsMs: context.tsMs, orders: decision.orders, pendingTargets: state.pendingTargets });
      return decision;
    } }, { candles: [...input.candles, ...futureFixture], initialCash: 100000000, maxPositions: 5, randomSeed: 204,
      parameters: rankRetentionMomentum.parameterSchema.parse(candidate.parameters),
      tradeFromTsMs: latest, resultPeriod: { fromTsMs: latest, toTsMs: trading[2]! },
      universeSchedule: [{ fromTsMs: latest, symbols }], marketTradingTsMs: trading,
      nonTradingSymbolsByTsMs: new Map(), nonTradingCoveredPeriod: { from: input.asof, to: new Date(trading[2]!).toISOString().slice(0, 10) },
      execution: { cost: getCostProfile('kr-equity-default')!, slippage: { id: 'quarter-research', version: '1', bps: 5, fixed: 0 },
        rules: { ...getKrxExecutionRules('KOSPI'), maxVolumeParticipationRate: .01 } } });
    const current = buildCurrentSignals(encode(input), [candidate]);
    expect(current.signals[0]).toMatchObject({ ordersAtLatestClose: observed[0]!.orders, pendingTargets: observed[0]!.pendingTargets });
    expect(observed[0]!.orders).toEqual([]);
    expect(observed[1]!.orders.map((order) => [order.symbol, order.side])).toEqual(symbols.slice(0, 5).map((symbol) => [symbol, 'BUY']));
    expect(result.fills).toHaveLength(5);
    expect(result.fills.every((fill) => fill.tsMs === trading[2] && fill.side === 'BUY')).toBe(true);
  });

  it('현재 일봉이 없는 종목을 이전 가격으로 조용히 선정하지 않는다', () => {
    const input = fixture();
    input.candles = input.candles.filter((bar) => !(bar.symbol === 'S01' && bar.tsMs === Date.parse(input.asof)));
    expect(() => buildCurrentSignals(encode(input), [candidate])).toThrow('현재 일봉이 없습니다');
  });

  it('당일 거래정지가 확인된 종목의 일봉 결손은 허용하되 신규 목표에서 제외한다', () => {
    const input = fixture();
    const latest = Date.parse(input.asof);
    input.candles = input.candles.filter((bar) => !(bar.symbol === 'S01' && bar.tsMs === latest));
    input.nontrading = [[latest, ['S01']]];
    expect(buildCurrentSignals(encode(input), [candidate]).signals[0]).toMatchObject({
      ordersAtLatestClose: [], pendingTargets: symbols.slice(1),
    });
  });

  it('미래 가격과 현재 전용 표시가 없는 과거 성과 입력을 거부한다', () => {
    const future = fixture();
    future.candles.push({ ...future.candles.at(-1)!, tsMs: Date.parse(future.asof) + 86400000 });
    expect(() => buildCurrentSignals(encode(future), [candidate])).toThrow('기준일 이후');
    const historical = fixture();
    historical.metadata = {};
    expect(() => buildCurrentSignals(encode(historical), [candidate])).toThrow('현재 신호 전용');
  });

  it('입력에 없는 기준일로 빈 신호 보고서를 만들지 않는다', () => {
    const input = fixture();
    input.asof = '2026-01-22';
    expect(() => buildCurrentSignals(encode(input), [candidate])).toThrow('기준일이 입력 거래일에 없습니다');
  });
});
