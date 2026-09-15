import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
    agentId: text('agent_id'),
    pid: integer('pid'),
    /** 에이전트 임대 시도 번호. 새 claim마다 증가해 이전 시도의 늦은 완료를 거부한다. */
    attempt: integer('attempt').notNull().default(0),
    /** lease 원문은 저장하지 않고 SHA-256만 저장한다. */
    leaseTokenHash: text('lease_token_hash'),
    leaseExpiresAtMs: integer('lease_expires_at_ms'),
    /** 작업과 결과의 계산 호환성을 확인하는 executionVersion. */
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

export const operationalDatabaseState = sqliteTable('operational_database_state', {
  singleton: integer('singleton').primaryKey(),
  datasetId: text('dataset_id').notNull(),
}, (table) => [check('operations_singleton_one', sql`${table.singleton} = 1`)]);
