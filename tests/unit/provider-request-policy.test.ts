import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { ProviderRequestBlockedError, SqliteProviderRequestPolicy, providerPlanFingerprint } from "../../src/server/shared/provider-request-policy.js";

const key = { provider: "KRX" as const, namespace: "fixture", endpoint: "/daily", parameters: { date: "2026-01-01" } };
describe("공급자 요청 승인", () => {
  it("손상 키와 근거별로 승인하고 취소·완료 이후 재시도를 막는다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const state = { kind: "CORRUPT" as const, evidence: "snapshot:1/hash:a" };
      expect(() => policy.authorize(key, state)).toThrow(ProviderRequestBlockedError);
      const [plan] = policy.list() as {fingerprint: string}[];
      policy.decide(plan!.fingerprint, true);
      const permit = policy.authorize(key, state);
      permit.beforeAttempt();
      expect(() => policy.authorize({...key, parameters: { date: "2026-01-02" }}, state)).toThrow(ProviderRequestBlockedError);
      expect(() => policy.authorize(key, {...state, evidence: "snapshot:2/hash:b"})).toThrow(ProviderRequestBlockedError);
      policy.decide(plan!.fingerprint, false);
      expect(() => permit.beforeAttempt()).toThrow(ProviderRequestBlockedError);
      policy.decide(plan!.fingerprint, true);
      permit.complete();
      expect(policy.decide(plan!.fingerprint, true)).toBe(false);
      expect(() => permit.beforeAttempt()).toThrow(ProviderRequestBlockedError);
    } finally { database.close(); }
  });
  it("최초 수집도 물리 attempt 상한을 영속 보존한다", () => {
    const database = openDatabase(":memory:");
    try {
      const state = {kind: "MISSING" as const, evidence: "no history"};
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const permit = policy.authorize(key, state);
      for (let i = 0; i < 5; i++) permit.beforeAttempt();
      expect(() => new SqliteProviderRequestPolicy(database.sqlite).authorize(key, state)).toThrow(ProviderRequestBlockedError);
    } finally { database.close(); }
  });
  it("완료 후 원문 유실은 최초 수집 권한을 재사용하지 않는다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const state = {kind:"MISSING" as const,evidence:"no history"};
      const permit = policy.authorize(key,state);
      permit.beforeAttempt(); permit.complete();
      expect(() => policy.authorize(key,state)).toThrow(ProviderRequestBlockedError);
      expect(policy.list()).toEqual(expect.arrayContaining([expect.objectContaining({reason:"SOURCE_RECOVERY",status:"BLOCKED"})]));
    } finally { database.close(); }
  });

  it("반복 승인은 범위를 넓히지 않고 소진 뒤 명시적 재승인만 다음 다섯 번을 허용한다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite, () => 123);
      const state = { kind: "REPLACEMENT" as const, evidence: "receipt:20260919000001" };
      const fingerprint = providerPlanFingerprint(key, state);
      expect(() => policy.authorize(key, state)).toThrow(ProviderRequestBlockedError);
      for (let i = 0; i < 3; i++) expect(policy.decide(fingerprint, true)).toBe(true);
      const permit = policy.authorize(key, state);
      for (let i = 0; i < 5; i++) permit.beforeAttempt();
      expect(() => permit.beforeAttempt()).toThrow(ProviderRequestBlockedError);
      expect(database.sqlite.prepare("SELECT attempts, max_attempts FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint))
        .toEqual({ attempts: 5, max_attempts: 5 });
      expect(policy.decide(fingerprint, true)).toBe(true);
      expect(policy.decide(fingerprint, true)).toBe(true);
      for (let i = 0; i < 5; i++) permit.beforeAttempt();
      expect(() => permit.beforeAttempt()).toThrow(ProviderRequestBlockedError);
      expect(database.sqlite.prepare("SELECT attempts, max_attempts FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint))
        .toEqual({ attempts: 10, max_attempts: 10 });
      for (const other of [
        { ...key, namespace: "another" },
        { ...key, endpoint: "/other" },
        { ...key, provider: "DART" as const },
        { ...key, parameters: { date: "2026-01-02" } },
      ]) expect(() => policy.authorize(other, state)).toThrow(ProviderRequestBlockedError);
      expect(() => policy.authorize(key, { ...state, evidence: "receipt:20260920000001" })).toThrow(ProviderRequestBlockedError);
    } finally { database.close(); }
  });

  it("취소와 attempt 이력은 실제 DB 재시작 뒤에도 남고 기존 permit의 재시도도 차단한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "provider-policy-"));
    const file = join(directory, "app.sqlite");
    let database = openDatabase(file);
    try {
      const state = { kind: "CORRUPT" as const, evidence: "raw:hash:a" };
      const fingerprint = providerPlanFingerprint(key, state);
      let policy = new SqliteProviderRequestPolicy(database.sqlite, () => 123);
      expect(() => policy.authorize(key, state)).toThrow(ProviderRequestBlockedError);
      policy.decide(fingerprint, true);
      const permit = policy.authorize(key, state);
      permit.beforeAttempt();
      policy.decide(fingerprint, false);
      expect(() => permit.beforeAttempt()).toThrow(ProviderRequestBlockedError);
      database.close();
      database = openDatabase(file);
      policy = new SqliteProviderRequestPolicy(database.sqlite, () => 456);
      expect(() => policy.authorize(key, state)).toThrow(ProviderRequestBlockedError);
      expect(database.sqlite.prepare("SELECT status, attempts, max_attempts, decided_at_ms FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint))
        .toEqual({ status: "CANCELLED", attempts: 1, max_attempts: 5, decided_at_ms: 123 });
      policy.decide(fingerprint, true);
      policy.authorize(key, state).beforeAttempt();
      expect(database.sqlite.prepare("SELECT attempts, max_attempts FROM provider_request_plans WHERE fingerprint = ?").get(fingerprint))
        .toEqual({ attempts: 2, max_attempts: 5 });
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("확인된 새 게시 사건은 별도 최초 본문 권한이며 완료 원문 유실은 복구 승인이 필요하다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const initial = policy.authorize(key, { kind: "MISSING", evidence: "no raw" });
      initial.beforeAttempt(); initial.complete();
      const publication = { kind: "PUBLICATION" as const, evidence: "new receipt:20260919000001" };
      const permit = policy.authorize(key, publication);
      expect(permit.reason).toBe("PUBLICATION_CONFIRMED");
      permit.beforeAttempt(); permit.complete();
      expect(() => policy.authorize(key, publication)).toThrow(ProviderRequestBlockedError);
      const next = policy.authorize(key, { ...publication, evidence: "new receipt:20260920000001" });
      expect(next.fingerprint).not.toBe(permit.fingerprint);
      expect(() => policy.authorize(key, { kind: "MISSING", evidence: "raw lost after restore" })).toThrow(ProviderRequestBlockedError);
      expect(policy.list()).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "SOURCE_RECOVERY", status: "BLOCKED" })]));
    } finally { database.close(); }
  });

  it("요청 객체의 속성 순서가 바뀌어도 완료 원문 유실을 신규 수집으로 오인하지 않는다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const original = { ...key, parameters: { date: "2026-01-01", market: "KOSPI" } };
      const first = policy.authorize(original, { kind: "MISSING", evidence: "no raw" });
      first.beforeAttempt(); first.complete();
      const reordered = { parameters: { market: "KOSPI", date: "2026-01-01" }, endpoint: key.endpoint, namespace: key.namespace, provider: key.provider };
      expect(() => policy.authorize(reordered, { kind: "MISSING", evidence: "missing after restart" })).toThrow(ProviderRequestBlockedError);
    } finally { database.close(); }
  });

});
