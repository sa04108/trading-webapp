// 확장자 `.js` 와 별칭(`@/`) 회피는 `prefill.ts` 와 같은 이유다.
// `tests/unit/preparation-live.test.ts` 가 이 모듈을 가져오는데, 그 테스트는
// `tsconfig.server.json` 의 NodeNext 프로그램에 편입된다 — `@/` alias 는 vite·
// tsconfig.web.json 에만 있어 그 프로그램에서는 풀리지 않는다.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api-client.js';

export type PreparationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_DAILY_QUOTA'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type PreparationPhase =
  | 'MARKET_DATA'
  | 'RESOLVING_STAGES'
  | 'VALIDATING_RESULT'
  | 'SYNCING_FACTS'
  | 'FINALIZING';

/** `backtest-preparation-orchestrator.ts` 의 `BacktestPreparationJobDto` 와 같은 모양 */
export interface BacktestPreparationJob {
  readonly id: string;
  readonly requestHash: string;
  readonly status: PreparationStatus;
  readonly phase: PreparationPhase;
  readonly doneSymbols: number;
  readonly totalSymbols: number;
  readonly savedFacts: number;
  readonly gapCount: number;
  readonly nextResumeAtMs: number | null;
  readonly error: string | null;
}

export interface PreparationLiveResult {
  readonly job: BacktestPreparationJob | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly sseFailed: boolean;
}

export const preparationJobQueryKey = (jobId: string | null) =>
  ['preparation-jobs', jobId] as const;

/** 202 응답에 이미 들어 있는 job을 상세 GET보다 먼저 화면에 반영한다. */
export function seedPreparationJob(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  job: BacktestPreparationJob,
): void {
  queryClient.setQueryData(preparationJobQueryKey(job.id), { job });
}

const TERMINAL_STATUSES: readonly PreparationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** terminal 상태면 SSE 도 폴링도 더 돌 이유가 없다 — 값이 다시 바뀌지 않는다 */
export function shouldCloseStream(status: PreparationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * SSE 가 끊긴 뒤에만(`sseFailed`) 종료되지 않은 상태에서 2초 폴백을 돈다.
 * `useBacktestLive`(`api.ts`)와 같은 규칙이다 — 새 폴링 정책을 만들지 않는다.
 * job 이 아직 없으면(null) 조회할 것이 없으므로 폴링하지 않는다.
 */
export function pollInterval(
  status: PreparationStatus | null,
  sseFailed: boolean,
): false | 2_000 {
  if (status === null || !sseFailed) return false;
  return shouldCloseStream(status) ? false : 2_000;
}

/**
 * "미리보기" 버튼을 잠글지 판정한다.
 *
 * 추적 중인 job 이 있다는 사실만으로 잠그면 안 된다 — WAITING_DAILY_QUOTA 처럼
 * 하루를 넘겨 기다리는 job 을 rule A 로 시작시킨 뒤 화면에서 rule B 로 바꾸면,
 * 그 job 은 이제 지금 값과 무관한 낡은 요청이다. 그런데도 계속 잠그면 브리프의
 * "새 hash로 다시 미리보기를 누르면 새 job 또는 queue를 받는다" 를 어기고,
 * 사용자는 새 규칙을 아무리 다시 눌러도 "조회 중…" 에서 벗어날 방법이 없다
 * (코디네이터 리뷰 finding 1, 2026-08-10).
 *
 * `paramsEqual` 을 주입받는 이유는 이 모듈이 웹 화면의 `PreviewParams`(전략·
 * 유니버스 규칙까지 포함한 구체 타입)를 모른다는 데 있다 — 그 타입은
 * `universe-rule-step.tsx` 에 있고, 그 파일은 JSX 를 써서 `tsconfig.server.json`
 * (NodeNext, jsx 플래그 없음)에서 타입 검사할 수 없다. 이 파일은
 * `tests/unit/preparation-live.test.ts` 를 통해 그 프로그램에 편입되므로, 구체
 * 타입에 의존하지 않는 제네릭 함수로 남겨 둔다.
 *
 * terminal 상태는 이미 잠글 이유가 없다 — 진행 중이 아니므로 `shouldCloseStream`
 * 으로 판정한다. `trackedParams` 가 없으면(추적 중인 job 자체가 없으면) 당연히
 * false 다.
 *
 * 202 응답의 job은 seedPreparationJob이 상세 GET보다 먼저 캐시에 넣는다. 따라서
 * status=null은 정상 연결 구간이 아니라 아직 추적할 상태가 없거나 상세 조회가
 * 실패한 경우다. 이 값을 진행 중으로 취급하면 조회 실패 때 버튼이 영구 잠길 수 있다.
 */
export function isPreparingCurrentParams<TParams>(
  trackedParams: TParams | null,
  currentParams: TParams,
  status: PreparationStatus | null,
  paramsEqual: (a: TParams, b: TParams) => boolean,
): boolean {
  if (trackedParams === null || status === null) return false;
  if (shouldCloseStream(status)) return false;
  return paramsEqual(trackedParams, currentParams);
}

const KST_RESUME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "8월 11일 00:00 (KST)" — 외부 API 일일 호출 한도로 멈췄을 때 다음 재개 시각을 알린다 */
export function formatPreparationResumeTime(tsMs: number | null): string {
  if (tsMs === null) return '알 수 없음';
  return `${KST_RESUME_FORMATTER.format(tsMs)} (KST)`;
}

/**
 * 백테스트 데이터 준비 작업(스펙 2026-08-05, Task 6) 진행률 — SSE 를 기본으로 하고
 * 끊기면 2초 폴링으로 넘긴다. `useBacktestLive`(`api.ts`)와 같은 골격이다.
 *
 * terminal 이 되면 `['universe-preview', requestHash]` 를 무효화한다. 그 hash 로
 * 캐시된 미리보기 조회가 있다면(예: 같은 조건으로 다시 미리보기를 부른 화면) 이
 * job 의 결과가 반영되지 않은 낡은 상태로 남지 않는다.
 */
export function usePreparationLive(jobId: string | null): PreparationLiveResult {
  const queryClient = useQueryClient();
  const [ssePayload, setSsePayload] = useState<BacktestPreparationJob | null>(null);
  const [sseFailed, setSseFailed] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  // terminal 알림(캐시 무효화)을 잡 하나당 한 번만 보낸다 — SSE·폴링 모두 같은
  // 종료 상태를 여러 번 전할 수 있다.
  const invalidatedForJob = useRef<string | null>(null);

  // 새 잡에 붙을 때마다 이전 잡의 흔적을 지운다 — 지우지 않으면 이전 잡이 남긴
  // sseFailed=true 가 새 잡에도 남아 SSE 를 아예 열지 않는다.
  useEffect(() => {
    setSsePayload(null);
    setSseFailed(false);
  }, [jobId]);

  const detail = useQuery({
    queryKey: preparationJobQueryKey(jobId),
    queryFn: () => api<{ job: BacktestPreparationJob }>(`/backtests/preparation-jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => pollInterval(query.state.data?.job.status ?? null, sseFailed),
  });

  const status = ssePayload?.status ?? detail.data?.job.status ?? null;

  useEffect(() => {
    if (jobId === null || (status !== null && shouldCloseStream(status))) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current || sseFailed) return;

    const source = new EventSource(`/api/v1/backtests/preparation-jobs/${jobId}/events`);
    sourceRef.current = source;
    source.onmessage = (event) => {
      setSsePayload(JSON.parse(event.data as string) as BacktestPreparationJob);
    };
    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setSseFailed(true); // polling fallback 활성화
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [jobId, status, sseFailed]);

  const job: BacktestPreparationJob | null =
    ssePayload && detail.data && ssePayload.id === detail.data.job.id
      ? { ...detail.data.job, ...ssePayload }
      : detail.data?.job ?? null;

  // SSE·폴링 어느 경로로 terminal 이 왔든 여기 한 곳에서만 무효화한다 — 위 두
  // 갈래에 각각 심으면 어느 한쪽이 늦게 도착했을 때 중복 호출을 다시 걱정해야 한다.
  useEffect(() => {
    if (!job || !shouldCloseStream(job.status)) return;
    if (invalidatedForJob.current === job.id) return;
    invalidatedForJob.current = job.id;
    void queryClient.invalidateQueries({ queryKey: ['universe-preview', job.requestHash] });
  }, [job, queryClient]);

  return {
    job,
    isLoading: detail.isLoading,
    error: detail.error,
    sseFailed,
  };
}
