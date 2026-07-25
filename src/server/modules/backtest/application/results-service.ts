import { and, asc, eq } from 'drizzle-orm';
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

  getTrades(jobId: string, options: { limit: number; offset: number; symbol?: string }) {
    const conditions = [eq(backtestTrades.jobId, jobId)];
    if (options.symbol) conditions.push(eq(backtestTrades.symbol, options.symbol));
    return this.db
      .select()
      .from(backtestTrades)
      .where(and(...conditions))
      .orderBy(asc(backtestTrades.exitTsMs))
      .limit(options.limit)
      .offset(options.offset)
      .all();
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
