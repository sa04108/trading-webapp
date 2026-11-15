import { randomUUID } from "node:crypto";
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
  type IntradayTimeframe,
} from "../../../../shared/schemas/intraday.js";
import {
  aggregateIntradayBars,
  intradayGaps,
  type IntradayEngineInput,
} from "../../../../runtime/modules/intraday/domain/engine.js";

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
}
type CollectionRow = typeof intradayCollections.$inferSelect;
type RunRow = Omit<typeof intradayRuns.$inferSelect, "resultJson"> & {
  resultJson?: string | null;
};
const ACTIVE = ["QUEUED", "PREPARING", "RUNNING"];
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
  private readonly tasks = new Set<Promise<void>>();
  private collectionQueue: Promise<void> = Promise.resolve();
  private runQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private pruneTask: Promise<void> | null = null;
  private lastPrunedAt = -Infinity;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    // 재시작 뒤 실행 중처럼 보이는 행을 남기지 않는다. 명시적인 재시도로 다시 준비한다.
    options.db
      .update(intradayRuns)
      .set({
        status: "FAILED",
        error:
          "서버가 재시작되어 실행이 중단됐습니다. 설정을 복제해 다시 실행하세요.",
        updatedAtMs: this.now(),
      })
      .where(inArray(intradayRuns.status, ACTIVE))
      .run();
    options.db
      .update(intradayCollections)
      .set({
        status: "FAILED",
        error: "서버가 재시작되어 수집이 중단됐습니다. 다시 수집하세요.",
        updatedAtMs: this.now(),
      })
      .where(inArray(intradayCollections.status, ACTIVE))
      .run();
    this.timer = setInterval(() => {
      void this.prune().catch(() => {});
    }, 3_600_000);
    this.timer.unref();
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
    return {
      id: row.id,
      symbol: row.symbol,
      period: JSON.parse(row.periodJson) as IntradayPeriod,
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
    return {
      id: row.id,
      request: JSON.parse(row.requestJson) as IntradayRequest,
      status: row.status as IntradayRun["status"],
      error: row.error,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
      ...(row.resultJson
        ? { result: JSON.parse(row.resultJson) as IntradayResult }
        : {}),
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
    timeframe: IntradayTimeframe,
  ): Promise<IntradayChart> {
    const { fromMs, toMs } = this.bounds(period);
    const data = await this.options.store.read(
      symbol,
      fromMs,
      Math.min(toMs, this.now() - 60_000),
    );
    const bars = aggregateIntradayBars(data.bars, timeframe);
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
      bars: bars.slice(-2000),
      totalBars: bars.length,
      truncated: bars.length > 2000,
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
      now = this.now(),
      controller = new AbortController();
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
    this.controllers.set(id, controller);
    const task = this.collectionQueue
      .then(() =>
        this.performCollection(
          id,
          request.symbol,
          request.period,
          controller.signal,
        ),
      )
      .finally(() => this.controllers.delete(id));
    this.collectionQueue = task.catch(() => {});
    this.track(this.collectionQueue);
    return this.getCollection(ownerId, id);
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
      const bars = await this.options.source!.fetch(
        symbol,
        range.fromMs,
        range.toMs,
        { signal, onProgress: (p) => update(p) },
      );
      signal.throwIfAborted();
      if (!bars.length)
        throw new IntradayError(
          "요청 구간에서 토스가 반환한 분봉이 없습니다. 조회 가능 기간·상장일·휴장 여부를 확인하세요.",
        );
      await this.options.store.merge(symbol, bars, this.now());
      signal.throwIfAborted();
      update({ status: "COMPLETED", fetchedBars: bars.length });
    } catch (error) {
      update({
        status: signal.aborted ? "CANCELLED" : "FAILED",
        error: signal.aborted
          ? "수집이 취소되었습니다."
          : error instanceof Error
            ? error.message
            : "분봉 수집에 실패했습니다.",
      });
      throw error;
    }
  }
  listRunGroups(ownerId: string): HistoryGroup[] {
    const strategyId = sql<string>`json_extract(${intradayRuns.requestJson}, '$.strategyId')`;
    return this.options.db
      .select({ strategyId, total: count() })
      .from(intradayRuns)
      .where(eq(intradayRuns.ownerId, ownerId))
      .groupBy(strategyId)
      .orderBy(asc(strategyId))
      .all();
  }
  private runHistoryWhere(ownerId: string, strategyId?: string) {
    return and(
      eq(intradayRuns.ownerId, ownerId),
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
    const columns = {
      createdAt: intradayRuns.createdAtMs,
      periodEnd,
      duration: sql`julianday(${periodEnd}) - julianday(json_extract(${intradayRuns.requestJson}, '$.period.from'))`,
      returnPct,
      cagrPct: sql`NULL`,
    };
    const column = columns[query.sort];
    return this.options.db
      .select({ ...runColumns, returnPct, maxDrawdownPct })
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
          : { returnPct: row.returnPct, maxDrawdownPct: row.maxDrawdownPct },
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
    const row = this.options.db
      .select({ id: intradayRuns.id, status: intradayRuns.status })
      .from(intradayRuns)
      .where(and(eq(intradayRuns.id, id), eq(intradayRuns.ownerId, ownerId)))
      .get();
    if (!row) throw new IntradayError("분봉 백테스트를 찾을 수 없습니다.", 404);
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
      controller = new AbortController(),
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
    this.controllers.set(id, controller);
    const task = this.runQueue
      .then(() => this.performRun(ownerId, id, request, controller.signal))
      .finally(() => this.controllers.delete(id));
    this.runQueue = task.catch(() => {});
    this.track(this.runQueue);
    return this.getRun(ownerId, id);
  }
  cancelRun(ownerId: string, id: string): IntradayRun {
    const row = this.getRun(ownerId, id);
    if (ACTIVE.includes(row.status)) {
      this.controllers.get(id)?.abort();
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
      let data = await this.options.store.read(request.symbol, fromMs, toMs);
      if (intradayGaps(data.bars, tradingDates).length > 0) {
        const collection = this.collect(
          ownerId,
          { symbol: request.symbol, period: request.period },
          id,
        );
        const cancel = () => this.cancelCollection(ownerId, collection.id);
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
      const result = await this.options.execute(
        { request, bars: data.bars, dataRevision: data.revision, tradingDates },
        signal,
      );
      signal.throwIfAborted();
      update({
        status: "COMPLETED",
        resultJson: JSON.stringify(result),
        error: null,
      });
    } catch (error) {
      update({
        status: signal.aborted ? "CANCELLED" : "FAILED",
        error: signal.aborted
          ? "실행이 취소되었습니다."
          : error instanceof Error
            ? error.message
            : "분봉 백테스트에 실패했습니다.",
      });
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
