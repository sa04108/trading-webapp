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
