import type { AppDatabase } from "../../../../runtime/shared/db/database.js";
import { addCalendarDays } from "../../../../runtime/modules/market-data/domain/kst-date.js";
import type { MarketIndexRequirement } from "../../../../runtime/modules/market-data/domain/market-index.js";
import { readMarketIndex } from "../../../../runtime/modules/market-data/application/market-index-history.js";
import { and, gte, lte } from "drizzle-orm";
import { symbolMasterTradingDays } from "../../../../runtime/shared/db/data-schema.js";

export async function ensureMarketIndex(input: { db: AppDatabase; master: { ingestDate(date: string): Promise<unknown> }; benchmarks: { syncDate(id: "KOSPI", date: string, options?: { retryMissing?: boolean }): Promise<void> }; requirement: MarketIndexRequirement; shouldStop?: () => boolean; onProgress?: (completed: number, total: number, date: string) => void }): Promise<void> {
  const { requirement: req } = input;
  // 범위 검증을 먼저 수행한다.
  readMarketIndex(input.db, req);
  const dates: string[] = [];
  for (let date = req.from; date <= req.to; date = addCalendarDays(date, 1)) dates.push(date);
  for (const [index, date] of dates.entries()) {
    if (input.shouldStop?.()) return;
    await input.master.ingestDate(date);
    input.onProgress?.(index + 1, dates.length, date);
  }
  const openDates = new Set(input.db.select({ date: symbolMasterTradingDays.date }).from(symbolMasterTradingDays).where(and(gte(symbolMasterTradingDays.date, req.from), lte(symbolMasterTradingDays.date, req.to))).all().map(({ date }) => date).filter((date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())));
  let completed = 0;
  for (const date of openDates) {
    if (input.shouldStop?.()) return;
    await input.benchmarks.syncDate("KOSPI", date, { retryMissing: true });
    input.onProgress?.(++completed, openDates.size, date);
  }
  const points = readMarketIndex(input.db, req);
  const seen = new Set(points?.map((point) => new Date(point.tsMs).toISOString().slice(0, 10)) ?? []);
  if (!points || [...openDates].some((date) => !seen.has(date))) throw new Error("KOSPI 지수 이력이 부족하거나 거래일 값이 누락되었습니다");
}
