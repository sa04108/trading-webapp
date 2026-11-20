import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { advanceIntradaySession, initialIntradayState, type IntradaySessionState } from "../../../../runtime/modules/intraday/domain/session-engine.js";
import { intradayBarSchema, intradayDate, MINUTE_MS, type IntradayBar, type IntradayFill, type IntradayOrderEvent } from "../../../../shared/schemas/intraday.js";
import { paperTradingAccountId, type IntradayTradingSetup, type TradingOrder } from "../../../../shared/schemas/trading.js";
import { paperTradingAccount, paperTradingOrders, tradingControl, tradingDeployments, tradingEvents, tradingOrders } from "../../../shared/db/trading-schema.js";
import type { BrokerOrder } from "./broker-port.js";

export interface IntradayPaperData {
  readonly paperDataConfigured: boolean;
  paperTradingDate?(date: string): boolean;
  paperBars(symbol: string, fromMs: number, throughMs: number): Promise<IntradayBar[]>;
}

type Row = typeof tradingDeployments.$inferSelect;
type Db = DatabaseHandle["db"];
type Output = ReturnType<typeof advanceIntradaySession>;
const CHECKPOINT_FORMAT = 1;
interface Checkpoint { formatVersion?: number; signalAfterMs: number; state: IntradaySessionState; gapDate?: string; missingBars?: number }

export function minuteSetup(row: Row | null): IntradayTradingSetup | null {
  if (!row) return null;
  const setup = JSON.parse(row.setupJson);
  return setup.kind === "intraday" ? setup : null;
}

export function readMinuteCheckpoint(row: Row): Checkpoint {
  if (!row.checkpoint) throw new Error("활성 분봉 모의계좌의 실행 상태가 없습니다.");
  return JSON.parse(row.checkpoint) as Checkpoint;
}

// 형식 번호가 없던 계좌도 같은 원장·주문·봉 구조인지 확인한 뒤 새 실행기에 넘긴다.
const count = z.number().int().nonnegative();
const timestamp = count.nullable();
const checkpointSchema = z.object({
  formatVersion: z.literal(CHECKPOINT_FORMAT).optional(),
  signalAfterMs: count,
  state: z.object({
    cash: z.number(), quantity: count, averagePrice: z.number(), lastPrice: z.number(),
    lastBarMs: timestamp, throughMs: timestamp, nextSignalId: count, day: z.string(), finalizedDay: z.string(), stopped: z.boolean(),
    totalEntryCost: z.number(), tradeProceeds: z.number(), entryAt: count, peak: z.number(), holdingMinutes: count,
    completedPnl: z.number(), previousVolume: count, dailyEntries: count, lastExitAt: timestamp,
    dayBars: z.array(intradayBarSchema), signalCheckpoint: z.object({ orbFired: z.boolean(), recoveryRemaining: count }).optional(),
    totalCosts: z.number(), maxDrawdownPct: z.number(), completedTrades: count, processedBars: count,
    pending: z.object({
      id: z.string().min(1), eligibleAtMs: count, expiresAtMs: count, requestedQty: count.positive(), remainingQty: count.positive(),
      signal: z.object({ id: z.string(), atMs: count, side: z.enum(["BUY", "SELL"]), reason: z.string() }),
    }).refine(order => order.signal.id === order.id && order.remainingQty <= order.requestedQty && order.eligibleAtMs <= order.expiresAtMs).nullable(),
  }),
});

function compatibleMinuteCheckpoint(row: Row): Checkpoint {
  const checkpoint = readMinuteCheckpoint(row);
  if (!checkpointSchema.safeParse(checkpoint).success)
    throw new Error("기존 분봉 체크포인트를 현재 실행기에서 이어갈 수 없습니다.");
  return checkpoint;
}

export function upgradeMinuteCheckpoint(row: Row): string {
  return JSON.stringify({ ...compatibleMinuteCheckpoint(row), formatVersion: CHECKPOINT_FORMAT });
}

export function startMinuteCheckpoint(row: Row, setup: IntradayTradingSetup, now: number): Checkpoint {
  const checkpoint = row.checkpoint ? compatibleMinuteCheckpoint(row) : { state: initialIntradayState(setup.request) };
  const { state } = checkpoint;
  if (state.stopped || (state.quantity > 0 && (state.day !== intradayDate(now) || now >= Date.parse(state.day + "T15:20:00+09:00")))) {
    throw new Error("당일 청산 기한을 지난 잔여 포지션이 있습니다. 이 계좌의 보유·체결 이력을 확인하고 새 모의투자를 생성해 주세요.");
  }
  return { ...checkpoint, formatVersion: CHECKPOINT_FORMAT, signalAfterMs: now };
}

/** 최근 누락 봉에는 두 분의 재조회 여유를 준 뒤, 실제로 관측한 봉만 확정한다. */
export function settleMinuteWindow(from: number, through: number, bars: IntradayBar[], now: number) {
  const seen = new Set(bars.map(bar => bar.endMs));
  let missing = 0;
  for (let at = from; at <= through; at += MINUTE_MS) {
    if (!seen.has(at)) {
      if (at > now - 3 * MINUTE_MS) return { through: at - MINUTE_MS, missing };
      missing++;
    }
  }
  return { through, missing };
}

/** 한 번에 한 거래일만 진행한다. OFF 동안의 이전 거래일은 재생하지 않는다. */
export function nextMinuteWindow({ state, signalAfterMs }: Checkpoint, now: number) {
  const dayOpen = Date.parse(intradayDate(signalAfterMs) + "T09:00:00+09:00");
  let from = Math.max(dayOpen + MINUTE_MS, (state.throughMs ?? dayOpen) + MINUTE_MS);
  let close = Date.parse(intradayDate(from) + "T15:20:00+09:00");
  if (from > close) {
    from = Date.parse(intradayDate(from + 86_400_000) + "T09:01:00+09:00");
    close = Date.parse(intradayDate(from) + "T15:20:00+09:00");
  }
  const through = Math.min(Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS, close);
  return through >= from ? { from, through } : null;
}

interface StoredMinuteOrder {
  request: { clientOrderId: string; symbol: string; side: TradingOrder["side"]; quantity: number; price: number };
  order: BrokerOrder;
  fills: IntradayFill[];
}

export function recordMinuteOrders(db: Db, slot: number, row: Row, setup: IntradayTradingSetup,
  submitted: Output["orders"], fills: IntradayFill[], events: IntradayOrderEvent[], bars: IntradayBar[]) {
  const accountId = paperTradingAccountId(slot);
  const symbol = setup.request.symbol;
  const prices = new Map(bars.map(bar => [bar.endMs, bar.close]));
  for (const entry of submitted) {
    const id = randomUUID();
    const price = prices.get(entry.atMs);
    if (price === undefined) throw new Error("분봉 주문의 신호 가격이 없습니다.");
    const common = { symbol, side: entry.side, quantity: entry.quantity, price, filledQuantity: 0, averageFillPrice: null, status: "OPEN" as const };
    const order: TradingOrder = { ...common, id, deploymentId: row.id, brokerOrderId: id, reason: entry.signal.reason, error: null, createdAtMs: entry.atMs, updatedAtMs: entry.atMs };
    const stored: StoredMinuteOrder = { request: { clientOrderId: id, symbol, side: entry.side, quantity: entry.quantity, price },
      order: { ...common, id, clientOrderId: id, orderedAtMs: entry.atMs, commission: 0, tax: 0 }, fills: [] };
    db.insert(tradingOrders).values({ id, accountId, deploymentId: row.id, brokerOrderId: id, decisionKey: entry.orderId, payloadJson: JSON.stringify(order), status: order.status, createdAtMs: entry.atMs, updatedAtMs: entry.atMs }).run();
    db.insert(paperTradingOrders).values({ id, accountSlot: slot, payloadJson: JSON.stringify(stored), createdAtMs: entry.atMs }).run();
  }
  const ids = new Set([...fills.map(fill => fill.orderId), ...events.map(event => event.orderId)]);
  for (const signalId of ids) {
    const terminal = events.find(event => event.orderId === signalId);
    const saved = db.select().from(tradingOrders).where(and(eq(tradingOrders.deploymentId, row.id), eq(tradingOrders.decisionKey, signalId))).get();
    if (!saved && terminal?.remainingQty === 0 && terminal.status === "UNFILLED") {
      db.insert(tradingEvents).values({ accountSlot: slot, deploymentId: row.id, actor: "system", severity: "INFO", message: terminal.reason, createdAtMs: terminal.atMs }).run();
      continue;
    }
    if (!saved) throw new Error("분봉 주문 원장에서 원래 신호를 찾을 수 없습니다.");
    const entry = db.select().from(paperTradingOrders).where(and(eq(paperTradingOrders.accountSlot, slot), eq(paperTradingOrders.id, saved.id))).get();
    if (!entry) throw new Error("분봉 모의계좌의 주문 원장이 없습니다.");
    const stored: StoredMinuteOrder = JSON.parse(entry.payloadJson);
    stored.fills.push(...fills.filter(fill => fill.orderId === signalId));
    const filledQuantity = stored.fills.reduce((sum, f) => sum + f.qty, 0);
    const amount = stored.fills.reduce((sum, f) => sum + f.qty * f.price, 0);
    const commission = stored.fills.reduce((sum, f) => sum + f.commission, 0);
    const tax = stored.fills.reduce((sum, f) => sum + f.tax, 0);
    const averageFillPrice = filledQuantity ? amount / filledQuantity : null;
    const status = terminal ? "CANCELLED" : filledQuantity === stored.order.quantity ? "FILLED" : "PARTIAL";
    const updatedAtMs = terminal?.atMs ?? stored.fills.at(-1)!.atMs;
    Object.assign(stored.order, { filledQuantity, averageFillPrice, status, commission, tax });
    const order: TradingOrder = { ...JSON.parse(saved.payloadJson), filledQuantity, averageFillPrice, status, updatedAtMs, error: terminal?.reason ?? null };
    db.update(tradingOrders).set({ payloadJson: JSON.stringify(order), status, appliedQuantity: filledQuantity, appliedAmount: amount, appliedCosts: commission + tax, updatedAtMs }).where(eq(tradingOrders.id, saved.id)).run();
    db.update(paperTradingOrders).set({ payloadJson: JSON.stringify(stored) }).where(eq(paperTradingOrders.id, saved.id)).run();
  }
}

/** 호출자의 실행 임대·개정 확인과 같은 트랜잭션에서 잔고와 체결 진행 위치를 저장한다. */
export function recordMinuteBalance(db: Db, slot: number, row: Row, setup: IntradayTradingSetup, checkpoint: Checkpoint, now: number) {
  const { cash, quantity, averagePrice, lastPrice, entryAt, lastBarMs } = checkpoint.state;
  const { symbol, initialCash } = setup.request;
  const cost = quantity * averagePrice;
  const marketValue = quantity * lastPrice;
  const portfolio = quantity ? { [symbol]: { quantity, cost, enteredAtMs: entryAt } } : {};
  const holdings = quantity ? [{ symbol, name: symbol, quantity, availableQuantity: quantity, averagePrice, price: lastPrice, marketValue, unrealizedPnl: marketValue - cost }] : [];
  db.update(tradingDeployments).set({ checkpoint: JSON.stringify(checkpoint), portfolioJson: JSON.stringify(portfolio),
    realizedPnl: cash - initialCash + cost, lastDecisionAtMs: lastBarMs, updatedAtMs: now,
    activity: "활성 · 확정 분봉 기준 모의매매" + (checkpoint.missingBars ? ` · ${checkpoint.gapDate} 누락 ${checkpoint.missingBars}봉` : "") }).where(eq(tradingDeployments.id, row.id)).run();
  db.update(paperTradingAccount).set({ cash, holdingsJson: JSON.stringify(portfolio) }).where(eq(paperTradingAccount.singleton, slot)).run();
  db.update(tradingControl).set({ snapshotJson: JSON.stringify({ holdings, cashBuyingPower: cash }), syncedAtMs: now, error: null }).where(eq(tradingControl.singleton, slot)).run();
}
