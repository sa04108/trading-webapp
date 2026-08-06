import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { addCalendarDays, kstDateOf } from '../domain/kst-date.js';
import { KrxQuotaError, type KrxHistoricalUniverseSource } from './ports.js';
import type { SymbolMasterService } from './symbol-master-service.js';

export type BackfillState = 'IDLE' | 'RUNNING' | 'BUDGET_EXHAUSTED' | 'FAILED';

export interface BackfillStatus {
  readonly state: BackfillState;
  /** 다음 수집 대상 — 완주(IDLE)했을 때는 더 채울 날짜가 없으므로 null 이다 */
  readonly cursorDate: string | null;
  /** 마지막 start() 의 fromDate — 스케줄러가 매일 같은 값으로 재개를 시도할 때 쓴다 */
  readonly targetStartDate: string | null;
  /** 마지막 start() 의 toDate — 지정하지 않은 호출(오늘까지)은 null 이다 */
  readonly targetEndDate: string | null;
  readonly error: string | null;
}

export interface SymbolMasterBackfillDeps {
  readonly service: SymbolMasterService;
  readonly source: KrxHistoricalUniverseSource;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dailyCallBudget?: number;
}

/** 엔드포인트당 기준. KRX 한도 10,000 에서 사용자 조회 몫을 남긴 값이다. */
const DEFAULT_DAILY_CALL_BUDGET = 9000;

/**
 * ingestDate 한 번이 엔드포인트 하나에 쓰는 최악 호출 수. 날짜마다 KOSPI/KOSDAQ 의
 * 일별시세·기본정보를 한 번씩만 부르므로, 어느 엔드포인트로 봐도 1을 넘지 않는다.
 * KRX 한도가 엔드포인트별이라 예산도 엔드포인트 기준으로 잰다.
 */
const CALLS_PER_ENDPOINT_PER_DATE = 1;

/**
 * KRX 일별 호출 예산 안에서 종목 마스터를 과거로 백필하는 러너.
 *
 * 상태는 메모리에만 있다 — 진행 위치는 SymbolMasterService 의 coverage 가 이미
 * 영속하므로, 이미 커버된 날짜는 재개 시 KRX 호출 없이 통과한다(ALREADY_COVERED).
 * 그래서 스케줄러는 매일 같은 fromDate 로 start() 를 다시 불러도 된다.
 */
export class SymbolMasterBackfill {
  private readonly deps: SymbolMasterBackfillDeps;
  private readonly dailyCallBudget: number;
  private state: BackfillState = 'IDLE';
  private cursorDate: string | null = null;
  private targetStartDate: string | null = null;
  private targetEndDate: string | null = null;
  private error: string | null = null;
  private stopRequested = false;

  constructor(deps: SymbolMasterBackfillDeps) {
    this.deps = deps;
    this.dailyCallBudget = deps.dailyCallBudget ?? DEFAULT_DAILY_CALL_BUDGET;
  }

  status(): BackfillStatus {
    return {
      state: this.state,
      cursorDate: this.cursorDate,
      targetStartDate: this.targetStartDate,
      targetEndDate: this.targetEndDate,
      error: this.error,
    };
  }

  /**
   * 이미 RUNNING 이면 무시한다 — 스케줄러가 겹쳐 부르더라도 루프가 둘로 늘어나지
   * 않게 하기 위해서다. 루프는 fire-and-forget 로 시작하고 start() 자체는 즉시
   * 반환한다: 백필은 분 단위로 걸릴 수 있는 작업이라 호출부를 막아 세우지 않는다.
   *
   * toDate 를 생략하면 예전처럼 "오늘(KST)까지" 다. 위저드가 백테스트 기간 전체를
   * 수집할 때는 toDate 를 넘겨 그 기간만 채운다 — 안 그러면 730일치 요청 하나가
   * 오늘까지 계속 이어져 필요 이상으로 KRX 호출 예산을 쓴다.
   */
  start(fromDate: string, toDate?: string): void {
    if (this.state === 'RUNNING') return;

    this.targetStartDate = fromDate;
    this.targetEndDate = toDate ?? null;
    this.stopRequested = false;
    this.state = 'RUNNING';
    this.cursorDate = fromDate;
    this.error = null;

    void this.runLoop(fromDate, toDate);
  }

  /** 진행 중 루프를 다음 날짜 경계에서 멈춘다 — 그 자리(cursorDate)에서 재개할 수 있다 */
  stop(): void {
    this.stopRequested = true;
  }

  /**
   * unhandled rejection 을 만들지 않도록 루프 전체를 try/catch 로 감싼다 —
   * start() 가 이 promise 를 기다리지 않으므로 여기서 놓친 예외는 프로세스
   * 전체로 번진다.
   */
  private async runLoop(fromDate: string, toDate?: string): Promise<void> {
    try {
      // 오늘(KST) 은 루프 시작 시점에 한 번만 정한다. 실제 운영에서 8000 호출
      // 예산으로 하루치 백필이 자정을 넘기는 일은 상정하지 않는다 — 넘기면
      // 다음날 스케줄러가 같은 fromDate 로 다시 불러 이어간다.
      const upperBound = toDate ?? kstDateOf(this.deps.clock.now());
      let cursor = fromDate;

      while (cursor <= upperBound) {
        if (this.stopRequested) {
          this.cursorDate = cursor;
          this.state = 'IDLE';
          return;
        }

        // 가장 많이 쓴 엔드포인트를 기준으로 본다 — 한도가 엔드포인트마다 따로 걸리므로
        // 그중 하나라도 예산을 넘기면 멈춰야 한다.
        if (
          this.deps.source.todayMaxEndpointCallCount() + CALLS_PER_ENDPOINT_PER_DATE >
          this.dailyCallBudget
        ) {
          this.cursorDate = cursor;
          this.state = 'BUDGET_EXHAUSTED';
          return;
        }

        this.cursorDate = cursor;
        await this.deps.service.ingestDate(cursor);
        cursor = addCalendarDays(cursor, 1);
      }

      this.cursorDate = null;
      this.state = 'IDLE';
    } catch (error) {
      if (error instanceof KrxQuotaError) {
        // cursorDate 는 실패한 바로 그 날짜에 남겨 둔다 — 재개 지점 표시용이다.
        this.state = 'BUDGET_EXHAUSTED';
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.state = 'FAILED';
      this.deps.logger.error(
        { module: 'market-data', event: 'symbol-master.backfill-failed', cursorDate: this.cursorDate, error: this.error },
        '종목 마스터 백필이 날짜 처리 중 실패했다',
      );
    }
  }
}
