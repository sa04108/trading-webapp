import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { TradingArtifact, TradingSnapshot, TradingSource } from "@shared/schemas/trading";

export const tradingKey = ["trading"] as const;
export function useTrading() {
  return useQuery({ queryKey: tradingKey, queryFn: () => api<TradingSnapshot>("/trading"), refetchInterval: 5_000 });
}
export function useTradingArtifacts() {
  return useQuery({ queryKey: ["trading", "strategies"], queryFn: () => api<{ strategies: TradingArtifact[] }>("/trading/strategies") });
}
export function useTradingSource(id: string | null) {
  return useQuery({ queryKey: ["trading", "source", id], queryFn: () => api<TradingSource>(`/trading/source/${encodeURIComponent(id!)}`), enabled: id !== null });
}
