import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RiskFreeRateService } from "../application/risk-free-rate-service.js";

export function registerRiskFreeRateRoutes(
  app: FastifyInstance,
  service: RiskFreeRateService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/market-data/risk-free-rate", { preHandler: requireAuth }, async () => service.status());
  app.post("/market-data/risk-free-rate/sync", { preHandler: requireAuth }, async (_request, reply) => {
    if (!service.status().configured) return reply.code(503).send({ error: "ECOS_API_KEY가 설정되지 않았습니다" });
    void service.sync().catch(() => {});
    return reply.code(202).send(service.status());
  });
}
