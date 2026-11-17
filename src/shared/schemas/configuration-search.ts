import { z } from "zod";
import type { BacktestRequest } from "./backtest-request.js";
import type { IntradayRequest } from "./intraday.js";

export const searchValueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
export type SearchValue = z.infer<typeof searchValueSchema>;
export const searchSettingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RANGE"), min: z.number().finite(), max: z.number().finite(), includeUnset: z.boolean().optional() }).strict()
    .refine((value) => value.min <= value.max, "최소값은 최대값 이하여야 합니다."),
  z.object({ kind: z.literal("CHOICE"), values: z.array(searchValueSchema).min(1).max(100) }).strict(),
]);
export const configurationSearchConfigSchema = z.object({
  count: z.number().int().min(1).max(100),
  settings: z.record(z.string().min(1).max(160), searchSettingSchema)
    .refine((settings) => Object.keys(settings).length > 0 && Object.keys(settings).length <= 100, "탐색할 설정을 1~100개 선택하세요."),
}).strict();
export const configurationSearchPreviewSchema = z.object({ requestId: z.string().uuid(), config: configurationSearchConfigSchema }).strict();
export type ConfigurationSearchConfig = z.infer<typeof configurationSearchConfigSchema>;
export type SearchSetting = z.infer<typeof searchSettingSchema>;
export type ConfigurationSearchMode = "daily" | "intraday";
export type ConfigurationSearchRequest = BacktestRequest | IntradayRequest;

interface SearchFieldBase {
  key: string;
  label: string;
  group: "strategy" | "universe" | "execution" | "seed";
  current: SearchValue;
  description?: string;
}
export type ConfigurationSearchField = SearchFieldBase & (
  { kind: "number"; min: number; max: number; step: number; integer: boolean; recommended: [number, number]; allowUnset?: boolean }
  | { kind: "choice"; options: { value: SearchValue; label: string }[]; recommended: SearchValue[] }
);
export interface ConfigurationSearchCatalog {
  mode: ConfigurationSearchMode;
  sourceJobId: string;
  strategyId: string;
  strategyName: string;
  period: { from: string; to: string };
  fields: ConfigurationSearchField[];
  maxCount: 100;
}
export type ConfigurationSearchStatus = "PREVIEW" | "ACTIVE" | "CANCELLING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ConfigurationSearchItemStatus = "PENDING" | "PREPARING" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface ConfigurationSearchSummary {
  id: string;
  sourceJobId: string;
  mode: ConfigurationSearchMode;
  strategyId: string;
  strategyName: string;
  period: { from: string; to: string };
  config: ConfigurationSearchConfig;
  status: ConfigurationSearchStatus;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  runningCount: number;
  createdAtMs: number;
  completedAtMs: number | null;
  error: string | null;
  sourceHref: string;
}
export interface ConfigurationSearchItem {
  id: string;
  ordinal: number;
  status: ConfigurationSearchItemStatus;
  values: Record<string, SearchValue>;
  request: ConfigurationSearchRequest;
  jobId: string | null;
  resultHref: string | null;
  error: string | null;
  metrics: { totalReturnPct: number; mddPct: number; sharpeRatio: number | null } | null;
}
export interface ConfigurationSearchDetail extends ConfigurationSearchSummary {
  items: ConfigurationSearchItem[];
  catalog: ConfigurationSearchCatalog;
}
