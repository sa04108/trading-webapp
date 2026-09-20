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
  deferRetry(): never;
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

const ATTEMPTS_PER_BATCH = 5;
export const PROVIDER_RETRY_DELAY_MS = 15 * 60_000;

interface RequestPlanRow {
  status: string;
  attempts: number;
  max_attempts: number;
  retry_after_ms: number | null;
}

/** 필요한 요청만 자동 수집하며 누적 시도와 재시도 대기를 재시작 후에도 유지한다. */
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
    let fingerprint = providerPlanFingerprint(key, state);
    // 같은 결손이 나중에 재발하면 완료 기록을 보존한 새 복구 회차를 만든다.
    while ((this.sqlite.prepare("SELECT status FROM provider_request_plans WHERE fingerprint = ?")
      .get(fingerprint) as { status: string } | undefined)?.status === "COMPLETED") {
      fingerprint = createHash("sha256").update(JSON.stringify({ previous: fingerprint, key, state })).digest("hex");
    }
    const reason = state.kind === "PUBLICATION" ? "PUBLICATION_CONFIRMED" : state.kind === "MISSING" ? "FIRST_ACQUISITION"
      : state.kind === "CORRUPT" ? "SOURCE_RECOVERY"
        : state.kind === "REPLACEMENT" ? "SOURCE_CHANGE_CONFIRMED" : "BLOCKED_SOURCE_REQUIREMENT";
    this.sqlite.prepare(`INSERT OR IGNORE INTO provider_request_plans
      (fingerprint, request_json, reason, evidence, status, attempts, max_attempts, created_at_ms)
      VALUES (?, ?, ?, ?, 'READY', 0, ?, ?)`).run(
        fingerprint, JSON.stringify(key), reason, state.evidence, ATTEMPTS_PER_BATCH, this.now());
    const check = (): ProviderRequestBlockedError | null => {
      const row = this.sqlite.prepare("SELECT status, attempts, max_attempts, retry_after_ms FROM provider_request_plans WHERE fingerprint = ?")
        .get(fingerprint) as RequestPlanRow;
      if (row.status === "COMPLETED")
        return new ProviderRequestBlockedError("SOURCE_REQUEST_COMPLETED", fingerprint, state.evidence);
      if (row.status !== "READY" && row.status !== "WAITING_RETRY")
        return new ProviderRequestBlockedError("SOURCE_REQUEST_INVALID", fingerprint, state.evidence);
      const now = this.now();
      if (row.retry_after_ms !== null && row.retry_after_ms > now)
        return new ProviderRequestBlockedError("RETRY_BACKOFF", fingerprint, state.evidence, row.retry_after_ms);
      if (row.attempts >= row.max_attempts) {
        const retryAfterMs = row.retry_after_ms ?? now + PROVIDER_RETRY_DELAY_MS;
        if (retryAfterMs > now) {
          this.sqlite.prepare("UPDATE provider_request_plans SET status = 'WAITING_RETRY', retry_after_ms = ? WHERE fingerprint = ?")
            .run(retryAfterMs, fingerprint);
          return new ProviderRequestBlockedError("RETRY_BACKOFF", fingerprint, state.evidence, retryAfterMs);
        }
        this.sqlite.prepare("UPDATE provider_request_plans SET status = 'READY', max_attempts = attempts + ?, retry_after_ms = NULL WHERE fingerprint = ?")
          .run(ATTEMPTS_PER_BATCH, fingerprint);
      } else if (row.retry_after_ms !== null) {
        this.sqlite.prepare("UPDATE provider_request_plans SET status = 'READY', retry_after_ms = NULL WHERE fingerprint = ?")
          .run(fingerprint);
      }
      return null;
    };
    // 대기 시각 저장은 오류를 던지기 전에 커밋해 반복 조회가 대기 시간을 늘리지 않게 한다.
    const blocked = this.sqlite.transaction(check).immediate();
    if (blocked) throw blocked;
    return {
      fingerprint, reason,
      beforeAttempt: () => {
        const blocked = this.sqlite.transaction(() => {
          const blocked = check();
          if (blocked) return blocked;
          this.sqlite.prepare(`UPDATE provider_request_plans SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= max_attempts THEN 'WAITING_RETRY' ELSE 'READY' END,
            retry_after_ms = CASE WHEN attempts + 1 >= max_attempts THEN ? ELSE NULL END
            WHERE fingerprint = ?`).run(this.now() + PROVIDER_RETRY_DELAY_MS, fingerprint);
          this.onSourceAttempt?.(key);
          const attempt = this.sqlite.prepare("SELECT attempts FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint) as {attempts:number};
          this.logger?.info({ event: "provider.http", activity: "SOURCE_FETCH", provider: key.provider,
            endpoint: key.endpoint, requestKey: key.parameters, reason, fingerprint, attempt: attempt.attempts }, "필요 범위의 원문 자동 수집");
          return null;
        }).immediate();
        if (blocked) throw blocked;
      },
      deferRetry: () => {
        const retryAfterMs = this.sqlite.transaction(() => {
          const row = this.sqlite.prepare("SELECT attempts, retry_after_ms FROM provider_request_plans WHERE fingerprint = ?")
            .get(fingerprint) as { attempts: number; retry_after_ms: number | null };
          const retryAfterMs = row.retry_after_ms ?? this.now() + 5000 * 2 ** Math.min(row.attempts, 5);
          this.sqlite.prepare("UPDATE provider_request_plans SET status = 'WAITING_RETRY', retry_after_ms = ? WHERE fingerprint = ? AND status != 'COMPLETED'")
            .run(retryAfterMs, fingerprint);
          return retryAfterMs;
        }).immediate();
        throw new ProviderRequestBlockedError("RETRY_BACKOFF", fingerprint, state.evidence, retryAfterMs);
      },
      complete: () => {
        this.sqlite.prepare("UPDATE provider_request_plans SET status = 'COMPLETED', retry_after_ms = NULL WHERE fingerprint = ?")
          .run(fingerprint);
        this.logger?.info({event:"provider.http.completed", fingerprint, reason}, "원문 저장 완료");
      },
    };
  }

}
