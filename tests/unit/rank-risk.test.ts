import { expect, it } from "vitest";
import { createRng } from "../../src/runtime/modules/backtest/domain/seeded-rng.js";
import type { Position } from "../../src/runtime/modules/backtest/domain/types.js";
import type { StrategyBarContext } from "../../src/runtime/modules/strategy/domain/strategy.js";
import { beginRankCycle, finishRankCycle, newRankRiskState, rankLiquidityReady, rankRiskParameters } from "../../src/runtime/modules/strategy/strategies/shared/rank-risk.js";
import { UNFILTERED_RANK_CONTROLS } from "../helpers/rank-controls.js";

const DAY = 86400000;
const AT = Date.UTC(2025, 5, 2);
const position = (symbol: string, quantity = 50): Position => ({ symbol, quantity, avgEntryPrice: 100, entryTsMs: AT - DAY, entryCosts: 0 });
function context(day: number, indexClose: number, positions: Position[] = []): StrategyBarContext {
  const tsMs = AT + day * DAY;
  const bars = new Map(["A", "B", "C"].map((symbol) => [symbol, {
    symbol, market: "KR" as const, timeframe: "1d" as const, tsMs, open: 100, high: 100, low: 100, close: 100, volume: 1000,
  }]));
  return { tsMs, isRebalanceBar: false, bars, getHistory: (symbol) => [bars.get(symbol)!],
    getMarketIndexHistory: () => Array.from({ length: 20 }, (_, i) => ({ tsMs: tsMs - (19 - i) * DAY, close: i === 19 ? indexClose : 100 })),
    portfolio: { cash: 0, equity: 10000, positions: new Map(positions.map((p) => [p.symbol, p])) },
    rng: createRng(1), fundamentals: () => null, corporateActions: () => [],
    tradableSymbols: null, activeUniverseSymbols: null, selectionMetric: () => null };
}

// 기존 순위 계산 테스트는 시장 악화·미체결·대기 매수의 상호작용을 검사하지 않았다.
it("리밸런스일이 아니어도 하락장에는 비중을 줄이고 거래 봉이 생기면 미완료 축소를 재시도한다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, marketTrendBars: 20, riskOffExposurePercent: 30 };
  const state = newRankRiskState(["A", "B"]);
  const held = [position("A"), position("B")];
  expect(beginRankCycle(context(0, 100, held), state, parameters)).toEqual({ orders: [] });
  state.pendingTargets = ["A", "B"];
  const missing = context(1, 90, held);
  const first = beginRankCycle({ ...missing, bars: new Map([["B", missing.bars.get("B")!]]) }, state, parameters);
  expect(first?.orders).toEqual([{ symbol: "B", side: "SELL", quantity: 35, reason: "MARKET_RISK_OFF" }]);
  expect(state.pendingTargets).toBeNull();
  const retry = beginRankCycle(context(2, 90, [position("A"), position("B", 15)]), state, parameters);
  expect(retry?.orders).toEqual([{ symbol: "A", side: "SELL", quantity: 35, reason: "MARKET_RISK_OFF" }]);
  expect(beginRankCycle(context(3, 102, [position("A", 15), position("B", 15)]), state, parameters)).toEqual({ orders: [] });
});

it("순위 완충 범위의 보유 종목은 유지하고 작은 비중 차이는 거래하지 않는다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, rankBufferPercent: 50, rebalanceBandPercent: 20 };
  const state = newRankRiskState(["A", "B", "C"]);
  const ctx = { ...context(0, 100, [position("A", 55), position("B", 45)]), isRebalanceBar: true };
  expect(beginRankCycle(ctx, state, parameters)).toBeNull();
  expect(finishRankCycle(["B", "C", "A"], ctx, state, parameters)).toEqual({ orders: [] });
  expect(state.pendingTargets).toEqual(["A", "B"]);
  expect(beginRankCycle(context(1, 100, [position("A", 55), position("B", 45)]), state, parameters)).toEqual({ orders: [] });
});

it("하락장 준비 후 기존 포지션으로 활성화해도 순위 평가를 기다리지 않고 축소한다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, marketTrendBars: 20, riskOffExposurePercent: 30 };
  const state = newRankRiskState(["A", "B"]);
  expect(beginRankCycle(context(0, 90), state, parameters)).toEqual({ orders: [] });
  expect(beginRankCycle(context(1, 90, [position("A"), position("B")]), state, parameters)?.orders)
    .toEqual(["A", "B"].map((symbol) => ({ symbol, side: "SELL", quantity: 35, reason: "MARKET_RISK_OFF" })));
});

it("공유 일정이 자주 와도 최소 교체 기간을 지키고 정상 투자 비율만 매수한다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, investmentPercent: 95, minRebalanceBars: 20 };
  const state = newRankRiskState(["A", "B"]);
  const first = { ...context(0, 100), isRebalanceBar: true };
  expect(beginRankCycle(first, state, parameters)).toBeNull();
  finishRankCycle(["A", "B"], first, state, parameters);
  expect(beginRankCycle(context(1, 100), state, parameters)?.orders.map((o) => o.quantity)).toEqual([47, 47]);
  for (let day = 2; day < 20; day++)
    expect(beginRankCycle({ ...context(day, 100), isRebalanceBar: true }, state, parameters)).toEqual({ orders: [] });
  expect(beginRankCycle({ ...context(20, 100), isRebalanceBar: true }, state, parameters)).toBeNull();
});

it("목표 종목 수를 줄인 기존 포트폴리오도 하락장 총 투자 한도를 지킨다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, marketTrendBars: 20, riskOffExposurePercent: 30 };
  const state = newRankRiskState(["A", "B", "C"]);
  const ctx = context(0, 90, [position("A", 25), position("B", 25), position("C", 25)]);
  const first = beginRankCycle({ ...ctx, portfolio: { ...ctx.portfolio, cash: 2500 },
    bars: new Map([...ctx.bars].filter(([symbol]) => symbol !== "A")) }, state, parameters);
  expect(first?.orders).toEqual(["B", "C"].map((symbol) => ({ symbol, side: "SELL", quantity: 15, reason: "MARKET_RISK_OFF" })));
  const retry = beginRankCycle(context(1, 90, [position("A", 25), position("B", 10), position("C", 10)]), state, parameters);
  expect(retry?.orders).toEqual([{ symbol: "A", side: "SELL", quantity: 15, reason: "MARKET_RISK_OFF" }]);
});

it("실제 판단에 지수가 없으면 정상장으로 가정하지 않고 실패한다", () => {
  const parameters = { ...UNFILTERED_RANK_CONTROLS, topN: 2, marketTrendBars: 20 };
  const ctx = { ...context(0, 100), isRebalanceBar: true, getMarketIndexHistory: () => [] };
  expect(() => beginRankCycle(ctx, newRankRiskState(["A"]), parameters)).toThrow("KOSPI");
});

it("거래대금은 확보한 전체 창의 원화 추정 평균으로 검사한다", () => {
  const parameters = rankRiskParameters.parse({ liquidityLookbackBars: 2, minAverageTradingValueKrw: 100000 });
  const ctx = context(0, 100);
  expect(rankLiquidityReady(ctx, "A", parameters)).toBe(false);
  const bar = ctx.bars.get("A")!;
  expect(rankLiquidityReady({ ...ctx, getHistory: () => [bar, { ...bar, volume: 500 }] }, "A", parameters)).toBe(false);
  expect(rankLiquidityReady({ ...ctx, getHistory: () => [bar, bar] }, "A", parameters)).toBe(true);
});
