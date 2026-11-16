import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IntradayValidationService } from "../../intraday/application/intraday-validation-service.js";
import type { Container } from "../../../bootstrap/container.js";
import type { PeriodValidationService } from "../../backtest/application/period-validation-service.js";
import type { BacktestRefreshService } from "../../backtest/application/backtest-refresh-service.js";
import { JobCenterError, JobCenterService } from "../application/job-center-service.js";
import { BackgroundJobHistory } from "../application/background-job-history.js";

const querySchema = z.object({
  status: z.enum(["all", "active", "finished"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const idsSchema = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(100) });

export function registerJobCenterRoutes(
  app: FastifyInstance,
  container: Container,
  validations: PeriodValidationService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  refreshJobs: BacktestRefreshService,
  intradayValidations?: IntradayValidationService,
): void {
  const history = new BackgroundJobHistory(container.database, container.clock, container.logger,
    [container.symbolMasterBackfill, container.benchmarkService], (job) => {
      try {
        container.notificationService.create({
          type: "data-sync", severity: "error", title: `${job.title} 작업이 중단되었습니다`,
          body: `${job.error ?? "서버 종료로 수집이 중단되었습니다."} 원본 화면에서 다시 시작하세요.`,
          link: job.link ?? "/jobs",
        });
      } catch (error) {
        container.logger.warn({ err: error, jobId: job.id }, "수집 작업 중단 알림 생성 실패");
      }
    });
  app.addHook("onClose", async () => { await history.close(); });
  const service = new JobCenterService(container, validations, refreshJobs, intradayValidations);
  const handle = (request: FastifyRequest, reply: FastifyReply, action: () => unknown): unknown => {
    // 사용자별 이력과 작업 소유권이 섞인 응답은 공유 캐시에 저장하지 않는다.
    reply.header("cache-control", "no-store");
    try { return action(); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "요청 형식이 올바르지 않습니다." });
      if (error instanceof JobCenterError) return reply.code(error.statusCode).send({ error: error.message });
      request.log.error({ err: error }, "작업 이력 요청 실패");
      throw error;
    }
  };
  app.get("/jobs", { preHandler: requireAuth }, (request, reply) => handle(request, reply, () => {
    const query = querySchema.parse(request.query);
    return service.list(request.authUser!.id, query.status, query.limit, query.offset);
  }));
  app.get("/jobs/:id", { preHandler: requireAuth }, (request, reply) => handle(request, reply, () => ({
    job: service.get(request.authUser!.id, (request.params as { id: string }).id),
  })));
  app.post("/jobs/:id/cancel", { preHandler: requireAuth }, (request, reply) => handle(request, reply, () => ({
    job: service.cancel(request.authUser!.id, request.authUser!.username, (request.params as { id: string }).id),
  })));
  app.delete("/jobs", { preHandler: requireAuth }, (request, reply) => handle(request, reply, () => {
    const { ids } = idsSchema.parse(request.body);
    service.remove(request.authUser!.id, request.authUser!.username, [...new Set(ids)]);
    return reply.code(204).send();
  }));
}
