import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';


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


/**
 * 외부 API 일일 호출 원장.
 *
 * 프로세스 메모리가 아니라 앱 SQLite에 기록해 같은 KST 날짜에 서버가 재시작돼도
 * 호출 예산이 이어진다. quotaScope는 공급자의 실제 한도 단위다 — DART는 키 전체
 * (`daily`), KRX는 엔드포인트별 경로를 쓴다.
 */
export const externalApiDailyUsage = sqliteTable(
  'external_api_daily_usage',
  {
    api: text('api').notNull(),
    quotaScope: text('quota_scope').notNull(),
    usageDateKst: text('usage_date_kst').notNull(),
    callsUsed: integer('calls_used').notNull().default(0),
    /** 공급자 응답 또는 로컬 예산 판정으로 그날 한도 소진을 확인한 최초 시각 */
    quotaExceededAtMs: integer('quota_exceeded_at_ms'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.api, table.quotaScope, table.usageDateKst] }),
    index('idx_external_api_daily_usage_date').on(table.usageDateKst),
  ],
);


/**
 * 슬라이스별 수집 워터마크 (구 broker_sync_state) — 더는 쓰지 않는다.
 * 이 테이블에 쓰던 `BrokerSyncService`가 봉 수집 제거로 함께 사라졌다(D-041).
 * 테이블째 삭제는 스키마 정리(후속 계획)에서 한다.
 */
export const symbolSlices = sqliteTable(
  'symbol_slices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code')
      .notNull(),
    /** 봉 슬라이스 ('1d'|'1m') */
    slice: text('slice').notNull(),
    /** 수집된 가장 오래된 봉 (수집 timeframe 기준) */
    syncedFirstTsMs: integer('synced_first_ts_ms'),
    /** 수집된 가장 최신 봉 */
    syncedLastTsMs: integer('synced_last_ts_ms'),
    /**
     * 백필 완료 시각. 일봉은 API 보관 깊이 바닥까지, 분봉은 2년 상한까지
     * 수집했다는 뜻이었다. `BrokerSyncService`가 사라지며 더는 갱신되지 않는다.
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
      .notNull(),
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
 * 수집 잡 (구 data_import_jobs) — 더는 쓰지 않는다. CSV 가져오기·증권사 봉
 * 동기화가 봉 수집 제거로 함께 사라져(D-041) 아무도 이 테이블에 쓰지 않는다.
 * 동시 수집 잡 개념 자체가 D-041 로 사라졌다. 테이블째 삭제는 스키마 정리(후속
 * 계획)에서 한다.
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
    /**
     * 종목별 격리 실패 목록 ({code, market, reason}[] JSON). 증권사가 상장폐지
     * 종목을 모르는 탓에 나는 404 등은 그 종목만 건너뛰고 나머지는 계속 수집한다.
     * null = 실패한 종목이 없거나 봉 단계 자체를 아직 실행하지 않은 잡.
     */
    failedSymbolsJson: text('failed_symbols_json'),
  },
  (table) => [index('idx_data_sync_jobs_status').on(table.status)],
);



/** 백테스트 유니버스·재무·가격을 온디맨드로 준비하는 영속 작업. */
export const backtestPreparationJobs = sqliteTable(
  'backtest_preparation_jobs',
  {
    id: text('id').primaryKey(),
    requestHash: text('request_hash').notNull(),
    requestJson: text('request_json').notNull(),
    /** 소유자 참조 이관이 끝난 준비 작업만 자동 정리한다. */
    lifecycleManaged: integer('lifecycle_managed', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull(),
    phase: text('phase').notNull(),
    /** 재계산·재시작에도 감소하지 않는 미리보기 전체 예상 진행률. */
    overallProgress: integer('overall_progress').notNull().default(0),
    doneSymbols: integer('done_symbols').notNull().default(0),
    totalSymbols: integer('total_symbols').notNull().default(0),
    savedFacts: integer('saved_facts').notNull().default(0),
    gapCount: integer('gap_count').notNull().default(0),
    dartQuotaDateKst: text('dart_quota_date_kst'),
    dartCallsUsed: integer('dart_calls_used').notNull().default(0),
    nextResumeAtMs: integer('next_resume_at_ms'),
    previewJson: text('preview_json'),
    error: text('error'),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [index('preparation_jobs_hash_idx').on(table.requestHash, table.status)],
);


/** Only a fully validated, unchanged data revision may reuse a completed preview. */
export const preparationPreviewCache = sqliteTable('preparation_preview_cache', {
  jobId: text('job_id').primaryKey()
    .references(() => backtestPreparationJobs.id, { onDelete: 'cascade' }),
  dataRevision: integer('data_revision').notNull(),
  validationVersion: text('validation_version').notNull(),
  fundamentalSymbolsJson: text('fundamental_symbols_json').notNull(),
});


/** 사용자별 현재 위저드가 소유하는 준비 작업은 최대 한 개다. */
export const preparationWizardReferences = sqliteTable('preparation_wizard_references', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  context: text('context').notNull(),
  preparationJobId: text('preparation_job_id').notNull()
    .references(() => backtestPreparationJobs.id, { onDelete: 'restrict' }),
}, (table) => [index('idx_preparation_wizard_job').on(table.preparationJobId)]);


// ── 백테스트 (스펙 §10, §12) ──────────────────────────────────────

/**
 * 사용자·작성 문맥·위저드 단계별 자동 저장 초안.
 * payload는 단계별 공유 Zod 스키마로 API 경계에서 검증한 JSON이다.
 */
export const backtestWizardDrafts = sqliteTable(
  'backtest_wizard_drafts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 빈 문자열은 신규 작성, 값이 있으면 재설정 복제의 source job id다. */
    context: text('context').notNull(),
    step: text('step').notNull(),
    payloadJson: text('payload_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.context, table.step] }),
    index('idx_backtest_wizard_drafts_updated').on(table.updatedAtMs),
    check(
      'chk_backtest_wizard_drafts_step',
      sql`${table.step} IN ('strategy', 'period', 'universe', 'capital')`,
    ),
  ],
);


export const backtestJobs = sqliteTable(
  'backtest_jobs',
  {
    id: text('id').primaryKey(),
    /** 실패·취소된 작업도 복제할 수 있도록 제출 때 쓴 미리보기를 보존한다. */
    preparationJobId: text('preparation_job_id')
      .references(() => backtestPreparationJobs.id, { onDelete: 'restrict' }),
    // QUEUED | STARTING | RUNNING | CANCELLING | CANCELLED | COMPLETED | FAILED | INTERRUPTED
    status: text('status').notNull(),
    requestJson: text('request_json').notNull(),
    strategyId: text('strategy_id').notNull(),
    /**
     * 제출한 유니버스 규칙 원문 (스펙 2026-08-05) — `requestJson` 안에도 있지만, 잡·런을
     * 목록 조회할 때 전체 요청을 파싱하지 않고 유니버스만 보려는 화면·감사 질의를 위해
     * 별도 컬럼으로 둔다.
     */
    universeRuleJson: text('universe_rule_json').notNull(),
    /**
     * `UniverseRuleResolver.resolve` 가 만든 멤버십 일정(`UniverseScheduleEntry[]`) —
     * 워커·엔진의 유일한 유니버스 소스다. 제출 시점에 고정해 대기 중 종목 마스터가
     * 갱신돼도 실행이 흔들리지 않는다 (§9.5 와 같은 재현성 원칙).
     */
    universeScheduleJson: text('universe_schedule_json').notNull(),
    /** 서버 소유 provenance pin (REVIEW §9.2). 클라이언트 입력이 아니다 */
    provenancePinJson: text('provenance_pin_json'),
    /**
     * 제출 시점에 고정된 종목 버전 스냅샷 — 실행 시점의 latest 로 대체 금지 (재현성 §9.5).
     * [{code, slice, version, contentHash}] JSON 과 그 집계 해시.
     */
    universeJson: text('universe_json'),
    universeHash: text('universe_hash'),
    /** 제출 시점의 벤치마크 종가와 그 해시. 데이터가 부족해도 부분 pin은 남긴다. */
    benchmarkJson: text('benchmark_json'),
    benchmarkHash: text('benchmark_hash'),
    /** 난수 시드 일괄 복제 묶음과 원본 계보. 일반 제출은 둘 다 null이다. */
    cloneBatchId: text('clone_batch_id'),
    cloneSourceJobId: text('clone_source_job_id'),
    progressBars: integer('progress_bars'),
    totalBars: integer('total_bars'),
    /** 제출 검증의 봉 수 추정값으로 장치별 자동 메모리 한도에 맞춰 배정한다. */
    estimatedBars: integer('estimated_bars').notNull().default(0),
    leaseFailures: integer('lease_failures').notNull().default(0),
    // 진행 위치 표시용 텍스트 (엔진이 시간 우선이라 날짜가 들어간다) — "심볼" 이 아니다
    progressLabel: text('progress_label'),
    error: text('error'),
    /**
     * 제출·복제 검증이 만든 경고 원문(string[]). 화면 토스트는 10초 뒤 사라지므로
     * 자본변동 gap 같은 "확인하지 못했다" 를 남길 곳이 여기밖에 없다.
     * null 은 경고가 없었거나 이 컬럼이 생기기 전에 만들어진 job 이다.
     */
    submitWarningsJson: text('submit_warnings_json'),
    workerId: text('worker_id'),
    pid: integer('pid'),
    /** 원격 worker lease attempt. 새 claim마다 증가해 이전 worker의 늦은 완료를 거부한다. */
    attempt: integer('attempt').notNull().default(0),
    /** lease 원문은 저장하지 않고 SHA-256만 저장한다. */
    leaseTokenHash: text('lease_token_hash'),
    leaseExpiresAtMs: integer('lease_expires_at_ms'),
    /** 서버와 worker가 같은 계산 코드를 실행하는지 확인하는 git SHA. */
    runnerVersion: text('runner_version'),
    resultSchemaVersion: integer('result_schema_version'),
    resultChecksum: text('result_checksum'),
    createdAtMs: integer('created_at_ms').notNull(),
    startedAtMs: integer('started_at_ms'),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [
    index('idx_backtest_jobs_status').on(table.status, table.createdAtMs),
    index('idx_backtest_jobs_created').on(table.createdAtMs),
    index('idx_backtest_jobs_preparation').on(table.preparationJobId),
  ],
);


/**
 * 난수 시드 일괄 복제의 영속 원본. 자식 100개를 기존 QUEUED 상한 밖에 전부 쌓지 않고
 * item을 PENDING으로 보관했다가 빈 슬롯만큼 실제 backtest_jobs로 승격한다.
 */
export const backtestCloneBatches = sqliteTable(
  'backtest_clone_batches',
  {
    id: text('id').primaryKey(),
    /** 아직 실제 작업으로 승격되지 않은 복제 항목도 미리보기를 보존한다. */
    preparationJobId: text('preparation_job_id')
      .references(() => backtestPreparationJobs.id, { onDelete: 'restrict' }),
    sourceJobId: text('source_job_id').notNull(),
    strategyId: text('strategy_id').notNull(),
    status: text('status').notNull(), // ACTIVE | CANCELLING | COMPLETED | FAILED | CANCELLED
    totalCount: integer('total_count').notNull(),
    requestJson: text('request_json').notNull(),
    universeScheduleJson: text('universe_schedule_json').notNull(),
    provenancePinJson: text('provenance_pin_json'),
    universeJson: text('universe_json'),
    universeHash: text('universe_hash'),
    benchmarkJson: text('benchmark_json'),
    benchmarkHash: text('benchmark_hash'),
    submitWarningsJson: text('submit_warnings_json'),
    error: text('error'),
    createdAtMs: integer('created_at_ms').notNull(),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [
    index('idx_backtest_clone_batches_created').on(table.createdAtMs),
    index('idx_backtest_clone_batches_status').on(table.status, table.createdAtMs),
    index('idx_backtest_clone_batches_preparation').on(table.preparationJobId),
  ],
);


export const backtestCloneBatchItems = sqliteTable(
  'backtest_clone_batch_items',
  {
    id: text('id').primaryKey(),
    batchId: text('batch_id')
      .notNull()
      .references(() => backtestCloneBatches.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    randomSeed: integer('random_seed').notNull(),
    state: text('state').notNull(), // PENDING | DISPATCHED | CANCELLED
    jobId: text('job_id').references(() => backtestJobs.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('uq_backtest_clone_batch_item_ordinal').on(table.batchId, table.ordinal),
    uniqueIndex('uq_backtest_clone_batch_item_seed').on(table.batchId, table.randomSeed),
    uniqueIndex('uq_backtest_clone_batch_item_job').on(table.jobId),
    index('idx_backtest_clone_batch_items_pending').on(table.batchId, table.state),
  ],
);


/** 독립 평가 실험은 원본 설정과 선택 규칙을 고정하고 단계별 복구 위치를 보관한다. */
export const backtestValidations = sqliteTable('backtest_validations', {
  id: text('id').primaryKey(),
  sourceJobId: text('source_job_id').notNull(),
  requestJson: text('request_json').notNull(),
  configJson: text('config_json').notNull(),
  planJson: text('plan_json').notNull(),
  strategyVersion: text('strategy_version').notNull(),
  strategySourceHash: text('strategy_source_hash').notNull(),
  engineVersion: text('engine_version').notNull(),
  gitCommitSha: text('git_commit_sha').notNull(),
  status: text('status').notNull(),
  fold: integer('fold').notNull().default(0),
  phase: text('phase').notNull().default('PREPARING_TRAIN'),
  dataRevision: integer('data_revision'),
  error: text('error'),
  createdAtMs: integer('created_at_ms').notNull(),
}, (table) => [index('idx_validation_source').on(table.sourceJobId)]);


/** 준비 참조는 위저드와 분리하며, 작업 연결은 enqueue와 같은 트랜잭션에서 저장한다. */
export const backtestValidationTrials = sqliteTable('backtest_validation_trials', {
  id: text('id').primaryKey(),
  validationId: text('validation_id').notNull().references(() => backtestValidations.id, { onDelete: 'cascade' }),
  fold: integer('fold').notNull(),
  role: text('role').notNull(),
  candidate: integer('candidate'),
  requestJson: text('request_json'),
  preparationJobId: text('preparation_job_id').references(() => backtestPreparationJobs.id, { onDelete: 'restrict' }),
  jobId: text('job_id').unique().references(() => backtestJobs.id, { onDelete: 'restrict' }),
}, (table) => [
  index('idx_validation_trial_parent').on(table.validationId, table.fold),
  index('idx_validation_trial_preparation').on(table.preparationJobId),
]);


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
  /** 제출한 유니버스 규칙 원문 — backtestJobs.universeRuleJson 과 같은 이유로 복사해 둔다 */
  universeRuleJson: text('universe_rule_json').notNull(),
  /** 멤버십 일정의 집계 해시 (`UniverseRuleResolver.resolve` 의 scheduleHash) */
  scheduleHash: text('schedule_hash').notNull(),
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
  provenancePinJson: text('provenance_pin_json'),
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
export const operationalDatabaseState = sqliteTable('operational_database_state', {
  singleton: integer('singleton').primaryKey(),
  datasetId: text('dataset_id').notNull(),
}, (table) => [check('operations_singleton_one', sql`${table.singleton} = 1`)]);

/**
 * DART 파서가 소비하기 전의 API 응답 snapshot.
 *
 * coverage protocol은 파서·정렬 의미가 바뀌면 올라가지만, 원천 응답까지 바뀌었다는
 * 뜻은 아니다. 같은 원문을 다시 해석할 수 있도록 성공(000)과 무자료(013) 봉투를
 * 행 순서와 미사용 필드까지 JSON 그대로 보존한다. API key와 corp_code는 재생 입력이
 * 아니므로 저장하지 않는다.
 */
export const dartRawApiSnapshots = sqliteTable(
  'dart_raw_api_snapshots',
  {
    code: text('code')
      .notNull(),
    endpoint: text('endpoint').notNull(),
    businessYear: integer('business_year').notNull(),
    reportCode: text('report_code').notNull(),
    /** 재무제표만 CFS/OFS, 나머지 엔드포인트는 NONE */
    fsDiv: text('fs_div').notNull(),
    payloadJson: text('payload_json').notNull(),
    contentHash: text('content_hash').notNull(),
    fetchedAtMs: integer('fetched_at_ms').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.code,
        table.endpoint,
        table.businessYear,
        table.reportCode,
        table.fsDiv,
      ],
    }),
    index('idx_dart_raw_api_snapshots_fetched_at').on(table.fetchedAtMs),
    check(
      'chk_dart_raw_api_snapshots_endpoint',
      sql`${table.endpoint} IN ('FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS')`,
    ),
    check(
      'chk_dart_raw_api_snapshots_report_code',
      sql`${table.reportCode} IN ('11013', '11012', '11014', '11011')`,
    ),
    check(
      'chk_dart_raw_api_snapshots_fs_div',
      sql`${table.fsDiv} IN ('CFS', 'OFS', 'NONE')`,
    ),
  ],
);



/** 장치별 인증 자격 증명은 해시만 저장하며 개별 폐기가 가능하다. */
export const agentClients = sqliteTable('agent_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAtMs: integer('created_at_ms').notNull(),
  lastSeenAtMs: integer('last_seen_at_ms'),
  revokedAtMs: integer('revoked_at_ms'),
});

/** 유니버스 계산 lease와 입력 버전은 서버 재시작 후에도 유지한다. */
export const agentPreparationLeases = sqliteTable('agent_preparation_leases', {
  jobId: text('job_id').primaryKey().references(() => backtestPreparationJobs.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  attempt: integer('attempt').notNull().default(0),
  leaseTokenHash: text('lease_token_hash'),
  leaseExpiresAtMs: integer('lease_expires_at_ms'),
  datasetVersion: integer('dataset_version').notNull(),
  failures: integer('failures').notNull().default(0),
  resultHash: text('result_hash'),
});

export const agentDataRequests = sqliteTable('agent_data_requests', {
  id: text('id').primaryKey(),
  requestJson: text('request_json').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  availableVersion: integer('available_version'),
  nextAttemptAtMs: integer('next_attempt_at_ms').notNull().default(0),
  error: text('error'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});

export const agentDataWaits = sqliteTable('agent_data_waits', {
  kind: text('kind').notNull(),
  jobId: text('job_id').notNull(),
  requestId: text('request_id').notNull().references(() => agentDataRequests.id),
  requestedVersion: integer('requested_version').notNull(),
}, (table) => [primaryKey({ columns: [table.kind, table.jobId] })]);

export const agentBacktestDatasets = sqliteTable('agent_backtest_datasets', {
  jobId: text('job_id').primaryKey().references(() => backtestJobs.id, { onDelete: 'cascade' }),
  datasetVersion: integer('dataset_version').notNull(),
});
