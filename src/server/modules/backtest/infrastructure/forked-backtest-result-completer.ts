import { fork } from "node:child_process";
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
  | { readonly type: "result-persistence-unavailable"; readonly error: string }
  | { readonly type: "invalid-result-artifact"; readonly error: string }
  | { readonly type: "result-import-internal-error"; readonly error: string };

/** 결과 검증·수백만 행 import를 한 번에 하나씩 별도 child에서 수행한다. */
export class ForkedBacktestResultCompleter implements BacktestResultCompleter {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly databasePath: string) {}

  complete(
    input: BacktestResultCompletionInput,
  ): Promise<BacktestResultCompletionOutput> {
    const completion = this.tail.then(() => this.completeOnce(input));
    this.tail = completion.then(
      () => undefined,
      () => undefined,
    );
    return completion;
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
      const child = fork(fileURLToPath(childUrl), [], {
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
      let stderr = "";
      let output: BacktestResultCompletionOutput | null = null;
      let persistenceError: string | null = null;
      let artifactError: string | null = null;
      let internalError: string | null = null;
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 8_000) stderr += chunk.toString();
      });
      child.on("message", (message: ChildMessage) => {
        if (message.type === "completed") output = message.output;
        else if (message.type === "result-persistence-unavailable") {
          persistenceError = message.error;
        } else if (message.type === "invalid-result-artifact") {
          artifactError = message.error;
        } else if (message.type === "result-import-internal-error") {
          internalError = message.error;
        }
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && output !== null) resolve(output);
        else if (persistenceError !== null) {
          reject(
            new BacktestResultPersistenceUnavailableError(persistenceError),
          );
        } else if (artifactError !== null) {
          reject(new BacktestResultArtifactRejectedError(artifactError));
        } else if (internalError !== null) {
          reject(new BacktestResultImportInternalError(internalError));
        } else
          reject(
            new Error(
              `결과 import child 실패 (code=${code}, signal=${signal ?? "none"}): ${stderr.trim()}`,
            ),
          );
      });
    });
  }
}
