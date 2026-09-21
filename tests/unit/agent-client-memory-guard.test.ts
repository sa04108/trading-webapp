import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient, type AgentRuntimeAdapter } from "../../src/agent/client.js";
import type { AgentLease } from "../../src/shared/agent-protocol.js";

interface MemoryGuardRunning {
  cancellation: boolean;
  cancellationReason?: string;
  cancelPath?: string;
  resourceError?: string;
  timers: NodeJS.Timeout[];
}

type HarnessRunning = MemoryGuardRunning & {
  lease: AgentLease;
  child: { pid: number; connected: boolean; kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  directory: string;
  jobPath: string;
  peakRss: number;
  budgetBytes: number;
  observation: {
    exited: boolean;
    snapshot: () => { exited: boolean };
    recordError: ReturnType<typeof vi.fn>;
  };
};

type ClientInternals = {
  readonly running: Map<string, MemoryGuardRunning>;
  sample(): void;
  spawn(lease: AgentLease): void;
};

type SetupFailureClient = {
  failSetup(lease: AgentLease, error: Error, code: string): void;
};

const directories: string[] = [];

function resources(memoryPressure: boolean): AgentRuntimeAdapter["resources"] {
  return () => ({
    cpus: 1,
    availableBytes: 512 * 1024 ** 2,
    reserveBytes: 128 * 1024 ** 2,
    slots: memoryPressure ? 0 : 1,
    heapMb: 128,
    maxBars: 1,
    budgetBytes: 128 * 1024 ** 2,
    memoryPressure,
  });
}

function lease(): AgentLease {
  return {
    kind: "PREPARATION",
    jobId: "memory-guard",
    attempt: 1,
    leaseToken: "t".repeat(48),
    leaseExpiresAtMs: Date.now() + 60_000,
    dataset: {
      version: 1,
      datasetId: "fe0da193-553e-4155-bcc8-470d15a8fd4a",
      sourceRevision: 1,
      schemaVersion: 1,
      collectionVersion: "c".repeat(64),
      sha256: "d".repeat(64),
      bytes: 1,
    },
    payload: {},
  };
}

function harness(local: boolean, memoryPressure: boolean, cancelling = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-guard-"));
  directories.push(directory);
  const runtime: AgentRuntimeAdapter | undefined = local
    ? {
        runnerVersion: "a".repeat(64),
        cache: {
          current: null,
          syncing: false,
          synchronize: async () => undefined,
          file: () => "",
          prune: () => undefined,
          stop: async () => undefined,
        },
        resources: resources(memoryPressure),
        connect: () => undefined,
        send: () => undefined,
        close: () => undefined,
        upload: async () => 200,
      }
    : undefined;
  const client = new AgentClient(
    { serverUrl: "http://localhost", token: "" },
    directory,
    undefined,
    () => undefined,
    runtime,
  );
  const kill = vi.fn();
  const send = vi.fn();
  const running: HarnessRunning = {
    lease: lease(),
    child: { pid: process.pid, connected: true, kill, send },
    directory,
    jobPath: path.join(directory, "job.sqlite"),
    peakRss: 0,
    budgetBytes: 1,
    cancellation: cancelling,
    timers: [],
    observation: {
      exited: false,
      snapshot: () => ({ exited: false }),
      recordError: vi.fn(),
    },
  };
  const internals = client as unknown as ClientInternals;
  internals.running.set("memory-guard-1", running);
  return { client, internals, running, kill, send };
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("AgentClient 메모리 보호", () => {
  it("로컬 API 메모리 압력은 이미 취소 중인 워커도 즉시 종료한다", () => {
    const h = harness(true, true, true);
    h.internals.sample();
    expect(h.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.running.cancellationReason).toBe("SERVER_MEMORY_PRESSURE");
    expect(h.running.cancelPath).toBe("SIGKILL");
    expect(h.running.resourceError).toContain("API");
  });

  it("로컬 워커 RSS 예산 초과는 유예 없이 종료한다", () => {
    const h = harness(true, false);
    h.internals.sample();
    expect(h.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.running.cancellationReason).toBe("MEMORY_BUDGET_EXCEEDED");
    expect(h.running.resourceError).toContain("메모리 예산");
  });

  it("원격 워커 RSS 예산 초과는 기존 IPC 취소 경로를 유지한다", () => {
    const h = harness(false, false);
    h.internals.sample();
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith({ type: "cancel" }, expect.any(Function));
    expect(h.running.cancellationReason).toBe("MEMORY_BUDGET_EXCEEDED");
    for (const timer of h.running.timers) clearTimeout(timer);
  });

  it("늦게 감지한 로컬 압력은 작업 폴더를 만들기 전에 setup 실패로 돌린다", () => {
    const h = harness(true, true);
    h.internals.running.clear();
    const failure = vi.spyOn(
      h.client as unknown as SetupFailureClient,
      "failSetup",
    ).mockImplementation(() => undefined);
    h.internals.spawn(lease());
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "memory-guard" }),
      expect.any(Error),
      "RESOURCE_BUDGET_EXCEEDED",
    );
    expect(fs.existsSync(path.join(h.client.directory, "jobs", "memory-guard-1"))).toBe(false);
  });

  it("기존 로컬 자식이 drain 중이면 다음 작업 폴더를 만들기 전에 거절한다", () => {
    const h = harness(true, false);
    const failure = vi.spyOn(
      h.client as unknown as SetupFailureClient,
      "failSetup",
    ).mockImplementation(() => undefined);
    h.internals.spawn({ ...lease(), jobId: "next-memory-guard" });
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "next-memory-guard" }),
      expect.any(Error),
      "RESOURCE_BUDGET_EXCEEDED",
    );
    expect(fs.existsSync(path.join(h.client.directory, "jobs", "next-memory-guard-1"))).toBe(false);
  });
});
