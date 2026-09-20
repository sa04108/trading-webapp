import { expect, it, vi } from "vitest";
import { pino } from "pino";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { AgentDataQueue } from "../../src/server/modules/agents/application/agent-data-queue.js";
import { ProviderRequestBlockedError } from "../../src/server/shared/provider-request-policy.js";
import { createDartFactSource } from "../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js";

it.each(["PENDING_PUBLICATION", "RETRY_BACKOFF"])("%s 대기는 기존 진행률로 전달하고 예약 시각에 자동으로 작업을 재개한다", async (reason) => {
  const database = openDatabase(":memory:");
  const now = Date.now();
  const deadline = now + 900_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const collect = vi.fn().mockRejectedValueOnce(new ProviderRequestBlockedError(reason, "scope", "자료 대기", deadline)).mockResolvedValue(undefined);
  const ready = vi.fn();
  const queue = new AgentDataQueue(database, { ensureLatest: async () => ({ version: 2 }) } as never, collect, ready, pino({ enabled: false }));
  try {
    queue.request("PREPARATION", "job", 1, { kind: "MARKET", dates: ["2026-09-18"] });
    queue.tick();
    await vi.waitFor(() => expect(queue.progressForJob("job")).toMatchObject({ activity: "WAITING_RETRY", nextResumeAtMs: deadline, retryCount: 0 }));
    queue.recover(); queue.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(deadline);
    queue.tick();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith("PREPARATION", "job", undefined));
    expect(collect).toHaveBeenCalledTimes(2);
  } finally { await queue.stop(); clock.mockRestore(); database.close(); }
});

it("종목 정체성이 불일치하는 입력은 자동 재시도로 우회하지 않는다", async () => {
  const database = openDatabase(":memory:");
  const collect = vi.fn().mockRejectedValue(new ProviderRequestBlockedError("IDENTITY_MISMATCH", "scope", "회사 불일치"));
  const queue = new AgentDataQueue(database, {} as never, collect, vi.fn(), pino({ enabled: false }));
  try {
    queue.request("PREPARATION", "job", 1, { kind: "MARKET", dates: ["2026-09-18"] });
    queue.tick();
    await vi.waitFor(() => expect(queue.progressForJob("job")).toMatchObject({ activity: "BLOCKED", nextResumeAtMs: null }));
    queue.recover(); queue.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(1);
  } finally { await queue.stop(); database.close(); }
});

it("DART 접수 뒤 아직 게시되지 않은 본문은 하루 대기를 기록하고 그 전에 HTTP를 다시 보내지 않는다", async () => {
  const now = Date.parse("2026-09-20T10:00:00Z");
  let retryAfterMs: number | null = null;
  const fetchImpl = vi.fn(async () => Response.json({ status: "013" }));
  const source = createDartFactSource({ baseUrl: "https://dart.test", apiKey: "fixture" }, pino({ enabled: false }), {
    clock: { now: () => now }, fetchImpl, sleep: async () => {}, corpCodeResolver: { resolve: async () => "00126380" },
    pendingFilings: {
      get: () => ({ receiptNo: "20260920000001", discoveredAtMs: now, status: "PENDING", retryAfterMs }),
      markApplied() {}, markPendingPublication(_key, _receipt, deadline) { retryAfterMs = deadline; },
    },
  });
  for (let i = 0; i < 2; i++) {
    await expect(source.fetchFinancials({ symbols: ["005930"], years: [2025], shareYears: [2025], consolidated: true }))
      .rejects.toMatchObject({ reason: "PENDING_PUBLICATION", retryAfterMs: now + 86_400_000 });
  }
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
