import type { BacktestArtifactSize } from './backtest-result-artifact.js';

export type BacktestExecutionStage = 'LOAD' | 'RUN' | 'PERSIST';
export type BacktestExecutionOutcome = 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** 자식 프로세스 한 번의 자원 사용량. 작업 결과와 달리 감사 로그에 작은 JSON으로 남긴다. */
export interface BacktestExecutionTelemetry {
  readonly schemaVersion: 1;
  readonly outcome: BacktestExecutionOutcome;
  readonly failedStage: BacktestExecutionStage | null;
  readonly durationsMs: {
    readonly load: number;
    readonly run: number;
    readonly persist: number;
    readonly total: number;
  };
  /** process.resourceUsage().maxRSS는 KiB이므로 worker가 bytes로 바꿔 보낸다. */
  readonly peakRssBytes: number;
  readonly input: {
    readonly candleCount: number;
    readonly factCount: number;
    readonly symbolCount: number;
  } | null;
  readonly output: BacktestArtifactSize | null;
}
