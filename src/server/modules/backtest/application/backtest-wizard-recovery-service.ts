import { eq, notInArray } from "drizzle-orm";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { newId } from "../../../../runtime/shared/ids.js";
import { PreparationInputError, type BacktestPreparationOrchestrator } from "../../../../runtime/modules/backtest/application/backtest-preparation-orchestrator.js";
import { preparationInputSchema, type PreparationInput } from "../../../../shared/schemas/backtest-preparation.js";
import { backtestRequestSchema } from "../../../../shared/schemas/backtest-request.js";
import { backtestWizardDrafts, backtestWizardJobs } from "../../../shared/db/preparation-owner-schema.js";
import { notifications } from "../../../shared/db/notification-schema.js";
import { PreparationReferenceService } from "./preparation-reference-service.js";
import type { BacktestWizardService } from "./backtest-wizard-service.js";
import { wizardRuntimeVersionsJson, wizardVersionChanges } from "./backtest-wizard-versions.js";

type Wizard = typeof backtestWizardJobs.$inferSelect;
type NotificationRow = typeof notifications.$inferSelect;
type Child = { id: string; status: string; request_json: string; cancel_requested?: number };
const terminal = ["COMPLETED", "CANCELLED", "FAILED", "INTERRUPTED"];

/** 포트를 열고 실행 큐를 시작하기 전에만 호출한다. 중단 실행과 새 준비를 한 트랜잭션으로 교체한다. */
export class BacktestWizardRecoveryService {
  private readonly references: PreparationReferenceService;
  constructor(
    private readonly database: DatabaseHandle,
    private readonly clock: Clock,
    private readonly wizards: BacktestWizardService,
    private readonly preparation: Pick<BacktestPreparationOrchestrator, "start" | "bindWizard">,
    private readonly onNotification: (notification: NotificationRow) => void,
    private readonly beforeQueue: () => Promise<void>,
  ) { this.references = new PreparationReferenceService(database); }

  recover(): void {
    this.wizards.sync();
    const events = this.database.sqlite.transaction(() => {
      const created: NotificationRow[] = [];
      const replacements = new Map<string, string>();
      const rows = this.database.db.select().from(backtestWizardJobs)
        .where(notInArray(backtestWizardJobs.status, ["COMPLETED", "CANCELLED", "CANCELLING"])).all();
      for (const wizard of rows) {
        const changes = wizardVersionChanges(wizard.runtimeVersionsJson);
        if (changes.length === 0) continue;
        const backtest = wizard.backtestJobId
          ? this.database.sqlite.prepare("SELECT id,status,request_json FROM backtest_jobs WHERE id=?").get(wizard.backtestJobId) as Child | undefined : undefined;
        const owner = this.references.getWizard(wizard.ownerId, wizard.id);
        const previous = owner ? this.database.sqlite.prepare("SELECT id,status,request_json,cancel_requested FROM backtest_preparation_jobs WHERE id=?")
          .get(owner.preparationJobId) as Child | undefined : undefined;
        // 사용자가 취소했거나 실패 후 멈춰 둔 계산을 배포만으로 다시 실행하지 않는다.
        if (backtest && (terminal.includes(backtest.status) || backtest.status === "CANCELLING")) continue;
        if (!backtest && (!previous || previous.cancel_requested || ["FAILED", "CANCELLED", "INTERRUPTED"].includes(previous.status))) {
          if (!previous && !wizard.recoveryMessage) this.database.db.update(backtestWizardJobs)
            .set({ runtimeVersionsJson: wizardRuntimeVersionsJson() }).where(eq(backtestWizardJobs.id, wizard.id)).run();
          continue;
        }

        const now = this.clock.now();
        const message = `${changes.join("·")} 변경으로 유니버스를 다시 준비합니다. 완료 후 설정을 확인하고 백테스트를 직접 실행하세요.`;
        this.fenceBacktest(backtest?.id, now);
        let error: string | null = null;
        let input: PreparationInput | null = null;
        try {
          input = this.readInput(backtest ?? previous);
          this.seedMissingDrafts(wizard, input, backtest, now);
          const key = JSON.stringify(input);
          const replacement = replacements.get(key);
          if (replacement) this.preparation.bindWizard(wizard.ownerId, wizard.id, replacement);
          else {
            const job = this.preparation.start(input, { userId: wizard.ownerId, context: wizard.id }, this.beforeQueue, { reuseActive: false });
            replacements.set(key, job.id);
          }
        } catch (failure) {
          if (!(failure instanceof PreparationInputError)) throw failure;
          error = `자동 복구할 수 없습니다: ${failure.message} 전략과 입력값을 확인한 뒤 미리보기를 다시 실행하세요.`;
        }
        // 새 참조로 교체한 뒤 소비자가 없는 이전 준비만 정리한다. 공유 작업은 유지한다.
        if (previous && (!this.references.hasConsumers(previous.id) || error && this.onlyWizardConsumer(previous.id, wizard)))
          this.fencePreparation(previous.id, now);
        this.database.db.update(backtestWizardJobs).set({
          currentStep: "universe", status: error ? "WAITING" : "QUEUED", finishedAtMs: null,
          runtimeVersionsJson: wizardRuntimeVersionsJson(), recoveryMessage: message, recoveryError: error, updatedAtMs: now,
        }).where(eq(backtestWizardJobs.id, wizard.id)).run();
        const notification: NotificationRow = {
          id: newId("ntf"), type: "backtest", severity: error ? "error" : "info",
          title: error ? "버전 변경 후 백테스트 자동 복구에 실패했습니다" : "버전 변경으로 유니버스를 다시 준비합니다",
          body: `${input ? `${input.strategyId} · ${input.period.from} ~ ${input.period.to}\n` : ""}${error ?? message}`,
          link: `/backtests/new/universe?wizard=${encodeURIComponent(wizard.id)}`, read: false, createdAtMs: now,
        };
        this.database.db.insert(notifications).values(notification).run();
        created.push(notification);
      }
      return created;
    }).immediate();
    // DB 복구가 롤백된 경우에는 SSE도 전송하지 않는다.
    for (const event of events) this.onNotification(event);
  }

  private readInput(child: Child | undefined): PreparationInput {
    try {
      const parsed = preparationInputSchema.safeParse(JSON.parse(child?.request_json ?? "null"));
      if (parsed.success) return parsed.data;
    } catch { /* 손상된 이전 요청은 새 값으로 추측하지 않는다. */ }
    throw new PreparationInputError("이전 작업의 전략·기간·유니버스 입력을 복원하지 못했습니다.");
  }

  private seedMissingDrafts(wizard: Wizard, input: PreparationInput, backtest: Child | undefined, now: number): void {
    const drafts: Record<string, unknown> = {
      strategy: { strategyId: input.strategyId, parameters: Object.fromEntries(Object.entries(input.parameters).map(([key, value]) => [key, String(value)])), currentStep: "universe" },
      period: input.period,
      universe: { universeRule: input.universeRule },
    };
    if (backtest) {
      const request = backtestRequestSchema.safeParse(JSON.parse(backtest.request_json));
      if (!request.success) throw new PreparationInputError("기존 백테스트의 자본·비용 설정을 복원하지 못했습니다.");
      const { capital, risk, execution, randomSeed } = request.data;
      drafts.capital = { initialCash: String(capital.initialCash), maxPositions: String(risk.maxPositions),
        maxPositionWeightPercent: risk.maxPositionWeightPercent === undefined ? "" : String(risk.maxPositionWeightPercent),
        commissionProfileId: execution.commissionProfileId, slippageProfileId: execution.slippageProfileId, randomSeed: String(randomSeed) };
    }
    // 정상적으로 자동 저장한 입력은 보존하고, 기록이 없는 단계만 실제 작업 요청으로 보충한다.
    for (const [step, payload] of Object.entries(drafts)) this.database.db.insert(backtestWizardDrafts).values({
      userId: wizard.ownerId, context: wizard.id, step, payloadJson: JSON.stringify(payload), updatedAtMs: now,
    }).onConflictDoNothing().run();
  }

  private fenceBacktest(id: string | undefined, now: number): void {
    if (!id) return;
    this.database.sqlite.prepare(`UPDATE backtest_jobs SET status='CANCELLED',
      agent_id=NULL, lease_token_hash=NULL, lease_expires_at_ms=NULL, completed_at_ms=?,
      error='버전 변경으로 유니버스 재준비 후 사용자 입력을 기다립니다.'
      WHERE id=? AND status IN ('QUEUED','STARTING','RUNNING')`).run(now, id);
  }

  private fencePreparation(id: string, now: number): void {
    this.database.sqlite.prepare(`UPDATE backtest_preparation_jobs SET status='CANCELLED', cancel_requested=1,
      updated_at_ms=?, completed_at_ms=? WHERE id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`).run(now, now, id);
    this.database.sqlite.prepare("UPDATE agent_preparation_leases SET lease_token_hash=NULL, lease_expires_at_ms=NULL WHERE job_id=?").run(id);
    this.database.sqlite.prepare("DELETE FROM agent_data_waits WHERE kind='PREPARATION' AND job_id=?").run(id);
  }

  private onlyWizardConsumer(id: string, wizard: Wizard): boolean {
    // 실패한 교체는 기존 참조를 보존하되 다른 위저드·실험에서 쓰는 작업은 취소하지 않는다.
    return !this.database.sqlite.prepare(`SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id=? AND (user_id<>? OR context<>?)
      UNION ALL SELECT 1 FROM backtest_jobs WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM backtest_validation_trials WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM backtest_clone_batches WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM configuration_search_items WHERE preparation_job_id=?
      UNION ALL SELECT 1 FROM backtest_refresh_jobs WHERE preparation_job_id=? LIMIT 1`)
      .get(id, wizard.ownerId, wizard.id, id, id, id, id, id);
  }
}
