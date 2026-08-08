import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
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
  syncJobRefetchIntervalMs,
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
   * 수집이 끝나면(`COMPLETED`) 딱 한 번 부모(위저드)에게 알린다.
   * 제출은 이 화면이 하지 않는다.
   * 부모는 이 신호로 막혔던 오류를 지워 실행 버튼을 다시 연다.
   * 실제 제출은 사용자가 그 버튼을 눌러야 일어난다.
   */
  onCollected: () => void;
}

/**
 * 위저드 제출 게이트(Task 6)가 자본변동 미수집으로 막았을 때 붙는 화면(Task 8).
 * 별도 화면으로 보내지 않는다 — 막힌 이유(문구)와 해소책(수집 버튼)을 한 카드에 둔다.
 *
 * 진행률·SSE 는 백테스트 상세(`features/backtests/api.ts` 의 `useBacktestLive`)와
 * 같은 패턴이다. 새 방식을 만들지 않는다.
 * SSE·GET 은 이 저장소에서 이미 백틱 없이 쓰는 도메인 약어다(예:
 * `corporate-action-sync-orchestrator.ts` 의 "SSE 로 진행률을 흘린다",
 * `backtest-routes.ts` 의 "POST 신규 제출뿐 아니라"). 그 관례를 그대로 따른다.
 */
export function CorporateActionGate({
  gate,
  nameOf,
  attempted,
  onCollected,
}: CorporateActionGateProps) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [ssePayload, setSsePayload] = useState<CorporateActionSyncJobDto | null>(null);
  // SSE 연결이 끊기면 켠다 — `useBacktestLive` 와 같은 폴백 신호다.
  const [sseFailed, setSseFailed] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  // 잡 하나당 완료 알림을 한 번만 보낸다 — SSE·폴링 모두 같은 종료 상태를 여러 번
  // 전할 수 있다.
  const notifiedForJob = useRef<string | null>(null);

  const estimate = useQuery({
    queryKey: ['facts', 'corporate-action-sync-plan', gate.symbols, gate.fromYear, gate.toYear],
    queryFn: () =>
      postJson<CorporateActionSyncEstimateDto>('/facts/corporate-action-sync-plan', {
        symbols: gate.symbols,
        fromYear: gate.fromYear,
        toYear: gate.toYear,
      }),
  });

  /**
   * SSE 가 끊기면(`sseFailed`) 여기서 2초마다 조회한다.
   * `useBacktestLive`(`features/backtests/api.ts:41-50`)와 같은 폴백 규칙이다 —
   * 새 방식을 만들지 않는다.
   */
  const jobQuery = useQuery({
    queryKey: ['facts', 'corporate-action-sync-jobs', jobId],
    queryFn: () =>
      api<{ job: CorporateActionSyncJobDto }>(`/facts/corporate-action-sync-jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      syncJobRefetchIntervalMs(query.state.data?.job.status ?? null, sseFailed),
  });

  const job = ssePayload ?? jobQuery.data?.job ?? null;
  const status = job?.status ?? null;

  const startMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: CorporateActionSyncJobDto }>('/facts/corporate-action-sync-jobs', {
        symbols: gate.symbols,
        fromYear: gate.fromYear,
        toYear: gate.toYear,
      }),
    onSuccess: (data) => {
      notifiedForJob.current = null;
      setSsePayload(null);
      setSseFailed(false);
      setJobId(data.job.id);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      api(`/facts/corporate-action-sync-jobs/${jobId}/cancel`, { method: 'POST' }),
    onError: (error: unknown) => {
      // 취소 실패를 삼키면 사용자는 버튼을 눌렀는데 아무 일도 안 일어난 것처럼 본다.
      toast.error(error instanceof ApiError ? error.message : '취소하지 못했습니다.');
    },
  });

  // SSE 로 진행률을 받는다.
  // 끊기면 다시 열지 않고 `sseFailed` 로 폴링에 넘긴다 — 위 `jobQuery` 가 받는다.
  useEffect(() => {
    if (jobId === null || (status !== null && isSyncJobTerminal(status))) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current || sseFailed) return;
    const source = new EventSource(`/api/v1/facts/corporate-action-sync-jobs/${jobId}/events`);
    sourceRef.current = source;
    source.onmessage = (event) => {
      setSsePayload(JSON.parse(event.data as string) as CorporateActionSyncJobDto);
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setSseFailed(true);
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [jobId, status, sseFailed]);

  // 수집이 끝나면 부모에게 딱 한 번 알린다.
  // 제출은 여기서 하지 않는다 — 부모가 막혔던 오류를 지워 실행 버튼을 다시 열고,
  // 실제 제출은 사용자가 그 버튼을 눌러야 일어난다(계획 §3, 리뷰 finding).
  useEffect(() => {
    if (job === null || job.status !== 'COMPLETED') return;
    if (notifiedForJob.current === job.id) return;
    notifiedForJob.current = job.id;
    onCollected();
  }, [job, onCollected]);

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
