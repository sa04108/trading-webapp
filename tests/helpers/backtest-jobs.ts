import { backtestJobs } from '../../src/server/shared/db/schema.js';
import type { DatabaseHandle } from '../../src/server/shared/db/database.js';

/** 내부 자식 작업까지 포함해 테스트에서 저장된 전체 작업을 확인한다. */
export function readBacktestJobs(database: DatabaseHandle) {
  return database.db.select().from(backtestJobs).all();
}
