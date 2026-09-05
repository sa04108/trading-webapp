import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  formatPreparationResumeTime,
  shouldCloseStream,
  type BacktestPreparationJob,
  type PreparationPhase,
} from './preparation-live';

const PHASE_LABELS: Record<PreparationPhase, string> = {
  MARKET_DATA: 'KRX 시장 데이터 수집',
  RESOLVING_STAGES: '유니버스 선정 계산',
  VALIDATING_RESULT: '미리보기 결과 검증',
  SYNCING_FACTS: 'DART 재무·자본변동 수집',
  FINALIZING: '미리보기 결과 저장',
};

/** 버튼 옆 상태와 준비 카드가 같은 용어로 실제 작업 위치를 설명하게 한다. */
export function preparationStatusDescription(job: BacktestPreparationJob): string {
  switch (job.status) {
    case 'QUEUED':
      return '데이터 준비 대기 중';
    case 'RUNNING':
      return PHASE_LABELS[job.phase];
    case 'WAITING_DAILY_QUOTA':
      return `${quotaProvider(job)} 일일 호출 한도 해제 대기`;
    case 'COMPLETED':
      return '준비 완료';
    case 'FAILED':
      return '준비 실패';
    case 'CANCELLED':
      return '취소됨';
  }
}

function quotaProvider(job: BacktestPreparationJob): 'KRX' | 'DART' {
  return job.phase === 'MARKET_DATA' ? 'KRX' : 'DART';
}

/** 0~100 정수. 분모가 0 이면(아직 계획을 못 받은 순간) 0 으로 둔다 */
function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

export interface PreparationProgressProps {
  readonly job: BacktestPreparationJob;
  readonly onCancel: () => void;
  /** FAILED 의 재시도·CANCELLED 의 다시 준비 — 둘 다 새 준비 요청을 시작하는 같은 동작이다 */
  readonly onRestart?: () => void;
}

/**
 * 백테스트 데이터 준비(스펙 2026-08-05, Task 6) 진행 화면.
 *
 * SSE/폴링 값은 부모(`usePreparationLive`)가 준다 — 이 컴포넌트는 그 값을 그리기만
 * 한다. COMPLETED 는 부모가 preview 를 자동으로 다시 불러 화면을 정상 미리보기로
 * 되돌리므로, 여기서는 짧게 완료를 알리기만 하고 버튼을 두지 않는다.
 */
export function PreparationProgress({ job, onCancel, onRestart }: PreparationProgressProps) {
  const cancellable = !shouldCloseStream(job.status);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">데이터 준비</CardTitle>
        <CardDescription>{preparationStatusDescription(job)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {job.status === 'RUNNING' || job.status === 'WAITING_DAILY_QUOTA' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span>{PHASE_LABELS[job.phase]}</span>
              <span className="tabular-nums" aria-live="polite">
                {job.doneSymbols} / {job.totalSymbols}
              </span>
            </div>
            <Progress
              value={progressPercent(job.doneSymbols, job.totalSymbols)}
              aria-label="데이터 준비 진행률"
            />
          </div>
        ) : null}

        {job.status === 'WAITING_DAILY_QUOTA' ? (
          <Alert role="alert">
            <AlertDescription>
              {quotaProvider(job)} 일일 호출 한도에 도달했습니다 —{' '}
              {formatPreparationResumeTime(job.nextResumeAtMs)}에 자동으로 이어서 준비합니다.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* 준비 job 은 서버에 영속된다(Task 6) — 진행 중에 화면을 떠나도 잃는 것이
            없다는 사실을 알려야 사용자가 수집이 끝날 때까지 붙어 있지 않는다. */}
        {job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'WAITING_DAILY_QUOTA' ? (
          <p className="text-xs text-muted-foreground">
            준비는 서버에서 진행되므로 화면을 나가거나 브라우저를 닫아도 계속됩니다. 나중에
            같은 조건으로 미리보기를 누르면 진행 상황을 다시 볼 수 있습니다.
          </p>
        ) : null}

        {job.status === 'FAILED' ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{job.error ?? '데이터 준비에 실패했습니다.'}</AlertDescription>
          </Alert>
        ) : null}

        {job.status === 'CANCELLED' ? (
          <p className="text-muted-foreground">{job.error ?? '데이터 준비가 취소되었습니다.'}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          {cancellable ? (
            <Button type="button" variant="destructive" className="h-11" onClick={onCancel}>
              취소
            </Button>
          ) : null}
          {job.status === 'FAILED' && onRestart ? (
            <Button type="button" className="h-11" onClick={onRestart}>
              재시도
            </Button>
          ) : null}
          {job.status === 'CANCELLED' && onRestart ? (
            <Button type="button" className="h-11" onClick={onRestart}>
              다시 준비
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
