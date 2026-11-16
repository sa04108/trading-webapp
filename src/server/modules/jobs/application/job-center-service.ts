import type { Container } from "../../../bootstrap/container.js";
import type { PeriodValidationService } from "../../backtest/application/period-validation-service.js";
import type { JobFilter, JobItem, JobKind, JobsResponse, JobStatus } from "../../../../shared/schemas/jobs.js";
import { isFinishedJob } from "../../../../shared/schemas/jobs.js";
import { INTRADAY_STRATEGIES } from "../../../../shared/schemas/intraday-strategies.js";
import { executionJobProgress, jobPhase, jobProgress } from "./job-progress.js";
import type { BacktestRefreshService } from "../../backtest/application/backtest-refresh-service.js";
import { backtestRefreshActionLabel } from "../../../../shared/schemas/backtest-refresh.js";

const active = "('QUEUED', 'RUNNING', 'WAITING', 'CANCELLING')";
const terminal = "('COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')";
const normalizedStatus = `CASE WHEN status IN ${terminal} THEN status
  WHEN status IN ('WAITING_DATA','WAITING_DAILY_QUOTA') THEN 'WAITING'
  WHEN status='CANCELLING' THEN 'CANCELLING' WHEN status='QUEUED' THEN 'QUEUED' ELSE 'RUNNING' END`;
const intradayStatus = `CASE WHEN status='CANCELLED' AND id IN (SELECT value FROM json_each(@draining))
  THEN 'CANCELLING' ELSE ${normalizedStatus} END`;
const preparationStatus = `CASE WHEN cancel_requested=1 AND status NOT IN ${terminal}
  THEN 'CANCELLING' ELSE ${normalizedStatus} END`;

interface Source {
  kind: JobKind;
  table: string;
  status?: string;
  updated: string;
  finished: string;
  where?: string;
}

const sources: Source[] = [
  { kind: "backtest-wizard", table: "backtest_wizard_jobs", status: "status", updated: "updated_at_ms", finished: "finished_at_ms", where: "owner_id=@owner" },
  { kind: "backtest-refresh", table: "backtest_refresh_jobs", updated: "updated_at_ms", finished: "completed_at_ms", where: "owner_id=@owner" },
  { kind: "backtest", table: "backtest_jobs", updated: "coalesce(completed_at_ms, last_received_at_ms, last_progress_at_ms, started_at_ms, created_at_ms)", finished: "coalesce(completed_at_ms, created_at_ms)", where: "clone_batch_id IS NULL AND NOT EXISTS (SELECT 1 FROM backtest_validation_trials t WHERE t.job_id=backtest_jobs.id) AND NOT EXISTS (SELECT 1 FROM backtest_wizard_children w JOIN backtest_wizard_jobs parent ON parent.id=w.wizard_id WHERE parent.owner_id=@owner AND w.kind='backtest' AND w.job_id=backtest_jobs.id)" },
  { kind: "preparation", table: "backtest_preparation_jobs", status: preparationStatus, updated: "updated_at_ms", finished: "coalesce(completed_at_ms, updated_at_ms)", where: "(NOT EXISTS (SELECT 1 FROM backtest_wizard_children w JOIN backtest_wizard_jobs parent ON parent.id=w.wizard_id WHERE parent.owner_id=@owner AND w.kind='preparation' AND w.job_id=backtest_preparation_jobs.id) OR EXISTS (SELECT 1 FROM preparation_wizard_references r WHERE r.preparation_job_id=backtest_preparation_jobs.id AND r.user_id=@owner AND r.context NOT IN (SELECT id FROM backtest_wizard_jobs)))" },
  { kind: "clone-batch", table: "backtest_clone_batches", updated: "coalesce(completed_at_ms, created_at_ms)", finished: "coalesce(completed_at_ms, created_at_ms)" },
  { kind: "validation", table: "backtest_validations", updated: "coalesce(completed_at_ms, created_at_ms)", finished: "coalesce(completed_at_ms, created_at_ms)" },
  { kind: "intraday-backtest", table: "intraday_runs", status: intradayStatus, updated: "updated_at_ms", finished: "updated_at_ms", where: "owner_id=@owner" },
  { kind: "intraday-collection", table: "intraday_collections", status: intradayStatus, updated: "updated_at_ms", finished: "updated_at_ms", where: "owner_id=@owner AND parent_run_id IS NULL" },
];

// 목록 조회는 큰 요청·결과 JSON을 읽지 않고, 실제 표시할 페이지의 상태만 보완한다.
const jobsCte = `WITH jobs AS (${sources.map((source) => {
  const status = source.status ?? normalizedStatus;
  return `SELECT '${source.kind}:' || id AS id, '${source.kind}' AS kind, id AS sourceId,
    ${status} AS status, created_at_ms AS createdAtMs, ${source.updated} AS updatedAtMs,
    CASE WHEN (${status}) IN ${terminal} THEN ${source.finished} ELSE NULL END AS finishedAtMs
    FROM ${source.table}${source.where ? ` WHERE ${source.where}` : ""}`;
}).join(" UNION ALL ")}
  UNION ALL SELECT id, substr(id, 1, instr(id, ':')-1), id, status, created_at_ms, updated_at_ms, finished_at_ms
  FROM background_job_history h WHERE NOT EXISTS (SELECT 1 FROM backtest_wizard_children w JOIN backtest_wizard_jobs parent ON parent.id=w.wizard_id WHERE parent.owner_id=@owner AND h.id=w.kind || ':' || w.job_id AND NOT (w.kind='preparation' AND EXISTS (SELECT 1 FROM preparation_wizard_references r WHERE r.preparation_job_id=w.job_id AND r.user_id=@owner AND r.context NOT IN (SELECT id FROM backtest_wizard_jobs))))), visible AS (
  SELECT * FROM jobs j WHERE (status IN ${active} OR @cutoff=0 OR finishedAtMs>=@cutoff)
    AND (status IN ${active} OR NOT EXISTS (SELECT 1 FROM job_dismissals d
      WHERE d.user_id=@owner AND d.job_id=j.id AND d.finished_at_ms=j.finishedAtMs)))`;
const filterSql = `(@filter='all' OR (@filter='active' AND status IN ${active}) OR (@filter='finished' AND status IN ${terminal}))`;

interface Metadata {
  id: string;
  sourceId: string;
  kind: JobKind;
  status: JobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs: number | null;
}

export class JobCenterError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class JobCenterService {
  constructor(private readonly container: Container, private readonly validations: PeriodValidationService, private readonly refreshJobs: BacktestRefreshService) {}

  private bindings(owner: string) {
    const days = this.container.config.notificationRetentionDays;
    return { owner, cutoff: days > 0 ? this.container.clock.now() - days * 86_400_000 : 0, draining: JSON.stringify(this.container.intradayService.pendingCancellationIds()) };
  }

  list(owner: string, filter: JobFilter, limit: number, requestedOffset: number): JobsResponse {
    this.container.backtestWizardService.sync(owner);
    const db = this.container.database.sqlite;
    const bindings = { ...this.bindings(owner), filter };
    const counts = db.prepare(`${jobsCte} SELECT coalesce(sum(CASE WHEN ${filterSql} THEN 1 ELSE 0 END),0) AS total,
      coalesce(sum(CASE WHEN status IN ${active} THEN 1 ELSE 0 END),0) AS activeCount FROM visible`).get(bindings) as { total: number; activeCount: number };
    const offset = Math.min(requestedOffset, Math.max(0, Math.floor((counts.total - 1) / limit) * limit));
    const rows = db.prepare(`${jobsCte} SELECT * FROM visible WHERE ${filterSql}
      ORDER BY CASE WHEN status IN ${active} THEN 0 ELSE 1 END, coalesce(finishedAtMs,createdAtMs) DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...bindings, limit, offset }) as Metadata[];
    const jobs = rows.map((row) => {
      const job = this.hydrate(owner, row, false);
      return { ...job, description: job.description?.slice(0, 500) ?? null, error: job.error?.slice(0, 500) ?? null };
    });
    return { jobs, ...counts, retentionDays: this.container.config.notificationRetentionDays, limit, offset };
  }

  private metadata(owner: string, id: string, includeDismissed = false): Metadata | null {
    this.container.backtestWizardService.sync(owner);
    const rows = includeDismissed ? "jobs" : "visible";
    return this.container.database.sqlite.prepare(`${jobsCte} SELECT * FROM ${rows} WHERE id=@id`).get({ ...this.bindings(owner), id }) as Metadata | undefined ?? null;
  }

  get(owner: string, id: string): JobItem {
    const row = this.metadata(owner, id);
    if (!row) throw new JobCenterError("작업 이력을 찾을 수 없습니다.", 404);
    return this.hydrate(owner, row, true);
  }

  private sharedPreparation(owner: string, id: string): boolean {
    return Boolean(this.container.database.sqlite.prepare(`SELECT 1 FROM preparation_wizard_references WHERE preparation_job_id=@id AND (user_id<>@owner OR context IN (SELECT id FROM backtest_wizard_jobs))
      UNION ALL SELECT 1 FROM backtest_jobs WHERE preparation_job_id=@id AND status NOT IN ${terminal}
      UNION ALL SELECT 1 FROM backtest_clone_batches WHERE preparation_job_id=@id AND status IN ('ACTIVE','CANCELLING')
      UNION ALL SELECT 1 FROM backtest_refresh_jobs WHERE preparation_job_id=@id AND status IN ('QUEUED','PREPARING','SUBMITTING')
      UNION ALL SELECT 1 FROM backtest_validation_trials t JOIN backtest_validations v ON v.id=t.validation_id
        WHERE t.preparation_job_id=@id AND v.status IN ('ACTIVE','CANCELLING') LIMIT 1`).get({ id, owner }));
  }

  private hydrate(owner: string, row: Metadata, detail: boolean): JobItem {
    const db = this.container.database.sqlite;
    let job: JobItem = { id: row.id, kind: row.kind, status: row.status, title: "작업", phase: jobPhase(row.status), description: null, progress: null, error: null,
      createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, finishedAtMs: row.finishedAtMs, cancellable: !isFinishedJob(row.status) && row.status !== "CANCELLING", link: null };
    const strategyName = (id: string) => this.container.strategyRegistry.describe(id)?.name ?? INTRADAY_STRATEGIES.find((strategy) => strategy.id === id)?.name ?? id;
    const period = (from: string | null, to: string | null) => from && to ? `${from} ~ ${to}` : null;
    switch (row.kind) {
      case "backtest-wizard": {
        const wizard = this.container.backtestWizardService.get(owner, row.sourceId);
        const strategy = this.container.backtestWizardDraftService.get(owner, row.sourceId, "strategy")?.payload.strategyId
          ?? wizard.preparationInput?.strategyId;
        const dates = this.container.backtestWizardDraftService.get(owner, row.sourceId, "period")?.payload
          ?? wizard.preparationInput?.period;
        job = { ...job, title: `${strategy ? `${strategyName(strategy)} · ` : ""}백테스트 위저드`, phase: wizard.phase,
          error: wizard.error, description: dates ? period(dates.from, dates.to) : null, link: wizard.link };
        if (wizard.backtestJobId && !isFinishedJob(wizard.status)) {
          const child = this.container.jobQueue.getJob(wizard.backtestJobId);
          if (child && !this.container.jobQueue.isTerminal(child.status)) {
            const progress = this.container.agentCoordinator.backtestProgress(child);
            if (progress) job = { ...job, phase: jobPhase(progress.activity), progress: executionJobProgress(progress) };
          }
        } else if (wizard.preparationJobId && !isFinishedJob(wizard.status)) {
          const child = this.container.backtestPreparationOrchestrator.get(wizard.preparationJobId);
          if (child && !this.container.backtestPreparationOrchestrator.isTerminal(child.status)) {
            const progress = this.container.agentCoordinator.preparationView(child).progress;
            job = { ...job, progress: progress ? executionJobProgress(progress) : jobProgress(child.doneSymbols, child.totalSymbols, "종목") };
          }
        }
        break;
      }
      case "backtest-refresh": {
        const refresh = this.refreshJobs.get(owner, row.sourceId);
        const preparation = refresh.preparationJobId ? this.container.backtestPreparationOrchestrator.get(refresh.preparationJobId) : null;
        job = { ...job, title: `${backtestRefreshActionLabel(refresh.action)} · 데이터 업데이트`, phase: refresh.message,
          error: refresh.error, description: "최신 데이터로 준비한 뒤 요청한 작업을 자동으로 실행합니다.",
          progress: preparation ? jobProgress(preparation.doneSymbols, preparation.totalSymbols, "종목") : null,
          link: refresh.resultHref ?? `/backtests/${encodeURIComponent(refresh.sourceJobId)}?refreshJob=${encodeURIComponent(refresh.id)}` };
        break;
      }
      case "benchmark": case "symbol-master": {
        const saved = db.prepare("SELECT snapshot_json FROM background_job_history WHERE id=?").get(row.id) as { snapshot_json: string };
        const snapshot = JSON.parse(saved.snapshot_json) as JobItem;
        return { ...snapshot, link: snapshot.link ?? `/jobs/${encodeURIComponent(row.id)}` };
      }
      case "backtest": {
        const data = db.prepare(`SELECT id, status, strategy_id AS strategyId, execution_activity AS activity, progress_bars AS current,
          total_bars AS total, progress_label AS label, result_transfer_bytes AS transfer, result_transfer_total_bytes AS transferTotal,
          agent_id AS agentId, last_progress_at_ms AS lastProgressAtMs, created_at_ms AS createdAtMs,
          estimated_bars AS estimatedBars, attempt, lease_failures AS leaseFailures, error,
          json_extract(request_json,'$.period.from') AS dateFrom, json_extract(request_json,'$.period.to') AS dateTo
          FROM backtest_jobs WHERE id=?`).get(row.sourceId) as {
            id: string; status: string; strategyId: string; activity: string | null; current: number | null; total: number | null; label: string | null;
            transfer: number | null; transferTotal: number | null; agentId: string | null; lastProgressAtMs: number | null;
            createdAtMs: number; estimatedBars: number; attempt: number; leaseFailures: number; error: string | null; dateFrom: string; dateTo: string;
          };
        const activity = data.agentId && data.lastProgressAtMs === null && row.status === "RUNNING" ? "STARTING_WORKER" : data.activity;
        const progress = activity === "UPLOADING_RESULT" ? jobProgress(data.transfer, data.transferTotal, "결과 전송 (바이트)")
          : row.status === "RUNNING" && (activity === "CALCULATING_BACKTEST" || activity === null) ? jobProgress(data.current, data.total, data.label) : null;
        job = { ...job, title: `${strategyName(data.strategyId)} · 일봉 백테스트`, description: period(data.dateFrom, data.dateTo), phase: jobPhase(activity ?? data.status), error: data.error, progress, link: `/backtests/${encodeURIComponent(row.sourceId)}` };
        if (detail && row.status === "QUEUED") {
          const progress = this.container.agentCoordinator.backtestProgress(data);
          if (progress) job = { ...job, phase: jobPhase(progress.activity), description: [job.description, progress.detail].filter(Boolean).join("\n"), progress: executionJobProgress(progress) };
        }
        break;
      }
      case "preparation": {
        const archive = db.prepare("SELECT snapshot_json FROM background_job_history WHERE id=?").get(row.id) as { snapshot_json: string } | undefined;
        if (archive) {
          const snapshot = JSON.parse(archive.snapshot_json) as JobItem;
          return { ...snapshot, link: snapshot.link ?? `/jobs/${encodeURIComponent(row.id)}` };
        }
        const data = db.prepare(`SELECT phase, done_symbols AS current, total_symbols AS total, error,
          json_extract(request_json,'$.strategyId') AS strategyId, json_extract(request_json,'$.period.from') AS dateFrom,
          json_extract(request_json,'$.period.to') AS dateTo FROM backtest_preparation_jobs WHERE id=?`).get(row.sourceId) as {
            phase: string; current: number; total: number; error: string | null; strategyId: string | null; dateFrom: string | null; dateTo: string | null;
          };
        const shared = job.cancellable && this.sharedPreparation(owner, row.sourceId);
        job = { ...job, title: `${data.strategyId ? `${strategyName(data.strategyId)} · ` : ""}유니버스 준비`, phase: jobPhase(data.phase),
          description: [period(data.dateFrom, data.dateTo), shared ? "진행 중인 다른 작업과 공유 중입니다. 연결된 백테스트·실험을 먼저 취소하세요." : null].filter(Boolean).join("\n") || null,
          error: data.error, progress: row.status === "RUNNING" && data.total > 0 ? jobProgress(data.current, data.total, "종목") : null, cancellable: job.cancellable && !shared, link: `/jobs/${encodeURIComponent(row.id)}` };
        if (detail && !isFinishedJob(row.status) && row.status !== "CANCELLING") {
          const source = this.container.backtestPreparationOrchestrator.get(row.sourceId);
          const progress = source ? this.container.agentCoordinator.preparationView(source).progress : null;
          if (progress) job = { ...job, phase: jobPhase(progress.activity), description: [job.description, progress.detail].filter(Boolean).join("\n") || null, progress: executionJobProgress(progress) };
        }
        break;
      }
      case "clone-batch": {
        const data = db.prepare("SELECT strategy_id AS strategyId, total_count AS total, error FROM backtest_clone_batches WHERE id=?").get(row.sourceId) as { strategyId: string; total: number; error: string | null };
        const counts = db.prepare(`SELECT count(*) AS done FROM backtest_clone_batch_items i LEFT JOIN backtest_jobs j ON j.id=i.job_id
          WHERE i.batch_id=? AND (i.state='CANCELLED' OR j.status IN ${terminal})`).get(row.sourceId) as { done: number };
        job = { ...job, title: `${strategyName(data.strategyId)} · 난수 시드 실험`, error: data.error, progress: jobProgress(counts.done, data.total, "백테스트"), link: `/backtests/batches/${encodeURIComponent(row.sourceId)}` };
        break;
      }
      case "validation": {
        const data = db.prepare(`SELECT phase, error,
          json_extract(request_json,'$.strategyId') AS strategyId, json_extract(plan_json,'$.totalRuns') AS total FROM backtest_validations WHERE id=?`).get(row.sourceId) as { phase: string; strategyId: string; total: number; error: string | null };
        const counts = db.prepare(`SELECT count(*) AS done,
          coalesce(sum(CASE WHEN t.skip_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS notEvaluated
          FROM backtest_validation_trials t LEFT JOIN backtest_jobs j ON j.id=t.job_id
          WHERE t.validation_id=? AND (t.skip_reason IS NOT NULL OR j.status IN ${terminal})`).get(row.sourceId) as { done: number; notEvaluated: number };
        job = { ...job, title: `${strategyName(data.strategyId)} · 기간 검증`, phase: jobPhase(data.phase), error: data.error,
          description: counts.notEvaluated ? `선택 가능한 IS 후보가 없어 선택 전략 OOS ${counts.notEvaluated}회 미평가` : null,
          progress: jobProgress(counts.done, data.total, "실행 처리 (미평가 포함)"), link: `/backtests/validations/${encodeURIComponent(row.sourceId)}` };
        break;
      }
      case "intraday-backtest": {
        const data = db.prepare(`SELECT json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.strategyId') AS strategyId, json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.symbol') AS symbol,
          json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.period.from') AS dateFrom, json_extract(CASE WHEN json_valid(request_json) THEN request_json ELSE '{}' END,'$.period.to') AS dateTo, status, error FROM intraday_runs WHERE id=? AND owner_id=?`).get(row.sourceId, owner) as { strategyId: string; symbol: string; dateFrom: string; dateTo: string; status: string; error: string | null };
        job = { ...job, title: `${strategyName(data.strategyId ?? "알 수 없는 전략")} · 분봉 백테스트`, description: `${data.symbol ?? "알 수 없는 종목"} · ${period(data.dateFrom, data.dateTo)}`, phase: jobPhase(data.status), error: data.error, link: `/backtests/intraday/${encodeURIComponent(row.sourceId)}` };
        if (data.status === "PREPARING") {
          const collection = db.prepare("SELECT fetched_bars AS bars, pages FROM intraday_collections WHERE parent_run_id=? AND owner_id=? ORDER BY created_at_ms DESC LIMIT 1").get(row.sourceId, owner) as { bars: number; pages: number } | undefined;
          if (collection) job = { ...job, progress: jobProgress(collection.bars, null, `${collection.pages}페이지 · ${collection.bars.toLocaleString("ko-KR")}봉 수집`) };
        }
        break;
      }
      case "intraday-collection": {
        const data = db.prepare(`SELECT symbol, json_extract(CASE WHEN json_valid(period_json) THEN period_json ELSE '{}' END,'$.from') AS dateFrom, json_extract(CASE WHEN json_valid(period_json) THEN period_json ELSE '{}' END,'$.to') AS dateTo,
          fetched_bars AS bars, pages, error FROM intraday_collections WHERE id=? AND owner_id=?`).get(row.sourceId, owner) as { symbol: string; dateFrom: string; dateTo: string; bars: number; pages: number; error: string | null };
        job = { ...job, title: `${data.symbol ?? "알 수 없는 종목"} · 분봉 수집`, description: period(data.dateFrom, data.dateTo), progress: jobProgress(data.bars, null, `${data.pages}페이지 · ${data.bars.toLocaleString("ko-KR")}봉 수집`), error: data.error, link: `/datasets/intraday?symbol=${encodeURIComponent(data.symbol ?? "")}` };
        break;
      }
    }
    if (row.status === "CANCELLING") job = { ...job, phase: "진행 중인 처리가 끝나면 취소됩니다", cancellable: false };
    return job;
  }

  cancel(owner: string, actor: string, id: string): JobItem {
    const row = this.metadata(owner, id);
    if (!row) throw new JobCenterError("작업 이력을 찾을 수 없습니다.", 404);
    const job = this.hydrate(owner, row, false);
    if (job.status === "CANCELLING") return job;
    if (!job.cancellable) throw new JobCenterError("이미 종료되었거나 다른 작업에서 사용 중인 작업은 취소할 수 없습니다.", 409);
    switch (row.kind) {
      case "backtest-wizard": this.container.backtestWizardService.cancel(owner, row.sourceId); break;
      case "backtest-refresh": this.refreshJobs.cancel(owner, row.sourceId); break;
      case "backtest": this.container.jobOrchestrator.cancel(row.sourceId); break;
      case "preparation": this.container.backtestPreparationOrchestrator.cancel(row.sourceId); break;
      case "clone-batch": {
        const batch = this.container.seedCloneBatchService.cancel(row.sourceId);
        for (const item of batch?.items ?? []) if (item.job && !this.container.jobQueue.isTerminal(item.job.status)) this.container.jobOrchestrator.cancel(item.job.id);
        break;
      }
      case "validation": this.validations.cancel(row.sourceId); break;
      case "intraday-backtest": this.container.intradayService.cancelRun(owner, row.sourceId); break;
      case "intraday-collection": this.container.intradayService.cancelCollection(owner, row.sourceId); break;
      case "benchmark": this.container.benchmarkService.cancelJob(row.id); break;
      case "symbol-master": this.container.symbolMasterBackfill.cancelJob(row.id); break;
    }
    this.container.auditLog.record(actor, "job.cancel-requested", { id });
    return this.get(owner, id);
  }

  remove(owner: string, actor: string, ids: readonly string[]): void {
    this.container.database.sqlite.transaction(() => {
      const rows = ids.map((id) => this.metadata(owner, id, true));
      if (rows.some((row) => !row)) throw new JobCenterError("작업 이력을 찾을 수 없습니다.", 404);
      if (rows.some((row) => !isFinishedJob(row!.status))) throw new JobCenterError("종료된 작업 이력만 삭제할 수 있습니다.", 409);
      const insert = this.container.database.sqlite.prepare(`INSERT INTO job_dismissals (user_id,job_id,finished_at_ms) VALUES (?,?,?)
        ON CONFLICT(user_id,job_id) DO UPDATE SET finished_at_ms=excluded.finished_at_ms`);
      for (const row of rows) insert.run(owner, row!.id, row!.finishedAtMs ?? row!.updatedAtMs);
      this.container.auditLog.record(actor, "job.history-dismissed", { ids });
    })();
  }
}
