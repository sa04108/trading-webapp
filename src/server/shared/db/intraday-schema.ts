import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 분봉 본문은 Parquet에 두고 수집·실행 상태만 운영 DB에서 관리한다. */
export const intradayCollections = sqliteTable(
  "intraday_collections",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    /** 백테스트가 내부적으로 시작한 수집은 부모 작업에서 관찰·취소한다. */
    parentRunId: text("parent_run_id"),
    symbol: text("symbol").notNull(),
    periodJson: text("period_json").notNull(),
    status: text("status").notNull(),
    fetchedBars: integer("fetched_bars").notNull().default(0),
    pages: integer("pages").notNull().default(0),
    oldestEndMs: integer("oldest_end_ms"),
    error: text("error"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("intraday_collections_owner").on(t.ownerId, t.createdAtMs),
    index("intraday_collections_parent").on(t.parentRunId),
  ],
);

export const intradayRuns = sqliteTable(
  "intraday_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    requestJson: text("request_json").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    resultJson: text("result_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [index("intraday_runs_owner").on(t.ownerId, t.createdAtMs)],
);
