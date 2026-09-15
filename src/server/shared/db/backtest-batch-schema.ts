import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";
import { backtestJobs } from "../../../runtime/shared/db/operations-schema.js";

/**
 * 난수 시드 일괄 복제의 영속 원본. 자식 100개를 기존 QUEUED 상한 밖에 전부 쌓지 않고
 * item을 PENDING으로 보관했다가 빈 슬롯만큼 실제 backtest_jobs로 승격한다.
 */
export const backtestCloneBatches = sqliteTable(
  "backtest_clone_batches",
  {
    id: text("id").primaryKey(),
    /** 아직 실제 작업으로 승격되지 않은 복제 항목도 미리보기를 보존한다. */
    preparationJobId: text("preparation_job_id").references(
      () => backtestPreparationJobs.id,
      { onDelete: "restrict" },
    ),
    sourceJobId: text("source_job_id").notNull(),
    strategyId: text("strategy_id").notNull(),
    status: text("status").notNull(), // ACTIVE | CANCELLING | COMPLETED | FAILED | CANCELLED
    totalCount: integer("total_count").notNull(),
    requestJson: text("request_json").notNull(),
    universeScheduleJson: text("universe_schedule_json").notNull(),
    provenancePinJson: text("provenance_pin_json"),
    universeJson: text("universe_json"),
    universeHash: text("universe_hash"),
    benchmarkJson: text("benchmark_json"),
    benchmarkHash: text("benchmark_hash"),
    submitWarningsJson: text("submit_warnings_json"),
    error: text("error"),
    createdAtMs: integer("created_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
  },
  (table) => [
    index("idx_backtest_clone_batches_created").on(table.createdAtMs),
    index("idx_backtest_clone_batches_status").on(
      table.status,
      table.createdAtMs,
    ),
    index("idx_backtest_clone_batches_preparation").on(table.preparationJobId),
  ],
);

export const backtestCloneBatchItems = sqliteTable(
  "backtest_clone_batch_items",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => backtestCloneBatches.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    randomSeed: integer("random_seed").notNull(),
    state: text("state").notNull(), // PENDING | DISPATCHED | CANCELLED
    jobId: text("job_id").references(() => backtestJobs.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("uq_backtest_clone_batch_item_ordinal").on(
      table.batchId,
      table.ordinal,
    ),
    uniqueIndex("uq_backtest_clone_batch_item_seed").on(
      table.batchId,
      table.randomSeed,
    ),
    uniqueIndex("uq_backtest_clone_batch_item_job").on(table.jobId),
    index("idx_backtest_clone_batch_items_pending").on(
      table.batchId,
      table.state,
    ),
  ],
);
