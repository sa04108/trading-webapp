import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, postJson, postJsonWithStatus } from '@/lib/api-client';
import { rebalanceIntervalFitsPeriod } from '../../../shared/schemas/rebalance-interval.js';
import type { RebalanceInterval, UniverseRule } from '../../../shared/schemas/universe-rule.js';
import type { SymbolMasterCoverageDto } from '../../../shared/schemas/symbol-master.js';
import { PreparationProgress } from './preparation-progress';
import {
  isPreparingCurrentParams,
  usePreparationLive,
  type BacktestPreparationJob,
} from './preparation-live';
import { UniverseStageEditor } from './universe-stage-editor';

/** 주기 unit 마다 허용하는 최댓값 — 스키마(universe-rule.ts rebalanceIntervalSchema)와 같은 값 */
const REBALANCE_UNIT_MAX: Record<RebalanceInterval['unit'], number> = {
  DAY: 365,
  WEEK: 52,
  MONTH: 12,
  YEAR: 1,
};

/** unit 마다 필드 모양이 다른 discriminated union 이라 값을 조립하는 지점을 한 곳에 모은다 */
function buildRebalanceInterval(unit: RebalanceInterval['unit'], value: number): RebalanceInterval {
  switch (unit) {
    case 'DAY':
      return { unit, value };
    case 'WEEK':
      return { unit, value };
    case 'MONTH':
      return { unit, value };
    case 'YEAR':
      return { unit, value: 1 };
  }
}

interface UniverseScheduleEntryDto {
  readonly rebalanceDate: string;
  /** 실제 유니버스·시총을 읽은 거래일 — 휴장일이면 소급된 직전 거래일이다 */
  readonly effectiveDate: string;
  readonly members: readonly { readonly symbol: string }[];
}

/** `POST /backtests/universe-preview` 응답 (스펙 2026-08-05, backtest-routes.ts 와 같은 모양) */
export interface UniversePreviewResponseDto {
  readonly schedule: readonly UniverseScheduleEntryDto[];
  readonly unionSymbols: readonly string[];
  /** unionSymbols 중 실제 재무 행이 있는 종목. 구 서버 응답에서는 없을 수 있다. */
  readonly fundamentalSymbols?: readonly string[];
  readonly scheduleHash: string;
  readonly uncoveredDates: readonly string[];
  /**
   * period.from~to 전체가 종목 마스터 coverage 로 빈틈없이 덮였는지 — uncoveredDates
   * 는 리밸런스 날짜만 보므로, 리밸런스 날짜 사이 평일이 비어 있는 부분 커버리지는
   * 이 값으로만 드러난다(운영 버그 fix — 아래 fullSyncNeeded 참고).
   */
  readonly periodCovered: boolean;
  readonly missingCandleSymbols: readonly string[];
}

export interface PreviewParams {
  readonly universeRule: UniverseRule;
  readonly period: { readonly from: string; readonly to: string };
  /**
   * 준비 작업(Task 6)의 requestHash 가 전략·파라미터까지 포함한다 — 서버
   * (`backtest-preparation-routes.ts` 의 `previewRequestSchema`)가 이 두 필드를
   * 요구한다. 유니버스·기간만으로는 "무엇을 준비했는지" 가 제출 시점의 hash 와
   * 어긋난다.
   */
  readonly strategyId: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * 파라미터 동등성 — 부모(new-backtest-wizard.tsx)와 이 컴포넌트가 같은 정의를 써야
 * "이 미리보기가 지금 값과 여전히 일치하는가" 판정이 두 곳에서 어긋나지 않는다.
 *
 * 단계 편집기(Task 9)가 들어오면서 규칙이 stages[0] 하나가 아니라 최대 5단계 배열과
 * rebalanceInterval 전체로 커졌다 — 첫 단계만 비교하던 예전 방식은 두 번째 단계 이후를
 * 바꿔도 "그대로" 로 오판해 이미 무효해진 미리보기를 유효하다고 계속 보여준다. 전부
 * 원시값(배열·객체)이라 JSON 문자열 비교로 충분하다.
 *
 * strategyId·parameters 도 비교한다(Task 10) — 전략이나 그 파라미터가 바뀌면 준비
 * 작업 requestHash 자체가 달라지므로, 유니버스·기간이 같아도 이전 미리보기는
 * 더 이상 지금 요청과 같은 것이 아니다.
 */
export function sameUniverseParams(a: PreviewParams, b: PreviewParams): boolean {
  return (
    JSON.stringify(a.universeRule) === JSON.stringify(b.universeRule) &&
    a.period.from === b.period.from &&
    a.period.to === b.period.to &&
    a.strategyId === b.strategyId &&
    JSON.stringify(a.parameters) === JSON.stringify(b.parameters)
  );
}

/**
 * `POST /backtests/universe-preview` 는 200(미리보기 완성)과 202(준비 작업 시작)를
 * 모두 성공으로 쓴다(Task 6). 몸통 모양이 달라 status 코드로만 가른다.
 */
export type UniversePreviewStartResponse =
  | { readonly kind: 'READY'; readonly preview: UniversePreviewResponseDto }
  | { readonly kind: 'PREPARING'; readonly job: BacktestPreparationJob };

export interface UniverseRuleStepProps {
  value: UniverseRule;
  onChange: (rule: UniverseRule) => void;
  /** 위저드 '기간' 단계가 정한 값 — 이 화면에서는 읽기 전용이다(리뷰 fix, 아래 참고) */
  period: { from: string; to: string };
  /** 위저드 '전략' 단계가 고른 값 — 아직 못 골랐으면 null(이 단계에는 보통 그 뒤에만 온다) */
  strategyId: string | null;
  /**
   * 위저드가 이미 숫자로 파싱한 전략 파라미터. 파싱에 실패하면(필수값 미입력 등)
   * 그 사유 문장을 그대로 받는다 — 이 화면이 검증을 다시 하지 않는다
   * (검토 단계의 `buildRequest` 와 같은 검증을 두 곳에 두지 않는다).
   */
  parameters: Record<string, number> | string;
  /**
   * 제출이 409 PREPARATION_REQUIRED 로 거절되면 부모가 이 값을 올려 새 준비 요청을
   * 시작하라고 신호한다(Task 10, 브리프 5번). 값 자체(증가하는 정수)는 의미가 없다 —
   * "이전에 본 값보다 커졌다" 만 새 시도의 신호다.
   */
  previewRetryToken: number;
  /**
   * 미리보기가 성공할 때마다(재동기화 뒤 재시도 포함) 그때 실제로 쓴 params 와 결과를
   * 그대로 올려 보낸다. **유효성 판정 자체는 하지 않는다** — 부모가 지금 값과 비교해
   * 판정한다(아래 컴포넌트 주석 참고). 이 컴포넌트는 그 판정에 필요한 원재료만 전달한다.
   */
  onPreviewResolved: (params: PreviewParams, result: UniversePreviewResponseDto) => void;
}

/**
 * 위저드 유니버스 단계 — 데이터셋·KRX 스냅샷 선택을 유니버스 규칙 정의로 교체한다
 * (스펙 2026-08-05).
 *
 * **기간은 이 화면에서 편집하지 않는다.** 위저드 '기간' 단계가 이 단계보다 앞에 있어
 * (WIZARD_STEPS 순서 — 리뷰 fix, 이전에는 뒤에 있었다) 이 화면에 들어올 때는 이미
 * from/to 가 정해져 있다. 여기서 다시 편집할 수 있게 하면 입력처가 두 곳이 되고,
 * 어느 한쪽에서 바꾼 값이 다른 쪽 화면에 열려 있는 이 컴포넌트를 갱신하지 못하는
 * 경합(리뷰에서 지적된 마운트 생명주기 버그)이 생긴다.
 *
 * **미리보기 유효성도 이 컴포넌트가 판정하지 않는다.** 전에는 `useMutation` 의
 * `variables` 와 지금 값을 비교해 `valid`/`stale` 을 계산하고 그 결과만 부모에
 * 올려보냈는데, 이 컴포넌트가 언마운트되면(다른 단계로 이동하면) 그 계산 자체가
 * 멈춘다 — 그 상태에서 '기간' 단계로 돌아가 날짜를 바꾸면 부모가 들고 있는 마지막
 * 값(성공)이 그대로 남아, 이미 무효해진 미리보기를 유효하다고 계속 보여주는 버그가
 * 있었다. 지금은 성공한 원재료(params·result)만 올려보내고, 부모가 매 렌더 지금
 * 값과 비교해 유효성을 다시 계산한다 — 이 컴포넌트가 화면에 있든 없든 항상 맞다.
 *
 * **미리보기가 곧바로 끝나지 않을 수 있다(Task 6).** 서버가 데이터를 아직 준비하지
 * 못했으면 202 와 준비 작업(job) 을 돌려준다 — 이 화면은 그 job 을
 * `usePreparationLive` 로 추적하며 진행률(`PreparationProgress`)을 보여주고,
 * COMPLETED 가 되면 **그때 쓴 params 가 지금 값과 여전히 같을 때만** 같은 요청을
 * 다시 불러(이번엔 200) 결과를 자동으로 반영한다. 그 사이 사용자가 규칙·기간을
 * 바꿨으면 자동 반영하지 않는다 — 이미 낡은 결과이기 때문이다. 이렇게 바뀌어도
 * 실행 중이던 job 자체를 취소하지는 않는다(브리프 4번) — 서버가 그 hash 로 계속
 * 준비를 끝내 두면 나중에 그 조건으로 되돌아왔을 때 바로 쓸 수 있다.
 */
export function UniverseRuleStep({
  value,
  onChange,
  period,
  strategyId,
  parameters,
  previewRetryToken,
  onPreviewResolved,
}: UniverseRuleStepProps) {
  const queryClient = useQueryClient();
  // 백테스트는 기간 안 모든 거래일의 봉을 쓴다 — 리밸런스 날짜만 동기화해서는
  // 부족하다(Task 4, 스펙 2026-08-06). 그래서 이 화면은 날짜별 순차 동기화 대신
  // 백그라운드 백필(SymbolMasterBackfill)을 기간 전체(period.from~to)로 시작시키고
  // coverage 의 backfill 상태를 폴링해 진행을 보여준다 — 2년이면 캘린더 730일이라
  // 포그라운드 루프로 돌리면 몇 분 걸린다.
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillCursor, setBackfillCursor] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [rebalanceIntervalText, setRebalanceIntervalText] = useState(() =>
    String(value.rebalanceInterval.value),
  );

  useEffect(() => {
    setRebalanceIntervalText(String(value.rebalanceInterval.value));
  }, [value.rebalanceInterval.unit, value.rebalanceInterval.value]);

  // 마지막으로 성공(READY)한 미리보기 원재료 — previewMutation.data 는 이제
  // READY/PREPARING 두 모양을 다 담는 discriminated union 이라, 화면에 그릴 "완성된
  // 미리보기" 는 이 state 로 따로 붙잡아 둔다.
  const [resolved, setResolved] = useState<{ params: PreviewParams; result: UniversePreviewResponseDto } | null>(
    null,
  );
  // 준비 작업(job)이 도는 동안만 채워진다 — 완료·취소·실패로 끝나면 비운다.
  const [preparingJobId, setPreparingJobId] = useState<string | null>(null);
  // 그 job 을 시작시킨 params — COMPLETED 가 왔을 때 "지금 값과 여전히 같은가" 를
  // 판정하는 데 쓴다. ref 인 이유: 이 값이 바뀐다고 다시 그릴 것이 없다.
  const preparingParamsRef = useRef<PreviewParams | null>(null);
  // 부모가 올려주는 previewRetryToken(브리프 5번, 409 PREPARATION_REQUIRED) 을
  // 최근 처리한 값 — 매 렌더 다시 시작하지 않게 막는다.
  const lastHandledRetryToken = useRef(0);

  const previewMutation = useMutation({
    mutationFn: (params: PreviewParams): Promise<UniversePreviewStartResponse> =>
      postJsonWithStatus<UniversePreviewResponseDto | { job: BacktestPreparationJob }>(
        '/backtests/universe-preview',
        {
          universeRule: params.universeRule,
          period: params.period,
          strategyId: params.strategyId,
          parameters: params.parameters,
        },
      ).then(({ status, data }) =>
        status === 202
          ? { kind: 'PREPARING', job: (data as { job: BacktestPreparationJob }).job }
          : { kind: 'READY', preview: data as UniversePreviewResponseDto },
      ),
    onSuccess: (startResponse, params) => {
      if (startResponse.kind === 'PREPARING') {
        preparingParamsRef.current = params;
        setPreparingJobId(startResponse.job.id);
        return;
      }
      preparingParamsRef.current = null;
      setPreparingJobId(null);
      setResolved({ params, result: startResponse.preview });
      onPreviewResolved(params, startResponse.preview);
    },
  });

  const runPreview = (params: PreviewParams): void => {
    previewMutation.mutate(params);
  };

  const { job: liveJob } = usePreparationLive(preparingJobId);

  const cancelPreparationMutation = useMutation({
    mutationFn: () => api(`/backtests/preparation-jobs/${preparingJobId}/cancel`, { method: 'POST' }),
    onError: (error: unknown) => {
      // 취소 실패를 삼키면 사용자는 버튼을 눌렀는데 아무 일도 안 일어난 것처럼 본다.
      toast.error(error instanceof ApiError ? error.message : '취소하지 못했습니다.');
    },
  });

  const paramsReady = typeof parameters !== 'string';
  const strategyReady = strategyId !== null;
  const currentParams: PreviewParams = {
    universeRule: value,
    period,
    strategyId: strategyId ?? '',
    parameters: paramsReady ? parameters : {},
  };

  // job 이 COMPLETED 되면, 그 job 을 시작시킨 params 가 지금 값과 여전히 같을 때만
  // 같은 요청을 다시 불러(이번엔 서버가 200 을 준다) 결과를 자동 반영한다.
  // 그 사이 규칙·기간·전략·파라미터가 바뀌었으면 낡은 결과이므로 반영하지 않는다 —
  // stale 안내가 이미 "다시 미리보기하세요" 를 보여준다(위 컴포넌트 주석 참고).
  useEffect(() => {
    if (!liveJob || liveJob.status !== 'COMPLETED') return;
    const preparedParams = preparingParamsRef.current;
    if (preparedParams === null) return;
    preparingParamsRef.current = null;
    setPreparingJobId(null);
    if (!sameUniverseParams(preparedParams, currentParams)) return;
    runPreview(preparedParams);
    // 의존성은 liveJob?.status 뿐이다 — currentParams 는 이 effect 가 실행되는 렌더의
    // 최신 값을 클로저로 그대로 받는다(usePreparationLive 가 job 상태를 바꿀 때마다
    // 이 컴포넌트도 다시 그려지므로, 그 렌더에서 만든 currentParams 가 여기 쓰인다).
  }, [liveJob?.status]);

  // 부모가 준비 요청을 다시 시작하라고 신호하면(제출 409 PREPARATION_REQUIRED,
  // 브리프 5번) 지금 값으로 미리보기를 다시 부른다. 아직 준비되지 않은 입력
  // (기간·전략·파라미터 중 하나라도 비어 있으면)이면 시도하지 않는다.
  useEffect(() => {
    if (previewRetryToken <= lastHandledRetryToken.current) return;
    lastHandledRetryToken.current = previewRetryToken;
    if (strategyReady && paramsReady) runPreview(currentParams);
    // 의존성은 previewRetryToken 뿐이다 — 위 effect 와 같은 이유로 currentParams 는
    // 최신 렌더의 클로저 값을 그대로 쓴다.
  }, [previewRetryToken]);

  const preview = resolved?.result ?? null;
  // 이 컴포넌트가 화면에 떠 있는 동안 "다시 미리보기하세요" 안내를 보여줄 뿐이다 —
  // 실제 다음 단계 게이트는 부모가 판정한다(위 컴포넌트 주석 참고).
  const stale = resolved !== null && !sameUniverseParams(resolved.params, currentParams);

  const periodReady = period.from !== '' && period.to !== '' && period.from <= period.to;
  // 기간이 아직 없으면 이 판정 자체가 의미가 없다 — periodReady 부재 안내가 이미 따로 뜬다.
  const intervalFitsPeriod =
    !periodReady || rebalanceIntervalFitsPeriod(period, value.rebalanceInterval);
  const canPreview = periodReady && intervalFitsPeriod && strategyReady && paramsReady;
  // 지금 값과 같은 params 로 시작된 job 이 아직 진행 중일 때만 버튼을 잠근다
  // (코디네이터 리뷰 finding 1) — 추적 중인 job 이 있다는 사실만으로 잠그면,
  // WAITING_DAILY_QUOTA 로 하루를 넘겨 기다리는 job 을 rule A 로 시작시킨 뒤
  // 화면에서 rule B 로 바꿔도 버튼이 "조회 중…" 에 갇힌다. 그 job 자체는 취소하지
  // 않는다 — 진행 카드는 `preparingJobId`/`liveJob` 만 보고 계속 그린다(아래).
  const preparing = isPreparingCurrentParams(
    preparingParamsRef.current,
    currentParams,
    liveJob?.status ?? null,
    sameUniverseParams,
  );

  /**
   * "기간 전체 동기화" 버튼의 주 해결책 조건 — uncoveredDates(리밸런스 날짜만) 뿐
   * 아니라 periodCovered(기간 전체)·missingCandleSymbols(봉 없는 종목)도 본다.
   * 리밸런스 날짜는 다 커버됐는데 그 사이 평일의 KRX 일봉이 비어 있으면
   * uncoveredDates 는 빈 배열이라 이 버튼이 사라지고, 봉 없는 종목에 남는 유일한
   * 선택지가 증권사 동기화뿐이 된다 — 상장폐지 종목은 증권사가 모르므로 반드시
   * 404 로 실패한다(운영 버그). 조건을 넓혀 이 버튼이 항상 먼저 뜨게 한다.
   */
  // 기간을 이미 다 채웠으면 이 버튼을 내리다 — 다시 눌러도 수집할 날짜가 없어
  // 아무 일도 일어나지 않는다. 그 상태로 남은 종목은 KRX 에도 데이터가 없다는 뜻이라
  // 아래 별도 안내가 맡는다.
  const fullSyncNeeded =
    preview !== null && (preview.uncoveredDates.length > 0 || !preview.periodCovered);

  /** 위 fullSyncNeeded 가 뜬 이유를 우선순위대로 설명한다 — 리밸런스 날짜 > 기간 전체 */
  const fullSyncReason = (result: UniversePreviewResponseDto): string => {
    if (result.uncoveredDates.length > 0) {
      return `종목 마스터가 리밸런스 날짜 ${result.uncoveredDates.length}개를 아직 커버하지 않습니다.`;
    }
    return '기간 중 일부 날짜의 KRX 데이터가 아직 없습니다.';
  };

  // 기간을 이미 다 커버했는데도(periodCovered) 여전히 봉이 없는 종목이
  // 남아 있는지 본다. 그렇다면 KRX 에도 그 종목의 일봉이 없다는 뜻이다
  // (증권사 동기화는 D-041 로 제거됐다) — 안내 알림만 보여준다.
  // 기간이 아직 미커버인 동안은 이 알림을 띄우지 않는다.
  // "기간 전체 동기화"부터 먼저 시도해야 하기 때문이다.
  const missingCandlesAfterFullSync =
    preview !== null && preview.periodCovered && preview.missingCandleSymbols.length > 0;

  /**
   * 지금 도는(또는 방금 끝난) 백필의 대상 구간이 이 화면이 요청한 period.from~to 를
   * 전부 덮는지 본다. `targetStartDate` 가 null 이면 그 백필 자체가 없던 것이므로
   * false 다. `targetEndDate` 가 null 이면 toDate 없이(오늘까지) 시작한 백필이라는
   * 뜻이라 위쪽은 항상 덮인 것으로 본다.
   */
  const backfillCoversRequestedPeriod = (
    targetStartDate: string | null,
    targetEndDate: string | null,
  ): boolean =>
    targetStartDate !== null &&
    targetStartDate <= period.from &&
    (targetEndDate === null || targetEndDate >= period.to);

  /**
   * `POST /symbol-master/backfill` 로 기간 전체(period.from~to) 백필을 시작시키고,
   * `GET /symbol-master/coverage` 의 backfill 상태가 RUNNING 이 아닐 때까지 폴링한다.
   *
   * 백필은 서버 쪽 단일 백그라운드 러너다 — 이미 다른 백필이 RUNNING 이면 이 호출은
   * 새로 시작하지 않고 그 진행 상황에 편승한다(symbol-master-backfill.ts start() 참고).
   * coverage 가 대상 구간(targetStartDate/targetEndDate)을 함께 주므로, 편승 중인
   * 진행이 이 화면이 요청한 기간을 덮지 못하면(다른 화면·스케줄러가 다른 범위를
   * 돌리는 중이면) 그 사실을 바로 알린다 — 그러지 않으면 사용자는 이유를 모른 채
   * "버튼이 다시 나타남"만 보게 된다(리뷰 finding). 편승 자체를 큐잉으로 막지는
   * 않는다 — 그 백필이 끝나면 버튼을 다시 눌러 이어가면 된다.
   *
   * BUDGET_EXHAUSTED 로 멈추면 오류로 안내한다 — 버튼을 다시 누르면(보통 다음날 예산이
   * 리셋된 뒤) 이어서 시도할 수 있다.
   *
   * 백필이 온전히 끝났어도(IDLE) 리밸런스 날짜가 하나 이상 여전히 uncoveredDates 로
   * 남을 수 있다 — `period.from` 자체가 휴장일이면 그 직전 거래일(재구성 앵커)이
   * 백필 요청 구간(`period.from`~`period.to`) 밖이라 이번 백필이 닿지 않기 때문이다
   * (symbol-master-service.ts `effectiveTradingDateWithinCoverage` 는 "같은 커버
   * 구간 안"에서만 앵커를 찾는다). 그 소급은 원래 `ensureTradingDay`(`POST
   * /symbol-master/sync`)의 책임이므로, 남은 날짜만 그 경로로 개별 보정한 뒤 다시
   * 미리보기한다 — 리밸런스 날짜 수만큼만 추가로 들어 대량 백필과 비용이 겹치지 않는다.
   */
  const syncFullPeriod = async (): Promise<void> => {
    setBackfillError(null);
    setBackfillRunning(true);
    setBackfillCursor(null);
    let backfillCompleted = false;

    try {
      await postJson<unknown>('/symbol-master/backfill', {
        fromDate: period.from,
        toDate: period.to,
      });

      let status = (await api<SymbolMasterCoverageDto>('/symbol-master/coverage')).backfill;
      while (status.state === 'RUNNING') {
        if (!backfillCoversRequestedPeriod(status.targetStartDate, status.targetEndDate)) {
          setBackfillError(
            '다른 구간 수집이 진행 중입니다 — 끝나면 다시 눌러 주세요.',
          );
          return; // finally 에서 backfillRunning 을 내린다 — 이 진행은 우리 요청이 아니므로 재미리보기도 하지 않는다.
        }
        setBackfillCursor(status.cursorDate);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        status = (await api<SymbolMasterCoverageDto>('/symbol-master/coverage')).backfill;
      }

      if (status.state === 'BUDGET_EXHAUSTED') {
        setBackfillError(
          `오늘 수집 한도에 도달했습니다 (진행: ${status.cursorDate ?? '?'}) — 잠시 후 다시 시도하세요`,
        );
      } else if (status.state === 'FAILED') {
        setBackfillError(status.error ?? '기간 동기화에 실패했습니다');
      } else {
        backfillCompleted = true;
      }
    } catch (error) {
      setBackfillError(error instanceof ApiError ? error.message : '기간 동기화에 실패했습니다');
    } finally {
      setBackfillRunning(false);
    }

    await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    if (resolved === null) return;

    // 부분 진행(BUDGET_EXHAUSTED·FAILED)이었어도 다시 물어야 남은 미커버 날짜가
    // 정확히 추려진다 — 다만 그 경우 아래 소급 보정은 시도하지 않는다: 방금 KRX
    // 예산이 바닥났거나 실패한 상태에서 날짜마다 추가 소급 호출을 걸면 같은 이유로
    // 다시 실패할 뿐이고, 이미 뜬 backfillError 로 원인은 충분히 안내된다.
    if (!backfillCompleted) {
      runPreview(resolved.params);
      return;
    }

    let refreshed: UniversePreviewStartResponse;
    try {
      refreshed = await previewMutation.mutateAsync(resolved.params);
    } catch {
      return; // previewMutation.isError 알림이 이미 안내한다
    }
    if (refreshed.kind !== 'READY' || refreshed.preview.uncoveredDates.length === 0) return;

    try {
      for (const date of refreshed.preview.uncoveredDates) {
        await postJson('/symbol-master/sync', { date });
      }
    } catch (error) {
      setBackfillError(
        error instanceof ApiError ? error.message : '남은 리밸런스 날짜를 소급하지 못했습니다',
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['symbol-master'] });
    runPreview(resolved.params);
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">유니버스 규칙</CardTitle>
          <CardDescription>
            리밸런스 날짜마다 아래 단계를 순서대로 적용해 유니버스를 다시 구성
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="universe-market">시장</Label>
            <Select
              value={value.markets[0]}
              onValueChange={(next) =>
                onChange({ ...value, markets: [next as 'KOSPI' | 'KOSDAQ'] })
              }
            >
              <SelectTrigger id="universe-market" className="h-11 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="KOSPI">KOSPI</SelectItem>
                <SelectItem value="KOSDAQ">KOSDAQ</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <UniverseStageEditor
            stages={value.stages}
            onChange={(stages) => onChange({ ...value, stages })}
          />

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="rebalance-interval-value">리밸런스 주기</Label>
              <Input
                id="rebalance-interval-value"
                name="rebalanceIntervalValue"
                type="number"
                inputMode="numeric"
                className="h-11 w-24"
                min={1}
                max={REBALANCE_UNIT_MAX[value.rebalanceInterval.unit]}
                disabled={value.rebalanceInterval.unit === 'YEAR'}
                value={rebalanceIntervalText}
                onChange={(e) => {
                  const text = e.target.value;
                  setRebalanceIntervalText(text);

                  if (text.trim() === '') return;
                  const n = Number(text);
                  const max = REBALANCE_UNIT_MAX[value.rebalanceInterval.unit];
                  if (!Number.isInteger(n) || n < 1 || n > max) return;

                  onChange({
                    ...value,
                    rebalanceInterval: buildRebalanceInterval(value.rebalanceInterval.unit, n),
                  });
                }}
                onBlur={() => {
                  const text = rebalanceIntervalText.trim();
                  const n = Number(text);

                  if (text === '' || !Number.isInteger(n)) {
                    setRebalanceIntervalText(String(value.rebalanceInterval.value));
                    return;
                  }

                  const max = REBALANCE_UNIT_MAX[value.rebalanceInterval.unit];
                  const clamped = Math.min(max, Math.max(1, n));
                  setRebalanceIntervalText(String(clamped));

                  if (clamped !== value.rebalanceInterval.value) {
                    onChange({
                      ...value,
                      rebalanceInterval: buildRebalanceInterval(
                        value.rebalanceInterval.unit,
                        clamped,
                      ),
                    });
                  }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rebalance-interval-unit">주기 단위</Label>
              <Select
                value={value.rebalanceInterval.unit}
                onValueChange={(next) => {
                  const unit = next as RebalanceInterval['unit'];
                  const max = REBALANCE_UNIT_MAX[unit];
                  const clamped = unit === 'YEAR' ? 1 : Math.min(value.rebalanceInterval.value, max);
                  onChange({ ...value, rebalanceInterval: buildRebalanceInterval(unit, clamped) });
                }}
              >
                <SelectTrigger id="rebalance-interval-unit" className="h-11 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DAY">일</SelectItem>
                  <SelectItem value="WEEK">주</SelectItem>
                  <SelectItem value="MONTH">개월</SelectItem>
                  <SelectItem value="YEAR">년</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="h-11"
              disabled={!canPreview || previewMutation.isPending || preparing}
              onClick={() => runPreview(currentParams)}
            >
              {previewMutation.isPending || preparing ? '조회 중…' : '미리보기'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            기간 {period.from || '?'} ~ {period.to || '?'}
          </p>
          {!periodReady ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>먼저 '기간' 단계에서 기간을 입력하세요</AlertDescription>
            </Alert>
          ) : null}
          {periodReady && !intervalFitsPeriod ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                리밸런스 주기가 기간보다 길어 리밸런스가 한 번도 일어나지 않습니다 — 주기를
                줄이거나 기간을 늘리세요.
              </AlertDescription>
            </Alert>
          ) : null}
          {!strategyReady ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>먼저 '전략' 단계에서 전략을 선택하세요</AlertDescription>
            </Alert>
          ) : null}
          {strategyReady && !paramsReady ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{parameters as string}</AlertDescription>
            </Alert>
          ) : null}
          {previewMutation.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {previewMutation.error instanceof ApiError
                  ? previewMutation.error.message
                  : '미리보기에 실패했습니다'}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {preparingJobId !== null && liveJob ? (
        <PreparationProgress
          job={liveJob}
          onCancel={() => cancelPreparationMutation.mutate()}
          onRestart={
            liveJob.status === 'FAILED' || liveJob.status === 'CANCELLED'
              ? () => {
                  preparingParamsRef.current = null;
                  setPreparingJobId(null);
                  runPreview(currentParams);
                }
              : undefined
          }
        />
      ) : null}

      {preview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">리밸런스 일정</CardTitle>
            <CardDescription>
              {stale
                ? '규칙이나 기간이 바뀌었습니다 — 다시 미리보기하세요.'
                : `종목 ${preview.unionSymbols.length}개 · 리밸런스 ${preview.schedule.length}회`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>리밸런스 날짜</TableHead>
                    <TableHead className="text-right">종목 수</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.schedule.map((entry) => (
                    <TableRow key={entry.rebalanceDate}>
                      <TableCell className="tabular-nums">
                        {entry.rebalanceDate}
                        {/* 요청 날짜와 적용 거래일이 같으면 덧붙이지 않는다 — 휴장일 소급이
                            있을 때만 알려주면 된다(브리프 표기 규약) */}
                        {entry.effectiveDate !== entry.rebalanceDate ? (
                          <span className="text-muted-foreground">
                            {' '}
                            (적용 {entry.effectiveDate})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.members.length}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {preview && fullSyncNeeded ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>
              {fullSyncReason(preview)} 기간 전체를 동기화해야 미리보기를 완성할 수 있습니다 —
              봉이 없는 종목이 있을 때 먼저 시도할 방법입니다.
            </p>
            {preview.uncoveredDates.length > 0 ? (
              <p className="text-xs tabular-nums opacity-80">
                {preview.uncoveredDates.join(', ')}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={backfillRunning}
              onClick={() => void syncFullPeriod()}
            >
              {backfillRunning
                ? backfillCursor
                  ? `동기화 중… ${backfillCursor}`
                  : '동기화 중…'
                : '기간 전체 동기화'}
            </Button>
            {backfillRunning ? (
              <p className="text-xs opacity-80">
                동기화는 서버에서 진행되므로 화면을 나가거나 브라우저를 닫아도 계속됩니다.
                나중에 돌아와서 미리보기를 다시 누르면 그 사이 수집된 데이터가 반영됩니다.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 429/503(쿼터·미설정)·예산 소진 같은 백필 실패가 조용히 묻히지 않게 previewMutation 과
          같은 방식으로 보여준다 (리뷰 fix) */}
      {backfillError !== null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{backfillError}</AlertDescription>
        </Alert>
      ) : null}

      {preview && missingCandlesAfterFullSync ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>다음 종목은 아직 봉 데이터가 없어 백테스트를 실행할 수 없습니다.</p>
            <p className="text-xs text-muted-foreground wrap-anywhere">
              {preview.missingCandleSymbols.join(', ')}
            </p>
            {/* 기간을 이미 다 채운 상태에서만 이 블록이 뜬다. 그런데도 봉이
                없다면 KRX 에도 이 종목의 일봉이 없다는 뜻이다. 봉 수집 경로가
                종목 마스터 동기화 하나뿐이라(가격 데이터 화면·증권사 동기화는
                D-041 로 제거됨) 이 화면에서 더 시도할 방법이 없다. */}
            <p className="text-xs text-muted-foreground">
              기간은 이미 다 수집했습니다 — KRX 에도 이 종목의 일봉이 없습니다.
              그 기간에 거래가 없었거나(거래정지·정리매매 종료) KRX 가 제공하지
              않는 종목입니다.
            </p>
            <p className="text-xs text-muted-foreground">
              상위 N 이나 기간을 조정해 이 종목을 유니버스에서 빼는 것 외에는
              방법이 없습니다.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
