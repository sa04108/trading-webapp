/**
 * 백테스트 실행의 유니버스 출처 pin (Task 12, REVIEW §9.2).
 *
 * 서버가 제출 검증 시점에 조립해 저장한다 — 클라이언트가 보내는 값이 아니다.
 *
 * `sourceKind: 'SYMBOL_MASTER'` (스펙 2026-08-05) 가 현재 유일하게 생성되는 값이다 —
 * 백테스트 유니버스가 데이터셋(`DATASET`)이나 손으로 고정한 스냅샷(`KRX_HISTORICAL`)이
 * 아니라 유니버스 규칙(시총 상위 N)을 리밸런스 날짜별로 종목 마스터에 적용해 만든
 * 멤버십 일정이기 때문이다. 두 옛 kind 는 리터럴에 남겨 둔다 — 결과 화면(web)이
 * `pin.sourceKind === 'KRX_HISTORICAL'` 로 분기하는 코드가 아직 있고(위저드 개편은
 * 별도 태스크), 마이그레이션이 기존 백테스트 데이터를 지우므로 실제로 이 값이 다시
 * 나올 일은 없지만 타입만 좁히면 그 분기가 컴파일 에러가 된다.
 */
export interface ProvenancePin {
  readonly sourceKind: 'KRX_HISTORICAL' | 'DATASET' | 'SYMBOL_MASTER';
  readonly universeSnapshotId: string | null;
  readonly requestedDate: string | null;
  readonly effectiveTradingDate: string | null;
  readonly usableFromDate: string | null;
  readonly filterPolicyVersion: string | null;
  readonly selectionMethod: string | null;
  readonly selectionHash: string | null;
  readonly krxApprovalExpiryDate: string | null;
  readonly approvalValidAtSubmit: boolean | null;
  /** 시점 불명 데이터셋 경고 등 — null 이면 없음 */
  readonly timepointWarning: string | null;
  /** KRX 스냅샷일 때만 채운다 */
  readonly symbols: ReadonlyArray<{
    readonly standardCode: string;
    readonly shortCode: string;
    readonly name: string;
    readonly market: string;
    readonly marketCapKrw: string | null;
    readonly rank: number | null;
  }> | null;
  /**
   * 멤버십 일정의 집계 해시 (`UniverseRuleResolver.resolve` 의 `scheduleHash`) —
   * `SYMBOL_MASTER` 경로 전용. 리밸런스 날짜별 종목 구성이 제출 시점과 같았는지
   * 재현성 검사에 쓴다.
   */
  readonly scheduleHash: string | null;
}

/**
 * 데이터셋 경로는 과거 시점 적합성을 보증할 방법이 없다 — 데이터셋은 "현재 등록된
 * 종목 집합" 이라 그 종목이 과거 그 시점의 실제 유니버스였는지 알 수 없다.
 */
export const DATASET_TIMEPOINT_WARNING =
  '이 데이터셋은 과거 시점 적합성을 확인할 수 없습니다 — 현재 등록 종목 기준일 수 있습니다.';
