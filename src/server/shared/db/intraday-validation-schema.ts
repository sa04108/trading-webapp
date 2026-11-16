import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { intradayRuns } from "./intraday-schema.js";

export const intradayValidations = sqliteTable("intraday_validations", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  sourceJobId: text("source_job_id").notNull().references(() => intradayRuns.id, { onDelete: "restrict" }),
  requestJson: text("request_json").notNull(), configJson: text("config_json").notNull(), planJson: text("plan_json").notNull(),
  executionVersion: text("execution_version").notNull(), validationVersion: text("validation_version").notNull(),
  strategyVersion: text("strategy_version").notNull(), dataRevision: text("data_revision").notNull(),
  status: text("status").notNull(), error: text("error"), createdAtMs: integer("created_at_ms").notNull(), completedAtMs: integer("completed_at_ms"),
}, (t) => [index("intraday_validation_source").on(t.ownerId, t.sourceJobId)]);
export const intradayValidationTrials = sqliteTable("intraday_validation_trials", {
  id: text("id").primaryKey(), validationId: text("validation_id").notNull().references(() => intradayValidations.id, { onDelete: "cascade" }),
  fold: integer("fold").notNull(), role: text("role").notNull(), candidate: integer("candidate"), requestJson: text("request_json"),
  metricsJson: text("metrics_json"), runId: text("run_id").unique().references(() => intradayRuns.id, { onDelete: "restrict" }), skipReason: text("skip_reason"),
}, (t) => [index("intraday_trial_parent").on(t.validationId, t.fold)]);
