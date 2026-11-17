import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import type { TradingQuote } from "@shared/schemas/trading";
import { IntradayChartView } from "../intraday/intraday-chart";

type Holding = { symbol: string; name: string };

export function HoldingPriceDialog({ holding, onClose }: { holding: Holding | null; onClose: () => void }) {
  const quote = useQuery({
    queryKey: ["trading", "quote", holding?.symbol],
    queryFn: () => api<TradingQuote>(`/trading/quotes/${encodeURIComponent(holding!.symbol)}`),
    enabled: holding !== null,
    refetchInterval: holding ? 5_000 : false,
    retry: false,
  });
  const today = new Date();
  const to = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(today);
  const from = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(today.getTime() - 30 * 86400_000));
  return <Dialog open={holding !== null} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>{holding?.name} ({holding?.symbol})</DialogTitle><DialogDescription>시세는 5초마다 조회하며 제공 시각을 확인하세요. 차트는 이전에 수집된 시세이며 현재 시세가 아닙니다.</DialogDescription></DialogHeader>
    {quote.error ? <p role="alert" className="text-sm text-destructive">시세를 불러오지 못했습니다.</p> : quote.data ? <p className="text-sm">최근 시세 <strong>{quote.data.price.toLocaleString()}원</strong> · 제공 시각 {new Date(quote.data.timestampMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST{(Date.now() - quote.data.timestampMs > 30_000 || quote.data.timestampMs > Date.now() + 5_000) ? " · 오래된 시세" : ""}</p> : <p role="status">시세 불러오는 중…</p>}
    {holding && <IntradayChartView symbol={holding.symbol} from={from} to={to} timeframe="5m" />}
  </DialogContent></Dialog>;
}
