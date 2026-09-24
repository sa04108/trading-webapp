import Database from "better-sqlite3";
import process from "node:process";

// 검증 진입점의 수신기를 감싸야 모듈 로딩 전에 IPC 입력을 먼저 소비하지 않는다.
const once = process.once;
process.once = function (event, listener) {
  if (event !== "message") return once.call(this, event, listener);
  process.once = once;
  return once.call(this, event, (...args) => {
    const db = new Database(":memory:");
    try {
      process.send?.({ type: "test.sql.started" });
      db.prepare(`WITH RECURSIVE numbers(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 3000000
      ) SELECT sum(value) FROM numbers`).get();
    } finally { db.close(); }
    listener(...args);
  });
};
