import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isFinishedJob, type JobResponse } from "@shared/schemas/jobs";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { useJob } from "./api";
import { JobProgressDisplay, JobStatusBadge } from "./job-display";

export function JobDetailPage() {
  const { id = "" } = useParams();
  const query = useJob(id);
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api<JobResponse>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["jobs", "detail", id], data);
      void queryClient.invalidateQueries({ queryKey: ["jobs", "list"] });
    },
  });
  const job = query.data?.job;
  return <Card>
    <CardHeader>
      <div><Button variant="ghost" size="sm" asChild><Link to="/jobs">← 작업 목록</Link></Button></div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="min-w-0 wrap-anywhere">{job?.title ?? "작업 상세"}</CardTitle>
        {job && !isFinishedJob(job.status) && job.status !== "CANCELLING" && job.cancellable && <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "취소 요청 중…" : "작업 취소"}</Button>}
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      {query.isError && <div role="alert" className="flex flex-wrap items-center gap-2 wrap-anywhere text-sm text-destructive">작업을 불러오지 못했습니다: {query.error.message}<Button size="sm" variant="outline" onClick={() => void query.refetch()}>다시 불러오기</Button></div>}
      {cancel.isError && <p role="alert" className="wrap-anywhere text-sm text-destructive">취소 실패: {cancel.error.message}</p>}
      {query.isLoading && <p className="text-sm text-muted-foreground">불러오는 중…</p>}
      {job && <>
        <JobStatusBadge status={job.status} />
        {job.description && <p className="whitespace-pre-wrap wrap-anywhere text-sm">{job.description}</p>}
        {job.phase && <p className="text-sm"><span className="text-muted-foreground">단계: </span>{job.phase}</p>}
        <JobProgressDisplay progress={job.progress} />
        {job.error && <div className="text-sm"><p className="font-medium text-destructive">오류</p><p className="whitespace-pre-wrap wrap-anywhere">{job.error}</p></div>}
        <dl className="grid gap-2 text-sm text-muted-foreground">
          <div><dt className="inline">생성: </dt><dd className="inline">{formatDateTime(job.createdAtMs)}</dd></div>
          <div><dt className="inline">갱신: </dt><dd className="inline">{formatDateTime(job.updatedAtMs)}</dd></div>
          {job.finishedAtMs !== null && <div><dt className="inline">종료 기록: </dt><dd className="inline">{formatDateTime(job.finishedAtMs)}</dd></div>}
        </dl>
        {job.link && <Button variant="outline" asChild><Link to={job.link}>원본 보기</Link></Button>}
      </>}
    </CardContent>
  </Card>;
}
