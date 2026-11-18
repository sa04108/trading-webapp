import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Circle, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, apiErrorMessage } from "@/lib/api-client";
import { backtestRefreshActionLabel, isBacktestRefreshFinished, type BacktestRefreshAction, type BacktestRefreshJob } from "../../../shared/schemas/backtest-refresh.js";
import { usePreparationLive } from "./preparation-live";
import { preparationStatusDescription } from "./preparation-progress";

export function isRefreshRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && (error.message === "PREPARATION_REQUIRED" || error.message === "PREVIEW_REQUIRED");
}

type Pending = { sourceId: string; action: BacktestRefreshAction; reason: string; requestId: string; storageKey: string };

const pendingIds = new Map<string, string>();
const clearedIds = new Set<string>();

export function pendingRequest(sourceId: string, action: BacktestRefreshAction, reason: string): Pending {
  const frozenAction = structuredClone(action);
  const storageKey = `backtest-refresh:${sourceId}:${JSON.stringify(frozenAction)}`;
  let requestId = pendingIds.get(storageKey);
  if (!requestId && !clearedIds.has(storageKey)) {
    try { requestId = sessionStorage.getItem(storageKey) ?? undefined; } catch { /* 저장소를 사용할 수 없으면 메모리에 보관한다. */ }
  }
  requestId ??= crypto.randomUUID();
  pendingIds.set(storageKey, requestId);
  clearedIds.delete(storageKey);
  try { sessionStorage.setItem(storageKey, requestId); } catch { /* 같은 화면의 재시도는 메모리의 ID를 사용한다. */ }
  return { sourceId, action: frozenAction, reason, requestId, storageKey };
}

function clearPendingRequest(storageKey: string): void {
  pendingIds.delete(storageKey);
  clearedIds.add(storageKey);
  try { sessionStorage.removeItem(storageKey); } catch { /* 서버가 수락한 작업을 실패로 표시하지 않는다. */ }
}

function confirmationLabel(action: BacktestRefreshAction | undefined): string {
  switch (action?.kind) {
    case "CLONE": return "업데이트 후 복제";
    case "PERIOD_VALIDATION": return "업데이트 후 기간검증";
    default: return "업데이트 후 실행";
  }
}

export function useBacktestRefresh(sourceId: string, initialJobId?: string | null) {
  const [open, setOpen] = useState(Boolean(initialJobId));
  const [pending, setPending] = useState<Pending | null>(null);
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const navigated = useRef<string | null>(null);
  const generation = useRef(0);
  const previousSourceId = useRef(sourceId);
  useEffect(() => {
    if (previousSourceId.current === sourceId) return;
    previousSourceId.current = sourceId;
    generation.current += 1;
    setPending(null);
    setError(null);
    setJobId(initialJobId ?? null);
    setOpen(Boolean(initialJobId));
  }, [sourceId, initialJobId]);
  useEffect(() => {
    if (!initialJobId) return;
    generation.current += 1;
    setJobId(initialJobId);
    setPending(null);
    setError(null);
    setOpen(true);
  }, [initialJobId]);
  const client = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["backtest-refresh-job", jobId],
    queryFn: () => api<{ job: BacktestRefreshJob }>(`/backtests/refresh-jobs/${encodeURIComponent(jobId!)}`),
    enabled: open && jobId !== null,
    refetchInterval: (q) => q.state.data?.job && isBacktestRefreshFinished(q.state.data.job.status) ? false : 2000,
  });
  const job = query.data?.job;
  const preparation = usePreparationLive(open ? job?.preparationJobId ?? null : null);
  useEffect(() => {
    if (!open || !job || job.status !== "COMPLETED" || !job.resultHref || navigated.current === job.id) return;
    navigated.current = job.id;
    setOpen(false);
    void client.invalidateQueries({ queryKey: ["backtests"] });
    void client.invalidateQueries({ queryKey: ["backtest-experiments"] });
    void client.invalidateQueries({ queryKey: ["period-validations"] });
    void navigate(job.resultHref);
  }, [open, job, client, navigate]);
  const offer = (action: BacktestRefreshAction, cause: ApiError) => {
    generation.current += 1;
    setPending(pendingRequest(sourceId, action, apiErrorMessage(cause, "원본 실행 이후 데이터가 변경되어 유니버스를 다시 준비해야 합니다.")));
    setJobId(null);
    setError(null);
    setOpen(true);
  };
  const run = async (operation: () => Promise<{ job: BacktestRefreshJob }>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const startedGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      client.setQueryData(["backtest-refresh-job", result.job.id], result);
      if (generation.current === startedGeneration) setJobId(result.job.id);
    } catch (cause) {
      if (generation.current === startedGeneration) setError(cause instanceof Error ? cause.message : "요청에 실패했습니다. 다시 시도해 주세요.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const start = () => {
    if (!pending) return;
    void run(async () => {
      const result = await api<{ job: BacktestRefreshJob }>(`/backtests/${encodeURIComponent(pending.sourceId)}/refresh-and-run`, { method: "POST", body: JSON.stringify({ requestId: pending.requestId, action: pending.action }) });
      clearPendingRequest(pending.storageKey);
      return result;
    });
  };
  const cancel = () => {
    if (jobId) void run(() => api(`/backtests/refresh-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
  };
  const retry = () => {
    if (jobId) void run(() => api(`/backtests/refresh-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" }));
  };
  const action = job?.action ?? pending?.action;
  const running = job && !isBacktestRefreshFinished(job.status);
  const failed = job?.status === "FAILED" || job?.status === "CANCELLED";
  const progressValue = job?.status === "PREPARING" ? preparation.job?.overallProgress : undefined;
  const progress = typeof progressValue === "number" && Number.isFinite(progressValue)
    ? Math.min(100, Math.max(0, Math.floor(progressValue))) : null;
  const title = !job ? "최신 데이터로 이어서 실행할까요?"
    : failed ? (job.status === "FAILED" ? "데이터 준비에 실패했습니다" : "작업이 취소되었습니다")
      : job.status === "SUBMITTING" ? "실행을 준비하고 있습니다" : "최신 데이터로 준비 중";
  const modal = <Dialog open={open} onOpenChange={setOpen}>
    <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[460px]">
      <div className="space-y-4 px-6 pb-5 pt-6">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{job ? "선택한 설정으로 유니버스를 준비하고 이어서 실행합니다." : pending?.reason}</DialogDescription>
        </DialogHeader>
        {!job && !jobId ? <>
          <div className="space-y-3 rounded-lg bg-muted p-4 text-sm">
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">데이터 기준</span><span>원본 → 최신</span></div>
            <div className="flex justify-between gap-4"><span className="text-muted-foreground">이어서 실행</span><span>{action && backtestRefreshActionLabel(action)}</span></div>
          </div>
          <p className="text-sm text-muted-foreground">선택한 설정과 기간으로 유니버스를 준비하고, 완료되면 자동으로 실행합니다.</p>
          <p className="text-xs text-muted-foreground">최신 데이터가 반영되어 결과가 원본과 달라질 수 있습니다.</p>
        </> : job ? <div className="space-y-5 py-2 text-sm" aria-live="polite">
          {failed ? <Alert variant="destructive"><AlertDescription>{job.error ?? (job.status === "FAILED" ? "데이터 준비 또는 실행에 실패했습니다." : "작업이 취소되었습니다.")}</AlertDescription></Alert> : <>
            <div className="space-y-2">
              <div className="flex justify-between gap-3"><span className="font-medium">{preparation.job && job.status === "PREPARING" ? preparationStatusDescription(preparation.job) : job.message}</span>{progress !== null ? <span className="tabular-nums">{progress}%</span> : null}</div>
              {progress !== null ? <Progress value={progress} aria-label="데이터 준비 진행률" /> : null}
            </div>
            {running ? <div className="space-y-3">
              <div className="flex items-center gap-3 font-medium"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /><span>{job.status === "SUBMITTING" ? "실행 준비" : "유니버스 준비"}</span><span className="ml-auto text-xs font-normal text-muted-foreground">진행 중</span></div>
              {job.status !== "SUBMITTING" ? <div className="flex items-center gap-3 text-muted-foreground"><Circle className="size-4" aria-hidden="true" /><span>{action && backtestRefreshActionLabel(action)}</span><span className="ml-auto text-xs">자동 실행 예정</span></div> : null}
            </div> : null}
          </>}
          {running ? <p className="text-muted-foreground">창을 닫아도 작업은 계속됩니다.<br />완료되면 알림으로 알려드립니다.</p> : null}
        </div> : <p className="text-sm text-muted-foreground">작업을 불러오는 중…</p>}
        {error || query.error ? <Alert variant="destructive"><AlertDescription>{error ?? query.error?.message}</AlertDescription></Alert> : null}
      </div>
      <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 border-t bg-muted/50 px-6 py-4 sm:justify-end">
        {running ? <Button variant="ghost" className="mr-auto text-muted-foreground" disabled={busy} onClick={cancel}>작업 취소</Button> : null}
        <Button variant={!jobId || failed ? "outline" : "default"} onClick={() => setOpen(false)}>{!jobId ? "취소" : "닫기"}</Button>
        {!jobId ? <Button disabled={busy} onClick={start}>{busy ? "요청 중…" : confirmationLabel(pending?.action)}</Button> : null}
        {failed ? <Button disabled={busy} onClick={retry}>다시 준비 후 실행</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
  return { offer, modal };
}
