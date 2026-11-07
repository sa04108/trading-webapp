import { openDatabase } from "../shared/db/database.js";
import { backtestPreparationJobs } from "../shared/db/schema.js";
import {
  AgentDataRequired,
  agentLeaseSchema,
  type AgentLease,
} from "../../shared/agent-protocol.js";
import { createPreparationWorkerRuntime } from "./preparation-runtime.js";
import { disconnectWorker, reportWorkerError, reportWorkerPhase, sendWorkerMessage } from "./worker-reporting.js";
import { randomUUID } from "node:crypto";
import { UniverseExecutor } from "./universe-executor.js";
import { createUniverseRuntime } from "./universe-runtime.js";
import { assertSafeIdentitySelections } from "../modules/backtest/application/backtest-symbol-identity.js";
import { UNIVERSE_COMPUTE_TIMEOUT_MS, universeComputeReplySchema,
  type UniverseComputeInput, type UniverseComputeReply } from "../../shared/universe-compute.js";

reportWorkerPhase("BOOTSTRAP_READY");

process.once(
  "message",
  (input: { lease: AgentLease; jobPath: string; dataPath: string }) => {
    void run(input).catch((error: unknown) => {
      reportWorkerError(error);
      sendWorkerMessage({ type: "FINISH", outcome: "FAILED",
        error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }).finally(() => disconnectWorker());
  },
);

async function run(input: {
  lease: AgentLease;
  jobPath: string;
  dataPath: string;
}): Promise<void> {
  reportWorkerPhase("JOB_RECEIVED");
  const lease = agentLeaseSchema.parse(input.lease);
  reportWorkerPhase("JOB_DB_OPENING");
  const database = openDatabase(input.jobPath, {
    dataPath: input.dataPath,
    dataReadonly: true,
  });
  reportWorkerPhase("JOB_DB_OPENED");
  let orchestrator:
    ReturnType<typeof createPreparationWorkerRuntime> | undefined;
  let stop: (() => void) | undefined;
  let onMessage: ((message: { type: string; requestId?: string; reply?: unknown }) => void) | undefined;
  const pending = new Map<string, { finish: (reply: UniverseComputeReply) => void; timer: NodeJS.Timeout }>();
  const remote = (task: UniverseComputeInput): Promise<UniverseComputeReply> => new Promise((resolve) => {
    const requestId = randomUUID();
    const finish = (reply: UniverseComputeReply) => {
      const entry = pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(requestId);
      resolve(reply);
    };
    pending.set(requestId, { finish,
      timer: setTimeout(() => finish({ status: "UNAVAILABLE" }), UNIVERSE_COMPUTE_TIMEOUT_MS + 5000) });
    if (!process.connected) finish({ status: "UNAVAILABLE" });
    else process.send!({ type: "UNIVERSE_REQUEST", requestId, input: task }, (error) => {
      if (error) finish({ status: "UNAVAILABLE" });
    });
  });
  const universe = createUniverseRuntime(database, lease.dataset.collectionVersion);
  const executor = new UniverseExecutor(universe.resolver, {
    dataPath: input.dataPath, collectionVersion: lease.dataset.collectionVersion,
    budgetBytes: Number(process.env.WORKER_BUDGET_BYTES ?? 0),
    cpuBudget: Number(process.env.WORKER_CPU_BUDGET ?? 1), remote,
    verifyRemote: (task, result) => {
      if (result.kind !== "READY") return;
      for (const date of result.schedule) {
        if (!task.rebalanceDates.includes(date.rebalanceDate) ||
            !universe.symbolMaster.isCovered(date.rebalanceDate) ||
            universe.symbolMaster.effectiveTradingDateWithinCoverage(date.rebalanceDate) !== date.effectiveDate)
          throw new Error("보조 계산 결과의 실제 거래일이 스냅샷과 다릅니다");
      }
      assertSafeIdentitySelections(universe.symbolMaster, result.schedule.flatMap((date) =>
        date.members.map((member) => ({ shortCode: member.symbol,
          standardCode: member.standardCode, effectiveDate: date.effectiveDate }))));
    },
  });
  try {
    database.db
      .insert(backtestPreparationJobs)
      .values({
        id: input.lease.jobId,
        requestHash: String(input.lease.payload.requestHash),
        requestJson: String(input.lease.payload.requestJson),
        status: "RUNNING",
        phase: "MARKET_DATA",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      })
      .onConflictDoUpdate({
        target: backtestPreparationJobs.id,
        set: { status: "RUNNING", cancelRequested: false },
      })
      .run();
    orchestrator = createPreparationWorkerRuntime(database, {
      collectionVersion: lease.dataset.collectionVersion,
      resolveUniverse: executor.resolve,
      onJobUpdated: () => {
        const progress = orchestrator?.get(input.lease.jobId);
        if (progress) {
          reportWorkerPhase(progress.phase);
          sendWorkerMessage({ type: "PROGRESS", progress });
        }
      },
    });
    stop = () => {
      orchestrator?.cancel(input.lease.jobId);
      for (const entry of pending.values()) entry.finish({ status: "UNAVAILABLE" });
      void executor.close();
    };
    onMessage = (message) => {
      if (message.type === "cancel") stop?.();
      else if (message.type === "UNIVERSE_REPLY" && message.requestId) {
        const parsed = universeComputeReplySchema.safeParse(message.reply);
        pending.get(message.requestId)?.finish(parsed.success ? parsed.data
          : { status: "FAILED", error: "잘못된 선정 계산 응답입니다" });
      }
    };
    process.on("SIGTERM", stop);
    process.on("disconnect", stop);
    process.on("message", onMessage);
    await orchestrator.runClaimedJob(input.lease.jobId);
    const job = orchestrator.get(input.lease.jobId);
    const row = database.sqlite
      .prepare(
        "SELECT preview_json AS preview, data_revision AS dataRevision, fundamental_symbols_json AS fundamentalSymbols FROM backtest_preparation_jobs LEFT JOIN preparation_preview_cache ON job_id = id WHERE id = ?",
      )
      .get(input.lease.jobId) as {
      preview: string | null;
      dataRevision: number | null;
      fundamentalSymbols: string | null;
    };
    sendWorkerMessage({
      type: "FINISH",
      outcome: job?.status,
      error: job?.error,
      result: row.preview
        ? {
            preview: JSON.parse(row.preview),
            dataRevision: row.dataRevision,
            fundamentalSymbols: JSON.parse(row.fundamentalSymbols ?? "[]"),
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof AgentDataRequired)
      sendWorkerMessage({ type: "NEEDS_DATA", request: error.request });
    else {
      reportWorkerError(error);
      sendWorkerMessage({
        type: "FINISH",
        outcome: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    }
  } finally {
    // 자체 IPC 종료가 취소 처리로 되돌아가 닫힌 작업 DB를 읽지 않도록 먼저 해제한다.
    if (stop) {
      process.off("SIGTERM", stop);
      process.off("disconnect", stop);
    }
    if (onMessage) process.off("message", onMessage);
    for (const entry of pending.values()) entry.finish({ status: "UNAVAILABLE" });
    await executor.close();
    try { await orchestrator?.stop(); }
    finally { database.close(); }
  }
}
