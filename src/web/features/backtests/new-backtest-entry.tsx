import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api-client';
import {
  clearAllBacktestWizardDrafts,
  loadBacktestWizardResumeCandidate,
  type BacktestWizardResumeCandidate,
} from './wizard-draft-api';
import { stepSlug } from './wizard-steps';

/**
 * slug 없는 진입만 작성 의도를 판정한다. 단계 URL은 새로고침·뒤로가기로 돌아오는
 * 기존 세션이므로 여기서 다시 묻거나 초안을 지우지 않는다.
 */
export function wizardResumeTarget(candidate: BacktestWizardResumeCandidate): {
  pathname: string;
  search: string;
} {
  return {
    pathname: `/backtests/new/${candidate.currentStep}`,
    search: candidate.sourceJobId === null
      ? ''
      : `?${new URLSearchParams({ from: candidate.sourceJobId })}`,
  };
}

export function NewBacktestEntry() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const rawSourceJobId = new URLSearchParams(search).get('from');
  const sourceJobId = rawSourceJobId === null || rawSourceJobId === '' ? null : rawSourceJobId;
  const resetStartedFor = useRef<string | null>(null);

  const candidateQuery = useQuery({
    queryKey: ['backtests', 'wizard-resume-candidate'],
    queryFn: loadBacktestWizardResumeCandidate,
    enabled: sourceJobId === null,
    refetchOnMount: 'always',
  });

  const resetDrafts = useMutation({
    mutationFn: async () => {
      // 임의의 `?from=` 주소만으로 보존 중인 초안을 지우지 않는다. 실제로 접근 가능한
      // 복제 원본인지 먼저 확인하고, 성공한 결과 화면의 재설정·복제 진입만 명시적
      // 새 시작으로 인정한다. 같은 key 를 써서 다음 화면의 조회도 이 결과를 재사용한다.
      if (sourceJobId !== null) {
        await queryClient.fetchQuery({
          queryKey: ['backtests', sourceJobId, 'clone-draft'],
          queryFn: () =>
            api<unknown>(`/backtests/${encodeURIComponent(sourceJobId)}/clone-draft`),
        });
      }
      await clearAllBacktestWizardDrafts();
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['backtests', 'wizard-draft'] });
      queryClient.removeQueries({ queryKey: ['backtests', 'wizard-resume-candidate'] });
      void navigate(
        sourceJobId === null
          ? { pathname: `/backtests/new/${stepSlug(0)}` }
          : { pathname: `/backtests/new/${stepSlug(4)}`, search },
        { replace: true },
      );
    },
  });

  // 결과의 재설정·복제 버튼은 기존 작업을 버리고 이 원본으로 새로 시작한다는 명시적 의도다.
  useEffect(() => {
    if (sourceJobId === null) {
      resetStartedFor.current = null;
      return;
    }
    if (resetStartedFor.current === sourceJobId) return;
    resetStartedFor.current = sourceJobId;
    resetDrafts.mutate();
  }, [sourceJobId, resetDrafts]);

  if (sourceJobId !== null) {
    if (resetDrafts.isError) {
      return (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-3">
            <p>
              재설정 및 복제를 시작하지 못했습니다. 기존 위저드 작업을 확인한 뒤 다시 시도하세요 —
              {' '}
              {resetDrafts.error instanceof ApiError
                ? resetDrafts.error.message
                : '잠시 후 다시 시도하세요.'}
            </p>
            <Button variant="outline" onClick={() => resetDrafts.mutate()}>
              다시 시도
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return <Skeleton className="mx-auto h-64 w-full max-w-2xl" />;
  }

  if (candidateQuery.isPending || candidateQuery.isFetching) {
    return <Skeleton className="mx-auto h-64 w-full max-w-2xl" />;
  }
  if (candidateQuery.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="space-y-3">
          <p>이전에 작성하던 백테스트가 있는지 확인하지 못했습니다.</p>
          <Button variant="outline" onClick={() => void candidateQuery.refetch()}>
            다시 시도
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const candidate = candidateQuery.data;
  if (candidate === null) {
    return <Navigate to={`/backtests/new/${stepSlug(0)}`} replace />;
  }

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>이전에 준비하던 백테스트가 있습니다</DialogTitle>
          <DialogDescription>
            {candidate.sourceJobId === null
              ? '저장된 설정과 마지막 단계에서 계속할 수 있습니다.'
              : '재설정 및 복제 중이던 설정과 마지막 단계에서 계속할 수 있습니다.'}
          </DialogDescription>
        </DialogHeader>
        {resetDrafts.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              저장된 작업을 정리하지 못했습니다. 다시 시도하세요.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={resetDrafts.isPending}
            onClick={() => resetDrafts.mutate()}
          >
            새로 시작
          </Button>
          <Button
            disabled={resetDrafts.isPending}
            onClick={() => {
              queryClient.removeQueries({
                queryKey: ['backtests', 'wizard-draft', candidate.sourceJobId],
                exact: true,
              });
              void navigate(wizardResumeTarget(candidate), { replace: true });
            }}
          >
            이전 작업 이어서 하기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
