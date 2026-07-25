/**
 * SQLite 메타데이터 스키마 (스펙 §12).
 * 테이블은 Phase 진행에 따라 추가된다. drizzle-kit generate 로 migrations/ 를 생성한다.
 * schema_migrations 역할은 drizzle 의 __drizzle_migrations 테이블이 담당한다.
 */
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  recoveryCodeHashesJson: text('recovery_code_hashes_json'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pendingTotp: integer('pending_totp', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
    lastSeenAtMs: integer('last_seen_at_ms').notNull(),
  },
  (table) => [index('idx_sessions_user').on(table.userId)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    ip: text('ip').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
    attemptedAtMs: integer('attempted_at_ms').notNull(),
  },
  (table) => [index('idx_login_attempts_username_time').on(table.username, table.attemptedAtMs)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    detailJson: text('detail_json'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_audit_logs_time').on(table.createdAtMs)],
);

export const applicationSettings = sqliteTable('application_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

// ── 데이터 (스펙 §12) ──────────────────────────────────────────────

export const datasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  market: text('market').notNull(),
  timeframe: text('timeframe').notNull(),
  symbolsJson: text('symbols_json').notNull(),
  description: text('description'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const datasetVersions = sqliteTable(
  'dataset_versions',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    note: text('note'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_dataset_versions_dataset').on(table.datasetId)],
);

export const dataCoverage = sqliteTable(
  'data_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    firstTsMs: integer('first_ts_ms'),
    lastTsMs: integer('last_ts_ms'),
    barCount: integer('bar_count').notNull().default(0),
    expectedBarCount: integer('expected_bar_count'),
    missingRangesJson: text('missing_ranges_json'),
    computedAtMs: integer('computed_at_ms').notNull(),
  },
  (table) => [index('idx_data_coverage_dataset_symbol').on(table.datasetId, table.symbol)],
);

export const dataImportJobs = sqliteTable(
  'data_import_jobs',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // QUEUED | RUNNING | COMPLETED | FAILED
    sourceType: text('source_type').notNull(), // CSV | PARQUET | BROKER
    fileName: text('file_name'),
    symbol: text('symbol'),
    rowsImported: integer('rows_imported'),
    error: text('error'),
    createdAtMs: integer('created_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [index('idx_data_import_jobs_dataset').on(table.datasetId)],
);

export const dataSyncJobs = sqliteTable('data_sync_jobs', {
  id: text('id').primaryKey(),
  datasetId: text('dataset_id')
    .notNull()
    .references(() => datasets.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  detailJson: text('detail_json'),
  createdAtMs: integer('created_at_ms').notNull(),
  completedAtMs: integer('completed_at_ms'),
});

// ── 백테스트 (스펙 §10, §12) ──────────────────────────────────────

export const backtestJobs = sqliteTable(
  'backtest_jobs',
  {
    id: text('id').primaryKey(),
    // QUEUED | STARTING | RUNNING | CANCELLING | CANCELLED | COMPLETED | FAILED | INTERRUPTED
    status: text('status').notNull(),
    requestJson: text('request_json').notNull(),
    strategyId: text('strategy_id').notNull(),
    datasetId: text('dataset_id').notNull(),
    // 제출 시점에 고정된 데이터셋 버전·해시 — 실행 시점의 latest 로 대체 금지 (재현성 §9.5)
    datasetVersion: integer('dataset_version'),
    datasetHash: text('dataset_hash'),
    progressBars: integer('progress_bars'),
    totalBars: integer('total_bars'),
    // 진행 위치 표시용 텍스트 (엔진이 시간 우선이라 날짜가 들어간다) — "심볼" 이 아니다
    progressLabel: text('progress_label'),
    error: text('error'),
    workerId: text('worker_id'),
    pid: integer('pid'),
    createdAtMs: integer('created_at_ms').notNull(),
    startedAtMs: integer('started_at_ms'),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [
    index('idx_backtest_jobs_status').on(table.status, table.createdAtMs),
    index('idx_backtest_jobs_created').on(table.createdAtMs),
  ],
);

/** 재현성 메타데이터 (스펙 §9.5) */
export const backtestRuns = sqliteTable('backtest_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .unique()
    .references(() => backtestJobs.id, { onDelete: 'cascade' }),
  strategyId: text('strategy_id').notNull(),
  strategyVersion: text('strategy_version').notNull(),
  strategySourceHash: text('strategy_source_hash').notNull(),
  parameterJson: text('parameter_json').notNull(),
  datasetId: text('dataset_id').notNull(),
  datasetVersion: integer('dataset_version').notNull(),
  datasetHash: text('dataset_hash').notNull(),
  engineVersion: text('engine_version').notNull(),
  feeModelVersion: text('fee_model_version').notNull(),
  slippageModelVersion: text('slippage_model_version').notNull(),
  randomSeed: integer('random_seed').notNull(),
  gitCommitSha: text('git_commit_sha').notNull(),
  warningsJson: text('warnings_json'),
  startedAtMs: integer('started_at_ms').notNull(),
  completedAtMs: integer('completed_at_ms'),
});

export const backtestMetrics = sqliteTable('backtest_metrics', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => backtestJobs.id, { onDelete: 'cascade' }),
  totalReturnPct: real('total_return_pct').notNull(),
  cagrPct: real('cagr_pct'),
  maxDrawdownPct: real('max_drawdown_pct').notNull(),
  sharpe: real('sharpe'),
  winRate: real('win_rate'),
  tradeCount: integer('trade_count').notNull(),
  metricsJson: text('metrics_json').notNull(),
});

export const backtestEquityPoints = sqliteTable(
  'backtest_equity_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => backtestJobs.id, { onDelete: 'cascade' }),
    tsMs: integer('ts_ms').notNull(),
    equity: real('equity').notNull(),
  },
  (table) => [index('idx_backtest_equity_job').on(table.jobId, table.tsMs)],
);

export const backtestDrawdownPoints = sqliteTable(
  'backtest_drawdown_points',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => backtestJobs.id, { onDelete: 'cascade' }),
    tsMs: integer('ts_ms').notNull(),
    drawdown: real('drawdown').notNull(),
  },
  (table) => [index('idx_backtest_drawdown_job').on(table.jobId, table.tsMs)],
);

export const backtestTrades = sqliteTable(
  'backtest_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => backtestJobs.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    quantity: real('quantity').notNull(),
    entryTsMs: integer('entry_ts_ms').notNull(),
    exitTsMs: integer('exit_ts_ms').notNull(),
    entryPrice: real('entry_price').notNull(),
    exitPrice: real('exit_price').notNull(),
    grossPnl: real('gross_pnl').notNull(),
    costs: real('costs').notNull(),
    netPnl: real('net_pnl').notNull(),
    returnPct: real('return_pct').notNull(),
    holdingTimeMs: integer('holding_time_ms').notNull(),
    exitReason: text('exit_reason'),
  },
  (table) => [index('idx_backtest_trades_job').on(table.jobId, table.exitTsMs)],
);

export const backtestMonthlyReturns = sqliteTable(
  'backtest_monthly_returns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => backtestJobs.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    returnPct: real('return_pct').notNull(),
  },
  (table) => [index('idx_backtest_monthly_job').on(table.jobId)],
);

export const backtestSymbolMetrics = sqliteTable(
  'backtest_symbol_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => backtestJobs.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    tradeCount: integer('trade_count').notNull(),
    netPnl: real('net_pnl').notNull(),
    winRate: real('win_rate'),
  },
  (table) => [index('idx_backtest_symbol_job').on(table.jobId)],
);
