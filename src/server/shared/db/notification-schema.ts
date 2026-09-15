import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 사용자 알림 (설계 2026-08-03-notification-center).
 * 전역이다 — backtest_jobs·data_sync_jobs 에 user_id 가 없는 것과 같은 이유로,
 * 이 시스템의 작업은 전부 전역 자원이고 읽음 플래그도 행에 직접 둔다.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // 'backtest' | 'data-sync'
    severity: text("severity").notNull(), // 'info' | 'error'
    title: text("title").notNull(),
    body: text("body"),
    /** 알림을 눌렀을 때 갈 곳. 대상이 삭제됐어도 남는다 — 404 가 출처 불명보다 낫다 */
    link: text("link"),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [index("idx_notifications_created").on(table.createdAtMs)],
);
