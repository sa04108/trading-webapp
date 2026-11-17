import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { configurationSearches, configurationSearchItems } from "../../../shared/db/configuration-search-schema.js";
import { searchCounts } from "../../backtest/presentation/backtest-experiment-routes.js";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import type { BacktestHistoryExtras, BacktestLineage } from "../../../../shared/schemas/backtest-experiments.js";
import { intradayValidationTrials, intradayValidations } from "../../../shared/db/intraday-validation-schema.js";
import { IntradayError, type IntradayService } from "../application/intraday-service.js";
import { IntradayValidationService } from "../application/intraday-validation-service.js";

export function registerIntradayValidationRoutes(app: FastifyInstance, database: DatabaseHandle, runs: IntradayService, requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  const service = new IntradayValidationService(database, runs), auth = { preHandler: requireAuth };
  const pump = () => { void service.pump().catch(e => app.log.error({ err: e }, "분봉 검증 진행 실패")); };
  const timer = setInterval(pump, 1000); timer.unref();
  app.addHook("onReady", async () => { pump(); });
  app.addHook("preClose", async () => { clearInterval(timer); await service.stop(); });
  const respond = async (reply: FastifyReply, action: () => unknown) => { try { return await action(); } catch (error) { return reply.code(error instanceof IntradayError ? error.statusCode : 400).send({ error: error instanceof Error ? error.message : String(error) }); } };
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  app.post("/intraday/runs/:id/validations/preview", auth, async (request, reply) => respond(reply, () => ({ plan: service.preview(request.authUser!.id, id(request), request.body).plan })));
  app.get("/intraday/runs/:id/validations", auth, async (request, reply) => respond(reply, () => ({ experiments: service.list(request.authUser!.id, id(request)) })));
  app.post("/intraday/runs/:id/validations", auth, async (request, reply) => respond(reply, async () => { const experiment = await service.create(request.authUser!.id, id(request), request.body); reply.code(201); return { experiment }; }));
  app.get("/intraday/validations/:id", auth, async (request, reply) => respond(reply, () => { const experiment = service.get(request.authUser!.id, id(request)); if (!experiment) throw new IntradayError("검증 실험을 찾을 수 없습니다.", 404); return { experiment }; }));
  app.get("/intraday/validations/:id/trials/:trialId/daily", auth, async (request, reply) => respond(reply, () => ({ report: service.dailyReport(request.authUser!.id, id(request), (request.params as { trialId: string }).trialId) })));
  app.post("/intraday/validations/:id/cancel", auth, async (request, reply) => respond(reply, () => { const experiment = service.cancel(request.authUser!.id, id(request)); if (!experiment) throw new IntradayError("검증 실험을 찾을 수 없습니다.", 404); return { experiment }; }));
  app.delete("/intraday/validations/:id", auth, async (request, reply) => respond(reply, () => { if (!service.delete(request.authUser!.id, id(request))) throw new IntradayError("검증 실험을 찾을 수 없습니다.", 404); return reply.code(204).send(); }));
  app.post("/intraday/runs/:id/clone", auth, async (request, reply) => respond(reply, () => { const source = runs.getRun(request.authUser!.id, id(request)); if (!["COMPLETED", "FAILED", "CANCELLED"].includes(source.status)) throw new IntradayError("종료된 결과만 복제할 수 있습니다."); const run = runs.submit(request.authUser!.id, source.request); reply.code(202); return run; }));
  app.get("/intraday/runs/:id/export", auth, async (request, reply) => respond(reply, () => { const run = runs.getRun(request.authUser!.id, id(request)); if (run.status !== "COMPLETED" || !run.result) throw new IntradayError("완료된 결과만 내보낼 수 있습니다."); reply.header("content-disposition", `attachment; filename="intraday-${run.id}.json"`); return run; }));
  app.get("/intraday/runs/:id/lineage", auth, async (request, reply) => respond(reply, () => {
    const owner = request.authUser!.id, runId = id(request); runs.getRunState(owner, runId);
    const visited = new Set<string>(); let complete = true, kind: BacktestLineage["kind"] = "original", roleLabel = "결과";
    const walk = (current: string): BacktestLineage["items"] => {
      if (visited.has(current) || visited.size >= 32) { complete = false; return [{ label: "상위 경로 확인 불가", description: current }]; }
      visited.add(current);
      try { runs.getRunState(owner, current); } catch { complete = false; return [{ label: "삭제된 상위 백테스트", description: current }]; }
      const own = { label: `결과 ${current.slice(-6)}`, href: `/backtests/intraday/${encodeURIComponent(current)}`, description: current };
      const search = database.db.select({ parent: configurationSearches.sourceJobId, id: configurationSearches.id, ordinal: configurationSearchItems.ordinal }).from(configurationSearchItems)
        .innerJoin(configurationSearches, eq(configurationSearchItems.searchId, configurationSearches.id))
        .where(and(eq(configurationSearchItems.jobId, current), eq(configurationSearches.mode, "intraday"), eq(configurationSearches.ownerId, owner))).get();
      if (search) {
        const label = `조합 ${search.ordinal + 1}`;
        if (current === runId) { kind = "search"; roleLabel = label; }
        return [...walk(search.parent), { label: "설정 탐색 실험", href: `/backtests/intraday/${encodeURIComponent(search.parent)}/search` },
          { label: `실험 ${search.id.slice(-6)}`, href: `/backtests/searches/${encodeURIComponent(search.id)}` }, { ...own, label }];
      }
      const trial = database.db.select({ parent: intradayValidations.sourceJobId, owner: intradayValidations.ownerId, experiment: intradayValidationTrials.validationId, fold: intradayValidationTrials.fold, role: intradayValidationTrials.role, candidate: intradayValidationTrials.candidate }).from(intradayValidationTrials).leftJoin(intradayValidations, eq(intradayValidationTrials.validationId, intradayValidations.id)).where(eq(intradayValidationTrials.runId, current)).get();
      if (!trial) return [own];
      if (!trial.parent || trial.owner !== owner) { complete = false; if (current === runId) { kind = "unknown"; roleLabel = "경로 확인 필요"; } return [{ label: "상위 경로 확인 불가" }, own]; }
      const role = `${trial.fold + 1}회차 · ${trial.role === "TRAIN" ? "IS 학습" : trial.role === "BASELINE" ? "OOS 기준 전략" : "OOS 검증"}${trial.candidate !== null ? ` · 후보 ${trial.candidate + 1}` : ""}`;
      if (current === runId) { kind = "validation"; roleLabel = role; }
      return [...walk(trial.parent), { label: "기간검증", href: `/backtests/intraday/${encodeURIComponent(trial.parent)}/validations` }, { label: `검증 ${trial.experiment.slice(-6)}`, href: `/backtests/intraday/validations/${encodeURIComponent(trial.experiment)}` }, { ...own, label: role }];
    };
    const items = [{ label: "백테스트", href: "/backtests" }, ...walk(runId)];
    const lineage: BacktestLineage = { kind, roleLabel, complete, items };
    return lineage;
  }));
  app.get("/intraday/experiments/summary", auth, async (request, reply) => respond(reply, () => {
    const raw = (request.query as { jobIds?: string }).jobIds; if (!raw || raw.length > 13000) throw new IntradayError("잘못된 작업 ID입니다.", 400);
    const ids = [...new Set(raw.split(","))]; if (ids.length > 100 || ids.some(x => !x || x.length > 128)) throw new IntradayError("잘못된 작업 ID입니다.", 400);
    const distribution = (v: number[]) => { const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; return { count: v.length, mean, sampleStdDev: v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean!) ** 2, 0) / (v.length - 1)) : null }; };
    const searches = searchCounts(database, "intraday", ids, request.authUser!.id);
    const summaries: BacktestHistoryExtras[] = ids.map(jobId => {
      const experiments = service.list(request.authUser!.id, jobId), modes = { HOLDOUT: 0, WALK_FORWARD: 0 };
      const samples: number[] = []; for (const e of experiments) { modes[e.config.mode]++; if (e.status !== "COMPLETED") continue; const oos = e.trials.filter(t => t.role === "OOS"); if (oos.length && oos.every(t => t.status === "COMPLETED" && t.metrics && t.metrics.intradayDaily?.isComplete !== false && Number.isFinite(t.metrics.totalReturnPct))) samples.push(oos.reduce((sum, t) => sum + t.metrics!.totalReturnPct / oos.length, 0)); }
      return { jobId, search: searches(jobId), seed: { batchCount: 0, activeCount: 0, completedCount: 0, returns: distribution([]) }, validation: { experimentCount: experiments.length, activeCount: experiments.filter(e => e.status === "ACTIVE" || e.status === "CANCELLING").length, completedCount: experiments.filter(e => e.status === "COMPLETED").length, returns: distribution(samples), modes } };
    }); return { summaries };
  }));
  return service;
}
