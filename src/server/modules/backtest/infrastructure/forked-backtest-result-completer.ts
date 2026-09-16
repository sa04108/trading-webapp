import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  BacktestResultCompletionInput,
  BacktestResultCompletionOutput,
} from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";
import {
  BacktestResultArtifactRejectedError,
  BacktestResultImportInternalError,
  BacktestResultPersistenceUnavailableError,
  type BacktestResultCompleter,
} from "../../../../runtime/modules/backtest/application/backtest-result-artifact.js";

type ChildMessage =
  | {
      readonly type: "completed";
      readonly output: BacktestResultCompletionOutput;
    }
  | { readonly type: "progress"; readonly activity: "VALIDATING_RESULT" | "IMPORTING_RESULT" }
  | { readonly type: "result-persistence-unavailable"; readonly error: string }
  | { readonly type: "invalid-result-artifact"; readonly error: string }
  | { readonly type: "result-import-internal-error"; readonly error: string };

export interface ForkedBacktestResultCompleterOptions {
  readonly gracefulStopMs?: number;
  readonly termStopMs?: number;
  readonly killStopMs?: number;
  readonly forkProcess?: typeof fork;
  readonly onProgressError?: (
    error: unknown,
    input: BacktestResultCompletionInput,
    activity: "VALIDATING_RESULT" | "IMPORTING_RESULT",
  ) => void;
}

const DEFAULT_GRACEFUL_STOP_MS = 10_000;
const DEFAULT_TERM_STOP_MS = 2_000;
const DEFAULT_KILL_STOP_MS = 2_000;

function stoppedError(): BacktestResultPersistenceUnavailableError {
  return new BacktestResultPersistenceUnavailableError(
    "서버가 종료 중이어서 결과 import를 시작할 수 없습니다.",
  );
}

/** 결과 검증·수백만 행 import를 한 번에 하나씩 별도 child에서 수행한다. */
export class ForkedBacktestResultCompleter implements BacktestResultCompleter {
  private tail: Promise<void> = Promise.resolve();
  private activeChild: ChildProcess | null = null;
  private stopping = false;
  private stoppingPromise: Promise<void> | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly onProgress?: (
      input: BacktestResultCompletionInput,
      activity: "VALIDATING_RESULT" | "IMPORTING_RESULT",
    ) => void,
    private readonly options: ForkedBacktestResultCompleterOptions = {},
  ) {}

  complete(
    input: BacktestResultCompletionInput,
  ): Promise<BacktestResultCompletionOutput> {
    if (this.stopping) return Promise.reject(stoppedError());
    const completion = this.tail.then(() => {
      if (this.stopping) throw stoppedError();
      return this.completeOnce(input);
    });
    this.tail = completion.then(
      () => undefined,
      () => undefined,
    );
    return completion;
  }

  stop(): Promise<void> {
    if (this.stoppingPromise !== null) return this.stoppingPromise;
    this.stopping = true;
    this.stoppingPromise = this.stopOnce();
    return this.stoppingPromise;
  }

  private async stopOnce(): Promise<void> {
    if (await this.waitForTail(this.options.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS))
      return;
    this.activeChild?.kill("SIGTERM");
    if (await this.waitForTail(this.options.termStopMs ?? DEFAULT_TERM_STOP_MS)) return;
    this.activeChild?.kill("SIGKILL");
    if (await this.waitForTail(this.options.killStopMs ?? DEFAULT_KILL_STOP_MS)) return;
    throw new Error("결과 import child가 강제 종료 뒤에도 정리되지 않았습니다.");
  }

  private async waitForTail(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.tail.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private completeOnce(
    input: BacktestResultCompletionInput,
  ): Promise<BacktestResultCompletionOutput> {
    const isTsRuntime = import.meta.url.endsWith(".ts");
    const childUrl = new URL(
      `../../../../workers/backtest-result-import-child.${isTsRuntime ? "ts" : "js"}`,
      import.meta.url,
    );
    return new Promise((resolve, reject) => {
      const child = (this.options.forkProcess ?? fork)(fileURLToPath(childUrl), [], {
        env: {
          NODE_ENV: process.env.NODE_ENV ?? "production",
          DATABASE_PATH: this.databasePath,
          BACKTEST_RESULT_ARTIFACT_PATH: input.artifactPath,
          BACKTEST_JOB_ID: input.jobId,
          BACKTEST_ATTEMPT: String(input.attempt),
          BACKTEST_LEASE_TOKEN_HASH: input.leaseTokenHash,
          BACKTEST_RESULT_CHECKSUM: input.checksum,
          BACKTEST_EXPECTED_RUNNER_VERSION: input.expectedRunnerVersion,
        },
        execArgv: isTsRuntime ? ["--import", "tsx"] : [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      this.activeChild = child;
      let stderr = "";
      let output: BacktestResultCompletionOutput | null = null;
      let persistenceError: string | null = null;
      let artifactError: string | null = null;
      let internalError: string | null = null;
      let childError: Error | null = null;
      let settled = false;
      const onStderr = (chunk: Buffer) => {
        if (stderr.length < 8_000) stderr += chunk.toString();
      };
      const cleanup = (): void => {
        child.stderr?.off("data", onStderr);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("close", onClose);
        if (this.activeChild === child) this.activeChild = null;
      };
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onMessage = (message: ChildMessage): void => {
        if (message.type === "completed") output = message.output;
        else if (message.type === "progress" && !this.stopping) {
          try {
            this.onProgress?.(input, message.activity);
          } catch (error) {
            this.options.onProgressError?.(error, input, message.activity);
          }
        } else if (message.type === "result-persistence-unavailable") {
          persistenceError = message.error;
        } else if (message.type === "invalid-result-artifact") {
          artifactError = message.error;
        } else if (message.type === "result-import-internal-error") {
          internalError = message.error;
        }
      };
      // Node는 spawn·kill 오류 뒤에도 close를 보낸다. 실제 process/stdio 종료 경계를
      // 지키기 위해 오류만 보관하고 close에서 한 번만 완료한다.
      const onError = (error: Error): void => {
        childError = error;
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0 && output !== null) {
          const completedOutput = output;
          settle(() => resolve(completedOutput));
        } else if (childError !== null) {
          const error = childError;
          settle(() => reject(error));
        } else if (persistenceError !== null) {
          const message = persistenceError;
          settle(() =>
            reject(new BacktestResultPersistenceUnavailableError(message)),
          );
        } else if (artifactError !== null) {
          const message = artifactError;
          settle(() => reject(new BacktestResultArtifactRejectedError(message)));
        } else if (internalError !== null) {
          const message = internalError;
          settle(() => reject(new BacktestResultImportInternalError(message)));
        } else {
          settle(() =>
            reject(
              new Error(
                `결과 import child 실패 (code=${code}, signal=${signal ?? "none"}): ${stderr.trim()}`,
              ),
            ),
          );
        }
      };
      child.stderr?.on("data", onStderr);
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("close", onClose);
    });
  }
}
