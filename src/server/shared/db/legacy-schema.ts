import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 마이그레이션 설정이 기존 운영 DB의 수집 테이블을 유지하도록 정의한다.
 * 런타임에서는 사용하지 않으며, 제거할 때는 삭제 마이그레이션과 이 선언을 함께 변경한다.
 */
export const symbolSlices = sqliteTable(
  "symbol_slices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    slice: text("slice").notNull(),
    syncedFirstTsMs: integer("synced_first_ts_ms"),
    syncedLastTsMs: integer("synced_last_ts_ms"),
    backfillDoneAtMs: integer("backfill_done_at_ms"),
    lastSyncedAtMs: integer("last_synced_at_ms"),
  },
  (table) => [
    uniqueIndex("idx_symbol_slices_code_slice").on(table.code, table.slice),
  ],
);

export const symbolCoverage = sqliteTable(
  "symbol_coverage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    slice: text("slice").notNull(),
    firstTsMs: integer("first_ts_ms"),
    lastTsMs: integer("last_ts_ms"),
    barCount: integer("bar_count").notNull().default(0),
    expectedBarCount: integer("expected_bar_count"),
    missingRangesJson: text("missing_ranges_json"),
    computedAtMs: integer("computed_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("idx_symbol_coverage_code_slice").on(table.code, table.slice),
  ],
);

export const dataSyncJobs = sqliteTable(
  "data_sync_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    sourceType: text("source_type").notNull(),
    symbolsJson: text("symbols_json").notNull(),
    slice: text("slice").notNull().default("1d"),
    fileName: text("file_name"),
    rowsImported: integer("rows_imported"),
    error: text("error"),
    createdAtMs: integer("created_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    phase: text("phase"),
    candlesMs: integer("candles_ms"),
    factsJson: text("facts_json"),
    failedSymbolsJson: text("failed_symbols_json"),
  },
  (table) => [index("idx_data_sync_jobs_status").on(table.status)],
);
