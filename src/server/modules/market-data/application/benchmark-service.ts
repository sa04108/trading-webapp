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
  fredBenchmarkCoverage,
  symbolMasterCoverage,
  symbolMasterTradingDays,
} from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { addCalendarDays, isWeekendDate } from '../domain/kst-date.js';
import {
  KrxNotConfiguredError,
  type FredBenchmarkSource,
  type KrxHistoricalUniverseSource,
} from './ports.js';

export type BenchmarkBackfillState = 'IDLE' | 'RUNNING' | 'FAILED';

export interface BenchmarkBackfillStatus {
  benchmarkId: BenchmarkId | null;
  state: BenchmarkBackfillState;
  cursorDate: string | null;
  from: string | null;
  to: string | null;
  error: string | null;
}

function isFredBenchmarkId(benchmarkId: BenchmarkId): benchmarkId is FredBenchmarkId {
  return BENCHMARK_SOURCES[benchmarkId] === 'FRED_API';
}

interface DateRange {
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * 구간의 모든 달력일이 값·수집 coverage·주말 중 하나로 설명되는지 본다.
 * 평일 휴장일은 성공한 source coverage가 있을 때만 인정해 시장별 휴일을 추측하지 않는다.
 */
function isCalendarRangeAccountedFor(
  from: string,
  to: string,
  pointDates: ReadonlySet<string>,
  coverage: readonly DateRange[],
): boolean {
  for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
    if (isWeekendDate(date) || pointDates.has(date)) continue;
    const attempted = coverage.some(
      (range) => range.startDate <= date && date <= range.endDate,
    );
    if (!attempted) return false;
  }
  return true;
}

export class BenchmarkService {
  private backfill: BenchmarkBackfillStatus = {
    benchmarkId: null, state: 'IDLE', cursorDate: null, from: null, to: null, error: null,
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
      const dates = new Set(points.map((point) => point.date));
      return {
        points,
        covered:
          points.length >= 2
          && isCalendarRangeAccountedFor(
            from,
            to,
            dates,
            this.fredCoverageRanges(benchmarkId, from, to),
          ),
      };
    }

    const tradingDays = this.deps.db
      .select({ date: symbolMasterTradingDays.date })
      .from(symbolMasterTradingDays)
      .where(and(gte(symbolMasterTradingDays.date, from), lte(symbolMasterTradingDays.date, to)))
      .orderBy(asc(symbolMasterTradingDays.date))
      .all()
      // 0005 legacy 이행은 이벤트 경계일도 최선 추정 거래일로 넣었다. 주말은 확실히
      // 잘못된 추정이므로 벤치마크 누락 거래일로 세지 않는다.
      .filter(({ date }) => !isWeekendDate(date));
    const dates = new Set(points.map((point) => point.date));
    const missingTradingDays = tradingDays.filter(({ date }) => !dates.has(date)).length;
    const masterCoverage = this.deps.db
      .select({
        startDate: symbolMasterCoverage.startDate,
        endDate: symbolMasterCoverage.endDate,
      })
      .from(symbolMasterCoverage)
      .where(and(
        lte(symbolMasterCoverage.startDate, to),
        gte(symbolMasterCoverage.endDate, from),
      ))
      .orderBy(asc(symbolMasterCoverage.startDate))
      .all();

    // 달력일마다 "왜 벤치마크 행이 없을 수 있는지"를 설명할 수 있어야 한다.
    // - 벤치마크 값 자체가 있으면 종목 마스터 coverage가 하루 늦어도 충분한 증거다.
    // - 종목 마스터가 조회한 날인데 trading_days에 없으면 확인된 휴장일이다.
    // - 주말은 별도 API 조회 없이 확정할 수 있다.
    // 이 판정은 요청 종료일 자체에 행을 강제하지 않아 금요일 데이터로 그 직후 주말까지
    // 자연스럽게 커버하면서도, 아직 확인하지 않은 평일을 휴장으로 추측하지 않는다.
    return {
      points,
      covered:
        points.length >= 2
        && missingTradingDays === 0
        && isCalendarRangeAccountedFor(from, to, dates, masterCoverage),
    };
  }

  private fredCoverageRanges(
    benchmarkId: FredBenchmarkId,
    from: string,
    to: string,
  ): DateRange[] {
    return this.deps.db
      .select({ startDate: fredBenchmarkCoverage.startDate, endDate: fredBenchmarkCoverage.endDate })
      .from(fredBenchmarkCoverage)
      .where(and(
        eq(fredBenchmarkCoverage.benchmarkId, benchmarkId),
        lte(fredBenchmarkCoverage.startDate, to),
        gte(fredBenchmarkCoverage.endDate, from),
      ))
      .orderBy(asc(fredBenchmarkCoverage.startDate))
      .all();
  }

  private saveFredCoverage(benchmarkId: FredBenchmarkId, from: string, to: string): void {
    const syncedAtMs = this.deps.clock.now();
    this.deps.db.insert(fredBenchmarkCoverage).values({
      benchmarkId,
      startDate: from,
      endDate: to,
      syncedAtMs,
    }).onConflictDoUpdate({
      target: [
        fredBenchmarkCoverage.benchmarkId,
        fredBenchmarkCoverage.startDate,
        fredBenchmarkCoverage.endDate,
      ],
      set: { syncedAtMs },
    }).run();
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
      const points = await this.deps.fredSource.fetchBenchmarkRange(benchmarkId, date, date);
      this.savePoints(benchmarkId, points);
      this.saveFredCoverage(benchmarkId, date, date);
      return;
    }

    const fetchClose = this.deps.krxSource.fetchBenchmarkClose;
    if (!fetchClose) throw new KrxNotConfiguredError();
    const close = await fetchClose(benchmarkId, date);
    if (close !== null) this.savePoints(benchmarkId, [{ date, close }]);
  }

  startBackfill(benchmarkId: BenchmarkId, from: string, to: string): BenchmarkBackfillStatus {
    if (this.backfill.state === 'RUNNING') return this.backfill;
    this.backfill = { benchmarkId, state: 'RUNNING', cursorDate: from, from, to, error: null };
    void this.runBackfill(benchmarkId, from, to);
    return this.backfill;
  }

  backfillStatus(): BenchmarkBackfillStatus {
    return this.backfill;
  }

  private async runBackfill(benchmarkId: BenchmarkId, from: string, to: string): Promise<void> {
    try {
      if (isFredBenchmarkId(benchmarkId)) {
        const points = await this.deps.fredSource.fetchBenchmarkRange(benchmarkId, from, to);
        this.savePoints(benchmarkId, points);
        this.saveFredCoverage(benchmarkId, from, to);
        this.backfill = { benchmarkId, state: 'IDLE', cursorDate: null, from, to, error: null };
        return;
      }

      const existingDates = new Set(this.list(benchmarkId, from, to).map(({ date }) => date));
      for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
        this.backfill.cursorDate = date;
        if (isWeekendDate(date) || existingDates.has(date)) continue;
        await this.syncDate(benchmarkId, date);
      }
      this.backfill = { benchmarkId, state: 'IDLE', cursorDate: null, from, to, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.backfill = {
        benchmarkId, state: 'FAILED', cursorDate: this.backfill.cursorDate, from, to, error: message,
      };
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
    };
    return {
      pin,
      hash: createHash('sha256').update(JSON.stringify(pin)).digest('hex'),
    };
  }
}
