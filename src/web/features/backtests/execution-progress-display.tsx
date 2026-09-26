import type { ExecutionActivity, ExecutionProgress } from "../../../shared/execution-progress.js";

const ACTIVITY_LABELS: Record<ExecutionActivity, string> = {
  LOCAL_REPLAY: "저장 원문 재처리",
  SOURCE_FETCH: "공급자 원문 수집",
  FILING_DISCOVERY: "최신 공시 확인",
  BLOCKED: "데이터 갱신 승인 필요",
  WAITING_FOR_EXECUTOR: "실행 자원 대기",
  ESTIMATING_JOB_MEMORY: "작업 메모리 산정",
  WAITING_FOR_MEMORY: "메모리 여유 대기",
  WAITING_FOR_SLOT: "계산 슬롯 대기",
  WAITING_FOR_CAPACITY: "작업 용량 대기",
  ASSIGNING_EXECUTOR: "실행 작업 배정",
  STARTING_WORKER: "계산 프로세스 시작",
  CHECKING_INPUT: "계산 입력 확인",
  COLLECTING_MARKET: "KRX 시장 데이터 수집·확인",
  COLLECTING_SELECTION: "선정 지표 수집",
  REGISTERING_SYMBOLS: "종목 등록",
  COLLECTING_FINANCIALS: "DART 재무 데이터 수집",
  COLLECTING_ACTIONS: "DART 자본변동 수집",
  WAITING_RETRY: "수집 재개 대기",
  PUBLISHING_COPY: "계산 스냅샷 복사",
  PUBLISHING_VERIFY: "계산 스냅샷 무결성 확인",
  PUBLISHING_HASH: "계산 스냅샷 해시 계산",
  PUBLISHING_COMMIT: "계산 스냅샷 게시",
  DOWNLOADING_DATASET: "계산 데이터 다운로드",
  VERIFYING_DATASET: "계산 데이터 검증",
  RESOLVING_UNIVERSE: "유니버스 선정 계산",
  VALIDATING_INPUT: "최종 입력 검증",
  SAVING_PREVIEW: "미리보기 결과 반영",
  LOADING_BACKTEST_INPUT: "백테스트 입력 적재",
  CALCULATING_BACKTEST: "백테스트 계산",
  WRITING_RESULT: "결과 파일 작성",
  UPLOADING_RESULT: "결과 전송",
  VALIDATING_RESULT: "결과 검증",
  IMPORTING_RESULT: "결과 DB 반영",
};

export function executionActivityLabel(activity: ExecutionActivity): string {
  return ACTIVITY_LABELS[activity] ?? activity;
}

export function executionProgressUnitLabel(
  unit: ExecutionProgress["unit"],
): string | null {
  switch (unit) {
    case "DATES": return "일";
    case "SYMBOLS": return "종목";
    case "BYTES": return "bytes";
    case "BARS": return "봉";
    default: return null;
  }
}

export function executionProgressPercent(
  progress: ExecutionProgress | null | undefined,
): number | null {
  if (
    !progress || progress.completed === null || progress.total === null ||
    progress.total <= 0
  ) return null;
  return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
}

export function executionProgressCount(
  progress: ExecutionProgress,
): string | null {
  const unit = executionProgressUnitLabel(progress.unit);
  if (unit === null || progress.completed === null || progress.total === null) {
    return null;
  }
  return `${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} ${unit}`;
}

export function ExecutionProgressSummary({
  progress,
  compact = false,
}: {
  progress: ExecutionProgress;
  compact?: boolean;
}) {
  const count = executionProgressCount(progress);
  const distinctCurrentItem =
    progress.currentItem && progress.currentItem !== progress.detail
      ? progress.currentItem
      : null;
  return (
    <div className={`space-y-1 text-muted-foreground ${compact ? "text-[11px]" : "text-xs"}`}>
      <p>
        {executionActivityLabel(progress.activity)}
        {count ? ` · ${count}` : ""}
      </p>
      <p>
        수행: {progress.actorName}
        {distinctCurrentItem ? ` · 현재 ${distinctCurrentItem}` : ""}
      </p>
      {progress.detail ? <p>{progress.detail}</p> : null}
    </div>
  );
}

export function isExecutorResourceWait(activity: ExecutionActivity): boolean {
  return activity === "WAITING_FOR_EXECUTOR" ||
    activity === "ESTIMATING_JOB_MEMORY" ||
    activity === "WAITING_FOR_MEMORY" ||
    activity === "WAITING_FOR_SLOT" ||
    activity === "WAITING_FOR_CAPACITY" ||
    activity === "ASSIGNING_EXECUTOR" ||
    activity === "STARTING_WORKER";
}
