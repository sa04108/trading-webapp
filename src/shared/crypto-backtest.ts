import { z } from "zod";
import { isoDateSchema } from "./schemas/backtest-request.js";

export const CRYPTO_STRATEGY_VERSION = "upbit-turnover-momentum-v1";

export const cryptoBacktestInputSchema = z
  .object({
    markets: z
      .array(
        z
          .string()
          .max(24)
          .regex(/^KRW-[A-Z0-9]+$/, "원화 마켓 형식이 올바르지 않습니다"),
      )
      .min(1)
      .max(40)
      .refine((markets) => new Set(markets).size === markets.length, "마켓은 중복될 수 없습니다"),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    initialCash: z.number().finite().positive().max(1e15),
    universeSize: z.number().int().min(1).max(40),
    lookbackDays: z.number().int().min(1).max(365),
    feeBps: z.number().finite().min(0).max(9999),
    slippageBps: z.number().finite().min(0).max(9999),
  })
  .superRefine((input, ctx) => {
    if (input.startDate > input.endDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "종료일은 시작일보다 빠를 수 없습니다" });
    }
    if (
      Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) >
      365 * 86_400_000
    ) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "백테스트 기간은 최대 366일입니다" });
    }
    if (input.universeSize > input.markets.length) {
      ctx.addIssue({
        code: "custom",
        path: ["universeSize"],
        message: "유니버스 크기는 마켓 수를 초과할 수 없습니다",
      });
    }
  });

export type CryptoBacktestInput = z.infer<typeof cryptoBacktestInputSchema>;

export interface CryptoDailyBar {
  market: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number;
}

export const cryptoBacktestResultSchema = z.object({
  equityCurve: z
    .array(z.object({ date: isoDateSchema, equity: z.number().finite().nonnegative() }))
    .min(1)
    .max(366),
  trades: z
    .array(
      z.object({
        date: isoDateSchema,
        market: z
          .string()
          .max(24)
          .regex(/^KRW-[A-Z0-9]+$/),
        side: z.enum(["BUY", "SELL"]),
        quantity: z.number().finite().positive(),
        price: z.number().finite().positive(),
        fee: z.number().finite().nonnegative(),
      }),
    )
    .max(732),
  totalReturn: z.number().finite(),
  maxDrawdown: z.number().finite().min(0).max(1),
  finalEquity: z.number().finite().nonnegative(),
  warnings: z.array(z.string().max(200)).max(44),
});

export type CryptoBacktestResult = z.infer<typeof cryptoBacktestResultSchema>;
