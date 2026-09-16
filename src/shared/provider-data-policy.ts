export type DataProvider = "KRX" | "DART";

/** 인증 정보와 실행 버전은 원천 요청의 정체성에 포함하지 않는다. */
export interface ProviderRequestKey {
  readonly provider: DataProvider;
  readonly namespace: string;
  readonly endpoint: string;
  readonly parameters: Readonly<Record<string, string>>;
}

export type ProviderDecisionReason =
  | "FIRST_ACQUISITION"
  | "REUSE_STORED"
  | "REUSE_LEGACY"
  | "REPLAY_LOCAL"
  | "REPAIR_LOCAL"
  | "BLOCKED_SOURCE_REQUIREMENT"
  | "BLOCKED_INTERPRETATION"
  | "SOURCE_RECOVERY"
  | "SOURCE_CHANGE_CONFIRMED"
  | "PUBLICATION_CONFIRMED"
  | "PENDING_PUBLICATION"
  | "FILING_DISCOVERY";

export interface ProviderLocalState {
  readonly history: "NEVER" | "LEGACY" | "RECORDED";
  readonly raw: "VALID" | "ABSENT" | "CORRUPT" | "IDENTITY_MISMATCH";
  readonly normalized: "VALID" | "MISSING" | "INVALID";
  readonly interpretation?: "REPLAY_REQUIRED" | "MISSING_FIELD" | "FAILED";
  /** 원문·manifest·공시 사건 등 실제 상태의 식별자. 실행 해시는 넣지 않는다. */
  readonly evidence: readonly string[];
  readonly sourceChange?: string;
  readonly publication?: string;
  readonly publicationPending?: boolean;
}

export interface ProviderRequestPlan {
  readonly key: ProviderRequestKey;
  readonly action: "REUSE" | "REPLAY" | "BLOCK" | "REQUEST";
  readonly reason: ProviderDecisionReason;
  readonly evidence: readonly string[];
  readonly requiresApproval: boolean;
  readonly fingerprint: string;
}

const SECRET_PARAMETER = /^(?:auth[_-]?key|api[_-]?key|crtfc_key|token|access_token|authorization|password|secret)$/i;

export function providerRequestKeyId(key: ProviderRequestKey): string {
  if (!key.namespace || !key.endpoint.startsWith("/") || key.endpoint.includes("?") || key.endpoint.includes("#")) {
    throw new Error("공급자 요청 namespace와 endpoint가 올바르지 않습니다.");
  }
  const parameters = Object.entries(key.parameters).sort(([a], [b]) => a.localeCompare(b));
  if (parameters.some(([name]) => SECRET_PARAMETER.test(name))) {
    throw new Error("공급자 요청 키에는 인증 정보를 포함할 수 없습니다.");
  }
  return JSON.stringify([key.provider, key.namespace, key.endpoint, parameters]);
}

export function providerPlan(
  key: ProviderRequestKey,
  action: ProviderRequestPlan["action"],
  reason: ProviderDecisionReason,
  evidence: readonly string[],
  requiresApproval = false,
): ProviderRequestPlan {
  const canonicalEvidence = Object.freeze([...new Set(evidence)].sort());
  // 호출자가 계획 작성 뒤 인자를 변경해도 승인 대상이 달라지지 않게 복사한다.
  const immutableKey = Object.freeze({ ...key, parameters: Object.freeze({ ...key.parameters }) });
  return Object.freeze({
    key: immutableKey,
    action,
    reason,
    evidence: canonicalEvidence,
    requiresApproval,
    fingerprint: JSON.stringify([providerRequestKeyId(immutableKey), action, reason, canonicalEvidence, requiresApproval]),
  });
}

/** 순수 로컬 판정이다. FULL/force/런타임 버전은 HTTP 권한을 부여하지 않는다. */
export function planProviderRequest(key: ProviderRequestKey, state: ProviderLocalState): ProviderRequestPlan {
  const result = (action: ProviderRequestPlan["action"], reason: ProviderDecisionReason, approval = false) =>
    providerPlan(key, action, reason, [...state.evidence, ...(state.sourceChange ? [state.sourceChange] : []), ...(state.publication ? [state.publication] : [])], approval);

  if (state.sourceChange) return result("BLOCK", "SOURCE_CHANGE_CONFIRMED", true);
  if (state.raw === "CORRUPT" || state.raw === "IDENTITY_MISMATCH") return result("BLOCK", "SOURCE_RECOVERY", true);
  if (state.interpretation === "FAILED") return result("BLOCK", "BLOCKED_INTERPRETATION");
  if (state.interpretation === "MISSING_FIELD") return result("BLOCK", "BLOCKED_SOURCE_REQUIREMENT", true);
  if (state.publicationPending) return result("BLOCK", "PENDING_PUBLICATION");
  if (state.normalized === "VALID" && state.interpretation !== "REPLAY_REQUIRED") {
    return result("REUSE", state.history === "LEGACY" ? "REUSE_LEGACY" : "REUSE_STORED");
  }
  if (state.raw === "VALID") {
    return result("REPLAY", state.normalized === "INVALID" ? "REPAIR_LOCAL" : "REPLAY_LOCAL");
  }
  if (state.history !== "NEVER") return result("BLOCK", "BLOCKED_SOURCE_REQUIREMENT", true);
  return result("REQUEST", state.publication ? "PUBLICATION_CONFIRMED" : "FIRST_ACQUISITION");
}

export interface ProviderRequestApproval {
  readonly fingerprint: string;
  readonly status: "APPROVED" | "REVOKED" | "CONSUMED";
}

export class ProviderDataBlockedError extends Error {
  constructor(readonly plan: ProviderRequestPlan) {
    super(`공급자 데이터 작업이 차단되었습니다: ${plan.reason}`);
    this.name = "ProviderDataBlockedError";
  }
}

/** 매 HTTP attempt 직전에 서버가 다시 평가한 현재 상태 및 현재 승인으로 호출한다. */
export function assertProviderRequestAllowed(
  plan: ProviderRequestPlan,
  approval?: ProviderRequestApproval | null,
): void {
  const expected = providerPlan(plan.key, plan.action, plan.reason, plan.evidence, plan.requiresApproval).fingerprint;
  if (expected !== plan.fingerprint) throw new ProviderDataBlockedError(plan);
  if (plan.action === "REQUEST" && !plan.requiresApproval) return;
  if (plan.requiresApproval && approval?.status === "APPROVED" && approval.fingerprint === plan.fingerprint) return;
  throw new ProviderDataBlockedError(plan);
}
