import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentMessage, DatasetManifest, ServerAgentMessage } from "../shared/agent-protocol.js";
import { universeComputeReplySchema, UNIVERSE_COMPUTE_TIMEOUT_MS,
  type UniverseComputeReply } from "../shared/universe-compute.js";
import { processRss, type AgentResources } from "./resources.js";

type Task = Extract<ServerAgentMessage, { type: "UNIVERSE_TASK" }>;
interface Running {
  task: Task; child: ChildProcess; budgetBytes: number; peakRss: number;
  closed: Promise<void>; deadline: NodeJS.Timeout;
}

/** 작은 서버의 기존 한도를 유지하면서 큰 장치의 보조 계산 예산을 확장한다. */
export function universeHelperBudget(budgetBytes: number): { budgetBytes: number; heapMb: number } {
  const budget = budgetBytes <= 512 * 1024 ** 2
    ? Math.min(budgetBytes, 320 * 1024 ** 2)
    : Math.min(budgetBytes, 2 * 1024 ** 3);
  return { budgetBytes: budget, heapMb: Math.max(128, Math.floor(budget * 0.4 / 1024 ** 2)) };
}

/** 작은 보조 계산도 슬롯·RSS·스냅샷 수명에 포함한다. 부모 준비 리스의 토큰은 전달하지 않는다. */
export class AgentUniverseTasks {
  private readonly running = new Map<string, Running>();
  constructor(private readonly deps: {
    resources(): AgentResources;
    active(): number;
    dataset(): DatasetManifest | null;
    file(dataset: DatasetManifest): string;
    send(message: AgentMessage): void;
    finished(peakRss: number): void;
  }) {}

  get size(): number { return this.running.size; }
  files(): string[] { return [...this.running.values()].map(({ task }) => this.deps.file(task.dataset)); }

  start(task: Task): void {
    if (this.running.has(task.taskId)) return;
    const dataset = this.deps.dataset();
    const resources = this.deps.resources();
    if (!dataset || JSON.stringify(dataset) !== JSON.stringify(task.dataset) ||
        resources.slots <= this.deps.active() || resources.budgetBytes < 256 * 1024 ** 2 ||
        resources.memoryPressure || task.deadlineMs <= Date.now()) {
      this.reply(task, { status: "UNAVAILABLE" });
      return;
    }
    const helperBudget = universeHelperBudget(resources.budgetBytes);
    let child: ChildProcess;
    try {
      const ts = import.meta.url.endsWith(".ts");
      child = fork(fileURLToPath(new URL(`../runtime/workers/universe-child.${ts ? "ts" : "js"}`, import.meta.url)), [], {
        execArgv: [`--max-old-space-size=${helperBudget.heapMb}`, "--max-semi-space-size=4", ...(ts ? ["--import", "tsx"] : [])],
        env: { NODE_ENV: "production" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      this.reply(task, { status: "UNAVAILABLE" });
      return;
    }
    let pending: UniverseComputeReply | undefined;
    let complete!: () => void;
    const running: Running = { task, child, budgetBytes: helperBudget.budgetBytes, peakRss: 0,
      closed: new Promise<void>((resolve) => { complete = resolve; }),
      deadline: setTimeout(() => child.kill("SIGKILL"), Math.min(UNIVERSE_COMPUTE_TIMEOUT_MS, task.deadlineMs - Date.now())),
    };
    this.running.set(task.taskId, running);
    child.on("message", (message: unknown) => {
      const parsed = universeComputeReplySchema.safeParse(message);
      if (parsed.success) pending = parsed.data;
      else child.kill("SIGKILL");
    });
    child.on("error", () => { pending = { status: "UNAVAILABLE" }; });
    child.once("close", () => {
      clearTimeout(running.deadline);
      this.running.delete(task.taskId);
      this.reply(task, pending ?? { status: "UNAVAILABLE" });
      this.deps.finished(running.peakRss);
      complete();
    });
    child.send({ dataPath: this.deps.file(task.dataset), collectionVersion: task.dataset.collectionVersion,
      input: task.input }, (error) => { if (error) child.kill("SIGKILL"); });
  }

  sample(): void {
    for (const running of this.running.values()) {
      running.peakRss = Math.max(running.peakRss, running.child.pid ? processRss(running.child.pid) : 0);
      if (running.peakRss > running.budgetBytes) running.child.kill("SIGKILL");
    }
  }

  cancel(taskId: string): void { this.running.get(taskId)?.child.kill("SIGKILL"); }

  async stop(): Promise<void> {
    const pending = [...this.running.values()];
    for (const running of pending) running.child.kill("SIGKILL");
    await Promise.all(pending.map((running) => running.closed));
  }

  private reply(task: Task, reply: UniverseComputeReply): void {
    this.deps.send({ type: "UNIVERSE_RESULT", taskId: task.taskId, token: task.token, reply });
  }
}
