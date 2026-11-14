import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IntradayEngineInput } from "../../../../runtime/modules/intraday/domain/engine.js";
import type { IntradayResult } from "../../../../shared/schemas/intraday.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";

/** 계산 프로세스에는 고정된 입력만 전달하고 공급자 자격 증명은 넘기지 않는다. */
export function executeIntraday(
  input: IntradayEngineInput,
  signal: AbortSignal,
): Promise<IntradayResult> {
  signal.throwIfAborted();
  const executionVersion = readRuntimeVersions().executionVersion;
  const source = import.meta.url.endsWith(".ts");
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(
        new URL(
          `../../../../workers/intraday-backtest-child.${source ? "ts" : "js"}`,
          import.meta.url,
        ),
      ),
      [],
      {
        env: { NODE_ENV: process.env.NODE_ENV ?? "production" },
        execArgv: [
          ...(source ? ["--import", "tsx"] : []),
          "--max-old-space-size=384",
        ],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let result: IntradayResult | undefined,
      failure: Error | undefined,
      killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const abort = () => stop(new Error("분봉 백테스트가 취소되었습니다."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(
      () => stop(new Error("분봉 계산 제한 시간(120초)을 초과했습니다.")),
      120_000,
    );
    child.on(
      "message",
      (message: { result?: IntradayResult; error?: string }) => {
        if (message.error) failure = new Error(message.error);
        else if (message.result) result = message.result;
      },
    );
    child.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0 && result) resolve({ ...result, executionVersion });
      else reject(new Error("분봉 계산 프로세스가 종료되었습니다."));
    });
    child.send(input, (error) => {
      if (error) stop(error);
    });
  });
}
