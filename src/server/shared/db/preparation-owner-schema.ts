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

/** 사용자별 현재 위저드가 소유하는 준비 작업은 최대 한 개다. */
export const preparationWizardReferences = sqliteTable(
  "preparation_wizard_references",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    context: text("context").notNull(),
    preparationJobId: text("preparation_job_id")
      .notNull()
      .references(() => backtestPreparationJobs.id, { onDelete: "restrict" }),
  },
  (table) => [index("idx_preparation_wizard_job").on(table.preparationJobId)],
);

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
    /** 빈 문자열은 신규 작성, 값이 있으면 재설정 복제의 source job id다. */
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
