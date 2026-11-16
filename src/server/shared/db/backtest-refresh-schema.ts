import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { backtestJobs, backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";
import { users } from "./auth-schema.js";

/** 확인한 요청과 후속 실행을 함께 보관해 창 종료·재부팅 후에도 한 번만 제출한다. */
export const backtestRefreshJobs = sqliteTable("backtest_refresh_jobs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  sourceJobId: text("source_job_id").notNull().references(() => backtestJobs.id, { onDelete: "cascade" }),
  actionJson: text("action_json").notNull(),
  requestJson: text("request_json").notNull(),
  warningsJson: text("warnings_json").notNull(),
  runtimeIdentity: text("runtime_identity").notNull(),
  status: text("status").notNull(),
  preparationJobId: text("preparation_job_id").references(() => backtestPreparationJobs.id, { onDelete: "restrict" }),
  resultHref: text("result_href"),
  error: text("error"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  completedAtMs: integer("completed_at_ms"),
  notifiedAtMs: integer("notified_at_ms"),
}, table => [
  uniqueIndex("idx_backtest_refresh_request").on(table.ownerId, table.requestId),
  index("idx_backtest_refresh_active").on(table.status, table.createdAtMs),
  index("idx_backtest_refresh_preparation").on(table.preparationJobId),
]);
