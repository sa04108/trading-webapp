import { describe, expect, it, vi } from "vitest";
import { createDartFactSource } from '../../src/server/modules/facts/infrastructure/dart/dart-fact-source.js';
import { pino } from "pino";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { AgentDataQueue } from "../../src/server/modules/agents/application/agent-data-queue.js";
import { ProviderRequestBlockedError } from "../../src/server/shared/provider-request-policy.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("게시 대기 수집 재시도", () => {
  it("PENDING_PUBLICATION만 deadline까지 큐에 남기고 승인 차단은 BLOCKED로 유지한다", async () => {
    const database = openDatabase(":memory:");
    const deadline = Date.now() + 60_000;
    let first = true;
    const collect = vi.fn(async () => {
      if (first) { first = false; throw new ProviderRequestBlockedError("PENDING_PUBLICATION", "raw", "receipt", deadline); }
    });
    const ready = vi.fn();
    const queue = new AgentDataQueue(database, { ensureLatest: async () => ({ version: 1 }) } as never, collect, ready, pino({ enabled: false }));
    try {
      queue.request("PREPARATION", "job", 1, { kind: "MARKET", dates: ["2026-01-05"] });
      queue.tick(); await tick(); await tick();
      expect(database.sqlite.prepare("SELECT status, attempts, next_attempt_at_ms FROM agent_data_requests").get()).toEqual({ status: "QUEUED", attempts: 0, next_attempt_at_ms: deadline });
      queue.tick(); await tick();
      expect(collect).toHaveBeenCalledTimes(1);
      vi.spyOn(Date, "now").mockReturnValue(deadline);
      queue.tick(); await tick(); await tick();
      expect(collect).toHaveBeenCalledTimes(2);
      expect(ready).toHaveBeenCalledWith("PREPARATION", "job", undefined);
      vi.restoreAllMocks();
      database.sqlite.prepare("UPDATE agent_data_requests SET status = ?, error = ?, next_attempt_at_ms = ?").run("BLOCKED", "PENDING_PUBLICATION: old", deadline);
      queue.recover();
      expect(database.sqlite.prepare("SELECT status FROM agent_data_requests").get()).toEqual({ status: "QUEUED" });
      database.sqlite.prepare("UPDATE agent_data_requests SET status = ?, error = ?").run("BLOCKED", "SOURCE_RECOVERY: raw");
      queue.recover();
      expect(database.sqlite.prepare("SELECT status FROM agent_data_requests").get()).toEqual({ status: "BLOCKED" });
    } finally { await queue.stop(); vi.restoreAllMocks(); database.close(); }
  });
});


it.each(['SAVED','NEW'] as const)('DART %s 반영 대기는 실제 endpoint 재시도 시각을 전달한다', async (kind) => {
  const now = Date.parse('2026-09-20T10:00:00Z');
  const deadline = now + 86_400_000;
  const mark = vi.fn();
  const http = vi.fn(async () => Response.json({status:'013'}));
  const source = createDartFactSource({baseUrl:'https://dart.test',apiKey:'fixture'},pino({enabled:false}),{
    clock:{now:()=>now},fetchImpl:http,sleep:async()=>{},corpCodeResolver:{resolve:async()=> '00126380'},
    pendingFilings:{get:()=>({receiptNo:'20260920000001',discoveredAtMs:now,status:'PENDING',retryAfterMs:kind==='SAVED'?deadline:null}),
      markApplied(){},markPendingPublication:mark},
  });
  await expect(source.fetchFinancials({symbols:['005930'],years:[2025],shareYears:[2025],consolidated:true})).rejects.toMatchObject({reason:'PENDING_PUBLICATION',retryAfterMs:deadline});
  expect(http).toHaveBeenCalledTimes(kind==='SAVED'?0:1);
  if(kind==='NEW') expect(mark).toHaveBeenCalledWith(expect.objectContaining({symbol:'005930',businessYear:2025}),'20260920000001',deadline);
});
