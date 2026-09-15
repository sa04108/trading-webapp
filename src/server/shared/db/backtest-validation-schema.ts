import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";
import { backtestJobs } from "../../../runtime/shared/db/operations-schema.js";

/** 독립 평가 실험은 원본 설정과 선택 규칙을 고정하고 단계별 복구 위치를 보관한다. */
export const backtestValidations = sqliteTable(
  "backtest_validations",
  {
    id: text("id").primaryKey(),
    sourceJobId: text("source_job_id").notNull(),
    requestJson: text("request_json").notNull(),
    configJson: text("config_json").notNull(),
    planJson: text("plan_json").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    strategySourceHash: text("strategy_source_hash").notNull(),
    engineVersion: text("engine_version").notNull(),
    /** 과거 실험은 NULL로 보존하고 새 실행과의 호환성을 추정하지 않는다. */
    executionVersion: text("execution_version"),
    validationVersion: text("validation_version"),
    gitCommitSha: text("git_commit_sha").notNull(),
    status: text("status").notNull(),
    fold: integer("fold").notNull().default(0),
    phase: text("phase").notNull().default("PREPARING_TRAIN"),
    dataRevision: integer("data_revision"),
    error: text("error"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [index("idx_validation_source").on(table.sourceJobId)],
);

/** 준비 참조는 위저드와 분리하며, 작업 연결은 enqueue와 같은 트랜잭션에서 저장한다. */
export const backtestValidationTrials = sqliteTable(
  "backtest_validation_trials",
  {
    id: text("id").primaryKey(),
    validationId: text("validation_id")
      .notNull()
      .references(() => backtestValidations.id, { onDelete: "cascade" }),
    fold: integer("fold").notNull(),
    role: text("role").notNull(),
    candidate: integer("candidate"),
    requestJson: text("request_json"),
    preparationJobId: text("preparation_job_id").references(
      () => backtestPreparationJobs.id,
      { onDelete: "restrict" },
    ),
    jobId: text("job_id")
      .unique()
      .references(() => backtestJobs.id, { onDelete: "restrict" }),
  },
  (table) => [
    index("idx_validation_trial_parent").on(table.validationId, table.fold),
    index("idx_validation_trial_preparation").on(table.preparationJobId),
  ],
);
