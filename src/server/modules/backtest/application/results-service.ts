import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADE_SORT_DIRECTION,
  DEFAULT_TRADE_SORT_KEY,
  type SortDirection,
  type TradeSortKey,
} from '../../../../shared/schemas/trade-sort.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  BENCHMARK_NAMES,
  benchmarkIdSchema,
  benchmarkPinSchema,
  type BenchmarkId,
} from '../../../../shared/schemas/benchmark.js';
import {
  backtestJobs,
  backtestDrawdownPoints,
  backtestEquityPoints,
  backtestMetrics,
  backtestMonthlyReturns,
  backtestRuns,
  backtestTrades,
} from '../../../shared/db/schema.js';
import { downsampleLttb } from './downsample.js';

const CHART_MAX_POINTS = 1_000;

/**
 * 정렬 축 → 컬럼. `satisfies` 로 축을 하나 더하면 여기도 채우게 만든다 — 빠뜨리면
 * 그 축은 조회 시점에 undefined 컬럼으로 터진다.
 *
 * `exit_ts_ms` 외의 축은 인덱스가 없어 SQLite 가 정렬한다. 정렬 대상은 한 작업의
 * 거래로 한정되므로(job_id 필터) 전체 테이블을 훑지 않는다 — 축마다 인덱스를 다는
 * 것은 쓰기 비용만 늘린다.
 */
const TRADE_SORT_COLUMNS = {
  EXIT_TS: backtestTrades.exitTsMs,
  ENTRY_TS: backtestTrades.entryTsMs,
  QUANTITY: backtestTrades.quantity,
  NET_PNL: backtestTrades.netPnl,
  RETURN_PCT: backtestTrades.returnPct,
  HOLDING_TIME: backtestTrades.holdingTimeMs,
} satisfies Record<TradeSortKey, unknown>;

export class ResultsService {
  constructor(private readonly db: AppDatabase) {}

  getRun(jobId: string) {
    return this.db.select().from(backtestRuns).where(eq(backtestRuns.jobId, jobId)).get() ?? null;
  }

  getMetrics(jobId: string): Record<string, unknown> | null {
    const row = this.db
      .select()
      .from(backtestMetrics)
      .where(eq(backtestMetrics.jobId, jobId))
      .get();
    return row ? (JSON.parse(row.metricsJson) as Record<string, unknown>) : null;
  }

  /**
   * 알림 설명이 쓰는 수익률. `getMetrics` 는 metricsJson 을 통째로 파싱하니 값
   * 하나엔 과하다. 결과가 없으면 null — 0 을 돌려주면 "수익 0%" 로 읽힌다.
   */
  getTotalReturnPct(jobId: string): number | null {
    const row = this.db
      .select({ totalReturnPct: backtestMetrics.totalReturnPct })
      .from(backtestMetrics)
      .where(eq(backtestMetrics.jobId, jobId))
      .get();
    return row?.totalReturnPct ?? null;
  }

  private benchmarkResult(jobId: string) {
    const job = this.db
      .select({
        benchmarkJson: backtestJobs.benchmarkJson,
        benchmarkHash: backtestJobs.benchmarkHash,
        requestJson: backtestJobs.requestJson,
      })
      .from(backtestJobs)
      .where(eq(backtestJobs.id, jobId))
      .get();
    if (!job) return null;

    let requestedId: BenchmarkId = 'KOSPI';
    try {
      const request = JSON.parse(job.requestJson) as { benchmarkId?: unknown };
      const parsedId = benchmarkIdSchema.safeParse(request.benchmarkId);
      if (parsedId.success) requestedId = parsedId.data;
    } catch {
      // 손상된 옛 요청은 기본 벤치마크명만 표시한다.
    }

    const unavailable = (reason: string) => ({
      summary: {
        benchmarkId: requestedId,
        name: BENCHMARK_NAMES[requestedId],
        available: false as const,
        unavailableReason: reason,
        totalReturnPct: null,
        excessReturnPct: null,
        dataHash: job.benchmarkHash,
      },
      points: [] as Array<{ tsMs: number; value: number }>,
    });

    if (!job.benchmarkJson) return unavailable('이 작업에는 벤치마크 데이터가 고정되지 않았습니다.');
    let parsed: ReturnType<typeof benchmarkPinSchema.safeParse>;
    try {
      parsed = benchmarkPinSchema.safeParse(JSON.parse(job.benchmarkJson));
    } catch {
      return unavailable('고정된 벤치마크 데이터를 읽을 수 없습니다.');
    }
    if (!parsed.success) return unavailable('고정된 벤치마크 데이터 형식이 올바르지 않습니다.');
    const pin = parsed.data;
    if (pin.points.length < 2) {
      return unavailable(`${pin.name} 수익률 계산에 필요한 거래일 데이터가 2개 미만입니다.`);
    }
    if (!pin.covered) {
      return unavailable(`${pin.name} 데이터가 백테스트 기간을 완전히 커버하지 않습니다.`);
    }
    const metrics = this.getMetrics(jobId) as { totalReturnPct?: unknown } | null;
    const strategyReturn = typeof metrics?.totalReturnPct === 'number' ? metrics.totalReturnPct : null;
    if (strategyReturn === null) return unavailable('백테스트 수익률이 아직 계산되지 않았습니다.');

    const first = pin.points[0]!.close;
    const last = pin.points.at(-1)!.close;
    const totalReturnPct = (last / first - 1) * 100;
    return {
      summary: {
        benchmarkId: pin.benchmarkId,
        name: pin.name,
        available: true as const,
        unavailableReason: null,
        totalReturnPct,
        excessReturnPct: strategyReturn - totalReturnPct,
        dataHash: job.benchmarkHash,
      },
      points: pin.points.map((point) => ({
        tsMs: Date.parse(`${point.date}T00:00:00Z`),
        value: point.close / first * 100,
      })),
    };
  }

  getBenchmark(jobId: string) {
    return this.benchmarkResult(jobId)?.summary ?? null;
  }

  /** 차트용 시리즈 — 서버 측 LTTB 다운샘플 (표시 전용) */
  getChartSeries(jobId: string) {
    const equity = this.db
      .select()
      .from(backtestEquityPoints)
      .where(eq(backtestEquityPoints.jobId, jobId))
      .orderBy(asc(backtestEquityPoints.tsMs))
      .all()
      .map((row) => ({ tsMs: row.tsMs, value: row.equity }));
    const drawdown = this.db
      .select()
      .from(backtestDrawdownPoints)
      .where(eq(backtestDrawdownPoints.jobId, jobId))
      .orderBy(asc(backtestDrawdownPoints.tsMs))
      .all()
      .map((row) => ({ tsMs: row.tsMs, value: row.drawdown }));
    const monthly = this.db
      .select()
      .from(backtestMonthlyReturns)
      .where(eq(backtestMonthlyReturns.jobId, jobId))
      .orderBy(asc(backtestMonthlyReturns.year), asc(backtestMonthlyReturns.month))
      .all()
      .map((row) => ({ year: row.year, month: row.month, returnPct: row.returnPct }));
    const symbols = this.db
      .selectDistinct({ symbol: backtestTrades.symbol })
      .from(backtestTrades)
      .where(eq(backtestTrades.jobId, jobId))
      .orderBy(asc(backtestTrades.symbol))
      .all()
      .map((row) => row.symbol);

    return {
      equity: downsampleLttb(equity, CHART_MAX_POINTS),
      benchmark: downsampleLttb(
        this.benchmarkResult(jobId)?.points ?? [],
        CHART_MAX_POINTS,
      ),
      drawdown: downsampleLttb(drawdown, CHART_MAX_POINTS),
      monthly,
      symbols,
      totalEquityPoints: equity.length,
    };
  }

  getTrades(
    jobId: string,
    options: {
      limit: number;
      offset: number;
      symbol?: string;
      sort?: TradeSortKey;
      direction?: SortDirection;
    },
  ) {
    const conditions = [eq(backtestTrades.jobId, jobId)];
    if (options.symbol) conditions.push(eq(backtestTrades.symbol, options.symbol));
    const column = TRADE_SORT_COLUMNS[options.sort ?? DEFAULT_TRADE_SORT_KEY];
    const primary =
      (options.direction ?? DEFAULT_TRADE_SORT_DIRECTION) === 'DESC' ? desc(column) : asc(column);
    const trades = this.db
      .select()
      .from(backtestTrades)
      .where(and(...conditions))
      // id 로 한 번 더 정렬한다 — 수량·보유기간·청산시각은 동률이 흔하고, 동률의 순서가
      // 정해지지 않으면 LIMIT/OFFSET 페이지 경계에서 같은 거래가 두 번 나오거나 빠진다.
      .orderBy(primary, asc(backtestTrades.id))
      .limit(options.limit)
      .offset(options.offset)
      .all();
    // 페이지네이션 UI 가 전체 페이지 수를 계산할 수 있게 필터 기준 총 건수를 함께 준다
    const total =
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(backtestTrades)
        .where(and(...conditions))
        .get()?.count ?? 0;
    return { trades, total };
  }

  /** 전체 결과 export (다운샘플 없음) */
  getFullExport(jobId: string) {
    return {
      run: this.getRun(jobId),
      metrics: this.getMetrics(jobId),
      equityPoints: this.db
        .select({ tsMs: backtestEquityPoints.tsMs, equity: backtestEquityPoints.equity })
        .from(backtestEquityPoints)
        .where(eq(backtestEquityPoints.jobId, jobId))
        .orderBy(asc(backtestEquityPoints.tsMs))
        .all(),
      trades: this.db
        .select()
        .from(backtestTrades)
        .where(eq(backtestTrades.jobId, jobId))
        .orderBy(asc(backtestTrades.exitTsMs))
        .all(),
      monthlyReturns: this.db
        .select()
        .from(backtestMonthlyReturns)
        .where(eq(backtestMonthlyReturns.jobId, jobId))
        .orderBy(asc(backtestMonthlyReturns.year), asc(backtestMonthlyReturns.month))
        .all(),
      benchmark: this.getBenchmark(jobId),
    };
  }
}
