import { EventEmitter } from 'node:events';
import { eq, inArray } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from '../../../shared/db/database.js';
import { corporateActionSyncJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { newId } from '../../../shared/ids.js';
import type { FactSyncService } from './fact-sync-service.js';

export type CorporateActionSyncJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type CorporateActionSyncJobRow = typeof corporateActionSyncJobs.$inferSelect;

const ACTIVE_STATUSES: CorporateActionSyncJobStatus[] = ['QUEUED', 'RUNNING'];
const TERMINAL_STATUSES: CorporateActionSyncJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export interface CorporateActionSyncRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
}

export interface CorporateActionSyncJobEvent {
  readonly jobId: string;
}

/**
 * 자본변동 일괄 수집 잡 (Task 7).
 * 200종목이면 수 분이 걸려 HTTP 요청 하나로 붙들 수 없다.
 * 잡을 만들어 뒤에서 돌리고 SSE 로 진행률을 흘린다.
 *
 * 백테스트의 `JobOrchestrator` 와 달리 자식 프로세스를 fork 하지 않는다.
 * 이 작업은 CPU 가 아니라 DART 응답 대기가 대부분이다.
 * 워커 프로세스를 띄울 이유가 없다 — 서버 이벤트 루프 안에서 비동기로
 * 돌려도 다른 요청을 막지 않는다.
 *
 * 동시에 한 잡만 허용한다.
 * 두 잡이 같은 종목을 나눠 수집하면 `symbol_facts_state` 갱신이 서로 경합한다.
 * DART rate limiter 도 전역 자원이라, 두 잡이 나눠 쓰면 화면에 보일
 * 소요시간 추정이 거짓말을 하게 된다.
 * 그래서 새 잡 생성 시점에 활성 잡이 있으면 409 로 거절한다.
 * 기존 잡을 대신 돌려주지 않는다 — 그러면 호출부가 "내 요청이 받아들여졌다"
 * 는 잘못된 인상을 받는다.
 */
export class CorporateActionSyncOrchestrator {
  readonly events = new EventEmitter();
  private readonly db: AppDatabase;
  private readonly cancelFlags = new Map<string, boolean>();

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly factSync: FactSyncService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.db = handle.db;
  }

  getJob(jobId: string): CorporateActionSyncJobRow | null {
    return (
      this.db
        .select()
        .from(corporateActionSyncJobs)
        .where(eq(corporateActionSyncJobs.id, jobId))
        .get() ?? null
    );
  }

  isTerminal(status: string): boolean {
    return TERMINAL_STATUSES.includes(status as CorporateActionSyncJobStatus);
  }

  hasActiveJob(): boolean {
    const row = this.db
      .select({ id: corporateActionSyncJobs.id })
      .from(corporateActionSyncJobs)
      .where(inArray(corporateActionSyncJobs.status, ACTIVE_STATUSES))
      .get();
    return row !== undefined;
  }

  /** 이미 도는 잡이 있으면 null 을 돌려준다 — 호출부(라우트)가 409 로 옮긴다. */
  start(request: CorporateActionSyncRequest): CorporateActionSyncJobRow | null {
    if (this.hasActiveJob()) return null;

    // 중복 심볼은 접는다 — FactSyncService.planFactSync 도 같은 방식으로 접으므로
    // totalSymbols 가 진행률의 분모로 쓰일 때 실제 종목 수와 어긋나지 않는다.
    const symbols = [...new Set(request.symbols)];
    const row: typeof corporateActionSyncJobs.$inferInsert = {
      id: newId('cas'),
      status: 'QUEUED',
      symbolsJson: JSON.stringify(symbols),
      fromYear: request.fromYear,
      toYear: request.toYear,
      doneSymbols: 0,
      totalSymbols: symbols.length,
      createdAtMs: this.clock.now(),
    };
    this.db.insert(corporateActionSyncJobs).values(row).run();
    this.cancelFlags.set(row.id, false);
    // 응답을 기다리지 않는다 — 잡 생성 요청은 등록만 확인하고 바로 돌아가야 한다.
    // 실패는 run() 내부에서 잡 상태(FAILED)로 흡수하므로 여기서 unhandled rejection
    // 이 되지 않는다.
    // run() 은 상태를 RUNNING 으로 옮기는 지점까지 동기적으로 실행된다(첫 await 전까지).
    // 그래서 아래 조회는 QUEUED 가 아니라 RUNNING 을 돌려준다.
    void this.run(row.id, symbols, request.fromYear, request.toYear);

    return this.getJob(row.id) as CorporateActionSyncJobRow;
  }

  /**
   * 취소 요청. `FactSyncService.runSync` 가 이미 갖고 있는 `shouldStop` 경로를
   * 쓴다 — 종목 경계에서 확인하므로 저장된 종목의 커버리지는 그대로 남는다.
   */
  cancel(jobId: string): 'CANCELLING' | 'NOT_CANCELLABLE' {
    const job = this.getJob(jobId);
    if (!job || !ACTIVE_STATUSES.includes(job.status as CorporateActionSyncJobStatus)) {
      return 'NOT_CANCELLABLE';
    }
    this.cancelFlags.set(jobId, true);
    return 'CANCELLING';
  }

  private setStatus(
    jobId: string,
    status: CorporateActionSyncJobStatus,
    patch: Partial<typeof corporateActionSyncJobs.$inferInsert> = {},
  ): void {
    const terminal = TERMINAL_STATUSES.includes(status);
    this.db
      .update(corporateActionSyncJobs)
      .set({ status, ...(terminal ? { completedAtMs: this.clock.now() } : {}), ...patch })
      .where(eq(corporateActionSyncJobs.id, jobId))
      .run();
    this.events.emit('job', { jobId } satisfies CorporateActionSyncJobEvent);
  }

  private async run(
    jobId: string,
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): Promise<void> {
    this.setStatus(jobId, 'RUNNING');
    try {
      const report = await this.factSync.syncCorporateActions(
        // 웹은 증분이다 — 매번 전 구간을 다시 받으면 버튼이 CLI 의 45분짜리가 된다.
        { symbols, fromYear, toYear, consolidated: true, mode: 'INCREMENTAL' },
        {
          onSymbolDone: (progress) => {
            this.db
              .update(corporateActionSyncJobs)
              .set({ doneSymbols: progress.index })
              .where(eq(corporateActionSyncJobs.id, jobId))
              .run();
            this.events.emit('job', { jobId } satisfies CorporateActionSyncJobEvent);
          },
          shouldStop: () => this.cancelFlags.get(jobId) === true,
        },
      );

      const status: CorporateActionSyncJobStatus =
        report.stopReason === 'CANCELLED'
          ? 'CANCELLED'
          : report.stopReason === 'ERROR'
            ? 'FAILED'
            : 'COMPLETED';
      this.setStatus(jobId, status, {
        savedFacts: report.savedFacts,
        gapCount: report.gaps.length,
        error: report.failureMessage,
      });
    } catch (error) {
      // syncCorporateActions 자체는 종목 단위 오류를 리포트로 흡수하므로 여기까지
      // 던져 올라오는 것은 그 바깥의 문제(예: DART 인증키 미설정)다.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { module: 'facts', event: 'corporate-action-sync.job.failed', jobId, err: error },
        'corporate action sync job failed',
      );
      this.setStatus(jobId, 'FAILED', { error: message });
    } finally {
      this.cancelFlags.delete(jobId);
    }
  }
}
