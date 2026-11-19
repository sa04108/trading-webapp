import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTradingPresets } from "./api";

type Status = "ACTIVE" | "INACTIVE" | "ERROR";
const labels: Record<Status, string> = { ACTIVE: "활성", INACTIVE: "꺼짐", ERROR: "문제" };

function StatusMarker({ status }: { status: Status }) {
  return <span aria-hidden="true" className={`flex size-3 shrink-0 items-center justify-center rounded-full ${status === "ACTIVE" ? "bg-emerald-500" : status === "INACTIVE" ? "border-2 border-gray-400" : "bg-red-600 text-[9px] font-bold leading-none text-white"}`}>{status === "ERROR" ? "!" : null}</span>;
}

export function TradingDashboardCard() {
  const { data, isLoading, error } = useTradingPresets();
  return <Card><CardHeader><CardTitle className="text-base">모의투자</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
    {isLoading ? <p>불러오는 중…</p> : error ? <p role="alert">모의투자 목록을 불러오지 못했습니다.</p> : data?.presets.length ? <ul className="divide-y">{data.presets.map((preset) => <li key={preset.id}><Link className="flex min-h-11 min-w-0 items-center gap-3 rounded hover:underline focus-visible:outline" to={`/trading?presetId=${encodeURIComponent(preset.id)}`}><StatusMarker status={preset.status} /><span className="truncate">{preset.title}</span><span className="sr-only"> · {labels[preset.status]}</span></Link></li>)}</ul> : <p>등록된 모의투자가 없습니다.</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="모의투자 상태 표시">{(["ACTIVE", "INACTIVE", "ERROR"] as const).map((status) => <span className="flex items-center gap-1.5" key={status}><StatusMarker status={status} />{labels[status]}</span>)}</div>
    <Link className="underline underline-offset-4" to="/trading">매매 관리</Link>
  </CardContent></Card>;
}
