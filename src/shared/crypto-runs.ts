import type { CryptoBacktestInput, CryptoBacktestResult } from "./crypto-backtest.js";

export type CryptoRunStatus = "COLLECTING" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface CryptoRunSummary {
  id: string;
  input: CryptoBacktestInput;
  status: CryptoRunStatus;
  createdAtMs: number;
  executor: string | null;
  error: string | null;
}
export interface CryptoRunDetail extends CryptoRunSummary {
  datasetHash: string | null;
  strategyVersion: string;
  result: CryptoBacktestResult | null;
}
