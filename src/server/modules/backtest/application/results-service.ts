import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADE_SORT_DIRECTION,
  DEFAULT_TRADE_SORT_KEY,
  type SortDirection,
  type TradeSortKey,
} from '../../../../shared/schemas/trade-sort.js';
import type { AppDatabase } from '../../../shared/db/database.js';
import {
  backtestDrawdownPoints,
  backtestEquityPoints,
  backtestMetrics,
  backtestMonthlyReturns,
  backtestRuns,
  backtestSymbolMetrics,
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
      .all()
      .map((row) => ({ year: row.year, month: row.month, returnPct: row.returnPct }));
    const symbols = this.db
      .select()
      .from(backtestSymbolMetrics)
      .where(eq(backtestSymbolMetrics.jobId, jobId))
      .all()
      .map((row) => ({
        symbol: row.symbol,
        tradeCount: row.tradeCount,
        netPnl: row.netPnl,
        winRate: row.winRate,
      }));

    return {
      equity: downsampleLttb(equity, CHART_MAX_POINTS),
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
        .all(),
      symbolMetrics: this.db
        .select()
        .from(backtestSymbolMetrics)
        .where(eq(backtestSymbolMetrics.jobId, jobId))
        .all(),
    };
  }
}
