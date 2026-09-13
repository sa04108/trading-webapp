import type { DartReportCode } from './dart-report-parser.js';

export type DartRawSnapshotEndpoint =
  | 'FINANCIAL_STATEMENT'
  | 'SHARE_STATUS'
  | 'ISSUANCE_STATUS';

export interface DartRawSnapshotKey {
  readonly symbol: string;
  readonly endpoint: DartRawSnapshotEndpoint;
  readonly businessYear: number;
  readonly reportCode: DartReportCode;
  readonly fsDiv: 'CFS' | 'OFS' | 'NONE';
}

export interface DartRawSnapshot {
  readonly payload: unknown;
  readonly fetchedAtMs: number;
}

/** DART API 어댑터와 영속 구현 사이의 원문 snapshot 포트. */
export interface DartRawSnapshotStore {
  get(key: DartRawSnapshotKey): DartRawSnapshot | null;
  /** 원문을 역직렬화하지 않고 요청 종목별 가장 이른 수집 시각만 집계한다. */
  getOldestFetchedAtMs(symbols: readonly string[]): ReadonlyMap<string, number>;
  /** 요청한 복합 키만 배치로 읽어 누락·손상·validator 실패 개수를 센다. */
  countMissing(
    keys: readonly DartRawSnapshotKey[],
    isValidPayload: (payload: unknown) => boolean,
  ): number;
  put(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void;
}

export function dartRawSnapshotKeyId(key: DartRawSnapshotKey): string {
  return [
    key.symbol,
    key.endpoint,
    key.businessYear,
    key.reportCode,
    key.fsDiv,
  ].join(':');
}
