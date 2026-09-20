import type { Logger } from "./logger.js";
import { ProviderRequestBlockedError } from "../../runtime/shared/provider-request-blocked-error.js";
export { ProviderRequestBlockedError } from "../../runtime/shared/provider-request-blocked-error.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface ProviderRequestKey {
  readonly provider: "DART" | "KRX";
  readonly namespace: string;
  readonly endpoint: string;
  readonly parameters: Readonly<Record<string, string>>;
}
export interface ProviderSourceState {
  readonly kind: "MISSING" | "PUBLICATION" | "CORRUPT" | "REPLACEMENT" | "REQUIREMENT";
  readonly evidence: string;
}
export interface ProviderRequestPermit {
  readonly fingerprint: string;
  readonly reason: string;
  beforeAttempt(): void;
  complete(): void;
}
export interface ProviderRequestPolicy {
  authorize(key: ProviderRequestKey, state: ProviderSourceState): ProviderRequestPermit;
}

/** 인증정보를 제외한 요청 정체성과 현재 근거를 함께 고정한다. */
export function providerPlanFingerprint(key: ProviderRequestKey, state: ProviderSourceState): string {
  return createHash("sha256").update(JSON.stringify({
    provider: key.provider, namespace: key.namespace, endpoint: key.endpoint,
    parameters: Object.fromEntries(Object.entries(key.parameters).sort(([a], [b]) => a.localeCompare(b))),
    state,
  })).digest("hex");
}

/** 승인은 단일 요청·근거에만 적용하며 각 물리 재시도에서도 취소와 상한을 확인한다. */
export class SqliteProviderRequestPolicy implements ProviderRequestPolicy {
  constructor(private readonly sqlite: Database.Database, private readonly now: () => number = Date.now, private readonly logger?: Logger, private readonly onSourceAttempt?: (key: ProviderRequestKey) => void) {}

  authorize(key: ProviderRequestKey, state: ProviderSourceState): ProviderRequestPermit {
    key = { provider: key.provider, namespace: key.namespace, endpoint: key.endpoint,
      parameters: Object.fromEntries(Object.entries(key.parameters).sort(([a], [b]) => a.localeCompare(b))) };
    if (state.kind === "MISSING") {
      const previous = this.sqlite.prepare("SELECT fingerprint FROM provider_request_plans WHERE request_json = ? AND status = 'COMPLETED' ORDER BY rowid DESC LIMIT 1")
        .get(JSON.stringify(key)) as {fingerprint:string} | undefined;
      if (previous) return this.authorize(key, {kind:"CORRUPT", evidence:`수집 완료 기록 ${previous.fingerprint}의 원문 유실: ${state.evidence}`});
    }
    const fingerprint = providerPlanFingerprint(key, state);
    const reason = state.kind === "PUBLICATION" ? "PUBLICATION_CONFIRMED" : state.kind === "MISSING" ? "FIRST_ACQUISITION"
      : state.kind === "CORRUPT" ? "SOURCE_RECOVERY"
        : state.kind === "REPLACEMENT" ? "SOURCE_CHANGE_CONFIRMED" : "BLOCKED_SOURCE_REQUIREMENT";
    this.sqlite.prepare(`INSERT OR IGNORE INTO provider_request_plans
      (fingerprint, request_json, reason, evidence, status, attempts, max_attempts, created_at_ms)
      VALUES (?, ?, ?, ?, ?, 0, 5, ?)`).run(fingerprint, JSON.stringify(key), reason, state.evidence,
        state.kind === "MISSING" || state.kind === "PUBLICATION" ? "APPROVED" : "BLOCKED", this.now());
    const check = () => {
      const row = this.sqlite.prepare("SELECT status, attempts, max_attempts FROM provider_request_plans WHERE fingerprint = ?")
        .get(fingerprint) as {status: string; attempts: number; max_attempts: number};
      if (row.status !== "APPROVED" || row.attempts >= row.max_attempts)
        throw new ProviderRequestBlockedError(reason, fingerprint, state.evidence);
    };
    check();
    return {
      fingerprint, reason,
      beforeAttempt: () => this.sqlite.transaction(() => {
        check();
        this.sqlite.prepare("UPDATE provider_request_plans SET attempts = attempts + 1 WHERE fingerprint = ?").run(fingerprint);
        this.onSourceAttempt?.(key);
        const attempt = this.sqlite.prepare("SELECT attempts FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint) as {attempts:number};
        this.logger?.info({ event: "provider.http", activity: "SOURCE_FETCH", provider: key.provider,
          endpoint: key.endpoint, requestKey: key.parameters, reason, fingerprint, attempt: attempt.attempts }, "승인 범위 내 원문 HTTP 요청");
      }).immediate(),
      complete: () => { this.logger?.info({event:"provider.http.completed", fingerprint, reason}, "원문 저장 완료"); this.sqlite.prepare("UPDATE provider_request_plans SET status = 'COMPLETED' WHERE fingerprint = ? AND status = 'APPROVED'").run(fingerprint); },
    };
  }

  list() {
    return this.sqlite.prepare("SELECT * FROM provider_request_plans ORDER BY created_at_ms DESC LIMIT 200").all();
  }

  decide(fingerprint: string, approved: boolean): boolean {
    // 명시적 재승인만 다음 다섯 번을 허용한다. 기존 attempt 이력은 초기화하지 않는다.
    return this.sqlite.prepare(`UPDATE provider_request_plans SET status = ?, decided_at_ms = ?,
      max_attempts = CASE WHEN ? = 1 AND attempts >= max_attempts THEN max_attempts + 5 ELSE max_attempts END
      WHERE fingerprint = ? AND status IN ('BLOCKED', 'APPROVED', 'CANCELLED')`)
      .run(approved ? "APPROVED" : "CANCELLED", this.now(), approved ? 1 : 0, fingerprint).changes === 1;
  }
}
