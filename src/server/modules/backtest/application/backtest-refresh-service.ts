import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import { newId } from "../../../../runtime/shared/ids.js";
import { backtestPreparationJobs } from "../../../../runtime/shared/db/operations-schema.js";
import type { BacktestPreparationOrchestrator, BacktestUniversePreview } from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { backtestRefreshJobs } from "../../../shared/db/backtest-refresh-schema.js";
import { backtestRefreshActionLabel, backtestRefreshActionSchema, type BacktestRefreshAction, type BacktestRefreshJob, type BacktestRefreshStatus } from "../../../../shared/schemas/backtest-refresh.js";
import type { BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import { PreparationReferenceError, PreparationReferenceService } from "./preparation-reference-service.js";

export type BacktestRefreshRow = typeof backtestRefreshJobs.$inferSelect;
const activeStatuses = ["QUEUED", "PREPARING", "SUBMITTING"];

export class BacktestRefreshError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export interface BacktestRefreshDeps {
  database: DatabaseHandle;
  clock: Clock;
  preparation: BacktestPreparationOrchestrator;
  snapshot(sourceJobId: string, action: BacktestRefreshAction): { request: BacktestRequest; warnings: readonly string[] };
  runtimeIdentity(request: BacktestRequest): string;
  refreshProviderFilings?: () => Promise<void>;
  buildSubmission(row: BacktestRefreshRow, preview: BacktestUniversePreview | null): Promise<(() => string | null) | null>;
  onFinished(job: BacktestRefreshJob): void;
}

/** 후속 실행 생성과 완료 기록을 같은 트랜잭션에 넣어 재시작·중복 요청에도 한 번만 실행한다. */
export class BacktestRefreshService {
  private pumping: Promise<void> | null = null;
  private stopping = false;
  private readonly references: PreparationReferenceService;

  constructor(private readonly deps: BacktestRefreshDeps) {
    this.references = new PreparationReferenceService(deps.database);
  }

  create(ownerId: string, requestId: string, sourceJobId: string, action: BacktestRefreshAction): BacktestRefreshJob {
    const normalized = backtestRefreshActionSchema.parse(action);
    return this.deps.database.sqlite.transaction(() => {
      const existing = this.deps.database.db.select().from(backtestRefreshJobs).where(and(
        eq(backtestRefreshJobs.ownerId, ownerId), eq(backtestRefreshJobs.requestId, requestId),
      )).get();
      const actionJson = JSON.stringify(normalized);
      if (existing) {
        const existingAction = backtestRefreshActionSchema.parse(JSON.parse(existing.actionJson));
        if (existing.sourceJobId !== sourceJobId || JSON.stringify(existingAction) !== actionJson)
          throw new BacktestRefreshError("같은 요청 번호에 다른 작업을 지정할 수 없습니다.", 409);
        return this.dto(existing);
      }
      const active = this.deps.database.db.select({ id: backtestRefreshJobs.id }).from(backtestRefreshJobs).where(and(
        eq(backtestRefreshJobs.ownerId, ownerId), inArray(backtestRefreshJobs.status, activeStatuses),
      )).all();
      if (active.length >= 5) throw new BacktestRefreshError("진행 중인 데이터 업데이트 작업은 최대 5개입니다.", 429);
      const snapshot = this.deps.snapshot(sourceJobId, normalized);
      const now = this.deps.clock.now();
      const row = this.deps.database.db.insert(backtestRefreshJobs).values({
        id: newId("btr"), ownerId, requestId, sourceJobId, actionJson,
        requestJson: JSON.stringify(snapshot.request), warningsJson: JSON.stringify(snapshot.warnings),
        runtimeIdentity: this.deps.runtimeIdentity(snapshot.request), status: "QUEUED", createdAtMs: now, updatedAtMs: now,
      }).returning().get();
      return this.dto(row);
    }).immediate();
  }

  get(ownerId: string, id: string): BacktestRefreshJob {
    return this.dto(this.owned(ownerId, id));
  }

  retry(ownerId: string, id: string): BacktestRefreshJob {
    const row = this.owned(ownerId, id);
    if (row.status !== "FAILED" && row.status !== "CANCELLED")
      throw new BacktestRefreshError("실패하거나 취소된 작업만 다시 시작할 수 있습니다.", 409);
    const action = backtestRefreshActionSchema.parse(JSON.parse(row.actionJson));
    // 같은 실패 화면을 여러 번 눌러도 한 번의 후속 재시도만 만든다.
    return this.create(ownerId, `retry:${id}`, row.sourceJobId, action);
  }

  cancel(ownerId: string, id: string): BacktestRefreshJob {
    this.deps.database.sqlite.transaction(() => {
      const row = this.owned(ownerId, id);
      if (!activeStatuses.includes(row.status)) return;
      this.finish(row, "CANCELLED", null, null);
      this.cancelUnsharedPreparation(row.preparationJobId);
    }).immediate();
    return this.get(ownerId, id);
  }

  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = this.tick().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async stop(): Promise<void> { this.stopping = true; await this.pumping; }

  private row(id: string): BacktestRefreshRow | undefined {
    return this.deps.database.db.select().from(backtestRefreshJobs).where(eq(backtestRefreshJobs.id, id)).get();
  }

  private owned(ownerId: string, id: string): BacktestRefreshRow {
    const row = this.row(id);
    if (!row || row.ownerId !== ownerId) throw new BacktestRefreshError("데이터 업데이트 작업을 찾을 수 없습니다.", 404);
    return row;
  }

  private current(row: BacktestRefreshRow): BacktestRefreshRow | null {
    if (this.stopping) return null;
    const current = this.row(row.id);
    return current && activeStatuses.includes(current.status) ? current : null;
  }

  private dto(row: BacktestRefreshRow): BacktestRefreshJob {
    const action = backtestRefreshActionSchema.parse(JSON.parse(row.actionJson));
    const status = row.status as BacktestRefreshStatus;
    const preparation = row.preparationJobId ? this.deps.preparation.get(row.preparationJobId) : null;
    const messages: Record<BacktestRefreshStatus, string> = {
      QUEUED: "최신 데이터 준비를 기다리고 있습니다.",
      PREPARING: "유니버스 준비가 끝나면 요청한 작업을 자동으로 시작합니다.",
      SUBMITTING: "데이터 준비가 끝났습니다. 실행 가능한 대기열을 확인하고 있습니다.",
      COMPLETED: `${backtestRefreshActionLabel(action)} 작업을 시작했습니다.`,
      FAILED: "데이터 준비 또는 후속 실행을 완료하지 못했습니다.",
      CANCELLED: "데이터 업데이트 작업을 취소했습니다.",
    };
    return { id: row.id, sourceJobId: row.sourceJobId, action, status, preparationJobId: row.preparationJobId,
      message: preparation?.status === "WAITING_DAILY_QUOTA" ? "수집 호출 한도 해제 후 자동으로 이어갑니다." : messages[status],
      error: row.error, resultHref: row.resultHref, createdAtMs: row.createdAtMs, completedAtMs: row.completedAtMs };
  }

  private attach(row: BacktestRefreshRow, preparationJobId: string): void {
    this.references.requirePreparation(preparationJobId);
    this.deps.database.db.update(backtestRefreshJobs).set({ preparationJobId, status: "PREPARING", updatedAtMs: this.deps.clock.now() })
      .where(eq(backtestRefreshJobs.id, row.id)).run();
    this.deps.database.db.update(backtestPreparationJobs).set({ lifecycleManaged: true })
      .where(eq(backtestPreparationJobs.id, preparationJobId)).run();
    this.references.collect();
  }

  private finish(row: BacktestRefreshRow, status: "COMPLETED" | "FAILED" | "CANCELLED", error: string | null, resultHref: string | null): void {
    const changed = this.deps.database.db.update(backtestRefreshJobs).set({
      status, error, resultHref, preparationJobId: null, updatedAtMs: this.deps.clock.now(), completedAtMs: this.deps.clock.now(),
    }).where(and(eq(backtestRefreshJobs.id, row.id), inArray(backtestRefreshJobs.status, activeStatuses))).run();
    if (changed.changes) this.references.collect();
  }

  /** 실행 완료가 커밋된 뒤 알림을 저장한다. 알림 직전 종료되어도 다음 부팅에서 전달한다. */
  private notifyFinished(): void {
    const rows = this.deps.database.db.select({ id: backtestRefreshJobs.id }).from(backtestRefreshJobs)
      .where(and(inArray(backtestRefreshJobs.status, ["COMPLETED", "FAILED", "CANCELLED"]), isNull(backtestRefreshJobs.notifiedAtMs)))
      .limit(100).all();
    for (const row of rows) this.deps.database.sqlite.transaction(() => {
      const current = this.row(row.id);
      if (!current || current.notifiedAtMs !== null) return;
      this.deps.onFinished(this.dto(current));
      this.deps.database.db.update(backtestRefreshJobs).set({ notifiedAtMs: this.deps.clock.now() }).where(eq(backtestRefreshJobs.id, row.id)).run();
    }).immediate();
  }

  private cancelUnsharedPreparation(id: string | null): void {
    if (!id) return;
    const shared = this.deps.database.sqlite.prepare(`
      SELECT 1 FROM backtest_refresh_jobs WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM backtest_jobs WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM backtest_validation_trials WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM configuration_search_items WHERE preparation_job_id=? LIMIT 1
    `).get(id, id, id, id, id);
    if (!shared) this.deps.preparation.cancel(id);
  }

  private async tick(): Promise<void> {
    this.notifyFinished();
    const rows = this.deps.database.db.select().from(backtestRefreshJobs).where(inArray(backtestRefreshJobs.status, activeStatuses))
      .orderBy(asc(backtestRefreshJobs.createdAtMs), asc(backtestRefreshJobs.id)).all();
    for (const saved of rows) {
      const row = this.current(saved);
      if (!row) continue;
      try { await this.advance(row); }
      catch (error) {
        if (!this.current(row)) continue;
        this.deps.database.sqlite.transaction(() => {
          if (!this.current(row)) return;
          if (error instanceof PreparationReferenceError) {
            // 검증 중 데이터가 바뀐 경우 새 기준으로 다시 준비하며 후속 작업은 아직 생성하지 않는다.
            this.deps.database.db.update(backtestRefreshJobs).set({ status: "QUEUED", preparationJobId: null, updatedAtMs: this.deps.clock.now() })
              .where(eq(backtestRefreshJobs.id, row.id)).run();
            this.references.collect();
          } else this.finish(row, "FAILED", error instanceof Error ? error.message : "데이터 업데이트 중 오류가 발생했습니다.", null);
        }).immediate();
      }
    }
    this.notifyFinished();
  }

  private async advance(row: BacktestRefreshRow): Promise<void> {
    const request = JSON.parse(row.requestJson) as BacktestRequest;
    if (this.deps.runtimeIdentity(request) !== row.runtimeIdentity)
      throw new Error("준비 중 실행 기준이 변경되어 자동 실행을 중단했습니다. 최신 기준으로 다시 시도하세요.");
    const action = backtestRefreshActionSchema.parse(JSON.parse(row.actionJson));
    // 공유 준비와 기간검증도 새 작업을 승인한 시점의 공시 목록 확인을 거친다.
    if (row.status === "QUEUED" && this.deps.refreshProviderFilings) {
      await this.deps.refreshProviderFilings();
      if (!this.current(row)) return;
    }
    let preview: BacktestUniversePreview | null = null;
    // 기간검증은 자체 영속 작업이 각 구간·후보별 준비를 수행한다.
    if (action.kind !== "PERIOD_VALIDATION") {
      if (row.preparationJobId) {
        const preparation = this.deps.preparation.get(row.preparationJobId);
        if (!preparation) throw new Error("사용 중인 데이터 준비 작업을 찾을 수 없습니다.");
        if (preparation.status === "FAILED" || preparation.status === "CANCELLED")
          throw new Error(preparation.error ?? "데이터 준비가 취소되었습니다.");
        if (preparation.status !== "COMPLETED") return;
        preview = this.deps.preparation.getFreshPreviewDetails(request, row.preparationJobId)?.preview ?? null;
      }
      if (!preview) {
        this.deps.database.sqlite.transaction(() => {
          if (!this.current(row)) return;
          const active = this.deps.preparation.getActive(request);
          const ready = this.deps.preparation.getFreshPreviewDetails(request);
          const id = active?.id ?? (ready ? ready.preview.preparationJobId! : this.deps.preparation.start(request).id);
          this.attach(row, id);
        }).immediate();
        return;
      }
    }
    if (!this.current(row)) return;
    this.deps.database.db.update(backtestRefreshJobs).set({ status: "SUBMITTING", updatedAtMs: this.deps.clock.now() })
      .where(eq(backtestRefreshJobs.id, row.id)).run();
    const submit = await this.deps.buildSubmission(row, preview);
    if (!submit || !this.current(row)) return;
    this.deps.database.sqlite.transaction(() => {
      if (!this.current(row)) return;
      if (this.deps.runtimeIdentity(request) !== row.runtimeIdentity)
        throw new Error("준비 중 실행 기준이 변경되어 자동 실행을 중단했습니다. 최신 기준으로 다시 시도하세요.");
      if (preview && !this.deps.preparation.getFreshPreviewDetails(request, preview.preparationJobId)?.preview)
        throw new PreparationReferenceError();
      const resultHref = submit();
      if (resultHref !== null) this.finish(row, "COMPLETED", null, resultHref);
    }).immediate();
  }
}
