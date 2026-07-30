import { useMutation, useQuery } from '@tanstack/react-query';
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
import { formatKrw } from '@/lib/format';
import { useStockNames } from '@/lib/use-stock-names';
import { requestToFormState } from './prefill';
import { ParamHint } from './param-hint';
import { extractNumberParams, paramLabel, type NumberParamSpec } from './param-specs';
import { formatSymbolLabel } from './symbol-summary';
import type { BacktestRequestBody } from './types';

const STEPS = ['전략', '데이터·종목', '기간', '자본·비용', '검토', '실행'] as const;

interface StrategySummary {
  id: string;
  version: string;
  name: string;
  description: string;
}

interface DatasetSummary {
  id: string;
  name: string;
  market: string;
  timeframe: string;
  symbols: string[];
}

interface ProfileSummary {
  id: string;
  version: string;
}

export function NewBacktestWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [strategyId, setStrategyId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [datasetId, setDatasetId] = useState<string | null>(null);
  // 소비 봉 주기 — '' 는 데이터셋 기본 (1h 데이터셋이면 1h)
  const [timeframe, setTimeframe] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
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
  const profiles = useQuery({
    queryKey: ['backtests', 'profiles'],
    queryFn: () =>
      api<{ commissionProfiles: ProfileSummary[]; slippageProfiles: ProfileSummary[] }>(
        '/backtests/profiles',
      ),
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
  // 선택 후보 전체를 한 번에 조회한다 — 체크박스와 검토 단계가 같은 Map 을 쓴다.
  const stockNames = useStockNames(selectedDataset?.symbols ?? []);
  const symbolLabel = (symbol: string): string =>
    formatSymbolLabel(symbol, stockNames.get(symbol)?.name ?? null);
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
    setSymbols(state.symbols);
    setFrom(state.from);
    setTo(state.to);
    setInitialCash(state.initialCash);
    setMaxPositions(state.maxPositions);
    setCommissionProfileId(state.commissionProfileId);
    setSlippageProfileId(state.slippageProfileId);
    setRandomSeed(state.randomSeed);
    setPrefillNotes(notes);
    // 기본값 시딩 effect 가 원본 파라미터를 덮어쓰지 못하게 막는다.
    // 사용자가 전략을 직접 바꾸면 pickStrategy 가 null 로 리셋해 정상 동작한다.
    seededFor.current = state.strategyId;
  }, [sourceJobId, draft.data, strategies.data, datasets.data]);

  const pickStrategy = (id: string): void => {
    setStrategyId(id);
    setParameters({}); // 스키마가 도착하면 위 effect 가 기본값을 심는다
    seededFor.current = null;
  };

  const paramValue = (spec: NumberParamSpec): string => parameters[spec.key] ?? '';

  const buildRequest = (): BacktestRequestBody | string => {
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
      strategyVersion: selectedStrategy.version,
      parameters: parsedParams,
      datasetId: selectedDataset.id,
      // 항상 명시해 보낸다 — 결과·복제가 "무슨 봉으로 돌렸는지" 를 들고 다니게 (§9.5)
      timeframe: (timeframe === '' ? selectedDataset.timeframe : timeframe) as
        | '1m'
        | '1h'
        | '1d',
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

  const canProceed = (): string | null => {
    switch (step) {
      case 0:
        return strategyId ? null : '전략을 선택하세요';
      case 1:
        if (!datasetId) return '데이터셋을 선택하세요';
        if (symbols.length === 0) return '종목을 1개 이상 선택하세요';
        return null;
      case 2:
        if (!from || !to) return '시작일과 종료일을 입력하세요';
        if (from > to) return '시작일이 종료일보다 늦습니다';
        return null;
      case 3: {
        const cash = Number(initialCash);
        return Number.isFinite(cash) && cash > 0 ? null : '초기 자본이 올바르지 않습니다';
      }
      default:
        return null;
    }
  };

  const goNext = (): void => {
    const error = canProceed();
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const request = step >= 4 ? buildRequest() : null;

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

      <ol className="flex flex-wrap gap-1 text-xs" aria-label="진행 단계">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? 'step' : undefined}
            className={cn(
              'rounded-full px-2.5 py-1',
              index === step
                ? 'bg-primary text-primary-foreground'
                : index < step
                  ? 'bg-muted text-foreground'
                  : 'bg-muted/50 text-muted-foreground',
            )}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {stepError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{stepError}</AlertDescription>
        </Alert>
      ) : null}

      {!prefilling && step === 0 ? (
        <div className="space-y-3">
          {(strategies.data?.strategies ?? []).map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              onClick={() => pickStrategy(strategy.id)}
              className={cn(
                'w-full rounded-xl border p-4 text-left transition-colors',
                strategyId === strategy.id ? 'border-primary bg-muted/50' : 'hover:bg-muted/30',
              )}
            >
              <p className="font-medium">
                {strategy.name}{' '}
                <span className="text-xs text-muted-foreground">v{strategy.version}</span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{strategy.description}</p>
            </button>
          ))}
          {selectedStrategy && paramSpecs.length > 0 ? (
            <Card>
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
                데이터셋이 없습니다. 데이터 메뉴에서 CSV 를 먼저 가져오세요.
              </AlertDescription>
            </Alert>
          ) : null}
          {(datasets.data?.datasets ?? []).map((dataset) => (
            <button
              key={dataset.id}
              type="button"
              onClick={() => {
                setDatasetId(dataset.id);
                setTimeframe(''); // 데이터셋 기본으로 리셋 — 이전 선택이 새 데이터셋에 새지 않게
                setSymbols(dataset.symbols);
              }}
              className={cn(
                'w-full rounded-xl border p-4 text-left transition-colors',
                datasetId === dataset.id ? 'border-primary bg-muted/50' : 'hover:bg-muted/30',
              )}
            >
              <p className="font-medium">{dataset.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {dataset.market} · {dataset.timeframe === '1h' ? '1m→1h' : dataset.timeframe} ·{' '}
                {dataset.symbols.length}종목
              </p>
            </button>
          ))}
          {selectedDataset?.timeframe === '1h' ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">봉 주기</CardTitle>
                <CardDescription>
                  1분봉은 봉 수가 약 55배라 실행이 느리고, 기간·종목이 많으면 상한에 걸릴 수
                  있습니다.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={timeframe === '' ? '1h' : timeframe}
                  onValueChange={(value) => setTimeframe(value)}
                >
                  <SelectTrigger className="h-11 w-full sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">1시간봉</SelectItem>
                    <SelectItem value="1m">1분봉</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          ) : null}
          {selectedDataset ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">종목 선택</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {selectedDataset.symbols.map((symbol) => {
                  const checked = symbols.includes(symbol);
                  return (
                    <label
                      key={symbol}
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm',
                        checked ? 'border-primary bg-muted/50' : '',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={checked}
                        onChange={(e) =>
                          setSymbols((prev) =>
                            e.target.checked
                              ? [...prev, symbol]
                              : prev.filter((s) => s !== symbol),
                          )
                        }
                      />
                      {symbolLabel(symbol)}
                    </label>
                  );
                })}
              </CardContent>
            </Card>
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
                        {profile.id} (v{profile.version})
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
                        {profile.id} (v{profile.version})
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

      {!prefilling && step >= 4 ? (
        typeof request === 'string' ? (
          <Alert variant="destructive">
            <AlertDescription>{request}</AlertDescription>
          </Alert>
        ) : request ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {step === 4 ? '검토' : '실행 준비 완료'}
              </CardTitle>
              <CardDescription>제출 전 설정을 확인하세요.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">전략</span>
                <span>
                  {request.strategyId} v{request.strategyVersion}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">종목</span>
                <span>{request.universe.symbols.map(symbolLabel).join(', ')}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">봉 주기</span>
                <span>
                  {request.timeframe === '1m'
                    ? '1분봉'
                    : request.timeframe === '1d'
                      ? '일봉'
                      : '1시간봉'}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">기간</span>
                <span>
                  {request.period.from} ~ {request.period.to}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">초기 자본</span>
                <span>{formatKrw(request.capital.initialCash)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">비용</span>
                <span>
                  {request.execution.commissionProfileId} / {request.execution.slippageProfileId}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">파라미터</span>
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
            onClick={() => {
              setStepError(null);
              setStep((s) => Math.max(0, s - 1));
            }}
          >
            이전
          </Button>
          {step < STEPS.length - 1 ? (
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
