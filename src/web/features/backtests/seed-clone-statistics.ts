import type { SeedCloneBatchItem } from './types';

export interface MetricDistributionSummary {
  readonly count: number;
  readonly mean: number;
  /** 서로 다른 seed를 모집단에서 추출한 표본으로 보고 n-1로 계산한다. */
  readonly sampleStdDev: number | null;
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export interface SeedCloneMetricSummary {
  readonly totalReturn: MetricDistributionSummary;
  readonly sharpe: MetricDistributionSummary | null;
  readonly maxDrawdown: MetricDistributionSummary;
  readonly bestSeed: number;
  readonly worstSeed: number;
}

function summarizeDistribution(values: readonly number[]): MetricDistributionSummary | null {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return null;

  const count = finiteValues.length;
  const mean = finiteValues.reduce((sum, value) => sum + value, 0) / count;
  const middle = Math.floor(count / 2);
  const median = count % 2 === 0
    ? (finiteValues[middle - 1]! + finiteValues[middle]!) / 2
    : finiteValues[middle]!;
  const sampleStdDev = count < 2
    ? null
    : Math.sqrt(
      finiteValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1),
    );

  return {
    count,
    mean,
    sampleStdDev,
    median,
    min: finiteValues[0]!,
    max: finiteValues.at(-1)!,
  };
}

/** 완료되어 지표가 저장된 실행만 집계한다. 미완료 실행의 빈 지표를 0으로 세지 않는다. */
export function summarizeSeedCloneMetrics(
  items: readonly SeedCloneBatchItem[],
): SeedCloneMetricSummary | null {
  const completed = items.filter(
    (item) => item.status === 'COMPLETED' && item.metrics !== null,
  );
  if (completed.length === 0) return null;

  const byReturn = completed
    .map((item) => ({ seed: item.randomSeed, value: item.metrics!.totalReturnPct }))
    .filter(({ value }) => Number.isFinite(value))
    .sort((left, right) => left.value - right.value);
  const totalReturn = summarizeDistribution(byReturn.map(({ value }) => value));
  const maxDrawdown = summarizeDistribution(
    completed.map((item) => item.metrics!.maxDrawdownPct),
  );
  if (!totalReturn || !maxDrawdown || byReturn.length === 0) return null;

  const sharpe = summarizeDistribution(
    completed.flatMap((item) => item.metrics!.sharpe === null ? [] : [item.metrics!.sharpe]),
  );

  return {
    totalReturn,
    sharpe,
    maxDrawdown,
    worstSeed: byReturn[0]!.seed,
    bestSeed: byReturn.at(-1)!.seed,
  };
}
