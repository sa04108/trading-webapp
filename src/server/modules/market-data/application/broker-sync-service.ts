import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '../../../shared/db/database.js';
import { dataSyncJobs, symbolSlices, symbols as symbolsTable } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import { newId } from '../../../shared/ids.js';
import type { Logger } from '../../../shared/logger.js';
import type { AuditLogService } from '../../audit/audit-service.js';
import type { Candle } from '../domain/candle.js';
import { aggregateToHourly } from '../domain/aggregate.js';
import { collectTimeframeForSlice, type DatasetSlice } from '../domain/dataset-slice.js';
import {
  fromLocalTime,
  getSessionForMarket,
  toLocalTime,
  type ExchangeSession,
} from '../domain/exchange-session.js';
import { deriveFactYearRange } from '../domain/fact-year-range.js';
import { minuteBackfillFloorTsMs } from '../domain/minute-backfill.js';
import type { Market } from '../domain/candle.js';
import type { SymbolService } from './symbol-service.js';
import type { CandleRepository, MarketDataSource } from './ports.js';

export class SyncAlreadyRunningError extends Error {
  constructor() {
    // 동시 실행은 전역으로 하나다 — 대상이 종목 집합이 된 뒤 데이터셋 단위 가드는
    // 의미가 없다(같은 종목을 두 잡이 동시에 긁으면 워터마크가 서로를 덮는다)
    super('데이터 수집이 이미 실행 중입니다 — 완료 후 다시 시도하세요');
    this.name = 'SyncAlreadyRunningError';
  }
}

class SyncCancelledError extends Error {
  constructor() {
    super('사용자 요청으로 취소됨 — 동기화를 다시 실행하면 이어받습니다');
    this.name = 'SyncCancelledError';
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

/** data_sync_jobs.facts_json 의 내용. null 컬럼 = 재무를 요청하지 않은 잡 */
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
  readonly symbolService: SymbolService;
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
    codes: readonly string[];
    fromYear: number;
    toYear: number;
    onProgress: (progress: FactPhaseProgress) => void;
    shouldStop: () => boolean;
  }) => Promise<FactPhaseResult>;
  /**
   * 잡 종료 알림. market-data 는 notification 모듈을 import 하지 않는다 — container 가
   * 클로저로 잇는다 (factsPhase 와 같은 관례). 미주입이면 알림 없이 동작한다 (테스트 등).
   */
  readonly notify?: (input: {
    severity: 'info' | 'error';
    title: string;
    body: string;
    link: string;
  }) => void;
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
 * 증권사 캔들 동기화 (설계 2026-07-28-broker-sync-design.md, 2026-07-30-dataset-symbol-group-design.md).
 *
 * 대상은 **종목 집합**이다 (설계 2026-07-31-symbol-as-first-class) — 사용자가 종목 화면에서
 * 여러 개를 체크해 한 번에 동기화한다. 슬라이스가 수집 방식을 결정한다:
 * 1m → 1분봉을 수집하고 세션 경계로 시간봉을 재집계, 1d → 일봉을 그대로 수집.
 * 워터마크(symbol_slices)·커버리지는 (code, slice) 로 관리된다 — 데이터셋 축이 없으므로
 * 같은 종목을 열 개 데이터셋이 참조해도 수집은 한 번이다.
 * 페이지마다 즉시 저장하고 워터마크는 저장 후에만 갱신하므로, 어느 지점에서 중단돼도
 * 다음 실행이 이어받는다 (스펙 §13).
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
    codes: readonly string[],
    options: { slice?: DatasetSlice; includeFacts?: boolean } = {},
  ): { job: { id: string }; done: Promise<void> } {
    if (codes.length === 0) throw new Error('동기화할 종목이 없습니다');
    const registered = this.deps.db
      .select({ code: symbolsTable.code, market: symbolsTable.market })
      .from(symbolsTable)
      .where(inArray(symbolsTable.code, [...codes]))
      .all();
    const known = new Map(registered.map((row) => [row.code, row.market as Market]));
    const missing = codes.filter((code) => !known.has(code));
    if (missing.length > 0) throw new Error(`등록되지 않은 종목입니다: ${missing.join(', ')}`);

    const slice = options.slice ?? '1d';
    const running = this.deps.db
      .select({ id: dataSyncJobs.id })
      .from(dataSyncJobs)
      .where(inArray(dataSyncJobs.status, ['QUEUED', 'RUNNING']))
      .get();
    if (running) throw new SyncAlreadyRunningError();

    const targets = [...new Set(codes)]
      .sort()
      .map((code) => ({ code, market: known.get(code)! }));

    const jobId = newId('imp');
    this.deps.db
      .insert(dataSyncJobs)
      .values({
        id: jobId,
        status: 'RUNNING',
        sourceType: 'BROKER',
        symbolsJson: JSON.stringify(targets.map((target) => target.code)),
        slice,
        phase: 'CANDLES',
        createdAtMs: this.deps.clock.now(),
      })
      .run();

    this.runningJobs.add(jobId);
    const done = this.run(targets, slice, jobId, options.includeFacts === true).finally(() => {
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
      .update(dataSyncJobs)
      .set({
        status: 'FAILED',
        error: '서버 재시작으로 중단됨 — 동기화를 다시 실행하면 이어받습니다',
        completedAtMs: this.deps.clock.now(),
      })
      .where(
        and(
          eq(dataSyncJobs.sourceType, 'BROKER'),
          inArray(dataSyncJobs.status, ['QUEUED', 'RUNNING']),
        ),
      )
      .run();
    // 재시작으로 조용히 FAILED 처리된 잡은 화면 어디서도 원인을 알 수 없다 — 요약 알림 1건으로 알린다
    if (result.changes > 0) {
      this.deps.notify?.({
        severity: 'error',
        title: '데이터 동기화가 중단되었습니다',
        body: `${result.changes}건 — 서버 재시작으로 실패 처리되었습니다`,
        link: '/datasets',
      });
    }
    return result.changes;
  }

  private async run(
    targets: ReadonlyArray<{ code: string; market: Market }>,
    slice: DatasetSlice,
    jobId: string,
    includeFacts: boolean,
  ): Promise<void> {
    const collect = collectTimeframeForSlice(slice);
    let totalRows = 0;
    const candlesStartedAtMs = this.deps.clock.now();
    // 봉 단계가 끝나기 전의 실패는 봉 소요시간을 남기지 않는다 — 다음 실행의 예상치를
    // 반쪽 측정으로 오염시키지 않기 위해서다
    let candlesMs: number | null = null;
    try {
      this.checkDisk();
      const now = this.deps.clock.now();

      for (const { code: symbol, market } of targets) {
        this.throwIfCancelled(jobId);
        const session = slice === '1m' ? getSessionForMarket(market) : null;
        const newRange: SyncedRange = { min: null, max: null };

        // 증분: 워터마크 이후 → 현재
        const before = this.getState(symbol, slice);
        if (before?.syncedLastTsMs != null) {
          const incremental = await this.pullRange(market, collect, symbol, slice, {
            jobId,
            fromTsMs: before.syncedLastTsMs + 1,
            toTsMs: now,
            newRange,
          });
          totalRows += incremental.rows;
        }

        // 백필: 일봉은 API 보관 깊이 바닥(0)까지, 분봉은 2년 상한까지 — 분봉은
        // 종목·기간에 비례해 폭발하므로 수집 자체를 묶는다(minute-backfill.ts).
        // 증분이 워터마크를 만들었을 수 있으므로 재조회.
        const state = this.getState(symbol, slice);
        if (state?.backfillDoneAtMs == null) {
          const backfillFromTsMs = slice === '1m' ? minuteBackfillFloorTsMs(now) : 0;
          const backfill = await this.pullRange(market, collect, symbol, slice, {
            jobId,
            fromTsMs: backfillFromTsMs,
            toTsMs: (state?.syncedFirstTsMs ?? now + 1) - 1,
            newRange,
          });
          totalRows += backfill.rows;
          // 일봉은 fromTsMs=0 구간을 에러 없이 소진 = API 바닥 도달. 분봉은 상한
          // 구간을 소진했을 뿐 API 바닥에는 닿지 않았을 수 있다 — 아래 플래그 의미 참고.
          this.markBackfillDone(symbol, slice);
        }

        // 시간봉 재집계는 분봉 슬라이스에서만 의미가 있다 — session 은 이미 slice==='1m'
        // 일 때만 채워지지만, 의도를 코드로 남기기 위해 slice 로도 명시적으로 가둔다
        if (slice === '1m' && session && newRange.min != null && newRange.max != null) {
          await this.reaggregateHourly(market, symbol, session, newRange.min, newRange.max);
        }

        // 커버리지·버전·수집시각은 종목마다 닫는다 — 200종목 중 180에서 멈춘 실행도
        // 완료된 180종목은 화면에 정확히 반영돼야 한다
        await this.deps.symbolService.refreshCoverage(symbol, market, slice);
        if (newRange.min != null) {
          this.deps.symbolService.bumpVersion(
            symbol,
            slice,
            `broker:${collect}:${newRange.min}-${newRange.max}`,
            this.deps.clock.now(),
          );
        }
        this.deps.symbolService.markSynced(symbol, slice, this.deps.clock.now());
      }

      candlesMs = this.deps.clock.now() - candlesStartedAtMs;

      const facts = includeFacts ? await this.runFactsPhase(targets, jobId) : null;
      /**
       * 재무 단계가 **실제로 돌다가 멈춘** 경우에만 잡 상태를 따라간다. 건너뛴 경우
       * (skipReason: DART 미설정·봉 없음)는 중단이 아니다 — 봉은 성공했고 재무는
       * 시작조차 하지 않았으므로 COMPLETED 다. 재무를 요청하지 않은 잡(facts=null)도
       * 당연히 그대로다. 그래서 판단 기준이 stopReason 이다 — 단계가 돌았고 멈췄을
       * 때만 값이 채워진다.
       */
      const factsStop = facts?.stopReason ?? null;
      const finalStatus =
        factsStop === 'CANCELLED' ? 'CANCELLED' : factsStop === 'ERROR' ? 'FAILED' : 'COMPLETED';
      this.deps.db
        .update(dataSyncJobs)
        .set({
          status: finalStatus,
          // 재무가 멈춰도 봉 결과는 그대로 남는다 — 봉은 이미 저장까지 끝났다
          rowsImported: totalRows,
          candlesMs,
          phase: null,
          factsJson: facts === null ? null : JSON.stringify(facts.state),
          error: facts?.state.failureMessage ?? null,
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataSyncJobs.id, jobId))
        .run();
      // notify 는 잡 상태를 이미 기록한 뒤의 부가 동작이다 — 여기서 던지면 바깥 catch 가
      // 방금 쓴 상태(COMPLETED 등)를 FAILED 로 덮어써 버리므로 지역적으로 흡수한다
      try {
        this.deps.notify?.({
          severity: finalStatus === 'FAILED' ? 'error' : 'info',
          title:
            finalStatus === 'COMPLETED'
              ? '데이터 동기화가 완료되었습니다'
              : finalStatus === 'FAILED'
                ? '데이터 동기화가 실패했습니다'
                : '데이터 동기화가 취소되었습니다',
          body:
            `${targets.length}종목 · ${totalRows.toLocaleString('ko-KR')}행` +
            (facts?.state.failureMessage ? ` — ${facts.state.failureMessage}` : ''),
          link: '/datasets',
        });
      } catch (notifyError) {
        this.deps.logger.warn(
          { module: 'market-data', event: 'data.sync.notify-failed', jobId, err: notifyError },
          'broker sync completion notify failed',
        );
      }
      if (factsStop === 'CANCELLED') {
        this.deps.audit.record('system', 'data.sync.cancelled', { symbols: targets.length });
      } else if (factsStop === 'ERROR') {
        // 봉 실패와 같은 자리에 남긴다 — 감사 로그에는 완료로 적지 않는다
        this.deps.logger.error(
          {
            module: 'market-data',
            event: 'data.sync.facts-failed',
            symbols: targets.length,
            reason: facts?.state.failureMessage,
          },
          'broker sync facts phase failed',
        );
      } else {
        this.deps.audit.record('system', 'data.sync.completed', {
          symbols: targets.length,
          rows: totalRows,
          facts: facts?.state.savedFacts ?? 0,
        });
      }
    } catch (error) {
      const cancelled = error instanceof SyncCancelledError;
      // 실패·취소 잡의 phase 는 지우지 않는다 — 어느 단계에서 죽었는지가 정보다
      this.deps.db
        .update(dataSyncJobs)
        .set({
          status: cancelled ? 'CANCELLED' : 'FAILED',
          rowsImported: totalRows,
          candlesMs,
          error: error instanceof Error ? error.message : String(error),
          completedAtMs: this.deps.clock.now(),
        })
        .where(eq(dataSyncJobs.id, jobId))
        .run();
      this.deps.notify?.({
        severity: cancelled ? 'info' : 'error',
        title: cancelled ? '데이터 동기화가 취소되었습니다' : '데이터 동기화가 실패했습니다',
        body:
          `${targets.length}종목 — ` +
          (error instanceof Error ? error.message : String(error)),
        link: '/datasets',
      });
      if (cancelled) {
        this.deps.audit.record('system', 'data.sync.cancelled', { symbols: targets.length });
        this.deps.logger.info(
          { module: 'market-data', event: 'data.sync.cancelled', symbols: targets.length },
          'broker sync cancelled',
        );
        return;
      }
      this.deps.logger.error(
        { module: 'market-data', event: 'data.sync.failed', symbols: targets.length, err: error },
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
    targets: ReadonlyArray<{ code: string; market: Market }>,
    jobId: string,
  ): Promise<{ state: FactsJobState; stopReason: 'ERROR' | 'CANCELLED' | null }> {
    const state: FactsJobState = {
      fromYear: null,
      toYear: null,
      symbolsDone: 0,
      symbolTotal: targets.length,
      savedFacts: 0,
      gapCount: 0,
      failureMessage: null,
      skipReason: null,
    };

    if (!this.deps.factsPhase) {
      state.skipReason = 'DART 인증키가 설정되지 않아 재무를 수집하지 않았습니다.';
      return { state, stopReason: null };
    }

    /**
     * DART 는 국내 공시 기관이므로 비KR 은 애초에 수집 대상이 아니다. 여기서 먼저
     * 걸러야 하는 이유: 아래 `deriveFactYearRange` 가 `getSessionForMarket` 을 부르고
     * 그 호출은 `factsPhase` 를 감싼 try **밖**이라, 예외가 `run` 의 catch 로 올라가
     * 봉 결과까지 실패로 덮는다 — 이 단계가 throw 하지 않게 만든 이유가 무너진다.
     * 라우트 선검증과 factsSyncEstimator 가 정상 경로를 막지만 방어선은 여기서 닫는다.
     */
    const foreign = targets.filter((target) => target.market !== 'KR');
    if (foreign.length > 0) {
      state.skipReason =
        `재무 데이터는 국내(KR) 종목만 지원합니다 — ` +
        `${foreign.map((target) => target.code).join(', ')} 는 재무를 수집하지 않았습니다.`;
      return { state, stopReason: null };
    }

    const codes = targets.map((target) => target.code);
    // coverage 행의 종목 필드 이름이 code 로 바뀌었다 — deriveFactYearRange 는
    // { symbol, firstTsMs, lastTsMs, slice } 모양을 받으므로 여기서 맞춰 준다
    const coverage = this.deps.symbolService
      .getCoverage(codes)
      .map((row) => ({ ...row, symbol: row.code }));
    const range = deriveFactYearRange(coverage, 'KR');
    if (range === null) {
      state.skipReason =
        '봉이 수집되지 않아 재무 연도 범위를 정할 수 없습니다 — 봉을 먼저 수집하세요.';
      return { state, stopReason: null };
    }
    state.fromYear = range.fromYear;
    state.toYear = range.toYear;

    this.deps.db
      .update(dataSyncJobs)
      .set({ phase: 'FACTS', factsJson: JSON.stringify(state) })
      .where(eq(dataSyncJobs.id, jobId))
      .run();

    let result: FactPhaseResult;
    try {
      result = await this.deps.factsPhase({
        codes,
        fromYear: range.fromYear,
        toYear: range.toYear,
        onProgress: (progress) => {
          state.symbolsDone = progress.symbolsDone;
          state.symbolTotal = progress.symbolTotal;
          state.savedFacts = progress.savedFacts;
          state.gapCount = progress.gapCount;
          // 조용한 45분은 멈춘 것과 구분되지 않는다 — 종목마다 잡을 갱신한다
          this.deps.db
            .update(dataSyncJobs)
            .set({ factsJson: JSON.stringify(state) })
            .where(eq(dataSyncJobs.id, jobId))
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
    market: Market,
    collect: '1m' | '1d',
    symbol: string,
    slice: DatasetSlice,
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
      await this.deps.candleRepository.saveCandles(buffer);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const candle of buffer) {
        if (candle.tsMs < min) min = candle.tsMs;
        if (candle.tsMs > max) max = candle.tsMs;
      }
      this.widenWatermark(symbol, slice, min, max);
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
          market,
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
            `증권사 응답이 올바르지 않아 수집을 중단했습니다 — ${symbol} 종목에서 빈 응답과 "다음 페이지 있음" 이 함께 왔습니다`,
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

  private getState(symbol: string, slice: DatasetSlice) {
    return this.deps.db
      .select()
      .from(symbolSlices)
      .where(and(eq(symbolSlices.code, symbol), eq(symbolSlices.slice, slice)))
      .get();
  }

  /** 저장이 끝난 뒤에만 호출 — 워터마크가 저장소보다 앞서 주장하지 않는다 */
  private widenWatermark(
    symbol: string,
    slice: DatasetSlice,
    minTsMs: number,
    maxTsMs: number,
  ): void {
    const existing = this.getState(symbol, slice);
    if (!existing) {
      this.deps.db
        .insert(symbolSlices)
        .values({ code: symbol, slice, syncedFirstTsMs: minTsMs, syncedLastTsMs: maxTsMs })
        .run();
      return;
    }
    this.deps.db
      .update(symbolSlices)
      .set({
        syncedFirstTsMs: Math.min(existing.syncedFirstTsMs ?? minTsMs, minTsMs),
        syncedLastTsMs: Math.max(existing.syncedLastTsMs ?? maxTsMs, maxTsMs),
      })
      .where(eq(symbolSlices.id, existing.id))
      .run();
  }

  /**
   * 백필 완료 표시. 일봉은 API 보관 깊이 바닥까지 소진했다는 뜻 그대로다. 분봉은
   * 2년 상한이 있어 진짜 API 바닥에는 닿지 않는다 — 그리고 그 상한 하한은
   * "지금부터 24개월 전"이라 시간이 지나면 앞으로 밀린다. 따라서 분봉에서 이
   * 플래그의 의미는 "API 바닥"이 아니라 **"현재 상한 기준으로 더 당길 백필 작업이
   * 없다"**다. 상한이 미래로 밀려도 다시 당겨 채울 필요는 없다 — 창이 항상 앞으로만
   * 밀리므로(과거로 되돌아가지 않으므로) 이미 커버한 구간을 다시 훑는 넓히기/gap-fill
   * 분기는 두지 않는다.
   */
  private markBackfillDone(symbol: string, slice: DatasetSlice): void {
    const existing = this.getState(symbol, slice);
    if (!existing) {
      this.deps.db
        .insert(symbolSlices)
        .values({ code: symbol, slice, backfillDoneAtMs: this.deps.clock.now() })
        .run();
      return;
    }
    this.deps.db
      .update(symbolSlices)
      .set({ backfillDoneAtMs: this.deps.clock.now() })
      .where(eq(symbolSlices.id, existing.id))
      .run();
  }

  /**
   * 이번에 새로 받은 1m 구간의 시간봉 재집계. 시작점을 세션 현지 일 시작으로 넓혀
   * 저장소 전체 기준으로 집계하므로, 페이지·구간 경계에서 반쪽 시간봉이 생기지 않는다.
   * 현지 일 단위로 나눠 스트리밍 — 수년치 백필도 하루치(수백 봉)만 메모리에 든다.
   */
  private async reaggregateHourly(
    market: Market,
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
      if (hourly.length > 0) await this.deps.candleRepository.saveCandles(hourly);
      buffer = [];
    };

    for await (const candle of this.deps.candleRepository.getCandles({
      market,
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
