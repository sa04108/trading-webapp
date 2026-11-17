import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";
import { intradayRequestSchema } from "../../../../shared/schemas/intraday.js";
import { getIntradayStrategy } from "../../../../shared/schemas/intraday-strategies.js";
import type { StrategyRegistry } from "../../../../runtime/modules/strategy/application/strategy-registry.js";
import type { IntradayService } from "../../intraday/application/intraday-service.js";
import { IntradayError } from "../../intraday/application/intraday-service.js";
import { ConfigurationSearchError, type ConfigurationSearchAdapter } from "./configuration-search-service.js";
import { intradaySearchCatalog, sampleConfigurations } from "./configuration-search-catalog.js";

export function createIntradaySearchAdapter(database: DatabaseHandle, runs: IntradayService, strategies: StrategyRegistry): ConfigurationSearchAdapter {
  const identity: ConfigurationSearchAdapter["runtimeIdentity"] = raw => {
    const request = intradayRequestSchema.parse(raw);
    return JSON.stringify({ execution: readRuntimeVersions().executionVersion, strategy: getIntradayStrategy(request.strategyId).version });
  };
  return {
    source: (owner, id) => {
      const source = runs.getRunRequest(owner, id);
      if (!["COMPLETED", "FAILED", "CANCELLED"].includes(source.status)) throw new ConfigurationSearchError("종료된 백테스트에서 설정 탐색을 시작하세요.", 409);
      return { request: source.request, catalog: intradaySearchCatalog(id, source.request), runtimeIdentity: identity(source.request) };
    },
    sample: (source, config) => sampleConfigurations(source.request, source.catalog, config, strategies),
    runtimeIdentity: identity,
    buildSubmission: async (owner, raw) => {
      const request = intradayRequestSchema.parse(raw);
      return () => {
        try { const id = randomUUID(); runs.createInternalRun(owner, request, id); return id; }
        catch (error) { if (error instanceof IntradayError && error.statusCode === 429) return null; throw error; }
      };
    },
    afterSubmit: (owner, id, raw) => runs.startInternalRun(owner, id, intradayRequestSchema.parse(raw)),
    job: (owner, id) => {
      // 큰 결과 JSON 전체를 읽지 않고 필요한 성과 값만 SQLite에서 꺼낸다.
      const row = database.sqlite.prepare(`SELECT status, error,
        json_extract(result_json, '$.metrics.returnPct') AS returnPct,
        json_extract(result_json, '$.metrics.maxDrawdownPct') AS mdd,
        json_extract(result_json, '$.metrics.sharpe') AS sharpe
        FROM intraday_runs WHERE id=? AND owner_id=?`).get(id, owner) as { status: string; error: string | null; returnPct: number | null; mdd: number | null; sharpe: number | null } | undefined;
      return row ? { status: row.status === "CANCELLED" && runs.isDraining(id) ? "CANCELLING" : row.status, error: row.error, metrics: row.status === "COMPLETED" && row.returnPct !== null && row.mdd !== null ? { totalReturnPct: row.returnPct, mddPct: row.mdd, sharpeRatio: row.sharpe } : null } : null;
    },
    cancelJob: (owner, id) => { runs.cancelRun(owner, id); },
    deleteJob: (owner, id) => { if (runs.isDraining(id)) throw new ConfigurationSearchError("아직 종료 처리 중인 백테스트입니다.", 409); runs.deleteRunHistory(owner, id); },
  };
}
