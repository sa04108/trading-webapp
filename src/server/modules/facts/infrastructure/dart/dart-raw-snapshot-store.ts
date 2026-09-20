import { ProviderRequestBlockedError } from "../../../../shared/provider-request-policy.js";
import type { DartReportCode } from "./dart-report-parser.js";

export type DartRawSnapshotEndpoint =
  "FINANCIAL_STATEMENT" | "SHARE_STATUS" | "ISSUANCE_STATUS";

export interface DartRawSnapshotKey {
  readonly symbol: string;
  readonly endpoint: DartRawSnapshotEndpoint;
  readonly businessYear: number;
  readonly reportCode: DartReportCode;
  readonly fsDiv: "CFS" | "OFS" | "NONE";
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
  /** 요청한 복합 키만 읽어 부재 개수를 센다. 손상·validator 실패는 별도 오류로 차단한다. */
  countMissing(
    keys: readonly DartRawSnapshotKey[],
    isValidPayload: (payload: unknown) => boolean,
  ): number;
  put(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void;
  /** 게시 대기 응답도 이전 활성 원문을 덮어쓰지 않고 보존한다. */
  observe?(key: DartRawSnapshotKey, payload: unknown, fetchedAtMs: number): void;
}

export function dartRawSnapshotKeyId(key: DartRawSnapshotKey): string {
  return [
    key.symbol,
    key.endpoint,
    key.businessYear,
    key.reportCode,
    key.fsDiv,
  ].join(":");
}

/** 손상과 파서 비호환은 부재와 구별하며 승인 없는 재수집으로 복구하지 않는다. */
export class DartRawSnapshotError extends ProviderRequestBlockedError {
  constructor(reason: "HASH_MISMATCH" | "INVALID_JSON" | "PARSER_INCOMPATIBLE" | "IDENTITY_MISMATCH", key: string, evidence = "저장 DART 원문 검증 실패") {
    super(reason, key, evidence);
  }
}
