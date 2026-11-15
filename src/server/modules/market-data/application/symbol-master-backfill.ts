import { EventEmitter } from "node:events";
import { newId } from "../../../../runtime/shared/ids.js";
import type { JobItem, JobStatus } from "../../../../shared/schemas/jobs.js";
import type { Clock } from "../../../../runtime/shared/clock.js";
import type { Logger } from "../../../shared/logger.js";
import {
  addCalendarDays,
  kstDateOf,
} from "../../../../runtime/modules/market-data/domain/kst-date.js";
import {
  KrxQuotaError,
  type KrxHistoricalUniverseSource,
} from "../../../../runtime/modules/market-data/application/ports.js";
import type { SymbolMasterService } from "../../../../runtime/modules/market-data/application/symbol-master-service.js";

export type BackfillState = "IDLE" | "RUNNING" | "BUDGET_EXHAUSTED" | "FAILED";

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
  private state: BackfillState = "IDLE";
  private cursorDate: string | null = null;
  private targetStartDate: string | null = null;
  private targetEndDate: string | null = null;
  private error: string | null = null;
  private stopRequested = false;
  readonly jobEvents = new EventEmitter();
  private job: JobItem | null = null;

  currentJob(): JobItem | null { return this.job; }

  private updateJob(status: JobStatus, current: number, total: number, label: string | null, error: string | null = null): void {
    if (!this.job) return;
    const now = this.deps.clock.now();
    const finished = ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status);
    this.job = { ...this.job, status, phase: label, error, updatedAtMs: now,
      finishedAtMs: finished ? now : null, cancellable: status === "RUNNING",
      progress: { current, total, percent: total ? Math.min(100, current / total * 100) : null, label } };
    for (const listener of this.jobEvents.rawListeners("job")) {
      try { listener.call(this.jobEvents, this.job); } catch { /* 관찰자 오류가 수집을 중단하지 않는다. */ }
    }
  }

  cancelJob(id: string): boolean {
    if (!this.job || this.job.id !== id || this.job.status !== "RUNNING") return false;
    this.stopRequested = true;
    const p = this.job.progress!;
    this.updateJob("CANCELLING", p.current!, p.total!, p.label);
    return true;
  }

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
    if (this.state === "RUNNING") return;

    this.targetStartDate = fromDate;
    this.targetEndDate = toDate ?? null;
    this.stopRequested = false;
    this.state = "RUNNING";
    this.cursorDate = fromDate;
    this.error = null;

    const end = toDate ?? kstDateOf(this.deps.clock.now());
    const total = Math.max(0, Math.round((Date.parse(end) - Date.parse(fromDate)) / 86400000) + 1);
    const now = this.deps.clock.now();
    this.job = { id: `symbol-master:${newId("sync")}`, kind: "symbol-master", title: "종목 마스터 수집", status: "RUNNING", phase: fromDate, description: `${fromDate} ~ ${end}`, progress: null, error: null, createdAtMs: now, updatedAtMs: now, finishedAtMs: null, cancellable: true, link: "/datasets/master" };
    this.updateJob("RUNNING", 0, total, fromDate);
    void this.runLoop(fromDate, end);
  }

  /** 진행 중 루프를 다음 날짜 경계에서 멈춘다 — 그 자리(cursorDate)에서 재개할 수 있다 */
  stop(): void {
    if (this.job) this.cancelJob(this.job.id);
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
      let completed = 0;
      const total = Math.max(0, Math.round((Date.parse(upperBound) - Date.parse(fromDate)) / 86400000) + 1);

      while (cursor <= upperBound) {
        if (this.stopRequested) {
          this.cursorDate = cursor;
          this.state = "IDLE";
          this.error = "사용자가 수집을 취소했습니다.";
          this.updateJob("CANCELLED", completed, total, cursor, this.error);
          return;
        }

        // 가장 많이 쓴 엔드포인트를 기준으로 본다 — 한도가 엔드포인트마다 따로 걸리므로
        // 그중 하나라도 예산을 넘기면 멈춰야 한다.
        if (
          this.deps.source.todayMaxEndpointCallCount() +
            CALLS_PER_ENDPOINT_PER_DATE >
          this.dailyCallBudget
        ) {
          this.cursorDate = cursor;
          this.state = "BUDGET_EXHAUSTED";
          this.updateJob("INTERRUPTED", completed, total, cursor, "일일 호출 예산을 소진했습니다.");
          return;
        }

        this.cursorDate = cursor;
        await this.deps.service.ingestDate(cursor);
        completed++;
        this.updateJob(this.stopRequested ? "CANCELLING" : "RUNNING", completed, total, cursor);
        cursor = addCalendarDays(cursor, 1);
      }

      this.cursorDate = null;
      this.state = "IDLE";
      this.error = this.stopRequested ? "사용자가 수집을 취소했습니다." : null;
      this.updateJob(this.stopRequested ? "CANCELLED" : "COMPLETED", completed, total, null, this.error);
    } catch (error) {
      const p = this.job!.progress!;
      if (this.stopRequested) {
        this.state = "IDLE";
        this.error = "사용자가 수집을 취소했습니다.";
        this.updateJob("CANCELLED", p.current!, p.total!, this.cursorDate, this.error);
        return;
      }
      if (error instanceof KrxQuotaError) {
        // cursorDate 는 실패한 바로 그 날짜에 남겨 둔다 — 재개 지점 표시용이다.
        this.state = "BUDGET_EXHAUSTED";
        this.updateJob("INTERRUPTED", p.current!, p.total!, this.cursorDate, "일일 호출 예산을 소진했습니다.");
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
      this.state = "FAILED";
      this.updateJob("FAILED", p.current!, p.total!, this.cursorDate, this.error);
      this.deps.logger.error(
        {
          module: "market-data",
          event: "symbol-master.backfill-failed",
          cursorDate: this.cursorDate,
          error: this.error,
        },
        "종목 마스터 백필이 날짜 처리 중 실패했다",
      );
    }
  }
}
