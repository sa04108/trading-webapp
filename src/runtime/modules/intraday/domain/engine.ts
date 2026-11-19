import { getIntradayStrategy, resolveIntradayRequest } from "../../../../shared/schemas/intraday-strategies.js";
import { missingRateWarning } from "../../backtest/domain/sharpe.js";
import { buildIntradayDailyReport } from "./daily-evaluation.js";
import { RISK_FREE_RATE_SEED } from "../../backtest/domain/risk-free-rate-seed.js";
import type { RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";
import { advanceIntradaySession, initialIntradayState } from "./session-engine.js";
import {
  intradayBarSchema,
  intradayDate,
  type IntradayBar,
  type IntradayRequest,
  type IntradayResult,
} from "../../../../shared/schemas/intraday.js";

import { CLOSE, OPEN, intradayGaps, isIntradaySessionBar } from "./session-bars.js";
export { aggregateIntradayBars, intradayGaps, isIntradaySessionBar } from "./session-bars.js";

export interface IntradayEngineInput {
  riskFreeRates?: RiskFreeRateHistory;
  request: IntradayRequest;
  bars: IntradayBar[];
  dataRevision: string;
  tradingDates: string[];
}

/** 일봉 엔진과 분리된 현금 매매 모형. 수집·주문 API를 호출하지 않는 순수 계산이다. */
export function runIntradayBacktest(
  input: IntradayEngineInput,
): IntradayResult {
  const request = resolveIntradayRequest(input.request);
  const expected = new Set(input.tradingDates);
  if (!expected.size) throw new Error("기간에 확인된 거래일이 없습니다.");
  const bars = input.bars
    .map((b) => intradayBarSchema.parse(b))
    .filter(
      (b) => expected.has(intradayDate(b.endMs)) && isIntradaySessionBar(b),
    )
    .sort((a, b) => a.endMs - b.endMs);
  if (bars.some((b, i) => i > 0 && b.endMs === bars[i - 1]!.endMs))
    throw new Error("중복된 분봉이 있습니다.");
  const gaps = intradayGaps(bars, input.tradingDates);
  const result: IntradayResult = {
    request,
    strategyVersion: getIntradayStrategy(request.strategyId).version,
    dataRevision: input.dataRevision,
    quoteScope: "TOSS_UNSPECIFIED",
    adjusted: false,
    session: "09:00–15:20 Asia/Seoul",
    fills: [],
    signals: [],
    orderEvents: [],
    equity: [],
    warnings: [
      "토스 제공 시세의 거래소 구성은 확인되지 않았습니다. 지정 시간 구간을 사용하는 모의 체결입니다.",
      "지표와 시초 범위는 매일 초기화합니다. 손절·익절은 확정된 신호 봉 종가로 판단하며 체결 지연·비용은 입력한 가정입니다.",
      "하루 진입 한도는 실제 포지션 개설 횟수이며, 완전 청산 이후 재진입 대기를 적용합니다. 최대 보유 시간에는 관측된 1분봉으로 청산을 요청하므로 누락·체결 지연으로 실제 보유 시간이 길어질 수 있습니다.",
      "미체결 매도 주문이 있으면 청산을 계속 시도하며 후속 신호로 주문 지연·만료 시간을 연장하지 않습니다.",
    ],
    processedBars: 0,
    position: { quantity: 0, averagePrice: 0, lastPrice: 0 },
    metrics: {
      pnl: 0,
      returnPct: 0,
      totalCosts: 0,
      maxDrawdownPct: 0,
      dailyMaxDrawdownPct: 0,
      sharpe: null,
      completedTrades: 0,
      averageTradePnl: null,
      averageHoldingMinutes: null,
    },
  };
  if (gaps.length) {
    const first = gaps[0]!;
    const time = (ms: number) =>
      new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
    result.warnings.push(
      `분봉 ${gaps.reduce((sum, gap) => sum + gap.missingMinutes, 0)}개(${gaps.length}구간)가 누락되었습니다. 최초 구간: ${time(first.fromMs)} ~ ${time(first.toMs)} KST. 누락 구간에서는 신호·체결을 만들지 않으며 수신된 확정 봉만으로 지표와 성과를 계산합니다.`,
    );
    if (request.strategyId === "intraday-orb")
      result.warnings.push(
        "09:00부터의 시초 범위에 누락된 분봉이 있으면 해당 날짜의 시초가 범위 돌파 진입을 생략합니다.",
      );
  }
  if (!bars.length)
    result.warnings.push(
      "조회 기간에 사용 가능한 분봉이 없어 매매를 수행하지 않았습니다.",
    );
  const session = advanceIntradaySession(request, initialIntradayState(request), bars, { throughMs: Math.max(...input.tradingDates.map((date) => Date.parse(`${date}T15:20:00+09:00`))) });
  result.signals = session.signals;
  result.fills = session.fills;
  result.orderEvents = session.orderEvents;
  result.equity = session.equity;
  result.warnings.push(...session.warnings);
  result.processedBars = session.state.processedBars;
  result.position = { quantity: session.state.quantity, averagePrice: session.state.averagePrice, lastPrice: session.state.lastPrice };
  result.metrics.totalCosts = session.state.totalCosts;
  result.metrics.maxDrawdownPct = session.state.maxDrawdownPct;
  result.metrics.completedTrades = session.state.completedTrades;
  const { completedPnl, holdingMinutes } = session.state;
  const dailyEquities = new Map<string, number>();
  for (const point of result.equity) dailyEquities.set(intradayDate(point.endMs), point.equity);
  const finalEquity = result.equity.at(-1)?.equity ?? request.initialCash;
  result.metrics.pnl = finalEquity - request.initialCash;
  result.metrics.returnPct = (result.metrics.pnl / request.initialCash) * 100;
  let dailyPeak = request.initialCash;
  for (const equity of dailyEquities.values()) {
    dailyPeak = Math.max(dailyPeak, equity);
    result.metrics.dailyMaxDrawdownPct = Math.min(
      result.metrics.dailyMaxDrawdownPct,
      (equity / dailyPeak - 1) * 100,
    );
  }
  result.dailyEvaluation = buildIntradayDailyReport(result, input.tradingDates, CLOSE - OPEN, input.riskFreeRates ?? RISK_FREE_RATE_SEED);
  result.metrics.sharpe = result.dailyEvaluation.summary.sharpe;
  result.metrics.sharpeBasis = result.dailyEvaluation.sharpeBasis;
  const coverage = result.dailyEvaluation.summary;
  if (!coverage.isComplete) result.warnings.push(
    `일별 통계와 Sharpe는 전체 ${coverage.expectedDays}거래일 중 시세가 완전하고 당일 청산한 ${coverage.evaluatedDays}일만 사용합니다. 부분 누락 ${coverage.partialDays}일, 전체 누락 ${coverage.missingDays}일, 청산 실패 ${coverage.exitFailedDays}일, 미실행 ${coverage.notRunDays}일은 제외하며 전체 기간 성과로 해석할 수 없습니다.`,
  );
  const rateWarning = missingRateWarning(result.metrics.sharpeBasis);
  if (rateWarning) result.warnings.push(rateWarning);
  if (result.metrics.completedTrades) {
    result.metrics.averageTradePnl =
      completedPnl / result.metrics.completedTrades;
    result.metrics.averageHoldingMinutes =
      holdingMinutes / result.metrics.completedTrades;
  }
  return result;
}
