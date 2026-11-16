import { and, eq } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { backtestWizardJobs } from "../../../shared/db/preparation-owner-schema.js";

export class BacktestWizardError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function requireWizard(database: DatabaseHandle, ownerId: string, id: string) {
  const row = database.db.select().from(backtestWizardJobs)
    .where(and(eq(backtestWizardJobs.id, id), eq(backtestWizardJobs.ownerId, ownerId))).get();
  if (!row) throw new BacktestWizardError("백테스트 위저드 작업을 찾을 수 없습니다.", 404);
  return row;
}

/** 취소·제출 직전에 보낸 자동 저장이나 중복 제출이 작업 상태를 되돌리지 못하게 한다. */
export function requireEditableWizard(database: DatabaseHandle, ownerId: string, id: string) {
  const row = requireWizard(database, ownerId, id);
  if (["COMPLETED", "CANCELLED"].includes(row.status))
    throw new BacktestWizardError("종료된 위저드는 수정할 수 없습니다.", 409);
  const job = row.backtestJobId
    ? database.sqlite.prepare("SELECT status FROM backtest_jobs WHERE id=?").get(row.backtestJobId) as { status: string } | undefined
    : null;
  if (job && !["FAILED", "CANCELLED", "INTERRUPTED"].includes(job.status))
    throw new BacktestWizardError("백테스트 실행 중이거나 결과가 완료된 위저드는 수정할 수 없습니다.", 409);
  return row;
}

/** 결과 삭제와 같은 트랜잭션에서 완료 증거를 부모에 남긴다. 완료 이벤트 누락도 복구한다. */
export function preserveCompletedWizards(database: DatabaseHandle, jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  database.sqlite.prepare(`UPDATE backtest_wizard_jobs AS w
    SET status='COMPLETED', finished_at_ms=coalesce(j.completed_at_ms,j.created_at_ms),
      updated_at_ms=max(w.updated_at_ms,coalesce(j.completed_at_ms,j.created_at_ms))
    FROM backtest_jobs j WHERE w.backtest_job_id=j.id AND j.status='COMPLETED'
      AND w.status NOT IN ('COMPLETED','CANCELLED') AND j.id IN (${jobIds.map(() => "?").join(",")})`)
    .run(...jobIds);
}
