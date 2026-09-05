import type {
  BacktestUniversePreview,
  PreparationInput,
} from './backtest-preparation-orchestrator.js';

export interface ReadyPreviewDetails {
  readonly preview: BacktestUniversePreview;
  readonly fundamentalSymbols: readonly string[];
}

/**
 * Expensive preparation work is intentionally narrower than the durable orchestrator.
 * Implementations may run it in-process for focused tests or in a serialized child-process
 * lane in production. SQLite job ownership, timers and SSE subscriptions stay in the parent.
 */
export interface BacktestPreparationExecutionLane {
  runClaimedJob(jobId: string): Promise<void>;
  getReadyPreview(input: PreparationInput): Promise<BacktestUniversePreview | null>;
  getReadyPreviewDetails(input: PreparationInput): Promise<ReadyPreviewDetails | null>;
  getCachedPreview(input: PreparationInput, preparationJobId?: string): Promise<BacktestUniversePreview | null>;
  needsDart(input: PreparationInput): Promise<boolean>;
  /** True when a queued/running child operation will settle only after cancellation completes. */
  cancel(jobId: string): boolean;
  onJobUpdated(listener: (jobId: string) => void): () => void;
  stop(): Promise<void>;
}

/** The bounded execution lane is full; callers should retry instead of stacking work. */
export class PreparationExecutionBusyError extends Error {
  constructor(message = '준비 작업 실행 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.') {
    super(message);
    this.name = 'PreparationExecutionBusyError';
  }
}

export type PreparationChildRequest =
  | { readonly type: 'RUN_JOB'; readonly jobId: string }
  | { readonly type: 'GET_READY_PREVIEW'; readonly input: PreparationInput }
  | { readonly type: 'GET_READY_PREVIEW_DETAILS'; readonly input: PreparationInput }
  | { readonly type: 'GET_CACHED_PREVIEW'; readonly input: PreparationInput; readonly preparationJobId?: string }
  | { readonly type: 'NEEDS_DART'; readonly input: PreparationInput };

export interface SerializedPreparationError {
  readonly name: string;
  readonly message: string;
  readonly date?: string;
  readonly stack?: string;
}

/** Module-neutral DTO for relaying a notification row already persisted by the child. */
export interface PreparationNotification {
  readonly id: string;
  readonly type: 'backtest' | 'data-sync';
  readonly severity: 'info' | 'error';
  readonly title: string;
  readonly body: string | null;
  readonly link: string | null;
  readonly read: boolean;
  readonly createdAtMs: number;
}

export type PreparationChildMessage =
  | { readonly type: 'JOB_UPDATED'; readonly jobId: string }
  | { readonly type: 'NOTIFICATION_CREATED'; readonly notification: PreparationNotification }
  | { readonly type: 'RESULT'; readonly value: unknown }
  | { readonly type: 'ERROR'; readonly error: SerializedPreparationError };
