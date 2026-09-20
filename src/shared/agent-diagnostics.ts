/** 작업 상태와 별개인 진단 계약. 토큰·전체 payload·환경변수는 포함하지 않는다. */
export const WORKER_DIAGNOSTIC_CODES = [
  "COMPLETED", "NEEDS_DATA", "CANCELLED", "RESOURCE_BUDGET_EXCEEDED",
  "JOB_SETUP_FAILED", "WORKER_SPAWN_FAILED", "WORKER_PROCESS_ERROR",
  "WORKER_SIGNAL_EXIT", "WORKER_NONZERO_EXIT", "WORKER_REPORTED_FAILED",
  "JOB_DB_MISSING", "JOB_DB_READ_FAILED", "JOB_ROW_MISSING",
  "RESULT_ARTIFACT_MISSING", "RESULT_ARTIFACT_READ_FAILED",
  "WORKER_EXIT_WITHOUT_TERMINAL_STATE", "TERMINAL_STATE_CONFLICT",
  "AGENT_INTERRUPTED", "FINALIZATION_FAILED", "RESULT_UPLOAD_REJECTED",
] as const;
export type WorkerDiagnosticCode = typeof WORKER_DIAGNOSTIC_CODES[number];
export const DIAGNOSTIC_OUTPUT_BYTES = 32 * 1024;
export interface DiagnosticError {
  name: string;
  message: string;
  code: string | null;
  stack: string | null;
}
export interface OutputTail {
  text: string;
  totalBytes: number;
  truncated: boolean;
}
export interface JobDatabaseObservation {
  state: "NOT_CHECKED" | "MISSING" | "FILE_ACCESS_FAILED" | "OPEN_FAILED" |
    "QUERY_FAILED" | "ROW_MISSING" | "READABLE";
  status: string | null;
  error: string | null;
  inspectionErrors: DiagnosticError[];
}
export interface ArtifactObservation {
  state: "NOT_CHECKED" | "MISSING" | "PRESENT" | "READ_FAILED";
  bytes: number | null;
  error: DiagnosticError | null;
}
export interface WorkerDiagnostics {
  schemaVersion: 1;
  code: WorkerDiagnosticCode;
  startedAtMs: number;
  finishedAtMs: number;
  pid: number | null;
  spawned: boolean;
  exitCode: number | null;
  signal: string | null;
  lastPhase: string;
  lastMessageAtMs: number | null;
  stderr: OutputTail;
  stdout: OutputTail;
  processErrors: DiagnosticError[];
  workerError: DiagnosticError | null;
  deliveryError: DiagnosticError | null;
  jobDb: JobDatabaseObservation;
  artifact: ArtifactObservation;
  cancellationReason: string | null;
  cancelPath: "IPC" | "SIGTERM" | "SIGKILL" | null;
  peakRssBytes: number;
  memoryBudgetBytes: number;
}

/** 오류 객체의 열거 가능 속성 전체를 복사하지 않는다. */
export function diagnosticError(error: unknown): DiagnosticError {
  const e = error instanceof Error ? error : new Error(String(error));
  const code: unknown = "code" in e ? e.code : undefined;
  return { name: e.name.slice(0, 100), message: e.message.slice(0, 2000),
    code: typeof code === "string" ? code.slice(0, 100) : null,
    stack: e.stack?.slice(0, 8000) ?? null };
}

export function parseDiagnosticError(value: unknown): DiagnosticError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const e = value as Record<string, unknown>;
  if (typeof e.name !== "string" || e.name.length > 100 ||
      typeof e.message !== "string" || e.message.length > 2000 ||
      !(e.code === null || typeof e.code === "string" && e.code.length <= 100) ||
      !(e.stack === null || typeof e.stack === "string" && e.stack.length <= 8000)) return undefined;
  return { name: e.name, message: e.message, code: e.code as string | null, stack: e.stack as string | null };
}

/** 원격 진단은 허용 필드만 재구성한다. 부가 진단 불량으로 FINISH 자체를 거부하지 않는다. */
export function parseWorkerDiagnostics(value: unknown): WorkerDiagnostics | undefined {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("object");
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max: number): string => {
    if (typeof v !== "string" || v.length > max) throw new Error("text");
    return v;
  };
  const number = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new Error("number");
    return v;
  };
  const bool = (v: unknown): boolean => {
    if (typeof v !== "boolean") throw new Error("boolean");
    return v;
  };
  const nullable = <T>(v: unknown, parse: (v: unknown) => T): T | null =>
    v === null ? null : parse(v);
  const choice = <T extends string>(v: unknown, values: readonly T[]): T => {
    if (typeof v !== "string" || !values.includes(v as T)) throw new Error("enum");
    return v as T;
  };
  const error = (v: unknown): DiagnosticError => {
    const e = object(v);
    return { name: text(e.name, 100), message: text(e.message, 2000),
      code: nullable(e.code, (s) => text(s, 100)),
      stack: nullable(e.stack, (s) => text(s, 8000)) };
  };
  const errors = (v: unknown): DiagnosticError[] => {
    if (!Array.isArray(v) || v.length > 4) throw new Error("errors");
    return v.map(error);
  };
  const output = (v: unknown): OutputTail => {
    const o = object(v);
    return { text: text(o.text, DIAGNOSTIC_OUTPUT_BYTES),
      totalBytes: number(o.totalBytes), truncated: bool(o.truncated) };
  };
  try {
    const d = object(value), db = object(d.jobDb), artifact = object(d.artifact);
    if (d.schemaVersion !== 1) return undefined;
    const exitCode = nullable(d.exitCode, (v) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error("exit");
      return v;
    });
    return {
      schemaVersion: 1, code: choice(d.code, WORKER_DIAGNOSTIC_CODES),
      startedAtMs: number(d.startedAtMs), finishedAtMs: number(d.finishedAtMs),
      pid: nullable(d.pid, number), spawned: bool(d.spawned), exitCode,
      signal: nullable(d.signal, (v) => text(v, 100)),
      lastPhase: text(d.lastPhase, 100), lastMessageAtMs: nullable(d.lastMessageAtMs, number),
      stderr: output(d.stderr), stdout: output(d.stdout),
      processErrors: errors(d.processErrors), workerError: nullable(d.workerError, error),
      deliveryError: nullable(d.deliveryError, error),
      jobDb: {
        state: choice(db.state, ["NOT_CHECKED", "MISSING", "FILE_ACCESS_FAILED", "OPEN_FAILED", "QUERY_FAILED", "ROW_MISSING", "READABLE"]),
        status: nullable(db.status, (v) => text(v, 100)),
        error: nullable(db.error, (v) => text(v, 2000)),
        inspectionErrors: errors(db.inspectionErrors),
      },
      artifact: {
        state: choice(artifact.state, ["NOT_CHECKED", "MISSING", "PRESENT", "READ_FAILED"]),
        bytes: nullable(artifact.bytes, number), error: nullable(artifact.error, error),
      },
      cancellationReason: nullable(d.cancellationReason, (v) => text(v, 100)),
      cancelPath: nullable(d.cancelPath, (v) => choice(v, ["IPC", "SIGTERM", "SIGKILL"])),
      peakRssBytes: number(d.peakRssBytes), memoryBudgetBytes: number(d.memoryBudgetBytes),
    };
  } catch {
    return undefined;
  }
}
