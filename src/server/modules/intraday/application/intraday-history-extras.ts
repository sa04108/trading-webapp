import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { BacktestHistoryExtras } from "../../../../shared/schemas/backtest-experiments.js";
import { intradayRuns } from "../../../shared/db/intraday-schema.js";
import { intradayValidations as experiments, intradayValidationTrials as trials } from "../../../shared/db/intraday-validation-schema.js";
import { distribution, searchCounts } from "../../backtest/application/history-summary.js";
import { IntradayError } from "./intraday-service.js";

export function intradayHistoryExtras(database: DatabaseHandle, owner: string, ids: string[]): BacktestHistoryExtras[] {
  const db = database.db;
  const sources = db.select({ id: intradayRuns.id }).from(intradayRuns)
    .where(and(eq(intradayRuns.ownerId, owner), inArray(intradayRuns.id, ids))).all();
  if (sources.length !== ids.length) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);

  // 완료된 실험의 OOS만 펼친다. 학습 후보의 실행 결과, 요청 및 검증 계획은 목록에 필요하지 않다.
  const rows = db.select({
    source: experiments.sourceJobId, status: experiments.status,
    mode: sql<string>`json_extract(${experiments.configJson}, '$.mode')`,
    // 단 한 회차라도 미평가·불완전하면 나머지 회차의 부분 평균을 표시하지 않는다.
    meanReturn: sql<number | null>`CASE WHEN MIN(CASE WHEN
      ${intradayRuns.status} = 'COMPLETED' AND ${trials.skipReason} IS NULL
      AND json_type(${trials.metricsJson}, '$.totalReturnPct') IN ('real', 'integer')
      AND json_type(${trials.metricsJson}, '$.intradayDaily.isComplete') IS NOT 'false'
      THEN 1 ELSE 0 END) = 1 THEN AVG(json_extract(${trials.metricsJson}, '$.totalReturnPct')) END`,
  }).from(experiments)
    .leftJoin(trials, and(eq(trials.validationId, experiments.id), eq(trials.role, "OOS"), eq(experiments.status, "COMPLETED")))
    .leftJoin(intradayRuns, and(eq(intradayRuns.id, trials.runId), eq(intradayRuns.ownerId, owner)))
    .where(and(eq(experiments.ownerId, owner), inArray(experiments.sourceJobId, ids)))
    .groupBy(experiments.id).all();

  const searches = searchCounts(database, "intraday", ids, owner);
  const summaries = new Map(ids.map(jobId => [jobId, {
    jobId, search: searches(jobId),
    validation: { experimentCount: 0, activeCount: 0, completedCount: 0, returns: distribution([]), modes: { HOLDOUT: 0, WALK_FORWARD: 0 } },
  }]));
  const samples = new Map<string, number[]>();
  for (const row of rows) {
    const { validation } = summaries.get(row.source)!;
    validation.experimentCount++;
    if (row.mode === "WALK_FORWARD") validation.modes.WALK_FORWARD++;
    if (row.mode === "HOLDOUT" || row.mode === "OPTIMIZED_HOLDOUT") validation.modes.HOLDOUT++;
    if (row.status === "ACTIVE" || row.status === "CANCELLING") validation.activeCount++;
    if (row.status === "COMPLETED") validation.completedCount++;
    if (row.meanReturn !== null && Number.isFinite(row.meanReturn)) {
      const values = samples.get(row.source) ?? [];
      values.push(row.meanReturn);
      samples.set(row.source, values);
    }
  }
  for (const [source, values] of samples) summaries.get(source)!.validation.returns = distribution(values);
  return [...summaries.values()];
}
