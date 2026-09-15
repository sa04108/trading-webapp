import type { FactSyncMode, FactSyncPlan } from "../domain/sync-plan.js";
import type { FactIngestionGap } from "./ports.js";

export interface FactSyncRequest {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly consolidated: boolean;
  /**
   * FULL = 이력을 무시하고 지정 구간 전체 (CLI). INCREMENTAL = 미수집 연도 +
   * watermark 이후 새 정기공시가 접수된 연도 (웹·준비 잡, detectRedisclosedYears
   * 참고). 웹이 매번 전 구간을 다시 받으면 45분짜리 버튼이 된다.
   */
  readonly mode: FactSyncMode;
}

/** 종목 하나가 끝날 때마다 호출된다 — 45분짜리 실행이 조용하지 않게 한다 */
export interface FactSyncProgress {
  readonly symbol: string;
  /** 1부터 시작하는 진행 번호 */
  readonly index: number;
  readonly total: number;
  /** 이 종목에서 저장된 팩트 수 */
  readonly savedFacts: number;
  /** 이 종목에서 남은 누락 수 */
  readonly gapCount: number;
}

export interface FactSyncHooks {
  onSymbolDone?(progress: FactSyncProgress): void;
  /**
   * 종목 경계에서 확인하는 취소 신호. 봉 수집이 페이지 경계에서 확인하는 것과 같은
   * 입자다 — 저장이 종목 단위이므로 여기서 멈추면 저장분과 이력이 정합하게 남는다.
   */
  shouldStop?(): boolean;
  /**
   * 실제 DART HTTP attempt 직전에 1건을 예약한다. 목록 페이지와 재시도도 각각 호출된다.
   */
  beforeDartRequest?(): "CONTINUE" | "PAUSE_DAILY_QUOTA";
}

export interface FactSyncReport {
  readonly savedFacts: number;
  /** 예시 보관 상한과 무관한 전체 결손 건수. */
  readonly gapCount: number;
  /** 최대 100건의 진단 예시. 실행 차단 판정에는 저장된 연도별 coverage를 사용한다. */
  readonly gaps: readonly FactIngestionGap[];
  /** 중단된 종목코드. 완주하면 null */
  readonly stoppedAtSymbol: string | null;
  /**
   * 중단 원인. 호출부가 잡 상태를 FAILED/CANCELLED 로 갈라야 하므로
   * stoppedAtSymbol 만으로는 부족하다.
   */
  readonly stopReason: "ERROR" | "CANCELLED" | "DAILY_QUOTA" | null;
  /** 중단 사유 + 이어받는 방법을 담은 한국어 안내. 완주하면 null */
  readonly failureMessage: string | null;
}

/** 서버 수집 구현과 스냅샷 worker가 공유하는 수집 계약이다. */
export interface FactSyncPort {
  planFinancialSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): FactSyncPlan;
  planCorporateActionSync(
    symbols: readonly string[],
    fromYear: number,
    toYear: number,
  ): FactSyncPlan;
  sync(
    request: FactSyncRequest,
    hooks?: FactSyncHooks,
  ): Promise<FactSyncReport>;
  syncCorporateActions(
    request: FactSyncRequest,
    hooks?: FactSyncHooks,
  ): Promise<FactSyncReport>;
}
