import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
