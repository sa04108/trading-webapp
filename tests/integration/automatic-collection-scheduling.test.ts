import { expect, it, vi } from "vitest";
import { pino } from "pino";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { AgentDataQueue } from "../../src/server/modules/agents/application/agent-data-queue.js";
import { ProviderRequestBlockedError } from "../../src/server/shared/provider-request-policy.js";

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

it("이전 재무·주식총수·증자감자 접수번호 대기는 시작 시 즉시 재평가하고 다른 범위는 보존한다", async () => {
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
    for (const job of ["actions-queued", "actions-blocked", "financial", "shares"]) {
      expect(byJob.get(job)).toEqual(expect.objectContaining({ status: "QUEUED", attempts: 2, next_attempt_at_ms: 0, error: null, activity: null, current_item: null }));
    }
    for (const job of ["outside", "failed"]) {
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


it('이전 목록 미관측 차단은 재조회로 복구하고 실제 해석 오류·quota·네트워크 대기는 유지한다', async () => {
  const { SqliteDartPendingFilingStore } = await import('../../src/server/modules/facts/infrastructure/dart/dart-pending-filing-store.js');
  const database = openDatabase(':memory:');
  const pending = new SqliteDartPendingFilingStore(database.sqlite);
  const collect = vi.fn().mockResolvedValue(undefined);
  const ready = vi.fn();
  const queue = new AgentDataQueue(database, { ensureLatest: async () => ({ version: 2 }) } as never,
    collect, ready, pino({ enabled: false }));
  const future = Date.now() + 86_400_000;
  try {
    const cases = [
      { symbol: '206560', filing: 'UNLISTED', error: 'PENDING_PUBLICATION', resume: true },
      { symbol: '054670', filing: 'UNLISTED_PARTIAL', error: 'UNRESOLVED_FILING', resume: true },
      { symbol: '000660', filing: 'UNRESOLVED', error: 'UNRESOLVED_FILING', resume: false },
      { symbol: '005930', filing: 'PENDING', error: 'RETRY_BACKOFF', resume: false },
      { symbol: '058970', filing: 'PENDING', error: 'DART 일일 호출 한도 대기', resume: false },
    ];
    for (const [index, entry] of cases.entries()) {
      const receipt = `20260820000${index + 100}`;
      database.sqlite.prepare("INSERT INTO symbols(code,market,created_at_ms) VALUES(?,'KR',1)").run(entry.symbol);
      database.sqlite.prepare(`INSERT INTO dart_discovered_filings
        (identity,receipt_no,symbol,business_year,report_code,payload_json,discovered_at_ms,status)
        VALUES(?,?,?,2026,'11012','{}',1,?)`).run(receipt, receipt, entry.symbol, entry.filing);
      database.sqlite.prepare(`INSERT INTO dart_filing_endpoint_checkpoints
        (receipt_no,endpoint,fs_div,status,retry_after_ms) VALUES(?,'SHARE_STATUS','NONE',?,?)`)
        .run(receipt, entry.filing === 'UNLISTED_PARTIAL' ? 'APPLIED' : 'PENDING_PUBLICATION', future);
      queue.request('PREPARATION', entry.symbol, 1, { kind: 'ACTIONS', symbols: [entry.symbol], fromYear: 2026, toYear: 2026 });
      database.sqlite.prepare(`UPDATE agent_data_requests SET status = 'BLOCKED', attempts = 3,
        next_attempt_at_ms = ?, error = ?, current_item = 'stale'
        WHERE id = (SELECT request_id FROM agent_data_waits WHERE job_id = ?)`)
        .run(future, `${entry.error}: ${entry.symbol}:SHARE_STATUS:2026:11012:NONE (${receipt})`, entry.symbol);
    }
    database.sqlite.exec(`INSERT INTO dart_discovery_jobs(day,from_date,to_date,page,status)
      VALUES('verify:2026-08-20','2026-08-20','2026-08-20',1,'DEFERRED'),
        ('ordinary','2026-09-23','2026-09-24',1,'DEFERRED');
      INSERT INTO dart_discovery_pages(day,from_date,page,payload_json,fetched_at_ms)
        VALUES('verify:2026-08-20','2026-08-20',1,'{}',1);`);
    pending.recover();
    queue.recover();
    const issues = database.sqlite.prepare('SELECT * FROM provider_input_issues ORDER BY id').all();
    const revision = database.sqlite.prepare('SELECT revision FROM dataset_state').get();
    pending.recover();
    queue.recover();
    expect(database.sqlite.prepare('SELECT * FROM provider_input_issues ORDER BY id').all()).toEqual(issues);
    expect(issues).toHaveLength(2);
    expect(database.sqlite.prepare('SELECT revision FROM dataset_state').get()).toEqual(revision);
    expect(database.sqlite.prepare('SELECT day FROM dart_discovery_jobs').all()).toEqual([{ day: 'ordinary' }]);
    expect(database.sqlite.prepare('SELECT * FROM dart_discovery_pages').all()).toEqual([]);
    for (const entry of cases) {
      const row = database.sqlite.prepare(`SELECT status,attempts,next_attempt_at_ms,error,current_item
        FROM agent_data_requests WHERE id = (SELECT request_id FROM agent_data_waits WHERE job_id = ?)`).get(entry.symbol);
      expect(row).toEqual({ status: entry.resume ? 'QUEUED' : 'BLOCKED', attempts: 3,
        next_attempt_at_ms: entry.resume ? 0 : future, error: entry.resume ? null : expect.any(String),
        current_item: entry.resume ? null : 'stale' });
    }
    queue.tick();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    queue.tick();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    expect(collect).toHaveBeenCalledTimes(2);
  } finally { await queue.stop(); database.close(); }
});
