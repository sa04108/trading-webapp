import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema.js";

/** 원본 작업·결과를 지우지 않고 사용자별 작업 목록에서만 숨긴다. */
export const jobDismissals = sqliteTable("job_dismissals", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jobId: text("job_id").notNull(),
  finishedAtMs: integer("finished_at_ms").notNull(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.jobId] }),
  index("idx_job_dismissals_finished").on(t.finishedAtMs),
]);

/** 메모리 수집과 원본 정리가 가능한 준비 작업의 작은 상태 이력. */
export const backgroundJobHistory = sqliteTable("background_job_history", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
  snapshotJson: text("snapshot_json").notNull(),
}, (t) => [index("idx_background_jobs_finished").on(t.finishedAtMs)]);
