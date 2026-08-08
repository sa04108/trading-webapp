// 확장자 .js 와 별칭(@/) 회피는 prefill.ts 와 같은 이유다.
// tests/unit/corporate-action-gate.test.ts 가 이 모듈을 가져와 tsconfig.server.json 의
// NodeNext 프로그램에 편입된다.
// 그 프로그램은 DOM lib 가 없어 EventSource 같은 브라우저 전용 타입을 읽지 못한다.
// 그래서 이 모듈은 DOM 을 쓰지 않는다. 렌더링·SSE 는 corporate-action-gate.tsx 가 맡는다.
import { ApiError } from '../../lib/api-client.js';
import { formatDuration } from '../../lib/format.js';
import { formatSymbolLabel } from './symbol-summary.js';

/** `POST /backtests` 400 응답이 실어 보내는 자본변동 게이트 정보 (Task 6·8) */
export interface CorporateActionGateDto {
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
}

/**
 * 제출 실패의 `ApiError.details` 에서 자본변동 게이트 정보를 꺼낸다.
 *
 * 화면이 종목·연도를 다시 계산하지 않는다 — 서버(`checkCorporateActionCoverage`)가
 * 이미 계산한 값을 그대로 받아 쓴다. 이 함수는 그 값을 안전하게 꺼내는 타입 가드일
 * 뿐이다.
 */
export function extractCorporateActionGate(error: unknown): CorporateActionGateDto | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const gate = (details as { corporateActionGate?: unknown }).corporateActionGate;
  if (typeof gate !== 'object' || gate === null) return null;
  const { symbols, fromYear, toYear } = gate as Record<string, unknown>;
  if (!Array.isArray(symbols) || typeof fromYear !== 'number' || typeof toYear !== 'number') {
    return null;
  }
  return {
    symbols: symbols.filter((code): code is string => typeof code === 'string'),
    fromYear,
    toYear,
  };
}

/** `POST /facts/corporate-action-sync-plan` 응답 (Task 8) */
export interface CorporateActionSyncEstimateDto {
  readonly calls: number;
  readonly estimatedMs: number;
  readonly overDailyLimit: boolean;
}

export type CorporateActionSyncJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** `corporate-action-routes.ts` 의 `serializeJob` 과 같은 모양 */
export interface CorporateActionSyncJobDto {
  readonly id: string;
  readonly status: CorporateActionSyncJobStatus;
  readonly symbols: readonly string[];
  readonly fromYear: number;
  readonly toYear: number;
  readonly doneSymbols: number;
  readonly totalSymbols: number;
  readonly savedFacts: number | null;
  readonly gapCount: number | null;
  readonly error: string | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

const TERMINAL_STATUSES: readonly CorporateActionSyncJobStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

export function isSyncJobTerminal(status: CorporateActionSyncJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canCancelSyncJob(status: CorporateActionSyncJobStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

/** 0~100 정수. 분모가 0 이면(아직 계획을 못 받은 순간) 0 으로 둔다 */
export function syncProgressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/** "2025년" 또는 "2025–2026년" — from·to 가 같으면 한 해만 적는다 */
export function formatYearRange(fromYear: number, toYear: number): string {
  return fromYear === toYear ? `${fromYear}년` : `${fromYear}–${toYear}년`;
}

/** "자본변동 이력이 없는 종목 23개가 있습니다." */
export function formatGateHeadline(symbolCount: number): string {
  return `자본변동 이력이 없는 종목 ${symbolCount}개가 있습니다.`;
}

/** "수집 대상: 23종목 × 2025–2026년" */
export function formatCollectionTarget(
  symbolCount: number,
  fromYear: number,
  toYear: number,
): string {
  return `수집 대상: ${symbolCount}종목 × ${formatYearRange(fromYear, toYear)}`;
}

/** "예상 호출: 약 690회 · 예상 시간 약 4분" — 숫자는 실행과 같은 함수(서버)가 준다 */
export function formatCollectionEstimate(estimate: CorporateActionSyncEstimateDto): string {
  return (
    `예상 호출: 약 ${estimate.calls.toLocaleString('ko-KR')}회 · ` +
    `예상 시간 약 ${formatDuration(estimate.estimatedMs)}`
  );
}

/** 쉼표로 이어 붙인 "이름(코드)" 목록 — 뭉뚱그리지 않고 하나씩 밝힌다 */
export function formatSymbolNames(
  symbols: readonly string[],
  nameOf: (code: string) => string | null,
): string {
  return symbols.map((code) => formatSymbolLabel(code, nameOf(code))).join(', ');
}

/**
 * 수집이 끝난 뒤에도 남아 있는 실패 종목 안내. "일부 실패" 로 뭉뚱그리지 않고
 * 이름으로 밝힌다(브리프 3번).
 */
export function formatRemainingGateMessage(
  symbols: readonly string[],
  nameOf: (code: string) => string | null,
): string {
  return (
    `다음 종목은 자본변동 이력을 여전히 수집하지 못했습니다: ${formatSymbolNames(symbols, nameOf)}. ` +
    'DART 가 응답하지 못하는 종목일 수 있습니다.'
  );
}
