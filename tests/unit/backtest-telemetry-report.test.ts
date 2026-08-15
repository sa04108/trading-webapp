import { describe, expect, it } from 'vitest';
import type { BacktestExecutionTelemetry } from '../../src/server/modules/backtest/application/backtest-execution-telemetry.js';
import {
  buildBacktestTelemetryReport,
  type BacktestFinishedAuditRow,
} from '../../src/server/modules/backtest/application/backtest-telemetry-report.js';

function telemetry(overrides: {
  index?: number;
  outcome?: BacktestExecutionTelemetry['outcome'];
  failedStage?: BacktestExecutionTelemetry['failedStage'];
} = {}): BacktestExecutionTelemetry {
  const index = overrides.index ?? 1;
  const inputScale = [1, 5, 25][index % 3]!;
  return {
    schemaVersion: 1,
    outcome: overrides.outcome ?? 'COMPLETED',
    failedStage: overrides.failedStage ?? null,
    durationsMs: {
      load: index * 100,
      run: index * 1_000,
      persist: index * 10,
      total: index * 1_110,
    },
    peakRssBytes: index * 10 * 1024 ** 2,
    input: {
      candleCount: inputScale * 1_000,
      factCount: inputScale * 100,
      symbolCount: index % 3 + 1,
    },
    output: {
      rowCount: index * 100,
      estimatedPayloadBytes: index * 1_000,
      equityPointCount: index * 40,
      drawdownPointCount: index * 40,
      tradeCount: index * 10,
      monthlyReturnCount: index * 10,
      openPositionCount: 0,
    },
  };
}

function row(value: unknown): BacktestFinishedAuditRow {
  return {
    createdAtMs: 1_000,
    detailJson: JSON.stringify({ jobId: 'bt_test', executionTelemetry: value }),
  };
}

describe('backtest telemetry report', () => {
  it('uses completed representative samples for conservative worker and shard sizing', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(telemetry({ index: index + 1 })));
    rows.push(row(telemetry({ index: 20, outcome: 'FAILED', failedStage: 'RUN' })));

    const report = buildBacktestTelemetryReport({
      rows,
      availableEventCount: rows.length,
      sinceMs: 0,
      untilMs: 2_000,
      workerBudgetBytes: 400 * 1024 ** 2,
    });

    expect(report.samples).toMatchObject({
      valid: 11,
      completed: 10,
      failed: 1,
      cancelled: 0,
      failedStages: { LOAD: 0, RUN: 1, PERSIST: 0 },
      distinctInputShapes: 3,
      inputScaleRatio: 25,
    });
    expect(report.readiness).toMatchObject({ readyForSizing: true, reasons: [] });
    expect(report.distributions.peakRssBytes).toEqual({
      min: 10 * 1024 ** 2,
      p50: 50 * 1024 ** 2,
      p95: 100 * 1024 ** 2,
      max: 100 * 1024 ** 2,
    });
    expect(report.distributions.durationsMs.total?.p95).toBe(11_100);
    expect(report.sizing).toEqual({
      localLightsailConcurrency: 1,
      workerBudgetBytes: 400 * 1024 ** 2,
      plannedBytesPerWorker: 125 * 1024 ** 2,
      memoryConcurrencyCap: 3,
      sequentialSeedsPerShardCandidate: 25,
    });
  });

  it('does not manufacture a recommendation from missing, malformed, or narrow samples', () => {
    const rows: BacktestFinishedAuditRow[] = [
      { createdAtMs: 1, detailJson: null },
      { createdAtMs: 2, detailJson: '{not json' },
      { createdAtMs: 3, detailJson: JSON.stringify({ jobId: 'old' }) },
      row({ ...telemetry(), schemaVersion: 99 }),
      row(telemetry()),
    ];

    const report = buildBacktestTelemetryReport({
      rows,
      availableEventCount: 8,
      sinceMs: 0,
      untilMs: 4,
      workerBudgetBytes: 400 * 1024 ** 2,
    });

    expect(report.events).toEqual({
      available: 8,
      scanned: 5,
      truncated: true,
      withoutTelemetry: 2,
      invalidTelemetry: 2,
    });
    expect(report.samples.valid).toBe(1);
    expect(report.readiness.readyForSizing).toBe(false);
    expect(report.readiness.reasons).toEqual([
      '완료 표본이 10개보다 적습니다 (1개).',
      '서로 다른 입력 규모가 3종보다 적습니다 (1종).',
      '최소·최대 입력 규모 차이가 4배보다 작습니다 (1.0배).',
    ]);
    expect(report.sizing).toMatchObject({
      localLightsailConcurrency: 1,
      plannedBytesPerWorker: null,
      memoryConcurrencyCap: null,
      sequentialSeedsPerShardCandidate: null,
    });
  });
});
