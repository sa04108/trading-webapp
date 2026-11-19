import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { ExperimentReturnDistribution } from "../../../../shared/schemas/backtest-experiments.js";
import { configurationSearches } from "../../../shared/db/configuration-search-schema.js";

export function distribution(values: number[]): ExperimentReturnDistribution {
  const count = values.length;
  const mean = count ? values.reduce((sum, value) => sum + value / count, 0) : null;
  const variance = count > 1 ? values.reduce((sum, value) => sum + (value - mean!) ** 2 / (count - 1), 0) : null;
  return { count, mean: mean !== null && Number.isFinite(mean) ? mean : null,
    sampleStdDev: variance !== null && Number.isFinite(variance) ? Math.sqrt(variance) : null };
}

/** 목록에 보이는 원본의 스칼라 지표만 일괄 조회한다. 실험 결과 본문과 매매 시계열은 읽지 않는다. */
export function searchCounts(database: DatabaseHandle, mode: "daily" | "intraday", ids: string[], ownerId?: string) {
  const status = configurationSearches.status;
  const rows = database.db.select({
    source: configurationSearches.sourceJobId,
    experimentCount: count(),
    activeCount: sql<number>`COUNT(*) FILTER (WHERE ${status} IN ('ACTIVE', 'CANCELLING'))`,
    completedCount: sql<number>`COUNT(*) FILTER (WHERE ${status} = 'COMPLETED')`,
  }).from(configurationSearches)
    .where(and(eq(configurationSearches.mode, mode), ne(status, "PREVIEW"), inArray(configurationSearches.sourceJobId, ids),
      ownerId ? eq(configurationSearches.ownerId, ownerId) : undefined))
    .groupBy(configurationSearches.sourceJobId).all();
  const byId = new Map(rows.map(({ source, ...counts }) => [source, counts]));
  return (id: string) => byId.get(id) ?? { experimentCount: 0, activeCount: 0, completedCount: 0 };
}
