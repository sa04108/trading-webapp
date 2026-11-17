import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { registerIntradayValidationRoutes } from "../../src/server/modules/intraday/presentation/intraday-validation-routes.js";
import { IntradayError } from "../../src/server/modules/intraday/application/intraday-service.js";
import { intradayValidations } from "../../src/server/shared/db/intraday-validation-schema.js";
import { readRuntimeVersions } from "../../src/runtime/shared/runtime-versions.js";
import { openDatabase } from "../../src/runtime/shared/db/database.js";
import { IntradayService } from "../../src/server/modules/intraday/application/intraday-service.js";
import { IntradayValidationService } from "../../src/server/modules/intraday/application/intraday-validation-service.js";
import { intradayRuns } from "../../src/server/shared/db/intraday-schema.js";
import { intradayValidationTrials } from "../../src/server/shared/db/intraday-validation-schema.js";
import { runIntradayBacktest } from "../../src/runtime/modules/intraday/domain/engine.js";
import type { IntradayRequest } from "../../src/shared/schemas/intraday.js";

const request: IntradayRequest = { mode: "intraday", strategyId: "intraday-ema", symbol: "005930", period: { from: "2026-10-01", to: "2026-10-10" }, timeframe: "1m", initialCash: 100_000, parameters: { fast: 2, slow: 5, allocationPct: 95, stopLossPct: 3, takeProfitPct: 6 }, execution: { holdingPolicy: "DAY_ONLY", commissionBps: 1, taxBps: 1, slippageBps: 1, latencyMs: 1000, orderExpiryMinutes: 3, maxParticipationPct: 10 } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture(synthetic = false, block?: Promise<void>, source = request) {
  const database = openDatabase(":memory:"); let revision = "rev1";
  const firstBarMs = Date.parse(`${source.period.from}T09:01:00+09:00`);
  const days = (Date.parse(source.period.to) - Date.parse(source.period.from)) / 86_400_000 + 1;
  const bars = Array.from({ length: days }, (_, i) => ({ endMs: firstBarMs + i * 86_400_000, open: 1000, high: 1000, low: 1000, close: 1000, volume: 100 }));
  const captured: IntradayRequest[] = [];
  const reads: { from: number; to: number }[] = [];
  const runs = new IntradayService({ db: database.db, now: () => Date.parse("2026-11-01T00:00:00Z"), store: { list: async () => [], read: async (_symbol, from, to) => { reads.push({ from, to }); return { revision, bars: bars.filter(b => b.endMs >= from && b.endMs <= to) }; }, merge: async () => { throw Error("unexpected collection"); }, prune: async () => {} }, source: null, calendar: { classify: () => ({ state: "OPEN" }) }, search: async () => [], execute: async (input) => { captured.push(input.request); if (block) await block; const result = runIntradayBacktest(input); result.executionVersion = readRuntimeVersions().executionVersion; if (synthetic) {
      const fast = input.request.strategyId === "intraday-ema" ? input.request.parameters.fast : 0;
      result.metrics.sharpe = fast;
      result.metrics.completedTrades = 1;
      const common = { orderId: "order", signalAtMs: 1, eligibleAtMs: 2, atMs: 3, price: 1000, commission: 0, tax: 0, reason: "EMA" as const };
      result.fills = [{ ...common, side: "BUY", qty: 2 }, { ...common, side: "SELL", qty: 1 }, { ...common, side: "SELL", qty: 1 }];
    } return result; } });
  database.db.insert(intradayRuns).values({ id: "source", ownerId: "owner", status: "COMPLETED", requestJson: JSON.stringify(source), createdAtMs: 1, updatedAtMs: 1 }).run();
  const validations = new IntradayValidationService(database, runs);
  cleanups.push(async () => { await validations.stop(); await runs.close(); database.close(); });
  return { database, runs, validations, captured, reads, setRevision: (value: string) => { revision = value; } };
}
async function settle(f: ReturnType<typeof fixture>, id: string) {
  for (let i = 0; i < 100; i++) { await f.validations.pump(); const e = f.validations.get("owner", id)!; if (!["ACTIVE", "CANCELLING"].includes(e.status)) return e; await new Promise(resolve => setImmediate(resolve)); }
  throw Error("experiment did not settle");
}
describe("분봉 기간 검증", () => {
  it("독립 현금으로 구간을 실행하고 소유권과 삭제 참조를 보호한다", async () => {
    const f = fixture();
    expect(() => f.validations.preview("other", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" })).toThrow();
    const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    expect(f.validations.get("other", created.id)).toBeNull();
    expect(() => f.runs.deleteRunHistory("owner", "source")).toThrow();
    const result = await settle(f, created.id);
    expect(result.status).toBe("COMPLETED");
    expect(f.captured.map(r => r.period)).toEqual([{ from: "2026-10-01", to: "2026-10-05" }, { from: "2026-10-06", to: "2026-10-10" }]);
    expect(f.captured.every(r => r.initialCash === request.initialCash)).toBe(true);
    expect(f.runs.countRuns("owner")).toBe(1);
    expect(f.validations.delete("owner", created.id)).toBe(true);
    expect(f.database.db.select().from(intradayValidationTrials).all()).toHaveLength(0);
  });
  it("부분 매도 건수를 사용하고 IS 성과만으로 OOS 후보를 선택한다", async () => {
    const f = fixture(true);
    const created = await f.validations.create("owner", "source", { mode: "OPTIMIZED_HOLDOUT", splitDate: "2026-10-06", optimization: { axes: [{ key: "fast", values: [2, 3] }], objective: "sharpe", minTrades: 2, maxDrawdownPct: 30 } });
    const result = await settle(f, created.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.trials.find(t => t.role === "OOS")?.candidate).toBe(1);
    expect(result.trials.filter(t => t.role === "TRAIN").map(t => t.metrics?.tradeCount)).toEqual([2, 2]);
    expect(result.trials.find(t => t.role === "BASELINE")?.parameters).toEqual(request.parameters);
  });
  it.each([false, true])("워크포워드에서 최적화가 켜진 경우에만 후보 조건으로 OOS를 미평가한다: %s", async (optimize) => {
    const source = { ...request, period: { from: "2026-08-01", to: "2026-10-31" } };
    const f = fixture(false, undefined, source);
    const config = { mode: "WALK_FORWARD", trainMonths: 1, testMonths: 1,
      ...(optimize ? { optimization: { axes: [{ key: "fast", values: [2, 3] }], objective: "sharpe", minTrades: 2, maxDrawdownPct: 30 } } : {}),
    };
    const created = await f.validations.create("owner", "source", config);
    const result = await settle(f, created.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.config).toEqual(config);
    expect(result.plan.folds).toHaveLength(2);
    expect(result.trials.filter(t => t.role === "TRAIN").every(t => t.metrics?.tradeCount === 0)).toBe(true);
    const oos = result.trials.filter(t => t.role === "OOS");
    expect(oos).toHaveLength(2);
    if (optimize) {
      expect(oos.every(t => t.status === "NOT_EVALUATED" && t.skipReason === "NO_ELIGIBLE_CANDIDATE" && t.metrics === null && t.jobId === null)).toBe(true);
      expect(result.trials.filter(t => t.role === "BASELINE" && t.status === "COMPLETED")).toHaveLength(2);
    } else {
      expect(result.plan.totalRuns).toBe(4);
      expect(result.trials).toHaveLength(4);
      expect(result.trials.every(t => t.status === "COMPLETED" && t.skipReason === null && t.selection === null)).toBe(true);
      expect(f.captured).toEqual([
        { ...source, period: { from: "2026-08-01", to: "2026-08-31" } },
        { ...source, period: { from: "2026-09-01", to: "2026-09-30" } },
        { ...source, period: { from: "2026-09-01", to: "2026-09-30" } },
        { ...source, period: { from: "2026-10-01", to: "2026-10-31" } },
      ]);
    }
  });
  it("하위 계산이 정리될 때까지 취소와 삭제를 보류한다", async () => {
    let release!: () => void;
    const block = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(false, block);
    const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    for (let i = 0; i < 50 && !f.captured.length; i++) { await f.validations.pump(); await new Promise(resolve => setImmediate(resolve)); }
    expect(f.captured).toHaveLength(1);
    f.validations.cancel("owner", created.id);
    await f.validations.pump();
    expect(f.validations.get("owner", created.id)?.status).toBe("CANCELLING");
    expect(() => f.validations.delete("owner", created.id)).toThrow();
    release();
    expect((await settle(f, created.id)).status).toBe("CANCELLED");
    expect(f.validations.delete("owner", created.id)).toBe(true);
  });
  it("완료 직후 취소해도 하위 성과를 한 번만 저장한다", async () => {
    const f = fixture();
    const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    let child: string | null = null;
    for (let i = 0; i < 100; i++) {
      const trial = f.database.db.select().from(intradayValidationTrials).all().find(t => t.role === "TRAIN")!;
      child = trial.runId;
      if (child && f.runs.getRunState("owner", child).status === "COMPLETED" && !f.runs.isDraining(child)) break;
      await f.validations.pump();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(child).not.toBeNull();
    expect(f.runs.getRunState("owner", child!).status).toBe("COMPLETED");
    expect(f.database.db.select().from(intradayValidationTrials).all().find(t => t.runId === child)?.metricsJson).toBeNull();
    const spy = vi.spyOn(f.runs, "getRun");
    f.validations.cancel("owner", created.id);
    const result = await settle(f, created.id);
    expect(result.status).toBe("CANCELLED");
    expect(result.trials.find(t => t.jobId === child)?.metrics).not.toBeNull();
    f.validations.get("owner", created.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("연결 후 enqueue 전 중단된 하위 실행을 같은 ID로 복구한다", async () => {
    const f = fixture();
    const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    await f.validations.stop();
    const trial = f.database.db.select().from(intradayValidationTrials).all().find(t => t.role === "TRAIN")!;
    expect(trial.runId).toBeNull();
    const childRequest = JSON.parse(trial.requestJson!) as IntradayRequest;
    f.database.sqlite.transaction(() => {
      f.runs.createInternalRun("owner", childRequest, "recovered-child");
      f.database.db.update(intradayValidationTrials).set({ runId: "recovered-child" }).where(eq(intradayValidationTrials.id, trial.id)).run();
    }).immediate();
    f.runs.recover();
    const resumed = new IntradayValidationService(f.database, f.runs);
    cleanups.unshift(async () => { await resumed.stop(); });
    const result = await settle({ ...f, validations: resumed }, created.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.trials.find(t => t.role === "TRAIN")?.jobId).toBe("recovered-child");
    expect(f.database.db.select().from(intradayRuns).all()).toHaveLength(3);
  });
  it("실행 중인 후보가 있으면 다음 후보를 enqueue하지 않고 용량 부족은 재시도한다", async () => {
    let release!: () => void;
    const block = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(true, block);
    const submit = vi.spyOn(f.runs, "createInternalRun");
    submit.mockImplementationOnce(() => { throw new IntradayError("용량 부족", 429); });
    const created = await f.validations.create("owner", "source", { mode: "OPTIMIZED_HOLDOUT", splitDate: "2026-10-06", optimization: { axes: [{ key: "fast", values: [2, 3] }], objective: "sharpe", minTrades: 1, maxDrawdownPct: 30 } });
    for (let i = 0; i < 50 && !f.captured.length; i++) { await f.validations.pump(); await new Promise(resolve => setImmediate(resolve)); }
    expect(f.captured).toHaveLength(1);
    for (let i = 0; i < 10; i++) await f.validations.pump();
    expect(f.database.db.select().from(intradayValidationTrials).all().filter(t => t.runId)).toHaveLength(1);
    expect(f.validations.get("owner", created.id)?.status).toBe("ACTIVE");
    release();
    expect((await settle(f, created.id)).status).toBe("COMPLETED");
  });
  it("중첩 검증 계보를 소유자별로 추적하고 순환을 불완전하게 표시한다", async () => {
    const f = fixture();
    const first = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    const a = await settle(f, first.id);
    const child = a.trials.find(t => t.role === "OOS")!.jobId!;
    const second = await f.validations.create("owner", child, { mode: "HOLDOUT", splitDate: "2026-10-08" });
    const b = await settle(f, second.id);
    const grandchild = b.trials.find(t => t.role === "OOS")!.jobId!;
    const app = Fastify();
    registerIntradayValidationRoutes(app, f.database, f.runs, async req => { req.authUser = { id: String(req.headers.authorization), username: "test" }; });
    cleanups.unshift(async () => { await app.close(); });
    const get = (id: string, owner = "owner") => app.inject({ method: "GET", url: `/intraday/runs/${id}/lineage`, headers: { authorization: owner } });
    const response = await get(grandchild);
    expect(response.statusCode).toBe(200);
    expect(response.json().complete).toBe(true);
    expect(response.json().items.filter((x: { label: string }) => x.label === "기간검증")).toHaveLength(2);
    expect((await get(grandchild, "other")).statusCode).toBe(404);
    f.database.db.update(intradayValidations).set({ sourceJobId: grandchild }).where(eq(intradayValidations.id, first.id)).run();
    expect((await get(grandchild)).json().complete).toBe(false);
  });
  it("완료 성과를 한 번만 읽어 캐시하고 반복 조회는 분봉 본문을 읽지 않는다", async () => {
    const f = fixture();
    const spy = vi.spyOn(f.runs, "getRun");
    const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    const result = await settle(f, created.id);
    expect(result.status).toBe("COMPLETED");
    expect(f.database.db.select().from(intradayValidationTrials).all().every(t => t.metricsJson !== null)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    const fullReads = f.reads.filter(r => r.from !== 0 || r.to !== 0).length;
    for (let i = 0; i < 5; i++) { f.validations.get("owner", created.id); f.validations.list("owner", "source"); await f.validations.pump(); }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.reads.filter(r => r.from !== 0 || r.to !== 0)).toHaveLength(fullReads);
    expect(f.reads.some(r => r.from === 0 && r.to === 0)).toBe(true);
  });
  it("고정 이후 데이터 revision이 달라지면 비교를 중단한다", async () => {
    const f = fixture(); const created = await f.validations.create("owner", "source", { mode: "HOLDOUT", splitDate: "2026-10-06" });
    f.setRevision("rev2");
    const result = await settle(f, created.id);
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("변경");
  });
});
