import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { brokerSyncState, dataImportJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { Candle, Timeframe } from '../domain/candle.js';
import { aggregateToHourly } from '../domain/aggregate.js';
import {
  fromLocalTime,
  getSessionForMarket,
  toLocalTime,
  type ExchangeSession,
} from '../domain/exchange-session.js';
import type { DatasetService, DatasetSummary } from './dataset-service.js';
import type { CandleRepository, MarketDataSource } from './ports.js';

export class SyncAlreadyRunningError extends Error {
  constructor(datasetId: string) {
    super(`이 데이터셋의 동기화가 이미 실행 중입니다: ${datasetId}`);
    this.name = 'SyncAlreadyRunningError';
  }
}

class SyncCancelledError extends Error {
  constructor() {
    super('사용자 요청으로 취소됨 — 동기화를 다시 실행하면 이어받습니다');
    this.name = 'SyncCancelledError';
  }
}

export class SyncUnsupportedDatasetError extends Error {
  constructor(timeframe: string) {
    super(
      `${timeframe} 데이터셋은 동기화할 수 없습니다 — 1h(1분봉 수집·집계) 또는 1d(일봉 수집) 데이터셋이어야 합니다`,
    );
    this.name = 'SyncUnsupportedDatasetError';
  }
}

export interface BrokerSyncDeps {
  readonly db: AppDatabase;
  readonly source: MarketDataSource;
  readonly candleRepository: CandleRepository;
  readonly datasetService: DatasetService;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditLogService;
  /** 이 여유 공간(bytes) 미만이면 수집을 시작·계속하지 않는다 */
  readonly minFreeDiskBytes: number;
  readonly freeDiskBytes: () => number;
}

const DISK_CHECK_PAGE_INTERVAL = 50;

interface SyncedRange {
  min: number | null;
  max: number | null;
}

/**
 * 증권사 캔들 동기화 (설계 2026-07-28-broker-sync-design.md).
 *
 * 데이터셋 timeframe 이 수집 방식을 결정한다 (CSV import 와 같은 관례):
 * 1h → 1분봉을 수집하고 세션 경계로 시간봉을 재집계, 1d → 일봉을 그대로 수집.
 * 페이지마다 즉시 저장하고 워터마크(broker_sync_state)를 저장 후에만 갱신하므로,
 * 어느 지점에서 중단돼도 다음 실행이 이어받는다 (스펙 §13).
 */
export class BrokerSyncService {
  /** 이 프로세스에서 실행 중인 잡 — 취소는 in-process 플래그로 전달된다 */
  private readonly runningJobs = new Set<string>();
  private readonly cancelRequested = new Set<string>();

  constructor(private readonly deps: BrokerSyncDeps) {}

  /**
   * 동기화 시작. 검증(존재·timeframe·중복 실행)은 동기적으로 던지고,
   * 수집은 백그라운드로 진행한다. done 은 절대 reject 하지 않는다 —
   * 실패는 잡 레코드(FAILED)에 기록된다.
   */
  startSync(datasetId: string): { job: { id: string }; done: Promise<void> } {
    const dataset = this.deps.datasetService.getDataset(datasetId);
    if (!dataset) throw new Error(`데이터셋을 찾을 수 없습니다: ${datasetId}`);

    const collect = this.collectTimeframe(dataset.timeframe);

    const running = this.deps.db
      .select({ id: dataImportJobs.id })
      .from(dataImportJobs)
      .where(
        and(
          eq(dataImportJobs.datasetId, datasetId),
          eq(dataImportJobs.sourceType, 'BROKER'),
          inArray(dataImportJobs.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .get();
    if (running) throw new SyncAlreadyRunningError(datasetId);

    const jobId = newId('imp');
    this.deps.db
      .insert(dataImportJobs)
      .values({
        id: jobId,
        datasetId,
        status: 'RUNNING',
        sourceType: 'BROKER',
        createdAtMs: this.deps.clock.now(),
      })
      .run();

    this.runningJobs.add(jobId);
    const done = this.run(dataset, collect, jobId).finally(() => {
      this.runningJobs.delete(jobId);
      this.cancelRequested.delete(jobId);
    });
    return { job: { id: jobId }, done };
  }

  /**
   * 실행 중인 동기화 취소 요청. 페이지 경계에서 반영되며, 저장된 페이지와 워터마크는
   * 남으므로 재실행이 이어받는다. 이 프로세스의 잡만 취소할 수 있다.
   */
  cancelSync(jobId: string): 'CANCELLING' | 'NOT_RUNNING' {
    if (!this.runningJobs.has(jobId)) return 'NOT_RUNNING';
    this.cancelRequested.add(jobId);
    return 'CANCELLING';
  }

  private throwIfCancelled(jobId: string): void {
    if (this.cancelRequested.has(jobId)) throw new SyncCancelledError();
  }

  /** 프로세스 재시작으로 고아가 된 BROKER 잡 정리 — 부팅 경로에서 호출한다 */
  recoverInterrupted(): number {
    const result = this.deps.db
      .update(dataImportJobs)
      .set({
        status: 'FAILED',
        error: '서버 재시작으로 중단됨 — 동기화를 다시 실행하면 이어받습니다',
        completedAtMs: this.deps.clock.now(),
      })
      .where(
        and(
          eq(dataImportJobs.sourceType, 'BROKER'),
          inArray(dataImportJobs.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .run();
    return result.changes;
  }

  private collectTimeframe(datasetTimeframe: Timeframe): '1m' | '1d' {
    if (datasetTimeframe === '1h') return '1m';
    if (datasetTimeframe === '1d') return '1d';
    throw new SyncUnsupportedDatasetError(datasetTimeframe);
  }

  private async run(dataset: DatasetSummary, collect: '1m' | '1d', jobId: string): Promise<void> {
    let totalRows = 0;
    try {
      this.checkDisk();
      const session = collect === '1m' ? getSessionForMarket(dataset.market) : null;
      const now = this.deps.clock.now();

      for (const symbol of dataset.symbols) {
        this.throwIfCancelled(jobId);
        const newRange: SyncedRange = { min: null, max: null };

        // 증분: 워터마크 이후 → 현재
        const before = this.getState(dataset.id, symbol);
        if (before?.syncedLastTsMs != null) {
          const incremental = await this.pullRange(dataset, collect, symbol, {
            jobId,
            fromTsMs: before.syncedLastTsMs + 1,
            toTsMs: now,
            newRange,
          });
          totalRows += incremental.rows;
        }

        // 백필: API 보관 깊이 바닥까지. 증분이 워터마크를 만들었을 수 있으므로 재조회.
        const state = this.getState(dataset.id, symbol);
        if (state?.backfillDoneAtMs == null) {
          const backfill = await this.pullRange(dataset, collect, symbol, {
            jobId,
            fromTsMs: 0,
            toTsMs: (state?.syncedFirstTsMs ?? now + 1) - 1,
            newRange,
          });
          totalRows += backfill.rows;
          // fromTsMs=0 구간을 에러 없이 소진 = API 바닥 도달
          this.markBackfillDone(dataset.id, symbol);
        }

        if (session && newRange.min != null && newRange.max != null) {
          await this.reaggregateHourly(dataset, symbol, session, newRange.min, newRange.max);
        }
      }

      await this.deps.datasetService.refreshCoverage(dataset.id, dataset.market, dataset.timeframe);
      if (totalRows > 0) {
        this.deps.datasetService.bumpVersion(
          dataset.id,
          `broker:${collect}:rows=${totalRows}:${this.deps.clock.now()}`,
          this.deps.clock.now(),
        );
      }

      this.deps.db
        .update(dataImportJobs)
        .set({ status: 'COMPLETED', rowsImported: totalRows, completedAtMs: this.deps.clock.now() })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      this.deps.audit.record('system', 'data.sync.completed', {
        datasetId: dataset.id,
        rows: totalRows,
      });
    } catch (error) {
      const cancelled = error instanceof SyncCancelledError;
      this.deps.db
        .update(dataImportJobs)
        .set({
          status: cancelled ? 'CANCELLED' : 'FAILED',
          rowsImported: totalRows,
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      if (cancelled) {
        this.deps.audit.record('system', 'data.sync.cancelled', { datasetId: dataset.id });
        this.deps.logger.info(
          { module: 'market-data', event: 'data.sync.cancelled', datasetId: dataset.id },
          'broker sync cancelled',
        );
        return;
      }
      this.deps.logger.error(
        { module: 'market-data', event: 'data.sync.failed', datasetId: dataset.id, err: error },
        'broker sync failed',
      );
    }
  }

  /**
   * [fromTsMs, toTsMs] 를 과거 방향 페이지로 수집해 소진한다. 에러는 그대로 던져
   * 잡을 실패시킨다 — 저장된 페이지와 워터마크는 남으므로 다음 실행이 이어받는다.
   */
  private async pullRange(
    dataset: DatasetSummary,
    collect: '1m' | '1d',
    symbol: string,
    args: { jobId: string; fromTsMs: number; toTsMs: number; newRange: SyncedRange },
  ): Promise<{ rows: number }> {
    let rows = 0;
    if (args.toTsMs < args.fromTsMs) return { rows };
    let to = args.toTsMs;
    let pages = 0;

    for (;;) {
      this.throwIfCancelled(args.jobId);
      if (pages > 0 && pages % DISK_CHECK_PAGE_INTERVAL === 0) this.checkDisk();
      const result = await this.deps.source.fetchCandles({
        market: dataset.market,
        timeframe: collect,
        symbol,
        fromTsMs: args.fromTsMs,
        toTsMs: to,
      });
      pages += 1;

      if (result.candles.length > 0) {
        await this.deps.candleRepository.saveCandles(dataset.id, result.candles);
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const candle of result.candles) {
          if (candle.tsMs < min) min = candle.tsMs;
          if (candle.tsMs > max) max = candle.tsMs;
        }
        this.widenWatermark(dataset.id, symbol, min, max);
        args.newRange.min = args.newRange.min == null ? min : Math.min(args.newRange.min, min);
        args.newRange.max = args.newRange.max == null ? max : Math.max(args.newRange.max, max);
        rows += result.candles.length;
        to = min - 1;
      } else if (result.hasMore) {
        // 진행 없는 응답 — 조용히 완료로 위장하지 않는다
        throw new Error(
          `소스가 빈 페이지에 hasMore=true 를 반환했습니다 (${symbol}, to=${to}) — 페이지네이션 이상`,
        );
      }

      if (!result.hasMore) return { rows };
    }
  }

  private getState(datasetId: string, symbol: string) {
    return this.deps.db
      .select()
      .from(brokerSyncState)
      .where(and(eq(brokerSyncState.datasetId, datasetId), eq(brokerSyncState.symbol, symbol)))
      .get();
  }

  /** 저장이 끝난 뒤에만 호출 — 워터마크가 저장소보다 앞서 주장하지 않는다 */
  private widenWatermark(datasetId: string, symbol: string, minTsMs: number, maxTsMs: number): void {
    const existing = this.getState(datasetId, symbol);
    if (!existing) {
      this.deps.db
        .insert(brokerSyncState)
        .values({ datasetId, symbol, syncedFirstTsMs: minTsMs, syncedLastTsMs: maxTsMs })
        .run();
      return;
    }
    this.deps.db
      .update(brokerSyncState)
      .set({
        syncedFirstTsMs: Math.min(existing.syncedFirstTsMs ?? minTsMs, minTsMs),
        syncedLastTsMs: Math.max(existing.syncedLastTsMs ?? maxTsMs, maxTsMs),
      })
      .where(eq(brokerSyncState.id, existing.id))
      .run();
  }

  private markBackfillDone(datasetId: string, symbol: string): void {
    const existing = this.getState(datasetId, symbol);
    if (!existing) {
      this.deps.db
        .insert(brokerSyncState)
        .values({ datasetId, symbol, backfillDoneAtMs: this.deps.clock.now() })
        .run();
      return;
    }
    this.deps.db
      .update(brokerSyncState)
      .set({ backfillDoneAtMs: this.deps.clock.now() })
      .where(eq(brokerSyncState.id, existing.id))
      .run();
  }

  /**
   * 이번에 새로 받은 1m 구간의 시간봉 재집계. 시작점을 세션 현지 일 시작으로 넓혀
   * 저장소 전체 기준으로 집계하므로, 페이지·구간 경계에서 반쪽 시간봉이 생기지 않는다.
   * 현지 일 단위로 나눠 스트리밍 — 수년치 백필도 하루치(수백 봉)만 메모리에 든다.
   */
  private async reaggregateHourly(
    dataset: DatasetSummary,
    symbol: string,
    session: ExchangeSession,
    fromTsMs: number,
    toTsMs: number,
  ): Promise<void> {
    const dayStartTsMs = fromLocalTime(toLocalTime(fromTsMs, session).dayIndex, 0, session);

    let buffer: Candle[] = [];
    let currentDay = Number.NaN;
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const hourly = aggregateToHourly(buffer, session);
      if (hourly.length > 0) await this.deps.candleRepository.saveCandles(dataset.id, hourly);
      buffer = [];
    };

    for await (const candle of this.deps.candleRepository.getCandles({
      datasetId: dataset.id,
      market: dataset.market,
      timeframe: '1m',
      symbols: [symbol],
      fromTsMs: dayStartTsMs,
      toTsMs,
    })) {
      const day = toLocalTime(candle.tsMs, session).dayIndex;
      if (day !== currentDay) {
        await flush();
        currentDay = day;
      }
      buffer.push(candle);
    }
    await flush();
  }

  private checkDisk(): void {
    const free = this.deps.freeDiskBytes();
    if (free < this.deps.minFreeDiskBytes) {
      throw new Error(
        `디스크 여유 공간 부족 (${Math.round(free / 1024 / 1024)}MB < ${Math.round(this.deps.minFreeDiskBytes / 1024 / 1024)}MB) — 수집을 중단합니다`,
      );
    }
  }
}
