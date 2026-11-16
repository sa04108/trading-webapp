import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { backtestJobs } from "../../../runtime/shared/db/operations-schema.js";
import { users } from "./auth-schema.js";

/** 비교 선택만 저장한다. 실행 입력과 결과 원본에는 벤치마크 시계열을 넣지 않는다. */
export const backtestBenchmarkSelections = sqliteTable("backtest_benchmark_selections", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jobId: text("job_id").notNull().references(() => backtestJobs.id, { onDelete: "cascade" }),
  benchmarkIdsJson: text("benchmark_ids_json").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.jobId] })]);
