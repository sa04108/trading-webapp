import type { ExecutionProgress } from "../../../../shared/execution-progress.js";
import type { JobProgress } from "../../../../shared/schemas/jobs.js";

const phases: Record<string, string> = {
  QUEUED: "실행 순서 대기", STARTING: "실행 준비", RUNNING: "실행 중", PREPARING: "데이터 준비",
  CANCELLING: "취소 처리 중", COMPLETED: "완료", FAILED: "실패", CANCELLED: "취소됨", INTERRUPTED: "중단됨",
  WAITING_DATA: "데이터 수집 대기", WAITING_DAILY_QUOTA: "API 일일 한도 복구 대기",
  FILING_DISCOVERY: "공시 목록 확인", MARKET_DATA: "시장 데이터 확인", RESOLVING_STAGES: "유니버스 선정",
  VALIDATING_RESULT: "결과 검증", SYNCING_FACTS: "재무 데이터 확인", FINALIZING: "준비 결과 저장",
  LOCAL_REPLAY: "저장 데이터 반영", SOURCE_FETCH: "증권사·거래소 데이터 수집", BLOCKED: "입력 데이터 확인 필요",
  WAITING_FOR_EXECUTOR: "실행기 배정 대기", ESTIMATING_JOB_MEMORY: "필요 메모리 확인", WAITING_FOR_MEMORY: "메모리 확보 대기",
  WAITING_FOR_SLOT: "계산 슬롯 대기", WAITING_FOR_CAPACITY: "실행 용량 확보 대기", ASSIGNING_EXECUTOR: "실행기 배정",
  STARTING_WORKER: "계산 프로세스 시작", CHECKING_INPUT: "입력 데이터 확인", COLLECTING_MARKET: "시장 데이터 수집",
  COLLECTING_SELECTION: "유니버스 선정 데이터 수집", REGISTERING_SYMBOLS: "종목 등록", COLLECTING_FINANCIALS: "재무 데이터 수집",
  COLLECTING_ACTIONS: "자본 변동 수집", WAITING_RETRY: "재시도 대기", PUBLISHING_COPY: "계산 데이터 복사",
  PUBLISHING_VERIFY: "계산 데이터 검증", PUBLISHING_HASH: "계산 데이터 해시 확인", PUBLISHING_COMMIT: "계산 데이터 게시",
  DOWNLOADING_DATASET: "계산 데이터 다운로드", VERIFYING_DATASET: "계산 데이터 확인", RESOLVING_UNIVERSE: "유니버스 선정",
  VALIDATING_INPUT: "입력 검증", SAVING_PREVIEW: "미리보기 저장", LOADING_BACKTEST_INPUT: "백테스트 데이터 불러오기",
  CALCULATING_BACKTEST: "전략 계산", WRITING_RESULT: "결과 파일 작성", UPLOADING_RESULT: "결과 전송", IMPORTING_RESULT: "결과 저장",
  PREPARING_TRAIN: "학습 구간 준비", TRAINING: "후보 전략 계산", PREPARING_TEST: "평가 구간 준비",
  PREPARING_OOS: "평가 구간 준비", TRAIN: "후보 전략 계산", OOS: "평가 구간 계산",
  TESTING: "평가 구간 계산", BASELINE: "고정 전략 비교",
};

export function jobPhase(value: string | null): string | null {
  return value ? phases[value] ?? value : null;
}

/** 실제 분모가 있는 처리량만 진행률로 표시한다. */
export function jobProgress(current: number | null, total: number | null, label: string | null): JobProgress | null {
  const completed = current !== null && Number.isFinite(current) ? Math.max(0, current) : null;
  const denominator = total !== null && Number.isFinite(total) && total > 0 ? total : null;
  if (completed === null && denominator === null && !label) return null;
  return { current: completed, total: denominator, percent: completed !== null && denominator !== null ? Math.min(100, 100 * completed / denominator) : null, label };
}

export function executionJobProgress(progress: ExecutionProgress): JobProgress | null {
  const units = { DATES: "날짜", SYMBOLS: "종목", BARS: "봉", BYTES: "바이트" };
  return jobProgress(progress.completed, progress.total, [progress.currentItem, progress.unit ? units[progress.unit] : null].filter(Boolean).join(" · ") || null);
}
