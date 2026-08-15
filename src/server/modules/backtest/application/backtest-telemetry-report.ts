import {
  backtestExecutionTelemetrySchema,
  type BacktestExecutionStage,
  type BacktestExecutionTelemetry,
} from './backtest-execution-telemetry.js';

const MIN_COMPLETED_SAMPLES = 10;
const MIN_DISTINCT_INPUT_SHAPES = 3;
const MIN_INPUT_SCALE_RATIO = 4;
const WORKER_HEADROOM_RATIO = 1.25;
const SEED_SHARD_RUNTIME_TARGET_MS = 15 * 60_000;
const MAX_SEEDS_PER_SHARD = 25;

export interface BacktestFinishedAuditRow {
  readonly createdAtMs: number;
  readonly detailJson: string | null;
}

export interface NumericDistribution {
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface BacktestTelemetryReport {
  readonly schemaVersion: 1;
  readonly window: {
    readonly sinceMs: number;
    readonly untilMs: number;
  };
  readonly events: {
    readonly available: number;
    readonly scanned: number;
    readonly truncated: boolean;
    readonly withoutTelemetry: number;
    readonly invalidTelemetry: number;
  };
  readonly samples: {
    readonly valid: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly failedStages: Record<BacktestExecutionStage, number>;
    readonly distinctInputShapes: number;
    readonly inputScaleRatio: number | null;
  };
  readonly readiness: {
    readonly readyForSizing: boolean;
    readonly minimumCompletedSamples: number;
    readonly minimumDistinctInputShapes: number;
    readonly minimumInputScaleRatio: number;
    readonly reasons: readonly string[];
  };
  readonly distributions: {
    readonly peakRssBytes: NumericDistribution | null;
    readonly durationsMs: {
      readonly load: NumericDistribution | null;
      readonly run: NumericDistribution | null;
      readonly persist: NumericDistribution | null;
      readonly total: NumericDistribution | null;
    };
    readonly input: {
      readonly candles: NumericDistribution | null;
      readonly facts: NumericDistribution | null;
      readonly symbols: NumericDistribution | null;
    };
    readonly output: {
      readonly rows: NumericDistribution | null;
      readonly estimatedPayloadBytes: NumericDistribution | null;
    };
  };
  readonly sizing: {
    /** 웹과 child가 같은 cgroup인 현 Lightsail에서는 표본과 무관하게 1을 유지한다. */
    readonly localLightsailConcurrency: 1;
    readonly workerBudgetBytes: number | null;
    readonly plannedBytesPerWorker: number | null;
    /** 메모리만 본 상한. 실제 전용 worker 병렬도는 CPU 슬롯과 이 값 중 작은 쪽이다. */
    readonly memoryConcurrencyCap: number | null;
    /** 한 worker가 seed를 순차 실행할 때 15분 이내가 되도록 잡은 계획 후보. */
    readonly sequentialSeedsPerShardCandidate: number | null;
  };
}

interface ParsedTelemetry {
  readonly telemetry: BacktestExecutionTelemetry;
}

function distribution(values: readonly number[]): NumericDistribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number): number => {
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index]!;
  };
  return {
    min: sorted[0]!,
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function parseTelemetry(detailJson: string | null): ParsedTelemetry | 'MISSING' | 'INVALID' {
  if (detailJson === null) return 'MISSING';
  let detail: unknown;
  try {
    detail = JSON.parse(detailJson);
  } catch {
    return 'INVALID';
  }
  if (typeof detail !== 'object' || detail === null || !('executionTelemetry' in detail)) {
    return 'MISSING';
  }
  const parsed = backtestExecutionTelemetrySchema.safeParse(detail.executionTelemetry);
  return parsed.success ? { telemetry: parsed.data } : 'INVALID';
}

function inputShape(telemetry: BacktestExecutionTelemetry): string | null {
  if (telemetry.input === null) return null;
  return [
    telemetry.input.candleCount,
    telemetry.input.factCount,
    telemetry.input.symbolCount,
  ].join(':');
}

export function buildBacktestTelemetryReport(options: {
  readonly rows: readonly BacktestFinishedAuditRow[];
  readonly availableEventCount: number;
  readonly sinceMs: number;
  readonly untilMs: number;
  /** OS·controller 메모리를 제외하고 전용 worker 프로세스들에 배정할 수 있는 예산. */
  readonly workerBudgetBytes?: number;
}): BacktestTelemetryReport {
  const telemetry: BacktestExecutionTelemetry[] = [];
  let withoutTelemetry = 0;
  let invalidTelemetry = 0;
  for (const row of options.rows) {
    const parsed = parseTelemetry(row.detailJson);
    if (parsed === 'MISSING') withoutTelemetry += 1;
    else if (parsed === 'INVALID') invalidTelemetry += 1;
    else telemetry.push(parsed.telemetry);
  }

  const completed = telemetry.filter((sample) => sample.outcome === 'COMPLETED');
  const completedWithInput = completed.filter(
    (sample): sample is BacktestExecutionTelemetry & { input: NonNullable<BacktestExecutionTelemetry['input']> } =>
      sample.input !== null,
  );
  const completedWithOutput = completed.filter(
    (sample): sample is BacktestExecutionTelemetry & { output: NonNullable<BacktestExecutionTelemetry['output']> } =>
      sample.output !== null,
  );
  const distinctInputShapes = new Set(completed.map(inputShape).filter((shape) => shape !== null)).size;
  const inputLoads = completedWithInput.map((sample) => sample.input.candleCount + sample.input.factCount);
  const inputLoadRange = distribution(inputLoads);
  const inputScaleRatio = inputLoadRange === null
    ? null
    : inputLoadRange.max / Math.max(1, inputLoadRange.min);
  const reasons: string[] = [];
  if (completed.length < MIN_COMPLETED_SAMPLES) {
    reasons.push(`완료 표본이 ${MIN_COMPLETED_SAMPLES}개보다 적습니다 (${completed.length}개).`);
  }
  if (distinctInputShapes < MIN_DISTINCT_INPUT_SHAPES) {
    reasons.push(
      `서로 다른 입력 규모가 ${MIN_DISTINCT_INPUT_SHAPES}종보다 적습니다 (${distinctInputShapes}종).`,
    );
  }
  if (inputScaleRatio === null || inputScaleRatio < MIN_INPUT_SCALE_RATIO) {
    reasons.push(
      `최소·최대 입력 규모 차이가 ${MIN_INPUT_SCALE_RATIO}배보다 작습니다 (${inputScaleRatio?.toFixed(1) ?? '없음'}배).`,
    );
  }
  const readyForSizing = reasons.length === 0;

  const peakRssBytes = distribution(completed.map((sample) => sample.peakRssBytes));
  const totalDurationMs = distribution(completed.map((sample) => sample.durationsMs.total));
  const workerBudgetBytes = options.workerBudgetBytes ?? null;
  const plannedBytesPerWorker = readyForSizing && peakRssBytes !== null
    ? Math.ceil(peakRssBytes.p95 * WORKER_HEADROOM_RATIO)
    : null;
  const memoryConcurrencyCap = plannedBytesPerWorker !== null && workerBudgetBytes !== null
    ? Math.max(0, Math.floor(workerBudgetBytes / plannedBytesPerWorker))
    : null;
  const sequentialSeedsPerShardCandidate = readyForSizing && totalDurationMs !== null
    ? Math.max(
        1,
        Math.min(MAX_SEEDS_PER_SHARD, Math.floor(SEED_SHARD_RUNTIME_TARGET_MS / totalDurationMs.p95)),
      )
    : null;

  const failedStages: Record<BacktestExecutionStage, number> = { LOAD: 0, RUN: 0, PERSIST: 0 };
  for (const sample of telemetry) {
    if (sample.failedStage !== null) failedStages[sample.failedStage] += 1;
  }

  return {
    schemaVersion: 1,
    window: { sinceMs: options.sinceMs, untilMs: options.untilMs },
    events: {
      available: options.availableEventCount,
      scanned: options.rows.length,
      truncated: options.availableEventCount > options.rows.length,
      withoutTelemetry,
      invalidTelemetry,
    },
    samples: {
      valid: telemetry.length,
      completed: completed.length,
      failed: telemetry.filter((sample) => sample.outcome === 'FAILED').length,
      cancelled: telemetry.filter((sample) => sample.outcome === 'CANCELLED').length,
      failedStages,
      distinctInputShapes,
      inputScaleRatio,
    },
    readiness: {
      readyForSizing,
      minimumCompletedSamples: MIN_COMPLETED_SAMPLES,
      minimumDistinctInputShapes: MIN_DISTINCT_INPUT_SHAPES,
      minimumInputScaleRatio: MIN_INPUT_SCALE_RATIO,
      reasons,
    },
    distributions: {
      peakRssBytes,
      durationsMs: {
        load: distribution(completed.map((sample) => sample.durationsMs.load)),
        run: distribution(completed.map((sample) => sample.durationsMs.run)),
        persist: distribution(completed.map((sample) => sample.durationsMs.persist)),
        total: totalDurationMs,
      },
      input: {
        candles: distribution(completedWithInput.map((sample) => sample.input.candleCount)),
        facts: distribution(completedWithInput.map((sample) => sample.input.factCount)),
        symbols: distribution(completedWithInput.map((sample) => sample.input.symbolCount)),
      },
      output: {
        rows: distribution(completedWithOutput.map((sample) => sample.output.rowCount)),
        estimatedPayloadBytes: distribution(
          completedWithOutput.map((sample) => sample.output.estimatedPayloadBytes),
        ),
      },
    },
    sizing: {
      localLightsailConcurrency: 1,
      workerBudgetBytes,
      plannedBytesPerWorker,
      memoryConcurrencyCap,
      sequentialSeedsPerShardCandidate,
    },
  };
}
