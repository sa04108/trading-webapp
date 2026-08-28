/**
 * SQLite 메타데이터 스키마 (스펙 §12).
 * 테이블은 Phase 진행에 따라 추가된다. drizzle-kit generate 로 migrations/ 를 생성한다.
 * schema_migrations 역할은 drizzle 의 __drizzle_migrations 테이블이 담당한다.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    /** KRX 표준코드(ISIN). 스냅샷 등록 시에만 채워진다 — 단축코드 재사용을 구분하는 유일한 열쇠 */
    standardCode: text('standard_code'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    index('idx_symbols_market').on(table.market),
    uniqueIndex('idx_symbols_standard_code').on(table.standardCode),
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
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
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
 *
 * **행 존재를 "재무를 수집했다" 신호로 쓰면 안 된다.** 자본변동 전용 수집 경로가
 * 재무보다 먼저 행을 만들 수 있다(`SqliteCorporateActionCoverageStore.addCoverageResult`).
 * 그 행의 `coveredYearsJson` 은 빈 배열이다. 재무 수집 여부는 반드시
 * `coveredYearsJson` 의 배열 내용으로 판정해야 한다.
 */
export const symbolFactsState = sqliteTable('symbol_facts_state', {
  code: text('code')
    .primaryKey()
    .references(() => symbols.code, { onDelete: 'cascade' }),
  /** number[] 오름차순 JSON */
  coveredYearsJson: text('covered_years_json').notNull(),
  /** 현재 재무 parser·gap·fact manifest 프로토콜로 검증한 종목/연도 상태 JSON */
  financialCoverageProtocolJson: text('financial_coverage_protocol_json'),
  /** 자본변동을 수집한 연도 (number[] 오름차순 JSON). 제출 게이트가 읽는다 */
  actionCoveredYearsJson: text('action_covered_years_json'),
  /** 자본변동 수집에서 gap 이 난 연도 (number[] 오름차순 JSON). 상세 조회의 fallback */
  actionGapYearsJson: text('action_gap_years_json'),
  /** 자본변동 gap의 원문 기준일·사유·심각도. 재수집한 연도 단위로 교체한다 */
  actionGapDetailsJson: text('action_gap_details_json'),
  /** 현재 gap/정렬 해석 프로토콜로 다시 검증한 연도와 버전 JSON */
  actionCoverageProtocolJson: text('action_coverage_protocol_json'),
  /** 과거 마이그레이션 호환용 최종 갱신 시각. 새 watermark 판정에는 쓰지 않는다 */
  updatedAtMs: integer('updated_at_ms').notNull(),
  /** 재무 수집만 전진시키는 공시검색 watermark */
  financialUpdatedAtMs: integer('financial_updated_at_ms'),
  /** 자본변동 수집만 전진시키는 공시검색 watermark */
  actionUpdatedAtMs: integer('action_updated_at_ms'),
});

/**
 * 재무 증분 수집까지 반영한 DART 정기공시 접수번호.
 *
 * `symbol_facts_state.updated_at_ms` 는 날짜보다 정밀하지만 공시검색 API는 접수일만
 * 돌려준다. watermark 당일을 다시 조회하면서도 같은 공시를 매 실행마다 재수집하지
 * 않으려면 접수번호를 별도로 기억해야 한다. 행은 팩트 저장과 버전 반영이 성공한 뒤에만
 * 추가한다 — 실패한 공시는 다음 실행에서 다시 시도한다.
 */
export const dartFinancialFilingReceipts = sqliteTable(
  'dart_financial_filing_receipts',
  {
    receiptNo: text('receipt_no').primaryKey(),
    code: text('code')
      .notNull()
      .references(() => symbols.code, { onDelete: 'cascade' }),
    businessYear: integer('business_year').notNull(),
    receiptDate: text('receipt_date').notNull(),
    processedAtMs: integer('processed_at_ms').notNull(),
  },
  (table) => [
    index('idx_dart_financial_filing_receipts_code_year').on(table.code, table.businessYear),
  ],
);

/**
 * point-in-time 팩트. periodKey는 재무 기준 기간이고 asOfTsMs는 시장에 알려진 시각이다.
 * 같은 기간의 정정공시는 asOfTsMs가 다른 새 행으로 남는다.
 */
export const facts = sqliteTable(
  'facts',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    field: text('field').notNull(),
    periodKey: text('period_key').notNull(),
    asOfTsMs: integer('as_of_ts_ms').notNull(),
    value: real('value').notNull(),
    unit: text('unit').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.key, table.field, table.periodKey, table.asOfTsMs],
    }),
    index('idx_facts_pit').on(table.scope, table.key, table.field, table.asOfTsMs),
    check('chk_facts_scope', sql`${table.scope} IN ('SYMBOL', 'MACRO')`),
  ],
);

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
    status: text('status').notNull(),
    phase: text('phase').notNull(),
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

// ── 백테스트 (스펙 §10, §12) ──────────────────────────────────────

export const backtestJobs = sqliteTable(
  'backtest_jobs',
  {
    id: text('id').primaryKey(),
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

// ── 종목 마스터 (설계 2026-08-05-symbol-master) ──────────────────────

/**
 * 종목 상태 SCD Type 2 버전. 유효 구간은 [validFromDate, validToDate) 다.
 * 종목 상태가 바뀐 날에만 새 행을 남기며 validToDate=null 은 알려진 미래
 * 구간까지 계속 유효함을 뜻한다.
 */
export const symbolMasterVersions = sqliteTable(
  'symbol_master_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    standardCode: text('standard_code').notNull(),
    validFromDate: text('valid_from_date').notNull(),
    validToDate: text('valid_to_date'),
    shortCode: text('short_code').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull(),
    /** 10진 정수 문자열 — bigint 정밀도를 그대로 보존한다 */
    sharesOutstanding: text('shares_outstanding').notNull(),
    instrumentType: text('instrument_type').notNull(),
    listedDate: text('listed_date'),
    recordedAtMs: integer('recorded_at_ms').notNull(),
  },
  (table) => [
    uniqueIndex('idx_smv_code_from').on(table.standardCode, table.validFromDate),
    uniqueIndex('idx_smv_open_code')
      .on(table.standardCode)
      .where(sql`${table.validToDate} IS NULL`),
    index('idx_smv_short_code').on(table.shortCode),
    index('idx_smv_asof').on(table.validFromDate, table.validToDate),
    index('idx_smv_valid_to').on(table.validToDate),
    check(
      'chk_smv_valid_range',
      sql`${table.validToDate} IS NULL OR ${table.validToDate} > ${table.validFromDate}`,
    ),
  ],
);

/** legacy 체크포인트+이벤트 이력을 SCD 버전으로 원자적 변환했는지 표시한다. */
export const symbolMasterStorageState = sqliteTable(
  'symbol_master_storage_state',
  {
    singleton: integer('singleton').primaryKey(),
    phase: text('phase').notNull(), // PENDING | ACTIVE
    migratedAtMs: integer('migrated_at_ms'),
  },
  (table) => [
    check('chk_sms_singleton', sql`${table.singleton} = 1`),
    check('chk_sms_phase', sql`${table.phase} IN ('PENDING', 'ACTIVE')`),
  ],
);

// 아래 세 테이블은 SCD 이행 전 데이터 보존용 legacy 구조다.
// 신규 수집과 조회에서는 사용하지 않고, 후속 contract 마이그레이션 전까지만 남겨 둔다.
/** 분기 체크포인트 메타데이터 — legacy 이행 전용. */
export const symbolMasterCheckpoints = sqliteTable('symbol_master_checkpoints', {
  id: text('id').primaryKey(),
  checkpointDate: text('checkpoint_date').notNull().unique(),
  source: text('source').notNull(), // KRX
  verifiedAtMs: integer('verified_at_ms'),
  mismatchJson: text('mismatch_json'),
  createdAtMs: integer('created_at_ms').notNull(),
});

/** symbols 에 FK 를 걸지 않는다 — 마스터는 미등록·폐지 종목도 담는다 */
export const symbolMasterCheckpointSymbols = sqliteTable(
  'symbol_master_checkpoint_symbols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    checkpointId: text('checkpoint_id')
      .notNull()
      .references(() => symbolMasterCheckpoints.id, { onDelete: 'cascade' }),
    standardCode: text('standard_code').notNull(),
    shortCode: text('short_code').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull(), // KOSPI | KOSDAQ
    /** 10진 정수 문자열 — bigint 를 그대로 보존한다 */
    sharesOutstanding: text('shares_outstanding').notNull(),
    /** COMMON_STOCK 또는 KrxExclusionReason — 필터 정책은 읽기 시점에 적용한다 */
    instrumentType: text('instrument_type').notNull(),
    listedDate: text('listed_date'),
  },
  (table) => [
    uniqueIndex('idx_smcs_checkpoint_code').on(table.checkpointId, table.standardCode),
  ],
);

/**
 * 변경 이벤트(delta). old/newValue 는 절대값 JSON 이라 중복 적용해도 결과가 같다.
 * observedSpanStart: diff 기준일 — 갭을 건너뛴 수집이면 이벤트 날짜가 근사값이다.
 */
export const symbolMasterEvents = sqliteTable(
  'symbol_master_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    effectiveDate: text('effective_date').notNull(),
    standardCode: text('standard_code').notNull(),
    // LISTED | DELISTED | MARKET_MOVED | SHARES_CHANGED | NAME_CHANGED | TYPE_CHANGED
    eventType: text('event_type').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    observedSpanStart: text('observed_span_start').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [
    index('idx_sme_effective').on(table.effectiveDate),
    index('idx_sme_code_effective').on(table.standardCode, table.effectiveDate),
  ],
);

/** 수집 완료 구간. 휴장일도 구간에 포함한다 — 이벤트만 없다 */
export const symbolMasterCoverage = sqliteTable('symbol_master_coverage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  syncedAtMs: integer('synced_at_ms').notNull(),
});

/**
 * 그날 거래할 수 없었던 종목 (거래정지·무거래). 봉이 아니라 사실 기록이다.
 *
 * `krx_daily_bars` 에 섞지 않는 이유: KRX 는 시·고·저를 주지 않는다. 봉으로 채우려면
 * 없는 가격을 지어내야 한다. 테이블을 나눠 두면 청산 코드가 `lastClose` 를 체결가로
 * 쓰는 실수를 타입 경계에서 막을 수 있다.
 */
export const krxNonTradingDays = sqliteTable(
  'krx_non_trading_days',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    shortCode: text('short_code').notNull(),
    market: text('market').notNull(), // KOSPI | KOSDAQ
    /** TDD_CLSPRC 원값 — **평가용이지 체결 가능 가격이 아니다** */
    lastClose: integer('last_close').notNull(),
  },
  (table) => [
    uniqueIndex('idx_kntd_date_code').on(table.date, table.shortCode),
    index('idx_kntd_date').on(table.date),
  ],
);

/**
 * 거래불가일을 채운 날짜 구간. 행이 없는 날짜가 "거래불가 종목이 없었다" 인지
 * "아직 모른다" 인지는 이 기록으로만 갈린다. symbol_master_coverage 와 같은 구조다.
 */
export const krxNonTradingCoverage = sqliteTable('krx_non_trading_coverage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  syncedAtMs: integer('synced_at_ms').notNull(),
});

/** 시총 랭킹 레이지 캐시 — 백테스트가 요청한 날짜만 쌓인다 (스펙 §데이터 모델) */
export const symbolMasterMarketCaps = sqliteTable(
  'symbol_master_market_caps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    standardCode: text('standard_code').notNull(),
    marketCapKrw: text('market_cap_krw').notNull(),
  },
  (table) => [uniqueIndex('idx_smmc_date_code').on(table.date, table.standardCode)],
);

/**
 * 날짜별 유니버스 선정 지표. 금액은 SQLite integer 범위와 JavaScript number 정밀도를
 * 넘을 수 있어 10진 text 로 보관하고, repository 경계에서만 bigint 로 바꾼다.
 */
export const dailySelectionMetrics = sqliteTable(
  'daily_selection_metrics',
  {
    date: text('date').notNull(),
    standardCode: text('standard_code').notNull(),
    marketCapKrw: text('market_cap_krw'),
    volume: integer('volume'),
    tradingValueKrw: text('trading_value_krw'),
  },
  (table) => [primaryKey({ columns: [table.date, table.standardCode] })],
);

/**
 * 실제로 거래가 있었던 날짜만 담는다. 휴장일과 무변화 거래일은 이벤트 건수로
 * 구별되지 않으므로, "거래일이었다"는 사실 자체를 별도로 남겨야 재구성 앵커를
 * 정확히 짚을 수 있다.
 */
export const symbolMasterTradingDays = sqliteTable('symbol_master_trading_days', {
  date: text('date').primaryKey(),
});

/**
 * 일별매매 OHLCV (설계 2026-08-06-krx-daily-bars).
 *
 * 기본 키가 (shortCode, date) 다 — 같은 날짜를 다시 수집해도 덮어쓰기만 하면 되고,
 * 읽기는 종목 하나의 기간 조회라 이 순서가 맞다. 거래대금(ACC_TRDVAL)은 쓰는 곳이
 * 없어 저장하지 않는다(YAGNI).
 */
export const krxDailyBars = sqliteTable(
  'krx_daily_bars',
  {
    /** 단축 종목코드 — 일별매매 응답의 ISU_CD 다(이름과 달리 단축코드다) */
    shortCode: text('short_code').notNull(),
    date: text('date').notNull(),
    market: text('market').notNull(),
    open: integer('open').notNull(),
    high: integer('high').notNull(),
    low: integer('low').notNull(),
    close: integer('close').notNull(),
    volume: integer('volume').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shortCode, table.date] }),
    // 날짜 단위 삭제·점검용 인덱스
    index('idx_krx_daily_bars_date').on(table.date),
  ],
);

/** 벤치마크 지수 일별 종가. 소수 지수값이므로 종목 원화 봉과 분리한다. */
export const benchmarkDailyValues = sqliteTable(
  'benchmark_daily_values',
  {
    benchmarkId: text('benchmark_id').notNull(),
    date: text('date').notNull(),
    close: real('close').notNull(),
    syncedAtMs: integer('synced_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.benchmarkId, table.date] }),
    index('idx_benchmark_daily_values_date').on(table.date),
  ],
);

/**
 * 벤치마크 소스가 성공적으로 확인한 달력일 범위.
 *
 * 테이블 이름은 FRED 전용이던 초기 스키마와의 호환 때문에 유지한다. KRX도 빈 응답을
 * 휴장일의 근거로 남겨야 종목 마스터를 아직 수집하지 않은 새 백테스트 기간을 독립적으로
 * 판정할 수 있다. 행 존재만으로 내부 관측값을 추정하지는 않는다.
 */
export const fredBenchmarkCoverage = sqliteTable(
  'fred_benchmark_coverage',
  {
    benchmarkId: text('benchmark_id').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    syncedAtMs: integer('synced_at_ms').notNull(),
  },
  (table) => [primaryKey({ columns: [table.benchmarkId, table.startDate, table.endDate] })],
);
