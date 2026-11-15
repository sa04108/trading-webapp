import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "../../../../runtime/shared/db/database.js";
import { backtestJobs } from "../../../../runtime/shared/db/operations-schema.js";
import { backtestMetrics } from "../../../shared/db/backtest-result-schema.js";
import { backtestCloneBatches, backtestCloneBatchItems } from "../../../shared/db/backtest-batch-schema.js";
import { backtestValidations, backtestValidationTrials } from "../../../shared/db/backtest-validation-schema.js";
import { benchmarkPinSchema } from "../../../../shared/schemas/benchmark.js";
import type { BacktestBreadcrumbEntry, BacktestHistoryExtras, BacktestLineage, ExperimentReturnDistribution } from "../../../../shared/schemas/backtest-experiments.js";

const modes = { HOLDOUT: "홀드아웃", OPTIMIZED_HOLDOUT: "최적화 홀드아웃", WALK_FORWARD: "워크포워드" } as const;
function modeOf(json: string): keyof typeof modes | null {
  try {
    const mode: unknown = (JSON.parse(json) as { mode?: unknown }).mode;
    return typeof mode === "string" && Object.hasOwn(modes, mode) ? mode as keyof typeof modes : null;
  } catch { return null; }
}
function distribution(values: number[]): ExperimentReturnDistribution {
  const count = values.length;
  const mean = count ? values.reduce((sum, value) => sum + value / count, 0) : null;
  const variance = count > 1 ? values.reduce((sum, value) => sum + (value - mean!) ** 2 / (count - 1), 0) : null;
  return { count, mean: mean !== null && Number.isFinite(mean) ? mean : null,
    sampleStdDev: variance !== null && Number.isFinite(variance) ? Math.sqrt(variance) : null };
}
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** 목록에 보이는 원본의 스칼라 지표만 일괄 조회한다. 실험 결과 본문과 매매 시계열은 읽지 않는다. */
export function historyExtras(database: DatabaseHandle, ids: string[]): BacktestHistoryExtras[] {
  const db = database.db;
  const jobs = db.select({ id: backtestJobs.id, status: backtestJobs.status, benchmark: backtestJobs.benchmarkJson, returns: backtestMetrics.totalReturnPct })
    .from(backtestJobs).leftJoin(backtestMetrics, eq(backtestMetrics.jobId, backtestJobs.id)).where(inArray(backtestJobs.id, ids)).all();
  const batches = db.select({ id: backtestCloneBatches.id, source: backtestCloneBatches.sourceJobId, status: backtestCloneBatches.status })
    .from(backtestCloneBatches).where(inArray(backtestCloneBatches.sourceJobId, ids)).all();
  const seedRuns = db.select({ source: backtestCloneBatches.sourceJobId, status: backtestJobs.status, returns: backtestMetrics.totalReturnPct })
    .from(backtestCloneBatchItems).innerJoin(backtestCloneBatches, eq(backtestCloneBatchItems.batchId, backtestCloneBatches.id))
    .innerJoin(backtestJobs, eq(backtestCloneBatchItems.jobId, backtestJobs.id))
    .leftJoin(backtestMetrics, eq(backtestMetrics.jobId, backtestJobs.id)).where(inArray(backtestCloneBatches.sourceJobId, ids)).all();
  const experiments = db.select({ id: backtestValidations.id, source: backtestValidations.sourceJobId, status: backtestValidations.status, config: backtestValidations.configJson })
    .from(backtestValidations).where(inArray(backtestValidations.sourceJobId, ids)).all();
  const oos = db.select({ experiment: backtestValidations.id, status: backtestJobs.status, returns: backtestMetrics.totalReturnPct })
    .from(backtestValidationTrials).innerJoin(backtestValidations, eq(backtestValidationTrials.validationId, backtestValidations.id))
    .leftJoin(backtestJobs, eq(backtestValidationTrials.jobId, backtestJobs.id))
    .leftJoin(backtestMetrics, eq(backtestMetrics.jobId, backtestJobs.id))
    .where(and(inArray(backtestValidations.sourceJobId, ids), eq(backtestValidationTrials.role, "OOS"))).all();
  return jobs.map((job) => {
    let benchmarkExcessReturnPct: number | null = null;
    if (job.status === "COMPLETED" && finite(job.returns) && job.benchmark) {
      try {
        const pin = benchmarkPinSchema.safeParse(JSON.parse(job.benchmark));
        if (pin.success && pin.data.covered && pin.data.points.length >= 2) {
          const excess = job.returns - (pin.data.points.at(-1)!.close / pin.data.points[0]!.close - 1) * 100;
          if (Number.isFinite(excess)) benchmarkExcessReturnPct = excess;
        }
      } catch { /* 손상된 벤치마크를 0%로 추정하지 않는다. */ }
    }
    const ownBatches = batches.filter((b) => b.source === job.id);
    const completeSeeds = seedRuns.filter((run) => run.source === job.id && run.status === "COMPLETED");
    const ownExperiments = experiments.filter((e) => e.source === job.id);
    const samples = ownExperiments.filter((e) => e.status === "COMPLETED").flatMap((e) => {
      const trials = oos.filter((trial) => trial.experiment === e.id);
      // 완료된 실험에서도 OOS 기록이 누락되면 일부 회차로 평균을 추정하지 않는다.
      if (!trials.length || trials.some((t) => t.status !== "COMPLETED" || !finite(t.returns))) return [];
      const mean = trials.reduce((sum, t) => sum + t.returns! / trials.length, 0);
      return Number.isFinite(mean) ? [mean] : [];
    });
    const modeCounts = { HOLDOUT: 0, OPTIMIZED_HOLDOUT: 0, WALK_FORWARD: 0 };
    for (const experiment of ownExperiments) {
      const mode = modeOf(experiment.config);
      if (mode) modeCounts[mode]++;
    }
    return { jobId: job.id, benchmarkExcessReturnPct,
      seed: { batchCount: ownBatches.length, activeCount: ownBatches.filter((b) => b.status === "ACTIVE" || b.status === "CANCELLING").length,
        completedCount: completeSeeds.length, returns: distribution(completeSeeds.map((r) => r.returns).filter(finite)) },
      validation: { experimentCount: ownExperiments.length, activeCount: ownExperiments.filter((e) => ["ACTIVE", "CANCELLING"].includes(e.status)).length,
        completedCount: ownExperiments.filter((e) => e.status === "COMPLETED").length, returns: distribution(samples), modes: modeCounts } };
  });
}

/** 방문 이력 대신 저장된 작업 관계를 따라가므로 직접 링크도 동일한 경로를 보여준다. */
export function backtestLineage(database: DatabaseHandle, id: string): BacktestLineage | null {
  const db = database.db;
  const jobById = (jobId: string) => db.select({ id: backtestJobs.id, source: backtestJobs.cloneSourceJobId, batch: backtestJobs.cloneBatchId })
    .from(backtestJobs).where(eq(backtestJobs.id, jobId)).get();
  if (!jobById(id)) return null;
  const visited = new Set<string>();
  let complete = true;
  let kind: BacktestLineage["kind"] = "original";
  let roleLabel = "직접 실행";
  const walk = (jobId: string): BacktestBreadcrumbEntry[] => {
    if (visited.has(jobId) || visited.size >= 32) {
      complete = false;
      return [{ label: "상위 경로 확인 불가" }];
    }
    visited.add(jobId);
    const job = jobById(jobId);
    if (!job) {
      complete = false;
      return [{ label: "삭제된 상위 백테스트", description: jobId }];
    }
    const own: BacktestBreadcrumbEntry = { label: `결과 ${jobId.slice(-6)}`, href: `/backtests/${encodeURIComponent(jobId)}`, description: jobId };
    const trial = db.select({ parent: backtestValidations.sourceJobId, experiment: backtestValidations.id, config: backtestValidations.configJson,
      role: backtestValidationTrials.role, fold: backtestValidationTrials.fold, candidate: backtestValidationTrials.candidate })
      .from(backtestValidationTrials).innerJoin(backtestValidations, eq(backtestValidationTrials.validationId, backtestValidations.id))
      .where(eq(backtestValidationTrials.jobId, jobId)).get();
    if (trial) {
      const mode = modeOf(trial.config);
      const role = trial.role === "TRAIN" ? "IS 학습" : trial.role === "BASELINE" ? "OOS 기준 전략" : trial.role === "OOS" ? "OOS 검증" : trial.role;
      const label = `${trial.fold + 1}회차 · ${role}${trial.candidate !== null ? ` · 후보 ${trial.candidate + 1}` : ""}`;
      if (jobId === id) { kind = "validation"; roleLabel = label; }
      return [...walk(trial.parent), { label: "기간검증", href: `/backtests/${encodeURIComponent(trial.parent)}/validations` },
        { label: `${mode ? modes[mode] : "기간검증"} ${trial.experiment.slice(-6)}`, href: `/backtests/validations/${encodeURIComponent(trial.experiment)}` }, { ...own, label }];
    }
    if (job.batch) {
      const batch = db.select({ source: backtestCloneBatches.sourceJobId }).from(backtestCloneBatches).where(eq(backtestCloneBatches.id, job.batch)).get();
      const item = db.select({ seed: backtestCloneBatchItems.randomSeed }).from(backtestCloneBatchItems).where(eq(backtestCloneBatchItems.jobId, jobId)).get();
      if (jobId === id) { kind = "seed"; roleLabel = item ? `난수 시드 ${item.seed}` : "난수 실험 결과"; }
      const source = batch?.source ?? job.source;
      if (!batch || !source) complete = false;
      return [...(source ? walk(source) : [{ label: "삭제된 상위 백테스트" }]),
        ...(source ? [{ label: "난수 시드 실험", href: `/backtests/${encodeURIComponent(source)}/seeds` }] : []),
        { label: `실험 ${job.batch.slice(-6)}`, ...(batch ? { href: `/backtests/batches/${encodeURIComponent(job.batch)}` } : {}) },
        { ...own, label: item ? `시드 ${item.seed}` : own.label }];
    }
    if (job.source) {
      if (jobId === id) { kind = "clone"; roleLabel = "복제 실행"; }
      return [...walk(job.source), { ...own, label: `복제 ${jobId.slice(-6)}` }];
    }
    return [{ ...own, label: `직접 실행 ${jobId.slice(-6)}` }];
  };
  const items = [{ label: "백테스트", href: "/backtests" }, ...walk(id)];
  if (!complete && kind === "original") { kind = "unknown"; roleLabel = "경로 확인 필요"; }
  return { items, kind, roleLabel, complete };
}

export function registerBacktestExperimentRoutes(app: FastifyInstance, database: DatabaseHandle,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  app.get("/backtests/history-extras", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ jobIds: z.string().min(1).max(13_000).transform((value) => value.split(",")).pipe(z.array(z.string().min(1).max(128)).max(100)) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_JOB_IDS" });
    return { summaries: historyExtras(database, [...new Set(parsed.data.jobIds)]) };
  });
  app.get<{ Params: { id: string } }>("/backtests/:id/lineage", { preHandler: requireAuth }, async (request, reply) => {
    const lineage = backtestLineage(database, request.params.id);
    return lineage ?? reply.code(404).send({ error: "NOT_FOUND" });
  });
}
