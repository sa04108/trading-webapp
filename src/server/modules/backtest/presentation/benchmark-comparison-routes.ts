import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { benchmarkSelectionSchema } from "../../../../shared/schemas/benchmark.js";
import type { BenchmarkComparisonService } from "../application/benchmark-comparison-service.js";
import type { JobQueue } from "../application/job-queue.js";

export function registerBenchmarkComparisonRoutes(
  app: FastifyInstance, comparisons: BenchmarkComparisonService, queue: JobQueue,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  function completed(id: string, reply: FastifyReply): boolean {
    const job = queue.getJob(id);
    if (!job) { reply.code(404).send({ error: "작업을 찾을 수 없습니다" }); return false; }
    if (job.status !== "COMPLETED") { reply.code(409).send({ error: "완료된 백테스트에서 비교할 수 있습니다." }); return false; }
    return true;
  }
  app.get<{ Params: { id: string } }>("/backtests/:id/benchmarks", { preHandler: requireAuth }, async (request, reply) => {
    if (!completed(request.params.id, reply)) return reply;
    return comparisons.get(request.authUser!.id, request.params.id);
  });
  app.patch<{ Params: { id: string } }>("/backtests/:id/benchmarks", { preHandler: requireAuth }, async (request, reply) => {
    if (!completed(request.params.id, reply)) return reply;
    const parsed = benchmarkSelectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "올바른 벤치마크 목록이 필요합니다." });
    comparisons.save(request.authUser!.id, request.params.id, parsed.data.benchmarkIds);
    return parsed.data;
  });
}
