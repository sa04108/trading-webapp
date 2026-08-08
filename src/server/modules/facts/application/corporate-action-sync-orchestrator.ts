import { EventEmitter } from 'node:events';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from '../../../shared/db/database.js';
import { corporateActionSyncJobs } from '../../../shared/db/schema.js';
import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { newId } from '../../../shared/ids.js';
import type { FactSyncService } from './fact-sync-service.js';
import {
  estimateCorporateActionSyncCost,
  type CorporateActionSyncEstimate,
} from '../domain/sync-plan.js';

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
 * 백테스트의 `JobOrchestrator` 와 달리 자식 프로세스를 새로 만들지 않는다.
 * 이 작업은 CPU 가 아니라 DART 응답 대기가 대부분이다.
 * 워커 프로세스를 띄울 이유가 없다 — 서버 이벤트 루프 안에서 비동기로
 * 돌려도 다른 요청을 막지 않는다.
 *
 * 동시에 한 잡만 허용한다.
 * 두 잡이 같은 종목을 나눠 수집하면 `symbol_facts_state` 갱신이 서로 경합한다.
 * DART 호출 속도 제한도 전역 자원이라, 두 잡이 나눠 쓰면 화면에 보일
 * 소요시간 추정이 거짓말을 하게 된다.
 * 그래서 새 잡 생성 시점에 활성 잡이 있으면 409 로 거절한다.
 * 기존 잡을 201 인 척 돌려주지 않는다 — 호출부가 "내 요청이 받아들여졌다" 고 오해한다.
 * 대신 409 본문에 그 잡의 id 를 실어 보낸다.
 * 새로고침한 클라이언트가 도는 잡에 다시 붙을 길은 열어 둔다.
 */
export class CorporateActionSyncOrchestrator {
  readonly events = new EventEmitter();
  private readonly db: AppDatabase;
  private readonly cancelFlags = new Map<string, boolean>();
  /** `stop()` 이 켠다 — 종료 중에는 DB 에 더 쓰지 않는다 */
  private stopping = false;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly factSync: FactSyncService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.db = handle.db;
  }

  /**
   * 서버 부팅 경로에서만 불러야 한다 — `main.ts` 가 `jobOrchestrator.start()` 를
   * 부르는 자리에서 이 메서드도 함께 부른다.
   *
   * **생성자에서 부르면 안 된다(2026-08-08 리뷰 지적).**
   * `createContainer()` 는 서버뿐 아니라 모든 CLI 서브커맨드
   * (`admin:create`, `facts:sync` 등)도 부른다.
   * 그 CLI 들도 전부 서버와 같은 `DATABASE_PATH` 를 쓴다.
   * 생성자에서 정리하면 서버가 잡을 돌리는 도중 CLI 를 한 번만 실행해도
   * 그 `RUNNING` 행이 죽는다.
   * 그때 "서버가 재시작됐다" 는 거짓 메시지까지 남는다.
   * `hasActiveJob()` 도 거짓이 되어 두 번째 잡이 동시에 뜰 수 있다.
   * 동시 실행을 막으려던 불변식 전체가 무너진다.
   *
   * 서버 부팅 경로에서만 부르면 안전하다.
   * `JobOrchestrator.recoverInterrupted` 도 생성자가 아니라 `start()` 가 부른다.
   * 그 `start()` 를 `main.ts` 가 부팅 때만 부른다.
   * 그 시점에는 이 프로세스 안에서 아직 어떤 잡도 만든 적이 없다.
   * 그래서 `QUEUED`·`RUNNING` 으로 남은 행은 전부 이전 실행이 중간에 죽은 흔적이다.
   */
  recoverOrphaned(): void {
    const orphaned = this.db
      .select({ id: corporateActionSyncJobs.id })
      .from(corporateActionSyncJobs)
      .where(inArray(corporateActionSyncJobs.status, ACTIVE_STATUSES))
      .all();
    for (const { id } of orphaned) {
      const recovered = this.setStatus(
        id,
        'FAILED',
        { error: '서버 재시작으로 작업이 중단되었습니다. 다시 실행하세요.' },
        ACTIVE_STATUSES,
      );
      if (recovered) {
        this.logger.warn(
          { module: 'facts', event: 'corporate-action-sync.job.recovered', jobId: id },
          'orphaned corporate action sync job marked FAILED',
        );
      }
    }
  }

  /**
   * 위저드 게이트 화면(Task 8)의 "예상 호출·예상 시간" 이다.
   * 잡을 만들지 않고 계획만 미리 본다.
   * `planCorporateActionSync` 는 `start()` 가 실제로 돌릴 계획과 같은 값을 낸다.
   * 그래서 화면의 숫자와 실행이 갈리지 않는다.
   */
  estimate(request: CorporateActionSyncRequest): CorporateActionSyncEstimate {
    const plan = this.factSync.planCorporateActionSync(
      request.symbols,
      request.fromYear,
      request.toYear,
    );
    return estimateCorporateActionSyncCost(plan);
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

  /**
   * 지금 돌고 있는 잡 하나. 없으면 null.
   * 409 응답이 이 행의 id 를 실어 보낸다 — 새로고침한 클라이언트가 자기 잡에 다시 붙는다.
   */
  getActiveJob(): CorporateActionSyncJobRow | null {
    return (
      this.db
        .select()
        .from(corporateActionSyncJobs)
        .where(inArray(corporateActionSyncJobs.status, ACTIVE_STATUSES))
        .get() ?? null
    );
  }

  hasActiveJob(): boolean {
    return this.getActiveJob() !== null;
  }

  /**
   * 프로세스 종료 신호. `container.close()` 가 `database.close()` 앞에서 부른다.
   * 도는 잡에 취소 플래그를 세워 종목 경계에서 멈추게 한다.
   * 기다리지는 않는다 — 남은 `RUNNING` 행은 다음 부팅의 `recoverOrphaned()` 가 거둔다.
   */
  stop(): void {
    this.stopping = true;
    for (const jobId of this.cancelFlags.keys()) this.cancelFlags.set(jobId, true);
  }

  /**
   * 이미 도는 잡이 있으면 null 을 돌려준다 — 호출부(라우트)가 409 로 옮긴다.
   *
   * `hasActiveJob()` 조회와 `insert()` 사이에 다른 요청이 끼어들 틈이 없다.
   * better-sqlite3 가 동기 드라이버라서 그렇다 — 유니크 인덱스나 트랜잭션으로
   * 강제한 것이 아니다.
   * 드라이버를 비동기로 바꾸면 이 가정이 깨진다.
   */
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
    // 종목 단위 실패는 `run()` 안에서 잡 상태(`FAILED`)로 흡수한다.
    // 그래도 `.catch` 를 붙인다.
    // 종료 중에는 `run()` 의 상태 기록마저 닫힌 DB 를 만나 던질 수 있다.
    // 그러면 아무도 받지 않는 프로미스 거부가 프로세스 밖으로 샌다.
    //
    // `run()` 은 첫 `await` 전까지, 즉 상태를 `RUNNING` 으로 옮기는 지점까지
    // 곧바로 실행한다. 그래서 아래 조회는 `QUEUED` 가 아니라 `RUNNING` 을 돌려준다.
    void this.run(row.id, symbols, request.fromYear, request.toYear).catch((error: unknown) => {
      this.logger.error(
        { module: 'facts', event: 'corporate-action-sync.job.unhandled', jobId: row.id, err: error },
        'corporate action sync job rejected outside its own handler',
      );
    });

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
    // 이 프로세스가 만든 잡이 아니면 플래그를 볼 주체가 없다.
    // `recoverOrphaned()` 를 부르지 않는 부팅 경로가 남긴 행이 여기 해당한다.
    // 종료 중에 상태를 못 옮기고 끊긴 행도 마찬가지다.
    // 그대로 두면 `hasActiveJob()` 이 참으로 굳어 새 잡이 계속 409 가 된다.
    // 그래서 플래그 대신 행을 직접 끝낸다.
    if (!this.cancelFlags.has(jobId)) {
      this.setStatus(
        jobId,
        'CANCELLED',
        { error: '이 서버가 돌리는 작업이 아니어서 기록만 종료했습니다.' },
        ACTIVE_STATUSES,
      );
      return 'CANCELLING';
    }
    this.cancelFlags.set(jobId, true);
    return 'CANCELLING';
  }

  /**
   * `expectedCurrent` 를 주면 현재 상태가 그중 하나일 때만 쓴다.
   * `JobQueue.setStatus` 의 `expectedCurrent` 와 같은 관례다(`compare-and-swap`).
   * 이 오케스트레이터는 한 프로세스 안에서 잡 하나만 돌린다.
   * 그래서 **한 프로세스만 이 DB 를 쓴다는 전제 아래서는** 경합할 두 번째 쓰기가 없다.
   * 그 전제는 CLI 가 같은 `DATABASE_PATH` 를 열면 곧바로 깨진다.
   * 가드를 박아 두면 그때도 종료된 잡을 덮어쓰는 사고가 코드 자체로 막힌다.
   * 반환값은 실제로 갱신됐는지다.
   */
  private setStatus(
    jobId: string,
    status: CorporateActionSyncJobStatus,
    patch: Partial<typeof corporateActionSyncJobs.$inferInsert> = {},
    expectedCurrent?: readonly CorporateActionSyncJobStatus[],
  ): boolean {
    const terminal = TERMINAL_STATUSES.includes(status);
    const where = expectedCurrent
      ? and(eq(corporateActionSyncJobs.id, jobId), inArray(corporateActionSyncJobs.status, expectedCurrent))
      : eq(corporateActionSyncJobs.id, jobId);
    const result = this.db
      .update(corporateActionSyncJobs)
      .set({ status, ...(terminal ? { completedAtMs: this.clock.now() } : {}), ...patch })
      .where(where)
      .run();
    this.events.emit('job', { jobId } satisfies CorporateActionSyncJobEvent);
    return result.changes > 0;
  }

  private async run(
    jobId: string,
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): Promise<void> {
    try {
      // `try` 안에 둔다 — 밖에 두면 여기서 던진 예외를 아래 `catch` 가 못 받는다.
      this.setStatus(jobId, 'RUNNING', {}, ['QUEUED']);
      const report = await this.factSync.syncCorporateActions(
        // 웹은 증분이다 — 매번 전 구간을 다시 받으면 버튼이 CLI 의 45분짜리가 된다.
        { symbols, fromYear, toYear, consolidated: true, mode: 'INCREMENTAL' },
        {
          onSymbolDone: (progress) => {
            this.db
              .update(corporateActionSyncJobs)
              .set({ doneSymbols: progress.index })
              .where(
                and(
                  eq(corporateActionSyncJobs.id, jobId),
                  inArray(corporateActionSyncJobs.status, ACTIVE_STATUSES),
                ),
              )
              .run();
            this.events.emit('job', { jobId } satisfies CorporateActionSyncJobEvent);
          },
          shouldStop: () => this.cancelFlags.get(jobId) === true,
        },
      );

      // 종료 중이면 여기서 멈춘다 — DB 가 이미 닫혔을 수 있다.
      // 남은 `RUNNING` 행은 다음 부팅의 `recoverOrphaned()` 가 `FAILED` 로 거둔다.
      if (this.stopping) return;

      const status: CorporateActionSyncJobStatus =
        report.stopReason === 'CANCELLED'
          ? 'CANCELLED'
          : report.stopReason === 'ERROR'
            ? 'FAILED'
            : 'COMPLETED';
      this.setStatus(
        jobId,
        status,
        { savedFacts: report.savedFacts, gapCount: report.gaps.length, error: report.failureMessage },
        ACTIVE_STATUSES,
      );
    } catch (error) {
      // `syncCorporateActions` 는 종목 단위 오류를 리포트로 흡수한다.
      // 그래서 여기까지 올라오는 것은 그 바깥의 문제다(예: DART 인증키 미설정).
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { module: 'facts', event: 'corporate-action-sync.job.failed', jobId, err: error },
        'corporate action sync job failed',
      );
      if (this.stopping) return;
      this.setStatus(jobId, 'FAILED', { error: message }, ACTIVE_STATUSES);
    } finally {
      this.cancelFlags.delete(jobId);
    }
  }
}
