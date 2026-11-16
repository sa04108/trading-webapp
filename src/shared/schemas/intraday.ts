import { z } from "zod";

export const INTRADAY_STRATEGY_ID = "intraday-ema";
export const INTRADAY_STRATEGY_VERSION = "1.0.0";
export const INTRADAY_RETENTION_DAYS = 365;
export const MINUTE_MS = 60_000;
export const intradaySymbolSchema = z
  .string()
  .regex(/^\d{6}$/, "국내 종목 코드 6자리를 입력하세요.");
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  }, "올바른 날짜를 입력하세요.");
export const intradayPeriodSchema = z
  .object({ from: dateSchema, to: dateSchema })
  .strict()
  .refine((p) => p.from <= p.to, "종료일은 시작일 이후여야 합니다.");
export const intradayTimeframeSchema = z.enum(["1m", "5m", "15m"]);
/** 시세 표시 주기는 전략의 신호 주기와 별도로 확장한다. */
export const intradayChartTimeframeSchema = z.enum(["1m", "5m", "10m", "15m", "30m", "1h", "1d", "1w", "1mo"]);
export type IntradayChartTimeframe = z.infer<typeof intradayChartTimeframeSchema>;
export const intradayBarSchema = z
  .object({
    endMs: z
      .number()
      .int()
      .positive()
      .refine((n) => n % MINUTE_MS === 0),
    open: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    high: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    low: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    close: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    volume: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (b) =>
      b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close),
    "봉 가격 범위가 올바르지 않습니다.",
  );
export type IntradayBar = z.infer<typeof intradayBarSchema>;
export const intradayCollectSchema = z
  .object({ symbol: intradaySymbolSchema, period: intradayPeriodSchema })
  .strict();
const riskParameters = {
  allocationPct: z.number().min(1).max(100),
  stopLossPct: z.number().min(0.1).max(50),
  takeProfitPct: z.number().min(0.1).max(100),
};
const requestBase = z
  .object({
    mode: z.literal("intraday"),
    symbol: intradaySymbolSchema,
    period: intradayPeriodSchema,
    timeframe: intradayTimeframeSchema,
    initialCash: z.number().min(10_000).max(1_000_000_000),
    execution: z
      .object({
        holdingPolicy: z.literal("DAY_ONLY"),
        commissionBps: z.number().min(0).max(100),
        taxBps: z.number().min(0).max(100),
        slippageBps: z.number().min(0).max(100),
        latencyMs: z.number().int().min(1).max(60_000),
        orderExpiryMinutes: z.number().int().min(1).max(10),
        maxParticipationPct: z.number().min(0.1).max(10),
      })
      .strict(),
  })
  .strict();
export const intradayRequestSchema = z
  .discriminatedUnion("strategyId", [
    requestBase.extend({
      strategyId: z.literal("intraday-ema"),
      parameters: z
        .object({
          ...riskParameters,
          fast: z.number().int().min(2).max(119),
          slow: z.number().int().min(3).max(120),
        })
        .strict()
        .refine(
          (p) => p.fast < p.slow,
          "단기 EMA는 장기 EMA보다 작아야 합니다.",
        ),
    }),
    requestBase.extend({
      strategyId: z.literal("intraday-orb"),
      parameters: z
        .object({
          ...riskParameters,
          openingMinutes: z.number().int().min(5).max(60),
          entryWindowMinutes: z.number().int().min(15).max(180),
          breakoutBps: z.number().min(0).max(100),
          volumeMultiplier: z.number().min(1).max(5),
        })
        .strict()
        .refine(
          (p) => p.openingMinutes < p.entryWindowMinutes,
          "진입 제한 시간은 시초 범위 형성 시간보다 길어야 합니다.",
        ),
    }),
    requestBase.extend({
      strategyId: z.literal("intraday-vwap-reclaim"),
      parameters: z
        .object({
          ...riskParameters,
          trendPeriod: z.number().int().min(3).max(120),
          volumePeriod: z.number().int().min(2).max(60),
          volumeMultiplier: z.number().min(1).max(5),
        })
        .strict(),
    }),
    requestBase.extend({
      strategyId: z.literal("intraday-bollinger-rsi"),
      parameters: z
        .object({
          ...riskParameters,
          bandPeriod: z.number().int().min(3).max(120),
          bandStdDev: z.number().min(1).max(3),
          rsiPeriod: z.number().int().min(2).max(60),
          oversold: z.number().min(5).max(45),
        })
        .strict(),
    }),
  ])
  .superRefine((r, ctx) => {
    const minutes = Number.parseInt(r.timeframe, 10);
    const warmup =
      r.strategyId === "intraday-ema"
        ? r.parameters.slow
        : r.strategyId === "intraday-vwap-reclaim"
          ? Math.max(r.parameters.trendPeriod, r.parameters.volumePeriod + 1)
          : r.strategyId === "intraday-bollinger-rsi"
            ? Math.max(r.parameters.bandPeriod + 1, r.parameters.rsiPeriod + 2)
            : 0;
    if (warmup * minutes >= 370)
      ctx.addIssue({
        code: "custom",
        message:
          "매일 지표를 초기화하므로 준비 시간이 15:10 진입 마감 이전이어야 합니다. 봉 주기나 지표 기간을 줄여 주세요.",
      });
    if (
      r.strategyId === "intraday-orb" &&
      Math.floor(r.parameters.entryWindowMinutes / minutes) * minutes <=
        r.parameters.openingMinutes
    )
      ctx.addIssue({
        code: "custom",
        message:
          "시초 범위 형성 이후 진입 제한 시간 안에 신호 봉이 하나 이상 있어야 합니다.",
      });
  });
export type IntradayRequest = z.infer<typeof intradayRequestSchema>;
export type IntradayTimeframe = z.infer<typeof intradayTimeframeSchema>;
export type IntradayPeriod = z.infer<typeof intradayPeriodSchema>;

export interface IntradaySymbolData {
  symbol: string;
  bars: number;
  firstEndMs: number | null;
  lastEndMs: number | null;
  revision: string;
  updatedAtMs: number;
}
export interface IntradayCollection {
  id: string;
  symbol: string;
  period: IntradayPeriod;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  fetchedBars: number;
  pages: number;
  oldestEndMs: number | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
export interface IntradayDataOverview {
  configured: boolean;
  retentionDays: number;
  quoteScope: "TOSS_UNSPECIFIED";
  symbols: IntradaySymbolData[];
  collections: IntradayCollection[];
}
export interface IntradayGap {
  fromMs: number;
  toMs: number;
  missingMinutes: number;
}
export interface IntradayChart {
  symbol: string;
  timeframe: IntradayChartTimeframe;
  bars: IntradayBar[];
  revision: string;
  gaps: IntradayGap[];
  totalBars: number;
  truncated: boolean;
}
export interface IntradaySignal {
  id: string;
  atMs: number;
  side: "BUY" | "SELL";
  reason:
    | "EMA"
    | "ORB"
    | "VWAP"
    | "BOLLINGER_RSI"
    | "STOP_LOSS"
    | "TAKE_PROFIT"
    | "DAY_EXIT";
}
export interface IntradayFill {
  orderId: string;
  signalAtMs: number;
  eligibleAtMs: number;
  atMs: number;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  commission: number;
  tax: number;
  reason: IntradaySignal["reason"];
}
export interface IntradayOrderEvent {
  orderId: string;
  atMs: number;
  status: "EXPIRED" | "CANCELLED" | "UNFILLED";
  remainingQty: number;
  reason: string;
}
export interface IntradayEquity {
  endMs: number;
  equity: number;
  cash: number;
  quantity: number;
}
export interface IntradayResult {
  executionVersion?: string;
  request: IntradayRequest;
  strategyVersion: string;
  dataRevision: string;
  quoteScope: "TOSS_UNSPECIFIED";
  adjusted: false;
  session: "09:00–15:20 Asia/Seoul";
  fills: IntradayFill[];
  signals: IntradaySignal[];
  orderEvents: IntradayOrderEvent[];
  equity: IntradayEquity[];
  warnings: string[];
  processedBars: number;
  position: { quantity: number; averagePrice: number; lastPrice: number };
  metrics: {
    pnl: number;
    returnPct: number;
    totalCosts: number;
    maxDrawdownPct: number;
    dailyMaxDrawdownPct: number;
    sharpe: number | null;
    completedTrades: number;
    averageTradePnl: number | null;
    averageHoldingMinutes: number | null;
  };
}
export interface IntradayRun {
  id: string;
  request: IntradayRequest;
  status:
    | "QUEUED"
    | "PREPARING"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  result?: IntradayResult;
}

/** 이력 목록에는 체결·자산 곡선을 전송하지 않고 필요한 지표만 포함한다. */
export interface IntradayRunSummary extends IntradayRun {
  metrics: { returnPct: number; maxDrawdownPct: number; sharpe: number | null } | null;
}

export function intradayDate(endMs: number): string {
  return new Date(endMs + 9 * 3_600_000).toISOString().slice(0, 10);
}
export function intradayPeriodMs(period: IntradayPeriod): {
  fromMs: number;
  toMs: number;
} {
  return {
    fromMs: Date.parse(`${period.from}T00:00:00+09:00`),
    toMs: Date.parse(`${period.to}T23:59:59.999+09:00`),
  };
}
export function intradayRetentionDate(now = Date.now()): string {
  return intradayDate(now - INTRADAY_RETENTION_DAYS * 86_400_000);
}
/** 완전한 하루의 봉을 사용하는 백테스트는 부분 만료된 경계일 다음 날부터 허용한다. */
export function intradayFirstBacktestDate(now = Date.now()): string {
  return intradayDate(now - (INTRADAY_RETENTION_DAYS - 1) * 86_400_000);
}
