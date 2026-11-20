import { z } from "zod";
import type { CryptoBacktestInput, CryptoBacktestResult } from "./crypto-backtest.js";

export const cryptoPaperSettingsSchema = z
  .object({ sourceRunId: z.uuid(), initialCash: z.number().positive().max(1e15).optional() })
  .strict();
export const cryptoPaperActiveSchema = z.object({ active: z.boolean() }).strict();

export const cryptoPaperVersionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    targetVersion: z.string().min(1).max(128),
  })
  .strict();

export interface CryptoPaperAccount {
  sourceRunId: string;
  strategyVersion: string;
  latestStrategyVersion: string;
  versionUpdateBlocker: string | null;
  revision: number;
  input: CryptoBacktestInput;
  active: boolean;
  initialCash: number;
  cash: number;
  holding: { market: string; quantity: number; lastClose: number } | null;
  equity: number;
  trades: CryptoBacktestResult["trades"];
  lastSession: string | null;
  updatedAtMs: number;
  valuedAtMs: number | null;
  error: string | null;
}
