export const jobKinds = [
  "backtest", "preparation", "clone-batch", "validation", "backtest-refresh",
  "intraday-backtest", "intraday-collection", "symbol-master", "benchmark",
] as const;

export type JobKind = (typeof jobKinds)[number];
export type JobStatus = "QUEUED" | "RUNNING" | "WAITING" | "CANCELLING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export type JobFilter = "all" | "active" | "finished";

export function isFinishedJob(status: JobStatus): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status);
}

export interface JobProgress {
  readonly current: number | null;
  readonly total: number | null;
  readonly percent: number | null;
  readonly label: string | null;
}

export interface JobItem {
  readonly id: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly status: JobStatus;
  readonly phase: string | null;
  readonly description: string | null;
  readonly progress: JobProgress | null;
  readonly error: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly cancellable: boolean;
  readonly link: string | null;
}

export interface JobsResponse {
  readonly jobs: JobItem[];
  readonly total: number;
  readonly activeCount: number;
  readonly retentionDays: number;
  readonly limit: number;
  readonly offset: number;
}

export interface JobResponse {
  readonly job: JobItem;
}
