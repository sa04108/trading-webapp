import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  "symbols",
  {
    code: text("code").primaryKey(),
    market: text("market").notNull(),
    /** 표시명 — 외부 조회가 실패하거나 소스가 없으면 null */
    name: text("name"),
    /** KRX 표준코드(ISIN). 스냅샷 등록 시에만 채워진다 — 단축코드 재사용을 구분하는 유일한 열쇠 */
    standardCode: text("standard_code"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    index("idx_symbols_market").on(table.market),
    uniqueIndex("idx_symbols_standard_code").on(table.standardCode),
  ],
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
export const symbolFactsState = sqliteTable("symbol_facts_state", {
  code: text("code")
    .primaryKey()
    .references(() => symbols.code, { onDelete: "cascade" }),
  /** number[] 오름차순 JSON */
  coveredYearsJson: text("covered_years_json").notNull(),
  /** 현재 재무 parser·gap·fact manifest 프로토콜로 검증한 종목/연도 상태 JSON */
  financialCoverageProtocolJson: text("financial_coverage_protocol_json"),
  /** 자본변동을 수집한 연도 (number[] 오름차순 JSON). 제출 게이트가 읽는다 */
  actionCoveredYearsJson: text("action_covered_years_json"),
  /** 자본변동 수집에서 gap 이 난 연도 (number[] 오름차순 JSON). 상세 조회의 fallback */
  actionGapYearsJson: text("action_gap_years_json"),
  /** 자본변동 gap의 원문 기준일·사유·심각도. 재수집한 연도 단위로 교체한다 */
  actionGapDetailsJson: text("action_gap_details_json"),
  /** 현재 gap/정렬 해석 프로토콜로 다시 검증한 연도와 버전 JSON */
  actionCoverageProtocolJson: text("action_coverage_protocol_json"),
  /** 재무 수집만 전진시키는 공시검색 watermark */
  financialUpdatedAtMs: integer("financial_updated_at_ms"),
  /** 자본변동 수집만 전진시키는 공시검색 watermark */
  actionUpdatedAtMs: integer("action_updated_at_ms"),
});

/**
 * 재무 증분 수집까지 반영한 DART 정기공시 접수번호.
 *
 * `symbol_facts_state.financial_updated_at_ms` 는 날짜보다 정밀하지만 공시검색 API는 접수일만
 * 돌려준다. watermark 당일을 다시 조회하면서도 같은 공시를 매 실행마다 재수집하지
 * 않으려면 접수번호를 별도로 기억해야 한다. 행은 팩트 저장과 버전 반영이 성공한 뒤에만
 * 추가한다 — 실패한 공시는 다음 실행에서 다시 시도한다.
 */
export const dartFinancialFilingReceipts = sqliteTable(
  "dart_financial_filing_receipts",
  {
    receiptNo: text("receipt_no").primaryKey(),
    code: text("code")
      .notNull()
      .references(() => symbols.code, { onDelete: "cascade" }),
    businessYear: integer("business_year").notNull(),
    receiptDate: text("receipt_date").notNull(),
    processedAtMs: integer("processed_at_ms").notNull(),
  },
  (table) => [
    index("idx_dart_financial_filing_receipts_code_year").on(
      table.code,
      table.businessYear,
    ),
  ],
);

/**
 * point-in-time 팩트. periodKey는 재무 기준 기간이고 asOfTsMs는 시장에 알려진 시각이다.
 * 같은 기간의 정정공시는 asOfTsMs가 다른 새 행으로 남는다.
 */
export const facts = sqliteTable(
  "facts",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    field: text("field").notNull(),
    periodKey: text("period_key").notNull(),
    asOfTsMs: integer("as_of_ts_ms").notNull(),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    /** 복합 KRX 변경에서도 DART 사건을 식별하는 절대 주식수 앵커 */
    corporateActionBeforeShares: integer("corporate_action_before_shares"),
    corporateActionAfterShares: integer("corporate_action_after_shares"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.scope,
        table.key,
        table.field,
        table.periodKey,
        table.asOfTsMs,
      ],
    }),
    index("idx_facts_pit").on(
      table.scope,
      table.key,
      table.field,
      table.asOfTsMs,
    ),
    check("chk_facts_scope", sql`${table.scope} IN ('SYMBOL', 'MACRO')`),
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
  "symbol_versions",
  {
    id: text("id").primaryKey(),
    code: text("code")
      .notNull()
      .references(() => symbols.code, { onDelete: "cascade" }),
    slice: text("slice").notNull(),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    index("idx_symbol_versions_code_slice").on(table.code, table.slice),
  ],
);

/** Market/fact writes advance this revision in the same SQLite transaction. */
export const preparationDataRevision = sqliteTable(
  "preparation_data_revision",
  {
    singleton: integer("singleton").primaryKey(),
    revision: integer("revision").notNull().default(0),
    armed: integer("armed", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    check("chk_preparation_revision_singleton", sql`${table.singleton} = 1`),
  ],
);

// ── 종목 마스터 (설계 2026-08-05-symbol-master) ──────────────────────

/**
 * 종목 상태 SCD Type 2 버전. 유효 구간은 [validFromDate, validToDate) 다.
 * 종목 상태가 바뀐 날에만 새 행을 남기며 validToDate=null 은 알려진 미래
 * 구간까지 계속 유효함을 뜻한다.
 */
export const symbolMasterVersions = sqliteTable(
  "symbol_master_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    standardCode: text("standard_code").notNull(),
    validFromDate: text("valid_from_date").notNull(),
    validToDate: text("valid_to_date"),
    shortCode: text("short_code").notNull(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    /** 10진 정수 문자열 — bigint 정밀도를 그대로 보존한다 */
    sharesOutstanding: text("shares_outstanding").notNull(),
    instrumentType: text("instrument_type").notNull(),
    listedDate: text("listed_date"),
    recordedAtMs: integer("recorded_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("idx_smv_code_from").on(
      table.standardCode,
      table.validFromDate,
    ),
    uniqueIndex("idx_smv_open_code")
      .on(table.standardCode)
      .where(sql`${table.validToDate} IS NULL`),
    index("idx_smv_short_code").on(table.shortCode),
    index("idx_smv_asof").on(table.validFromDate, table.validToDate),
    index("idx_smv_valid_to").on(table.validToDate),
    check(
      "chk_smv_valid_range",
      sql`${table.validToDate} IS NULL OR ${table.validToDate} > ${table.validFromDate}`,
    ),
  ],
);

/** 수집 완료 구간. 휴장일도 구간에 포함한다 — 이벤트만 없다 */
export const symbolMasterCoverage = sqliteTable("symbol_master_coverage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  syncedAtMs: integer("synced_at_ms").notNull(),
  /** 이 구간을 마지막으로 검증한 수집 코드 버전. null은 재수집이 필요한 과거 표식이다. */
  collectionVersion: text("collection_version"),
});

/**
 * 그날 거래할 수 없었던 종목 (거래정지·무거래). 봉이 아니라 사실 기록이다.
 *
 * `krx_daily_bars` 에 섞지 않는 이유: KRX 는 시·고·저를 주지 않는다. 봉으로 채우려면
 * 없는 가격을 지어내야 한다. 테이블을 나눠 두면 청산 코드가 `lastClose` 를 체결가로
 * 쓰는 실수를 타입 경계에서 막을 수 있다.
 */
export const krxNonTradingDays = sqliteTable(
  "krx_non_trading_days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    shortCode: text("short_code").notNull(),
    market: text("market").notNull(), // KOSPI | KOSDAQ
    /** TDD_CLSPRC 원값 — **평가용이지 체결 가능 가격이 아니다** */
    lastClose: integer("last_close").notNull(),
  },
  (table) => [
    uniqueIndex("idx_kntd_date_code").on(table.date, table.shortCode),
    index("idx_kntd_date").on(table.date),
  ],
);

/**
 * 거래불가일을 채운 날짜 구간. 행이 없는 날짜가 "거래불가 종목이 없었다" 인지
 * "아직 모른다" 인지는 이 기록으로만 갈린다. symbol_master_coverage 와 같은 구조다.
 */
export const krxNonTradingCoverage = sqliteTable("krx_non_trading_coverage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  syncedAtMs: integer("synced_at_ms").notNull(),
  /** 이 구간을 마지막으로 검증한 수집 코드 버전. null은 재수집이 필요한 과거 표식이다. */
  collectionVersion: text("collection_version"),
});

/** 시총 랭킹 레이지 캐시 — 백테스트가 요청한 날짜만 쌓인다 (스펙 §데이터 모델) */
export const symbolMasterMarketCaps = sqliteTable(
  "symbol_master_market_caps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    standardCode: text("standard_code").notNull(),
    marketCapKrw: text("market_cap_krw").notNull(),
  },
  (table) => [
    uniqueIndex("idx_smmc_date_code").on(table.date, table.standardCode),
  ],
);

/**
 * 날짜별 유니버스 선정 지표. 금액은 SQLite integer 범위와 JavaScript number 정밀도를
 * 넘을 수 있어 10진 text 로 보관하고, repository 경계에서만 bigint 로 바꾼다.
 */
export const dailySelectionMetrics = sqliteTable(
  "daily_selection_metrics",
  {
    date: text("date").notNull(),
    standardCode: text("standard_code").notNull(),
    marketCapKrw: text("market_cap_krw"),
    volume: integer("volume"),
    tradingValueKrw: text("trading_value_krw"),
  },
  (table) => [primaryKey({ columns: [table.date, table.standardCode] })],
);

/**
 * KRX 일별매매 API에서 선정 지표를 한 번 온전히 조회한 날짜.
 *
 * 지표 행과 분리한다. 거래대금이 모든 종목에서 '-'인 정상 응답은 non-null 값이
 * 하나도 없어 행만으로 "미조회"와 구분할 수 없기 때문이다.
 */
export const dailySelectionMetricCoverage = sqliteTable(
  "daily_selection_metric_coverage",
  {
    date: text("date").primaryKey(),
    syncedAtMs: integer("synced_at_ms").notNull(),
    /** 이 구간을 마지막으로 검증한 수집 코드 버전. null은 재수집이 필요한 과거 표식이다. */
    collectionVersion: text("collection_version"),
  },
);

/**
 * 실제로 거래가 있었던 날짜만 담는다. 휴장일과 무변화 거래일은 이벤트 건수로
 * 구별되지 않으므로, "거래일이었다"는 사실 자체를 별도로 남겨야 재구성 앵커를
 * 정확히 짚을 수 있다.
 */
export const symbolMasterTradingDays = sqliteTable(
  "symbol_master_trading_days",
  {
    date: text("date").primaryKey(),
  },
);

/**
 * 일별매매 OHLCV (설계 2026-08-06-krx-daily-bars).
 *
 * 기본 키가 (shortCode, date) 다 — 같은 날짜를 다시 수집해도 덮어쓰기만 하면 되고,
 * 읽기는 종목 하나의 기간 조회라 이 순서가 맞다. 거래대금(ACC_TRDVAL)은 쓰는 곳이
 * 없어 저장하지 않는다(YAGNI).
 */
export const krxDailyBars = sqliteTable(
  "krx_daily_bars",
  {
    /** 단축 종목코드 — 일별매매 응답의 ISU_CD 다(이름과 달리 단축코드다) */
    shortCode: text("short_code").notNull(),
    date: text("date").notNull(),
    market: text("market").notNull(),
    open: integer("open").notNull(),
    high: integer("high").notNull(),
    low: integer("low").notNull(),
    close: integer("close").notNull(),
    volume: integer("volume").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shortCode, table.date] }),
    // 날짜 단위 삭제·점검용 인덱스
    index("idx_krx_daily_bars_date").on(table.date),
  ],
);

/** 벤치마크 지수 일별 종가. 소수 지수값이므로 종목 원화 봉과 분리한다. */
export const benchmarkDailyValues = sqliteTable(
  "benchmark_daily_values",
  {
    benchmarkId: text("benchmark_id").notNull(),
    date: text("date").notNull(),
    close: real("close").notNull(),
    syncedAtMs: integer("synced_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.benchmarkId, table.date] }),
    index("idx_benchmark_daily_values_date").on(table.date),
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
  "fred_benchmark_coverage",
  {
    benchmarkId: text("benchmark_id").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    syncedAtMs: integer("synced_at_ms").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.benchmarkId, table.startDate, table.endDate],
    }),
  ],
);
export const datasetState = sqliteTable(
  "dataset_state",
  {
    singleton: integer("singleton").primaryKey(),
    datasetId: text("dataset_id").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [check("data_singleton_one", sql`${table.singleton} = 1`)],
);
