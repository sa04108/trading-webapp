import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import {
  PROVIDER_RETRY_DELAY_MS,
  SqliteProviderRequestPolicy,
  type ProviderRequestKey,
} from "../../src/server/shared/provider-request-policy.js";

const key: ProviderRequestKey = {
  provider: "KRX", namespace: "fixture", endpoint: "/daily", parameters: { basDd: "20260918" },
};

const state = { kind: "CORRUPT" as const, evidence: "원문 해시 불일치" };

describe("공급자 자동 수집 정책", () => {
  it.each(["MISSING", "PUBLICATION", "CORRUPT", "REPLACEMENT", "REQUIREMENT"] as const)(
    "%s 자료는 수동 결정 없이 필요한 요청을 실행하고 완료 기록을 남긴다", (kind) => {
      const database = openDatabase(":memory:");
      try {
        const policy = new SqliteProviderRequestPolicy(database.sqlite);
        const permit = policy.authorize(key, { kind, evidence: "대상 원문 확인" });
        permit.beforeAttempt();
        permit.complete();
        expect(database.sqlite.prepare("SELECT status, attempts, retry_after_ms FROM provider_request_plans").get())
          .toEqual({ status: "COMPLETED", attempts: 1, retry_after_ms: null });
        expect(() => permit.beforeAttempt()).toThrow("SOURCE_REQUEST_COMPLETED");
      } finally { database.close(); }
    },
  );

  it("시도 한도와 대기 시각은 정책 재생성·동시 permit·반복 조회에도 유지된다", () => {
    const database = openDatabase(":memory:");
    let now = 1_000_000;
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite, () => now);
      const first = policy.authorize(key, state);
      const shared = policy.authorize(key, state);
      for (let i = 0; i < 5; i++) (i % 2 ? first : shared).beforeAttempt();
      const retryAfterMs = now + PROVIDER_RETRY_DELAY_MS;
      expect(() => shared.beforeAttempt()).toThrow("RETRY_BACKOFF");
      now += 10_000;
      const restarted = new SqliteProviderRequestPolicy(database.sqlite, () => now);
      expect(() => restarted.authorize(key, state)).toThrow("RETRY_BACKOFF");
      expect(database.sqlite.prepare("SELECT attempts, max_attempts, retry_after_ms FROM provider_request_plans").get())
        .toEqual({ attempts: 5, max_attempts: 5, retry_after_ms: retryAfterMs });
      now = retryAfterMs;
      const resumed = restarted.authorize(key, state);
      resumed.beforeAttempt();
      expect(database.sqlite.prepare("SELECT attempts, max_attempts, retry_after_ms FROM provider_request_plans").get())
        .toEqual({ attempts: 6, max_attempts: 10, retry_after_ms: null });
      resumed.complete();
    } finally { database.close(); }
  });

  it("다섯 번째 요청이 성공하면 대기 없이 완료하고 다른 범위는 독립 실행한다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const permit = policy.authorize(key, state);
      for (let i = 0; i < 5; i++) permit.beforeAttempt();
      permit.complete();
      const independent = policy.authorize({ ...key, parameters: { basDd: "20260917" } }, state);
      independent.beforeAttempt();
      independent.complete();
      expect(database.sqlite.prepare("SELECT status, attempts, retry_after_ms FROM provider_request_plans ORDER BY rowid").all())
        .toEqual([
          { status: "COMPLETED", attempts: 5, retry_after_ms: null },
          { status: "COMPLETED", attempts: 1, retry_after_ms: null },
        ]);
    } finally { database.close(); }
  });

  it.each(["REQUIREMENT", "CORRUPT"] as const)("%s 결손이 똑같이 재발해도 새 회차로 복구하고 오래된 permit은 재사용하지 않는다", (kind) => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const state = { kind, evidence: "동일 원문 결손" };
      const first = policy.authorize(key, state);
      first.beforeAttempt(); first.complete();
      const second = policy.authorize(key, state);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(() => first.beforeAttempt()).toThrow("SOURCE_REQUEST_COMPLETED");
      expect(policy.authorize(key, state).fingerprint).toBe(second.fingerprint);
      second.beforeAttempt(); second.complete();
      expect(database.sqlite.prepare("SELECT status, attempts FROM provider_request_plans ORDER BY rowid").all())
        .toEqual([{ status: "COMPLETED", attempts: 1 }, { status: "COMPLETED", attempts: 1 }]);
    } finally { database.close(); }
  });

  it("완료 후 유실된 원문은 최초 수집으로 숨기지 않고 자동 복구한다", () => {
    const database = openDatabase(":memory:");
    try {
      const policy = new SqliteProviderRequestPolicy(database.sqlite);
      const initial = policy.authorize(key, { kind: "MISSING", evidence: "원문 없음" });
      initial.beforeAttempt(); initial.complete();
      const recovery = policy.authorize(key, { kind: "MISSING", evidence: "원문 없음" });
      expect(recovery.reason).toBe("SOURCE_RECOVERY");
      recovery.beforeAttempt(); recovery.complete();
      expect(database.sqlite.prepare("SELECT attempts FROM provider_request_plans").all())
        .toEqual([{ attempts: 1 }, { attempts: 1 }]);
    } finally { database.close(); }
  });
});
