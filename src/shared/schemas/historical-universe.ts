import type { UniverseSortKey } from './universe-sort.js';

/**
 * KRX 과거 시점 고정 유니버스 — 웹과 서버가 공유하는 DTO.
 *
 * zod 를 쓰지 않는다 — 상수·타입 정의만으로 충분하고, 여기에 zod 를 두면 이 파일을
 * import 하는 화면 코드까지 zod 를 웹 번들에 끌고 들어온다 (symbol-code.ts 와 같은 이유).
 * 서버 라우트는 이 타입을 참고해 자기 zod 스키마를 만든다.
 *
 * `marketCapKrw` 는 문자열이다 — 시가총액은 원 단위 정수라 JS number 로 옮기면
 * Number.MAX_SAFE_INTEGER(약 900조 원) 를 넘는 값에서 정밀도를 잃는다. 서버는
 * BigInt 를 이 경계에서 문자열로 바꾸고, 화면은 표시할 때만 다시 파싱한다.
 */
export interface HistoricalCandidateDto {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: 'KOSPI' | 'KOSDAQ';
  readonly marketCapKrw: string | null;
  /** 활성 정렬 기준의 값 — MKTCAP 이면 marketCapKrw 와 같고, 영업이익이면 원 단위 문자열. 값이 없으면 null */
  readonly sortValue: string | null;
  readonly rank: number | null;
}

export interface HistoricalUniversePreviewDto {
  readonly previewId: string;
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly usableFromRule: string;
  readonly candidates: readonly HistoricalCandidateDto[];
  readonly rawCounts: Readonly<Record<string, number>>;
  readonly eligibleCount: number;
  readonly unknownMarketCapCount: number;
  readonly sortBy: UniverseSortKey;
  /** 활성 정렬 기준 값이 없어 rank 를 받지 못한 후보 수 */
  readonly unknownSortValueCount: number;
  readonly excludedByType: Readonly<Record<string, number>>;
  /** 데이터 출처 표시 — 화면이 그대로 보여준다. */
  readonly attribution: '한국거래소 통계정보';
}

export interface HistoricalUniverseStatusDto {
  readonly available: boolean;
  readonly reason: string | null;
  readonly approvalExpiry: string | null;
  readonly todayCallCount: number;
}

export interface UniverseSnapshotSummaryDto {
  readonly id: string;
  readonly sourceKind: 'KRX_HISTORICAL';
  readonly requestedDate: string;
  readonly effectiveTradingDate: string;
  readonly usableFromDate: string;
  readonly sortKey: UniverseSortKey;
  readonly selectionMethod: 'TOP_MARKET_CAP_N' | 'MANUAL_FROM_KRX_SNAPSHOT';
  readonly selectionN: number | null;
  readonly selectedCount: number;
  readonly unknownMarketCapCount: number;
  readonly createdAtMs: number;
}

export interface UniverseSnapshotSymbolDto {
  readonly standardCode: string;
  readonly shortCode: string;
  readonly name: string;
  readonly market: 'KOSPI' | 'KOSDAQ';
  readonly marketCapKrw: string | null;
  readonly rank: number | null;
}

export interface UniverseSnapshotDetailDto extends UniverseSnapshotSummaryDto {
  readonly symbols: readonly UniverseSnapshotSymbolDto[];
  readonly krxApprovalExpiryDate: string | null;
}
