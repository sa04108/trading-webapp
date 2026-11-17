import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema.js";
import { backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";

/** 각 위저드는 독립적으로 준비 결과를 소유한다. 동일 결과는 여러 위저드가 공유할 수 있다. */
export const preparationWizardReferences = sqliteTable(
  "preparation_wizard_references",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    context: text("context").notNull(),
    preparationJobId: text("preparation_job_id")
      .notNull()
      .references(() => backtestPreparationJobs.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.context] }),
    index("idx_preparation_wizard_job").on(table.preparationJobId),
  ],
);

/** 작성·자료 준비·실행을 하나로 관찰하는 영속 위저드. 계산 작업 자체는 기존 큐가 실행한다. */
export const backtestWizardJobs = sqliteTable("backtest_wizard_jobs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceJobId: text("source_job_id"),
  currentStep: text("current_step").notNull().default("strategy"),
  status: text("status").notNull().default("WAITING"),
  backtestJobId: text("backtest_job_id"),
  runtimeVersionsJson: text("runtime_versions_json"),
  recoveryMessage: text("recovery_message"),
  recoveryError: text("recovery_error"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
}, (table) => [index("idx_backtest_wizard_owner_status").on(table.ownerId, table.status)]);

/** 재시도한 자식까지 묶고, 같은 준비 작업을 공유하는 위저드도 표현한다. */
export const backtestWizardChildren = sqliteTable("backtest_wizard_children", {
  wizardId: text("wizard_id").notNull().references(() => backtestWizardJobs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  jobId: text("job_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.wizardId, table.kind, table.jobId] }),
  index("idx_backtest_wizard_child_job").on(table.kind, table.jobId),
]);

// ── 백테스트 (스펙 §10, §12) ──────────────────────────────────────

/**
 * 사용자·작성 문맥·위저드 단계별 자동 저장 초안.
 * payload는 단계별 공유 Zod 스키마로 API 경계에서 검증한 JSON이다.
 */
export const backtestWizardDrafts = sqliteTable(
  "backtest_wizard_drafts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 위저드 ID. 기존 API의 작성 문맥도 같은 저장소에서 분리한다. */
    context: text("context").notNull(),
    step: text("step").notNull(),
    payloadJson: text("payload_json").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.context, table.step] }),
    index("idx_backtest_wizard_drafts_updated").on(table.updatedAtMs),
    check(
      "chk_backtest_wizard_drafts_step",
      sql`${table.step} IN ('strategy', 'period', 'universe', 'capital')`,
    ),
  ],
);
