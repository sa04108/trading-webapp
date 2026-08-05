/**
 * 백테스트 실행의 유니버스 출처 pin (Task 12, REVIEW §9.2).
 *
 * 서버가 제출 검증 시점에 조립해 저장한다 — 클라이언트가 보내는 값이 아니다.
 *
 * `sourceKind` 는 `'SYMBOL_MASTER'` 뿐이다(스펙 2026-08-05) — 백테스트 유니버스가
 * 유니버스 규칙(시총 상위 N)을 리밸런스 날짜별로 종목 마스터에 적용해 만든 멤버십
 * 일정이기 때문이다. 데이터셋(`DATASET`)·손으로 고정한 KRX 스냅샷(`KRX_HISTORICAL`)
 * 경로는 데이터셋·스냅샷 개념 전체와 함께 제거됐다(T6) — 마이그레이션이 기존
 * 백테스트 데이터를 지우므로 옛 kind 가 다시 나올 일은 없다.
 *
 * 옛 KRX 스냅샷·데이터셋 경로 전용 필드(`universeSnapshotId`·`requestedDate`·
 * `effectiveTradingDate`·`usableFromDate`·`selectionHash`·`krxApprovalExpiryDate`·
 * `approvalValidAtSubmit`·`timepointWarning`·`symbols`)는 `SYMBOL_MASTER` 경로에서
 * 항상 null 이던 죽은 필드라 T6 최종 리뷰에서 함께 제거했다 — 값을 채우던 경로 자체가
 * 없어졌으므로 부활할 일이 없다.
 */
export interface ProvenancePin {
  readonly sourceKind: 'SYMBOL_MASTER';
  readonly filterPolicyVersion: string | null;
  readonly selectionMethod: string | null;
  /**
   * 멤버십 일정의 집계 해시 (`UniverseRuleResolver.resolve` 의 `scheduleHash`).
   * 리밸런스 날짜별 종목 구성이 제출 시점과 같았는지 재현성 검사에 쓴다.
   */
  readonly scheduleHash: string | null;
}
