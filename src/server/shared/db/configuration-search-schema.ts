import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { backtestPreparationJobs } from "../../../runtime/shared/db/operations-schema.js";
import type { ConfigurationSearchMode, ConfigurationSearchStatus, ConfigurationSearchItemStatus } from "../../../shared/schemas/configuration-search.js";

/** 미리보기에서 추출한 조합과 실행 기준을 보존하며 시작 요청은 같은 실험을 재사용한다. */
export const configurationSearches = sqliteTable("configuration_searches", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  requestId: text("request_id").notNull(),
  mode: text("mode").$type<ConfigurationSearchMode>().notNull(),
  sourceJobId: text("source_job_id").notNull(),
  configJson: text("config_json").notNull(),
  catalogJson: text("catalog_json").notNull(),
  runtimeIdentity: text("runtime_identity").notNull(),
  status: text("status").$type<ConfigurationSearchStatus>().notNull(),
  error: text("error"),
  createdAtMs: integer("created_at_ms").notNull(),
  completedAtMs: integer("completed_at_ms"),
  notifiedAtMs: integer("notified_at_ms"),
}, table => [uniqueIndex("idx_configuration_search_request").on(table.ownerId, table.requestId), index("idx_configuration_search_source").on(table.mode, table.sourceJobId), index("idx_configuration_search_status").on(table.status)]);

/** 항목마다 준비 참조를 소유한다. 자식 생성과 jobId 연결은 하나의 트랜잭션이다. */
export const configurationSearchItems = sqliteTable("configuration_search_items", {
  id: text("id").primaryKey(),
  searchId: text("search_id").notNull().references(() => configurationSearches.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  requestJson: text("request_json").notNull(),
  valuesJson: text("values_json").notNull(),
  status: text("status").$type<ConfigurationSearchItemStatus>().notNull(),
  preparationJobId: text("preparation_job_id").references(() => backtestPreparationJobs.id, { onDelete: "restrict" }),
  jobId: text("job_id"),
  error: text("error"),
}, table => [uniqueIndex("idx_configuration_search_ordinal").on(table.searchId, table.ordinal), uniqueIndex("idx_configuration_search_job").on(table.jobId), index("idx_configuration_search_preparation").on(table.preparationJobId)]);
