import { ProviderRequestBlockedError } from "../../../../shared/provider-request-policy.js";

export interface KrxRawSnapshotKey {
  readonly namespace: string;
  readonly endpoint: string;
  readonly basDd: string;
}

export interface KrxRawSnapshot {
  readonly payload: unknown;
  readonly fetchedAtMs: number;
}

export interface KrxRawSnapshotStore {
  get(key: KrxRawSnapshotKey): KrxRawSnapshot | null;
  put(key: KrxRawSnapshotKey, payload: unknown, fetchedAtMs: number): void;
}

export class KrxRawSnapshotCorruptError extends ProviderRequestBlockedError {
  constructor(readonly key: KrxRawSnapshotKey, evidence = "KRX 저장 원문의 해시 또는 JSON 검증 실패") {
    super("SOURCE_RECOVERY", JSON.stringify(key), evidence);
    this.name = "KrxRawSnapshotCorruptError";
  }
}
