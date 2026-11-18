import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { tradingRevisionSchema, tradingWriteSchema } from "../../../../shared/schemas/trading.js";
import { TradingError, type TradingService } from "../application/trading-service.js";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const activationSchema = tradingRevisionSchema.extend({ acknowledged: z.literal(true) });
const versionSchema = tradingRevisionSchema.extend({ artifactHash: z.string().regex(/^[a-f0-9]{64}$/), parameters: z.record(z.string(), z.unknown()) });
const resolveSchema = tradingRevisionSchema.extend({ acknowledged: z.literal(true), brokerOrderId: z.string().trim().min(1).max(500).nullable() });
const orderParamsSchema = z.object({ orderId: z.string().max(100).uuid() }).strict();
const emptySchema = z.object({}).strict();
const sourceParamsSchema = z.object({ jobId: z.string().min(1).max(100) }).strict();
const quoteParamsSchema = z.object({ symbol: z.string().regex(/^[A-Za-z0-9]{6}$/) }).strict();

async function respond(reply: FastifyReply, operation: () => unknown): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TradingError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "요청 값을 확인하세요.", code: "INVALID_REQUEST" });
    throw error;
  }
}

export function registerTradingRoutes(app: FastifyInstance, service: TradingService, requireAuth: PreHandler): void {
  const auth = { preHandler: requireAuth };
  app.get("/trading", auth, async (_request, reply) => respond(reply, () => service.snapshot()));
  app.get("/trading/quotes/:symbol", auth, async (request, reply) => respond(reply, () => service.quote(quoteParamsSchema.parse(request.params).symbol)));
  app.get("/trading/strategies", auth, async (_request, reply) => respond(reply, () => ({ strategies: service.artifacts() })));
  app.get("/trading/source/:jobId", auth, async (request, reply) => respond(reply, () => service.source(sourceParamsSchema.parse(request.params).jobId)));
  app.post("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision, initialCashKrw, ...setup } = tradingWriteSchema.parse(request.body);
    return service.register(setup, expectedRevision, request.authUser!.id, initialCashKrw);
  }));
  app.put("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision, initialCashKrw, ...setup } = tradingWriteSchema.parse(request.body);
    return service.update(setup, expectedRevision, request.authUser!.id, initialCashKrw);
  }));
  app.delete("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = tradingRevisionSchema.parse(request.body);
    return service.remove(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/version", auth, async (request, reply) => respond(reply, () => {
    const { artifactHash, parameters, expectedRevision } = versionSchema.parse(request.body);
    return service.version(artifactHash, parameters, expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/activate", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = activationSchema.parse(request.body);
    return service.activate(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/deactivate", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = activationSchema.parse(request.body);
    return service.deactivate(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/prepare", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = tradingRevisionSchema.parse(request.body);
    const snapshot = service.prepareData(expectedRevision, request.authUser!.id);
    return reply.code(202).send(snapshot);
  }));
  app.post("/trading/orders/:orderId/resolve", auth, async (request, reply) => respond(reply, () => {
    const { orderId } = orderParamsSchema.parse(request.params);
    const { expectedRevision, brokerOrderId } = resolveSchema.parse(request.body);
    return service.resolveOrder(orderId, brokerOrderId, expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/refresh", auth, async (request, reply) => respond(reply, () => {
    emptySchema.parse(request.body);
    return service.refresh();
  }));
}
