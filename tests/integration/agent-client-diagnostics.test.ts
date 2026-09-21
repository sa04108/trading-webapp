import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import Database from "better-sqlite3";
import { AgentClient, type AgentRuntimeAdapter, type AgentResultUpload } from "../../src/agent/client.js";
import { diagnosticError, emptyDiagnostics, type WorkerObservation } from "../../src/agent/worker-diagnostics.js";
import type { WorkerDiagnostics } from "../../src/shared/agent-diagnostics.js";
import type { AgentLease, AgentMessage, ServerAgentMessage } from "../../src/shared/agent-protocol.js";

// 종료 이벤트 순서는 별도 실제 프로세스 테스트에서 검증한다. 여기서는 종료 이후의
// 파일 조사·outbox·결과 업로드 경계만 호출하여 계산 엔진이나 외부 서버에 의존하지 않는다.
interface FinalizingJob {
  lease: AgentLease;
  directory: string;
  jobPath: string;
  peakRss: number;
  budgetBytes: number;
  cancellation: boolean;
  cancellationReason?: string;
  timers: NodeJS.Timeout[];
  observation: Pick<WorkerObservation, "snapshot">;
}
interface Finalizer {
  finished(job: FinalizingJob, pending: undefined): Promise<void>;
  heartbeat(): void;
}

async function scenario(run: (h: {
  directory: string;
  jobDirectory: string;
  lease: AgentLease;
  sent: AgentMessage[];
  uploads: AgentResultUpload[];
  receive(message: ServerAgentMessage): void;
  finish(diagnostics?: WorkerDiagnostics, cancellationReason?: string): Promise<void>;
  retry(): void;
}) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-client-diagnostics-"));
  const lease: AgentLease = {
    kind: "BACKTEST", jobId: "diagnostic-job", attempt: 1,
    leaseToken: "l".repeat(48), leaseExpiresAtMs: Date.now() + 90_000,
    dataset: { version: 1, datasetId: "fe0da193-553e-4155-bcc8-470d15a8fd4a", sourceRevision: 1,
      collectionVersion: "c".repeat(64), schemaVersion: 1, sha256: "d".repeat(64), bytes: 1 },
    payload: {},
  };
  const sent: AgentMessage[] = [], uploads: AgentResultUpload[] = [];
  let receive: (message: ServerAgentMessage) => void = () => {};
  const runtime: AgentRuntimeAdapter = {
    runnerVersion: "a".repeat(64),
    cache: { current: lease.dataset, syncing: false, synchronize: async () => {},
      file: () => path.join(directory, "missing-snapshot.sqlite"), prune: () => {}, stop: async () => {} },
    connect: (listener) => { receive = listener; },
    send: (message) => { sent.push(message); }, close: () => {},
    upload: async (input) => { uploads.push(input); return 200; },
    resources: () => ({ cpus: 1, availableBytes: 128 * 1024 ** 2, reserveBytes: 0, slots: 1, heapMb: 64, maxBars: 1, budgetBytes: 128 * 1024 ** 2 }),
  };
  const client = new AgentClient({ serverUrl: "http://localhost", token: "agent-secret" }, directory, undefined, () => {}, runtime);
  const finalizer = client as unknown as Finalizer;
  const jobDirectory = path.join(directory, "jobs", `${lease.jobId}-${lease.attempt}`);
  try {
    client.start();
    receive({ type: "WELCOME", runnerVersion: runtime.runnerVersion });
    fs.mkdirSync(jobDirectory, { recursive: true });
    await run({ directory, jobDirectory, lease, sent, uploads,
      receive: (message) => receive(message), retry: () => finalizer.heartbeat(),
      finish: async (diagnostics, cancellationReason) => {
        const observed = diagnostics ?? { ...emptyDiagnostics(), spawned: true, exitCode: 0 };
        await finalizer.finished({ lease, directory: jobDirectory,
          jobPath: path.join(jobDirectory, "job.sqlite"), peakRss: 1024,
          budgetBytes: 1024 * 1024, cancellation: cancellationReason !== undefined,
          cancellationReason, timers: [],
          observation: { snapshot: () => observed } }, undefined);
        // 업로드 ACK의 microtask까지 정리한 뒤 결과를 관측한다.
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
  } finally {
    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function seedJob(directory: string, status: string, error: string | null = null): void {
  const database = new Database(path.join(directory, "job.sqlite"));
  try {
    database.exec("CREATE TABLE backtest_jobs (id TEXT PRIMARY KEY, status TEXT, error TEXT)");
    database.prepare("INSERT INTO backtest_jobs VALUES (?, ?, ?)").run("diagnostic-job", status, error);
  } finally { database.close(); }
}
function finishMessage(sent: AgentMessage[]) {
  const message = sent.find((value) => value.type === "FINISH");
  assert.ok(message && message.type === "FINISH");
  return message;
}

describe("AgentClient 종료 결과 전달", () => {
  it("DB와 stderr가 없어도 분류된 FINISH를 보내고 ACK 뒤 진단을 보존", async () => scenario(async (h) => {
    await h.finish();
    const message = finishMessage(h.sent);
    assert.equal(message.outcome, "FAILED");
    const diagnostics = message.result?.diagnostics as WorkerDiagnostics;
    assert.equal(diagnostics.code, "JOB_DB_MISSING");
    assert.equal(diagnostics.jobDb.state, "MISSING");
    assert.equal(diagnostics.stderr.totalBytes, 0);
    h.receive({ type: "ACK", kind: "BACKTEST", jobId: h.lease.jobId, attempt: 1, accepted: true });
    assert.equal(fs.existsSync(h.jobDirectory), false);
    assert.ok(fs.existsSync(path.join(h.directory, "diagnostics", "diagnostic-job-1.json")));
  }));

  it("DB의 빈 오류가 수집한 stderr를 덮어쓰지 않음", async () => scenario(async (h) => {
    seedJob(h.jobDirectory, "RUNNING", "");
    const diagnostics = { ...emptyDiagnostics(), spawned: true, exitCode: 1 };
    diagnostics.stderr = { text: "native failure", totalBytes: 14, truncated: false };
    await h.finish(diagnostics);
    assert.match(finishMessage(h.sent).error ?? "", /native failure/);
  }));

  it.each([
    ["PROCESS_CONTROL_ERROR", "FAILED", "WORKER_PROCESS_ERROR"],
    ["SERVER_CANCEL_REQUEST", "CANCELLED", "CANCELLED"],
  ] as const)("취소된 워커 DB와 제어 오류가 함께 있어도 중단 원인 %s에 맞게 %s를 전송", async (reason, outcome, code) => scenario(async (h) => {
    seedJob(h.jobDirectory, "CANCELLED");
    const diagnostics = { ...emptyDiagnostics(), spawned: true, exitCode: 0 };
    diagnostics.processErrors = [diagnosticError(new Error("IPC operation failed"))];
    await h.finish(diagnostics, reason);
    const message = finishMessage(h.sent);
    assert.equal(message.outcome, outcome);
    const reported = message.result?.diagnostics as WorkerDiagnostics;
    assert.equal(reported.code, code);
    assert.equal(reported.cancellationReason, reason);
    assert.equal(reported.jobDb.status, "CANCELLED");
    assert.equal(reported.processErrors[0]?.message, "IPC operation failed");
    const persisted = JSON.parse(fs.readFileSync(path.join(h.jobDirectory, "outbox.json"), "utf8"));
    assert.equal(persisted.message.outcome, outcome);
  }));

  it("깨진 SQLite도 종료 보고를 중단시키지 않음", async () => scenario(async (h) => {
    fs.writeFileSync(path.join(h.jobDirectory, "job.sqlite"), "not a database");
    await h.finish();
    const diagnostics = finishMessage(h.sent).result?.diagnostics as WorkerDiagnostics;
    assert.equal(diagnostics.code, "JOB_DB_READ_FAILED");
    assert.ok(diagnostics.jobDb.inspectionErrors.length > 0);
  }));

  it("정상 결과는 FINISH COMPLETED가 아니라 기존 파일 업로드로 전달", async () => scenario(async (h) => {
    seedJob(h.jobDirectory, "COMPLETED");
    const bytes = Buffer.from("artifact transport fixture");
    fs.writeFileSync(path.join(h.jobDirectory, "result.sqlite"), bytes);
    await h.finish();
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0]?.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(h.sent.some((message) => message.type === "FINISH"), false);
    assert.equal(fs.existsSync(h.jobDirectory), false);
  }));

  it("완료 상태의 결과 파일이 없으면 업로드 대신 명시적 실패", async () => scenario(async (h) => {
    seedJob(h.jobDirectory, "COMPLETED");
    await h.finish();
    assert.equal(h.uploads.length, 0);
    assert.match(finishMessage(h.sent).error ?? "", /RESULT_ARTIFACT_MISSING/);
  }));

  it("outbox 디스크 쓰기 실패 중에도 보고하고 다음 heartbeat에서 영속화 재시도", async () => scenario(async (h) => {
    const blocked = path.join(h.jobDirectory, "outbox.json.tmp");
    fs.mkdirSync(blocked);
    await h.finish();
    assert.equal(finishMessage(h.sent).outcome, "FAILED");
    assert.equal(fs.existsSync(path.join(h.jobDirectory, "outbox.json")), false);
    fs.rmSync(blocked, { recursive: true });
    h.retry();
    const persisted = JSON.parse(fs.readFileSync(path.join(h.jobDirectory, "outbox.json"), "utf8"));
    assert.equal(persisted.message.result.diagnostics.code, "JOB_DB_MISSING");
  }));

  it("프로세스 시작 전 DB 준비 실패도 JOB 처리에서 FINISH로 전달", async () => scenario(async (h) => {
    h.receive({ type: "JOB", lease: h.lease });
    const message = finishMessage(h.sent);
    assert.equal(message.outcome, "FAILED");
    assert.match(message.error ?? "", /JOB_SETUP_FAILED/);
  }));
});
