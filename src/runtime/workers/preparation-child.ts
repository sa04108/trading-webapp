import { openDatabase } from "../shared/db/database.js";
import { backtestPreparationJobs } from "../shared/db/schema.js";
import {
  AgentDataRequired,
  agentLeaseSchema,
  type AgentLease,
} from "../../shared/agent-protocol.js";
import { createPreparationWorkerRuntime } from "./preparation-runtime.js";
import { disconnectWorker, reportWorkerError, reportWorkerPhase, sendWorkerMessage } from "./worker-reporting.js";

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
  let onMessage: ((message: { type: string }) => void) | undefined;
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
    };
    onMessage = (message: { type: string }) => {
      if (message.type === "cancel") stop?.();
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
    try { await orchestrator?.stop(); }
    finally { database.close(); }
  }
}
