import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * 외부 API 일일 호출 원장.
 *
 * 프로세스 메모리가 아니라 앱 SQLite에 기록해 같은 KST 날짜에 서버가 재시작돼도
 * 호출 예산이 이어진다. quotaScope는 공급자의 실제 한도 단위다 — DART는 키 전체
 * (`daily`), KRX는 엔드포인트별 경로를 쓴다.
 */
export const externalApiDailyUsage = sqliteTable(
  "external_api_daily_usage",
  {
    api: text("api").notNull(),
    quotaScope: text("quota_scope").notNull(),
    usageDateKst: text("usage_date_kst").notNull(),
    callsUsed: integer("calls_used").notNull().default(0),
    /** 공급자 응답 또는 로컬 예산 판정으로 그날 한도 소진을 확인한 최초 시각 */
    quotaExceededAtMs: integer("quota_exceeded_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.api, table.quotaScope, table.usageDateKst] }),
    index("idx_external_api_daily_usage_date").on(table.usageDateKst),
  ],
);

/**
 * DART 파서가 소비하기 전의 API 응답 snapshot.
 *
 * coverage protocol은 파서·정렬 의미가 바뀌면 올라가지만, 원천 응답까지 바뀌었다는
 * 뜻은 아니다. 같은 원문을 다시 해석할 수 있도록 성공(000)과 무자료(013) 봉투를
 * 행 순서와 미사용 필드까지 JSON 그대로 보존한다. API key와 corp_code는 재생 입력이
 * 아니므로 저장하지 않는다.
 */
export const dartRawApiSnapshots = sqliteTable(
  "dart_raw_api_snapshots",
  {
    code: text("code").notNull(),
    endpoint: text("endpoint").notNull(),
    businessYear: integer("business_year").notNull(),
    reportCode: text("report_code").notNull(),
    /** 재무제표만 CFS/OFS, 나머지 엔드포인트는 NONE */
    fsDiv: text("fs_div").notNull(),
    payloadJson: text("payload_json").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAtMs: integer("fetched_at_ms").notNull(),
    /** 원문 저장 시 한 번 추출한다. 과거 NULL은 본문 재검증 없이 보존한다. */
    receiptNo: text("receipt_no"),
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
    index("idx_dart_raw_api_snapshots_fetched_at").on(table.fetchedAtMs),
    index("idx_dart_raw_report_metadata").on(table.code, table.businessYear, table.reportCode),
    check(
      "chk_dart_raw_api_snapshots_endpoint",
      sql`${table.endpoint} IN ('FINANCIAL_STATEMENT', 'SHARE_STATUS', 'ISSUANCE_STATUS')`,
    ),
    check(
      "chk_dart_raw_api_snapshots_report_code",
      sql`${table.reportCode} IN ('11013', '11012', '11014', '11011')`,
    ),
    check(
      "chk_dart_raw_api_snapshots_fs_div",
      sql`${table.fsDiv} IN ('CFS', 'OFS', 'NONE')`,
    ),
  ],
);

/** 공급자 응답 전체와 이력을 운영 DB에 보존한다. */
export const krxRawApiSnapshots = sqliteTable("krx_raw_api_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  namespace: text("namespace").notNull(),
  endpoint: text("endpoint").notNull(),
  basDd: text("bas_dd").notNull(),
  payloadJson: text("payload_json").notNull(),
  contentHash: text("content_hash").notNull(),
  fetchedAtMs: integer("fetched_at_ms").notNull(),
}, (table) => [index("idx_krx_raw_api_snapshots_key").on(table.namespace, table.endpoint, table.basDd)]);

/** 원문 요청의 최소 범위와 승인·취소·물리 재시도 이력. */
export const providerRequestPlans = sqliteTable("provider_request_plans", {
  fingerprint: text("fingerprint").primaryKey().notNull(),
  requestJson: text("request_json").notNull(), reason: text("reason").notNull(), evidence: text("evidence").notNull(),
  status: text("status").notNull(), attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5), createdAtMs: integer("created_at_ms").notNull(),
  decidedAtMs: integer("decided_at_ms"),
});
export const dartDiscoveryJobs = sqliteTable("dart_discovery_jobs", {
  windowDays: integer("window_days").notNull().default(80),
  day: text("day").primaryKey().notNull(), fromDate: text("from_date").notNull(), toDate: text("to_date").notNull(),
  page: integer("page").notNull(), status: text("status").notNull(), owner: text("owner"),
  leaseUntilMs: integer("lease_until_ms"), completedAtMs: integer("completed_at_ms"), error: text("error"),
}, (table) => [index("idx_dart_discovery_completed").on(table.status, table.toDate, table.completedAtMs)]);
export const dartDiscoveryPages = sqliteTable("dart_discovery_pages", {
  day: text("day").notNull(), fromDate: text("from_date").notNull(), page: integer("page").notNull(),
  payloadJson: text("payload_json").notNull(), fetchedAtMs: integer("fetched_at_ms").notNull(),
}, (table) => [primaryKey({columns:[table.day,table.fromDate,table.page]})]);
export const dartDiscoveredFilings = sqliteTable("dart_discovered_filings", {
  identity: text("identity").primaryKey().notNull(), receiptNo: text("receipt_no"), symbol: text("symbol"),
  businessYear: integer("business_year"), reportCode: text("report_code"), payloadJson: text("payload_json").notNull(),
  discoveredAtMs: integer("discovered_at_ms").notNull(), status: text("status").notNull(),
}, (table) => [
  index("idx_dart_filings_scope").on(table.symbol, table.businessYear, table.reportCode, table.receiptNo),
  index("idx_dart_filings_status").on(table.status),
]);
export const dartCorpCodeSnapshot = sqliteTable("dart_corp_code_snapshot", {
  namespace: text("namespace").primaryKey().notNull(), xml: text("xml").notNull(),
  contentHash: text("content_hash").notNull(), fetchedAtMs: integer("fetched_at_ms").notNull(),
});
export const dartRawApiSnapshotHistory = sqliteTable("dart_raw_api_snapshot_history", {
  id: integer("id").primaryKey({autoIncrement:true}), snapshotJson: text("snapshot_json").notNull(),
  archivedAtMs: integer("archived_at_ms").notNull(),
});
export const dartFilingEndpointCheckpoints = sqliteTable("dart_filing_endpoint_checkpoints", {
  receiptNo: text("receipt_no").notNull(), endpoint: text("endpoint").notNull(), fsDiv: text("fs_div").notNull(),
  status: text("status").notNull(), retryAfterMs: integer("retry_after_ms"),
}, (table) => [primaryKey({columns:[table.receiptNo,table.endpoint,table.fsDiv]})]);
/** 완료 결과의 입력 출처가 나중의 일일 확인으로 바뀌지 않도록 제출 시점 상태를 고정한다. */
export const providerExecutionProvenance = sqliteTable("provider_execution_provenance", {
  jobId: text("job_id").primaryKey().notNull(), freshnessJson: text("freshness_json").notNull(),
});
