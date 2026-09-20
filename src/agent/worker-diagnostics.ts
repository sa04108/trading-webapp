import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  DIAGNOSTIC_OUTPUT_BYTES, diagnosticError, parseDiagnosticError,
  type ArtifactObservation,
  type JobDatabaseObservation,
  type OutputTail,
  type WorkerDiagnosticCode,
  type WorkerDiagnostics,
} from "../shared/agent-diagnostics.js";

export { diagnosticError } from "../shared/agent-diagnostics.js";

/** 큰 단일 청크의 원본 버퍼까지 붙잡지 않고 마지막 바이트만 복사한다. */
export class BoundedOutput {
  private buffer: Buffer = Buffer.alloc(0);
  private total = 0;
  constructor(private readonly limit = DIAGNOSTIC_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("출력 한도가 잘못되었습니다");
  }
  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + bytes.length);
    this.buffer = Buffer.from(Buffer.concat([
      this.buffer, bytes.subarray(Math.max(0, bytes.length - this.limit)),
    ]).subarray(-this.limit));
  }
  snapshot(): OutputTail {
    return { text: this.buffer.toString("utf8"), totalBytes: this.total,
      truncated: this.total > this.limit };
  }
}

export function emptyDiagnostics(now = Date.now()): WorkerDiagnostics {
  const output = (): OutputTail => ({ text: "", totalBytes: 0, truncated: false });
  return {
    schemaVersion: 1, code: "WORKER_EXIT_WITHOUT_TERMINAL_STATE",
    startedAtMs: now, finishedAtMs: now, pid: null, spawned: false,
    exitCode: null, signal: null, lastPhase: "SETUP", lastMessageAtMs: null,
    stderr: output(), stdout: output(), processErrors: [], workerError: null, deliveryError: null,
    jobDb: { state: "NOT_CHECKED", status: null, error: null, inspectionErrors: [] },
    artifact: { state: "NOT_CHECKED", bytes: null, error: null },
    cancellationReason: null, cancelPath: null, peakRssBytes: 0, memoryBudgetBytes: 0,
  };
}

/** exit는 타이머 정리용, close는 출력 수집과 종료 보고의 완료 경계다. */
export function observeWorker(child: ChildProcess, onExit: () => void) {
  const data = emptyDiagnostics();
  data.lastPhase = "SPAWNING";
  data.pid = child.pid ?? null;
  const stderr = new BoundedOutput(), stdout = new BoundedOutput();
  let exited = false;
  const recordError = (error: unknown): void => {
    if (data.processErrors.length < 4) data.processErrors.push(diagnosticError(error));
  };
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
  child.stdout?.on("error", recordError);
  child.stderr?.on("error", recordError);
  child.once("spawn", () => {
    data.spawned = true;
    data.lastPhase = "WAITING_FOR_WORKER";
  });
  child.on("error", recordError);
  child.on("message", () => { data.lastMessageAtMs = Date.now(); });
  child.once("exit", (code, signal) => {
    exited = true;
    data.exitCode = code;
    data.signal = signal;
    onExit();
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      data.exitCode = code;
      data.signal = signal;
      data.finishedAtMs = Date.now();
      onExit();
      resolve();
    });
  });
  return {
    closed, recordError,
    workerError(value: unknown) {
      const error = parseDiagnosticError(value);
      if (error && data.workerError === null) data.workerError = error;
    },
    get exited() { return exited; },
    phase(value: string) { data.lastPhase = value.slice(0, 100); },
    snapshot(): WorkerDiagnostics {
      return { ...data, processErrors: [...data.processErrors],
        stderr: stderr.snapshot(), stdout: stdout.snapshot() };
    },
  };
}
export type WorkerObservation = ReturnType<typeof observeWorker>;

interface ReadonlyDatabase {
  prepare(sql: string): { get(id: string): unknown };
  close(): void;
}

/** 진단을 위한 파일·DB 오류를 원래 작업 오류와 분리하여 반환한다. */
export function inspectJobDatabase(
  file: string,
  kind: "BACKTEST" | "PREPARATION",
  jobId: string,
  open: (file: string) => ReadonlyDatabase,
): JobDatabaseObservation {
  const result: JobDatabaseObservation = {
    state: "NOT_CHECKED", status: null, error: null, inspectionErrors: [],
  };
  try {
    if (!fs.statSync(file).isFile()) throw new Error("작업 DB 경로가 파일이 아닙니다");
  } catch (error) {
    result.state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "FILE_ACCESS_FAILED";
    if (result.state !== "MISSING") result.inspectionErrors.push(diagnosticError(error));
    return result;
  }
  let database: ReadonlyDatabase;
  try { database = open(file); }
  catch (error) {
    result.state = "OPEN_FAILED";
    result.inspectionErrors.push(diagnosticError(error));
    return result;
  }
  try {
    const table = kind === "BACKTEST" ? "backtest_jobs" : "backtest_preparation_jobs";
    const row = database.prepare(`SELECT status, error FROM ${table} WHERE id = ?`).get(jobId) as
      { status: string; error: string | null } | undefined;
    result.state = row ? "READABLE" : "ROW_MISSING";
    if (row) {
      if (typeof row.status !== "string") throw new Error("작업 상태가 문자열이 아닙니다");
      result.status = row.status.slice(0, 100);
      result.error = typeof row.error === "string" ? row.error.slice(0, 2000) : null;
    }
  } catch (error) {
    result.state = "QUERY_FAILED";
    result.inspectionErrors.push(diagnosticError(error));
  } finally {
    try { database.close(); }
    catch (error) { result.inspectionErrors.push(diagnosticError(error)); }
  }
  return result;
}

export function inspectArtifact(file: string): ArtifactObservation {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("결과 경로가 파일이 아닙니다");
    return { state: "PRESENT", bytes: stat.size, error: null };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "READ_FAILED",
      bytes: null, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : diagnosticError(error) };
  }
}

export interface WorkerDecisionInput {
  kind: "BACKTEST" | "PREPARATION";
  diagnostics: WorkerDiagnostics;
  pendingType?: "FINISH" | "NEEDS_DATA";
  pendingOutcome?: string;
  resourceError?: string;
  cancellation: boolean;
}
export function classifyWorker(input: WorkerDecisionInput): WorkerDiagnosticCode {
  const { diagnostics: d, pendingOutcome: outcome, pendingType: type } = input;
  if (input.resourceError) return "RESOURCE_BUDGET_EXCEEDED";
  // 제어 오류로 보낸 중단 요청에 워커가 취소로 응답해도 최초 실패 원인을 유지한다.
  if (d.cancellationReason !== "PROCESS_CONTROL_ERROR" &&
      (input.cancellation || outcome === "CANCELLED" || d.jobDb.status === "CANCELLED"))
    return "CANCELLED";
  if (!d.spawned && d.processErrors.length) return "WORKER_SPAWN_FAILED";
  const abnormal = d.signal !== null || d.exitCode !== 0 || d.processErrors.length > 0 || d.workerError !== null;
  if (abnormal && (outcome === "COMPLETED" || d.jobDb.status === "COMPLETED"))
    return "TERMINAL_STATE_CONFLICT";
  if (d.signal) return "WORKER_SIGNAL_EXIT";
  if (d.processErrors.length) return "WORKER_PROCESS_ERROR";
  if (outcome === "FAILED" || d.jobDb.status === "FAILED" || d.workerError) return "WORKER_REPORTED_FAILED";
  if (d.exitCode !== null && d.exitCode !== 0) return "WORKER_NONZERO_EXIT";
  if (d.exitCode === null) return "WORKER_EXIT_WITHOUT_TERMINAL_STATE";
  if (type === "NEEDS_DATA") return input.kind === "PREPARATION" ? "NEEDS_DATA" : "TERMINAL_STATE_CONFLICT";
  if (input.kind === "PREPARATION" && outcome === "COMPLETED") return "COMPLETED";
  if (d.jobDb.state === "MISSING") return "JOB_DB_MISSING";
  if (d.jobDb.state === "ROW_MISSING") return "JOB_ROW_MISSING";
  if (d.jobDb.state !== "READABLE") return "JOB_DB_READ_FAILED";
  if (d.jobDb.status === "COMPLETED" && input.kind === "BACKTEST") {
    if (d.artifact.state === "READ_FAILED") return "RESULT_ARTIFACT_READ_FAILED";
    if (d.artifact.state !== "PRESENT" || !d.artifact.bytes) return "RESULT_ARTIFACT_MISSING";
    return "COMPLETED";
  }
  return "WORKER_EXIT_WITHOUT_TERMINAL_STATE";
}

export function diagnosticSummary(d: WorkerDiagnostics, reported?: string): string {
  const reason = reported?.trim() || d.jobDb.error?.trim() || d.workerError?.message || d.deliveryError?.message ||
    d.processErrors[0]?.message || d.stderr.text.trim() || d.jobDb.inspectionErrors[0]?.message || d.artifact.error?.message || "계산 프로세스의 종료 계약을 확인할 수 없습니다";
  const context = `[${d.code}] exit=${d.exitCode ?? "null"} signal=${d.signal ?? "none"} ` +
    `phase=${d.lastPhase} db=${d.jobDb.state}/${d.jobDb.status ?? "none"} ` +
    `result=${d.artifact.state} stderr=${d.stderr.totalBytes} bytes`;
  return `${context}\n${reason.slice(-Math.max(0, 1999 - context.length))}`.slice(0, 2000);
}

/** 문자열의 비밀값을 로그·outbox에 들어가기 전에 지운다. 식별 정보는 별도로 허용한다. */
export function redactDiagnostics(d: WorkerDiagnostics, secrets: readonly string[]): WorkerDiagnostics {
  return JSON.parse(JSON.stringify(d, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  })) as WorkerDiagnostics;
}

export const DIAGNOSTIC_RETENTION = { maxFiles: 100, maxBytes: 16 * 1024 * 1024, maxAgeMs: 7 * 86_400_000 };

/** ACK 대상 작업 폴더와 분리한다. 저장 실패는 FINISH 전달을 막지 않는다. */
export function retainDiagnostic(
  root: string, key: string, value: unknown,
  write: (file: string, value: unknown) => void,
  log: (message: string) => void,
  now = Date.now(),
): void {
  try {
    if (!/^[a-zA-Z0-9_-]+-\d+$/.test(key)) throw new Error("잘못된 진단 식별자");
    const directory = path.join(root, "diagnostics");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Error("진단 기록 크기 초과");
    write(path.join(directory, `${key}.json`), value);
  } catch (error) {
    log(JSON.stringify({ event: "agent.diagnostics-storage-failed", key, error: diagnosticError(error) }));
  } finally {
    pruneDiagnostics(root, log, now);
  }
}

/** 유휴 에이전트도 만료 기록과 실패한 원자 쓰기의 임시 파일을 정리한다. */
export function pruneDiagnostics(root: string, log: (message: string) => void, now = Date.now()): void {
  const directory = path.join(root, "diagnostics");
  try {
    for (const name of fs.readdirSync(directory)) {
      if (/^[a-zA-Z0-9_-]+-\d+\.json\.tmp$/.test(name))
        fs.rmSync(path.join(directory, name), { force: true });
    }
    const files = fs.readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+-\d+\.json$/.test(name))
      .map((name) => ({ file: path.join(directory, name), stat: fs.lstatSync(path.join(directory, name)) }))
      .filter(({ stat }) => stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
    let bytes = 0, kept = 0;
    for (const { file, stat } of files) {
      if (now - stat.mtimeMs > DIAGNOSTIC_RETENTION.maxAgeMs || kept >= DIAGNOSTIC_RETENTION.maxFiles ||
          bytes + stat.size > DIAGNOSTIC_RETENTION.maxBytes) fs.rmSync(file, { force: true });
      else { bytes += stat.size; kept += 1; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log(JSON.stringify({ event: "agent.diagnostics-prune-failed", error: diagnosticError(error) }));
  }
}
