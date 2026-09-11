import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '@/lib/api-client';
import { formatDateTime, formatKrw, formatNumber, formatSignedPct } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { backtestRequestSchema } from '../../../shared/schemas/backtest-request.js';
import {
  buildPeriodValidationPlan, periodValidationConfigSchema,
  type PeriodValidationConfig, type PeriodValidationDto, type ValidationTrialDto,
} from '../../../shared/schemas/period-validation.js';
import { extractNumberParams, paramLabel, type NumberParamSpec } from './param-specs';
import type { BacktestRequestBody } from './types';

const MODE_LABELS = { HOLDOUT: '홀드아웃', OPTIMIZED_HOLDOUT: '최적화 홀드아웃', WALK_FORWARD: '워크포워드' };
const STATUS_LABELS: Record<string, string> = {
  ACTIVE: '진행 중', COMPLETED: '완료', FAILED: '실패', CANCELLING: '취소 중', CANCELLED: '취소',
  PENDING: '대기', QUEUED: '실행 대기', STARTING: '시작 중', RUNNING: '실행 중',
  INTERRUPTED: '중단', SKIPPED: '미실행', MISSING: '결과 없음',
  PREPARATION_QUEUED: '데이터 준비 대기', PREPARATION_RUNNING: '데이터 준비 중',
  PREPARATION_WAITING_DAILY_QUOTA: 'API 할당량 대기', PREPARATION_FAILED: '데이터 준비 실패',
  PREPARATION_CANCELLED: '데이터 준비 취소',
};
const active = (experiment: PeriodValidationDto): boolean => ['ACTIVE', 'CANCELLING'].includes(experiment.status);

function parameterText(trial: ValidationTrialDto | undefined, config: PeriodValidationConfig, specs: NumberParamSpec[]): string {
  if (!trial?.parameters) return '선택 대기';
  if (config.mode === 'HOLDOUT' || trial.role === 'BASELINE') return '원본 설정';
  return config.optimization.axes.map(({ key }) => {
    const spec = specs.find((item) => item.key === key);
    return `${spec ? paramLabel(spec) : key} ${String(trial.parameters![key])}`;
  }).join(' · ');
}

function TrialLink({ trial, children }: { trial: ValidationTrialDto | undefined; children: React.ReactNode }) {
  return trial?.jobId ? <Link className="underline underline-offset-4" to={`/backtests/${trial.jobId}`}>{children}</Link> : <>{children}</>;
}

function ValidationResult({ experiment, specs, refresh }: {
  experiment: PeriodValidationDto; specs: NumberParamSpec[]; refresh: () => Promise<void>;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (action: 'cancel' | 'delete') => api(`/backtest-validations/${experiment.id}${action === 'cancel' ? '/cancel' : ''}`, {
      method: action === 'cancel' ? 'POST' : 'DELETE',
    }),
    onSuccess: async () => { setDeleteOpen(false); await refresh(); },
  });
  const completed = experiment.trials.filter((trial) => trial.status === 'COMPLETED').length;
  const oos = experiment.trials.filter((trial) => trial.role === 'OOS' && trial.metrics);
  const returns = oos.map((trial) => trial.metrics!.totalReturnPct);
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">{MODE_LABELS[experiment.config.mode]} · {STATUS_LABELS[experiment.status]}</CardTitle>
        {active(experiment)
          ? <Button size="sm" variant="outline" disabled={mutation.isPending || experiment.status === 'CANCELLING'} onClick={() => mutation.mutate('cancel')}>실험 취소</Button>
          : <Button size="sm" variant="outline" onClick={() => setDeleteOpen(true)}>실험 삭제</Button>}
      </div>
      <p className="text-sm text-muted-foreground">{formatDateTime(experiment.createdAtMs)} · 실행 {completed}/{experiment.plan.totalRuns}회 완료 · 각 구간 초기자금 {formatKrw(experiment.initialCash)}</p>
      {experiment.config.mode !== 'HOLDOUT' ? <p className="text-sm text-muted-foreground">
        IS 선택 기준: {experiment.config.optimization.objective === 'sharpe' ? 'Sharpe' : 'CAGR'} 최대 · 매도 체결 {experiment.config.optimization.minTrades}건 이상 · MDD 크기 {experiment.config.optimization.maxDrawdownPct}% 이하
      </p> : null}
    </CardHeader>
    <CardContent className="space-y-3">
      {experiment.error || mutation.error ? <Alert variant="destructive"><AlertDescription>{experiment.error ?? mutation.error?.message}</AlertDescription></Alert> : null}
      {returns.length > 0 ? <p className="text-sm">
        {experiment.status === 'COMPLETED' ? 'OOS 전체 결과' : '완료된 OOS의 부분 결과'}: 수익 구간 {returns.filter((value) => value > 0).length}/{returns.length}개 · 최악 구간 {formatSignedPct(Math.min(...returns))}
      </p> : null}
      <Table>
        <TableHeader><TableRow>
          <TableHead>회차 / 기간</TableHead><TableHead>선택 매개변수</TableHead><TableHead>IS 수익률</TableHead>
          <TableHead>OOS 수익률</TableHead><TableHead>OOS CAGR</TableHead><TableHead>OOS MDD</TableHead><TableHead>OOS Sharpe</TableHead><TableHead>OOS 매도 체결</TableHead>
          {experiment.config.mode !== 'HOLDOUT' ? <TableHead>고정 전략 OOS</TableHead> : null}<TableHead>벤치마크 OOS</TableHead>
        </TableRow></TableHeader>
        <TableBody>{experiment.plan.folds.map((fold) => {
          const trials = experiment.trials.filter((trial) => trial.fold === fold.ordinal);
          const test = trials.find((trial) => trial.role === 'OOS');
          const train = trials.find((trial) => trial.role === 'TRAIN' && trial.candidate === (experiment.config.mode === 'HOLDOUT' ? 0 : test?.candidate));
          const baseline = trials.find((trial) => trial.role === 'BASELINE');
          return <TableRow key={fold.ordinal}>
            <TableCell className="whitespace-nowrap">{fold.ordinal + 1}회차<br />IS {fold.train.from} ~ {fold.train.to}<br />OOS {fold.test.from} ~ {fold.test.to}</TableCell>
            <TableCell>{parameterText(experiment.config.mode === 'HOLDOUT' ? train : test, experiment.config, specs)}</TableCell>
            <TableCell><TrialLink trial={train}>{formatSignedPct(train?.metrics?.totalReturnPct ?? null)}</TrialLink></TableCell>
            <TableCell><TrialLink trial={test}>{test?.metrics ? formatSignedPct(test.metrics.totalReturnPct) : STATUS_LABELS[test?.status ?? 'PENDING']}</TrialLink></TableCell>
            <TableCell>{formatSignedPct(test?.metrics?.cagrPct ?? null)}</TableCell><TableCell>{formatSignedPct(test?.metrics?.maxDrawdownPct ?? null)}</TableCell>
            <TableCell>{formatNumber(test?.metrics?.sharpe ?? null)}</TableCell><TableCell>{test?.metrics?.tradeCount ?? '-'}</TableCell>
            {experiment.config.mode !== 'HOLDOUT' ? <TableCell><TrialLink trial={baseline}>{formatSignedPct(baseline?.metrics?.totalReturnPct ?? null)}</TrialLink></TableCell> : null}
            <TableCell>{formatSignedPct(test?.benchmarkReturnPct ?? null)}</TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
      <details><summary className="cursor-pointer text-sm">후보별 실행과 상세 결과</summary>
        <Table><TableHeader><TableRow><TableHead>회차 / 용도</TableHead><TableHead>매개변수</TableHead><TableHead>상태</TableHead><TableHead>수익률</TableHead><TableHead>CAGR</TableHead><TableHead>MDD</TableHead><TableHead>Sharpe</TableHead><TableHead>매도 체결</TableHead></TableRow></TableHeader>
          <TableBody>{experiment.trials.map((trial) => <TableRow key={trial.id}>
            <TableCell>{trial.fold + 1} / {trial.role === 'TRAIN' ? 'IS 후보' : trial.role === 'BASELINE' ? '고정 전략 OOS' : '선택 전략 OOS'}</TableCell>
            <TableCell>{parameterText(trial, experiment.config, specs)}</TableCell>
            <TableCell><TrialLink trial={trial}>{STATUS_LABELS[trial.status] ?? trial.status}{trial.progress !== null && trial.status === 'RUNNING' ? ` ${Math.floor(trial.progress)}%` : ''}</TrialLink>{trial.error ? <p className="text-destructive">{trial.error}</p> : null}</TableCell>
            <TableCell>{formatSignedPct(trial.metrics?.totalReturnPct ?? null)}</TableCell><TableCell>{formatSignedPct(trial.metrics?.cagrPct ?? null)}</TableCell>
            <TableCell>{formatSignedPct(trial.metrics?.maxDrawdownPct ?? null)}</TableCell><TableCell>{formatNumber(trial.metrics?.sharpe ?? null)}</TableCell><TableCell>{trial.metrics?.tradeCount ?? '-'}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </details>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>검증 실험 삭제</DialogTitle><DialogDescription>이 실험의 설정과 모든 하위 백테스트 결과를 삭제합니다.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>닫기</Button><Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate('delete')}>삭제</Button></DialogFooter></DialogContent></Dialog>
    </CardContent>
  </Card>;
}

export function PeriodValidationSection({ jobId, request }: { jobId: string; request: BacktestRequestBody }) {
  const queryClient = useQueryClient();
  const queryKey = ['period-validations', jobId];
  const experiments = useQuery({
    queryKey, queryFn: () => api<{ experiments: PeriodValidationDto[] }>(`/backtests/${jobId}/validations`),
    refetchInterval: (query) => query.state.data?.experiments.some(active) ? 2_000 : false,
  });
  const schema = useQuery({ queryKey: ['strategy-schema', request.strategyId], queryFn: () => api<{ schema: Record<string, unknown> }>(`/strategies/${request.strategyId}/schema`), staleTime: 60_000 });
  const specs = useMemo(() => extractNumberParams(schema.data?.schema), [schema.data]);
  const [mode, setMode] = useState<PeriodValidationConfig['mode']>('HOLDOUT');
  const [splitDate, setSplitDate] = useState(() => {
    const start = Date.parse(`${request.period.from}T00:00:00Z`);
    const end = Date.parse(`${request.period.to}T00:00:00Z`);
    return new Date(start + Math.floor((end - start) / 86_400_000 * 0.7) * 86_400_000).toISOString().slice(0, 10);
  });
  const [trainMonths, setTrainMonths] = useState('36');
  const [testMonths, setTestMonths] = useState('6');
  const [axes, setAxes] = useState([{ key: '', values: '' }]);
  const [objective, setObjective] = useState('sharpe');
  const [minTrades, setMinTrades] = useState('5');
  const [maxDrawdown, setMaxDrawdown] = useState('30');
  const preview = useMemo(() => {
    try {
      const optimization = { axes: (mode === 'HOLDOUT' ? [] : axes).map((axis) => {
        const values = axis.values.split(',').map((value) => value.trim());
        if (values.some((value) => value === '')) throw new Error('후보값을 쉼표로 구분해 2개 이상 입력하세요.');
        return { key: axis.key, values: values.map(Number) };
      }), objective, minTrades: Number(minTrades), maxDrawdownPct: Number(maxDrawdown) };
      const input = mode === 'HOLDOUT' ? { mode, splitDate }
        : mode === 'OPTIMIZED_HOLDOUT' ? { mode, splitDate, optimization }
        : { mode, trainMonths: Number(trainMonths), testMonths: Number(testMonths), optimization };
      const parsed = periodValidationConfigSchema.safeParse(input);
      if (!parsed.success) throw new Error('기간과 최적화 설정을 확인하세요. 매개변수 후보는 2개 이상 필요합니다.');
      return { config: parsed.data, plan: buildPeriodValidationPlan(backtestRequestSchema.parse(request), parsed.data), error: null };
    } catch (error) {
      return { config: null, plan: null, error: error instanceof Error ? error.message : '설정을 확인하세요.' };
    }
  }, [request, mode, splitDate, trainMonths, testMonths, axes, objective, minTrades, maxDrawdown]);
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey: ['backtests'] });
  };
  const create = useMutation({
    mutationFn: (config: PeriodValidationConfig) => api(`/backtests/${jobId}/validations`, { method: 'POST', body: JSON.stringify(config) }),
    onSuccess: refresh,
  });
  return <section id="period-validation" className="space-y-4 min-w-0" aria-label="기간 검증">
    <Card><CardHeader><CardTitle>기간 검증</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">각 IS/OOS를 초기자금 {formatKrw(request.capital.initialCash)}과 무포지션 상태에서 다시 실행합니다. 지표 준비에는 시작일 이전 데이터를 사용하며, 구간 말 미청산 보유분은 평가금액으로 반영합니다. 구간 수익률을 연속 운용 수익률로 합산하지 않습니다.</p>
      <p className="text-sm text-muted-foreground">이미 확인한 기간을 나누는 실험입니다. OOS 결과를 보고 설정을 수정하면 미사용 데이터에 대한 검증으로 해석할 수 없습니다.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2"><Label htmlFor="validation-mode">검증 방식</Label><Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}><SelectTrigger id="validation-mode"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(MODE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
        {mode === 'WALK_FORWARD' ? <>
          <div className="space-y-2"><Label htmlFor="validation-train">학습 기간 (개월)</Label><Input id="validation-train" type="number" min={1} max={120} value={trainMonths} onChange={(event) => setTrainMonths(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="validation-test">평가·이동 기간 (개월)</Label><Input id="validation-test" type="number" min={1} max={60} value={testMonths} onChange={(event) => setTestMonths(event.target.value)} /></div>
        </> : <div className="space-y-2"><Label htmlFor="validation-split">OOS 시작일</Label><Input id="validation-split" type="date" min={request.period.from} max={request.period.to} value={splitDate} onChange={(event) => setSplitDate(event.target.value)} /></div>}
      </div>
      {mode !== 'HOLDOUT' ? <>
        {axes.map((axis, index) => <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]" key={index}>
          <div className="space-y-2"><Label htmlFor={`validation-param-${index}`}>탐색 매개변수 {index + 1}</Label><Select value={axis.key} onValueChange={(key) => setAxes((items) => items.map((item, i) => i === index ? { ...item, key } : item))}><SelectTrigger id={`validation-param-${index}`}><SelectValue placeholder="매개변수 선택" /></SelectTrigger><SelectContent>{specs.map((spec) => <SelectItem key={spec.key} value={spec.key}>{paramLabel(spec)}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor={`validation-values-${index}`}>후보값 (쉼표 구분)</Label><Input id={`validation-values-${index}`} placeholder="예: 10, 20, 40" value={axis.values} onChange={(event) => setAxes((items) => items.map((item, i) => i === index ? { ...item, values: event.target.value } : item))} /></div>
          {index > 0 ? <Button className="self-end" variant="outline" onClick={() => setAxes((items) => items.filter((_, i) => i !== index))}>제거</Button> : null}
        </div>)}
        {axes.length < 2 ? <Button variant="outline" size="sm" onClick={() => setAxes((items) => [...items, { key: '', values: '' }])}>매개변수 추가</Button> : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2"><Label htmlFor="validation-objective">IS 선택 기준</Label><Select value={objective} onValueChange={setObjective}><SelectTrigger id="validation-objective"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sharpe">Sharpe 최대</SelectItem><SelectItem value="cagrPct">CAGR 최대</SelectItem></SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="validation-trades">최소 매도 체결 수 (부분청산 포함)</Label><Input id="validation-trades" type="number" min={1} value={minTrades} onChange={(event) => setMinTrades(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="validation-drawdown">허용 MDD 크기 (%)</Label><Input id="validation-drawdown" type="number" min={0.01} max={100} value={maxDrawdown} onChange={(event) => setMaxDrawdown(event.target.value)} /></div>
        </div>
        <p className="text-sm text-muted-foreground">후보 선택은 IS 성과만 사용합니다. 같은 회차의 후보는 동일 난수 시드로 비교하며, 조건을 만족하는 후보가 없으면 실험을 중단합니다.</p>
      </> : null}
      {preview.plan ? <>
        <p className="font-medium">{preview.plan.folds.length}개 구간 · 후보 {preview.plan.candidates.length}개 · 백테스트 총 {preview.plan.totalRuns}회{mode === 'HOLDOUT' ? '' : ' (고정 전략 OOS 비교 포함)'}</p>
        <Table><TableHeader><TableRow><TableHead>회차</TableHead><TableHead>IS</TableHead><TableHead>OOS</TableHead></TableRow></TableHeader><TableBody>{preview.plan.folds.map((fold) => <TableRow key={fold.ordinal}><TableCell>{fold.ordinal + 1}</TableCell><TableCell>{fold.train.from} ~ {fold.train.to}</TableCell><TableCell>{fold.test.from} ~ {fold.test.to}</TableCell></TableRow>)}</TableBody></Table>
        {preview.plan.unusedPeriod ? <p className="text-sm text-muted-foreground">평가 기간보다 짧아 제외한 마지막 구간: {preview.plan.unusedPeriod.from} ~ {preview.plan.unusedPeriod.to}</p> : null}
      </> : <p className="text-sm text-muted-foreground">{preview.error}</p>}
      {create.error || experiments.error || schema.error ? <Alert variant="destructive"><AlertDescription>{create.error?.message ?? experiments.error?.message ?? schema.error?.message}</AlertDescription></Alert> : null}
      <Button disabled={!preview.config || create.isPending || (experiments.data?.experiments.filter(active).length ?? 0) >= 5} onClick={() => { if (preview.config) create.mutate(preview.config); }}>{create.isPending ? '실험 생성 중…' : '검증 실험 실행'}</Button>
    </CardContent></Card>
    {experiments.data?.experiments.slice().reverse().map((experiment) => <ValidationResult key={experiment.id} experiment={experiment} specs={specs} refresh={refresh} />)}
  </section>;
}
