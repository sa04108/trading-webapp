import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, postJson } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { formatKrw, timeframeLabel } from '@/lib/format';
import { wizardTimeframes } from '@/features/datasets/dataset-slices';
import { costProfileLabel, slippageProfileLabel } from './profile-labels';
import { useStockNames } from '@/lib/use-stock-names';
import { requestToFormState } from './prefill';
import { ParamHint } from './param-hint';
import { extractNumberParams, paramLabel, type NumberParamSpec } from './param-specs';
import { StrategyDataBadge } from './strategy-data-badge';
import { useStrategies } from './api';
import { STRATEGY_DATA_DETAILS, strategyDataRequirement } from './strategy-data-requirement';
import { SymbolLabel } from '@/components/symbol-label';
import { formatUniverseRuleSummary } from './universe-summary';
import {
  clampSymbolName,
  formatSymbolLabel,
  SYMBOL_SUMMARY_LIMIT,
} from './symbol-summary';
import {
  sameUniverseParams,
  UniverseRuleStep,
  type PreviewParams,
  type UniversePreviewResponseDto,
} from './universe-rule-step';
import type { UniverseRule } from '../../../shared/schemas/universe-rule.js';
import type { BacktestRequestBody } from './types';
import {
  navigableStepLimit,
  reachableStepFromUrl,
  REVIEW_STEP,
  RUN_STEP,
  stepBlocker,
  stepIndexOf,
  stepJumpBlockReason,
  stepSlug,
  WIZARD_STEPS,
  type StepGateState,
} from './wizard-steps';

interface CommissionProfileSummary {
  id: string;
  version: string;
  buyCommissionRate: number;
  sellCommissionRate: number;
  sellTaxRate: number;
}

interface SlippageProfileSummary {
  id: string;
  version: string;
  bps: number;
  fixed: number;
}

// 마크업 테스트(universe-stage-editor-markup.test.tsx)도 이 두 값을 그대로 임포트해
// "신규 진입 기본값" 계약을 고정한다 — 위저드 밖에서 다시 선언하면 두 곳이 어긋날 수 있다.
export const DEFAULT_UNIVERSE_RULE: UniverseRule = {
  markets: ['KOSPI'],
  stages: [{ criterion: 'MARKET_CAP', limit: 200 }],
  rebalanceInterval: { value: 1, unit: 'MONTH' },
};

// 스키마 기본값(risk.maxPositions default 40, max 200 — backtest-request.ts)과 같은 값이다.
export const DEFAULT_MAX_POSITIONS = '40';

/**
 * 전략 파라미터 입력(문자열)을 서버가 받는 숫자로 파싱한다.
 *
 * 검토 단계(`buildRequest`)와 유니버스 단계(미리보기 요청)가 같은 파싱을 쓴다 — 둘이
 * 각자 파싱하면, 값이 같아도 라운딩·범위 판단이 갈라져 미리보기 때 만든 준비 작업의
 * requestHash 와 실제 제출 requestHash 가 어긋날 수 있다(Task 6 hash 는 파싱된 값
 * 기준이다). 실패하면 사람이 읽을 오류 문장을 그대로 돌려준다.
 */
function parseStrategyParameters(
  paramSpecs: readonly NumberParamSpec[],
  parameters: Record<string, string>,
): Record<string, number> | string {
  const parsed: Record<string, number> = {};
  for (const spec of paramSpecs) {
    const raw = parameters[spec.key] ?? '';
    const label = paramLabel(spec);
    if (raw === '') {
      if (spec.optional) continue;
      return `${label} 을(를) 입력하세요`;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) return `${label} 이(가) 숫자가 아닙니다`;
    if (spec.minimum !== undefined && value < spec.minimum) {
      return `${label} 은(는) ${spec.minimum} 이상이어야 합니다`;
    }
    if (spec.maximum !== undefined && value > spec.maximum) {
      return `${label} 은(는) ${spec.maximum} 이하여야 합니다`;
    }
    parsed[spec.key] = spec.isInteger ? Math.round(value) : value;
  }
  return parsed;
}

export function NewBacktestWizard() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  /** URL 이 가리키는 단계. null 은 모르는 slug 다 */
  const urlStep = stepIndexOf(params.step);
  /**
   * 이 세션에서 위저드가 스스로 이동해 도달한 가장 앞 단계. 게이트가 뒤늦게 무너져도
   * (유니버스 미리보기가 무효화한 `['symbols']` 재조회가 재무 게이트를 뒤집는 식으로)
   * 서 있던 자리에서 밀려나지 않게 하는 근거다 — 판정 규칙은 `reachableStepFromUrl` 에 있다.
   */
  const [traversed, setTraversed] = useState(0);
  /** 검토 화면을 눈으로 지났는지 — 제출 화면에 URL 로 바로 들어오는 길을 막는다 */
  const [reviewPassed, setReviewPassed] = useState(false);
  const [strategyId, setStrategyId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  /**
   * 유니버스 규칙 (스펙 2026-08-05) — 위저드는 더 이상 종목이나 데이터셋을 고르지
   * 않는다. 시장·단계(최대 5개)·리밸런스 주기만 고르면 실제 종목 구성은 제출 시점에
   * 서버가 리밸런스 날짜별로 재구성한다 (`UniverseRuleResolver`).
   */
  const [universeRule, setUniverseRule] = useState<UniverseRule>(DEFAULT_UNIVERSE_RULE);
  /**
   * `UniverseRuleStep` 이 마지막으로 성공시킨 미리보기 원재료(그때 쓴 params·결과) —
   * **판정 결과가 아니라 원재료만** 저장한다(리뷰 fix). `universePreviewOk`·
   * `unionSymbols` 는 아래에서 이 값과 지금 값(universeRule·from·to)을
   * 매 렌더 비교해 도출한다 — state 로 따로 들고 있다가 규칙·기간이 바뀔 때마다 수동으로
   * false 로 되돌리는 방식은, `UniverseRuleStep` 이 화면에 없는 동안(다른 단계에 있는
   * 동안) 그 되돌림 자체가 일어날 기회가 없어 낡은 성공이 유효한 척 남는 버그가 있었다.
   */
  const [lastPreview, setLastPreview] = useState<{
    params: PreviewParams;
    result: UniversePreviewResponseDto;
  } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [initialCash, setInitialCash] = useState('10000000');
  // 스키마 기본값 40 (backtest-request.ts risk.maxPositions default) — 등록된 전략들의
  // topN 기본값(없음/10/20/최대 200)이 모두 이 값만으로 제출 게이트(topN > maxPositions
  // 422)를 통과한다.
  const [maxPositions, setMaxPositions] = useState(DEFAULT_MAX_POSITIONS);
  const [commissionProfileId, setCommissionProfileId] = useState('kr-equity-default');
  const [slippageProfileId, setSlippageProfileId] = useState('fixed-5bps');
  const [randomSeed, setRandomSeed] = useState('42');
  const [stepError, setStepError] = useState<string | null>(null);
  /**
   * 제출이 409 PREPARATION_REQUIRED 로 거절되면(Task 10, 브리프 5번) 이 값을 올려
   * `UniverseRuleStep` 에게 새 준비 요청을 다시 시작하라고 신호한다 — 값 자체는
   * 의미가 없고 "이전보다 커졌다" 만 신호다.
   */
  const [previewRetryToken, setPreviewRetryToken] = useState(0);

  const strategies = useStrategies();
  const schema = useQuery({
    queryKey: ['strategies', strategyId, 'schema'],
    queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${strategyId}/schema`),
    enabled: strategyId !== null,
  });

  const [searchParams] = useSearchParams();
  const sourceJobId = searchParams.get('from');

  const draft = useQuery({
    queryKey: ['backtests', sourceJobId, 'clone-draft'],
    queryFn: () =>
      api<{ request: BacktestRequestBody; warnings: string[]; blockers: string[] }>(
        `/backtests/${sourceJobId}/clone-draft`,
      ),
    enabled: sourceJobId !== null,
  });

  const selectedStrategy = strategies.data?.strategies.find((s) => s.id === strategyId) ?? null;
  const paramSpecs = useMemo(() => extractNumberParams(schema.data?.schema), [schema.data]);
  // 미리보기 요청·검토 단계 제출이 같은 파싱을 쓴다(위 parseStrategyParameters 주석
  // 참고) — 문자열이면 아직 파싱에 실패한 상태라는 뜻이다.
  const parsedParameters = useMemo(
    () => parseStrategyParameters(paramSpecs, parameters),
    [paramSpecs, parameters],
  );

  /**
   * 유니버스 미리보기 유효성 — `lastPreview` 와 지금 값을 매 렌더 비교해서 도출한다
   * (리뷰 fix). `UniverseRuleStep` 이 화면에 없어도(다른 단계에 있어도) 이 계산은
   * 항상 이 렌더의 최신 `universeRule`/`from`/`to` 를 본다 — 컴포넌트 마운트 여부와
   * 무관하다.
   *
   * 리밸런스 주기는 더 이상 전략 파라미터에서 도출하지 않는다(Task 9) — `universeRule.
   * rebalanceInterval` 이 그 자체로 완결된 값이라 여기서 따로 뽑을 것이 없다.
   *
   * strategyId·parameters 도 포함한다(Task 10) — 준비 작업(Task 6)의 requestHash 가
   * 이 둘까지 본다. 전략을 아직 못 골랐거나 파라미터가 아직 안 맞으면 빈 값으로
   * 채운다 — 어차피 그 상태에서는 `UniverseRuleStep` 이 미리보기 자체를 막는다.
   */
  const currentUniverseParams: PreviewParams = {
    universeRule,
    period: { from, to },
    strategyId: strategyId ?? '',
    parameters: typeof parsedParameters === 'string' ? {} : parsedParameters,
  };
  // 지금 값과 일치하는 미리보기 결과 — 일치하지 않으면(규칙·기간이 바뀌었으면) null.
  const currentPreviewResult =
    lastPreview !== null && sameUniverseParams(lastPreview.params, currentUniverseParams)
      ? lastPreview.result
      : null;
  const universePreviewOk =
    currentPreviewResult !== null &&
    currentPreviewResult.uncoveredDates.length === 0 &&
    currentPreviewResult.missingCandleSymbols.length === 0;
  /** 그 미리보기가 확정한 종목 목록 — 위저드 나머지 단계(재무 게이트·검토)가 본다 */
  const unionSymbols = currentPreviewResult !== null && universePreviewOk ? currentPreviewResult.unionSymbols : [];

  const stockNames = useStockNames(unionSymbols);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;
  const symbolLabel = (symbol: string): string => formatSymbolLabel(symbol, nameOf(symbol));

  // 스키마 기본값은 입력 상태에 한 번 심는다. 렌더 시점에 빈 값을 기본값으로 되돌리면
  // 필드를 비울 수 없어 (전체 선택 후 삭제 → 즉시 기본값 복귀) 지우고 다시 쓰기가 막힌다.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (strategyId === null || paramSpecs.length === 0) return;
    if (seededFor.current === strategyId) return;
    seededFor.current = strategyId;
    setParameters(
      Object.fromEntries(
        paramSpecs.map((spec) => [
          spec.key,
          spec.defaultValue !== undefined ? String(spec.defaultValue) : '',
        ]),
      ),
    );
  }, [strategyId, paramSpecs]);

  // 프리필은 원본 작업당 한 번만 — 사용자가 편집을 시작한 뒤 덮어쓰지 않는다.
  const prefilledFrom = useRef<string | null>(null);
  const [prefillNotes, setPrefillNotes] = useState<string[]>([]);
  useEffect(() => {
    if (sourceJobId === null || !draft.data) return;
    if (prefilledFrom.current === sourceJobId) return;
    // 카탈로그가 도착해야 사라진 참조를 판정할 수 있다
    if (!strategies.data) return;
    prefilledFrom.current = sourceJobId;

    const { state, notes } = requestToFormState(draft.data.request, {
      strategyIds: strategies.data.strategies.map((s) => s.id),
    });
    setStrategyId(state.strategyId);
    setParameters(state.parameters);
    // 원본 timeframe 은 옮기지 않는다 — 위저드가 만들 수 있는 값은 이제 '1d' 하나뿐이라
    // 옛 잡의 값('1m'·'1h')을 그대로 두면 고칠 UI 도 없이 제출이 막힌다.
    setUniverseRule(state.universeRule);
    // 원본의 유니버스 규칙만 옮긴다 — 실제 종목 구성은 이 화면에서 다시 미리보기해야
    // 얻는다(제출 시점에 서버가 새로 재구성하므로 옛 목록은 의미가 없다). lastPreview 를
    // 비워 두면 universePreviewOk 는 그 사실만으로 자연히 false 다(derive 위 참고).
    setLastPreview(null);
    setFrom(state.from);
    setTo(state.to);
    setInitialCash(state.initialCash);
    setMaxPositions(state.maxPositions);
    setCommissionProfileId(state.commissionProfileId);
    setSlippageProfileId(state.slippageProfileId);
    setRandomSeed(state.randomSeed);
    setPrefillNotes(notes);
    // 기본값 시딩 effect 가 원본 파라미터를 덮어쓰지 못하게 막는다.
    // 사용자가 전략을 직접 바꾸면 toggleStrategy 가 null 로 리셋해 정상 동작한다.
    seededFor.current = state.strategyId;
  }, [sourceJobId, draft.data, strategies.data]);

  // 같은 카드를 다시 누르면 선택 해제 — 접힌 목록을 다시 펼치는 유일한 경로다
  const toggleStrategy = (id: string): void => {
    setStrategyId((prev) => (prev === id ? null : id));
    setParameters({}); // 스키마가 도착하면 위 effect 가 기본값을 심는다
    seededFor.current = null;
    setStepError(null);
  };

  const paramValue = (spec: NumberParamSpec): string => parameters[spec.key] ?? '';

  // UniverseRuleStep 이 성공한 미리보기마다 그때 쓴 params·결과를 그대로 올려보낸다 —
  // 유효성 판정은 여기(부모)가 매 렌더 다시 한다(위 currentUniverseParams 주석 참고).
  const handlePreviewResolved = (
    params: PreviewParams,
    result: UniversePreviewResponseDto,
  ): void => {
    setLastPreview({ params, result });
  };

  // 위저드는 항상 timeframe 을 명시해 만든다(§9.5) — BacktestRequestBody 의 timeframe 이
  // optional 인 건 옛 잡과의 호환 때문이지, 이 화면이 만드는 요청과는 무관하다.
  const buildRequest = (): (BacktestRequestBody & { timeframe: '1d' }) | string => {
    if (!selectedStrategy) return '전략을 선택하세요';
    if (!universePreviewOk) return '유니버스 규칙을 미리보기하고 경고를 모두 해결하세요';
    if (!from || !to || from > to) return '기간이 올바르지 않습니다';
    const cash = Number(initialCash);
    if (!Number.isFinite(cash) || cash <= 0) return '초기 자본이 올바르지 않습니다';
    const positions = Number(maxPositions);
    // 상한 200 은 스키마(backtest-request.ts risk.maxPositions max)와 같은 값이다.
    if (!Number.isInteger(positions) || positions < 1 || positions > 200) {
      return '동시 보유 종목 상한은 1~200 이어야 합니다';
    }

    if (typeof parsedParameters === 'string') return parsedParameters;

    return {
      strategyId: selectedStrategy.id,
      parameters: parsedParameters,
      universeRule,
      // 항상 명시해 보낸다 — 결과·복제가 "무슨 봉으로 돌렸는지" 를 들고 다니게 (§9.5).
      // KRX 일봉이 유일한 출처라 고를 것 없이 이 값 하나로 고정한다.
      timeframe: wizardTimeframes[0],
      period: { from, to },
      capital: { initialCash: cash, currency: 'KRW' },
      execution: { fillTiming: 'NEXT_BAR_OPEN', commissionProfileId, slippageProfileId },
      risk: { maxPositions: positions },
      randomSeed: (() => {
        const seed = Number(randomSeed);
        return Number.isInteger(seed) && seed >= 0 ? seed : 42;
      })(),
    };
  };

  const submitMutation = useMutation({
    mutationFn: (body: BacktestRequestBody) =>
      postJson<{ job: { id: string }; warnings?: string[] }>('/backtests', body),
    onSuccess: (data) => {
      toast.success('백테스트가 대기열에 추가되었습니다');
      // 201 이 실어 보낸 경고를 버리지 않는다 — 복제 경로(`backtest-detail-page.tsx`)와 같다.
      // 자본변동 gap 경고가 여기로 온다.
      // 흘리면 "수집했고 분할이 없었다" 와 "gap 이 나서 확인하지 못했다" 가 같아 보인다.
      for (const warning of data.warnings ?? []) toast.warning(warning, { duration: 10_000 });
      void navigate(`/backtests/${data.job.id}`);
    },
    onError: (error: unknown) => {
      // 준비된 데이터가 아직 없다는 뜻이다(Task 6) — 검토·실행 단계에 머물며 같은
      // 사유를 빨간 배너로 띄우면 사용자는 "왜 실패했는지" 를 알 방법이 없다. 대신
      // 미리보기 단계로 돌려보내고 새 준비 요청을 바로 시작시킨다(브리프 5번).
      // 서버 `{error, message}` 관례상 사람이 읽는 문장은 details.message 에 있고
      // `error.message` 자체는 코드('PREPARATION_REQUIRED')다(api-client.ts 참고).
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.message === 'PREPARATION_REQUIRED'
      ) {
        setLastPreview(null);
        setPreviewRetryToken((token) => token + 1);
        goToSlug(recordTraversal(2));
        return;
      }
      setStepError(error instanceof ApiError ? error.message : '제출에 실패했습니다');
    },
  });

  // 단계 게이트가 보는 값만 모아 넘긴다 — 규칙은 wizard-steps.ts 한 곳에 있다
  // preview가 확정한 종목만 서버의 실제 재무 행으로 판정한다. 구 서버가 이 필드를
  // 내리지 않으면 undefined로 남겨 근거 없이 "재무 없음"으로 단정하지 않는다.
  const symbolsWithFacts = currentPreviewResult?.fundamentalSymbols;
  const gate: StepGateState = {
    strategyId,
    from,
    to,
    initialCash,
    universePreviewOk,
    requiresFundamentals: selectedStrategy?.requiresFundamentals,
    symbolsWithFacts,
    unionSymbols,
  };
  const reachable = reachableStepFromUrl(gate, { traversed, reviewPassed });
  /**
   * 단계의 출처는 URL 이다. state 로도 들고 있으면 뒤로가기가 URL 만 바꾸고 state 는
   * 낡은 값으로 남는 경합이 생긴다.
   *
   * 갈 수 없는 곳을 가리키는 URL 은 **렌더 단계에서 바로 좁힌다**. 아래 effect 로만
   * 고치면 그 사이 한 프레임이 그려져, 검토 화면의 `buildRequest` 오류가 빨간 배너로
   * 번쩍인 뒤 사라진다. effect 는 URL 표기를 뒤따라 맞추는 일만 맡는다.
   */
  const step = urlStep === null ? 0 : Math.min(urlStep, reachable);
  const navLimit = navigableStepLimit(step, gate);

  // 비용 프로필은 자본·비용 단계에서만 표시한다. 실제 렌더 단계에 묶어 갈 수 없는
  // deep link가 첫 단계로 접힐 때도 불필요한 조회를 시작하지 않는다.
  const profiles = useQuery({
    queryKey: ['backtests', 'profiles'],
    queryFn: () =>
      api<{
        commissionProfiles: CommissionProfileSummary[];
        slippageProfiles: SlippageProfileSummary[];
      }>('/backtests/profiles'),
    enabled: step === 3,
  });

  /**
   * 단계 이동은 모두 push 다 — 이동 하나가 이력 한 칸을 차지해야 뒤로가기가 직전
   * 이동을 되돌린다. `location.search` 를 이어붙여 `?from=` 복제 맥락을 유지한다.
   */
  const goToSlug = (target: number, options?: { replace?: boolean }): void => {
    void navigate(
      { pathname: `/backtests/new/${stepSlug(target)}`, search: location.search },
      options,
    );
  };

  /**
   * 이 단계를 스스로 지나왔다고 기록한다. 클램프가 나중에 이 단계를 되돌리지 않는 근거가
   * 되므로 위저드가 실제로 이동시키는 자리에서만 부른다 — 뒤로가기로 온 이동은 이미
   * 지나온 자리라서 기록할 것이 없다.
   */
  const recordTraversal = (target: number): number => {
    setTraversed((prev) => Math.max(prev, target));
    return target;
  };

  const goNext = (): void => {
    const error = stepBlocker(step, gate);
    if (error) {
      setStepError(error);
      return;
    }
    // 검토를 지났다는 사실을 여기서만 세운다 — 실행 단계 URL 의 유일한 열쇠다
    if (step === REVIEW_STEP) setReviewPassed(true);
    goToSlug(recordTraversal(Math.min(step + 1, RUN_STEP)));
  };

  // 상단 버튼으로 바로 이동. 잠긴 단계는 여기 오지 않는다(호출부가 이유를 띄운다)
  const goToStep = (target: number): void => {
    if (target === step || target < 0 || target > navLimit) return;
    goToSlug(recordTraversal(target));
  };

  const request = step >= REVIEW_STEP ? buildRequest() : null;

  // 검토 줄은 종목 하나가 한 줄을 쓴다 — 개수는 5개로 접고, 이름은 글자수로 줄이고,
  // 폭 맞춤은 SymbolLabel 이 한다(코드는 잘리지 않는다). 전체 목록은 title 로 남긴다.
  const reviewSymbols = unionSymbols;
  const reviewShownSymbols = reviewSymbols.slice(0, SYMBOL_SUMMARY_LIMIT);
  const reviewRestCount = reviewSymbols.length - reviewShownSymbols.length;
  const symbolsFullText = reviewSymbols.map(symbolLabel).join(', ');

  // 초안뿐 아니라 전략 카탈로그가 실패해도 프리필 effect 는 영영 끝나지 않는다 —
  // 그대로 두면 스켈레톤에 갇힌다. 둘 중 하나라도 실패하면 프리필을 포기하고 폼을 보여준다.
  const prefillError = sourceJobId !== null && (draft.isError || strategies.isError);

  // 프리필 중에는 폼을 감춘다 — 입력하던 값이 프리필에 덮이는 경합을 없앤다
  const prefilling =
    sourceJobId !== null && prefilledFrom.current !== sourceJobId && !prefillError;

  /**
   * URL 표기를 지금 그리고 있는 단계에 맞춘다. 좁히는 판단은 위 `step` 이 이미 했고,
   * 여기서는 주소창만 뒤따라 고친다. `replace` 라서 갈 수 없던 단계가 이력에 남지 않는다.
   *
   * 모르는 slug 는 갈 수 있는 곳이 아니라 **첫 단계**로 접는다 — 복제 초안이 게이트를
   * 열어 두었더라도 확인해야 할 전략·기간 화면을 건너뛰게 하지 않는다(설계의 옛 URL 호환 표).
   *
   * `prefilling` 중에는 보류한다: 복제 초안이 도착하기 전의 빈 게이트를 근거로 삼으면
   * 곧 채워질 폼을 이유 없이 버린다.
   */
  useEffect(() => {
    if (prefilling) return;
    if (urlStep === null) {
      goToSlug(0, { replace: true });
      return;
    }
    if (urlStep !== step) goToSlug(step, { replace: true });
  }, [urlStep, step, prefilling]);

  // 단계가 바뀌면 앞 단계의 오류 문장을 지운다. 단계의 출처가 URL 이므로 이동 함수가
  // 아니라 단계 변화에 매단다 — 뒤로가기로 온 이동도 같이 걸린다.
  useEffect(() => {
    setStepError(null);
    // 검토보다 앞으로 돌아가면 '검토를 지났다' 를 취소한다 — 설정을 고친 뒤 앞으로가기로
    // 제출 화면에 되돌아오는 길을 막는다. 다시 들어가려면 검토에서 '다음' 을 눌러야 한다.
    if (step < REVIEW_STEP) setReviewPassed(false);
    // 실행 화면을 벗어나면 다음 진입은 새 시도다 — 낡은 제출 실패가 흔적으로 남지 않게 한다.
    if (step !== RUN_STEP) submitMutation.reset();
  }, [step]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h2 className="text-lg font-semibold">
        {sourceJobId !== null ? '재설정 및 복제' : '새 백테스트'}
      </h2>

      {prefillError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {draft.isError
              ? draft.error instanceof ApiError
                ? draft.error.message
                : '원본 설정을 불러올 수 없습니다'
              : '전략 목록을 불러올 수 없어 원본 설정을 채우지 못했습니다 — 처음부터 선택하세요.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {(draft.data?.blockers ?? []).length > 0 ? (
        <Alert variant="destructive">
          <AlertDescription>
            원본 그대로는 제출할 수 없습니다 — 아래를 고치세요.
            <ul className="mt-1 list-disc pl-5">
              {(draft.data?.blockers ?? []).map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {[...(draft.data?.warnings ?? []), ...prefillNotes].length > 0 ? (
        <Alert>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {[...(draft.data?.warnings ?? []), ...prefillNotes].map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {prefilling ? <Skeleton className="h-64 w-full" /> : null}

      {prefilling ? null : (
        // 3열 × 2행 — 44px 터치 영역을 지키면서 여섯 단계가 좁은 화면에 들어간다
        <nav aria-label="진행 단계">
          <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
            {WIZARD_STEPS.map((label, index) => {
              const lockReason = stepJumpBlockReason(index, step, gate);
              const current = index === step;
              return (
                <li key={label}>
                  <button
                    type="button"
                    aria-current={current ? 'step' : undefined}
                    // disabled 대신 aria-disabled — 포커스와 클릭을 살려 두고 왜 못
                    // 가는지 오류 영역에 문장으로 알린다 (스펙 §17 접근성)
                    aria-disabled={lockReason !== null}
                    title={lockReason ?? undefined}
                    onClick={() => {
                      if (lockReason !== null) setStepError(lockReason);
                      else goToStep(index);
                    }}
                    className={cn(
                      'flex min-h-11 w-full items-center justify-center rounded-lg px-1.5 text-center text-xs transition-colors',
                      current
                        ? 'bg-primary font-medium text-primary-foreground'
                        : lockReason !== null
                          ? 'cursor-not-allowed bg-muted/40 text-muted-foreground'
                          : 'bg-muted text-foreground hover:bg-muted/70',
                    )}
                  >
                    {index + 1}. {label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {stepError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{stepError}</AlertDescription>
        </Alert>
      ) : null}

      {!prefilling && step === 0 ? (
        <div className="space-y-3">
          {/* 마지막 카드의 pb-3 을 상쇄한다 — 접힘 애니메이션이 여백까지 같이 줄이도록
              간격을 space-y 가 아니라 카드 안쪽 패딩으로 준 대가다 */}
          <div className="-mb-3">
            {(strategies.data?.strategies ?? []).map((strategy) => {
              const selected = strategyId === strategy.id;
              const collapsed = strategyId !== null && !selected;
              // 배지는 모든 카드에, 풀어 쓴 한 줄은 고른 카드에만 — 목록을 훑는 동안은
              // 배지만으로 충분하고, 고른 뒤에는 무엇이 개입하는지 문장으로 확인시킨다
              const requirement = strategyDataRequirement(strategy.requiresFundamentals);
              const dataDetail =
                selected && requirement !== null ? STRATEGY_DATA_DETAILS[requirement] : null;
              return (
                <div
                  key={strategy.id}
                  // grid-rows 0fr↔1fr 은 height:auto 를 트랜지션하는 표준 방법이다
                  className={cn(
                    'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                    collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
                  )}
                  // 접힌 카드는 클릭·탭 이동·스크린리더에서 모두 빠진다
                  inert={collapsed}
                >
                  {/* overflow-hidden 이 grid 항목의 자동 최소 높이를 0 으로 풀어 준다.
                      아래 간격은 그 안쪽에 둬야 접힐 때 패딩까지 같이 사라진다 */}
                  <div className="overflow-hidden">
                    <div className="pb-3">
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleStrategy(strategy.id)}
                        className={cn(
                          'w-full rounded-xl border p-4 text-left transition-colors',
                          selected ? 'border-primary bg-muted/50' : 'hover:bg-muted/30',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium">
                            {strategy.name}{' '}
                            <span className="text-xs text-muted-foreground">
                              v{strategy.version}
                            </span>
                          </p>
                          <StrategyDataBadge
                            requiresFundamentals={strategy.requiresFundamentals}
                          />
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{strategy.description}</p>
                        {dataDetail ? (
                          <p className="mt-2 text-xs text-muted-foreground">{dataDetail}</p>
                        ) : null}
                        {/* 데이터 요구 문장과 붙으면 한 덩어리로 읽힌다 — 조작 안내는
                            설명이 아니므로 간격으로 떼어 놓는다 */}
                        {selected ? (
                          <p className="mt-3 text-xs text-muted-foreground">
                            다시 누르면 선택을 해제합니다
                          </p>
                        ) : null}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {selectedStrategy && paramSpecs.length > 0 ? (
            <Card className="animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none">
              <CardHeader>
                <CardTitle className="text-base">파라미터</CardTitle>
                <CardDescription>검증된 범위 내에서만 조정할 수 있습니다.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                {paramSpecs.map((spec) => (
                  <div key={spec.key} className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label htmlFor={`param-${spec.key}`} className="text-xs">
                        {paramLabel(spec)}
                        {spec.optional ? ' (선택)' : ''}
                      </Label>
                      <ParamHint spec={spec} />
                    </div>
                    <Input
                      id={`param-${spec.key}`}
                      type="number"
                      inputMode="decimal"
                      className="h-11"
                      min={spec.minimum}
                      max={spec.maximum}
                      step={spec.isInteger ? 1 : 'any'}
                      value={paramValue(spec)}
                      onChange={(e) =>
                        setParameters((prev) => ({ ...prev, [spec.key]: e.target.value }))
                      }
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* '기간' 이 '유니버스' 보다 앞이다(리뷰 fix) — 유니버스 미리보기가 기간을
          필요로 하므로, 기간을 먼저 확정해야 다음 단계가 그 값을 바로 쓸 수 있다. */}
      {!prefilling && step === 1 ? (
        <Card>
          <CardContent className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="from">시작일</Label>
              <Input
                id="from"
                type="date"
                className="h-11"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">종료일</Label>
              <Input
                id="to"
                type="date"
                className="h-11"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!prefilling && step === 2 ? (
        <div className="space-y-3">
          <UniverseRuleStep
            value={universeRule}
            onChange={setUniverseRule}
            period={{ from, to }}
            strategyId={strategyId}
            parameters={parsedParameters}
            previewRetryToken={previewRetryToken}
            onPreviewResolved={handlePreviewResolved}
          />

          {/* 게이트 문장은 「다음」을 눌러야 오류 영역에 뜬다 — 재무 조합처럼 미리보기가
              성공한 뒤에만 드러나는 어긋남은 여기서 바로 보여야 왕복이 없다 (D-027 과 같은
              방향). 미리보기 자체가 안 된 상태의 메시지는 UniverseRuleStep 이 이미 보여준다. */}
          {universePreviewOk && stepBlocker(2, gate) !== null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{stepBlocker(2, gate)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {!prefilling && step === 3 ? (
        <Card>
          <CardContent className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="cash">초기 자본 (KRW)</Label>
              <Input
                id="cash"
                type="number"
                inputMode="numeric"
                className="h-11"
                value={initialCash}
                onChange={(e) => setInitialCash(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="commission">수수료 프로파일</Label>
                <Select value={commissionProfileId} onValueChange={setCommissionProfileId}>
                  <SelectTrigger id="commission" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(profiles.data?.commissionProfiles ?? []).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.id} (v{profile.version}) — {costProfileLabel(profile)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="slippage">슬리피지 프로파일</Label>
                <Select value={slippageProfileId} onValueChange={setSlippageProfileId}>
                  <SelectTrigger id="slippage" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(profiles.data?.slippageProfiles ?? []).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.id} (v{profile.version}) — {slippageProfileLabel(profile)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="max-positions">동시 보유 종목 상한</Label>
              <Input
                id="max-positions"
                type="number"
                inputMode="numeric"
                className="h-11"
                min={1}
                max={200}
                step={1}
                value={maxPositions}
                onChange={(e) => setMaxPositions(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seed">Random seed</Label>
              <Input
                id="seed"
                type="number"
                inputMode="numeric"
                className="h-11"
                value={randomSeed}
                onChange={(e) => setRandomSeed(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!prefilling && step >= REVIEW_STEP ? (
        typeof request === 'string' ? (
          <Alert variant="destructive">
            <AlertDescription>{request}</AlertDescription>
          </Alert>
        ) : request ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {step === REVIEW_STEP ? '검토' : '실행 준비 완료'}
              </CardTitle>
              <CardDescription>제출 전 설정을 확인하세요.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">전략</span>
                {/* 버전은 요청이 아니라 레지스트리에서 읽는다 (D-029) — 실행되는 것도
                    제출 시점에 등록돼 있는 전략이다. 데이터 요구 배지를 여기 한 번 더
                    두는 이유: 제출 직전이 재무 개입을 알아차릴 마지막 지점이다 */}
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                  <span>
                    {request.strategyId}
                    {selectedStrategy ? ` v${selectedStrategy.version}` : ''}
                  </span>
                  <StrategyDataBadge
                    requiresFundamentals={selectedStrategy?.requiresFundamentals}
                  />
                </span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">유니버스 규칙</span>
                {/* 단계형 편집기(Task 9)가 시가총액 외 기준·다단계를 허용한 뒤로는 첫
                    단계만 읽는 하드코딩된 문구가 실제 규칙과 어긋날 수 있다 — 상세
                    화면과 같은 요약 함수를 그대로 쓴다(리뷰에서 재현된 회귀). */}
                <span>{formatUniverseRuleSummary(request.universeRule)}</span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                {/* 라벨은 줄어들지 않고('종목' 이 '종'+'목' 으로 쪼개지지 않게), 값은
                    min-w-0 로 줄어들 수 있어야 truncate 가 동작한다 */}
                <span className="shrink-0 text-muted-foreground">종목</span>
                <span className="flex min-w-0 flex-col items-end" title={symbolsFullText}>
                  {reviewShownSymbols.map((symbol) => (
                    <SymbolLabel
                      key={symbol}
                      symbol={symbol}
                      name={clampSymbolName(nameOf(symbol))}
                      className="max-w-full"
                    />
                  ))}
                  {reviewRestCount > 0 ? (
                    <span className="text-muted-foreground">외 {reviewRestCount}종목</span>
                  ) : null}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">봉 주기</span>
                <span>{timeframeLabel(request.timeframe)}</span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">기간</span>
                <span>
                  {request.period.from} ~ {request.period.to}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">초기 자본</span>
                <span>{formatKrw(request.capital.initialCash)}</span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">비용</span>
                <span>
                  {request.execution.commissionProfileId} / {request.execution.slippageProfileId}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">파라미터</span>
                <span className="text-right font-mono text-xs">
                  {Object.entries(request.parameters)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' ')}
                </span>
              </div>
            </CardContent>
          </Card>
        ) : null
      ) : null}

      {prefilling ? null : (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={step === 0}
            onClick={() => goToStep(step - 1)}
          >
            이전
          </Button>
          {step < RUN_STEP ? (
            <Button className="h-11" onClick={goNext}>
              다음
            </Button>
          ) : (
            <Button
              className="h-11"
              disabled={typeof request === 'string' || submitMutation.isPending}
              onClick={() => {
                if (request && typeof request !== 'string') submitMutation.mutate(request);
              }}
            >
              {submitMutation.isPending ? '제출 중…' : '백테스트 실행'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
