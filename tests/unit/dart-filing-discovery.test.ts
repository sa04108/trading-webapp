import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { DartFilingDiscovery } from "../../src/server/modules/facts/application/dart-filing-discovery.js";

const now = () => Date.parse("2026-09-20T01:00:00Z");
describe("DART 영속 일일 공시 조회", () => {
  it("동시 tick와 재시작은 완료 페이지를 재요청하지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      const fetchPage = vi.fn(async () => ({status: "000", total_page: 1, list: [{rcept_no: "20260919000001", stock_code: "005930", report_nm: "반기보고서 (2026.06)", unused: 7}]}));
      const options = {sqlite: database.sqlite, fetchPage, now, logger: pino({level:"silent"})};
      const discovery = new DartFilingDiscovery(options);
      expect(discovery.freshness().lastCheckedAtMs).toBeNull();
      await Promise.all([discovery.tick(), discovery.tick(), new DartFilingDiscovery(options).tick()]);
      await new DartFilingDiscovery(options).tick();
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(discovery.freshness()).toEqual({lastCheckedAtMs: now(), checkedThrough:"2026-09-19", warning:null});
      const row = database.sqlite.prepare("SELECT payload_json, report_code FROM dart_discovered_filings").get() as {payload_json:string; report_code:string};
      expect(JSON.parse(row.payload_json).unused).toBe(7);
      expect(row.report_code).toBe("11012");
    } finally { database.close(); }
  });
  it("실패한 페이지부터 재개하고 완료 이전 최신성 경고를 유지한다", async () => {
    const database = openDatabase(":memory:");
    try {
      const fetchPage = vi.fn().mockResolvedValueOnce({status:"000", total_page:2,list:[]}).mockRejectedValueOnce(new Error("quota")).mockResolvedValueOnce({status:"000",total_page:2,list:[]});
      const options = {sqlite:database.sqlite,fetchPage,now,logger:pino({level:"silent"})};
      const discovery = new DartFilingDiscovery(options);
      await discovery.tick();
      expect(discovery.freshness().warning).not.toBeNull();
      await new DartFilingDiscovery(options).tick();
      expect(fetchPage.mock.calls.map(call => call[2])).toEqual([1,2,2]);
      expect(discovery.freshness().warning).toBeNull();
    } finally { database.close(); }
  });
  it("기존 watermark가 오래됐으면 초기 공백을 분할 조회하고 재시작 후 중복하지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      database.sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1)");
      const watermark = Date.parse("2026-01-01T00:00:00Z");
      database.sqlite.prepare("INSERT INTO symbol_facts_state(code,covered_years_json,financial_updated_at_ms) VALUES('005930','[2025]',?)").run(watermark);
      const fetchPage = vi.fn(async () => ({status:"013"}));
      const options = {sqlite:database.sqlite,fetchPage,now,logger:pino({level:"silent"})};
      await new DartFilingDiscovery(options).tick();
      expect(fetchPage).toHaveBeenCalledTimes(4);
      const calls = fetchPage.mock.calls as unknown as [string,string,number][];
      expect(calls[0]?.[0]).toBe("2025-12-31");
      expect(calls.at(-1)?.[1]).toBe("2026-09-19");
      for (const [from,to] of calls) expect(Date.parse(to)-Date.parse(from)).toBeLessThan(80*86_400_000);
      await new DartFilingDiscovery(options).tick();
      expect(fetchPage).toHaveBeenCalledTimes(4);
    } finally { database.close(); }
  });
  it("기준시각 없는 기존 자료는 최근 목록 조회 후에도 최신으로 표시하지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      database.sqlite.exec("INSERT INTO symbols(code,market,created_at_ms) VALUES('005930','KR',1); INSERT INTO symbol_facts_state(code,covered_years_json) VALUES('005930','[2025]')");
      const discovery = new DartFilingDiscovery({sqlite:database.sqlite,fetchPage:async()=>({status:"013"}),now,logger:pino({level:"silent"})});
      await discovery.tick();
      expect(discovery.freshness().lastCheckedAtMs).toBe(now());
      expect(discovery.freshness().warning).toContain("기준시각 미확인");
    } finally { database.close(); }
  });

  it("자정 후 재개는 원래 종료일을 유지하고 다음 작업의 겹친 경계에서 접수를 중복 저장하지 않는다", async () => {
    const database = openDatabase(":memory:");
    try {
      let current = now();
      const filing = {rcept_no:"20260919000001",stock_code:"005930",report_nm:"반기보고서 (2026.06)"};
      const fetchPage = vi.fn().mockResolvedValueOnce({status:"000",total_page:2,list:[filing]})
        .mockRejectedValueOnce(new Error("quota"))
        .mockResolvedValueOnce({status:"000",total_page:2,list:[filing]})
        .mockResolvedValueOnce({status:"000",total_page:1,list:[filing,{...filing,rcept_no:"20260920000002"}]});
      const options = {sqlite:database.sqlite,fetchPage,now:()=>current,logger:pino({level:"silent"})};
      await new DartFilingDiscovery(options).tick();
      current += 86_400_000;
      const restarted = new DartFilingDiscovery(options);
      await restarted.tick();
      expect(fetchPage.mock.calls[2]?.slice(1,3)).toEqual(["2026-09-19",2]);
      expect(restarted.freshness().warning).not.toBeNull();
      await restarted.tick();
      expect(fetchPage.mock.calls[3]?.slice(0,3)).toEqual(["2026-09-18","2026-09-20",1]);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM dart_discovered_filings").get()).toEqual({n:2});
      expect(restarted.freshness().warning).toBeNull();
    } finally { database.close(); }
  });
  it("페이지 상한을 넘으면 범위를 줄이고 모든 하위 구간 저장 뒤에만 완료한다", async () => {
    const database = openDatabase(":memory:");
    try {
      const fetchPage = vi.fn().mockResolvedValueOnce({status:"000",total_page:1001,list:[]}).mockResolvedValue({status:"013"});
      const discovery = new DartFilingDiscovery({sqlite:database.sqlite,fetchPage,now,logger:pino({level:"silent"})});
      await discovery.tick();
      expect(fetchPage).toHaveBeenCalledTimes(3);
      const calls = fetchPage.mock.calls;
      expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
      expect(Date.parse(calls[1]?.[1] as string)-Date.parse(calls[1]?.[0] as string)).toBe(39*86_400_000);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM dart_discovery_pages").get()).toEqual({n:2});
      expect(discovery.freshness().checkedThrough).toBe("2026-09-19");
    } finally { database.close(); }
  });

});
