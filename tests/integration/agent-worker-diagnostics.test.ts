import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "vitest";
import {
  DIAGNOSTIC_RETENTION, emptyDiagnostics, inspectArtifact, inspectJobDatabase,
  observeWorker, retainDiagnostic, pruneDiagnostics,
} from "../../src/agent/worker-diagnostics.js";

function temporary<T>(run: (directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-diagnostics-"));
  try { return run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function closed(child: ChildProcess, operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("자식 종료 시간 초과")); }, 5000);
    })]);
  } finally {
    clearTimeout(timer);
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe("실제 프로세스 종료 관측", () => {
  it("stderr 없는 비정상 종료 코드와 정상 종료를 구분", async () => {
    for (const code of [0, 19]) {
      const child = spawn(process.execPath, ["-e", `process.exitCode=${code}`], { stdio: ["ignore", "pipe", "pipe"] });
      const observer = observeWorker(child, () => {});
      await closed(child, observer.closed);
      assert.equal(observer.snapshot().spawned, true);
      assert.equal(observer.snapshot().exitCode, code);
      assert.equal(observer.snapshot().stderr.totalBytes, 0);
    }
  });

  it("존재하지 않는 실행 파일의 error/close는 exit 없이도 완료", async () => {
    const child = spawn(path.join(os.tmpdir(), `missing-worker-${process.pid}-${Date.now()}`), []);
    let exited = false;
    child.on("exit", () => { exited = true; });
    const observer = observeWorker(child, () => {});
    await closed(child, observer.closed);
    assert.equal(exited, false);
    assert.equal(observer.snapshot().spawned, false);
    assert.equal(observer.snapshot().processErrors[0]?.code, "ENOENT");
  });

  it("큰 종료 직전 출력의 마지막 오류까지 수집", async () => {
    const child = spawn(process.execPath, ["-e", `process.stderr.write('x'.repeat(200000)+'FINAL_ERROR');process.exitCode=1;`], { stdio: ["ignore", "pipe", "pipe"] });
    const observer = observeWorker(child, () => {});
    await closed(child, observer.closed);
    const stderr = observer.snapshot().stderr;
    assert.equal(stderr.totalBytes, 200011);
    assert.ok(stderr.text.endsWith("FINAL_ERROR"));
    assert.equal(stderr.truncated, true);
  });

  it("워커 오류 IPC와 stack을 전송한 뒤 강제 exit 없이 출력까지 비움", async () => {
    const ts = import.meta.url.endsWith(".ts");
    const helper = new URL(`../../src/runtime/workers/worker-reporting.${ts ? "ts" : "js"}`, import.meta.url).href;
    const script = `
      import { reportWorkerPhase, reportWorkerError, disconnectWorker } from ${JSON.stringify(helper)};
      process.once('message', () => {
        reportWorkerPhase('JOB_DB_OPENING');
        reportWorkerError(new Error('FIRST_FAILURE'));
        reportWorkerError(new Error('CLEANUP_FAILURE'));
        process.stdout.write('x'.repeat(200000) + 'DRAINED');
        process.exitCode = 1;
        void disconnectWorker();
      });
    `;
    const child = spawn(process.execPath, [...(ts ? ["--import", "tsx"] : []), "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const observer = observeWorker(child, () => {});
    const messages: unknown[] = [];
    child.on("message", (value: unknown) => {
      messages.push(value);
      const message = value as { diagnosticError?: unknown };
      observer.workerError(message.diagnosticError);
    });
    child.send!({ start: true });
    await closed(child, observer.closed);
    const result = observer.snapshot();
    assert.equal(result.exitCode, 1);
    assert.equal(result.workerError?.message, "FIRST_FAILURE");
    assert.match(result.workerError?.stack ?? "", /FIRST_FAILURE/);
    assert.match(result.stderr.text, /CLEANUP_FAILURE/);
    assert.ok(result.stdout.text.endsWith("DRAINED"));
    assert.equal(result.stdout.totalBytes, 200007);
    assert.equal(messages.length, 3);
  });

  it("명시적 SIGKILL 종료를 시그널로 남김", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
    const observer = observeWorker(child, () => {});
    child.stdout!.once("data", () => child.kill("SIGKILL"));
    await closed(child, observer.closed);
    assert.equal(observer.snapshot().signal, "SIGKILL");
    assert.equal(observer.snapshot().stderr.totalBytes, 0);
  });
});

describe("작업 파일 조사와 진단 보존", () => {
  it("DB 누락·접근 실패·열기 실패를 구분하고 누락 파일을 생성하지 않음", () => temporary((dir) => {
    const file = path.join(dir, "job.sqlite");
    const noOpen = () => { throw new Error("열면 안 됨"); };
    assert.equal(inspectJobDatabase(file, "BACKTEST", "job", noOpen).state, "MISSING");
    assert.equal(fs.existsSync(file), false);
    assert.equal(inspectJobDatabase(dir, "BACKTEST", "job", noOpen).state, "FILE_ACCESS_FAILED");
    fs.writeFileSync(file, "not sqlite");
    assert.equal(inspectJobDatabase(file, "BACKTEST", "job", noOpen).state, "OPEN_FAILED");
  }));

  it("작업 종류에 맞는 테이블과 행을 조회하고 DB 닫기 실패도 보존", () => temporary((dir) => {
    const file = path.join(dir, "job.sqlite");
    fs.writeFileSync(file, "fixture");
    for (const kind of ["BACKTEST", "PREPARATION"] as const) {
      let sql = "";
      const observation = inspectJobDatabase(file, kind, "job-id", () => ({
        prepare(query) { sql = query; return { get(id) { assert.equal(id, "job-id"); return { status: "RUNNING", error: "" }; } }; },
        close() { throw new Error("close failure"); },
      }));
      assert.match(sql, kind === "BACKTEST" ? /FROM backtest_jobs/ : /FROM backtest_preparation_jobs/);
      assert.equal(observation.state, "READABLE");
      assert.equal(observation.error, "");
      assert.equal(observation.inspectionErrors[0]?.message, "close failure");
    }
  }));

  it("테이블 조회 실패가 자원 정리나 종료 보고를 예외로 막지 않음", () => temporary((dir) => {
    const file = path.join(dir, "job.sqlite");
    fs.writeFileSync(file, "fixture");
    let closeCount = 0;
    const failed = inspectJobDatabase(file, "BACKTEST", "job", () => ({
      prepare() { throw new Error("no such table"); }, close() { closeCount += 1; },
    }));
    assert.equal(failed.state, "QUERY_FAILED");
    assert.equal(closeCount, 1);
    const missing = inspectJobDatabase(file, "BACKTEST", "job", () => ({
      prepare() { return { get() { return undefined; } }; }, close() {},
    }));
    assert.equal(missing.state, "ROW_MISSING");
  }));

  it("결과 파일 누락·존재·접근 오류를 구분", () => temporary((dir) => {
    const file = path.join(dir, "result.sqlite");
    assert.equal(inspectArtifact(file).state, "MISSING");
    assert.equal(inspectArtifact(dir).state, "READ_FAILED");
    fs.writeFileSync(file, "result");
    assert.deepEqual(inspectArtifact(file), { state: "PRESENT", bytes: 6, error: null });
  }));

  it("작업 폴더를 정리해도 별도 진단은 남고 보존 개수·기간에 상한 적용", () => temporary((dir) => {
    const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const diagnostics = emptyDiagnostics();
    const log = (message: string) => { throw new Error(message); };
    fs.mkdirSync(path.join(dir, "jobs", "job-1"), { recursive: true });
    retainDiagnostic(dir, "job-1", { diagnostics }, write, log);
    fs.rmSync(path.join(dir, "jobs", "job-1"), { recursive: true });
    assert.ok(fs.existsSync(path.join(dir, "diagnostics", "job-1.json")));
    const old = path.join(dir, "diagnostics", "job-1.json");
    fs.utimesSync(old, 1, 1);
    for (let i = 2; i < 105; i += 1) retainDiagnostic(dir, `job-${i}`, { diagnostics }, write, log);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.readdirSync(path.join(dir, "diagnostics")).length <= DIAGNOSTIC_RETENTION.maxFiles);
  }));

  it("추가 작업 없이도 만료 기록과 중단된 임시 파일을 정리", () => temporary((dir) => {
    const directory = path.join(dir, "diagnostics");
    fs.mkdirSync(directory);
    const old = path.join(directory, "job-1.json");
    fs.writeFileSync(old, "{}");
    fs.utimesSync(old, 1, 1);
    fs.writeFileSync(path.join(directory, "job-2.json.tmp"), "partial");
    fs.writeFileSync(path.join(directory, "unrelated.txt"), "keep");
    pruneDiagnostics(dir, (message) => { throw new Error(message); });
    assert.deepEqual(fs.readdirSync(directory), ["unrelated.txt"]);
  }));

  it("진단 저장소 장애와 경로 탈출 시도는 로그로 남기고 호출자에 전파하지 않음", () => temporary((dir) => {
    const logs: string[] = [];
    const fail = () => { throw new Error("ENOSPC"); };
    assert.doesNotThrow(() => retainDiagnostic(dir, "job-1", {}, fail, (value) => logs.push(value)));
    assert.doesNotThrow(() => retainDiagnostic(dir, "../escape-1", {}, fail, (value) => logs.push(value)));
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /agent.diagnostics-storage-failed/);
  }));
});
