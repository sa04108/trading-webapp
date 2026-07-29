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
import { deriveFactYearRange } from '../domain/fact-year-range.js';
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

/**
 * 재무 단계 진행 — 45분짜리 단계가 조용하지 않게 한다.
 *
 * 네 값 모두 **지금까지의 누적**이다. 이 단계는 진행을 그대로 factsJson 에 덮어쓰고
 * (더하지 않고) 화면은 그 값을 폴링하므로, 종목 단위 값을 넘기면 카운터가 종목마다
 * 12 → 0 → 8 → 0 으로 튀다 마지막에만 총계로 맞는다. 주입부가 감싸는
 * facts 모듈의 FactSyncProgress 는 savedFacts·gapCount 가 **종목 단위**라
 * (`이 종목에서 저장된 팩트 수`) 필드를 1:1 로 옮기면 정확히 그 증상이 난다 —
 * 둘 다 number 라서 타입으로는 잡히지 않는다. 주입부가 누적해서 넘겨야 한다.
 */
export interface FactPhaseProgress {
  /** 완료된 종목 수 (누적) */
  readonly symbolsDone: number;
  readonly symbolTotal: number;
  /** 이 단계에서 지금까지 저장된 팩트 수 (누적) */
  readonly savedFacts: number;
  /** 이 단계에서 지금까지 발견된 누락 수 (누적) */
  readonly gapCount: number;
}

export interface FactPhaseResult {
  readonly savedFacts: number;
  readonly gapCount: number;
  readonly stopReason: 'ERROR' | 'CANCELLED' | null;
  readonly failureMessage: string | null;
}

/** data_import_jobs.facts_json 의 내용. null 컬럼 = 재무를 요청하지 않은 잡 */
export interface FactsJobState {
  fromYear: number | null;
  toYear: number | null;
  symbolsDone: number;
  symbolTotal: number;
  savedFacts: number;
  gapCount: number;
  failureMessage: string | null;
  /** 재무 단계를 시작조차 하지 않은 사유 */
  skipReason: string | null;
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
  /**
   * 재무 수집 단계. market-data 는 facts 모듈을 import 하지 않는다 — 컨테이너가
   * 클로저로 잇는다 (dataset-routes 의 hasActiveBacktests 와 같은 관례).
   * 주입되지 않았으면 DART 가 설정되지 않은 배포다.
   */
  readonly factsPhase?: (args: {
    datasetId: string;
    fromYear: number;
    toYear: number;
    onProgress: (progress: FactPhaseProgress) => void;
    shouldStop: () => boolean;
  }) => Promise<FactPhaseResult>;
}

const DISK_CHECK_PAGE_INTERVAL = 50;

/**
 * 저장 배칭 상한 (2026-07-28 운영 장애, D-023). 페이지(최대 200봉)마다 저장하면
 * Parquet 파티션 재작성이 페이지 수만큼 반복돼 — 백필이 진행될수록 재작성 대상이
 * 커지는 쓰기 증폭 — DuckDB 메모리를 상한까지 밀어올려 1GB 박스를 질식시켰다.
 * 1만 봉(~월 파티션 1.2개 분량)씩 모아 저장하면 재작성이 월당 ~1회로 준다.
 */
const SAVE_BATCH_ROWS = 10_000;

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
   *
   * includeFacts 면 봉 뒤에 재무 단계를 같은 잡으로 이어 돌린다 — 잡 id·취소·폴링이
   * 하나여야 화면이 "동기화" 버튼 하나로 두 단계를 다룰 수 있다.
   */
  startSync(
    datasetId: string,
    options: { includeFacts?: boolean } = {},
  ): { job: { id: string }; done: Promise<void> } {
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
        phase: 'CANDLES',
        createdAtMs: this.deps.clock.now(),
      })
      .run();

    this.runningJobs.add(jobId);
    const done = this.run(dataset, collect, jobId, options.includeFacts === true).finally(() => {
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

  private async run(
    dataset: DatasetSummary,
    collect: '1m' | '1d',
    jobId: string,
    includeFacts: boolean,
  ): Promise<void> {
    let totalRows = 0;
    const candlesStartedAtMs = this.deps.clock.now();
    // 봉 단계가 끝나기 전의 실패는 봉 소요시간을 남기지 않는다 — 다음 실행의 예상치를
    // 반쪽 측정으로 오염시키지 않기 위해서다
    let candlesMs: number | null = null;
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
      candlesMs = this.deps.clock.now() - candlesStartedAtMs;
      if (totalRows > 0) {
        this.deps.datasetService.bumpVersion(
          dataset.id,
          `broker:${collect}:rows=${totalRows}:${this.deps.clock.now()}`,
          this.deps.clock.now(),
        );
      }

      const facts = includeFacts ? await this.runFactsPhase(dataset, jobId) : null;
      /**
       * 재무 단계가 **실제로 돌다가 멈춘** 경우에만 잡 상태를 따라간다. 건너뛴 경우
       * (skipReason: DART 미설정·봉 없음)는 중단이 아니다 — 봉은 성공했고 재무는
       * 시작조차 하지 않았으므로 COMPLETED 다. 재무를 요청하지 않은 잡(facts=null)도
       * 당연히 그대로다. 그래서 판단 기준이 stopReason 이다 — 단계가 돌았고 멈췄을
       * 때만 값이 채워진다.
       */
      const factsStop = facts?.stopReason ?? null;
      this.deps.db
        .update(dataImportJobs)
        .set({
          status:
            factsStop === 'CANCELLED' ? 'CANCELLED' : factsStop === 'ERROR' ? 'FAILED' : 'COMPLETED',
          // 재무가 멈춰도 봉 결과는 그대로 남는다 — 봉은 이미 저장까지 끝났다
          rowsImported: totalRows,
          candlesMs,
          phase: null,
          factsJson: facts === null ? null : JSON.stringify(facts.state),
          error: facts?.state.failureMessage ?? null,
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataImportJobs.id, jobId))
        .run();
      if (factsStop === 'CANCELLED') {
        this.deps.audit.record('system', 'data.sync.cancelled', { datasetId: dataset.id });
      } else if (factsStop === 'ERROR') {
        // 봉 실패와 같은 자리에 남긴다 — 감사 로그에는 완료로 적지 않는다
        this.deps.logger.error(
          {
            module: 'market-data',
            event: 'data.sync.facts-failed',
            datasetId: dataset.id,
            reason: facts?.state.failureMessage,
          },
          'broker sync facts phase failed',
        );
      } else {
        this.deps.audit.record('system', 'data.sync.completed', {
          datasetId: dataset.id,
          rows: totalRows,
          facts: facts?.state.savedFacts ?? 0,
        });
      }
    } catch (error) {
      const cancelled = error instanceof SyncCancelledError;
      // 실패·취소 잡의 phase 는 지우지 않는다 — 어느 단계에서 죽었는지가 정보다
      this.deps.db
        .update(dataImportJobs)
        .set({
          status: cancelled ? 'CANCELLED' : 'FAILED',
          rowsImported: totalRows,
          candlesMs,
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
   * 재무 단계. 봉 단계가 성공한 뒤에만 불린다.
   *
   * 여기서 throw 하지 않는 이유: 봉 수집은 이미 끝났고 그 결과(rowsImported)를
   * 기록해야 한다. 재무 실패를 예외로 올리면 catch 절이 봉 결과를 덮어 "봉도 실패"
   * 처럼 보인다 — 상태를 리포트로 되돌려 호출부가 둘을 함께 기록하게 한다.
   */
  private async runFactsPhase(
    dataset: DatasetSummary,
    jobId: string,
  ): Promise<{ state: FactsJobState; stopReason: 'ERROR' | 'CANCELLED' | null }> {
    const state: FactsJobState = {
      fromYear: null,
      toYear: null,
      symbolsDone: 0,
      symbolTotal: dataset.symbols.length,
      savedFacts: 0,
      gapCount: 0,
      failureMessage: null,
      skipReason: null,
    };

    if (!this.deps.factsPhase) {
      state.skipReason = 'DART_API_KEY 가 설정되지 않아 재무를 수집하지 않았습니다.';
      return { state, stopReason: null };
    }

    const coverage = this.deps.datasetService.getCoverage(dataset.id);
    const range = deriveFactYearRange(coverage, dataset.market);
    if (range === null) {
      state.skipReason =
        '봉이 수집되지 않아 재무 연도 범위를 정할 수 없습니다 — 봉을 먼저 수집하세요.';
      return { state, stopReason: null };
    }
    state.fromYear = range.fromYear;
    state.toYear = range.toYear;

    this.deps.db
      .update(dataImportJobs)
      .set({ phase: 'FACTS', factsJson: JSON.stringify(state) })
      .where(eq(dataImportJobs.id, jobId))
      .run();

    let result: FactPhaseResult;
    try {
      result = await this.deps.factsPhase({
        datasetId: dataset.id,
        fromYear: range.fromYear,
        toYear: range.toYear,
        onProgress: (progress) => {
          state.symbolsDone = progress.symbolsDone;
          state.symbolTotal = progress.symbolTotal;
          state.savedFacts = progress.savedFacts;
          state.gapCount = progress.gapCount;
          // 조용한 45분은 멈춘 것과 구분되지 않는다 — 종목마다 잡을 갱신한다
          this.deps.db
            .update(dataImportJobs)
            .set({ factsJson: JSON.stringify(state) })
            .where(eq(dataImportJobs.id, jobId))
            .run();
        },
        shouldStop: () => this.cancelRequested.has(jobId),
      });
    } catch (error) {
      // 주입된 함수가 계약을 깨고 예외로 실패하는 경우까지 여기서 흡수한다 — 위로
      // 올리면 catch 절이 봉 결과를 덮는다. 직전 onProgress 까지의 진행은 남는다.
      state.failureMessage = error instanceof Error ? error.message : String(error);
      return { state, stopReason: 'ERROR' };
    }

    state.savedFacts = result.savedFacts;
    state.gapCount = result.gapCount;
    state.failureMessage = result.failureMessage;
    // 중단 여부는 stopReason 이 정한다 (FactSyncService 와 같은 신호) — 호출부가
    // 이것만 보고 FAILED/CANCELLED 를 가른다
    return { state, stopReason: result.stopReason };
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
    let buffer: Candle[] = [];

    // 워터마크는 저장(flush) 이후에만 넓힌다 — 버퍼에만 있는 봉은 다음 실행이 재수집한다
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      await this.deps.candleRepository.saveCandles(dataset.id, buffer);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const candle of buffer) {
        if (candle.tsMs < min) min = candle.tsMs;
        if (candle.tsMs > max) max = candle.tsMs;
      }
      this.widenWatermark(dataset.id, symbol, min, max);
      args.newRange.min = args.newRange.min == null ? min : Math.min(args.newRange.min, min);
      args.newRange.max = args.newRange.max == null ? max : Math.max(args.newRange.max, max);
      rows += buffer.length;
      buffer = [];
    };

    try {
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
          buffer.push(...result.candles);
          let pageMin = Number.POSITIVE_INFINITY;
          for (const candle of result.candles) {
            if (candle.tsMs < pageMin) pageMin = candle.tsMs;
          }
          to = pageMin - 1;
          if (buffer.length >= SAVE_BATCH_ROWS) await flush();
        } else if (result.hasMore) {
          // 진행 없는 응답 — 조용히 완료로 위장하지 않는다
          throw new Error(
            `소스가 빈 페이지에 hasMore=true 를 반환했습니다 (${symbol}, to=${to}) — 페이지네이션 이상`,
          );
        }

        if (!result.hasMore) break;
      }
      // 성공 경로의 마지막 flush 실패는 그대로 전파한다 — 잡이 FAILED 로 남아야 한다
      await flush();
      return { rows };
    } finally {
      // 에러·취소로 빠져나갈 때도 이미 받은 봉은 저장을 시도한다 — 이어받기 보존.
      // 여기서의 저장 실패는 원래 에러를 가리지 않도록 삼킨다 (봉은 재수집 가능).
      try {
        await flush();
      } catch (flushError) {
        this.deps.logger.warn(
          { module: 'market-data', event: 'data.sync.flush-failed', symbol, err: flushError },
          'failed to persist buffered candles on abort — they will be re-fetched',
        );
      }
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
