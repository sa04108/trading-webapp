import type { EventEmitter } from "node:events";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { Logger } from "../../../shared/logger.js";
import { isFinishedJob, type JobItem } from "../../../../shared/schemas/jobs.js";

export interface BackgroundJobSource {
  readonly jobEvents: EventEmitter;
  currentJob(): JobItem | null;
  cancelJob(id: string): boolean;
}

/** 수집 데이터와 별개인 관찰용 이력만 저장한다. */
export class BackgroundJobHistory {
  private readonly subscriptions: Array<() => void> = [];
  private readonly lastSaved = new Map<string, { status: string; atMs: number }>();
  private readonly stopping = new Set<string>();

  constructor(
    private readonly database: DatabaseHandle,
    clock: Clock,
    logger: Logger,
    private readonly sources: readonly BackgroundJobSource[],
  ) {
    const current = new Set(sources.map((source) => source.currentJob()?.id));
    const abandoned = database.sqlite.prepare("SELECT snapshot_json FROM background_job_history WHERE finished_at_ms IS NULL").all() as Array<{ snapshot_json: string }>;
    for (const row of abandoned) {
      const job = JSON.parse(row.snapshot_json) as JobItem;
      if (!current.has(job.id)) this.save({ ...job, status: "INTERRUPTED", phase: "서버 재시작으로 중단됨", error: "서버가 재시작되어 수집이 중단되었습니다. 저장된 데이터는 유지되며 원본 화면에서 다시 시작할 수 있습니다.", updatedAtMs: clock.now(), finishedAtMs: clock.now(), cancellable: false });
    }
    for (const source of sources) {
      const listener = (job: JobItem): void => {
        try {
          const previous = this.lastSaved.get(job.id);
          // 캐시된 날짜를 빠르게 통과해도 상태 이력 때문에 날짜마다 DB를 쓰지 않는다.
          if (previous?.status === job.status && clock.now() - previous.atMs < 1000) return;
          this.save(this.stopping.has(job.id) && isFinishedJob(job.status)
            ? { ...job, status: "INTERRUPTED", phase: "서버 종료로 중단됨", error: "서버 종료로 수집을 중단했습니다. 저장된 데이터는 유지됩니다.", cancellable: false }
            : job);
          if (isFinishedJob(job.status)) this.lastSaved.delete(job.id);
          else this.lastSaved.set(job.id, { status: job.status, atMs: clock.now() });
        }
        catch (error) { logger.warn({ err: error, jobId: job.id }, "수집 작업 이력 저장 실패"); }
      };
      source.jobEvents.on("job", listener);
      this.subscriptions.push(() => source.jobEvents.off("job", listener));
      const job = source.currentJob();
      if (job) listener(job);
    }
  }

  private save(job: JobItem): void {
    this.database.sqlite.prepare(`INSERT INTO background_job_history
      (id, status, created_at_ms, updated_at_ms, finished_at_ms, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at_ms=excluded.updated_at_ms,
        finished_at_ms=excluded.finished_at_ms, snapshot_json=excluded.snapshot_json`)
      .run(job.id, job.status, job.createdAtMs, job.updatedAtMs, job.finishedAtMs, JSON.stringify(job));
  }

  async close(): Promise<void> {
    // 진행 중 I/O가 끝나고 취소 이력을 저장한 뒤 DB를 닫는다.
    await Promise.all(this.sources.map(async (source) => {
      const current = source.currentJob();
      if (!current || isFinishedJob(current.status)) return;
      if (current.status !== "CANCELLING") this.stopping.add(current.id);
      await new Promise<void>((resolve) => {
        const listener = (job: JobItem): void => {
          if (job.id !== current.id || !isFinishedJob(job.status)) return;
          source.jobEvents.off("job", listener);
          resolve();
        };
        source.jobEvents.on("job", listener);
        source.cancelJob(current.id);
        const next = source.currentJob();
        if (!next || next.id !== current.id || isFinishedJob(next.status)) {
          source.jobEvents.off("job", listener);
          resolve();
        }
      });
    }));
    for (const unsubscribe of this.subscriptions) unsubscribe();
  }
}
