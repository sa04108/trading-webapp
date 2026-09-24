import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableServerResources, processRss } from "../../../../agent/resources.js";
import type { SubmissionValidationInput, SubmissionValidationResult, SubmissionValidator } from "../application/submission-validation.js";
import { PreparationReferenceError } from "../application/preparation-reference-service.js";
import { recordDiagnostic, type StageDiagnostic } from "../../../../runtime/shared/diagnostics.js";

export class SubmissionValidationUnavailableError extends Error {
  constructor(message: string, readonly statusCode: number = 503) { super(message); }
}

interface Options {
  readonly forkProcess?: typeof fork;
  readonly timeoutMs?: number;
  readonly maxPending?: number;
  readonly memoryBudget?: () => number;
}

/** 동기 SQLite 검증은 하나씩 실행하고, 접속 종료·시간 초과 시 자식을 회수한다. */
export class ForkedSubmissionValidator implements SubmissionValidator {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly shutdown = new AbortController();

  constructor(private readonly databasePath: string, private readonly dataPath: string, private readonly options: Options = {}) {}

  validate(input: SubmissionValidationInput, signal?: AbortSignal): Promise<SubmissionValidationResult> {
    if (this.shutdown.signal.aborted) return Promise.reject(new SubmissionValidationUnavailableError("서버가 종료 중입니다."));
    if (this.pending >= (this.options.maxPending ?? 4)) return Promise.reject(new SubmissionValidationUnavailableError("제출 검증이 진행 중입니다. 잠시 뒤 다시 시도하세요.", 429));
    const combined = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    this.pending += 1;
    const operation = this.tail.then(() => {
      if (combined.aborted) throw new SubmissionValidationUnavailableError("제출 검증이 취소되었습니다.");
      return this.run(input, combined);
    });
    this.tail = operation.then(() => undefined, () => undefined).finally(() => { this.pending -= 1; });
    // 대기 중 연결 종료도 즉시 반환한다. 직렬 체인에는 빈 슬롯만 남기고 프로세스는 만들지 않는다.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new SubmissionValidationUnavailableError("제출 검증이 취소되었습니다."));
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      operation.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
    });
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.tail;
  }

  private run(input: SubmissionValidationInput, signal: AbortSignal): Promise<SubmissionValidationResult> {
    const resources = this.options.memoryBudget ? undefined : availableServerResources(0);
    if (resources?.memoryPressure) throw new SubmissionValidationUnavailableError("운영 서버의 메모리 여유가 부족합니다.", 507);
    if (resources && resources.slots < 1) throw new SubmissionValidationUnavailableError("운영 서버가 사용 중입니다. 잠시 뒤 다시 시도하세요.");
    const budget = Math.min(192 * 1024 * 1024, this.options.memoryBudget?.() ?? resources!.budgetBytes);
    if (budget < 128 * 1024 * 1024) throw new SubmissionValidationUnavailableError("제출 검증을 위한 메모리 여유가 부족합니다. 실행 중 작업이 끝난 뒤 다시 시도하세요.", 507);
    const isTs = import.meta.url.endsWith(".ts");
    const started = performance.now();
    recordDiagnostic({ event: "diagnostic.stage.started", stage: "submission.worker" });
    return new Promise((resolve, reject) => {
      const child: ChildProcess = (this.options.forkProcess ?? fork)(fileURLToPath(new URL(`../../../../workers/submission-validation-child.${isTs ? "ts" : "js"}`, import.meta.url)), [], {
        env: { NODE_ENV: process.env.NODE_ENV ?? "production", DATABASE_PATH: this.databasePath, DATA_DATABASE_PATH: this.dataPath,
          ...(isTs && process.env.QUANT_SOURCE_RUNTIME_VERSIONS ? { QUANT_SOURCE_RUNTIME_VERSIONS: process.env.QUANT_SOURCE_RUNTIME_VERSIONS } : {}) },
        // 작은 cgroup에서는 V8의 기본 young generation 확장도 전체 RSS 예산을 소진한다.
        execArgv: ["--max-semi-space-size=4", `--max-old-space-size=${Math.max(64, Math.floor(budget / 1024 / 1024 * 0.6))}`, ...(isTs ? ["--import", "tsx"] : [])],
        serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let output: SubmissionValidationResult | undefined;
      let error: Error | undefined;
      let lastPhase = "BOOTSTRAP";
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (reason: Error) => {
        if (killTimer) return;
        error ??= reason;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
      };
      const abort = () => terminate(new SubmissionValidationUnavailableError("제출 검증이 취소되었습니다."));
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => terminate(new SubmissionValidationUnavailableError("제출 검증 시간이 초과되었습니다. 잠시 뒤 다시 시도하세요.")), this.options.timeoutMs ?? 120_000);
      const memory = setInterval(() => {
        if ((child.pid && processRss(child.pid) > budget) || (!this.options.memoryBudget && availableServerResources(0).memoryPressure))
          terminate(new SubmissionValidationUnavailableError("제출 검증의 메모리 상한을 넘었습니다.", 507));
      }, 500);
      memory.unref();
      child.on("message", (message: { type: string; output?: SubmissionValidationResult; error?: string; diagnostic?: StageDiagnostic }) => {
        if (message.type === "completed") output = message.output;
        else if (message.type === "diagnostic" && message.diagnostic) {
          lastPhase = message.diagnostic.stage;
          recordDiagnostic(message.diagnostic);
        }
        else if (message.type === "stale") error = new PreparationReferenceError();
        else if (message.type === "failed") error = new Error(message.error ?? "제출 검증 실패");
      });
      child.on("error", (cause) => { terminate(cause); });
      child.once("close", (code) => {
        clearTimeout(timeout); clearTimeout(killTimer); clearInterval(memory);
        signal.removeEventListener("abort", abort);
        recordDiagnostic({ event: "diagnostic.stage.finished", stage: "submission.worker", lastPhase,
          elapsedMs: performance.now() - started, outcome: !error && code === 0 && output ? "COMPLETED" : "FAILED" });
        if (error) reject(error);
        else if (code === 0 && output) resolve(output);
        else reject(new SubmissionValidationUnavailableError("제출 검증 프로세스가 종료되었습니다."));
      });
      if (signal.aborted) abort();
      else child.send(input, (cause) => { if (cause) terminate(cause); });
    });
  }
}
