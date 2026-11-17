import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { AppDatabase } from "../../../shared/db/database.js";
import { benchmarkDailyValues, symbolMasterTradingDays } from "../../../shared/db/data-schema.js";
import type { MarketIndexPoint, MarketIndexRequirement } from "../domain/market-index.js";

/** 지수와 거래일을 같은 데이터 스냅샷에서 읽어 실제 거래일 결손을 검사한다. */
export function readMarketIndex(db: AppDatabase, requirement: MarketIndexRequirement): readonly MarketIndexPoint[] | null {
  const { from, to, tradeFrom, minimumBars } = requirement;
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!Number.isSafeInteger(minimumBars) || minimumBars < 1 || minimumBars > 3000 || !validDate(from) || !validDate(to) || !validDate(tradeFrom) || from > tradeFrom || tradeFrom > to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || (Date.parse(to) - Date.parse(from)) / 86400000 > 10000) throw new Error("시장 지수 요청 범위가 올바르지 않습니다");
  const rows = db.select({ date: benchmarkDailyValues.date, close: benchmarkDailyValues.close }).from(benchmarkDailyValues).where(and(eq(benchmarkDailyValues.benchmarkId, "KOSPI"), gte(benchmarkDailyValues.date, from), lte(benchmarkDailyValues.date, to))).orderBy(asc(benchmarkDailyValues.date)).all();
  const days = db.select({ date: symbolMasterTradingDays.date }).from(symbolMasterTradingDays).where(and(gte(symbolMasterTradingDays.date, from), lte(symbolMasterTradingDays.date, to))).orderBy(asc(symbolMasterTradingDays.date)).all().filter(({ date }) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()));
  const dates = new Set(rows.filter((row) => Number.isFinite(row.close) && row.close > 0).map((row) => row.date));
  if (rows.some((row) => !Number.isFinite(row.close) || row.close <= 0) || days.some(({ date }) => !dates.has(date)) || days.filter(({ date }) => date < tradeFrom && dates.has(date)).length < minimumBars || days.length === 0) return null;
  const sessions = new Set(days.map(({ date }) => date));
  return rows.filter(({ date }) => sessions.has(date)).map(({ date, close }) => ({ tsMs: Date.parse(`${date}T00:00:00Z`), close }));
}
