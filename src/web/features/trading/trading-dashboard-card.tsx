import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { tradingStatusLabel } from "./status-labels";
import { useTrading } from "./api";

export function TradingDashboardCard() {
  const { data, isLoading, error } = useTrading();
  const money = (value: number | null | undefined) => value == null ? "—" : `${value.toLocaleString()}원`;
  return <Card><CardHeader><CardTitle className="text-base">모의투자와 매매 상태</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
    {isLoading ? <p>불러오는 중…</p> : error ? <p role="alert">매매 정보를 불러오지 못했습니다.</p> : <>
      <p>전략: {data?.deployment ? `${data.deployment.name} · ${tradingStatusLabel[data.deployment.status]}` : "등록된 전략 없음"}</p>
      <p>보유 평가액 {money(data?.account?.marketValue)} · 평가손익 {money(data?.account?.unrealizedPnl)} · 총 손익 {money(data?.performance?.totalPnl)}</p>
      <p>전략 추정 수익률 {data?.performance?.returnPercent == null ? "—" : `${data.performance.returnPercent.toFixed(2)}%`}</p>
      {data?.deployment?.lastError ? <p role="alert" className="text-destructive">{data.deployment.lastError}</p> : null}
      <p className="text-muted-foreground">최근 갱신: {data?.broker.lastSyncAtMs ? new Date(data.broker.lastSyncAtMs).toLocaleString() : "기록 없음"}{data?.broker.error ? ` · ${data.broker.error}` : ""}</p>
    </>}
    <Link className="underline underline-offset-4" to="/trading">매매 관리</Link>
  </CardContent></Card>;
}
