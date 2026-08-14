import { createHash } from 'node:crypto';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import {
  BENCHMARK_NAMES,
  BENCHMARK_SOURCES,
  type BenchmarkPoint,
  type BenchmarkId,
  type BenchmarkPin,
  type FredBenchmarkId,
} from '../../../../shared/schemas/benchmark.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  benchmarkDailyValues,
  symbolMasterCoverage,
  symbolMasterTradingDays,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { addCalendarDays } from '../domain/kst-date.js';
import {
  KrxNotConfiguredError,
  type FredBenchmarkSource,
  type KrxHistoricalUniverseSource,
} from './ports.js';

export type BenchmarkBackfillState = 'IDLE' | 'RUNNING' | 'FAILED';

export interface BenchmarkBackfillStatus {
  state: BenchmarkBackfillState;
  cursorDate: string | null;
  from: string | null;
  to: string | null;
  error: string | null;
}

function isFredBenchmarkId(benchmarkId: BenchmarkId): benchmarkId is FredBenchmarkId {
  return BENCHMARK_SOURCES[benchmarkId] === 'FRED_API';
}

export class BenchmarkService {
  private backfill: BenchmarkBackfillStatus = {
    state: 'IDLE', cursorDate: null, from: null, to: null, error: null,
  };

  constructor(private readonly deps: {
    db: AppDatabase;
    krxSource: KrxHistoricalUniverseSource;
    fredSource: FredBenchmarkSource;
    clock: Clock;
    logger: Logger;
  }) {}

  list(benchmarkId: BenchmarkId, from: string, to: string) {
    return this.deps.db
      .select({ date: benchmarkDailyValues.date, close: benchmarkDailyValues.close })
      .from(benchmarkDailyValues)
      .where(and(
        eq(benchmarkDailyValues.benchmarkId, benchmarkId),
        gte(benchmarkDailyValues.date, from),
        lte(benchmarkDailyValues.date, to),
      ))
      .orderBy(asc(benchmarkDailyValues.date))
      .all();
  }

  status(benchmarkId: BenchmarkId, from: string, to: string) {
    const points = this.list(benchmarkId, from, to);
    if (isFredBenchmarkId(benchmarkId)) {
      const firstDate = points[0]?.date;
      const lastDate = points.at(-1)?.date;
      // ponytail: FRED 기간 조회는 완결된 시계열을 주므로 경계 7일만 확인한다.
      // 중간 누락 감시가 필요해지면 공급자별 거래일 coverage를 저장한다.
      const missingTradingDays =
        Number(firstDate === undefined || firstDate > addCalendarDays(from, 7))
        + Number(lastDate === undefined || lastDate < addCalendarDays(to, -7));
      return {
        points,
        covered: points.length >= 2 && missingTradingDays === 0,
        missingTradingDays,
        tradingDays: points.length,
      };
    }

    const tradingDays = this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(and(gte(symbolMasterTradingDays.date, from), lte(symbolMasterTradingDays.date, to)))
      .orderBy(asc(symbolMasterTradingDays.date))
      .all();
    const dates = new Set(points.map((point) => point.date));
    const missingTradingDays = tradingDays.filter(({ date }) => !dates.has(date)).length;
    const masterCovered = this.deps.db
      .select({ startDate: symbolMasterCoverage.startDate })
      .from(symbolMasterCoverage)
      .where(and(
        lte(symbolMasterCoverage.startDate, from),
        gte(symbolMasterCoverage.endDate, to),
      ))
      .get() !== undefined;
    return {
      points,
      covered: masterCovered && tradingDays.length >= 2 && missingTradingDays === 0,
      missingTradingDays,
      tradingDays: tradingDays.length,
    };
  }

  private savePoints(benchmarkId: BenchmarkId, points: readonly BenchmarkPoint[]): void {
    if (points.length === 0) return;
    const syncedAtMs = this.deps.clock.now();
    this.deps.db.transaction((tx) => {
      for (const { date, close } of points) {
        tx.insert(benchmarkDailyValues).values({
          benchmarkId,
          date,
          close,
          syncedAtMs,
        }).onConflictDoUpdate({
          target: [benchmarkDailyValues.benchmarkId, benchmarkDailyValues.date],
          set: { close, syncedAtMs },
        }).run();
      }
    });
  }

  async syncDate(benchmarkId: BenchmarkId, date: string): Promise<void> {
    if (isFredBenchmarkId(benchmarkId)) {
      this.savePoints(
        benchmarkId,
        await this.deps.fredSource.fetchBenchmarkRange(benchmarkId, date, date),
      );
      return;
    }

    const fetchClose = this.deps.krxSource.fetchBenchmarkClose;
    if (!fetchClose) throw new KrxNotConfiguredError();
    const close = await fetchClose(benchmarkId, date);
    if (close !== null) this.savePoints(benchmarkId, [{ date, close }]);
  }

  startBackfill(benchmarkId: BenchmarkId, from: string, to: string): BenchmarkBackfillStatus {
    if (this.backfill.state === 'RUNNING') return this.backfill;
    this.backfill = { state: 'RUNNING', cursorDate: from, from, to, error: null };
    void this.runBackfill(benchmarkId, from, to);
    return this.backfill;
  }

  backfillStatus(): BenchmarkBackfillStatus {
    return this.backfill;
  }

  private async runBackfill(benchmarkId: BenchmarkId, from: string, to: string): Promise<void> {
    try {
      if (isFredBenchmarkId(benchmarkId)) {
        this.savePoints(
          benchmarkId,
          await this.deps.fredSource.fetchBenchmarkRange(benchmarkId, from, to),
        );
        this.backfill = { state: 'IDLE', cursorDate: null, from, to, error: null };
        return;
      }

      for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
        this.backfill.cursorDate = date;
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (day === 0 || day === 6) continue;
        await this.syncDate(benchmarkId, date);
      }
      this.backfill = { state: 'IDLE', cursorDate: null, from, to, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.backfill = { state: 'FAILED', cursorDate: this.backfill.cursorDate, from, to, error: message };
      this.deps.logger.error(
        { module: 'market-data', event: 'benchmark.backfill-failed', date: this.backfill.cursorDate, error: message },
        '벤치마크 백필이 날짜 처리 중 실패했다',
      );
    }
  }

  pin(benchmarkId: BenchmarkId, period: { from: string; to: string }): {
    pin: BenchmarkPin;
    hash: string;
  } {
    const status = this.status(benchmarkId, period.from, period.to);
    const pin: BenchmarkPin = {
      benchmarkId,
      name: BENCHMARK_NAMES[benchmarkId],
      source: BENCHMARK_SOURCES[benchmarkId],
      sourceVersion: 'v1',
      period,
      points: status.points,
      covered: status.covered,
      missingTradingDays: status.missingTradingDays,
    };
    return {
      pin,
      hash: createHash('sha256').update(JSON.stringify(pin)).digest('hex'),
    };
  }
}
