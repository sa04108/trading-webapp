import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, postJson } from '@/lib/api-client';
import {
  canCancelSyncJob,
  formatCollectionEstimate,
  formatCollectionTarget,
  formatGateHeadline,
  formatRemainingGateMessage,
  isSyncJobTerminal,
  syncProgressPercent,
  type CorporateActionGateDto,
  type CorporateActionSyncEstimateDto,
  type CorporateActionSyncJobDto,
} from './corporate-action-gate-logic';

export interface CorporateActionGateProps {
  /** 서버(`checkCorporateActionCoverage`)가 계산해 준 값 — 여기서 다시 세지 않는다 */
  gate: CorporateActionGateDto;
  nameOf: (code: string) => string | null;
  /** 이전에 한 번 수집을 마치고도 다시 이 화면을 보는 중인지 — 문구를 "여전히"로 바꾼다 */
  attempted: boolean;
  /**
   * 수집이 끝나 게이트를 다시 평가해야 할 때 부모(위저드)를 부른다.
   * 판정은 이 화면이 하지 않는다.
   * 부모가 실제 제출(`POST /backtests`)을 다시 태워 서버가 통과·실패를 가른다.
   * 화면이 종목·연도를 다시 계산하지 않는 것과 같은 이유다.
   */
  onRetry: () => void;
}

/**
 * 위저드 제출 게이트(Task 6)가 자본변동 미수집으로 막았을 때 붙는 화면(Task 8).
 * 별도 화면으로 보내지 않는다 — 막힌 이유(문구)와 해소책(수집 버튼)을 한 카드에 둔다.
 *
 * 진행률·SSE 는 백테스트 상세(`features/backtests/api.ts` 의 `useBacktestLive`)와
 * 같은 패턴이다. 새 방식을 만들지 않는다.
 */
export function CorporateActionGate({ gate, nameOf, attempted, onRetry }: CorporateActionGateProps) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [ssePayload, setSsePayload] = useState<CorporateActionSyncJobDto | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // 잡 하나당 재평가를 한 번만 부른다 — SSE 는 같은 종료 상태를 여러 번 보낼 수 있다
  const retriedForJob = useRef<string | null>(null);

  const estimate = useQuery({
    queryKey: ['facts', 'corporate-action-sync-plan', gate.symbols, gate.fromYear, gate.toYear],
    queryFn: () =>
      postJson<CorporateActionSyncEstimateDto>('/facts/corporate-action-sync-plan', {
        symbols: gate.symbols,
        fromYear: gate.fromYear,
        toYear: gate.toYear,
      }),
  });

  const jobQuery = useQuery({
    queryKey: ['facts', 'corporate-action-sync-jobs', jobId],
    queryFn: () =>
      api<{ job: CorporateActionSyncJobDto }>(`/facts/corporate-action-sync-jobs/${jobId}`),
    enabled: jobId !== null,
  });

  const job = ssePayload ?? jobQuery.data?.job ?? null;

  const startMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: CorporateActionSyncJobDto }>('/facts/corporate-action-sync-jobs', {
        symbols: gate.symbols,
        fromYear: gate.fromYear,
        toYear: gate.toYear,
      }),
    onSuccess: (data) => {
      retriedForJob.current = null;
      setSsePayload(null);
      setJobId(data.job.id);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      api(`/facts/corporate-action-sync-jobs/${jobId}/cancel`, { method: 'POST' }),
  });

  // SSE 로 진행률을 받는다. 연결이 끊기면 다시 열지 않는다.
  // 종료 상태는 GET 조회로도 확인할 수 있다.
  // 이 화면은 오래 떠 있지 않는다 — 수집이 끝나면 곧바로 onRetry 로 넘어간다.
  useEffect(() => {
    if (jobId === null || (job !== null && isSyncJobTerminal(job.status))) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current) return;
    const source = new EventSource(`/api/v1/facts/corporate-action-sync-jobs/${jobId}/events`);
    sourceRef.current = source;
    source.onmessage = (event) => {
      setSsePayload(JSON.parse(event.data as string) as CorporateActionSyncJobDto);
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [jobId, job]);

  // 수집이 끝나면 게이트를 다시 평가한다 — 위저드의 제출을 다시 태워 실제 통과
  // 여부를 서버에 되묻는다(브리프 2번). 취소·실패는 재평가할 것이 없다 — 커버리지가
  // 늘지 않았으므로 다시 물어봐도 같은 자리다.
  useEffect(() => {
    if (job === null || job.status !== 'COMPLETED') return;
    if (retriedForJob.current === job.id) return;
    retriedForJob.current = job.id;
    void queryClient.invalidateQueries({ queryKey: ['facts', 'corporate-action-sync-plan'] });
    onRetry();
  }, [job, onRetry, queryClient]);

  const canStart = job === null || job.status === 'FAILED' || job.status === 'CANCELLED';
  const running = job !== null && !isSyncJobTerminal(job.status);
  const cancellable = job !== null && canCancelSyncJob(job.status);
  const progress = job ? syncProgressPercent(job.doneSymbols, job.totalSymbols) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">자본변동 이력 수집이 필요합니다</CardTitle>
        <CardDescription>
          {attempted
            ? formatRemainingGateMessage(gate.symbols, nameOf)
            : `${formatGateHeadline(gate.symbols.length)} 액면분할이 있었다면 결과가 틀어집니다.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{formatCollectionTarget(gate.symbols.length, gate.fromYear, gate.toYear)}</p>

        {job === null ? (
          estimate.data ? (
            <p>{formatCollectionEstimate(estimate.data)}</p>
          ) : estimate.isError ? (
            <p className="text-xs text-muted-foreground">예상 호출·시간을 불러오지 못했습니다.</p>
          ) : (
            <Skeleton className="h-5 w-2/3" />
          )
        ) : null}

        {job !== null ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span>수집 진행률</span>
              <span className="tabular-nums" aria-live="polite">
                {job.doneSymbols} / {job.totalSymbols}종목
              </span>
            </div>
            <Progress value={progress} aria-label="자본변동 수집 진행률" />
            {job.status === 'FAILED' ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{job.error ?? '수집이 실패했습니다.'}</AlertDescription>
              </Alert>
            ) : null}
            {job.status === 'CANCELLED' ? (
              <p className="text-xs text-muted-foreground">
                {job.error ?? '수집이 취소되었습니다.'}
              </p>
            ) : null}
          </div>
        ) : null}

        {startMutation.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {startMutation.error instanceof ApiError
                ? startMutation.error.message
                : '수집을 시작하지 못했습니다.'}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end gap-2">
          {running ? (
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              onClick={() => cancelMutation.mutate()}
              disabled={!cancellable || cancelMutation.isPending}
            >
              <XCircle data-icon="inline-start" />
              취소
            </Button>
          ) : (
            <Button
              type="button"
              className="h-11"
              onClick={() => startMutation.mutate()}
              disabled={!canStart || startMutation.isPending}
            >
              <RefreshCw data-icon="inline-start" />
              {canStart && job === null ? '자본변동 이력 수집' : '다시 수집'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
