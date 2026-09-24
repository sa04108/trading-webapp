import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** 조회와 부분 인덱스가 같은 유효 봉 조건을 사용해야 원본 행을 다시 읽지 않는다. */
export function validDailyBar(table: {
  readonly market: AnyColumn;
  readonly open: AnyColumn;
  readonly high: AnyColumn;
  readonly low: AnyColumn;
  readonly close: AnyColumn;
  readonly volume: AnyColumn;
}): SQL {
  // 고정 조건을 바인딩 변수로 바꾸면 SQLite가 부분 인덱스의 포함 관계를 증명하지 못한다.
  return sql`${table.market} IN ('KOSPI', 'KOSDAQ')
    AND ${table.open} > 0 AND ${table.high} > 0 AND ${table.low} > 0 AND ${table.close} > 0
    AND ${table.volume} >= 0
    AND ${table.high} >= ${table.low} AND ${table.high} >= ${table.open} AND ${table.high} >= ${table.close}
    AND ${table.low} <= ${table.open} AND ${table.low} <= ${table.close}`;
}
