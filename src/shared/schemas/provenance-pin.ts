/**
 * 백테스트 실행의 유니버스 출처 pin (Task 12, REVIEW §9.2).
 *
 * 서버가 제출 검증 시점에 조립해 저장한다 — 클라이언트가 보내는 값이 아니다.
 * `datasetId` 경로와 `universeSnapshotId` 경로 둘 다 이 모양으로 남긴다: 유니버스가
 * 과거 어느 시점의 무엇으로 고정됐는지(KRX_HISTORICAL) 또는 그 시점을 보증할 수
 * 없다는 사실(DATASET) 자체가 재현성·감사의 일부이기 때문이다.
 */
export interface ProvenancePin {
  readonly sourceKind: 'KRX_HISTORICAL' | 'DATASET';
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
}

/**
 * 데이터셋 경로는 과거 시점 적합성을 보증할 방법이 없다 — 데이터셋은 "현재 등록된
 * 종목 집합" 이라 그 종목이 과거 그 시점의 실제 유니버스였는지 알 수 없다.
 */
export const DATASET_TIMEPOINT_WARNING =
  '이 데이터셋은 과거 시점 적합성을 확인할 수 없습니다 — 현재 등록 종목 기준일 수 있습니다.';
