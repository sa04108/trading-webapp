import { z } from "zod";
import { universeRuleSchema } from "./universe-rule.js";
import type { IntradayRequest, IntradayTimeframe } from "./intraday.js";

export const PAPER_TRADING_ACCOUNT_ID = "PAPER";
export const paperTradingAccountId = (slot: number): string => slot === 1 ? PAPER_TRADING_ACCOUNT_ID : `PAPER-${slot}`;
export const PAPER_TRADING_INITIAL_CASH_KRW = 100_000_000;
export const paperInitialCashSchema = z.number().int().min(10_000).max(1_000_000_000_000);

export interface TradingQuote {
  symbol: string;
  price: number;
  timestampMs: number;
}

export const tradingSetupSchema = z.object({
  title: z.string().trim().max(100).optional(),
  strategyId: z.string().min(1).max(100),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.record(z.string(), z.unknown()),
  universeRule: universeRuleSchema,
  timeframe: z.literal("1d"),
  budgetKrw: z.number().int().min(10_000).max(1_000_000_000_000),
  maxPositions: z.number().int().min(1).max(200),
  maxPositionPercent: z.number().positive().max(100),
  dailyLossLimitPercent: z.number().positive().max(100),
  maxOrderKrw: z.number().int().min(1_000).max(1_000_000_000_000),
  maxSlippageBps: z.number().int().min(0).max(500),
  randomSeed: z.number().int().min(0).max(4_294_967_295),
  sourceJobId: z.string().max(100).nullable().default(null),
  paperCommissionProfileId: z.enum(["kr-equity-default", "zero-cost"]).optional(),
  paperSlippageProfileId: z.enum(["fixed-5bps", "zero-slippage"]).optional(),
}).strict();

export type TradingSetup = z.infer<typeof tradingSetupSchema>;
export type TradingStatus = "INACTIVE" | "ACTIVE" | "STOPPING" | "ERROR";

export interface TradingPresetSummary {
  id: string;
  title: string;
  status: "ACTIVE" | "INACTIVE" | "ERROR";
  createdAtMs: number;
}

export interface TradingArtifact {
  strategyId: string;
  name: string;
  description: string;
  version: string;
  artifactHash: string;
  executionVersion: string;
  parameterSchema: Record<string, unknown>;
  latest: boolean;
}

export interface TradingDeployment extends TradingSetup {
  id: string;
  name: string;
  version: string;
  status: TradingStatus;
  createdAtMs: number;
  updatedAtMs: number;
  activatedAtMs: number | null;
  lastDecisionAtMs: number | null;
  lastError: string | null;
  activity: string;
  latestArtifactHash: string | null;
  latestVersion: string | null;
}

export interface IntradayTradingSetup {
  kind: "intraday";
  title?: string;
  sourceRunId: string;
  executionVersion: string;
  request: IntradayRequest;
}

export interface IntradayTradingDeployment extends IntradayTradingSetup,
  Pick<TradingDeployment, "id" | "name" | "version" | "status" | "createdAtMs" | "updatedAtMs" | "activatedAtMs" | "lastDecisionAtMs" | "lastError" | "activity"> {
  timeframe: IntradayTimeframe;
  strategyId: IntradayRequest["strategyId"];
}

export interface TradingPosition {
  symbol: string;
  name: string;
  quantity: number;
  availableQuantity: number | null;
  averagePrice: number;
  price: number;
  marketValue: number;
  unrealizedPnl: number;
  returnPercent: number | null;
  deploymentId: string | null;
}

export type TradingOrderStatus = "CREATED" | "SENDING" | "UNKNOWN" | "OPEN" | "PARTIAL" | "FILLED" | "CANCEL_REQUESTED" | "CANCELLED" | "REJECTED";
export interface TradingOrder {
  id: string;
  deploymentId: string;
  brokerOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  status: TradingOrderStatus;
  reason: string;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TradingEvent {
  id: number;
  createdAtMs: number;
  severity: "INFO" | "WARNING" | "ERROR";
  message: string;
}

export interface TradingToggle {
  id: string;
  action: "activate" | "deactivate";
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  message: string;
}

export interface TradingSnapshot {
  toggleJob?: TradingToggle | null;
  revision: number;
  dataPreparation: {
    status: "RUNNING" | "READY" | "FAILED";
    message: string;
  } | null;
  paperCapital: { initialCashKrw: number; canEdit: boolean } | null;
  deployment: TradingDeployment | IntradayTradingDeployment | null;
  broker: {
    provider: "TOSS" | "PAPER";
    configured: boolean;
    accounts: { id: string; label: string }[];
    selectedAccountId: string | null;
    lastSyncAtMs: number | null;
    error: string | null;
  };
  account: {
    cashBuyingPower: number;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedReturnPercent: number | null;
  } | null;
  performance: {
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    returnPercent: number | null;
  } | null;
  positions: TradingPosition[];
  orders: TradingOrder[];
  events: TradingEvent[];
  blockers: string[];
}

export interface TradingSource {
  setup: TradingSetup | null;
  strategyName: string;
  strategyVersion: string;
  error: string | null;
}

export const tradingRevisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const tradingWriteSchema = tradingSetupSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
  initialCashKrw: paperInitialCashSchema.optional(),
});

export const tradingPresetCreateSchema = tradingWriteSchema.extend({ expectedRevision: z.literal(0), requestId: z.string().uuid() });
export const intradayTradingPresetSchema = z.object({
  sourceRunId: z.string().min(1).max(100),
  requestId: z.string().uuid(),
  title: z.string().trim().max(100).optional(),
}).strict();
export const tradingPresetTitleSchema = tradingRevisionSchema.extend({
  deploymentId: z.string().uuid(),
  expectedTitle: z.string().max(100),
  title: z.string().trim().max(100),
});
