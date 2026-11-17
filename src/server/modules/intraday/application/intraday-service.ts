import { createHash, randomUUID } from "node:crypto";
import { readRiskFreeRateHistory } from "../../../../runtime/modules/market-data/infrastructure/sqlite-risk-free-rate-store.js";
import { readRuntimeVersions } from "../../../../runtime/shared/runtime-versions.js";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  historyQuerySchema,
  type HistoryGroup,
  type HistoryQuery,
} from "../../../../shared/schemas/backtest-history.js";
import type { AppDatabase } from "../../../../runtime/shared/db/database.js";
import {
  intradayCollections,
  intradayRuns,
} from "../../../shared/db/intraday-schema.js";
import {
  INTRADAY_RETENTION_DAYS,
  MINUTE_MS,
  intradayCollectSchema,
  intradayDate,
  intradayFirstBacktestDate,
  intradayPeriodMs,
  intradayRequestSchema,
  intradayRetentionDate,
  type IntradayBar,
  type IntradayChart,
  type IntradayCollection,
  type IntradayDataOverview,
  type IntradayPeriod,
  type IntradayRequest,
  type IntradayResult,
  type IntradayRun,
  type IntradayRunSummary,
  type IntradaySymbolData,
  type IntradayChartTimeframe,
} from "../../../../shared/schemas/intraday.js";
import {
  intradayGaps,
  type IntradayEngineInput,
} from "../../../../runtime/modules/intraday/domain/engine.js";
import { intradayValidations, intradayValidationTrials } from "../../../shared/db/intraday-validation-schema.js";
import { aggregateChartBars } from "./chart-bars.js";

export class IntradayError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
export interface IntradayStore {
  list(): Promise<IntradaySymbolData[]>;
  read(
    symbol: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ bars: IntradayBar[]; revision: string }>;
  merge(
    symbol: string,
    bars: IntradayBar[],
    nowMs: number,
  ): Promise<IntradaySymbolData>;
  prune(nowMs: number): Promise<void>;
}
export interface IntradaySource {
  fetch(
    symbol: string,
    fromMs: number,
    toMs: number,
    options?: {
      signal?: AbortSignal;
      onProgress?: (p: {
        pages: number;
        fetchedBars: number;
        oldestEndMs: number | null;
      }) => void;
    },
  ): Promise<IntradayBar[]>;
}
export type IntradayTerminalEvent = {
  id: string;
  ownerId: string;
  symbol: string;
  period: IntradayPeriod;
  status: "COMPLETED" | "FAILED";
  error: string | null;
} & (
  | { kind: "collection" }
  | { kind: "run"; strategyId: string; returnPct: number | null }
);
interface Options {
  db: AppDatabase;
  store: IntradayStore;
  source: IntradaySource | null;
  now?: () => number;
  calendar: { classify(date: string, market: "KOSPI"): { state: string } };
  execute: (
    input: IntradayEngineInput,
    signal: AbortSignal,
  ) => Promise<IntradayResult>;
  validateSymbol?: (
    symbol: string,
  ) => Promise<{ listDate: string; isinCode: string }>;
  search: (query: string) => Promise<{ symbol: string; name: string }[]>;
  onRecoveryFailure?: (terminalNotificationExpected: boolean) => void;
  onTerminal?: (event: IntradayTerminalEvent) => void;
}
type CollectionRow = typeof intradayCollections.$inferSelect;
type RunRow = Omit<typeof intradayRuns.$inferSelect, "resultJson"> & {
  resultJson?: string | null;
};
const ACTIVE = ["QUEUED", "PREPARING", "RUNNING"];

/** 양의 크기로 저장된 과거 낙폭도 현재의 음수 표기로 조회한다. */
function normalizeDrawdown(value: number): number {
  return value > 0 ? -value : value;
}

const runColumns = {
  id: intradayRuns.id,
  ownerId: intradayRuns.ownerId,
  requestJson: intradayRuns.requestJson,
  status: intradayRuns.status,
  error: intradayRuns.error,
  createdAtMs: intradayRuns.createdAtMs,
  updatedAtMs: intradayRuns.updatedAtMs,
};

export class IntradayService {
  private readonly now: () => number;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly recoveredCollections = new Map<string, string>();
  private recovered = false;
  private readonly tasks = new Set<Promise<void>>();
  private collectionQueue: Promise<void> = Promise.resolve();
  private runQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private pruneTask: Promise<void> | null = null;
  private lastPrunedAt = -Infinity;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => {
      void this.prune().catch(() => {});
    }, 3_600_000);
    this.timer.unref();
  }
  private isValidationRun(id: string): boolean {
    return !!this.options.db.select({ id: intradayValidationTrials.id }).from(intradayValidationTrials).where(eq(intradayValidationTrials.runId, id)).get();
  }
  /** 저장된 종료 상태만 전달하며 알림 오류는 작업 결과에 영향을 주지 않는다. */
  private notifyTerminal(kind: "collection" | "run", id: string): void {
    if (!this.options.onTerminal) return;
    try {
      const safeObject = (json: string | null): Record<string, unknown> => {
        try {
          const value: unknown = JSON.parse(json ?? "null");
          return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
        } catch { return {}; }
      };
      const safePeriod = (value: unknown): IntradayPeriod => {
        const period = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
        return { from: typeof period.from === "string" ? period.from : "기간 정보 없음", to: typeof period.to === "string" ? period.to : "기간 정보 없음" };
      };
      if (kind === "collection") {
        const row = this.options.db.select().from(intradayCollections).where(eq(intradayCollections.id, id)).get();
        if (!row || row.parentRunId !== null || (row.status !== "COMPLETED" && row.status !== "FAILED")) return;
        this.options.onTerminal({ kind, id, ownerId: row.ownerId, symbol: row.symbol,
          period: safePeriod(safeObject(row.periodJson)), status: row.status, error: row.error });
      } else {
        const row = this.options.db.select().from(intradayRuns).where(eq(intradayRuns.id, id)).get();
        if (!row || (row.status !== "COMPLETED" && row.status !== "FAILED")) return;
        if (this.isValidationRun(id)) return;
        const request = safeObject(row.requestJson);
        const metrics = safeObject(JSON.stringify(safeObject(row.resultJson).metrics ?? null));
        this.options.onTerminal({ kind, id, ownerId: row.ownerId,
          symbol: typeof request.symbol === "string" ? request.symbol : "알 수 없는 종목",
          strategyId: typeof request.strategyId === "string" ? request.strategyId : "알 수 없는 전략",
          period: safePeriod(request.period), status: row.status, error: row.error,
          returnPct: typeof metrics.returnPct === "number" && Number.isFinite(metrics.returnPct) ? metrics.returnPct : null });
      }
    } catch { /* 알림 실패가 종료 상태를 바꾸지 않는다. */ }
  }
  /** 서버 부팅에서만 호출한다. 생성자를 공유하는 CLI가 작업을 실행하지 않게 한다. */
  recover(): void {
    if (this.recovered || this.closing) return;
    this.recovered = true;
    const runs = this.options.db.select(runColumns).from(intradayRuns)
      .where(inArray(intradayRuns.status, ACTIVE)).orderBy(asc(intradayRuns.createdAtMs)).all();
    const parents = new Map(runs.map((run) => [run.id, run.ownerId]));
    const collections = this.options.db.select().from(intradayCollections)
      .where(inArray(intradayCollections.status, ACTIVE)).orderBy(asc(intradayCollections.createdAtMs)).all();
    for (const row of collections) {
      try {
        const request = intradayCollectSchema.parse({ symbol: row.symbol, period: JSON.parse(row.periodJson) });
        this.bounds(request.period);
        if (row.parentRunId !== null && parents.get(row.parentRunId) !== row.ownerId)
          throw new IntradayError("연결된 백테스트가 종료되었거나 없어 수집을 재개할 수 없습니다.");
        this.options.db.update(intradayCollections).set({ status: "QUEUED", error: null,
          pages: 0, fetchedBars: 0, oldestEndMs: null, updatedAtMs: this.now() })
          .where(eq(intradayCollections.id, row.id)).run();
        this.recovering.add(row.id);
        if (row.parentRunId !== null) this.recoveredCollections.set(row.parentRunId, row.id);
        this.enqueueCollection(row.id, request.symbol, request.period);
      } catch (error) {
        this.options.db.update(intradayCollections).set({ status: "FAILED", updatedAtMs: this.now(),
          error: error instanceof Error ? error.message : "저장된 수집 요청을 복구할 수 없습니다." })
          .where(eq(intradayCollections.id, row.id)).run();
        this.notifyTerminal("collection", row.id);
        this.options.onRecoveryFailure?.(row.parentRunId === null || parents.get(row.parentRunId) === row.ownerId);
      }
    }
    for (const row of runs) {
      try {
        const request = intradayRequestSchema.parse(JSON.parse(row.requestJson));
        this.bounds(request.period, true);
        this.options.db.update(intradayRuns).set({ status: "QUEUED", error: null, updatedAtMs: this.now() })
          .where(eq(intradayRuns.id, row.id)).run();
        this.recovering.add(row.id);
        this.enqueueRun(row.ownerId, row.id, request);
      } catch (error) {
        const childId = this.recoveredCollections.get(row.id);
        if (childId) this.cancelCollection(row.ownerId, childId);
        this.recoveredCollections.delete(row.id);
        this.options.db.update(intradayRuns).set({ status: "FAILED", updatedAtMs: this.now(),
          error: error instanceof Error ? error.message : "저장된 백테스트 요청을 복구할 수 없습니다." })
          .where(eq(intradayRuns.id, row.id)).run();
        this.notifyTerminal("run", row.id);
        if (!this.isValidationRun(row.id)) this.options.onRecoveryFailure?.(true);
      }
    }
  }
  private async prune(): Promise<void> {
    if (this.closing) return;
    if (this.now() - this.lastPrunedAt < 3_600_000) return;
    this.pruneTask ??= this.options.store
      .prune(this.now())
      .then(() => {
        this.lastPrunedAt = this.now();
      })
      .finally(() => {
        this.pruneTask = null;
      });
    await this.pruneTask;
  }
  private bounds(
    period: IntradayPeriod,
    backtest = false,
  ): { fromMs: number; toMs: number } {
    if (
      period.from < intradayRetentionDate(this.now()) ||
      period.to > intradayDate(this.now())
    )
      throw new IntradayError(
        "분봉은 최근 365일 범위에서 조회할 수 있습니다.",
        400,
      );
    if (backtest && period.to >= intradayDate(this.now()))
      throw new IntradayError(
        "백테스트 종료일은 KST 기준 어제까지 지정하세요.",
        400,
      );
    if (backtest && period.from < intradayFirstBacktestDate(this.now()))
      throw new IntradayError(
        `하루 전체가 보관된 ${intradayFirstBacktestDate(this.now())} 이후부터 백테스트할 수 있습니다.`,
        400,
      );
    const range = intradayPeriodMs(period);
    return {
      fromMs: Math.max(
        range.fromMs,
        this.now() - INTRADAY_RETENTION_DAYS * 86_400_000,
      ),
      toMs: range.toMs,
    };
  }
  private tradingDates(period: IntradayPeriod): string[] {
    const dates: string[] = [];
    for (
      let ts = Date.parse(`${period.from}T00:00:00Z`);
      ts <= Date.parse(`${period.to}T00:00:00Z`);
      ts += 86_400_000
    ) {
      const date = new Date(ts).toISOString().slice(0, 10),
        state = this.options.calendar.classify(date, "KOSPI").state;
      if (state === "UNKNOWN")
        throw new IntradayError(
          `${date} 공식 거래일 달력을 확인할 수 없습니다.`,
        );
      if (state === "OPEN") dates.push(date);
    }
    return dates;
  }
  private collection(row: CollectionRow): IntradayCollection {
    let period: IntradayPeriod = { from: "", to: "" };
    try {
      const saved = intradayCollectSchema.safeParse({ symbol: row.symbol, period: JSON.parse(row.periodJson) });
      if (saved.success) period = saved.data.period;
    } catch { /* 손상된 요청도 실패 상태와 복구 사유는 조회할 수 있어야 한다. */ }
    return {
      id: row.id,
      symbol: row.symbol,
      period,
      status: row.status as IntradayCollection["status"],
      fetchedBars: row.fetchedBars,
      pages: row.pages,
      oldestEndMs: row.oldestEndMs,
      error: row.error,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    };
  }
  private run(row: RunRow): IntradayRun {
    const result = row.resultJson
      ? JSON.parse(row.resultJson) as IntradayResult
      : undefined;
    if (result) {
      result.metrics.maxDrawdownPct = normalizeDrawdown(result.metrics.maxDrawdownPct);
      result.metrics.dailyMaxDrawdownPct = normalizeDrawdown(result.metrics.dailyMaxDrawdownPct);
    }
    return {
      id: row.id,
      request: JSON.parse(row.requestJson) as IntradayRequest,
      status: row.status as IntradayRun["status"],
      error: row.error,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
      ...(result ? { result } : {}),
    };
  }
  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  private checkCapacity(internal = false): void {
    if (this.closing) throw new IntradayError("서버를 종료하는 중입니다.");
    if (
      !internal &&
      [...this.controllers.values()].filter((c) => !c.signal.aborted).length >=
        20
    )
      throw new IntradayError(
        "대기 중인 분봉 작업이 많습니다. 완료 후 다시 시도하세요.",
        429,
      );
  }
  async overview(ownerId: string): Promise<IntradayDataOverview> {
    await this.prune();
    return {
      configured: this.options.source !== null,
      retentionDays: INTRADAY_RETENTION_DAYS,
      quoteScope: "TOSS_UNSPECIFIED",
      symbols: await this.options.store.list(),
      collections: this.options.db
        .select()
        .from(intradayCollections)
        .where(eq(intradayCollections.ownerId, ownerId))
        .orderBy(desc(intradayCollections.createdAtMs))
        .limit(100)
        .all()
        .map((row) => this.collection(row)),
    };
  }
  async search(query: string): Promise<{ symbol: string; name: string }[]> {
    return this.options.search(query);
  }
  async chart(
    symbol: string,
    period: IntradayPeriod,
    timeframe: IntradayChartTimeframe,
  ): Promise<IntradayChart> {
    const { fromMs, toMs } = this.bounds(period);
    const data = await this.options.store.read(
      symbol,
      fromMs,
      Math.min(toMs, this.now() - 60_000),
    );
    const bars = aggregateChartBars(data.bars, timeframe);
    // 당일은 아직 도착할 수 없는 미래 봉을 누락으로 세지 않는다.
    const gaps = intradayGaps(data.bars, this.tradingDates(period))
      .filter((g) => g.fromMs < this.now() - 120_000)
      .map((g) => {
        const end = Math.min(
          g.toMs,
          Math.floor((this.now() - 60_000) / 60_000) * 60_000,
        );
        return {
          ...g,
          toMs: end,
          missingMinutes: Math.max(0, (end - g.fromMs) / 60_000),
        };
      });
    return {
      symbol,
      timeframe,
      bars,
      totalBars: bars.length,
      truncated: false,
      revision: data.revision,
      gaps: gaps.slice(0, 500),
    };
  }
  collect(ownerId: string, raw: unknown, parentRunId?: string): IntradayCollection {
    this.checkCapacity(parentRunId !== undefined);
    if (!this.options.source)
      throw new IntradayError("서버의 토스증권 API 연결 설정을 확인하세요.");
    const request = intradayCollectSchema.parse(raw);
    this.bounds(request.period);
    const id = randomUUID(),
      now = this.now();
    this.options.db
      .insert(intradayCollections)
      .values({
        id,
        ownerId,
        parentRunId: parentRunId ?? null,
        symbol: request.symbol,
        periodJson: JSON.stringify(request.period),
        status: "QUEUED",
        createdAtMs: now,
        updatedAtMs: now,
      })
      .run();
    this.enqueueCollection(id, request.symbol, request.period);
    return this.getCollection(ownerId, id);
  }
  private enqueueCollection(id: string, symbol: string, period: IntradayPeriod): void {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.collectionQueue
      .then(() =>
        this.performCollection(
          id,
          symbol,
          period,
          controller.signal,
        ),
      )
      .finally(() => {
        this.controllers.delete(id);
        this.cancelled.delete(id);
        this.recovering.delete(id);
      });
    this.collectionQueue = task.catch(() => {});
    this.track(this.collectionQueue);
  }
  getCollection(ownerId: string, id: string): IntradayCollection {
    const row = this.options.db
      .select()
      .from(intradayCollections)
      .where(
        and(
          eq(intradayCollections.id, id),
          eq(intradayCollections.ownerId, ownerId),
        ),
      )
      .get();
    if (!row) throw new IntradayError("수집 작업을 찾을 수 없습니다.", 404);
    return this.collection(row);
  }
  cancelCollection(ownerId: string, id: string): IntradayCollection {
    const row = this.getCollection(ownerId, id);
    if (ACTIVE.includes(row.status)) {
      this.cancelled.add(id);
      this.controllers.get(id)?.abort();
      this.options.db
        .update(intradayCollections)
        .set({
          status: "CANCELLED",
          error: "사용자가 수집을 취소했습니다.",
          updatedAtMs: this.now(),
        })
        .where(eq(intradayCollections.id, id))
        .run();
    }
    return this.getCollection(ownerId, id);
  }
  private async performCollection(
    id: string,
    symbol: string,
    period: IntradayPeriod,
    signal: AbortSignal,
  ): Promise<void> {
    const update = (values: Partial<typeof intradayCollections.$inferInsert>) =>
      this.options.db
        .update(intradayCollections)
        .set({ ...values, updatedAtMs: this.now() })
        .where(eq(intradayCollections.id, id))
        .run();
    try {
      signal.throwIfAborted();
      this.bounds(period);
      if (!this.options.source)
        throw new IntradayError("서버의 토스증권 API 연결 설정을 확인하세요.");
      update({ status: "RUNNING" });
      const stored = await this.options.store.list();
      if (stored.length >= 100 && !stored.some((s) => s.symbol === symbol))
        throw new IntradayError("초기 분봉 보관은 최대 100종목입니다.");
      const instrument = await this.options.validateSymbol?.(symbol);
      const range = this.bounds(period);
      if (instrument)
        range.fromMs = Math.max(
          range.fromMs,
          Date.parse(`${instrument.listDate}T00:00:00+09:00`),
        );
      if (range.fromMs > range.toMs)
        throw new IntradayError("선택한 기간은 현재 종목의 상장일 이전입니다.");
      const data = await this.options.store.read(symbol, range.fromMs, range.toMs);
      const availableToMs = Math.min(range.toMs, this.now() - MINUTE_MS);
      // 누락 판정은 백테스트와 같게 유지하고, 재조회 범위는 누락이 있는 서울 날짜로 묶는다.
      const missingDates = new Set(intradayGaps(data.bars, this.tradingDates({
        from: intradayDate(range.fromMs),
        to: intradayDate(range.toMs),
      })).filter((gap) => {
        const firstMissingEndMs = Math.ceil(Math.max(gap.fromMs + MINUTE_MS, range.fromMs) / MINUTE_MS) * MINUTE_MS;
        return firstMissingEndMs <= Math.min(gap.toMs, availableToMs);
      }).map((gap) => intradayDate(gap.toMs)));
      let fetchedBars = 0;
      let pages = 0;
      let oldestEndMs: number | null = null;
      for (const date of missingDates) {
        signal.throwIfAborted();
        const day = intradayPeriodMs({ from: date, to: date });
        let dayPages = 0;
        const bars = await this.options.source.fetch(
          symbol,
          Math.max(range.fromMs, day.fromMs),
          Math.min(range.toMs, day.toMs),
          { signal, onProgress: (progress) => {
            dayPages = progress.pages;
            if (progress.oldestEndMs !== null)
              oldestEndMs = Math.min(oldestEndMs ?? Infinity, progress.oldestEndMs);
            update({ pages: pages + dayPages, fetchedBars: fetchedBars + progress.fetchedBars, oldestEndMs });
          } },
        );
        signal.throwIfAborted();
        // 성공한 빈 응답은 누락으로 남기고 다음 날짜로 진행한다. 실제 요청·파싱 오류는 catch에서 실패로 처리한다.
        if (bars.length) {
          await this.options.store.merge(symbol, bars, this.now());
          oldestEndMs = Math.min(oldestEndMs ?? Infinity, ...bars.map((bar) => bar.endMs));
        }
        pages += dayPages;
        fetchedBars += bars.length;
        update({ pages, fetchedBars, oldestEndMs });
      }
      signal.throwIfAborted();
      update({ status: "COMPLETED", fetchedBars, pages, oldestEndMs });
      this.notifyTerminal("collection", id);
    } catch (error) {
      const suspended = signal.aborted && this.closing && !this.cancelled.has(id);
      update({
        status: suspended ? "QUEUED" : signal.aborted ? "CANCELLED" : "FAILED",
        error: suspended ? null : signal.aborted
          ? "수집이 취소되었습니다."
          : error instanceof Error
            ? error.message
            : "분봉 수집에 실패했습니다.",
      });
      if (!signal.aborted) this.notifyTerminal("collection", id);
      if (!signal.aborted && this.recovering.has(id) && !this.isValidationRun(id)) this.options.onRecoveryFailure?.(true);
      throw error;
    }
  }
  listRunGroups(ownerId: string): HistoryGroup[] {
    const strategyId = sql<string>`json_extract(${intradayRuns.requestJson}, '$.strategyId')`;
    return this.options.db
      .select({ strategyId, total: count() })
      .from(intradayRuns)
      .where(this.runHistoryWhere(ownerId))
      .groupBy(strategyId)
      .orderBy(asc(strategyId))
      .all();
  }
  private runHistoryWhere(ownerId: string, strategyId?: string) {
    return and(
      eq(intradayRuns.ownerId, ownerId),
      sql`NOT EXISTS (SELECT 1 FROM intraday_validation_trials WHERE run_id = ${intradayRuns.id})`,
      sql`NOT EXISTS (SELECT 1 FROM configuration_search_items WHERE job_id = ${intradayRuns.id})`,
      strategyId === undefined ? undefined :
        sql`json_extract(${intradayRuns.requestJson}, '$.strategyId') = ${strategyId}`,
    );
  }
  countRuns(ownerId: string, strategyId?: string): number {
    return this.options.db
      .select({ total: count() })
      .from(intradayRuns)
      .where(this.runHistoryWhere(ownerId, strategyId))
      .get()!.total;
  }
  listRuns(
    ownerId: string,
    query: HistoryQuery = historyQuerySchema.parse({ limit: 100 }),
  ): IntradayRunSummary[] {
    const periodEnd = sql`json_extract(${intradayRuns.requestJson}, '$.period.to')`;
    const returnPct = sql<number | null>`CASE WHEN ${intradayRuns.status} = 'COMPLETED' THEN json_extract(${intradayRuns.resultJson}, '$.metrics.returnPct') END`;
    const maxDrawdownPct = sql<number | null>`CASE WHEN ${intradayRuns.status} = 'COMPLETED' THEN json_extract(${intradayRuns.resultJson}, '$.metrics.maxDrawdownPct') END`;
    const sharpe = sql<number | null>`CASE WHEN ${intradayRuns.status} = 'COMPLETED' THEN json_extract(${intradayRuns.resultJson}, '$.metrics.sharpe') END`;
    const columns = {
      createdAt: intradayRuns.createdAtMs,
      periodEnd,
      duration: sql`julianday(${periodEnd}) - julianday(json_extract(${intradayRuns.requestJson}, '$.period.from'))`,
      returnPct,
      cagrPct: sql`NULL`,
    };
    const column = columns[query.sort];
    return this.options.db
      .select({ ...runColumns, returnPct, maxDrawdownPct, sharpe })
      .from(intradayRuns)
      .where(this.runHistoryWhere(ownerId, query.strategyId))
      .orderBy(
        asc(sql`${column} IS NULL`),
        query.dir === "asc" ? asc(column) : desc(column),
        desc(intradayRuns.createdAtMs),
        desc(intradayRuns.id),
      )
      .limit(query.limit)
      .offset(query.offset)
      .all()
      .map((row) => ({
        ...this.run(row),
        metrics: row.returnPct === null || row.maxDrawdownPct === null
          ? null
          : { returnPct: row.returnPct, maxDrawdownPct: normalizeDrawdown(row.maxDrawdownPct), sharpe: row.sharpe },
      }));
  }
  getRun(ownerId: string, id: string): IntradayRun {
    const row = this.options.db
      .select()
      .from(intradayRuns)
      .where(and(eq(intradayRuns.id, id), eq(intradayRuns.ownerId, ownerId)))
      .get();
    if (!row) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);
    return this.run(row);
  }
  /** 취소 표시 이후에도 I/O가 끝나지 않은 작업은 관찰 화면에서 진행 중으로 취급한다. */
  pendingCancellationIds(): string[] {
    return [...this.controllers].filter(([, controller]) => controller.signal.aborted).map(([id]) => id);
  }
  deleteRunHistory(ownerId: string, id: string): void {
    const searchReference = this.options.db.get(sql`SELECT 1 FROM configuration_searches WHERE mode='intraday' AND source_job_id=${id}
      UNION ALL SELECT 1 FROM configuration_search_items WHERE job_id=${id} LIMIT 1`);
    if (searchReference) throw new IntradayError("설정 탐색에서 참조하는 결과입니다. 연결된 실험을 먼저 삭제하세요.", 409);
    const row = this.options.db
      .select({ id: intradayRuns.id, status: intradayRuns.status })
      .from(intradayRuns)
      .where(and(eq(intradayRuns.id, id), eq(intradayRuns.ownerId, ownerId)))
      .get();
    if (!row) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);
    if (this.options.db.select({ id: intradayValidations.id }).from(intradayValidations).where(eq(intradayValidations.sourceJobId, id)).get() || this.options.db.select({ id: intradayValidationTrials.id }).from(intradayValidationTrials).where(eq(intradayValidationTrials.runId, id)).get()) throw new IntradayError("검증 실험에서 참조하는 결과는 삭제할 수 없습니다.", 409);
    if (this.controllers.has(id) || !["COMPLETED", "FAILED", "CANCELLED"].includes(row.status)) {
      throw new IntradayError("실행이 완전히 종료된 백테스트만 삭제할 수 있습니다.", 409);
    }
    const deleted = this.options.db
      .delete(intradayRuns)
      .where(and(
        eq(intradayRuns.id, id),
        eq(intradayRuns.ownerId, ownerId),
        inArray(intradayRuns.status, ["COMPLETED", "FAILED", "CANCELLED"]),
      ))
      .returning({ id: intradayRuns.id })
      .get();
    if (!deleted) throw new IntradayError("백테스트 상태가 변경되어 삭제할 수 없습니다.", 409);
  }
  submit(ownerId: string, raw: unknown): IntradayRun {
    this.checkCapacity();
    const request = intradayRequestSchema.parse(raw);
    this.bounds(request.period, true);
    const id = randomUUID(),
      now = this.now();
    this.options.db
      .insert(intradayRuns)
      .values({
        id,
        ownerId,
        requestJson: JSON.stringify(request),
        status: "QUEUED",
        createdAtMs: now,
        updatedAtMs: now,
      })
      .run();
    this.enqueueRun(ownerId, id, request);
    return this.getRun(ownerId, id);
  }
  async storedRevision(request: IntradayRequest): Promise<string> {
    const { fromMs, toMs } = this.bounds(request.period, true);
    const data = await this.options.store.read(request.symbol, fromMs, toMs);
    if (!data.bars.length) throw new IntradayError("저장된 분봉 데이터가 없습니다.");
    return this.calculationRevision(data.revision);
  }
  getRunRequest(ownerId: string, id: string): { request: IntradayRequest; status: string } {
    const row = this.options.db.select({ requestJson: intradayRuns.requestJson, status: intradayRuns.status }).from(intradayRuns).where(and(eq(intradayRuns.id, id), eq(intradayRuns.ownerId, ownerId))).get();
    if (!row) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);
    return { request: intradayRequestSchema.parse(JSON.parse(row.requestJson)), status: row.status };
  }
  async currentStoredRevision(request: IntradayRequest): Promise<string> {
    this.bounds(request.period, true);
    // 보관 범위 밖인 0 구간은 Parquet 봉을 해독하지 않고 manifest revision만 읽는다.
    return this.calculationRevision((await this.options.store.read(request.symbol, 0, 0)).revision);
  }
  private calculationRevision(barRevision: string, rateVersion = readRiskFreeRateHistory(this.options.db).version): string {
    // 기간 검증은 봉뿐 아니라 Sharpe에 사용한 금리표도 동일하게 고정한다.
    return createHash("sha256").update(`${barRevision}:${rateVersion}`).digest("hex");
  }
  getRunState(ownerId: string, id: string): { status: string; error: string | null } {
    const row = this.options.db.select({ status: intradayRuns.status, error: intradayRuns.error }).from(intradayRuns).where(and(eq(intradayRuns.id, id), eq(intradayRuns.ownerId, ownerId))).get();
    if (!row) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);
    return row;
  }
  createInternalRun(ownerId: string, request: IntradayRequest, id: string): void {
    this.checkCapacity();
    this.bounds(request.period, true);
    const now = this.now();
    this.options.db.insert(intradayRuns).values({ id, ownerId, requestJson: JSON.stringify(request), status: "QUEUED", createdAtMs: now, updatedAtMs: now }).run();
  }
  startInternalRun(ownerId: string, id: string, request: IntradayRequest): void {
    if (!this.controllers.has(id) && !this.closing) this.enqueueRun(ownerId, id, request);
  }
  isDraining(id: string): boolean { return this.controllers.has(id); }
  private enqueueRun(ownerId: string, id: string, request: IntradayRequest): void {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.runQueue
      .then(() => this.performRun(ownerId, id, request, controller.signal))
      .finally(() => {
        this.controllers.delete(id);
        this.cancelled.delete(id);
        this.recovering.delete(id);
        this.recoveredCollections.delete(id);
      });
    this.runQueue = task.catch(() => {});
    this.track(this.runQueue);
  }
  cancelRun(ownerId: string, id: string): IntradayRun {
    const row = this.getRun(ownerId, id);
    if (ACTIVE.includes(row.status)) {
      this.cancelled.add(id);
      this.controllers.get(id)?.abort();
      const recoveredChild = this.recoveredCollections.get(id);
      if (recoveredChild) this.cancelCollection(ownerId, recoveredChild);
      this.options.db
        .update(intradayRuns)
        .set({
          status: "CANCELLED",
          error: "사용자가 실행을 취소했습니다.",
          updatedAtMs: this.now(),
        })
        .where(eq(intradayRuns.id, id))
        .run();
    }
    return this.getRun(ownerId, id);
  }
  private async performRun(
    ownerId: string,
    id: string,
    request: IntradayRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const update = (values: Partial<typeof intradayRuns.$inferInsert>) =>
      this.options.db
        .update(intradayRuns)
        .set({ ...values, updatedAtMs: this.now() })
        .where(eq(intradayRuns.id, id))
        .run();
    try {
      signal.throwIfAborted();
      const { fromMs, toMs } = this.bounds(request.period, true);
      const tradingDates = this.tradingDates(request.period);
      if (!tradingDates.length)
        throw new IntradayError("기간에 거래일이 없습니다.");
      update({ status: "PREPARING" });
      const instrument = await this.options.validateSymbol?.(request.symbol);
      if (instrument && request.period.from < instrument.listDate)
        throw new IntradayError(
          `현재 종목의 상장일(${instrument.listDate}) 이후 기간을 선택하세요.`,
        );
      const linked = this.options.db.select({ revision: intradayValidations.dataRevision, status: intradayValidations.status, executionVersion: intradayValidations.executionVersion, validationVersion: intradayValidations.validationVersion }).from(intradayValidationTrials).innerJoin(intradayValidations, eq(intradayValidationTrials.validationId, intradayValidations.id)).where(eq(intradayValidationTrials.runId, id)).get();
      const versions = readRuntimeVersions();
      if (linked && (linked.executionVersion !== versions.executionVersion || linked.validationVersion !== versions.validationVersion)) throw new IntradayError("검증 실행 버전이 변경되었습니다.");
      if (linked && linked.status !== "ACTIVE") throw new IntradayError("검증 실험이 종료되었습니다.");
      let data = await this.options.store.read(request.symbol, fromMs, toMs);
      if (linked && (!data.bars.length || this.calculationRevision(data.revision) !== linked.revision)) throw new IntradayError("고정된 시세 또는 금리 데이터가 변경되었거나 만료되었습니다.");
      const recoveredCollection = this.recoveredCollections.get(id);
      if (!linked && (recoveredCollection || intradayGaps(data.bars, tradingDates).length > 0)) {
        const collection = recoveredCollection ? this.getCollection(ownerId, recoveredCollection) : this.collect(
          ownerId,
          { symbol: request.symbol, period: request.period },
          id,
        );
        const cancel = () => {
          if (this.closing && !this.cancelled.has(id)) this.controllers.get(collection.id)?.abort();
          else this.cancelCollection(ownerId, collection.id);
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          await this.collectionQueue;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        signal.throwIfAborted();
        const completed = this.getCollection(ownerId, collection.id);
        if (completed.status !== "COMPLETED")
          throw new IntradayError(
            completed.error ?? "분봉 준비에 실패했습니다.",
          );
        data = await this.options.store.read(request.symbol, fromMs, toMs);
      }
      signal.throwIfAborted();
      update({ status: "RUNNING" });
      const riskFreeRates = readRiskFreeRateHistory(this.options.db);
      const result = await this.options.execute(
        { request, bars: data.bars, dataRevision: this.calculationRevision(data.revision, riskFreeRates.version), tradingDates, riskFreeRates },
        signal,
      );
      signal.throwIfAborted();
      if (linked && (result.executionVersion !== linked.executionVersion || result.dataRevision !== linked.revision || (await this.currentStoredRevision(request)) !== linked.revision)) throw new IntradayError("검증 중 분봉 데이터가 변경되었습니다.");
      signal.throwIfAborted();
      update({
        status: "COMPLETED",
        resultJson: JSON.stringify(result),
        error: null,
      });
      this.notifyTerminal("run", id);
    } catch (error) {
      const suspended = signal.aborted && this.closing && !this.cancelled.has(id);
      const recoveredChild = this.recoveredCollections.get(id);
      if (!suspended && recoveredChild) this.cancelCollection(ownerId, recoveredChild);
      update({
        status: suspended ? "QUEUED" : signal.aborted ? "CANCELLED" : "FAILED",
        error: suspended ? null : signal.aborted
          ? "실행이 취소되었습니다."
          : error instanceof Error
            ? error.message
            : "분봉 백테스트에 실패했습니다.",
      });
      if (!signal.aborted) this.notifyTerminal("run", id);
      if (!signal.aborted && this.recovering.has(id) && !this.isValidationRun(id)) this.options.onRecoveryFailure?.(true);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([
      ...this.tasks,
      ...(this.pruneTask ? [this.pruneTask] : []),
    ]);
  }
}
