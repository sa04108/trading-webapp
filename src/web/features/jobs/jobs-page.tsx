import { usePaginationPosition } from "@/components/use-pagination-position";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isFinishedJob, type JobFilter } from "@shared/schemas/jobs";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/format";
import { useJobs } from "./api";
import { JobProgressDisplay, JobStatusBadge } from "./job-display";

const filters: { value: JobFilter; label: string }[] = [
  { value: "all", label: "전체" }, { value: "active", label: "진행 중" }, { value: "finished", label: "종료됨" },
];

export function JobsPage() {
  const [filter, setFilter] = useState<JobFilter>("all");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const queryClient = useQueryClient();
  const query = useJobs(filter, offset);
  const preservePosition = usePaginationPosition(offset, query.isPlaceholderData);
  const jobs = query.data?.jobs ?? [];
  const pageOffset = query.data?.offset ?? offset;
  const finished = jobs.filter((job) => isFinishedJob(job.status));
  const selectedIds = finished.filter((job) => selected.has(job.id)).map((job) => job.id);
  const allSelected = finished.length > 0 && selectedIds.length === finished.length;
  const remove = useMutation({
    mutationFn: (ids: string[]) => api<void>("/jobs", { method: "DELETE", body: JSON.stringify({ ids }) }),
    onSuccess: () => {
      setSelected(new Set());
      setEditing(false);
      if (pageOffset > 0 && jobs.length === selectedIds.length) setOffset(Math.max(0, pageOffset - 50));
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["jobs"] }); },
  });
  const changeFilter = (value: JobFilter) => {
    setFilter(value); setOffset(0); setSelected(new Set()); setEditing(false); remove.reset();
  };
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>작업</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {editing && <>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox disabled={query.isPlaceholderData} checked={allSelected} onCheckedChange={() => setSelected(allSelected ? new Set() : new Set(finished.map((job) => job.id)))} aria-label="종료된 작업 전체 선택" /> 전체 선택
              </label>
              <Button variant="destructive" size="sm" disabled={!selectedIds.length || remove.isPending || query.isPlaceholderData} onClick={() => remove.mutate(selectedIds)}>삭제 ({selectedIds.length})</Button>
            </>}
            {finished.length > 0 && <Button variant="outline" size="sm" disabled={query.isPlaceholderData} onClick={() => { setEditing(!editing); setSelected(new Set()); remove.reset(); }}>{editing ? "완료" : "편집"}</Button>}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{query.data?.retentionDays === 0 ? "종료된 작업 기록은 자동으로 삭제되지 않습니다." : `종료된 작업 기록은 ${query.data?.retentionDays ?? 7}일간 보관됩니다.`} 기록을 삭제해도 원본 결과와 데이터는 유지됩니다.</p>
        <div className="flex flex-wrap gap-2" aria-label="작업 필터">
          {filters.map(({ value, label }) => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => changeFilter(value)}>{label}</Button>)}
        </div>
        {remove.isError && <p role="alert" className="wrap-anywhere text-sm text-destructive">삭제 실패: {remove.error.message}</p>}
        {cancel.isError && <p role="alert" className="wrap-anywhere text-sm text-destructive">취소 실패: {cancel.error.message}</p>}
      </CardHeader>
      <CardContent className="p-0">
        {query.isError && <div role="alert" className="flex flex-wrap items-center gap-2 px-6 py-3 text-sm wrap-anywhere text-destructive">작업을 불러오지 못했습니다: {query.error.message}<Button size="sm" variant="outline" onClick={() => void query.refetch()}>다시 불러오기</Button></div>}
        <div data-pagination-content>
        {query.isLoading ? <p className="px-6 py-8 text-sm text-muted-foreground">불러오는 중…</p> : jobs.length === 0 && !query.isError ? <p className="px-6 py-8 text-sm text-muted-foreground">작업이 없습니다.</p> : <ul className="divide-y">
          {jobs.map((job) => <li key={job.id} className="flex flex-wrap items-start gap-3 px-6 py-3 hover:bg-muted/50">
            {editing && isFinishedJob(job.status) && <Checkbox className="mt-1" disabled={query.isPlaceholderData} checked={selected.has(job.id)} aria-label={`${job.title} 선택`} onCheckedChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(job.id)) next.delete(job.id); else next.add(job.id); return next; })} />}
            <Link to={`/jobs/${encodeURIComponent(job.id)}`} className="min-w-0 flex-[1_1_14rem] rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-words text-sm font-medium">{job.title}</span><JobStatusBadge status={job.status} /></div>
              {job.description && <p className="truncate text-sm text-muted-foreground">{job.description}</p>}
              {job.phase && <p className="wrap-anywhere text-sm text-muted-foreground">{job.phase}</p>}
              <JobProgressDisplay progress={job.progress} />
              <p className="mt-1 text-xs text-muted-foreground">{formatRelativeTime(job.createdAtMs, Date.now())}</p>
            </Link>
            <div className="ml-auto flex shrink-0 gap-2">
              {job.link && <Button variant="outline" size="sm" asChild><Link to={job.link} aria-label={`${job.title} 작업 열기`}>작업 열기</Link></Button>}
              {!isFinishedJob(job.status) && job.status !== "CANCELLING" && job.cancellable && <Button variant="outline" size="sm" disabled={cancel.isPending || query.isPlaceholderData} aria-label={`${job.title} 취소`} onClick={() => cancel.mutate(job.id)}>취소</Button>}
            </div>
          </li>)}
        </ul>}
        </div>
        {query.data && query.data.total > 50 && <nav data-pagination-controls aria-label="작업 페이지 이동" className="flex items-center justify-between gap-2 border-t px-6 py-3 text-sm"><Button variant="outline" size="sm" disabled={pageOffset === 0 || query.isPlaceholderData} onClick={(event) => { preservePosition(event.currentTarget); setOffset(Math.max(0, pageOffset - 50)); setSelected(new Set()); }}>이전</Button><span>{pageOffset + 1}–{Math.min(pageOffset + jobs.length, query.data.total)} / {query.data.total}</span><Button variant="outline" size="sm" disabled={pageOffset + jobs.length >= query.data.total || query.isPlaceholderData} onClick={(event) => { preservePosition(event.currentTarget); setOffset(pageOffset + 50); setSelected(new Set()); }}>다음</Button></nav>}
      </CardContent>
    </Card>
  );
}
