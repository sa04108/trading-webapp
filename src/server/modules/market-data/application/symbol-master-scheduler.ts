import type { Clock } from '../../../shared/clock.js';
import type { Logger } from '../../../shared/logger.js';
import { addCalendarDays, kstDateOf, kstHourOf } from '../domain/kst-date.js';
import type { SymbolMasterBackfill } from './symbol-master-backfill.js';
import type { SymbolMasterService } from './symbol-master-service.js';

export interface SymbolMasterSchedulerDeps {
  readonly service: SymbolMasterService;
  readonly backfill: SymbolMasterBackfill;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * 외부 타이머가 1시간 간격으로 호출하는 종목 마스터 일일 동기화 스케줄러.
 *
 * KST 18:00 이후 매일 자동으로 전날 종목 마스터를 수집하고, 백필 예산이
 * 다시 리셋되면 재개한다.
 */
export class SymbolMasterScheduler {
  private ticking = false;

  constructor(private readonly deps: SymbolMasterSchedulerDeps) {}

  /**
   * 일일 동기화 스케줄러 tick. 외부 타이머가 1시간 간격으로 호출한다.
   *
   * 규약:
   * - KST 18:00 이전이면 아무것도 하지 않는다 (장 마감·KRX 집계 여유).
   * - 백필이 RUNNING 중이면 스케줄러의 갭 채움 루프를 건너뛴다 (백필이 이미 처리 중).
   * - 마지막 커버일 < 어제(KST) 이면 그 다음날부터 어제까지 ingestDate 순차 실행 — 갭 자동 보정.
   * - 백필이 BUDGET_EXHAUSTED 면 backfill.start(원래 fromDate) 재호출 — 날짜가 바뀌어 예산이 리셋됐을 때 이어가게 한다.
   * - ingest 중 오류가 발생하면 logger.warn 후 tick 종료 — 다음 tick 이 재시도.
   */
  async tick(): Promise<void> {
    // 이전 tick 이 진행 중이면 중복 호출 방지
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.tickImpl();
    } finally {
      this.ticking = false;
    }
  }

  private async tickImpl(): Promise<void> {
    const now = this.deps.clock.now();
    const hour = kstHourOf(now);

    // KST 18:00 이전이면 no-op
    if (hour < 18) {
      return;
    }

    // 어제(KST)
    const today = kstDateOf(now);
    const yesterday = addCalendarDays(today, -1);

    // 마지막 커버일
    const ranges = this.deps.service.coverageRanges();
    const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : undefined;
    const lastCoverageEndDate = lastRange?.endDate;

    // 백필 상태 확인 — RUNNING 중이면 스케줄러의 갭 채움은 건너뜀
    const backfillStatus = this.deps.backfill.status();
    const backfillRunning = backfillStatus.state === 'RUNNING';

    // 마지막 커버일 < 어제 이고 백필이 RUNNING 아니면 갭 보정
    if (
      !backfillRunning
      && lastCoverageEndDate !== undefined
      && lastCoverageEndDate < yesterday
    ) {
      const nextDate = addCalendarDays(lastCoverageEndDate, 1);
      for (let cursor = nextDate; cursor <= yesterday; cursor = addCalendarDays(cursor, 1)) {
        try {
          await this.deps.service.ingestDate(cursor);
        } catch (error) {
          this.deps.logger.warn(
            {
              module: 'market-data',
              event: 'symbol-master.scheduler-ingest-error',
              date: cursor,
              error: error instanceof Error ? error.message : String(error),
            },
            `종목 마스터 일일 동기화 중 오류가 발생했다. 다음 tick 에서 재시도한다`,
          );
          return;
        }
      }
    }

    // 백필이 BUDGET_EXHAUSTED 면 재개
    if (
      backfillStatus.state === 'BUDGET_EXHAUSTED'
      && backfillStatus.targetStartDate !== null
    ) {
      this.deps.backfill.start(backfillStatus.targetStartDate);
    }
  }
}
