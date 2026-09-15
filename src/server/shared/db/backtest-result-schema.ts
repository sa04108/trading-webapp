import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { backtestJobs } from "../../../runtime/shared/db/operations-schema.js";

/** 재현성 메타데이터 (스펙 §9.5) */
export const backtestRuns = sqliteTable("backtest_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => backtestJobs.id, { onDelete: "cascade" }),
  strategyId: text("strategy_id").notNull(),
  strategyVersion: text("strategy_version").notNull(),
  strategySourceHash: text("strategy_source_hash").notNull(),
  parameterJson: text("parameter_json").notNull(),
  /** 제출한 유니버스 규칙 원문 — backtestJobs.universeRuleJson 과 같은 이유로 복사해 둔다 */
  universeRuleJson: text("universe_rule_json").notNull(),
  /** 멤버십 일정의 집계 해시 (`UniverseRuleResolver.resolve` 의 scheduleHash) */
  scheduleHash: text("schedule_hash").notNull(),
  /**
   * 소비한 (종목, 슬라이스, 버전, 해시) 목록의 집계 해시 — 구 datasetHash 를 대신한다.
   * 종목 데이터가 데이터셋 간에 공유되므로 데이터셋 버전 하나로는 입력을 고정할 수 없다
   * (설계 2026-07-31-symbol-as-first-class, §9.5).
   */
  universeHash: text("universe_hash").notNull(),
  /** [{code, slice, version, contentHash}] — 같은 입력이었는지 항목별로 비교할 수 있게 */
  universeJson: text("universe_json").notNull(),
  engineVersion: text("engine_version").notNull(),
  /** 도입 전 결과는 조회만 유지하며 새 검증 실험의 호환 원본으로 사용하지 않는다. */
  executionVersion: text("execution_version"),
  feeModelVersion: text("fee_model_version").notNull(),
  slippageModelVersion: text("slippage_model_version").notNull(),
  randomSeed: integer("random_seed").notNull(),
  gitCommitSha: text("git_commit_sha").notNull(),
  provenancePinJson: text("provenance_pin_json"),
  warningsJson: text("warnings_json"),
  /** 기간 종료 시점 미청산 포지션 스냅샷 (OpenPositionSnapshot[]) — 소수라 JSON 보관 */
  openPositionsJson: text("open_positions_json"),
  startedAtMs: integer("started_at_ms").notNull(),
  completedAtMs: integer("completed_at_ms"),
});

export const backtestMetrics = sqliteTable("backtest_metrics", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => backtestJobs.id, { onDelete: "cascade" }),
  totalReturnPct: real("total_return_pct").notNull(),
  cagrPct: real("cagr_pct"),
  maxDrawdownPct: real("max_drawdown_pct").notNull(),
  sharpe: real("sharpe"),
  winRate: real("win_rate"),
  tradeCount: integer("trade_count").notNull(),
  metricsJson: text("metrics_json").notNull(),
});

export const backtestEquityPoints = sqliteTable(
  "backtest_equity_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => backtestJobs.id, { onDelete: "cascade" }),
    tsMs: integer("ts_ms").notNull(),
    equity: real("equity").notNull(),
  },
  (table) => [index("idx_backtest_equity_job").on(table.jobId, table.tsMs)],
);

export const backtestDrawdownPoints = sqliteTable(
  "backtest_drawdown_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => backtestJobs.id, { onDelete: "cascade" }),
    tsMs: integer("ts_ms").notNull(),
    drawdown: real("drawdown").notNull(),
  },
  (table) => [index("idx_backtest_drawdown_job").on(table.jobId, table.tsMs)],
);

export const backtestTrades = sqliteTable(
  "backtest_trades",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => backtestJobs.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    quantity: real("quantity").notNull(),
    entryTsMs: integer("entry_ts_ms").notNull(),
    exitTsMs: integer("exit_ts_ms").notNull(),
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price").notNull(),
    grossPnl: real("gross_pnl").notNull(),
    costs: real("costs").notNull(),
    netPnl: real("net_pnl").notNull(),
    returnPct: real("return_pct").notNull(),
    holdingTimeMs: integer("holding_time_ms").notNull(),
    exitReason: text("exit_reason"),
  },
  (table) => [index("idx_backtest_trades_job").on(table.jobId, table.exitTsMs)],
);

export const backtestMonthlyReturns = sqliteTable(
  "backtest_monthly_returns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => backtestJobs.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    returnPct: real("return_pct").notNull(),
  },
  (table) => [index("idx_backtest_monthly_job").on(table.jobId)],
);
