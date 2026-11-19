import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { TradingArtifact, TradingPresetSummary, TradingSnapshot, TradingSource } from "@shared/schemas/trading";

export const tradingKey = (presetId: string | null) => ["trading", "snapshot", presetId] as const;
export const tradingPresetsKey = ["trading", "presets"] as const;
export const tradingPath = (path: string, presetId: string | null) => presetId === null ? path : `${path}?presetId=${encodeURIComponent(presetId)}`;
export function useTrading(presetId: string | null = null) {
  return useQuery({ queryKey: tradingKey(presetId), queryFn: () => api<TradingSnapshot>(tradingPath("/trading", presetId)), refetchInterval: query => query.state.data?.toggleJob?.status === "RUNNING" ? 1_000 : 5_000 });
}
export function useTradingPresets() {
  return useQuery({ queryKey: tradingPresetsKey, queryFn: () => api<{ presets: TradingPresetSummary[]; archived?: TradingPresetSummary[]; defaultAccountPresetId?: string | null }>("/trading/presets"), refetchInterval: 5_000 });
}
export function useTradingArtifacts() {
  return useQuery({ queryKey: ["trading", "strategies"], queryFn: () => api<{ strategies: TradingArtifact[] }>("/trading/strategies") });
}
export function useTradingSource(id: string | null) {
  return useQuery({ queryKey: ["trading", "source", id], queryFn: () => api<TradingSource>(`/trading/source/${encodeURIComponent(id!)}`), enabled: id !== null });
}
