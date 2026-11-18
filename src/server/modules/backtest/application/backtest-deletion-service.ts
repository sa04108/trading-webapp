import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../../../../runtime/shared/db/database.js";
import type { BacktestDeletionPreview } from "../../../../shared/schemas/backtest-deletion.js";

type Mode = "daily" | "intraday";
type Row = { id: string; status: string; ownerId?: string };
type Plan = { jobs: Set<string>; searches: Set<string>; validations: Set<string>; blockers: Set<string> };
const terminal = (status: string) => ["COMPLETED", "FAILED", "CANCELLED"].includes(status);
export class BacktestDeletionError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

/** 표시한 삭제 범위와 실제 정리 범위를 같은 그래프로 계산하고 한 트랜잭션으로 지운다. */
export class BacktestDeletionService {
  constructor(private readonly db: AppDatabase, private readonly hooks: {
    isIntradayDraining?: (id: string) => boolean;
    beforeDeleteDaily?: (ids: string[]) => void;
    collectPreparations?: () => void;
  } = {}) {}

  preview(owner: string, mode: Mode, ids: string[]): BacktestDeletionPreview {
    return this.db.transaction(() => this.summary(owner, mode, ids, this.plan(owner, mode, ids)));
  }

  delete(owner: string, mode: Mode, ids: string[], token?: string): BacktestDeletionPreview {
    return this.db.transaction(() => {
      const plan = this.plan(owner, mode, ids), summary = this.summary(owner, mode, ids, plan);
      if (token !== undefined && token !== summary.token) throw new BacktestDeletionError("연결된 기록이 변경되었습니다. 삭제 내용을 다시 확인하세요.");
      if (summary.blockers.length) throw new BacktestDeletionError(summary.blockers.join(" "));
      // 모든 소유권·실행 상태를 검증한 다음 참조를 먼저 끊는다. 실패하면 전체를 롤백한다.
      if (mode === "daily") this.hooks.beforeDeleteDaily?.([...plan.jobs]);
      this.remove("configuration_searches", plan.searches);
      this.remove(mode === "daily" ? "backtest_validations" : "intraday_validations", plan.validations);
      this.remove(mode === "daily" ? "backtest_jobs" : "intraday_runs", plan.jobs);
      if (mode === "daily") this.hooks.collectPreparations?.();
      return summary;
    }, { behavior: "immediate" });
  }

  private remove(table: string, ids: Set<string>): void {
    const statement = sql`DELETE FROM ${sql.identifier(table)} WHERE id = `;
    for (const id of ids) this.db.run(sql`${statement}${id}`);
  }

  private summary(owner: string, mode: Mode, ids: string[], plan: Plan): BacktestDeletionPreview {
    const sorted = (values: Iterable<string>) => [...values].sort();
    return {
      backtestCount: plan.jobs.size,
      configurationSearchCount: plan.searches.size,
      periodValidationCount: plan.validations.size,
      blockers: [...plan.blockers],
      token: createHash("sha256").update(JSON.stringify([owner, mode, sorted(new Set(ids)), sorted(plan.jobs), sorted(plan.searches), sorted(plan.validations)])).digest("hex"),
    };
  }

  private plan(owner: string, mode: Mode, ids: string[]): Plan {
    const plan: Plan = { jobs: new Set(), searches: new Set(), validations: new Set(), blockers: new Set() };
    const pending = [...new Set(ids)];
    const jobTable = sql.identifier(mode === "daily" ? "backtest_jobs" : "intraday_runs");
    const validations = sql.identifier(mode === "daily" ? "backtest_validations" : "intraday_validations");
    const trials = sql.identifier(mode === "daily" ? "backtest_validation_trials" : "intraday_validation_trials");
    const childColumn = sql.identifier(mode === "daily" ? "job_id" : "run_id");
    const owned = (row: Row | undefined) => {
      if (!row || (row.ownerId !== undefined && row.ownerId !== owner)) throw new BacktestDeletionError("삭제할 백테스트 또는 연결된 기록을 찾을 수 없습니다.", 404);
      return row;
    };
    const readJob = (id: string) => this.db.get<Row>(sql`SELECT id, status ${mode === "intraday" ? sql`, owner_id AS ownerId` : sql``} FROM ${jobTable} WHERE id=${id}`);
    // 선택된 루트는 모두 존재해야 한다. 이미 삭제된 옛 실험 자식은 참조만 정리한다.
    for (const id of pending) owned(readJob(id));
    const addChildren = (query: SQL) => {
      for (const child of this.db.all<{ id: string | null }>(query)) if (child.id) pending.push(child.id);
    };
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const id = pending[cursor]!;
      if (plan.jobs.has(id)) continue;
      const job = readJob(id);
      if (!job) continue;
      owned(job); plan.jobs.add(id);
      if (!(terminal(job.status) || (mode === "daily" && job.status === "INTERRUPTED")) || (mode === "intraday" && this.hooks.isIntradayDraining?.(id))) plan.blockers.add("실행 중이거나 정리 중인 백테스트가 있습니다. 실행이 종료된 뒤 삭제할 수 있습니다.");
      if (mode === "daily" && this.db.get(sql`SELECT 1 FROM backtest_refresh_jobs WHERE source_job_id=${id} AND status IN ('QUEUED','PREPARING','SUBMITTING') LIMIT 1`)) plan.blockers.add("데이터 업데이트 후 실행 작업이 진행 중입니다. 해당 작업이 종료된 뒤 삭제할 수 있습니다.");

      // 자식 결과를 직접 삭제할 때에도 그 결과를 소유한 실험과 형제 결과를 명시적으로 포함한다.
      const searches = this.db.all<Row>(sql`SELECT id, status, owner_id AS ownerId FROM configuration_searches WHERE mode=${mode} AND (source_job_id=${id} OR id IN (SELECT search_id FROM configuration_search_items WHERE job_id=${id}))`);
      for (const row of searches) {
        if (plan.searches.has(row.id)) continue;
        owned(row); plan.searches.add(row.id);
        if (row.status !== "PREVIEW" && !terminal(row.status)) plan.blockers.add("진행 중인 설정 탐색 실험이 있습니다. 실험이 종료된 뒤 삭제할 수 있습니다.");
        addChildren(sql`SELECT job_id AS id FROM configuration_search_items WHERE search_id=${row.id}`);
      }
      for (const row of this.db.all<Row>(sql`SELECT id, status ${mode === "intraday" ? sql`, owner_id AS ownerId` : sql``} FROM ${validations} WHERE source_job_id=${id} OR id IN (SELECT validation_id FROM ${trials} WHERE ${childColumn}=${id})`)) {
        if (plan.validations.has(row.id)) continue;
        owned(row); plan.validations.add(row.id);
        if (!terminal(row.status)) plan.blockers.add("진행 중인 기간검증이 있습니다. 검증이 종료된 뒤 삭제할 수 있습니다.");
        addChildren(sql`SELECT ${childColumn} AS id FROM ${trials} WHERE validation_id=${row.id}`);
      }
    }
    return plan;
  }
}
