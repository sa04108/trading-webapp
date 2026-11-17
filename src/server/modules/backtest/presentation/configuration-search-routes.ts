import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConfigurationSearchError, type ConfigurationSearchService } from "../application/configuration-search-service.js";
import { IntradayError } from "../../intraday/application/intraday-service.js";

type Auth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export function registerConfigurationSearchRoutes(app: FastifyInstance, service: ConfigurationSearchService, requireAuth: Auth): void {
  const auth = { preHandler: requireAuth, bodyLimit: 64 * 1024 };
  const id = (request: FastifyRequest) => z.object({ id: z.string().min(1).max(128) }).parse(request.params).id;
  const respond = async (reply: FastifyReply, action: () => unknown) => {
    reply.header("cache-control", "no-store");
    try { return await action(); }
    catch (error) {
      if (error instanceof ConfigurationSearchError || error instanceof IntradayError) return reply.code(error.statusCode).send({ error: error.message, code: error.statusCode === 409 ? "SEARCH_CONFLICT" : error.statusCode === 404 ? "SEARCH_NOT_FOUND" : "INVALID_SEARCH" });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => issue.message).join("; "), code: "INVALID_REQUEST", issues: error.issues });
      throw error;
    }
  };
  const pump = () => { void service.pump().catch((error: unknown) => app.log.error({ err: error }, "설정 탐색 작업 진행 실패")); };
  const timer = setInterval(pump, 1000); timer.unref();
  app.addHook("onReady", async () => { pump(); });
  app.addHook("preClose", async () => { clearInterval(timer); await service.stop(); });
  for (const mode of ["daily", "intraday"] as const) {
    const base = mode === "daily" ? "/backtests/:id/configuration-search" : "/intraday/runs/:id/configuration-search";
    app.get(`${base}/catalog`, auth, (request, reply) => respond(reply, () => ({ catalog: service.catalog(request.authUser!.id, mode, id(request)) })));
    app.post(`${base}/preview`, auth, (request, reply) => respond(reply, () => {
      const experiment = service.preview(request.authUser!.id, mode, id(request), request.body);
      return reply.code(201).send({ experiment });
    }));
    app.get(base, auth, (request, reply) => respond(reply, () => ({ experiments: service.list(request.authUser!.id, mode, id(request)) })));
  }
  app.get("/configuration-searches/:id", auth, (request, reply) => respond(reply, () => ({ experiment: service.get(request.authUser!.id, id(request)) })));
  app.post("/configuration-searches/:id/start", auth, (request, reply) => respond(reply, () => {
    const experiment = service.start(request.authUser!.id, id(request)); pump();
    return reply.code(202).send({ experiment });
  }));
  app.post("/configuration-searches/:id/cancel", auth, (request, reply) => respond(reply, () => {
    const experiment = service.cancel(request.authUser!.id, id(request)); pump(); return { experiment };
  }));
  app.delete("/configuration-searches/:id", auth, (request, reply) => respond(reply, () => {
    service.delete(request.authUser!.id, id(request)); return reply.code(204).send();
  }));
}
