import { describe, expect, it, vi } from "vitest";
import { assertProviderRequestAllowed, planProviderRequest, providerRequestKeyId, type ProviderLocalState, type ProviderRequestKey } from "../../src/shared/provider-data-policy.js";
import { RestClient } from "../../src/server/shared/rest-client.js";
import { createLogger } from "../../src/server/shared/logger.js";
import { loadConfig } from "../../src/server/bootstrap/config.js";

const key: ProviderRequestKey = { provider: "KRX", namespace: "test", endpoint: "/daily", parameters: { basDd: "20260915" } };
const state: ProviderLocalState = { history: "RECORDED", raw: "VALID", normalized: "VALID", evidence: ["raw:original"] };
const logger = createLogger(loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }));

describe("A: 공급자 호출 정책", () => {
  it.each(["KRX", "DART"] as const)("%s 정상 데이터 및 legacy는 요청하지 않는다", (provider) => {
    expect(planProviderRequest({ ...key, provider }, state).action).toBe("REUSE");
    expect(planProviderRequest({ ...key, provider }, { ...state, history: "LEGACY", raw: "ABSENT" }).reason).toBe("REUSE_LEGACY");
  });
  it("파서 변경과 manifest 손상은 로컬 재생으로 분류한다", () => {
    expect(planProviderRequest(key, { ...state, interpretation: "REPLAY_REQUIRED" }).reason).toBe("REPLAY_LOCAL");
    expect(planProviderRequest(key, { ...state, normalized: "INVALID" }).reason).toBe("REPAIR_LOCAL");
  });
  it("진짜 최초 결손만 승인 없이 요청한다", () => {
    const first = planProviderRequest(key, { history: "NEVER", raw: "ABSENT", normalized: "MISSING", evidence: [] });
    expect(first.reason).toBe("FIRST_ACQUISITION");
    expect(() => assertProviderRequestAllowed(first)).not.toThrow();
    expect(() => assertProviderRequestAllowed(planProviderRequest(key, { ...state, raw: "ABSENT", normalized: "MISSING" }))).toThrow();
  });
  it.each(["CORRUPT", "IDENTITY_MISMATCH"] as const)("%s는 현재 계획의 승인 없이는 요청하지 않는다", (raw) => {
    const plan = planProviderRequest(key, { ...state, raw });
    expect(() => assertProviderRequestAllowed(plan)).toThrow();
    expect(() => assertProviderRequestAllowed(plan, { fingerprint: plan.fingerprint, status: "APPROVED" })).not.toThrow();
    expect(() => assertProviderRequestAllowed(plan, { fingerprint: plan.fingerprint, status: "REVOKED" })).toThrow();
    expect(() => assertProviderRequestAllowed(plan, { fingerprint: "other-plan", status: "APPROVED" })).toThrow();
  });
  it("정정 근거가 달라지면 기존 승인을 재사용하지 않는다", () => {
    const oldPlan = planProviderRequest(key, { ...state, sourceChange: "receipt:1" });
    const newPlan = planProviderRequest(key, { ...state, sourceChange: "receipt:2" });
    expect(() => assertProviderRequestAllowed(newPlan, { fingerprint: oldPlan.fingerprint, status: "APPROVED" })).toThrow();
  });
  it("필드 미보유와 파서 실패를 최초 수집으로 바꾸지 않는다", () => {
    expect(planProviderRequest(key, { ...state, interpretation: "MISSING_FIELD" }).requiresApproval).toBe(true);
    expect(planProviderRequest(key, { ...state, interpretation: "FAILED" }).requiresApproval).toBe(false);
    expect(planProviderRequest(key, { ...state, publicationPending: true }).reason).toBe("PENDING_PUBLICATION");
  });
  it("정규화된 요청 키는 인자 순서와 무관하고 인증키를 거부한다", () => {
    expect(providerRequestKeyId({ ...key, parameters: { a: "1", b: "2" } })).toBe(providerRequestKeyId({ ...key, parameters: { b: "2", a: "1" } }));
    expect(() => providerRequestKeyId({ ...key, parameters: { crtfc_key: "secret" } })).toThrow();
  });
});

describe("A: 실제 HTTP attempt 경계", () => {
  it("승인 취소 후 retry는 HTTP와 quota 양쪽에서 제외한다", async () => {
    const plan = planProviderRequest(key, { ...state, raw: "CORRUPT" });
    let status: "APPROVED" | "REVOKED" = "APPROVED";
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const quota = vi.fn();
    const client = new RestClient({ baseUrl: "https://provider.invalid", logger, fetchImpl: fetchImpl as typeof fetch, groupMinIntervalMs: { default: 0 }, sleep: async () => { status = "REVOKED"; } });
    await expect(client.request("default", "/daily", {}, { authorizeAttempt: () => assertProviderRequestAllowed(plan, { fingerprint: plan.fingerprint, status }), beforeAttempt: quota })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledTimes(1);
  });
  it("처음부터 차단되거나 취소된 요청은 실제 HTTP 0회다", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const quota = vi.fn();
    const client = new RestClient({ baseUrl: "https://provider.invalid", logger, fetchImpl: fetchImpl as typeof fetch, groupMinIntervalMs: { default: 0 } });
    const plan = planProviderRequest(key, { ...state, raw: "CORRUPT" });
    await expect(client.request("default", "/daily", {}, { authorizeAttempt: () => assertProviderRequestAllowed(plan), beforeAttempt: quota })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(client.request("default", "/daily", {}, { signal: controller.signal, beforeAttempt: quota })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
  });
});
