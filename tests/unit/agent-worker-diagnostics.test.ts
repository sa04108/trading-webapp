import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "vitest";
import {
  BoundedOutput, classifyWorker, diagnosticError, diagnosticSummary,
  emptyDiagnostics, observeWorker, redactDiagnostics,
  type WorkerDecisionInput,
} from "../../src/agent/worker-diagnostics.js";
import { parseWorkerDiagnostics, type WorkerDiagnostics, type WorkerDiagnosticCode } from "../../src/shared/agent-diagnostics.js";
import { recordWorkerDiagnostics } from "../../src/server/modules/agents/application/agent-diagnostic-recorder.js";

function normal(): WorkerDiagnostics {
  const d = emptyDiagnostics(1000);
  d.spawned = true;
  d.exitCode = 0;
  d.jobDb = { state: "READABLE", status: "RUNNING", error: null, inspectionErrors: [] };
  d.artifact = { state: "MISSING", bytes: null, error: null };
  return d;
}

describe("에이전트 종료 진단 분류", () => {
  const cases: Array<[string, (d: WorkerDiagnostics) => void, Partial<WorkerDecisionInput>, WorkerDiagnosticCode]> = [
    ["출력 없는 0 종료와 RUNNING 행", () => {}, {}, "WORKER_EXIT_WITHOUT_TERMINAL_STATE"],
    ["출력 없는 비정상 종료", (d) => { d.exitCode = 23; }, {}, "WORKER_NONZERO_EXIT"],
    ["SIGKILL을 OOM으로 단정하지 않음", (d) => { d.exitCode = null; d.signal = "SIGKILL"; }, {}, "WORKER_SIGNAL_EXIT"],
    ["spawn 이전 오류", (d) => { d.spawned = false; d.processErrors = [diagnosticError(new Error("ENOENT"))]; }, {}, "WORKER_SPAWN_FAILED"],
    ["spawn 이후 제어 오류", (d) => { d.processErrors = [diagnosticError(new Error("IPC"))]; }, {}, "WORKER_PROCESS_ERROR"],
    ["존재하지 않는 작업 DB", (d) => { d.jobDb.state = "MISSING"; }, {}, "JOB_DB_MISSING"],
    ["열 수 없는 작업 DB", (d) => { d.jobDb.state = "OPEN_FAILED"; }, {}, "JOB_DB_READ_FAILED"],
    ["테이블 조회 실패", (d) => { d.jobDb.state = "QUERY_FAILED"; }, {}, "JOB_DB_READ_FAILED"],
    ["작업 행 없음", (d) => { d.jobDb.state = "ROW_MISSING"; }, {}, "JOB_ROW_MISSING"],
    ["완료 행과 누락 결과", (d) => { d.jobDb.status = "COMPLETED"; }, {}, "RESULT_ARTIFACT_MISSING"],
    ["완료 행과 빈 결과", (d) => { d.jobDb.status = "COMPLETED"; d.artifact = { state: "PRESENT", bytes: 0, error: null }; }, {}, "RESULT_ARTIFACT_MISSING"],
    ["완료 행과 결과 접근 실패", (d) => { d.jobDb.status = "COMPLETED"; d.artifact.state = "READ_FAILED"; }, {}, "RESULT_ARTIFACT_READ_FAILED"],
    ["정상 결과가 있으면 stderr 경고는 실패가 아님", (d) => {
      d.jobDb.status = "COMPLETED"; d.artifact = { state: "PRESENT", bytes: 4096, error: null };
      d.stderr = { text: "warning", totalBytes: 7, truncated: false };
    }, {}, "COMPLETED"],
    ["완료 행과 비정상 종료는 충돌", (d) => { d.jobDb.status = "COMPLETED"; d.exitCode = 1; }, {}, "TERMINAL_STATE_CONFLICT"],
    ["준비 완료 IPC와 SIGTERM 충돌", (d) => { d.signal = "SIGTERM"; d.exitCode = null; },
      { kind: "PREPARATION", pendingType: "FINISH", pendingOutcome: "COMPLETED" }, "TERMINAL_STATE_CONFLICT"],
    ["준비 결과는 기존 FINISH 계약을 유지", () => {},
      { kind: "PREPARATION", pendingType: "FINISH", pendingOutcome: "COMPLETED" }, "COMPLETED"],
    ["백테스트 FINISH 완료만으로 업로드를 생략하지 않음", () => {},
      { pendingType: "FINISH", pendingOutcome: "COMPLETED" }, "WORKER_EXIT_WITHOUT_TERMINAL_STATE"],
    ["준비 데이터 요청은 계산 실패가 아님", () => {},
      { kind: "PREPARATION", pendingType: "NEEDS_DATA" }, "NEEDS_DATA"],
    ["백테스트는 데이터 요청 메시지를 성공으로 전달하지 않음", () => {},
      { pendingType: "NEEDS_DATA" }, "TERMINAL_STATE_CONFLICT"],
    ["명시적 작업 실패", (d) => { d.jobDb.status = "FAILED"; d.exitCode = 1; }, {}, "WORKER_REPORTED_FAILED"],
    ["명시적 취소가 종료 시그널보다 우선", (d) => { d.signal = "SIGKILL"; }, { cancellation: true }, "CANCELLED"],
    ["메모리 예산 초과 중단을 사용자 취소로 오인하지 않음", () => {},
      { cancellation: true, resourceError: "memory budget" }, "RESOURCE_BUDGET_EXCEEDED"],
  ];
  for (const [name, change, overrides, expected] of cases) {
    it(name, () => {
      const diagnostics = normal();
      change(diagnostics);
      assert.equal(classifyWorker({ kind: "BACKTEST", cancellation: false, diagnostics, ...overrides }), expected);
    });
  }

  it("DB의 빈 오류 문자열이 stderr를 지우지 않고 요약은 2000자 이내", () => {
    const d = normal();
    d.jobDb.error = "  ";
    d.stderr.text = "native module failed";
    assert.match(diagnosticSummary(d), /native module failed/);
    assert.ok(diagnosticSummary(d, "한".repeat(10000)).length <= 2000);
  });

  it("출력 버퍼는 마지막 바이트와 전체 길이만 보존", () => {
    const output = new BoundedOutput(16);
    output.append(Buffer.alloc(1024 * 1024, 97));
    output.append("FINAL ERROR");
    assert.equal(output.snapshot().text.length, 16);
    assert.ok(output.snapshot().text.endsWith("FINAL ERROR"));
    assert.equal(output.snapshot().totalBytes, 1024 * 1024 + 11);
    assert.equal(output.snapshot().truncated, true);
  });

  it("여러 청크로 나뉜 UTF-8 출력이 경계 안에서는 유지", () => {
    const output = new BoundedOutput(32);
    const bytes = Buffer.from("한글 오류");
    output.append(bytes.subarray(0, 2));
    output.append(bytes.subarray(2));
    assert.equal(output.snapshot().text, "한글 오류");
    assert.equal(output.snapshot().truncated, false);
  });

  it("exit 이후 도착한 stderr까지 close에서 수집", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: 7 });
    let cleanup = 0, closed = false;
    const observation = observeWorker(child, () => { cleanup += 1; });
    void observation.closed.then(() => { closed = true; });
    child.emit("spawn");
    child.emit("exit", 1, null);
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(cleanup, 1);
    child.stderr!.emit("data", Buffer.from("late stderr"));
    child.emit("close", 1, null);
    await observation.closed;
    assert.equal(observation.snapshot().stderr.text, "late stderr");
    assert.equal(observation.snapshot().exitCode, 1);
  });

  it("추가 오류가 최초 워커 오류를 덮어쓰지 않음", async () => {
    const child = new EventEmitter() as ChildProcess;
    const observation = observeWorker(child, () => {});
    observation.workerError(diagnosticError(new Error("first failure")));
    observation.workerError(diagnosticError(new Error("DB write failure")));
    child.emit("close", 1, null);
    await observation.closed;
    assert.equal(observation.snapshot().workerError?.message, "first failure");
  });
});

describe("진단 전송 경계", () => {
  it("허용 필드만 재구성하고 크기·버전을 검증", () => {
    const d = normal();
    const parsed = parseWorkerDiagnostics({ ...d, leaseToken: "must-not-survive" });
    assert.deepEqual(parsed, d);
    assert.equal(parseWorkerDiagnostics({ ...d, schemaVersion: 2 }), undefined);
    assert.equal(parseWorkerDiagnostics({ ...d, exitCode: 0.5 }), undefined);
    assert.equal(parseWorkerDiagnostics({ ...d, stderr: { ...d.stderr, text: "x".repeat(32769) } }), undefined);
    assert.equal(parseWorkerDiagnostics({ ...d, processErrors: Array(5).fill(diagnosticError("error")) }), undefined);
    assert.equal(parseWorkerDiagnostics(null), undefined);
  });

  it("부모가 아는 토큰과 Bearer 문자열을 모든 문자열 필드에서 제거", () => {
    const d = normal();
    d.stderr.text = "secret-lease Bearer example-token";
    d.processErrors = [diagnosticError(new Error("secret-lease"))];
    const safe = redactDiagnostics(d, ["secret-lease"]);
    assert.doesNotMatch(JSON.stringify(safe), /secret-lease|example-token/);
    assert.match(JSON.stringify(safe), /redacted/);
    assert.match(d.stderr.text, /secret-lease/);
  });

  it("수락한 진단만 감사에 저장하며 감사 실패는 종료 응답을 막지 않음", () => {
    const writes: unknown[] = [], logs: unknown[] = [];
    const logger = { info: (v: unknown) => { logs.push(v); }, warn: (v: unknown) => { logs.push(v); } };
    const audit = { record: (_actor: string, event: string, detail: unknown) => { writes.push({ event, detail }); } };
    const input = { accepted: true, clientId: "authenticated-agent", kind: "BACKTEST" as const,
      jobId: "job-id", attempt: 2, outcome: "FAILED" as const, executionMode: "remote" as const,
      runnerVersion: "a".repeat(64), diagnostics: normal() };
    recordWorkerDiagnostics(input, audit, logger);
    assert.equal(writes.length, 1);
    assert.match(JSON.stringify(writes), /agent.worker.diagnostics/);
    assert.match(JSON.stringify(writes), /authenticated-agent/);
    recordWorkerDiagnostics({ ...input, accepted: false }, audit, logger);
    recordWorkerDiagnostics({ ...input, diagnostics: { schemaVersion: 99 } }, audit, logger);
    assert.equal(writes.length, 1);
    assert.doesNotThrow(() => recordWorkerDiagnostics(input, { record() { throw new Error("disk full"); } }, logger));
    assert.match(JSON.stringify(logs), /agent.diagnostics-audit-failed/);
  });
});
