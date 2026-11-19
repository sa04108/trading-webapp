import { resolveIntradayRequest } from "../../../../shared/schemas/intraday-strategies.js";
import { MINUTE_MS, intradayBarSchema, intradayDate, type IntradayBar, type IntradayRequest, type IntradaySignal, type IntradayFill, type IntradayOrderEvent, type IntradayEquity } from "../../../../shared/schemas/intraday.js";
import { getKrxExecutionRules, tickSizeAt } from "../../backtest/domain/cost-profiles.js";
import { roundToTick } from "../../backtest/domain/execution.js";
import { createIntradaySignalModel } from "./signal-model.js";
import { aggregateIntradayBars, isIntradaySessionBar, minuteOfDay } from "./session-bars.js";

const EXIT = 15 * 60 + 15;
const ENTRY_CUTOFF = 15 * 60 + 10;
export interface IntradayPendingOrder { id: string; signal: IntradaySignal; eligibleAtMs: number; expiresAtMs: number; remainingQty: number; requestedQty: number }
export interface IntradaySubmittedOrder { orderId: string; atMs: number; side: "BUY" | "SELL"; quantity: number; signal: IntradaySignal }
export interface IntradaySessionState {
  cash: number; quantity: number; averagePrice: number; lastPrice: number; pending: IntradayPendingOrder | null;
  lastBarMs: number | null; throughMs: number | null; nextSignalId: number; day: string; finalizedDay: string; stopped: boolean;
  totalEntryCost: number; tradeProceeds: number; entryAt: number; peak: number; holdingMinutes: number; completedPnl: number;
  previousVolume: number; dailyEntries: number; lastExitAt: number | null; dayBars: IntradayBar[];
  totalCosts: number; maxDrawdownPct: number; completedTrades: number; processedBars: number;
}
export function initialIntradayState(request: IntradayRequest): IntradaySessionState {
  return { cash: request.initialCash, quantity: 0, averagePrice: 0, lastPrice: 0, pending: null, lastBarMs: null, throughMs: null,
    nextSignalId: 0, day: "", finalizedDay: "", stopped: false, totalEntryCost: 0, tradeProceeds: 0, entryAt: 0,
    peak: request.initialCash, holdingMinutes: 0, completedPnl: 0, previousVolume: 0, dailyEntries: 0, lastExitAt: null,
    dayBars: [], totalCosts: 0, maxDrawdownPct: 0, completedTrades: 0, processedBars: 0 };
}
export function cancelIntradayPending(state: IntradaySessionState, atMs: number, reason = "사용자가 주문을 취소했습니다."): { state: IntradaySessionState; orderEvents: IntradayOrderEvent[] } {
  const next = structuredClone(state);
  const pending = next.pending;
  next.pending = null;
  return { state: next, orderEvents: pending ? [{ orderId: pending.id, atMs, status: "CANCELLED", remainingQty: pending.remainingQty, reason }] : [] };
}
export function advanceIntradaySession(requestInput: IntradayRequest, inputState: IntradaySessionState, inputBars: readonly IntradayBar[], options: { throughMs: number; signalAfterMs?: number }) {
  const request = resolveIntradayRequest(requestInput);
  if (!Number.isFinite(options.throughMs) || (inputState.throughMs !== null && options.throughMs < inputState.throughMs)) throw new Error("처리 시각은 이전 시각보다 빠를 수 없습니다.");
  const state = structuredClone(inputState);
  let { cash, quantity, averagePrice, lastPrice, pending, lastBarMs, nextSignalId, day, finalizedDay, stopped,
    totalEntryCost, tradeProceeds, entryAt, peak, holdingMinutes, completedPnl, previousVolume, dailyEntries, dayBars } = state;
  let lastExitAt = state.lastExitAt ?? -Infinity;
  const { maxDailyEntries = 2, cooldownMinutes = 30, maxHoldingMinutes = 120 } = request.parameters;
  const bars = inputBars.map(b => intradayBarSchema.parse(b)).filter(b => isIntradaySessionBar(b) && b.endMs <= options.throughMs).sort((a,b) => a.endMs-b.endMs);
  if (bars.some((b,i) => (i > 0 && b.endMs === bars[i-1]!.endMs) || (lastBarMs !== null && b.endMs <= lastBarMs) || (state.throughMs !== null && b.endMs <= state.throughMs))) throw new Error("중복되거나 순서가 지난 분봉이 있습니다.");
  const aggregated = new Map(aggregateIntradayBars([...dayBars, ...bars], request.timeframe).map(b => [b.endMs, b]));
  const signalModel = createIntradaySignalModel(request);
  for (const b of dayBars) signalModel.onMinute(b, aggregated.get(b.endMs));
  const orders: IntradaySubmittedOrder[] = [];
  const result = { signals: [] as IntradaySignal[], fills: [] as IntradayFill[], orderEvents: [] as IntradayOrderEvent[], equity: [] as IntradayEquity[], warnings: [] as string[], processedBars: state.processedBars,
    metrics: { totalCosts: state.totalCosts, maxDrawdownPct: state.maxDrawdownPct, completedTrades: state.completedTrades } };
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
      remainingQty: pending.remainingQty,
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
      id: `signal-${++nextSignalId}`,
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
    orders.push({ orderId: signal.id, atMs, side, quantity: wanted, signal });
    pending = {
      id: signal.id,
      signal,
      eligibleAtMs: atMs + execution.latencyMs,
      expiresAtMs:
        atMs + execution.latencyMs + execution.orderExpiryMinutes * MINUTE_MS,
      remainingQty: wanted,
      requestedQty: wanted,
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
  for (const bar of stopped ? [] : bars) {
    const barDay = intradayDate(bar.endMs),
      minute = minuteOfDay(bar.endMs),
      openAt = bar.endMs - MINUTE_MS;
    if (day !== barDay) {
      finishDay();
      if (quantity > 0) { stopped = true; break; }
      dayBars = [];
      day = barDay;
      previousVolume = 0;
      dailyEntries = 0;
      lastExitAt = -Infinity;
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
        pending.remainingQty,
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
            // 첫 매수 체결만 진입 한도를 사용하며 같은 주문의 부분체결은 중복 계산하지 않는다.
            dailyEntries++;
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
            lastExitAt = openAt;
            completedPnl += tradeProceeds - totalEntryCost;
            holdingMinutes += (openAt - entryAt) / MINUTE_MS;
            averagePrice = 0;
          }
        }
        pending.remainingQty -= qty;
        if (pending.remainingQty === 0) pending = null;
      }
    }
    settlePending(bar.endMs);
    const signalBar = aggregated.get(bar.endMs);
    const decision = signalModel.onMinute(bar, signalBar);
    dayBars.push(bar);
    // 시간 제한은 실제 첫 체결부터 센다. 관측된 1분봉에서 청산 신호를 내고 기존 지연·만료 규칙으로 체결한다.
    const tradingEnabled = bar.endMs > (options.signalAfterMs ?? -Infinity);
    const holdingExpired = tradingEnabled && quantity > 0 && bar.endMs - entryAt >= maxHoldingMinutes * MINUTE_MS;
    if (holdingExpired) {
      if (pending?.signal.side === "BUY") event("CANCELLED", bar.endMs, "최대 보유 시간으로 미체결 매수를 취소했습니다.");
      order("SELL", bar.endMs, "MAX_HOLD", bar.close, bar.volume);
    }
    if (tradingEnabled && signalBar && !holdingExpired) {
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
        dailyEntries < maxDailyEntries &&
        bar.endMs >= lastExitAt + cooldownMinutes * MINUTE_MS &&
        decision.entry
      ) {
        order("BUY", bar.endMs, decision.entry, bar.close, bar.volume);
      }
    }
    if (tradingEnabled && minute >= EXIT) {
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
    result.processedBars++;
    previousVolume = bar.volume;
    lastPrice = bar.close;
    lastBarMs = bar.endMs;
  }
  if (day && options.throughMs >= Date.parse(`${day}T15:20:00+09:00`)) {
    finishDay();
    if (quantity > 0) stopped = true;
  } else settlePending(options.throughMs);
  Object.assign(state, { cash, quantity, averagePrice, lastPrice, pending, lastBarMs, throughMs: options.throughMs, nextSignalId, day, finalizedDay, stopped,
    totalEntryCost, tradeProceeds, entryAt, peak, holdingMinutes, completedPnl, previousVolume, dailyEntries, lastExitAt: Number.isFinite(lastExitAt) ? lastExitAt : null,
    dayBars, totalCosts: result.metrics.totalCosts, maxDrawdownPct: result.metrics.maxDrawdownPct, completedTrades: result.metrics.completedTrades, processedBars: result.processedBars });
  return { state, signals: result.signals, fills: result.fills, orderEvents: result.orderEvents, orders, equity: result.equity, warnings: result.warnings };
}
