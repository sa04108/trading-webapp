import { describe, expect, it } from "vitest";
import { assertProviderRequestAllowed, planProviderRequest } from "../../src/shared/provider-data-policy.js";

describe("A: 승인 계획의 요청 정체성", () => {
  it("계획 작성 뒤 호출자가 원본 인자를 수정해도 요청 범위가 바뀌지 않는다", () => {
    const parameters = { basDd: "20260915" };
    const plan = planProviderRequest(
      { provider: "KRX", namespace: "test", endpoint: "/daily", parameters },
      { history: "RECORDED", raw: "CORRUPT", normalized: "MISSING", evidence: ["raw:1"] },
    );
    parameters.basDd = "20260916";
    expect(plan.key.parameters.basDd).toBe("20260915");
    expect(Object.isFrozen(plan.key.parameters)).toBe(true);
    expect(Object.isFrozen(plan.evidence)).toBe(true);
  });

  it("fingerprint를 복사해 다른 endpoint나 근거에 붙인 계획은 승인되지 않는다", () => {
    const plan = planProviderRequest(
      { provider: "DART", namespace: "test", endpoint: "/financial", parameters: { year: "2025" } },
      { history: "RECORDED", raw: "CORRUPT", normalized: "MISSING", evidence: ["raw:1"] },
    );
    const approval = { fingerprint: plan.fingerprint, status: "APPROVED" as const };
    expect(() => assertProviderRequestAllowed({ ...plan, key: { ...plan.key, endpoint: "/other" } }, approval)).toThrow();
    expect(() => assertProviderRequestAllowed({ ...plan, evidence: ["raw:2"] }, approval)).toThrow();
    expect(() => assertProviderRequestAllowed(plan, { ...approval, status: "CONSUMED" })).toThrow();
  });
});
