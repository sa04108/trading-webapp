import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { backtestRefreshActionSchema } from "../../../../shared/schemas/backtest-refresh.js";
import { BacktestRefreshError, type BacktestRefreshService } from "../application/backtest-refresh-service.js";

export function registerBacktestRefreshRoutes(app: FastifyInstance, service: BacktestRefreshService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>): void {
  const pump = () => { void service.pump().catch((error: unknown) => app.log.error({ err: error }, "데이터 업데이트 후 자동 실행 실패")); };
  const timer = setInterval(pump, 1_000);
  timer.unref();
  app.addHook("onReady", async () => { pump(); });
  app.addHook("onClose", async () => { clearInterval(timer); await service.stop(); });
  const handle = (reply: FastifyReply, action: () => unknown): unknown => {
    reply.header("cache-control", "no-store");
    try { return action(); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "업데이트 후 실행할 작업의 설정이 올바르지 않습니다." });
      if (error instanceof BacktestRefreshError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  };
  app.post("/backtests/:id/refresh-and-run", { preHandler: requireAuth }, (request, reply) => handle(reply, () => {
    const body = z.object({ requestId: z.string().uuid(), action: backtestRefreshActionSchema }).parse(request.body);
    const job = service.create(request.authUser!.id, body.requestId, (request.params as { id: string }).id, body.action);
    pump();
    return reply.code(202).send({ job });
  }));
  app.get("/backtests/refresh-jobs/:id", { preHandler: requireAuth }, (request, reply) => handle(reply, () => ({
    job: service.get(request.authUser!.id, (request.params as { id: string }).id),
  })));
  app.post("/backtests/refresh-jobs/:id/cancel", { preHandler: requireAuth }, (request, reply) => handle(reply, () => ({
    job: service.cancel(request.authUser!.id, (request.params as { id: string }).id),
  })));
  app.post("/backtests/refresh-jobs/:id/retry", { preHandler: requireAuth }, (request, reply) => handle(reply, () => {
    const job = service.retry(request.authUser!.id, (request.params as { id: string }).id);
    pump();
    return reply.code(202).send({ job });
  }));
}
