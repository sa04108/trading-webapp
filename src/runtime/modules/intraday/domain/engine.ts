import { getIntradayStrategy } from "../../../../shared/schemas/intraday-strategies.js";
import { missingRateWarning } from "../../backtest/domain/sharpe.js";
import { buildIntradayDailyReport } from "./daily-evaluation.js";
import { RISK_FREE_RATE_SEED } from "../../backtest/domain/risk-free-rate-seed.js";
import type { RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";
import { createIntradaySignalModel } from "./signal-model.js";
import {
  MINUTE_MS,
  intradayBarSchema,
  intradayDate,
  intradayRequestSchema,
  type IntradayBar,
  type IntradayGap,
  type IntradayRequest,
  type IntradayResult,
  type IntradaySignal,
  type IntradayTimeframe,
} from "../../../../shared/schemas/intraday.js";
import {
  getKrxExecutionRules,
  tickSizeAt,
} from "../../backtest/domain/cost-profiles.js";
import { roundToTick } from "../../backtest/domain/execution.js";

const OPEN = 9 * 60;
const CLOSE = 15 * 60 + 20;
const ENTRY_CUTOFF = 15 * 60 + 10;
const EXIT = 15 * 60 + 15;
function minuteOfDay(ms: number): number {
  return (((ms / MINUTE_MS + 540) % 1440) + 1440) % 1440;
}
export function isIntradaySessionBar(bar: IntradayBar): boolean {
  const minute = minuteOfDay(bar.endMs);
  return minute > OPEN && minute <= CLOSE;
}

/** 봉 종료 시각을 유지한다. 누락된 1분봉이 있는 구간은 집계 봉을 만들지 않는다. */
export function aggregateIntradayBars(
  input: readonly IntradayBar[],
  timeframe: IntradayTimeframe,
): IntradayBar[] {
  const minutes = Number.parseInt(timeframe, 10);
  const bars = input
    .filter(isIntradaySessionBar)
    .sort((a, b) => a.endMs - b.endMs);
  if (minutes === 1) return bars;
  const groups = new Map<number, IntradayBar[]>();
  for (const bar of bars) {
    const elapsed = minuteOfDay(bar.endMs) - OPEN;
    const end =
      bar.endMs +
      (Math.ceil(elapsed / minutes) * minutes - elapsed) * MINUTE_MS;
    // 종가 단일가 구간과 이어지는 짧은 마지막 봉은 초기 전략 입력에서 제외한다.
    if (minuteOfDay(end) > CLOSE) continue;
    const group = groups.get(end) ?? [];
    group.push(bar);
    groups.set(end, group);
  }
  const result: IntradayBar[] = [];
  for (const [endMs, group] of groups) {
    if (
      group.length !== minutes ||
      group.some((b, i) => b.endMs !== endMs - (minutes - 1 - i) * MINUTE_MS)
    )
      continue;
    result.push({
      endMs,
      open: group[0]!.open,
      close: group.at(-1)!.close,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      volume: group.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

/** 무거래·정지인지 확인할 수 없는 빈 분은 정상 봉으로 간주하지 않는다. */
export function intradayGaps(
  input: readonly IntradayBar[],
  dates: readonly string[],
): IntradayGap[] {
  const times = new Set(input.map((b) => b.endMs));
  const gaps: IntradayGap[] = [];
  for (const date of dates) {
    const start = Date.parse(`${date}T09:00:00+09:00`);
    let gap: IntradayGap | null = null;
    for (let i = 1; i <= CLOSE - OPEN; i++) {
      const end = start + i * MINUTE_MS;
      if (!times.has(end)) {
        if (!gap) {
          gap = { fromMs: end - MINUTE_MS, toMs: end, missingMinutes: 1 };
          gaps.push(gap);
        } else {
          gap.toMs = end;
          gap.missingMinutes++;
        }
      } else gap = null;
    }
  }
  return gaps;
}

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
  const request = intradayRequestSchema.parse(input.request);
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
  const aggregated = new Map(
    aggregateIntradayBars(bars, request.timeframe).map((b) => [b.endMs, b]),
  );
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
  type Order = {
    id: string;
    signal: IntradaySignal;
    eligibleAtMs: number;
    expiresAtMs: number;
    quantity: number;
  };
  let pending = null as Order | null;
  let cash = request.initialCash,
    quantity = 0,
    averagePrice = 0,
    totalEntryCost = 0,
    tradeProceeds = 0,
    entryAt = 0;
  const signalModel = createIntradaySignalModel(request);
  let day = "",
    peak = cash;
  let holdingMinutes = 0,
    completedPnl = 0,
    previousVolume = 0;
  const dailyEquities = new Map<string, number>();
  const execution = request.execution;
  const event = (
    status: "EXPIRED" | "CANCELLED" | "UNFILLED",
    atMs: number,
    reason: string,
  ) => {
    if (!pending) return;
    result.orderEvents.push({
      orderId: pending.id,
      atMs,
      status,
      remainingQty: pending.quantity,
      reason,
    });
    pending = null;
  };
  const order = (
    side: "BUY" | "SELL",
    atMs: number,
    reason: IntradaySignal["reason"],
    close: number,
    liquidity: number,
  ) => {
    if (pending) return;
    const signal: IntradaySignal = {
      id: `signal-${result.signals.length + 1}`,
      atMs,
      side,
      reason,
    };
    result.signals.push(signal);
    const buyPrice =
      close *
      (1 + execution.slippageBps / 10_000) *
      (1 + execution.commissionBps / 10_000);
    const wanted =
      side === "SELL"
        ? quantity
        : Math.min(
            Math.floor(
              (cash * request.parameters.allocationPct) / 100 / buyPrice,
            ),
            Math.floor((liquidity * execution.maxParticipationPct) / 100),
          );
    if (wanted <= 0) {
      result.orderEvents.push({
        orderId: signal.id,
        atMs,
        status: "UNFILLED",
        remainingQty: 0,
        reason: "현금·기존 봉 거래량으로 주문 가능한 수량이 없습니다.",
      });
      return;
    }
    pending = {
      id: signal.id,
      signal,
      eligibleAtMs: atMs + execution.latencyMs,
      expiresAtMs:
        atMs + execution.latencyMs + execution.orderExpiryMinutes * MINUTE_MS,
      quantity: wanted,
    };
  };
  const tickRules = getKrxExecutionRules("KOSPI");
  // 가격 봉이 없어도 주문 기한은 흐른다. 가장 먼저 도달한 종료 조건을 실제 시각에 기록한다.
  const settlePending = (untilMs: number) => {
    if (!pending) return;
    const orderDay = intradayDate(pending.signal.atMs);
    const closeAt = Date.parse(`${orderDay}T15:20:00+09:00`);
    const cutoffAt = pending.signal.side === "BUY"
      ? Date.parse(`${orderDay}T15:10:00+09:00`)
      : closeAt;
    const terminalAt = Math.min(pending.expiresAtMs, cutoffAt, closeAt);
    if (untilMs < terminalAt) return;
    if (terminalAt === pending.expiresAtMs)
      event("EXPIRED", terminalAt, "주문 유효 시간이 지났습니다.");
    else if (pending.signal.side === "BUY")
      event("CANCELLED", terminalAt, "신규 진입 마감입니다.");
    else event("UNFILLED", terminalAt, "세션 종료 후 미체결 주문입니다.");
  };
  let finalizedDay = "";
  // 마지막 봉이 누락되어도 날짜 경계에서 주문과 잔량을 정리한다. 관측하지 않은 가격으로 청산하지 않는다.
  const finishDay = () => {
    if (!day || finalizedDay === day) return;
    finalizedDay = day;
    settlePending(Date.parse(`${day}T15:20:00+09:00`));
    if (quantity > 0)
      result.warnings.push(
        `${day} 당일 청산에 실패해 ${quantity}주가 남았습니다. 마지막 관측 가격으로 평가하고 이 날짜에서 계산을 종료했습니다.`,
      );
  };
  for (const bar of bars) {
    const barDay = intradayDate(bar.endMs),
      minute = minuteOfDay(bar.endMs),
      openAt = bar.endMs - MINUTE_MS;
    if (day !== barDay) {
      finishDay();
      if (quantity > 0) break;
      day = barDay;
      previousVolume = 0;
    }
    settlePending(openAt);
    if (pending && openAt >= pending.eligibleAtMs) {
      const side = pending.signal.side;
      const slipped =
        bar.open *
        (1 + ((side === "BUY" ? 1 : -1) * execution.slippageBps) / 10_000);
      const tick = tickSizeAt(tickRules, slipped, openAt);
      const price = roundToTick(
        Math.max(tick, slipped),
        tick,
        side === "BUY" ? "up" : "down",
      );
      // 주문 수량에는 이미 지난 봉만 사용한다. 체결 봉 거래량은 사후 체결 상한이다.
      const cap = Math.floor(
        (bar.volume * execution.maxParticipationPct) / 100,
      );
      const affordable = Math.floor(
        cash / (price * (1 + execution.commissionBps / 10_000)),
      );
      const qty = Math.min(
        pending.quantity,
        cap,
        side === "BUY" ? affordable : quantity,
      );
      if (qty > 0) {
        const gross = price * qty,
          commission = (gross * execution.commissionBps) / 10_000,
          tax = side === "SELL" ? (gross * execution.taxBps) / 10_000 : 0;
        result.fills.push({
          orderId: pending.id,
          signalAtMs: pending.signal.atMs,
          eligibleAtMs: pending.eligibleAtMs,
          atMs: openAt,
          side,
          qty,
          price,
          commission,
          tax,
          reason: pending.signal.reason,
        });
        result.metrics.totalCosts +=
          commission + tax + Math.abs(price - bar.open) * qty;
        if (side === "BUY") {
          if (!quantity) {
            entryAt = openAt;
            totalEntryCost = 0;
            tradeProceeds = 0;
          }
          averagePrice = (averagePrice * quantity + gross) / (quantity + qty);
          totalEntryCost += gross + commission;
          quantity += qty;
          cash -= gross + commission;
        } else {
          quantity -= qty;
          cash += gross - commission - tax;
          tradeProceeds += gross - commission - tax;
          if (!quantity) {
            result.metrics.completedTrades++;
            completedPnl += tradeProceeds - totalEntryCost;
            holdingMinutes += (openAt - entryAt) / MINUTE_MS;
            averagePrice = 0;
          }
        }
        pending.quantity -= qty;
        if (pending.quantity === 0) pending = null;
      }
    }
    settlePending(bar.endMs);
    const signalBar = aggregated.get(bar.endMs);
    const decision = signalModel.onMinute(bar, signalBar);
    if (signalBar) {
      const pnl =
        averagePrice > 0 ? (signalBar.close / averagePrice - 1) * 100 : 0;
      let exitReason: IntradaySignal["reason"] | null = null;
      if (quantity > 0 && pnl <= -request.parameters.stopLossPct)
        exitReason = "STOP_LOSS";
      else if (quantity > 0 && pnl >= request.parameters.takeProfitPct)
        exitReason = "TAKE_PROFIT";
      else if (quantity > 0) exitReason = decision.exit;
      if (exitReason) {
        if (pending?.signal.side === "BUY")
          event(
            "CANCELLED",
            bar.endMs,
            "청산 신호로 미체결 매수를 취소했습니다.",
          );
        order("SELL", bar.endMs, exitReason, bar.close, previousVolume);
      } else if (
        !quantity &&
        !pending &&
        minute < ENTRY_CUTOFF &&
        decision.entry
      ) {
        order("BUY", bar.endMs, decision.entry, bar.close, bar.volume);
      }
    }
    if (minute >= EXIT) {
      if (pending?.signal.side === "BUY")
        event("CANCELLED", bar.endMs, "당일 청산 시간입니다.");
      if (quantity > 0)
        order("SELL", bar.endMs, "DAY_EXIT", bar.close, bar.volume);
    }
    const equity = cash + quantity * bar.close;
    peak = Math.max(peak, equity);
    result.metrics.maxDrawdownPct = Math.min(
      result.metrics.maxDrawdownPct,
      (equity / peak - 1) * 100,
    );
    result.equity.push({ endMs: bar.endMs, equity, cash, quantity });
    dailyEquities.set(day, equity);
    result.processedBars++;
    previousVolume = bar.volume;
    result.position = { quantity, averagePrice, lastPrice: bar.close };
  }
  finishDay();
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
