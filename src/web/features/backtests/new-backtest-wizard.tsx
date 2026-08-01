import { useMutation, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
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
import { formatKrw, formatRelativeTime, timeframeLabel } from '@/lib/format';
import { wizardTimeframes } from '@/features/datasets/dataset-slices';
import { SymbolFactsBadge } from '@/features/datasets/symbol-facts-badge';
import { SymbolSortNote, SymbolSortSelect } from '@/features/datasets/symbol-list';
import {
  countWithMetric,
  SYMBOL_SORT_LABELS,
  type SymbolSortKey,
} from '@/features/datasets/symbol-sort';
import type { SymbolSummary } from '@/features/datasets/symbol-types';
import { MAX_UNIVERSE_SYMBOLS, selectUniverse } from './dataset-universe';
import { costProfileLabel, slippageProfileLabel } from './profile-labels';
import { useStockNames } from '@/lib/use-stock-names';
import { useSymbolMetrics } from '@/lib/use-symbol-metrics';
import { requestToFormState } from './prefill';
import { ParamHint } from './param-hint';
import { extractNumberParams, paramLabel, type NumberParamSpec } from './param-specs';
import { StrategyDataBadge } from './strategy-data-badge';
import { STRATEGY_DATA_DETAILS, strategyDataRequirement } from './strategy-data-requirement';
import { SymbolLabel } from '@/components/symbol-label';
import {
  clampSymbolName,
  formatSymbolLabel,
  SYMBOL_SUMMARY_LIMIT,
} from './symbol-summary';
import type { BacktestRequestBody } from './types';
import {
  navigableStepLimit,
  REVIEW_STEP,
  RUN_STEP,
  stepBlocker,
  stepJumpBlockReason,
  WIZARD_STEPS,
  type StepGateState,
} from './wizard-steps';

interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
  /**
   * 서버는 항상 boolean 을 내리지만(`StrategySummary`) 응답을 런타임 검증하지 않으므로
   * 낡은 서버·프록시 응답에서는 없을 수 있다. 없는 것을 false 로 좁히지 않고 그대로
   * 흘려보내 배지가 침묵하게 한다 (`strategyDataRequirement`).
   */
  requiresFundamentals?: boolean;
}

interface DatasetSummary {
  id: string;
  name: string;
  description: string | null;
  symbols: string[];
}

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

export function NewBacktestWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [strategyId, setStrategyId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [datasetId, setDatasetId] = useState<string | null>(null);
  // 소비 봉 주기 — '' 는 아직 정해지지 않음(프리필 초기값이거나 데이터셋 미선택). 사용자가
  // 목록에서 데이터셋을 고르면 그 자리에서 wizardTimeframes 첫 항목으로 명시값을 채운다.
  const [timeframe, setTimeframe] = useState('');
  /**
   * 유니버스는 **데이터셋이 정한다** — 위저드에서 종목을 하나씩 고르는 UI 는 없앴다
   * (D-038). 이 상태는 복제 프리필이 원본 요청의 종목 목록을 그대로 되살릴 때만 쓴다:
   * 예전 화면에서 부분 선택으로 만든 잡을 복제하면서 유니버스를 조용히 바꾸면
   * 「재실행」이 재실행이 아니게 된다. 데이터셋을 새로 고르거나 정렬을 바꾸면 null 로
   * 되돌리고 데이터셋에서 다시 도출한다.
   */
  const [prefilledSymbols, setPrefilledSymbols] = useState<string[] | null>(null);
  /** 상한을 넘는 데이터셋에서 상위 N종목을 고를 기준 — 종목 화면의 정렬과 같은 축이다 */
  const [universeSortKey, setUniverseSortKey] = useState<SymbolSortKey>('MARKET_CAP');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [initialCash, setInitialCash] = useState('10000000');
  // 기본값 20 — 스키마 최댓값(risk.maxPositions ≤ 20)이자, 등록된 세 전략(topN 없음/10/20)이
  // 모두 기본값만으로 제출 게이트(topN > maxPositions 422)를 통과하는 값이다
  const [maxPositions, setMaxPositions] = useState('20');
  const [commissionProfileId, setCommissionProfileId] = useState('kr-equity-default');
  const [slippageProfileId, setSlippageProfileId] = useState('fixed-5bps');
  const [randomSeed, setRandomSeed] = useState('42');
  const [stepError, setStepError] = useState<string | null>(null);

  const strategies = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: StrategySummary[] }>('/strategies'),
  });
  const schema = useQuery({
    queryKey: ['strategies', strategyId, 'schema'],
    queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${strategyId}/schema`),
    enabled: strategyId !== null,
  });
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<{ datasets: DatasetSummary[] }>('/datasets'),
  });
  // 봉 보유·재무 보유·수집 시각은 이제 종목에 있다 — 데이터셋 카드는 참조 종목을
  // 모아서 그린다 (설계 2026-07-31-symbol-as-first-class)
  const symbolsQuery = useQuery({
    queryKey: ['symbols'],
    queryFn: () => api<{ symbols: SymbolSummary[] }>('/symbols'),
  });
  const profiles = useQuery({
    queryKey: ['backtests', 'profiles'],
    queryFn: () =>
      api<{
        commissionProfiles: CommissionProfileSummary[];
        slippageProfiles: SlippageProfileSummary[];
      }>('/backtests/profiles'),
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
  const selectedDataset = datasets.data?.datasets.find((d) => d.id === datasetId) ?? null;
  // 데이터셋 카드의 "마지막 수집 N일 전" 기준 시각 — 렌더 시점으로 충분하다
  const nowMs = Date.now();
  // useMemo 인 이유: 유니버스 도출이 이 Map 을 의존성으로 읽는다. 매 렌더 새 Map 이면
  // 1,000종목 데이터셋을 매 렌더 다시 정렬하게 된다.
  const symbolByCode = useMemo(
    () => new Map((symbolsQuery.data?.symbols ?? []).map((s) => [s.code, s])),
    [symbolsQuery.data],
  );
  /**
   * 데이터셋의 봉 슬라이스 보유 = 참조 종목 **전부** 가 그 슬라이스를 가진 경우.
   * 하나라도 비면 그 봉으로 돌릴 수 없다 — any 로 열면 일부 종목이 조용히 0봉으로 빠진다.
   */
  const slicesOf = (codes: readonly string[]) =>
    (['1d', '1m'] as const).map((slice) => ({
      slice,
      hasData:
        codes.length > 0 &&
        codes.every((code) =>
          symbolByCode.get(code)?.slices.some((s) => s.slice === slice && s.hasData) === true,
        ),
    }));
  /** 재무는 전 종목이 갖고 있어야 「재무 있음」이다 — 랭킹은 빠진 종목을 조용히 버린다 */
  const factsOf = (codes: readonly string[]): boolean | undefined => {
    if (codes.length === 0 || symbolsQuery.data === undefined) return undefined;
    return codes.every((code) => symbolByCode.get(code)?.hasFacts === true);
  };
  /** 카드의 마지막 수집은 참조 종목 중 가장 오래된 값 — 묵음은 가장 약한 고리가 정한다 */
  const lastSyncOf = (codes: readonly string[]): number | null => {
    const times = codes.flatMap((code) =>
      (symbolByCode.get(code)?.slices ?? [])
        .filter((s) => s.hasData)
        .map((s) => s.lastSyncedAtMs),
    );
    if (times.length === 0 || times.some((time) => time === null)) return null;
    return Math.min(...(times as number[]));
  };
  // 카드 노출·기본값 계산에 반복해서 쓰인다 — 보유 슬라이스(hasData) 기준으로 도출
  const timeframeOptions = selectedDataset ? wizardTimeframes(slicesOf(selectedDataset.symbols)) : [];

  /**
   * 유니버스 도출. 데이터셋이 상한(200종목)을 넘으면 정렬 상위 200종목만 담는다 —
   * 규칙은 `dataset-universe.ts` 에 있고 종목 화면과 같은 정렬 함수를 쓴다.
   *
   * 상태가 아니라 파생값이다. 데이터셋을 고를 때 한 번 계산해 담아 두면 지표가 뒤늦게
   * 도착했을 때 가나다순으로 자른 200종목이 그대로 제출된다 — 화면은 「시가총액순」이라고
   * 적고 있는데 실제 유니버스는 다른, 눈에 보이지 않는 어긋남이다.
   */
  const { metrics, rankingLimit, unavailable: metricsUnavailable } = useSymbolMetrics();
  const universe = useMemo(() => {
    const codes = selectedDataset?.symbols ?? [];
    const members = codes.map((code) => ({
      code,
      name: symbolByCode.get(code)?.name ?? null,
    }));
    return selectUniverse(members, universeSortKey, metrics);
  }, [selectedDataset, symbolByCode, universeSortKey, metrics]);
  const symbols = prefilledSymbols ?? universe.symbols;
  // 선택 후보 전체를 한 번에 조회한다 — 체크박스와 검토 단계가 같은 Map 을 쓴다.
  const stockNames = useStockNames(selectedDataset?.symbols ?? []);
  const nameOf = (symbol: string): string | null => stockNames.get(symbol)?.name ?? null;
  const symbolLabel = (symbol: string): string => formatSymbolLabel(symbol, nameOf(symbol));
  const paramSpecs = useMemo(() => extractNumberParams(schema.data?.schema), [schema.data]);

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
    if (!strategies.data || !datasets.data) return;
    prefilledFrom.current = sourceJobId;

    const { state, notes } = requestToFormState(draft.data.request, {
      strategyIds: strategies.data.strategies.map((s) => s.id),
      datasets: datasets.data.datasets,
    });
    setStrategyId(state.strategyId);
    setParameters(state.parameters);
    setDatasetId(state.datasetId);
    setTimeframe(state.timeframe);
    // 원본 요청의 유니버스를 그대로 되살린다 — 부분 선택으로 만든 예전 잡의 복제가
    // 데이터셋 전체로 넓어지면 「재실행」이 재실행이 아니게 된다
    setPrefilledSymbols(state.symbols);
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
  }, [sourceJobId, draft.data, strategies.data, datasets.data]);

  // 같은 카드를 다시 누르면 선택 해제 — 접힌 목록을 다시 펼치는 유일한 경로다
  const toggleStrategy = (id: string): void => {
    setStrategyId((prev) => (prev === id ? null : id));
    setParameters({}); // 스키마가 도착하면 위 effect 가 기본값을 심는다
    seededFor.current = null;
    setStepError(null);
  };

  const paramValue = (spec: NumberParamSpec): string => parameters[spec.key] ?? '';

  // 위저드는 항상 timeframe 을 명시해 만든다(§9.5) — BacktestRequestBody 의 timeframe 이
  // optional 인 건 옛 잡과의 호환 때문이지, 이 화면이 만드는 요청과는 무관하다.
  const buildRequest = (): (BacktestRequestBody & { timeframe: '1m' | '1h' | '1d' }) | string => {
    if (!selectedStrategy) return '전략을 선택하세요';
    if (!selectedDataset || symbols.length === 0) return '데이터셋과 종목을 선택하세요';
    if (!from || !to || from > to) return '기간이 올바르지 않습니다';
    const cash = Number(initialCash);
    if (!Number.isFinite(cash) || cash <= 0) return '초기 자본이 올바르지 않습니다';
    const positions = Number(maxPositions);
    if (!Number.isInteger(positions) || positions < 1 || positions > 20) {
      return '동시 보유 종목 상한은 1~20 이어야 합니다';
    }

    const parsedParams: Record<string, number> = {};
    for (const spec of paramSpecs) {
      const raw = paramValue(spec);
      const label = paramLabel(spec);
      if (raw === '') {
        if (spec.optional) continue;
        return `${label} 을(를) 입력하세요`;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return `${label} 이(가) 숫자가 아닙니다`;
      if (spec.minimum !== undefined && value < spec.minimum)
        return `${label} 은(는) ${spec.minimum} 이상이어야 합니다`;
      if (spec.maximum !== undefined && value > spec.maximum)
        return `${label} 은(는) ${spec.maximum} 이하여야 합니다`;
      parsedParams[spec.key] = spec.isInteger ? Math.round(value) : value;
    }

    return {
      strategyId: selectedStrategy.id,
      parameters: parsedParams,
      datasetId: selectedDataset.id,
      // 항상 명시해 보낸다 — 결과·복제가 "무슨 봉으로 돌렸는지" 를 들고 다니게 (§9.5)
      // 사용자가 카드를 만지지 않았으면(timeframe==='') 도출 목록의 첫 항목이 기본이다.
      // 도출 목록마저 비어 있는 극단적 경우엔 legacyConsumeDefault 와 같은 규칙으로 폴백한다.
      timeframe: (timeframe === ''
        ? (timeframeOptions[0] ?? '1d')
        : timeframe) as '1m' | '1h' | '1d',
      universe: { type: 'SYMBOLS', symbols },
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
      postJson<{ job: { id: string } }>('/backtests', body),
    onSuccess: (data) => {
      toast.success('백테스트가 대기열에 추가되었습니다');
      void navigate(`/backtests/${data.job.id}`);
    },
    onError: (error: unknown) => {
      setStepError(error instanceof ApiError ? error.message : '제출에 실패했습니다');
    },
  });

  // 단계 게이트가 보는 값만 모아 넘긴다 — 규칙은 wizard-steps.ts 한 곳에 있다
  /**
   * 선택 종목 중 재무를 가진 코드. **선택 종목 전부의 재무 보유를 알 때만** 배열을 만든다.
   *
   * 응답이 아직 없거나, 목록에 없는 종목이 선택돼 있거나, `hasFacts` 가 빠진 응답이면
   * undefined 다 — 그런 상태에서 배열을 만들면 "모른다" 가 "전부 없다" 로 바뀌어
   * (`filter(hasFacts === true)` 가 빈 배열을 낸다) 게이트가 근거 없이 문을 잠근다.
   * D-032 배지가 필드 부재에 침묵하는 것과 같은 이유다.
   */
  const symbolsWithFacts = ((): readonly string[] | undefined => {
    if (symbolsQuery.data === undefined) return undefined;
    const known = new Map(symbolsQuery.data.symbols.map((s) => [s.code, s.hasFacts]));
    if (symbols.some((code) => known.get(code) === undefined)) return undefined;
    return symbols.filter((code) => known.get(code) === true);
  })();
  const gate: StepGateState = {
    strategyId,
    datasetId,
    symbols,
    from,
    to,
    initialCash,
    requiresFundamentals: selectedStrategy?.requiresFundamentals,
    symbolsWithFacts,
  };
  const navLimit = navigableStepLimit(step, gate);

  const goNext = (): void => {
    const error = stepBlocker(step, gate);
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(s + 1, RUN_STEP));
  };

  // 상단 버튼으로 바로 이동. 잠긴 단계는 여기 오지 않는다(호출부가 이유를 띄운다)
  const goToStep = (target: number): void => {
    if (target === step || target < 0 || target > navLimit) return;
    setStepError(null);
    setStep(target);
  };

  const request = step >= REVIEW_STEP ? buildRequest() : null;

  // 검토 줄은 종목 하나가 한 줄을 쓴다 — 개수는 5개로 접고, 이름은 글자수로 줄이고,
  // 폭 맞춤은 SymbolLabel 이 한다(코드는 잘리지 않는다). 전체 목록은 title 로 남긴다.
  const reviewSymbols =
    request !== null && typeof request !== 'string' ? request.universe.symbols : [];
  const reviewShownSymbols = reviewSymbols.slice(0, SYMBOL_SUMMARY_LIMIT);
  const reviewRestCount = reviewSymbols.length - reviewShownSymbols.length;
  const symbolsFullText = reviewSymbols.map(symbolLabel).join(', ');

  // 초안뿐 아니라 전략·데이터셋 카탈로그가 실패해도 프리필 effect 는 영영 끝나지 않는다 —
  // 그대로 두면 스켈레톤에 갇힌다. 셋 중 하나라도 실패하면 프리필을 포기하고 폼을 보여준다.
  const prefillError =
    sourceJobId !== null && (draft.isError || strategies.isError || datasets.isError);

  // 프리필 중에는 폼을 감춘다 — 입력하던 값이 프리필에 덮이는 경합을 없앤다
  const prefilling =
    sourceJobId !== null && prefilledFrom.current !== sourceJobId && !prefillError;

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
              : '전략·데이터셋 목록을 불러올 수 없어 원본 설정을 채우지 못했습니다 — 처음부터 선택하세요.'}
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

      {!prefilling && step === 1 ? (
        <div className="space-y-3">
          {(datasets.data?.datasets ?? []).length === 0 ? (
            <Alert>
              <AlertDescription>
                데이터셋이 없습니다. 데이터 화면에서 증권사 데이터셋을 만들거나 CSV 를 가져오세요.
              </AlertDescription>
            </Alert>
          ) : null}
          {/* 데이터셋 카드는 **데이터셋 자체만** 보여 준다 — 어떤 종목이 들어 있는지를
              여기서 고치지 않는다 (D-038). 「편집」은 데이터 화면의 그 데이터셋 편집으로
              보낸다: 참조를 바꾸는 화면이 둘이면 무엇이 최신인지 알 수 없다.

              카드를 `<button>` 하나로 두면 「편집」을 그 안에 넣을 수 없다(중첩 버튼).
              바깥은 `<div>` 로 두고 선택 버튼과 편집 버튼을 형제로 놓는다. */}
          {(datasets.data?.datasets ?? []).map((dataset) => (
            <div
              key={dataset.id}
              className={cn(
                'rounded-xl border transition-colors',
                datasetId === dataset.id ? 'border-primary bg-muted/50' : 'hover:bg-muted/30',
              )}
            >
              <div className="flex items-start gap-2 p-4">
                <button
                  type="button"
                  aria-pressed={datasetId === dataset.id}
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setDatasetId(dataset.id);
                    // 새 데이터셋의 슬라이스로 다시 도출한 첫 항목을 기본값으로 명시한다 —
                    // 이전 선택이 새 데이터셋에 새지 않게
                    const options = wizardTimeframes(slicesOf(dataset.symbols));
                    setTimeframe(options[0] ?? '1d');
                    // 데이터셋을 바꿨으면 프리필 유니버스는 근거를 잃는다
                    setPrefilledSymbols(null);
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{dataset.name}</p>
                    {/* 전략 카드와 같은 표기 — 1단계에서 「재무 필요」를 본 사용자가 여기서
                        「재무 없음」을 보면 제출 전에 조합이 어긋난 것을 알아차린다 */}
                    <SymbolFactsBadge hasFacts={factsOf(dataset.symbols)} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {dataset.symbols.length}종목 ·{' '}
                    {slicesOf(dataset.symbols)
                      .filter((s) => s.hasData)
                      .map((s) => timeframeLabel(s.slice))
                      .join('·') || '전 종목 공통 봉 없음'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    마지막 수집 {formatRelativeTime(lastSyncOf(dataset.symbols), nowMs)}
                  </p>
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void navigate(`/datasets?tab=datasets&edit=${dataset.id}`)}
                >
                  <SlidersHorizontal data-icon="inline-start" />
                  편집
                </Button>
              </div>
            </div>
          ))}
          {/* 게이트 문장은 「다음」을 눌러야 오류 영역에 뜬다 — 조합이 어긋난 것은
              종목을 고르는 그 자리에서 보여야 왕복이 없다 (D-027 과 같은 방향) */}
          {datasetId !== null && symbols.length > 0 && stepBlocker(1, gate) !== null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{stepBlocker(1, gate)}</AlertDescription>
            </Alert>
          ) : null}
          {timeframeOptions.length >= 2 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">봉 주기</CardTitle>
                {timeframeOptions.includes('1m') ? (
                  <CardDescription>
                    1분봉은 봉 수가 약 55배라 실행이 느리고, 기간·종목이 많으면 상한에 걸릴 수
                    있습니다.
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                <Select
                  value={timeframe === '' ? (timeframeOptions[0] ?? '') : timeframe}
                  onValueChange={(value) => setTimeframe(value)}
                >
                  <SelectTrigger className="h-11 w-full sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {timeframeOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {timeframeLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          ) : null}
          {/* 상한을 넘는 데이터셋만 이 카드를 띄운다. 1,000종목 데이터셋을 골라 놓고
              200종목만 돌아간 것을 결과 화면에서 알게 되는 상황을 없앤다 — 무엇을 기준으로
              자를지도 여기서 정한다. 상한 이하면 데이터셋 전체가 그대로 유니버스라
              고를 것이 없다. */}
          {selectedDataset && universe.truncated ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">종목 상한</CardTitle>
                <CardDescription>
                  이 데이터셋은 {universe.total}종목이라 백테스트 상한({MAX_UNIVERSE_SYMBOLS}
                  종목)을 넘습니다 — 아래 기준의 상위 {MAX_UNIVERSE_SYMBOLS}종목만 담고 나머지{' '}
                  {universe.droppedCount}종목은 빠집니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <SymbolSortSelect
                  value={universeSortKey}
                  unavailable={metricsUnavailable}
                  label="유니버스 선정 기준"
                  onChange={(next) => {
                    setUniverseSortKey(next);
                    // 기준을 직접 골랐으면 프리필 유니버스보다 그 선택이 우선한다
                    setPrefilledSymbols(null);
                  }}
                />
                <SymbolSortNote
                  sortKey={universeSortKey}
                  total={universe.total}
                  withMetric={countWithMetric(
                    selectedDataset.symbols,
                    universeSortKey,
                    metrics,
                  )}
                  rankingLimit={rankingLimit}
                  unavailable={metricsUnavailable}
                />
              </CardContent>
            </Card>
          ) : null}
          {selectedDataset && prefilledSymbols !== null ? (
            <Alert>
              <AlertDescription>
                원본 백테스트의 종목 {prefilledSymbols.length}개를 그대로 씁니다 — 데이터셋을
                다시 고르면 데이터셋 전체에서 새로 도출합니다.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {!prefilling && step === 2 ? (
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
                max={20}
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
                  {/* 잘렸다는 사실은 제출 직전에 한 번 더 말한다 — 2단계에서 읽고
                      네 단계를 지나온 사용자가 그것을 기억한다고 볼 수 없다 */}
                  {universe.truncated && prefilledSymbols === null ? (
                    <span className="text-muted-foreground">
                      {selectedDataset?.name} {universe.total}종목 중{' '}
                      {SYMBOL_SORT_LABELS[universeSortKey]} 상위 {universe.symbols.length}종목
                    </span>
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
