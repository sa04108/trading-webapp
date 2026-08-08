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
  extractActiveSyncJobId,
  formatCollectionEstimate,
  formatCollectionTarget,
  formatGateHeadline,
  formatRemainingGateMessage,
  isSyncJobTerminal,
  selectSyncJob,
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
 * 진행률은 SSE 를 기본으로 하고 끊기면 폴링으로 넘긴다.
 * 백테스트 상세(`features/backtests/api.ts` 의 `useBacktestLive`)와 같은 골격이다.
 * 다만 어느 값을 우선할지는 `selectSyncJob` 이 따로 정한다 — 그 함수 주석을 참고한다.
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

  // SSE 가 끊기면 그 값이 얼어붙으므로 폴링 값을 우선한다 — 규칙은 `selectSyncJob` 이 갖는다
  const job = selectSyncJob(ssePayload, jobQuery.data?.job ?? null, sseFailed);
  const status = job?.status ?? null;

  /** 화면을 잡 하나에 붙인다 — 새 잡을 만들었을 때와 도는 잡을 되찾았을 때가 같은 절차다 */
  const attachTo = (id: string): void => {
    notifiedForJob.current = null;
    setSsePayload(null);
    setSseFailed(false);
    setJobId(id);
  };

  const startMutation = useMutation({
    mutationFn: () =>
      postJson<{ job: CorporateActionSyncJobDto }>('/facts/corporate-action-sync-jobs', {
        symbols: gate.symbols,
        fromYear: gate.fromYear,
        toYear: gate.toYear,
      }),
    onSuccess: (data) => {
      attachTo(data.job.id);
    },
    onError: (error: unknown) => {
      // 409 는 다른 잡이 이미 돈다는 뜻이고, 서버가 그 잡의 id 를 함께 보낸다.
      // 새로고침으로 id 를 잃은 화면이 여기서 도는 잡에 다시 붙는다.
      const activeJobId = extractActiveSyncJobId(error);
      if (activeJobId !== null) attachTo(activeJobId);
    },
  });
  // 409 로 붙은 경우에는 오류 배너를 띄우지 않는다 — 아래 진행률이 그 자리를 대신한다
  const startError =
    startMutation.isError && extractActiveSyncJobId(startMutation.error) === null
      ? startMutation.error
      : null;

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
            // 하루 한도를 넘는 계획은 눈에 띄게 그린다 — 문구는 `formatCollectionEstimate` 가 만든다
            <p className={estimate.data.overDailyLimit ? 'text-destructive' : undefined}>
              {formatCollectionEstimate(estimate.data)}
            </p>
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

        {startError !== null ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              {startError instanceof ApiError ? startError.message : '수집을 시작하지 못했습니다.'}
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
