import { randomBytes, randomUUID } from "node:crypto";
import type { AgentMessage, DatasetManifest, ServerAgentMessage } from "../../../../shared/agent-protocol.js";
import { UNIVERSE_COMPUTE_MAX_PENDING, UNIVERSE_COMPUTE_TIMEOUT_MS,
  type UniverseComputeReply } from "../../../../shared/universe-compute.js";

type Request = Extract<AgentMessage, { type: "UNIVERSE_REQUEST" }>;
interface Task {
  readonly owner: string;
  readonly worker: string;
  readonly request: Request;
  readonly token: string;
  readonly deadlineMs: number;
  readonly dataset: DatasetManifest;
}

/** 서버에는 임대 메타데이터만 남기고 계산 결과의 병합은 요청한 에이전트가 맡는다. */
export class UniverseComputeBroker {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly deps: {
    ownerDataset(owner: string, request: Request): DatasetManifest | null;
    peers(): readonly { id: string; datasetVersion: number; available: boolean }[];
    send(id: string, message: ServerAgentMessage): void;
    now?: () => number;
  }) {}

  active(worker: string): number {
    let count = 0;
    for (const task of this.tasks.values()) if (task.worker === worker) count++;
    return count;
  }

  request(owner: string, request: Request): void {
    const owned = [...this.tasks.values()].filter((task) =>
      task.owner === owner && task.request.jobId === request.jobId && task.request.attempt === request.attempt);
    if (owned.some((task) => task.request.requestId === request.requestId)) return;
    const dataset = this.deps.ownerDataset(owner, request);
    const peer = dataset && this.deps.peers().find((candidate) =>
      candidate.id !== owner && candidate.available && candidate.datasetVersion === dataset.version);
    if (!peer || !dataset || owned.length >= UNIVERSE_COMPUTE_MAX_PENDING || this.tasks.size >= 32) {
      this.reply(owner, request, { status: "UNAVAILABLE" });
      return;
    }
    const taskId = randomUUID();
    const task: Task = { owner, worker: peer.id, request,
      token: randomBytes(32).toString("base64url"), dataset,
      deadlineMs: (this.deps.now?.() ?? Date.now()) + UNIVERSE_COMPUTE_TIMEOUT_MS };
    this.tasks.set(taskId, task);
    try {
      this.deps.send(peer.id, { type: "UNIVERSE_TASK", taskId, token: task.token,
        deadlineMs: task.deadlineMs, dataset, input: request.input });
    } catch {
      this.tasks.delete(taskId);
      this.reply(owner, request, { status: "UNAVAILABLE" });
    }
  }

  result(worker: string, message: Extract<AgentMessage, { type: "UNIVERSE_RESULT" }>): void {
    const task = this.tasks.get(message.taskId);
    if (!task || task.worker !== worker || task.token !== message.token) return;
    this.tasks.delete(message.taskId);
    if (JSON.stringify(this.deps.ownerDataset(task.owner, task.request)) === JSON.stringify(task.dataset))
      this.reply(task.owner, task.request,
        task.deadlineMs > (this.deps.now?.() ?? Date.now()) ? message.reply : { status: "UNAVAILABLE" });
  }

  sweep(stopping = false): void {
    const connected = new Set(this.deps.peers().map((peer) => peer.id));
    const now = this.deps.now?.() ?? Date.now();
    for (const [taskId, task] of this.tasks) {
      const valid = !stopping && JSON.stringify(this.deps.ownerDataset(task.owner, task.request)) === JSON.stringify(task.dataset);
      if (valid && connected.has(task.worker) && now < task.deadlineMs) continue;
      this.tasks.delete(taskId);
      this.deps.send(task.worker, { type: "UNIVERSE_CANCEL", taskId });
      if (valid) this.reply(task.owner, task.request, { status: "UNAVAILABLE" });
    }
  }

  private reply(owner: string, request: Request, reply: UniverseComputeReply): void {
    this.deps.send(owner, { type: "UNIVERSE_REPLY", jobId: request.jobId,
      attempt: request.attempt, requestId: request.requestId, reply });
  }
}
