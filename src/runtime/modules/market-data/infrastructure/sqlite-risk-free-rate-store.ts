import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { riskFreeRateHistorySchema, type RiskFreeRateHistory } from "../../../../shared/schemas/risk-free-rate.js";
import type { AppDatabase } from "../../../shared/db/database.js";
import { riskFreeRateHistory } from "../../../shared/db/data-schema.js";
import { RISK_FREE_RATE_SEED } from "../../backtest/domain/risk-free-rate-seed.js";

/** 같은 내용의 변경 이력은 수집 시각과 무관하게 같은 식별자를 갖는다. */
export function versionRateHistory(input: Omit<RiskFreeRateHistory, "version">): RiskFreeRateHistory {
  const parsed = riskFreeRateHistorySchema.parse({ ...input, version: "0".repeat(64) });
  const payload = {
    series: parsed.series, coveredFrom: parsed.coveredFrom, coveredTo: parsed.coveredTo,
    source: parsed.source, sourceSha256: parsed.sourceSha256, changes: parsed.changes,
  };
  const version = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, version };
}

/** 서버와 읽기 전용 계산 스냅샷이 같은 금리표를 읽는다. */
export function readRiskFreeRateHistory(db: AppDatabase): RiskFreeRateHistory {
  const row = db.select().from(riskFreeRateHistory).where(eq(riskFreeRateHistory.singleton, 1)).get();
  if (!row) throw new Error("백테스트 금리표가 초기화되지 않았습니다");
  const history = riskFreeRateHistorySchema.parse(JSON.parse(row.historyJson));
  const { version, ...payload } = history;
  if (versionRateHistory(payload).version !== version) throw new Error("금리표 식별자가 내용과 일치하지 않습니다");
  return history;
}

/** 새 계산 DB와 기존 서버 DB를 한 번만 초기화하고 ECOS 갱신분은 덮어쓰지 않는다. */
export function initializeRiskFreeRateHistory(db: AppDatabase): void {
  db.insert(riskFreeRateHistory).values({ singleton: 1, historyJson: JSON.stringify(RISK_FREE_RATE_SEED) }).onConflictDoNothing().run();
}
