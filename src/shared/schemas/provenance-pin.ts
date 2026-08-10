import type { UniverseCriterion, UniverseRule } from './universe-rule.js';

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

/**
 * 서버 `universe-rule-resolver.ts` 의 `UniverseStageDiagnostic` 과 필드가 같은
 * shared 버전이다. shared → server import 는 경계 위반(§7, dependency-cruiser)이라
 * pin 이 단계 진단을 그대로 실어 나르려면 이 모양을 shared 에도 정의해야 한다. 서버
 * 값은 구조적으로 호환되므로 별도 변환 없이 그대로 대입한다.
 */
export interface UniverseStageDiagnosticSnapshot {
  readonly criterion: UniverseCriterion;
  readonly inputCount: number;
  readonly eligibleCount: number;
  readonly selectedCount: number;
  readonly excludedMissingCount: number;
}

/** 서버 `RebalanceDiagnostic` 과 필드가 같은 shared 버전 — 위 주석과 같은 이유다. */
export interface RebalanceDiagnosticSnapshot {
  readonly rebalanceDate: string;
  readonly effectiveDate: string;
  readonly stages: readonly UniverseStageDiagnosticSnapshot[];
}

/**
 * 순서형 유니버스 파이프라인(Task 1~10, 스펙 2026-08-09) 실행이 쓰는 pin.
 *
 * 단일 `selectionMethod` 문자열로는 "어느 단계가 몇 종목을 걸러냈는지" 를 재현할 수
 * 없어, 단계별 진단(`diagnostics`)과 규칙 원문(`universeRule`)을 그대로 함께 싣는다.
 * `preparedAtMs` 는 이 pin 을 조립한 시각이다 — 준비(preparation)가 완료된 뒤에도
 * 종목 마스터·선정 지표가 갱신될 수 있어, "언제 이 스케줄로 확정했는지" 를 실행
 * 시각과 별도로 남긴다.
 */
export interface OrderedUniversePipelineProvenancePin {
  readonly sourceKind: 'SYMBOL_MASTER';
  readonly filterPolicyVersion: string | null;
  readonly selectionMethod: 'ORDERED_UNIVERSE_PIPELINE';
  readonly universeRule: UniverseRule;
  /**
   * 멤버십 일정의 집계 해시. 리밸런스 날짜별 종목 구성이 제출 시점과 같았는지
   * 재현성 검사에 쓴다.
   */
  readonly scheduleHash: string;
  readonly diagnostics: readonly RebalanceDiagnosticSnapshot[];
  readonly preparedAtMs: number;
}

/**
 * 순서형 파이프라인 이전(Task 1~10 이전) 완료 run 이 저장해 둔 모양이다.
 *
 * 기존 완료 백테스트 결과는 다시 쓰지 않는다(2026-08-10 결정, docs/DECISIONS.md
 * D-049) — 그래서 이 모양은 새 run 이 다시 쓰는 대상이 아니라, 옛 run 을 읽을 때만
 * 이 분기로 남는다. `selectionMethod` 는 옛 경로가 실제로 저장했던 값들
 * (`TOP_MARKET_CAP_N`·`MANUAL_FROM_KRX_SNAPSHOT` 등)을 가리지 않고 그대로 담는다.
 */
export interface LegacyTopMarketCapProvenancePin {
  readonly sourceKind: 'SYMBOL_MASTER';
  readonly filterPolicyVersion: string | null;
  readonly selectionMethod: string | null;
  readonly scheduleHash: string | null;
}

export type ProvenancePin =
  | OrderedUniversePipelineProvenancePin
  | LegacyTopMarketCapProvenancePin;
