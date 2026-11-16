import { and, eq, notInArray } from "drizzle-orm";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { newId } from "../../../../runtime/shared/ids.js";
import type { BacktestWizardJob, BacktestWizardPageStep } from "../../../../shared/schemas/backtest-wizard-draft.js";
import { preparationInputSchema } from "../../../../shared/schemas/backtest-preparation.js";
import { backtestWizardJobs } from "../../../shared/db/preparation-owner-schema.js";
import { PreparationReferenceService } from "./preparation-reference-service.js";
import { BacktestWizardError, requireEditableWizard, requireWizard } from "./backtest-wizard-state.js";

const terminal = ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"];
type Row = typeof backtestWizardJobs.$inferSelect;
type Child = { id: string; status: string; updatedAtMs: number; error: string | null; cancelRequested?: number };
type PreparationChild = Child & { requestJson: string };

/** 별도 실행 큐 없이 기존 준비·계산 작업을 묶는다. 읽을 때도 상태를 맞춰 서버 재시작을 견딘다. */
export class BacktestWizardService {
  private readonly references: PreparationReferenceService;
  constructor(
    private readonly database: DatabaseHandle,
    private readonly clock: Clock,
    private readonly cancelJobs: { backtest(id: string): unknown; preparation(id: string): unknown },
  ) { this.references = new PreparationReferenceService(database); }

  create(ownerId: string, sourceJobId?: string): BacktestWizardJob {
    if (sourceJobId && !this.database.sqlite.prepare("SELECT 1 FROM backtest_jobs WHERE id=?").get(sourceJobId))
      throw new BacktestWizardError("복제 원본 백테스트를 찾을 수 없습니다.", 404);
    const now = this.clock.now();
    const id = newId("wizard");
    this.database.db.insert(backtestWizardJobs).values({
      id, ownerId, sourceJobId: sourceJobId ?? null, currentStep: sourceJobId ? "review" : "strategy",
      status: "WAITING", createdAtMs: now, updatedAtMs: now,
    }).run();
    return this.get(ownerId, id);
  }

  private children(row: Row) {
    const preparation = this.database.sqlite.prepare(`SELECT p.id, p.status, p.updated_at_ms AS updatedAtMs,
      p.error, p.request_json AS requestJson, p.cancel_requested AS cancelRequested
      FROM preparation_wizard_references r JOIN backtest_preparation_jobs p ON p.id=r.preparation_job_id
      WHERE r.user_id=? AND r.context=?`).get(row.ownerId, row.id) as PreparationChild | undefined;
    const backtest = row.backtestJobId ? this.database.sqlite.prepare(`SELECT id, status,
      coalesce(completed_at_ms,last_received_at_ms,last_progress_at_ms,started_at_ms,created_at_ms) AS updatedAtMs,
      error FROM backtest_jobs WHERE id=?`).get(row.backtestJobId) as Child | undefined : undefined;
    return { preparation, backtest };
  }

  sync(ownerId?: string): void {
    const rows = this.database.db.select().from(backtestWizardJobs)
      .where(and(ownerId ? eq(backtestWizardJobs.ownerId, ownerId) : undefined,
        notInArray(backtestWizardJobs.status, ["COMPLETED", "CANCELLED"]))).all();
    for (const row of rows) {
      const { preparation, backtest } = this.children(row);
      this.syncRow(row, preparation, backtest);
    }
  }

  private syncRow(row: Row, preparation: Child | undefined, backtest: Child | undefined): Row {
    if (row.status === "COMPLETED" || row.status === "CANCELLED") return row;
    const child = backtest ?? preparation;
    const status = backtest?.status === "COMPLETED" ? "COMPLETED"
      : !child || terminal.includes(child.status) ? "WAITING"
      : child.cancelRequested || child.status === "CANCELLING" ? "CANCELLING"
      : child.status === "QUEUED" ? "QUEUED"
      : child.status.startsWith("WAITING") ? "WAITING" : "RUNNING";
    const updatedAtMs = Math.max(row.updatedAtMs, child?.updatedAtMs ?? row.updatedAtMs);
    if (status === row.status && updatedAtMs === row.updatedAtMs) return row;
    const updated = { status, updatedAtMs, finishedAtMs: status === "COMPLETED" ? backtest!.updatedAtMs : null };
    this.database.db.update(backtestWizardJobs).set(updated).where(eq(backtestWizardJobs.id, row.id)).run();
    return { ...row, ...updated };
  }

  get(ownerId: string, id: string): BacktestWizardJob {
    const stored = requireWizard(this.database, ownerId, id);
    const { preparation, backtest } = this.children(stored);
    const row = this.syncRow(stored, preparation, backtest);
    const child = backtest ?? preparation;
    let phase = "설정 입력 대기";
    if (row.status === "CANCELLED") phase = "사용자가 작업을 취소했습니다";
    else if (row.status === "COMPLETED") phase = "백테스트 결과 생성 완료";
    else if (backtest && !terminal.includes(backtest.status)) phase = "백테스트 진행 중";
    else if (backtest) phase = "백테스트 재실행 대기";
    else if (preparation?.status === "COMPLETED") phase = "유니버스 준비 완료 · 사용자 입력 대기";
    else if (preparation && !terminal.includes(preparation.status)) phase = "유니버스 준비 중";
    else if (preparation) phase = "유니버스 준비 재시도 대기";
    const parsed = preparation ? preparationInputSchema.safeParse(JSON.parse(preparation.requestJson)) : null;
    return {
      id: row.id, sourceJobId: row.sourceJobId, currentStep: row.currentStep as BacktestWizardPageStep,
      status: row.status as BacktestWizardJob["status"], phase,
      error: row.status === "CANCELLED" ? null : child?.error ?? null,
      preparationJobId: preparation?.id ?? null, preparationInput: parsed?.success ? parsed.data : null,
      backtestJobId: row.backtestJobId, createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
      finishedAtMs: row.finishedAtMs,
      link: backtest && (row.status === "COMPLETED" || (row.status !== "CANCELLED" && !terminal.includes(backtest.status)))
        ? `/backtests/${encodeURIComponent(backtest.id)}`
        : row.status === "COMPLETED" ? `/jobs/${encodeURIComponent(`backtest-wizard:${row.id}`)}`
        : `/backtests/new/${row.currentStep}?wizard=${encodeURIComponent(row.id)}`,
    };
  }

  requireEditable(ownerId: string, id: string) { return requireEditableWizard(this.database, ownerId, id); }

  requireStandalonePreparation(id: string): void {
    if (this.database.sqlite.prepare(`SELECT 1 FROM preparation_wizard_references r
      JOIN backtest_wizard_jobs w ON w.id=r.context WHERE r.preparation_job_id=? LIMIT 1`).get(id))
      throw new BacktestWizardError("이 준비 작업은 위저드에서 사용 중입니다. 해당 위저드 작업을 취소하세요.", 409);
  }

  cancel(ownerId: string, id: string): BacktestWizardJob {
    const job = this.get(ownerId, id);
    if (job.status === "COMPLETED") throw new BacktestWizardError("완료된 위저드는 취소할 수 없습니다.", 409);
    // 부모 종료와 자식 취소·참조 해제는 함께 커밋한다. 재요청도 남은 정리를 수행한다.
    this.database.sqlite.transaction(() => {
      this.database.db.update(backtestWizardJobs).set({ status: "CANCELLED", finishedAtMs: job.finishedAtMs ?? this.clock.now(), updatedAtMs: this.clock.now() })
        .where(and(eq(backtestWizardJobs.id, id), eq(backtestWizardJobs.ownerId, ownerId))).run();
      if (job.backtestJobId) this.cancelJobs.backtest(job.backtestJobId);
      this.references.releaseWizard(ownerId, id);
      if (job.preparationJobId && !this.references.hasConsumers(job.preparationJobId))
        this.cancelJobs.preparation(job.preparationJobId);
    }).immediate();
    return this.get(ownerId, id);
  }
}
