import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";
import { backtestJobs } from "../../../runtime/shared/db/operations-schema.js";

/** 장치별 인증 자격 증명은 해시만 저장하며 개별 폐기가 가능하다. */
export const agentClients = sqliteTable("agent_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAtMs: integer("created_at_ms").notNull(),
  lastSeenAtMs: integer("last_seen_at_ms"),
  revokedAtMs: integer("revoked_at_ms"),
});

/** 유니버스 계산 lease와 입력 버전은 서버 재시작 후에도 유지한다. */
export const agentPreparationLeases = sqliteTable("agent_preparation_leases", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => backtestPreparationJobs.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  attempt: integer("attempt").notNull().default(0),
  leaseTokenHash: text("lease_token_hash"),
  leaseExpiresAtMs: integer("lease_expires_at_ms"),
  datasetVersion: integer("dataset_version").notNull(),
  failures: integer("failures").notNull().default(0),
  resultHash: text("result_hash"),
  lastReceivedAtMs: integer("last_received_at_ms"),
});

export const agentDataRequests = sqliteTable("agent_data_requests", {
  id: text("id").primaryKey(),
  requestJson: text("request_json").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableVersion: integer("available_version"),
  nextAttemptAtMs: integer("next_attempt_at_ms").notNull().default(0),
  error: text("error"),
  activity: text("activity"),
  progressUnit: text("progress_unit"),
  progressCompleted: integer("progress_completed"),
  progressTotal: integer("progress_total"),
  currentItem: text("current_item"),
  activityStartedAtMs: integer("activity_started_at_ms"),
  lastProgressAtMs: integer("last_progress_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const agentDataWaits = sqliteTable(
  "agent_data_waits",
  {
    kind: text("kind").notNull(),
    jobId: text("job_id").notNull(),
    requestId: text("request_id")
      .notNull()
      .references(() => agentDataRequests.id),
    requestedVersion: integer("requested_version").notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.jobId] })],
);

export const agentBacktestDatasets = sqliteTable("agent_backtest_datasets", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => backtestJobs.id, { onDelete: "cascade" }),
  datasetVersion: integer("dataset_version").notNull(),
});
