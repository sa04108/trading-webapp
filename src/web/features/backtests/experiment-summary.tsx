import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { formatNumber } from "@/lib/format";
import { useBacktestHistoryExtras } from "./experiment-api";

export function ExperimentSummary({ jobId }: { jobId: string }) {
  const query = useBacktestHistoryExtras([jobId]);
  const summary = query.data?.summaries[0];
  const entries = [
    { title: "난수 시드 실험", path: "seeds", count: summary?.seed.batchCount, active: summary?.seed.activeCount,
      samples: summary?.seed.returns.count, deviation: summary?.seed.returns.sampleStdDev,
      help: "같은 설정에서 난수 시드를 바꿔 결과의 민감도를 확인합니다. 모든 실험의 유효한 완료 실행 수익률로 표본 표준편차를 계산합니다. 표본이 두 개 미만이면 —로 표시합니다.", metric: "수익률 표준편차" },
    { title: "기간검증", path: "validations", count: summary?.validation.experimentCount, active: summary?.validation.activeCount,
      samples: summary?.validation.returns.count, deviation: summary?.validation.returns.sampleStdDev,
      help: "홀드아웃·최적화 홀드아웃·워크포워드로 별도 기간의 성과를 확인합니다. 완료된 실험마다 OOS 구간 수익률의 평균을 구한 뒤 실험 간 표본 표준편차를 계산합니다. 독립 실행 구간을 연속 수익률로 합산하지 않습니다. 표본이 두 개 미만이면 —로 표시합니다.", metric: "OOS 수익률 표준편차" },
  ];
  return <section aria-label="백테스트 실험" className="grid gap-3 md:grid-cols-2">
    {entries.map((entry) => <Card key={entry.path}>
      <CardHeader><CardTitle className="flex items-center gap-1 text-sm">{entry.title}<InfoHint label={`${entry.title} 안내`}>{entry.help}</InfoHint></CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {query.isError ? <p role="alert" className="text-sm text-destructive">요약을 불러오지 못했습니다. <button className="underline" onClick={() => void query.refetch()}>다시 시도</button></p> : !summary ?
          <p className="text-sm text-muted-foreground">요약을 불러오는 중…</p> : <>
            <p className="text-sm">기록 {entry.count}개{entry.active ? ` · 진행 중 ${entry.active}개` : ""}</p>
            <p className="text-sm text-muted-foreground">{entry.metric} {entry.deviation == null ? "—" : `${formatNumber(entry.deviation)}%p`} · 유효 표본 {entry.samples}개</p>
          </>}
        <Button variant="outline" asChild><Link to={`/backtests/${encodeURIComponent(jobId)}/${entry.path}`}>{entry.title} 열기</Link></Button>
      </CardContent>
    </Card>)}
  </section>;
}
