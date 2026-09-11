import { z } from 'zod';
import { backtestRequestSchema, isoDateSchema, type BacktestPeriod, type BacktestRequest } from './backtest-request.js';

export const MAX_VALIDATION_RUNS = 300;
export const MAX_VALIDATION_CANDIDATES = 50;

const optimizationSchema = z.object({
  axes: z.array(z.object({
    key: z.string().min(1).max(100),
    values: z.array(z.number().finite()).min(2).max(25),
  })).min(1).max(2),
  objective: z.enum(['sharpe', 'cagrPct']).default('sharpe'),
  minTrades: z.number().int().min(1).max(100_000).default(5),
  maxDrawdownPct: z.number().positive().max(100).default(30),
});

export const periodValidationConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('HOLDOUT'), splitDate: isoDateSchema }),
  z.object({ mode: z.literal('OPTIMIZED_HOLDOUT'), splitDate: isoDateSchema, optimization: optimizationSchema }),
  z.object({
    mode: z.literal('WALK_FORWARD'),
    trainMonths: z.number().int().min(1).max(120),
    testMonths: z.number().int().min(1).max(60),
    optimization: optimizationSchema,
  }),
]);

export type PeriodValidationConfig = z.infer<typeof periodValidationConfigSchema>;
export interface ValidationFold {
  ordinal: number;
  train: BacktestPeriod;
  test: BacktestPeriod;
}
export interface PeriodValidationPlan {
  folds: ValidationFold[];
  candidates: Record<string, unknown>[];
  totalRuns: number;
  unusedPeriod: BacktestPeriod | null;
}

function dayOffset(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 매번 원래 날짜에서 이동해 월말 절삭이 다음 구간의 날짜까지 밀지 않게 한다. */
export function validationMonthOffset(date: string, months: number): string {
  const original = new Date(`${date}T00:00:00Z`);
  const result = new Date(original);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(original.getUTCDate(), last));
  return result.toISOString().slice(0, 10);
}

/** 화면 미리보기와 서버 실행이 같은 비중복 기간·후보 조합을 사용한다. */
export function buildPeriodValidationPlan(source: BacktestRequest, config: PeriodValidationConfig): PeriodValidationPlan {
  const { from, to } = source.period;
  if (from >= to) throw new Error('검증 기간은 시작일보다 종료일이 뒤여야 합니다.');
  let candidates = [{ ...source.parameters }];
  if (config.mode !== 'HOLDOUT') {
    const keys = new Set<string>();
    for (const axis of config.optimization.axes) {
      if (keys.has(axis.key)) throw new Error('탐색 매개변수가 중복됐습니다.');
      keys.add(axis.key);
      if (new Set(axis.values).size !== axis.values.length) throw new Error('후보값이 중복됐습니다.');
      candidates = candidates.flatMap((params) => axis.values.map((value) => ({ ...params, [axis.key]: value })));
      if (candidates.length > MAX_VALIDATION_CANDIDATES) {
        throw new Error(`매개변수 조합은 최대 ${MAX_VALIDATION_CANDIDATES}개입니다.`);
      }
    }
  }
  const folds: ValidationFold[] = [];
  let unusedPeriod: BacktestPeriod | null = null;
  if (config.mode === 'WALK_FORWARD') {
    for (let ordinal = 0; ordinal <= MAX_VALIDATION_RUNS; ordinal += 1) {
      const startMonth = ordinal * config.testMonths;
      const testFrom = validationMonthOffset(from, startMonth + config.trainMonths);
      const testTo = dayOffset(validationMonthOffset(from, startMonth + config.trainMonths + config.testMonths), -1);
      if (testTo > to) {
        if (testFrom <= to) unusedPeriod = { from: testFrom, to };
        break;
      }
      folds.push({ ordinal, train: { from: validationMonthOffset(from, startMonth), to: dayOffset(testFrom, -1) }, test: { from: testFrom, to: testTo } });
    }
    if (folds.length < 2) throw new Error('워크포워드에는 완전한 OOS 구간이 2개 이상 필요합니다. 학습·평가 기간을 줄이세요.');
  } else {
    if (config.splitDate <= from || config.splitDate > to) throw new Error('OOS 시작일은 전체 기간 안에 있어야 합니다.');
    folds.push({ ordinal: 0, train: { from, to: dayOffset(config.splitDate, -1) }, test: { from: config.splitDate, to } });
  }
  const totalRuns = folds.length * (candidates.length + (config.mode === 'HOLDOUT' ? 1 : 2));
  if (totalRuns > MAX_VALIDATION_RUNS) throw new Error(`예상 실행 ${totalRuns}회가 상한 ${MAX_VALIDATION_RUNS}회를 초과합니다.`);
  for (const fold of folds) {
    for (const period of [fold.train, fold.test]) {
      if (period.from >= period.to) throw new Error('각 IS/OOS 구간에는 최소 2일이 필요합니다.');
      for (const parameters of [...candidates, source.parameters]) {
        const parsed = backtestRequestSchema.safeParse({ ...source, period, parameters });
        if (!parsed.success) throw new Error(`${fold.ordinal + 1}회차: ${parsed.error.issues[0]!.message}`);
      }
    }
  }
  return { folds, candidates, totalRuns, unusedPeriod };
}

export type ValidationStatus = 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLING' | 'CANCELLED';
export type ValidationRole = 'TRAIN' | 'OOS' | 'BASELINE';
export interface ValidationMetrics {
  totalReturnPct: number;
  cagrPct: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  tradeCount: number;
}
export interface ValidationTrialDto {
  id: string;
  fold: number;
  role: ValidationRole;
  candidate: number | null;
  period: BacktestPeriod;
  parameters: Record<string, unknown> | null;
  jobId: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  metrics: ValidationMetrics | null;
  benchmarkReturnPct: number | null;
}
export interface PeriodValidationDto {
  id: string;
  sourceJobId: string;
  status: ValidationStatus;
  config: PeriodValidationConfig;
  plan: PeriodValidationPlan;
  initialCash: number;
  createdAtMs: number;
  error: string | null;
  trials: ValidationTrialDto[];
}

/** OOS와 고정 전략 성과는 선택 함수에 전달하지 않는다. 동률이면 후보 입력 순서를 유지한다. */
export function selectValidationCandidate(
  candidates: readonly { candidate: number; metrics: ValidationMetrics }[],
  optimization: z.infer<typeof optimizationSchema>,
): number | null {
  const eligible = candidates.filter(({ metrics }) => {
    const score = metrics[optimization.objective];
    return score !== null && Number.isFinite(score)
      && Number.isFinite(metrics.maxDrawdownPct) && Number.isFinite(metrics.tradeCount)
      && metrics.tradeCount >= optimization.minTrades
      && Math.abs(metrics.maxDrawdownPct) <= optimization.maxDrawdownPct;
  });
  eligible.sort((a, b) => b.metrics[optimization.objective]! - a.metrics[optimization.objective]! || a.candidate - b.candidate);
  return eligible[0]?.candidate ?? null;
}
