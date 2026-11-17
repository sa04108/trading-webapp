import { createHash } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { registerRiskFreeRateRoutes } from "../../src/server/modules/market-data/presentation/risk-free-rate-routes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../../src/runtime/shared/db/database.js";
import { datasetIdentity } from "../../src/runtime/shared/db/database-layout.js";
import { RiskFreeRateService } from "../../src/server/modules/market-data/application/risk-free-rate-service.js";

const databaseHandles: DatabaseHandle[] = [];
function database() {
  const handle = openDatabase(":memory:");
  databaseHandles.push(handle);
  return handle;
}
afterEach(() => { for (const handle of databaseHandles.splice(0)) handle.close(); });

// 초기화와 동기화는 빈 DB나 HTTP 클라이언트 검사만으로 과거 금리 손실을 검출할 수 없다.
describe("금리 이력 저장과 갱신", () => {
  it("초기 DB에 제공 이력과 내용 해시를 보존한다", () => {
    const handle = database();
    const service = new RiskFreeRateService({ db: handle.db, source: null, now: Date.now });
    const history = service.history();
    expect(history).toMatchObject({ series: "KRW_MSB_91D", coveredFrom: "2010-01-01", coveredTo: "2026-11-17", source: "USER_CSV", sourceSha256: "351d9e23e4ea06fce7099e661c1573d15dd40e2188f9a293a9213f0e6c55d51d", version: "2cc8625245723b2d605b14a25ded3dc54bc98f4b1190b96eb8a8e2360fea6e18" });
    expect(history.changes).toHaveLength(2092);
    const { version, ...payload } = history;
    expect(createHash("sha256").update(JSON.stringify(payload)).digest("hex")).toBe(version);
  });

  it("기존 이력을 보존하고 중복 금리는 압축하며 새 금리의 정밀도를 유지한다", async () => {
    const handle = database();
    let now = Date.parse("2026-11-21T10:00:00Z");
    const fetchDailyRates = vi.fn().mockResolvedValue([
      { date: "2026-11-17", annualRatePct: 99 },
      { date: "2026-11-18", annualRatePct: 3.21 },
      { date: "2026-11-19", annualRatePct: 3.217 },
      { date: "2026-11-20", annualRatePct: 3.217 },
    ]);
    const service = new RiskFreeRateService({ db: handle.db, source: { fetchDailyRates }, now: () => now });
    const before = service.history();
    const revision = datasetIdentity(handle.sqlite).revision;
    await service.sync();
    const after = service.history();
    expect(fetchDailyRates).toHaveBeenCalledWith(expect.objectContaining({ statCode: "817Y002", itemCode: "010400000", startDate: "2026-11-10", endDate: "2026-11-20" }));
    expect(after.changes).toEqual([...before.changes, { date: "2026-11-19", annualRatePct: 3.217 }]);
    expect(after).toMatchObject({ coveredTo: "2026-11-20", source: "USER_CSV_AND_ECOS" });
    expect(after.version).not.toBe(before.version);
    expect(datasetIdentity(handle.sqlite).revision).toBe(revision + 1);
    now = Date.parse("2026-11-22T10:00:00Z");
    await service.sync();
    expect(fetchDailyRates).toHaveBeenCalledTimes(2);
    expect(service.history()).toEqual(after);
    expect(datasetIdentity(handle.sqlite).revision).toBe(revision + 1);
  });

  it("수집 실패와 불완전한 응답 실패 시 기록과 revision을 유지한다", async () => {
    const handle = database();
    const fetchDailyRates = vi.fn().mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("incomplete response"));
    const service = new RiskFreeRateService({ db: handle.db, source: { fetchDailyRates }, now: () => Date.parse("2026-11-21T10:00:00Z") });
    const before = service.history();
    const revision = datasetIdentity(handle.sqlite).revision;
    for (let i = 0; i < 2; i++) {
      await expect(service.sync()).rejects.toThrow();
      expect(service.history()).toEqual(before);
      expect(datasetIdentity(handle.sqlite).revision).toBe(revision);
    }
  });

  it("중간 영업일의 관측이 누락되면 전체 갱신을 거절한다", async () => {
    const handle = database();
    const source = { fetchDailyRates: vi.fn().mockResolvedValue([
      { date: "2026-11-18", annualRatePct: 3.21 },
      { date: "2026-11-20", annualRatePct: 3.22 },
    ]) };
    const service = new RiskFreeRateService({ db: handle.db, source, now: () => Date.parse("2026-11-21T10:00:00Z") });
    const before = service.history();
    const revision = datasetIdentity(handle.sqlite).revision;
    await expect(service.sync()).rejects.toThrow("2026-11-19");
    expect(service.status().error).toContain("2026-11-19");
    expect(service.history()).toEqual(before);
    expect(datasetIdentity(handle.sqlite).revision).toBe(revision);
  });

  it("동시 동기화를 합치고 종료 시 진행 중 요청을 중단한다", async () => {
    const handle = database();
    const fetchDailyRates = vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = new RiskFreeRateService({ db: handle.db, source: { fetchDailyRates }, now: () => Date.parse("2026-11-21T10:00:00Z") });
    const before = service.history();
    const revision = datasetIdentity(handle.sqlite).revision;
    const first = service.sync();
    const second = service.sync();
    expect(first).toBe(second);
    expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    const firstRejected = expect(first).rejects.toThrow("aborted");
    await service.close();
    await firstRejected;
    expect(service.history()).toEqual(before);
    expect(datasetIdentity(handle.sqlite).revision).toBe(revision);
    await expect(service.sync()).rejects.toThrow();
  });

  it("한국시간 18시 이후 실패를 한 시간 뒤 재시도하고 성공한 날 재실행하지 않는다", async () => {
    const handle = database();
    let now = Date.parse("2026-11-21T08:59:00Z");
    const fetchDailyRates = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue([{ date: "2026-11-17", annualRatePct: 3.21 }]);
    const onError = vi.fn();
    const service = new RiskFreeRateService({ db: handle.db, source: { fetchDailyRates }, now: () => now, onError });
    await service.tick();
    expect(fetchDailyRates).not.toHaveBeenCalled();
    now = Date.parse("2026-11-21T09:00:00Z");
    await service.tick();
    expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    now = Date.parse("2026-11-21T09:59:59Z");
    await service.tick();
    expect(fetchDailyRates).toHaveBeenCalledTimes(1);
    now = Date.parse("2026-11-21T10:00:00Z");
    await service.tick();
    expect(fetchDailyRates).toHaveBeenCalledTimes(2);
    now = Date.parse("2026-11-21T12:00:00Z");
    await service.tick();
    expect(fetchDailyRates).toHaveBeenCalledTimes(2);
  });
});

// 경로 테스트는 인증 누락이나 미설정 상태의 잘못된 성공 응답을 잡는다.
it("금리 API는 인증을 요구하고 설정 여부에 맞는 동기화 상태를 반환한다", async () => {
  const handle = database();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.authorization !== "Bearer test") await reply.code(401).send();
  };
  const unconfigured = Fastify();
  registerRiskFreeRateRoutes(unconfigured, new RiskFreeRateService({ db: handle.db, source: null, now: Date.now }), authorize);
  try {
    expect((await unconfigured.inject({ method: "GET", url: "/market-data/risk-free-rate" })).statusCode).toBe(401);
    expect((await unconfigured.inject({ method: "POST", url: "/market-data/risk-free-rate/sync" })).statusCode).toBe(401);
    const headers = { authorization: "Bearer test" };
    expect((await unconfigured.inject({ method: "GET", url: "/market-data/risk-free-rate", headers })).json()).toMatchObject({ configured: false, series: "KRW_MSB_91D" });
    expect((await unconfigured.inject({ method: "POST", url: "/market-data/risk-free-rate/sync", headers })).statusCode).toBe(503);
  } finally { await unconfigured.close(); }

  const configured = Fastify();
  const service = new RiskFreeRateService({ db: handle.db, source: { fetchDailyRates: vi.fn().mockResolvedValue([]) }, now: () => Date.parse("2026-11-17T10:00:00Z") });
  registerRiskFreeRateRoutes(configured, service, authorize);
  try {
    const headers = { authorization: "Bearer test" };
    const result = await configured.inject({ method: "POST", url: "/market-data/risk-free-rate/sync", headers });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({ configured: true, series: "KRW_MSB_91D" });
    expect((await configured.inject({ method: "GET", url: "/market-data/risk-free-rate", headers })).json()).toMatchObject({ configured: true, coveredTo: "2026-11-17", changeCount: 2092 });
  } finally { await service.close(); await configured.close(); }
});
