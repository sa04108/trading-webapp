/**
 * SQLite 메타데이터 스키마 (스펙 §12).
 * 테이블은 Phase 진행에 따라 추가된다. drizzle-kit generate 로 migrations/ 를 생성한다.
 * schema_migrations 역할은 drizzle 의 __drizzle_migrations 테이블이 담당한다.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  // 마지막으로 소비한 TOTP 타임스텝 — 같은 코드의 재사용을 막는다 (RFC 6238 §5.2)
  totpLastUsedStep: integer('totp_last_used_step'),
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

// ── 데이터 (스펙 §12) ──────────────────────────────────────────────

export const datasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  market: text('market').notNull(),
  /** 기본 봉 ('1d'|'1m') — 생성 드로어의 수집 봉 선택. 카드 스위치 기본값 */
  defaultTimeframe: text('default_timeframe').notNull().default('1d'),
  /** 종목 구성 유일키 (정렬·중복 제거, ',' join) — 애플리케이션 레벨 중복 검사용 */
  symbolsKey: text('symbols_key').notNull().default(''),
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
    /** 봉 슬라이스 ('1d'|'1m') — 슬라이스별 커버리지 */
    slice: text('slice').notNull().default('1d'),
  },
  (table) => [
    index('idx_data_coverage_dataset_symbol_slice').on(table.datasetId, table.symbol, table.slice),
  ],
);

export const dataImportJobs = sqliteTable(
  'data_import_jobs',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED
    sourceType: text('source_type').notNull(), // CSV | PARQUET | BROKER
    fileName: text('file_name'),
    symbol: text('symbol'),
    rowsImported: integer('rows_imported'),
    error: text('error'),
    createdAtMs: integer('created_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
    /** CANDLES | FACTS — 봉·재무 두 단계로 진행되는 잡의 현재 단계 (BROKER 전용) */
    phase: text('phase'),
    /**
     * 봉 단계만의 소요시간. 잡 전체 소요시간에는 재무 단계가 섞여 있어 다음 실행의
     * 봉 예상치로 쓸 수 없다 — 봉만 따로 재어 둔다.
     */
    candlesMs: integer('candles_ms'),
    /** 재무 단계 진행·결과 (FactsJobState). null = 재무를 요청하지 않은 잡 */
    factsJson: text('facts_json'),
  },
  (table) => [index('idx_data_import_jobs_dataset').on(table.datasetId)],
);

/**
 * 증권사 동기화 상태 (설계 2026-07-28-broker-sync-design.md).
 * 수집 워터마크와 "백필이 API 보관 깊이 바닥에 닿았다"는 플래그. 워터마크는 봉 저장
 * 이후에만 갱신하므로 실제 저장소보다 앞서 주장하지 않는다. data_coverage 는 데이터셋
 * timeframe(1h/1d) 기준이라 원본 수집 timeframe 의 워터마크로 쓰기에 부정확하다.
 */
export const brokerSyncState = sqliteTable(
  'broker_sync_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** 수집된 가장 오래된 봉 (수집 timeframe 기준) */
    syncedFirstTsMs: integer('synced_first_ts_ms'),
    /** 수집된 가장 최신 봉 */
    syncedLastTsMs: integer('synced_last_ts_ms'),
    /**
     * 백필 완료 시각. 일봉은 API 보관 깊이 바닥까지 소진했다는 뜻이지만, 분봉은
     * 2년 상한이 있어 API 바닥에는 닿지 않는다 — 분봉에서는 "현재 상한 기준으로
     * 더 당길 백필 작업이 없다"는 뜻이다 (broker-sync-service.ts markBackfillDone 참고).
     */
    backfillDoneAtMs: integer('backfill_done_at_ms'),
    /** 봉 슬라이스 ('1d'|'1m') — 슬라이스별 수집 워터마크 */
    slice: text('slice').notNull().default('1d'),
  },
  (table) => [
    uniqueIndex('idx_broker_sync_state_dataset_symbol').on(
      table.datasetId,
      table.symbol,
      table.slice,
    ),
  ],
);

/**
 * 종목별 재무 수집 완료 연도 (설계 2026-07-29-web-facts-sync-design.md §3).
 *
 * **범위 두 값이 아니라 연도 목록이다.** CLI 로 2010–2012 를, 웹으로 2019–2026 을
 * 받으면 수집 이력은 불연속이 된다 — `from`/`to` 로 접으면 2013–2018 을 수집했다고
 * 거짓말한다.
 *
 * 종목 단위인 이유는 저장이 종목 단위이기 때문이다 — 180/200 에서 중단된 실행도
 * 완료된 179종목만 기록되어 다음 실행이 정확히 이어받는다.
 */
export const datasetFactsState = sqliteTable(
  'dataset_facts_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    /** number[] 오름차순 JSON */
    coveredYearsJson: text('covered_years_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    uniqueIndex('idx_dataset_facts_state_dataset_symbol').on(table.datasetId, table.symbol),
  ],
);

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
  /** 기간 종료 시점 미청산 포지션 스냅샷 (OpenPositionSnapshot[]) — 소수라 JSON 보관 */
  openPositionsJson: text('open_positions_json'),
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
