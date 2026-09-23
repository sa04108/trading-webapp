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

it("이전 ACTIONS 작업의 CFS 대기만 시작 시 즉시 다시 평가한다", async () => {
  const database = openDatabase(":memory:");
  const collect = vi.fn().mockResolvedValue(undefined);
  const ready = vi.fn();
  const queue = new AgentDataQueue(
    database,
    { ensureLatest: async () => ({ version: 2 }) } as never,
    collect,
    ready,
    pino({ enabled: false }),
  );
  const future = Date.now() + 86_400_000;
  const requests = [
    { job: "actions-queued", status: "QUEUED", input: { kind: "ACTIONS" as const, symbols: ["058970"], fromYear: 2016, toYear: 2026 }, error: "PENDING_PUBLICATION: 058970:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001423)" },
    { job: "actions-blocked", status: "BLOCKED", input: { kind: "ACTIONS" as const, symbols: ["309710"], fromYear: 2016, toYear: 2026 }, error: "PENDING_PUBLICATION: 309710:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001529)" },
    { job: "financial", status: "BLOCKED", input: { kind: "FINANCIAL" as const, symbols: ["058970"], fromYear: 2016, toYear: 2026 }, error: "PENDING_PUBLICATION: 058970:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001423)" },
    { job: "shares", status: "BLOCKED", input: { kind: "ACTIONS" as const, symbols: ["000660"], fromYear: 2016, toYear: 2026 }, error: "PENDING_PUBLICATION: 000660:SHARE_STATUS:2026:11012:NONE (20260828001529)" },
    { job: "outside", status: "QUEUED", input: { kind: "ACTIONS" as const, symbols: ["000660"], fromYear: 2016, toYear: 2025 }, error: "PENDING_PUBLICATION: 000660:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001529)" },
    { job: "failed", status: "FAILED", input: { kind: "ACTIONS" as const, symbols: ["005930"], fromYear: 2016, toYear: 2026 }, error: "PENDING_PUBLICATION: 005930:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001423)" },
  ];
  try {
    for (const entry of requests) queue.request("PREPARATION", entry.job, 1, entry.input);
    const rows = database.sqlite.prepare("SELECT w.job_id, r.id FROM agent_data_waits w JOIN agent_data_requests r ON r.id = w.request_id").all() as Array<{ job_id: string; id: string }>;
    const ids = new Map(rows.map((row) => [row.job_id, row.id]));
    const update = database.sqlite.prepare("UPDATE agent_data_requests SET status = ?, attempts = 2, next_attempt_at_ms = ?, error = ?, activity = 'WAITING_RETRY', current_item = 'stale' WHERE id = ?");
    for (const entry of requests) {
      const id = ids.get(entry.job);
      if (id === undefined) throw new Error("테스트 요청을 찾을 수 없습니다");
      update.run(entry.status, future, entry.error, id);
    }
    database.sqlite.prepare("INSERT INTO dart_filing_endpoint_checkpoints(receipt_no, endpoint, fs_div, status) VALUES ('20260828001423', 'FINANCIAL_STATEMENT', 'CFS', 'PENDING_PUBLICATION')").run();
    queue.recover();
    queue.recover();
    const states = database.sqlite.prepare("SELECT w.job_id, r.status, r.attempts, r.next_attempt_at_ms, r.error, r.activity, r.current_item FROM agent_data_waits w JOIN agent_data_requests r ON r.id = w.request_id").all() as Array<{ job_id: string; status: string; attempts: number; next_attempt_at_ms: number; error: string | null; activity: string | null; current_item: string | null }>;
    const byJob = new Map(states.map((row) => [row.job_id, row]));
    for (const job of ["actions-queued", "actions-blocked"]) {
      expect(byJob.get(job)).toEqual(expect.objectContaining({ status: "QUEUED", attempts: 2, next_attempt_at_ms: 0, error: null, activity: null, current_item: null }));
    }
    for (const job of ["financial", "shares", "outside", "failed"]) {
      const state = byJob.get(job);
      expect(state).toEqual(expect.objectContaining({ attempts: 2, next_attempt_at_ms: future, error: expect.any(String) }));
    }
    expect(byJob.get("financial")?.status).toBe("QUEUED");
    expect(byJob.get("shares")?.status).toBe("QUEUED");
    expect(byJob.get("failed")?.status).toBe("FAILED");
    expect(database.sqlite.prepare("SELECT status FROM dart_filing_endpoint_checkpoints WHERE receipt_no = '20260828001423'").get()).toEqual({ status: "PENDING_PUBLICATION" });
    queue.tick();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
  } finally { await queue.stop(); database.close(); }
});

it("완전 목록에서 사라진 접수의 공유 게시 대기만 즉시 다시 평가하고 재시작 뒤에도 복구한다", async () => {
  const database = openDatabase(":memory:");
  const collect = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn();
  const queue = new AgentDataQueue(
    database,
    { ensureLatest: async () => ({ version: 2 }) } as never,
    collect,
    vi.fn(),
    pino({ enabled: false }),
    { onProgress: notify },
  );
  const future = Date.now() + 86_400_000;
  const absentReceipt = "20260828001423";
  const otherReceipt = "20260828001529";
  try {
    const input = { kind: "FINANCIAL" as const, symbols: ["058970"], fromYear: 2026, toYear: 2026 };
    queue.request("PREPARATION", "absent-one", 1, input);
    queue.request("PREPARATION", "absent-two", 1, input);
    queue.request("PREPARATION", "other", 1, { kind: "FINANCIAL", symbols: ["309710"], fromYear: 2026, toYear: 2026 });
    queue.request("PREPARATION", "backoff", 1, { kind: "MARKET", dates: ["2026-09-18"] });
    queue.request("PREPARATION", "blocked", 1, { kind: "MARKET", dates: ["2026-09-19"] });
    queue.request("PREPARATION", "running", 1, { kind: "MARKET", dates: ["2026-09-20"] });
    queue.request("PREPARATION", "failed", 1, { kind: "MARKET", dates: ["2026-09-21"] });
    const ids = new Map((database.sqlite.prepare("SELECT w.job_id, w.request_id FROM agent_data_waits w").all() as Array<{ job_id: string; request_id: string }>).map((row) => [row.job_id, row.request_id]));
    const update = database.sqlite.prepare(`UPDATE agent_data_requests SET status = ?, attempts = 2,
      available_version = 7, next_attempt_at_ms = ?, error = ?, activity = 'WAITING_RETRY',
      activity_started_at_ms = 11, last_progress_at_ms = 12, progress_completed = 1,
      progress_total = 3, current_item = 'stale' WHERE id = ?`);
    const pending = (receipt: string) => `PENDING_PUBLICATION: 058970:FINANCIAL_STATEMENT:2026:11012:CFS (${receipt})`;
    update.run("QUEUED", future, pending(absentReceipt), ids.get("absent-one"));
    update.run("QUEUED", future, pending(otherReceipt), ids.get("other"));
    update.run("QUEUED", future, "RETRY_BACKOFF: scope (retry)", ids.get("backoff"));
    for (const job of ["blocked", "running", "failed"]) update.run(job.toUpperCase(), future, pending(absentReceipt), ids.get(job));

    queue.resumePendingPublicationForAbsentFilings([absentReceipt, absentReceipt, "invalid"]);
    queue.resumePendingPublicationForAbsentFilings([absentReceipt]);

    const states = database.sqlite.prepare("SELECT w.job_id, r.status, r.attempts, r.available_version, r.next_attempt_at_ms, r.error, r.activity, r.activity_started_at_ms, r.last_progress_at_ms, r.progress_completed, r.progress_total, r.current_item FROM agent_data_waits w JOIN agent_data_requests r ON r.id = w.request_id").all() as Array<{ job_id: string; status: string; attempts: number; available_version: number | null; next_attempt_at_ms: number; error: string | null; activity: string | null; activity_started_at_ms: number | null; last_progress_at_ms: number | null; progress_completed: number | null; progress_total: number | null; current_item: string | null }>;
    const byJob = new Map(states.map((row) => [row.job_id, row]));
    for (const job of ["absent-one", "absent-two"]) {
      expect(byJob.get(job)).toEqual(expect.objectContaining({ status: "QUEUED", attempts: 2, available_version: 7, next_attempt_at_ms: 0, error: null, activity: null, activity_started_at_ms: null, last_progress_at_ms: null, progress_completed: 1, progress_total: 3, current_item: null }));
    }
    expect(notify.mock.calls.map((call) => call[1]).sort()).toEqual(["absent-one", "absent-two"]);
    for (const job of ["other", "backoff", "blocked", "running", "failed"]) {
      expect(byJob.get(job)).toEqual(expect.objectContaining({ attempts: 2, available_version: 7, next_attempt_at_ms: future, error: expect.any(String), activity: "WAITING_RETRY", current_item: "stale" }));
    }
    expect(byJob.get("other")?.error).toBe(pending(otherReceipt));
    expect(byJob.get("backoff")?.error).toBe("RETRY_BACKOFF: scope (retry)");
    expect(byJob.get("blocked")?.status).toBe("BLOCKED");
    expect(byJob.get("running")?.status).toBe("RUNNING");
    expect(byJob.get("failed")?.status).toBe("FAILED");

    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity, receipt_no, symbol, business_year, report_code, payload_json, discovered_at_ms, status)
      VALUES ('unlisted', ?, '058970', 2026, '11012', '{}', 1, 'UNLISTED')`).run(absentReceipt);
    update.run("QUEUED", future, pending(absentReceipt), ids.get("absent-one"));
    queue.recover();
    expect(byJob.get("absent-one")).toBeDefined();
    const recovered = database.sqlite.prepare("SELECT next_attempt_at_ms, error FROM agent_data_requests WHERE id = ?").get(ids.get("absent-one"));
    expect(recovered).toEqual({ next_attempt_at_ms: 0, error: null });
    queue.tick();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
  } finally { await queue.stop(); database.close(); }
});

it("실행 중 접수가 목록에서 사라진 뒤 본문 오류가 돌아와도 하루 대기를 다시 만들지 않는다", async () => {
  const database = openDatabase(":memory:");
  const receipt = "20260828001423";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const collect = vi.fn(async () => {
    await gate;
    throw new ProviderRequestBlockedError("PENDING_PUBLICATION",
      "058970:FINANCIAL_STATEMENT:2026:11012:CFS", receipt, Date.now() + 86_400_000);
  });
  const queue = new AgentDataQueue(database,
    { ensureLatest: async () => ({ version: 2 }) } as never, collect, vi.fn(), pino({ enabled: false }));
  try {
    queue.request("PREPARATION", "racing", 1,
      { kind: "FINANCIAL", symbols: ["058970"], fromYear: 2026, toYear: 2026 });
    const pending = database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES ('racing',?, '058970',2026,'11012','{}',1,'UNLISTED')`);
    queue.tick();
    await vi.waitFor(() => expect(database.sqlite.prepare("SELECT status FROM agent_data_requests").get())
      .toEqual({ status: "RUNNING" }));
    pending.run(receipt);
    release();
    await vi.waitFor(() => expect(database.sqlite.prepare("SELECT status,next_attempt_at_ms,error FROM agent_data_requests").get())
      .toEqual({ status: "QUEUED", next_attempt_at_ms: 0, error: null }));
    expect(collect).toHaveBeenCalledTimes(1);
  } finally { release(); await queue.stop(); database.close(); }
});

it("부분 반영 공시가 다시 목록에 나타나면 해당 무결성 차단만 복원하고 재시작 뒤에도 회복한다", async () => {
  const database = openDatabase(":memory:");
  const queue = new AgentDataQueue(database,
    { ensureLatest: async () => ({ version: 2 }) } as never,
    vi.fn(), vi.fn(), pino({ enabled: false }));
  const receipt = "20260828001423";
  const error = `UNRESOLVED_FILING: 058970:FINANCIAL_STATEMENT:2026:11012:CFS (${receipt})`;
  try {
    queue.request("PREPARATION", "reappeared", 1,
      { kind: "FINANCIAL", symbols: ["058970"], fromYear: 2026, toYear: 2026 });
    queue.request("PREPARATION", "other", 1,
      { kind: "FINANCIAL", symbols: ["309710"], fromYear: 2026, toYear: 2026 });
    const rows = database.sqlite.prepare("SELECT w.job_id,w.request_id FROM agent_data_waits w").all() as
      Array<{job_id:string;request_id:string}>;
    const ids = new Map(rows.map((row) => [row.job_id, row.request_id]));
    const block = database.sqlite.prepare("UPDATE agent_data_requests SET status='BLOCKED', error=?, next_attempt_at_ms=99 WHERE id=?");
    block.run(error, ids.get("reappeared"));
    block.run("UNRESOLVED_FILING: 309710:FINANCIAL_STATEMENT:2026:11012:CFS (20260828001529)", ids.get("other"));
    queue.resumeUnresolvedForReappearedFilings([receipt]);
    queue.resumeUnresolvedForReappearedFilings([receipt]);
    expect(database.sqlite.prepare("SELECT status,error,next_attempt_at_ms FROM agent_data_requests WHERE id=?").get(ids.get("reappeared")))
      .toEqual({ status: "QUEUED", error: null, next_attempt_at_ms: 0 });
    expect(database.sqlite.prepare("SELECT status FROM agent_data_requests WHERE id=?").get(ids.get("other")))
      .toEqual({ status: "BLOCKED" });
    database.sqlite.prepare(`INSERT INTO dart_discovered_filings
      (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
      VALUES ('reappeared',?, '058970',2026,'11012','{}',1,'PENDING')`).run(receipt);
    block.run(error, ids.get("reappeared"));
    queue.recover();
    expect(database.sqlite.prepare("SELECT status,error,next_attempt_at_ms FROM agent_data_requests WHERE id=?").get(ids.get("reappeared")))
      .toEqual({ status: "QUEUED", error: null, next_attempt_at_ms: 0 });
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
