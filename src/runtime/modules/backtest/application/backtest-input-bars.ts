import { and, desc, lt, sql } from "drizzle-orm";
import type { BacktestRequest } from "../../../../shared/schemas/backtest-request.js";
import { periodToTsRange } from "../../../../shared/schemas/backtest-request.js";
import type { AppDatabase } from "../../../shared/db/database.js";
import { symbolMasterTradingDays } from "../../../shared/db/schema.js";
import { CandleCoverageService } from "../../market-data/application/candle-coverage-service.js";
import type { AnyTradingStrategy } from "../../strategy/domain/strategy.js";

/** 워커와 사전 집계가 같은 거래일 경계와 준비 봉 수를 사용한다. */
export function getBacktestCandleWindow(
  db: AppDatabase,
  request: BacktestRequest,
  strategy: AnyTradingStrategy,
  parameters: unknown,
): { warmupBars: number; priorTradingDays: { date: string }[]; warmupFromDate: string } {
  const strategyWarmupBars = strategy.dataRequirements?.priceWarmupBars?.(parameters) ?? 0;
  const declineWarmupBars = request.universeRule.stages.reduce(
    (maximum, stage) => stage.criterion === "DECLINE"
      ? Math.max(maximum, stage.lookbackTradingDays) : maximum,
    0,
  );
  const warmupBars = Math.ceil(Math.max(0, strategyWarmupBars, declineWarmupBars));
  const priorTradingDays = warmupBars === 0 ? [] : db
    .select({ date: symbolMasterTradingDays.date })
    .from(symbolMasterTradingDays)
    .where(and(
      lt(symbolMasterTradingDays.date, request.period.from),
      sql`strftime('%w', ${symbolMasterTradingDays.date}) NOT IN ('0', '6')`,
    ))
    .orderBy(desc(symbolMasterTradingDays.date))
    .limit(warmupBars)
    .all();
  return { warmupBars, priorTradingDays,
    warmupFromDate: priorTradingDays[priorTradingDays.length - 1]?.date ?? request.period.from };
}

/** 확정 종목의 유효 봉을 묶음별로 세어 봉 객체를 적재하지 않는다. */
export async function countBacktestInputBars(
  db: AppDatabase,
  request: BacktestRequest,
  symbols: readonly string[],
  strategy: AnyTradingStrategy,
  parameters: unknown,
): Promise<{ tradeBars: number; loadBars: number; warmupFromDate: string }> {
  const { warmupFromDate } = getBacktestCandleWindow(db, request, strategy, parameters);
  const { fromTsMs, toTsMs } = periodToTsRange(request.period);
  const warmupTsMs = Date.parse(`${warmupFromDate}T00:00:00Z`);
  const unique = [...new Set(symbols)];
  const coverage = new CandleCoverageService(db);
  let tradeBars = 0;
  let loadBars = 0;
  for (let offset = 0; offset < unique.length; offset += 32) {
    const batch = unique.slice(offset, offset + 32);
    const trade = coverage.getCoverageBetween(batch, fromTsMs, toTsMs)
      .reduce((sum, row) => sum + row.barCount, 0);
    tradeBars += trade;
    loadBars += trade;
    if (warmupTsMs < fromTsMs) {
      loadBars += coverage.getCoverageBetween(batch, warmupTsMs, fromTsMs - 86_400_000)
        .reduce((sum, row) => sum + row.barCount, 0);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { tradeBars, loadBars, warmupFromDate };
}
