import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const cryptoDatasets = sqliteTable("crypto_datasets", {
  queryKey: text("query_key").primaryKey(),
  sha256: text("sha256").notNull(),
  barsJson: text("bars_json").notNull(),
});

export const cryptoRuns = sqliteTable(
  "crypto_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    datasetKey: text("dataset_key").references(() => cryptoDatasets.queryKey),
    executor: text("executor"),
    token: text("token"),
    deadlineMs: integer("deadline_ms"),
    attempts: integer("attempts").notNull().default(0),
    resultJson: text("result_json"),
    error: text("error"),
  },
  (t) => [
    index("crypto_runs_owner").on(t.ownerId, t.createdAtMs, t.id),
    index("crypto_runs_queue").on(t.status, t.createdAtMs),
  ],
);

export const cryptoPaperAccounts = sqliteTable("crypto_paper_accounts", {
  ownerId: text("owner_id").primaryKey(),
  sourceRunId: text("source_run_id")
    .notNull()
    .references(() => cryptoRuns.id),
  initialCash: real("initial_cash").notNull(),
  cash: real("cash").notNull(),
  holdingJson: text("holding_json"),
  active: integer("active").notNull().default(0),
  activeFromMs: integer("active_from_ms"),
  revision: integer("revision").notNull().default(1),
  lastSession: text("last_session"),
  updatedAtMs: integer("updated_at_ms").notNull(),
  valuedAtMs: integer("valued_at_ms"),
  error: text("error"),
});

export const cryptoPaperFills = sqliteTable(
  "crypto_paper_fills",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => cryptoPaperAccounts.ownerId),
    date: text("date").notNull(),
    sequence: integer("sequence").notNull(),
    fillJson: text("fill_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.date, t.sequence] })],
);
