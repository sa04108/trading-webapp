import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";
import { getIntradayStrategy } from "../../../../shared/schemas/intraday-strategies.js";
import { intradayRequestSchema, type IntradayRequest, type IntradayResult } from "../../../../shared/schemas/intraday.js";
import { buildPeriodValidationPlan, getValidationOptimization, periodValidationConfigSchema, selectValidationCandidate, evaluateValidationCandidate, type PeriodValidationDto, type PeriodValidationPlan, type ValidationMetrics, type ValidationStatus, type ValidationRole, type ValidationSkipReason } from "../../../../shared/schemas/period-validation.js";
import { summarizeIntradayTrades } from "../../../../shared/intraday-trades.js";
import { intradayRuns } from "../../../shared/db/intraday-schema.js";
import { intradayValidations, intradayValidationTrials } from "../../../shared/db/intraday-validation-schema.js";
import { IntradayError, type IntradayService } from "./intraday-service.js";

const metrics = (result: IntradayResult): ValidationMetrics => ({ totalReturnPct: result.metrics.returnPct, cagrPct: null, maxDrawdownPct: result.metrics.maxDrawdownPct, sharpe: result.metrics.sharpe, tradeCount: summarizeIntradayTrades(result).tradeCount, ...(result.dailyEvaluation ? { intradayDaily: result.dailyEvaluation.summary } : {}) });
type Row = typeof intradayValidations.$inferSelect;
export class IntradayValidationService {
  private pumping: Promise<void> | null = null;
  private stopping = false;
  constructor(private readonly database: DatabaseHandle, private readonly runs: IntradayService) {}
  private row(owner: string, id: string) { return this.database.db.select().from(intradayValidations).where(and(eq(intradayValidations.id, id), eq(intradayValidations.ownerId, owner))).get(); }
  private trials(id: string) { return this.database.db.select().from(intradayValidationTrials).where(eq(intradayValidationTrials.validationId, id)).orderBy(asc(intradayValidationTrials.fold), asc(intradayValidationTrials.role), asc(intradayValidationTrials.candidate)).all(); }
  preview(owner: string, sourceId: string, raw: unknown) {
    const source = this.runs.getRunRequest(owner, sourceId);
    if (source.status !== "COMPLETED") throw new IntradayError("완료된 백테스트에서 검증을 시작할 수 있습니다.");
    const config = periodValidationConfigSchema.parse(raw);
    const plan = buildPeriodValidationPlan(source.request, config);
    return { source: source.request, config, plan };
  }
  async create(owner: string, sourceId: string, raw: unknown): Promise<PeriodValidationDto> {
    const { source, config, plan } = this.preview(owner, sourceId, raw);
    const revision = await this.runs.storedRevision(source);
    const versions = readRuntimeVersions(), id = randomUUID();
    this.database.sqlite.transaction(() => {
      if (this.runs.getRunState(owner, sourceId).status !== "COMPLETED") throw new IntradayError("원본 상태가 변경되었습니다.");
      const active = this.database.db.select({ id: intradayValidations.id }).from(intradayValidations).where(inArray(intradayValidations.status, ["ACTIVE", "CANCELLING"])).all();
      if (active.length >= 5) throw new IntradayError("진행 중인 검증 실험은 최대 5개입니다.");
      this.database.db.insert(intradayValidations).values({ id, ownerId: owner, sourceJobId: sourceId, requestJson: JSON.stringify(source), configJson: JSON.stringify(config), planJson: JSON.stringify(plan), executionVersion: versions.executionVersion, validationVersion: versions.validationVersion, strategyVersion: getIntradayStrategy(source.strategyId).version, dataRevision: revision, status: "ACTIVE", createdAtMs: Date.now() }).run();
      for (const fold of plan.folds) {
        for (const [candidate, parameters] of plan.candidates.entries()) this.database.db.insert(intradayValidationTrials).values({ id: randomUUID(), validationId: id, fold: fold.ordinal, role: "TRAIN", candidate, requestJson: JSON.stringify({ ...source, parameters, period: fold.train }) }).run();
        this.database.db.insert(intradayValidationTrials).values({ id: randomUUID(), validationId: id, fold: fold.ordinal, role: "OOS" }).run();
        if (getValidationOptimization(config)) this.database.db.insert(intradayValidationTrials).values({ id: randomUUID(), validationId: id, fold: fold.ordinal, role: "BASELINE", requestJson: JSON.stringify({ ...source, period: fold.test }) }).run();
      }
    }).immediate();
    void this.pump();
    return this.get(owner, id)!;
  }
  list(owner: string, sourceId: string): PeriodValidationDto[] {
    this.runs.getRunState(owner, sourceId);
    return this.database.db.select({ id: intradayValidations.id }).from(intradayValidations).where(and(eq(intradayValidations.ownerId, owner), eq(intradayValidations.sourceJobId, sourceId))).orderBy(asc(intradayValidations.createdAtMs)).all().map(({ id }) => this.get(owner, id)!);
  }
  get(owner: string, id: string): PeriodValidationDto | null {
    const row = this.row(owner, id); if (!row) return null;
    const source = JSON.parse(row.requestJson) as IntradayRequest, config = periodValidationConfigSchema.parse(JSON.parse(row.configJson)), plan = JSON.parse(row.planJson) as PeriodValidationPlan;
    const optimization = getValidationOptimization(config);
    return { id, sourceJobId: row.sourceJobId, status: row.status as ValidationStatus, config, plan, initialCash: source.initialCash, createdAtMs: row.createdAtMs, error: row.error, trials: this.trials(id).map((trial) => {
      const request = trial.requestJson ? JSON.parse(trial.requestJson) as IntradayRequest : null;
      const run = trial.runId ? this.runs.getRunState(owner, trial.runId) : null;
      const m = trial.metricsJson ? JSON.parse(trial.metricsJson) as ValidationMetrics : null;
      return { id: trial.id, fold: trial.fold, role: trial.role as ValidationRole, candidate: trial.candidate, period: request?.period ?? plan.folds[trial.fold]!.test, parameters: request?.parameters ?? null, jobId: trial.runId, status: trial.skipReason ? "NOT_EVALUATED" : run?.status ?? (row.status === "ACTIVE" ? "PENDING" : "SKIPPED"), progress: null, error: run?.error ?? null, metrics: m, skipReason: trial.skipReason as ValidationSkipReason | null, selection: trial.role === "TRAIN" && m && optimization ? evaluateValidationCandidate(m, optimization) : null };
    }) };
  }
  cancel(owner: string, id: string): PeriodValidationDto | null {
    const row = this.row(owner, id); if (!row) return null;
    if (row.status === "ACTIVE") this.database.db.update(intradayValidations).set({ status: "CANCELLING" }).where(eq(intradayValidations.id, id)).run();
    void this.pump(); return this.get(owner, id);
  }
  dailyReport(owner: string, id: string, trialId: string) {
    if (!this.row(owner, id)) throw new IntradayError("검증 실험을 찾을 수 없습니다.", 404);
    const trial = this.database.db.select().from(intradayValidationTrials).where(and(eq(intradayValidationTrials.id, trialId), eq(intradayValidationTrials.validationId, id))).get();
    if (!trial) throw new IntradayError("검증 구간을 찾을 수 없습니다.", 404);
    // 목록 응답에는 요약만 싣고 선택한 구간의 일별 자료를 요청할 때만 결과를 읽는다.
    if (!trial.runId) return null;
    const run = this.runs.getRun(owner, trial.runId);
    return run.status === "COMPLETED" ? run.result?.dailyEvaluation ?? null : null;
  }
  delete(owner: string, id: string): boolean {
    const row = this.row(owner, id); if (!row) return false;
    const trials = this.trials(id);
    if (["ACTIVE", "CANCELLING"].includes(row.status) || trials.some(t => t.runId && this.runs.isDraining(t.runId))) throw new IntradayError("종료된 검증 실험만 삭제할 수 있습니다.");
    this.database.sqlite.transaction(() => {
      const ids = trials.flatMap(t => t.runId ? [t.runId] : []);
      if (ids.length && this.database.db.select({ id: intradayValidations.id }).from(intradayValidations).where(inArray(intradayValidations.sourceJobId, ids)).get()) throw new IntradayError("하위 결과를 참조하는 검증이 있습니다.");
      this.database.db.delete(intradayValidationTrials).where(eq(intradayValidationTrials.validationId, id)).run();
      if (ids.length) this.database.db.delete(intradayRuns).where(and(eq(intradayRuns.ownerId, owner), inArray(intradayRuns.id, ids))).run();
      this.database.db.delete(intradayValidations).where(eq(intradayValidations.id, id)).run();
    }).immediate(); return true;
  }
  pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.pumping) this.pumping = this.tick().finally(() => { this.pumping = null; });
    return this.pumping;
  }
  async stop() { this.stopping = true; await this.pumping; }
  private async tick() {
    const rows = this.database.db.select().from(intradayValidations).where(inArray(intradayValidations.status, ["ACTIVE", "CANCELLING"])).orderBy(asc(intradayValidations.createdAtMs)).all();
    for (const row of rows.filter(r => r.status === "CANCELLING")) this.drain(row);
    const row = rows.find(r => r.status === "ACTIVE"); if (!row || this.stopping) return;
    try { await this.advance(row); } catch (error) {
      if (this.row(row.ownerId, row.id)?.status !== "ACTIVE") return;
      if (error instanceof IntradayError && error.statusCode === 429) return;
      this.database.db.update(intradayValidations).set({ status: "CANCELLING", error: error instanceof Error ? error.message : String(error) }).where(eq(intradayValidations.id, row.id)).run();
      this.drain(this.row(row.ownerId, row.id)!);
    }
  }
  private settleMetrics(owner: string, trial: typeof intradayValidationTrials.$inferSelect): void {
    if (trial.metricsJson || !trial.runId) return;
    const result = this.runs.getRun(owner, trial.runId).result;
    if (!result) throw new Error("하위 실행의 성과가 없습니다.");
    trial.metricsJson = JSON.stringify(metrics(result));
    this.database.db.update(intradayValidationTrials).set({ metricsJson: trial.metricsJson }).where(eq(intradayValidationTrials.id, trial.id)).run();
  }
  private drain(row: Row) {
    let pending = false;
    for (const trial of this.trials(row.id)) if (trial.runId) {
      const run = this.runs.getRunState(row.ownerId, trial.runId);
      if (run.status === "COMPLETED") {
        try { this.settleMetrics(row.ownerId, trial); } catch { /* 취소 작업의 정리를 계속한다. */ }
      }
      if (["QUEUED", "PREPARING", "RUNNING"].includes(run.status)) this.runs.cancelRun(row.ownerId, trial.runId);
      if (this.runs.isDraining(trial.runId)) pending = true;
    }
    if (!pending) this.database.db.update(intradayValidations).set({ status: row.error ? "FAILED" : "CANCELLED", completedAtMs: Date.now() }).where(and(eq(intradayValidations.id, row.id), eq(intradayValidations.status, "CANCELLING"))).run();
  }
  private async advance(row: Row) {
    const source = intradayRequestSchema.parse(JSON.parse(row.requestJson));
    const versions = readRuntimeVersions();
    if (versions.executionVersion !== row.executionVersion || versions.validationVersion !== row.validationVersion || getIntradayStrategy(source.strategyId).version !== row.strategyVersion) throw new Error("검증 중 실행 버전이 변경되었습니다.");
    if (await this.runs.currentStoredRevision(source) !== row.dataRevision) throw new Error("검증 중 분봉 데이터가 변경되었습니다.");
    if (this.stopping || this.row(row.ownerId, row.id)?.status !== "ACTIVE") return;
    const config = periodValidationConfigSchema.parse(JSON.parse(row.configJson)), plan = JSON.parse(row.planJson) as PeriodValidationPlan;
    const trials = this.trials(row.id);
    if (trials.some(t => t.runId && (["QUEUED", "PREPARING", "RUNNING"].includes(this.runs.getRunState(row.ownerId, t.runId).status) || this.runs.isDraining(t.runId)))) return;
    for (const fold of plan.folds) {
      const group = trials.filter(t => t.fold === fold.ordinal), train = group.filter(t => t.role === "TRAIN"), oos = group.find(t => t.role === "OOS")!;
      for (const trial of group) if (trial.runId) {
        const run = this.runs.getRunState(row.ownerId, trial.runId);
        if (["FAILED", "CANCELLED"].includes(run.status)) throw new Error(run.error ?? "하위 실행에 실패했습니다.");
        if (run.status === "COMPLETED") this.settleMetrics(row.ownerId, trial);
      }
      const ready = (t: typeof oos) => t.runId && t.metricsJson && this.runs.getRunState(row.ownerId, t.runId).status === "COMPLETED";
      if (!train.every(ready)) { this.launch(row, train.find(t => !t.runId)); return; }
      if (!oos.requestJson && !oos.skipReason) {
        const optimization = getValidationOptimization(config);
        const selected = !optimization ? 0 : selectValidationCandidate(train.map(t => ({ candidate: t.candidate!, metrics: JSON.parse(t.metricsJson!) as ValidationMetrics })), optimization);
        this.database.db.update(intradayValidationTrials).set({ candidate: selected, skipReason: selected === null ? "NO_ELIGIBLE_CANDIDATE" : null, requestJson: selected === null ? null : JSON.stringify({ ...source, parameters: plan.candidates[selected], period: fold.test }) }).where(eq(intradayValidationTrials.id, oos.id)).run();
        return;
      }
      const evaluation = group.filter(t => t.role !== "TRAIN" && !t.skipReason);
      if (!evaluation.every(ready)) { this.launch(row, evaluation.find(t => !t.runId)); return; }
    }
    this.database.db.update(intradayValidations).set({ status: "COMPLETED", completedAtMs: Date.now() }).where(and(eq(intradayValidations.id, row.id), eq(intradayValidations.status, "ACTIVE"))).run();
  }
  private launch(row: Row, trial: typeof intradayValidationTrials.$inferSelect | undefined) {
    if (!trial || !trial.requestJson || this.stopping) return;
    const request = intradayRequestSchema.parse(JSON.parse(trial.requestJson)), id = randomUUID();
    this.database.sqlite.transaction(() => {
      if (this.row(row.ownerId, row.id)?.status !== "ACTIVE") return;
      const current = this.database.db.select().from(intradayValidationTrials).where(eq(intradayValidationTrials.id, trial.id)).get();
      if (!current || current.runId) return;
      this.runs.createInternalRun(row.ownerId, request, id);
      this.database.db.update(intradayValidationTrials).set({ runId: id }).where(eq(intradayValidationTrials.id, trial.id)).run();
    }).immediate();
    if (this.database.db.select().from(intradayValidationTrials).where(eq(intradayValidationTrials.runId, id)).get()) this.runs.startInternalRun(row.ownerId, id, request);
  }
}
