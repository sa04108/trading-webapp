import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { TradingToggle } from "../../../../shared/schemas/trading.js";
import { tradingToggleJobs as jobs } from "../../../shared/db/trading-schema.js";

type Entry = typeof jobs.$inferSelect;

export class TradingToggleHistory {
  constructor(private readonly database: DatabaseHandle, private readonly slot: number, private readonly now: () => number) {}

  active() {
    return this.database.db.select().from(jobs)
      .where(and(eq(jobs.accountSlot, this.slot), isNull(jobs.finishedAtMs))).get();
  }

  latest(deploymentId: string): TradingToggle | null {
    const row = this.database.db.select({ id: jobs.id, action: jobs.action, status: jobs.status, message: jobs.message })
      .from(jobs).where(eq(jobs.deploymentId, deploymentId))
      .orderBy(desc(jobs.createdAtMs), sql`rowid DESC`).limit(1).get();
    return row ? { ...row, id: `trading-toggle:${row.id}` } : null;
  }

  create(input: Pick<Entry, "deploymentId" | "ownerId" | "action" | "title" | "executorToken" | "expectedRevision">) {
    const now = this.now();
    return this.database.db.insert(jobs).values({
      ...input, id: randomUUID(), accountSlot: this.slot, status: "RUNNING",
      message: input.action === "activate" ? "계좌와 전략 실행 데이터를 확인하고 있습니다." : "신규 주문을 차단하고 미체결 주문을 확인하고 있습니다.",
      createdAtMs: now, updatedAtMs: now,
    }).returning().get();
  }

  update(id: string, status: TradingToggle["status"], message: string) {
    const now = this.now();
    this.database.db.update(jobs).set({ status, message, updatedAtMs: now, finishedAtMs: status === "RUNNING" ? null : now })
      .where(and(eq(jobs.id, id), isNull(jobs.finishedAtMs))).run();
  }

  /** 현재 임대를 가진 실행기만 중지 대조의 완료나 이전 실행기의 중단을 확정한다. */
  reconcile(deployment: { id: string; status: string; activity: string } | null, executorToken: string) {
    const job = this.active();
    if (!job) return;
    if (job.deploymentId !== deployment?.id) {
      this.update(job.id, "INTERRUPTED", "등록 전략이 변경되어 전환을 중단했습니다.");
    } else if (job.action === "deactivate") {
      if (deployment.status === "INACTIVE") this.update(job.id, "COMPLETED", "자동 매매를 껐습니다.");
      else if (deployment.status === "STOPPING" && deployment.activity !== job.message) this.update(job.id, "RUNNING", deployment.activity);
    } else if (job.executorToken !== executorToken) {
      if (deployment.status === "ACTIVE") this.update(job.id, "COMPLETED", "자동 매매를 켰습니다.");
      else this.update(job.id, "INTERRUPTED", "실행기가 바뀌어 활성화 준비를 중단했습니다. 계좌 상태를 확인한 뒤 다시 켜 주세요.");
    }
  }
}
