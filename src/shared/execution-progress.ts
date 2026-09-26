export type ExecutionActorKind = "SERVER" | "REMOTE_AGENT" | "SERVER_AGENT";

export type ExecutionProgressUnit = "DATES" | "SYMBOLS" | "BARS" | "BYTES";

export type ExecutionActivity =
  | "LOCAL_REPLAY"
  | "SOURCE_FETCH"
  | "FILING_DISCOVERY"
  | "BLOCKED"
  | "WAITING_FOR_EXECUTOR"
  | "ESTIMATING_JOB_MEMORY"
  | "WAITING_FOR_MEMORY"
  | "WAITING_FOR_SLOT"
  | "WAITING_FOR_CAPACITY"
  | "ASSIGNING_EXECUTOR"
  | "STARTING_WORKER"
  | "CHECKING_INPUT"
  | "COLLECTING_MARKET"
  | "COLLECTING_SELECTION"
  | "REGISTERING_SYMBOLS"
  | "COLLECTING_FINANCIALS"
  | "COLLECTING_ACTIONS"
  | "WAITING_RETRY"
  | "PUBLISHING_COPY"
  | "PUBLISHING_VERIFY"
  | "PUBLISHING_HASH"
  | "PUBLISHING_COMMIT"
  | "DOWNLOADING_DATASET"
  | "VERIFYING_DATASET"
  | "RESOLVING_UNIVERSE"
  | "VALIDATING_INPUT"
  | "SAVING_PREVIEW"
  | "LOADING_BACKTEST_INPUT"
  | "CALCULATING_BACKTEST"
  | "WRITING_RESULT"
  | "UPLOADING_RESULT"
  | "VALIDATING_RESULT"
  | "IMPORTING_RESULT";

/** 화면은 분모가 확인된 처리량만 퍼센트로 바꾸고 나머지는 활동과 경과 시간을 표시한다. */
export interface ExecutionProgress {
  readonly activity: ExecutionActivity;
  readonly detail: string | null;
  readonly actorKind: ExecutionActorKind;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly unit: ExecutionProgressUnit | null;
  readonly completed: number | null;
  readonly total: number | null;
  readonly currentItem: string | null;
  readonly attempt: number | null;
  readonly retryCount: number;
  readonly startedAtMs: number;
  readonly lastProgressAtMs: number | null;
  readonly lastReceivedAtMs: number | null;
  readonly nextResumeAtMs: number | null;
}
