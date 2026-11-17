import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OpenApiTokenError, type OpenApiTokenService } from "../application/openapi-token-service.js";

export function registerOpenApiTokenRoutes(app: FastifyInstance, service: OpenApiTokenService, requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>): void {
  const auth = { preHandler: requireSession, bodyLimit: 4096 };
  const respond = (reply: FastifyReply, action: () => unknown) => {
    reply.header("cache-control", "no-store");
    try { return action(); }
    catch (error) {
      if (error instanceof OpenApiTokenError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(issue => issue.message).join("; ") });
      throw error;
    }
  };
  app.get("/openapi-tokens", auth, (request, reply) => respond(reply, () => ({ tokens: service.list(request.authUser!.id) })));
  app.post("/openapi-tokens", auth, (request, reply) => respond(reply, () => reply.code(201).send(service.issue(request.authUser!, request.body))));
  app.delete("/openapi-tokens/:id", auth, (request, reply) => respond(reply, () => {
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    service.revoke(request.authUser!, id); return reply.code(204).send();
  }));
}
