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

/**
 * 사용자 알림 (설계 2026-08-03-notification-center).
 * 전역이다 — backtest_jobs·data_sync_jobs 에 user_id 가 없는 것과 같은 이유로,
 * 이 시스템의 작업은 전부 전역 자원이고 읽음 플래그도 행에 직접 둔다.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'backtest' | 'data-sync'
    severity: text('severity').notNull(), // 'info' | 'error'
    title: text('title').notNull(),
    body: text('body'),
    /** 알림을 눌렀을 때 갈 곳. 대상이 삭제됐어도 남는다 — 404 가 출처 불명보다 낫다 */
    link: text('link'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_notifications_created').on(table.createdAtMs)],
);

// ── 데이터 (스펙 §12) ──────────────────────────────────────────────

/**
 * 종목이 1급 객체다 (설계 2026-07-31-symbol-as-first-class).
 *
 * 봉·재무·수집 워터마크가 모두 여기에 매달린다. 데이터셋은 `dataset_symbols` 로 참조만
 * 갖는다 — 같은 종목이 N개 데이터셋에 있어도 데이터는 한 벌이고, DART 호출도 한 번이다.
 *
 * `market` 이 종목의 속성인 이유: 005930 은 어느 데이터셋에 들어가든 KOSPI 다.
 * `name` 을 저장하는 이유: 가나다순 정렬이 외부 조회 성공에 의존하면 목록 순서가
 * 흔들린다. 나중에 정렬·필터를 서버로 내리는 준비도 된다.
 */
export const symbols = sqliteTable(
  'symbols',
  {
    code: text('code').primaryKey(),
    market: text('market').notNull(),
    /** 표시명 — 외부 조회가 실패하거나 소스가 없으면 null */
    name: text('name'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_symbols_market').on(table.market)],
);

/**
 * 슬라이스별 수집 워터마크 (구 broker_sync_state).
 * 워터마크는 봉 저장 이후에만 갱신하므로 실제 저장소보다 앞서 주장하지 않는다.
 */
export const symbolSlices = sqliteTable(
  'symbol_slices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code')
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
    /** 봉 슬라이스 ('1d'|'1m') */
    slice: text('slice').notNull(),
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
    /** 마지막으로 이 슬라이스 수집이 완료된 시각 — 종목 화면의 「일봉 3일 전」 */
    lastSyncedAtMs: integer('last_synced_at_ms'),
  },
  (table) => [uniqueIndex('idx_symbol_slices_code_slice').on(table.code, table.slice)],
);

export const symbolCoverage = sqliteTable(
  'symbol_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code')
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
    slice: text('slice').notNull(),
    firstTsMs: integer('first_ts_ms'),
    lastTsMs: integer('last_ts_ms'),
    barCount: integer('bar_count').notNull().default(0),
    expectedBarCount: integer('expected_bar_count'),
    missingRangesJson: text('missing_ranges_json'),
    computedAtMs: integer('computed_at_ms').notNull(),
  },
  (table) => [uniqueIndex('idx_symbol_coverage_code_slice').on(table.code, table.slice)],
);

/**
 * 종목별 재무 수집 완료 연도 (설계 2026-07-29-web-facts-sync-design.md §3).
 *
 * **범위 두 값이 아니라 연도 목록이다.** CLI 로 2010–2012 를, 웹으로 2019–2026 을
 * 받으면 수집 이력은 불연속이 된다 — `from`/`to` 로 접으면 2013–2018 을 수집했다고
 * 거짓말한다.
 *
 * 이제 데이터셋 축이 없다 — 같은 종목을 두 데이터셋에서 각각 받던 중복이 사라진다.
 */
export const symbolFactsState = sqliteTable('symbol_facts_state', {
  code: text('code')
    .primaryKey()
    .references(() => symbols.code, { onDelete: 'cascade' }),
  /** number[] 오름차순 JSON */
  coveredYearsJson: text('covered_years_json').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

/**
 * 슬라이스별 데이터 버전 (구 dataset_versions) — §9.5 재현성의 앵커.
 *
 * 종목 데이터를 데이터셋들이 공유하므로 "데이터셋 버전" 으로는 실행 입력을 고정할 수
 * 없다: 누군가 종목을 동기화하면 그 종목을 참조하는 모든 데이터셋의 입력이 변한다.
 * 수집 성공마다 `(code, slice)` 의 version 을 올리고, 실행은 소비한 조합을
 * `backtest_runs.universeJson` 에 스냅샷으로 남긴다.
 *
 * `contentHash` 는 바이트 다이제스트가 아니라 계보 해시다(직전 해시 + 지문 seed) —
 * 구 `dataset_versions.contentHash` 와 같은 성질이다. 데이터가 바뀌면 해시가 바뀐다는
 * 보장이지, 해시로 내용을 재구성할 수 있다는 뜻은 아니다.
 */
export const symbolVersions = sqliteTable(
  'symbol_versions',
  {
    id: text('id').primaryKey(),
    code: text('code')
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
    slice: text('slice').notNull(),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [index('idx_symbol_versions_code_slice').on(table.code, table.slice)],
);

/** 데이터셋은 이름과 설명, 그리고 종목 참조뿐이다 — market·timeframe·종목목록을 갖지 않는다 */
export const datasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const datasetSymbols = sqliteTable(
  'dataset_symbols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    code: text('code')
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('idx_dataset_symbols_dataset_code').on(table.datasetId, table.code),
    // 종목 화면의 「데이터셋 2곳」 역방향 조회
    index('idx_dataset_symbols_code').on(table.code),
  ],
);

/**
 * 수집 잡 (구 data_import_jobs). 대상이 데이터셋이 아니라 **종목 집합**이다 —
 * 사용자가 종목 화면에서 여러 개를 체크해 한 번에 동기화한다.
 */
export const dataSyncJobs = sqliteTable(
  'data_sync_jobs',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(), // QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED
    sourceType: text('source_type').notNull(), // CSV | PARQUET | BROKER
    /** 이 잡이 다루는 종목 코드 (string[] JSON) */
    symbolsJson: text('symbols_json').notNull(),
    /** 수집 대상 슬라이스 ('1d'|'1m') */
    slice: text('slice').notNull().default('1d'),
    fileName: text('file_name'),
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
  (table) => [index('idx_data_sync_jobs_status').on(table.status)],
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
    /**
     * 제출 시점에 고정된 종목 버전 스냅샷 — 실행 시점의 latest 로 대체 금지 (재현성 §9.5).
     * [{code, slice, version, contentHash}] JSON 과 그 집계 해시.
     */
    universeJson: text('universe_json'),
    universeHash: text('universe_hash'),
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
  /** 어느 데이터셋을 골랐나 — 실행이 무엇을 소비했는지는 universeJson 이 답한다 */
  datasetId: text('dataset_id').notNull(),
  /**
   * 소비한 (종목, 슬라이스, 버전, 해시) 목록의 집계 해시 — 구 datasetHash 를 대신한다.
   * 종목 데이터가 데이터셋 간에 공유되므로 데이터셋 버전 하나로는 입력을 고정할 수 없다
   * (설계 2026-07-31-symbol-as-first-class, §9.5).
   */
  universeHash: text('universe_hash').notNull(),
  /** [{code, slice, version, contentHash}] — 같은 입력이었는지 항목별로 비교할 수 있게 */
  universeJson: text('universe_json').notNull(),
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
