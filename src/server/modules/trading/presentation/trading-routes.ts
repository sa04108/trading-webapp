import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { intradayTradingPresetSchema, tradingPresetCreateSchema, tradingPresetTitleSchema, tradingRevisionSchema, tradingWriteSchema } from "../../../../shared/schemas/trading.js";
import { IntradayError } from "../../intraday/application/intraday-service.js";
import type { TradingPresets } from "../application/trading-presets.js";
import { TradingError } from "../application/trading-service.js";

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
    if (error instanceof IntradayError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "요청 값을 확인하세요.", code: "INVALID_REQUEST" });
    throw error;
  }
}

export function registerTradingRoutes(app: FastifyInstance, presets: TradingPresets, requireAuth: PreHandler): void {
  const auth = { preHandler: requireAuth };
  const scope = z.object({ presetId: z.string().uuid().optional() }).strict();
  const account = (request: FastifyRequest) => {
    const {presetId} = scope.parse(request.query);
    return presetId === undefined ? presets.defaultAccount : presets.forPreset(presetId);
  };
  app.get("/trading/presets", auth, async (_request, reply) => respond(reply, () => presets.list()));
  app.post("/trading/intraday-presets", auth, async (request, reply) => respond(reply, async () =>
    reply.code(201).send(await presets.createIntraday(intradayTradingPresetSchema.parse(request.body), request.authUser!.id))));
  app.post("/trading/presets", auth, async (request, reply) => respond(reply, async () => {
    const {expectedRevision, initialCashKrw, requestId, ...setup} = tradingPresetCreateSchema.parse(request.body);
    const result = await presets.create(setup, expectedRevision, request.authUser!.id, initialCashKrw, requestId);
    return reply.code(201).send(result);
  }));
  app.get("/trading", auth, async (request, reply) => respond(reply, () => account(request).snapshot()));
  app.patch("/trading/title", auth, async (request, reply) => respond(reply, () => {
    const { deploymentId, expectedRevision, expectedTitle, title } = tradingPresetTitleSchema.parse(request.body);
    return account(request).rename(deploymentId, expectedRevision, expectedTitle, title, request.authUser!.id);
  }));
  app.get("/trading/quotes/:symbol", auth, async (request, reply) => respond(reply, () => account(request).quote(quoteParamsSchema.parse(request.params).symbol)));
  app.get("/trading/strategies", auth, async (_request, reply) => respond(reply, () => ({ strategies: presets.defaultAccount.artifacts() })));
  app.get("/trading/source/:jobId", auth, async (request, reply) => respond(reply, () => presets.defaultAccount.source(sourceParamsSchema.parse(request.params).jobId)));
  app.post("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision, initialCashKrw, ...setup } = tradingWriteSchema.parse(request.body);
    return account(request).register(setup, expectedRevision, request.authUser!.id, initialCashKrw);
  }));
  app.put("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision, initialCashKrw, ...setup } = tradingWriteSchema.parse(request.body);
    return account(request).update(setup, expectedRevision, request.authUser!.id, initialCashKrw);
  }));
  app.delete("/trading/strategy", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = tradingRevisionSchema.parse(request.body);
    return account(request).remove(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/version", auth, async (request, reply) => respond(reply, () => {
    const { artifactHash, parameters, expectedRevision } = versionSchema.parse(request.body);
    return account(request).version(artifactHash, parameters, expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/activate", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = activationSchema.parse(request.body);
    return account(request).activate(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/deactivate", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = activationSchema.parse(request.body);
    return account(request).deactivate(expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/prepare", auth, async (request, reply) => respond(reply, () => {
    const { expectedRevision } = tradingRevisionSchema.parse(request.body);
    const snapshot = account(request).prepareData(expectedRevision, request.authUser!.id);
    return reply.code(202).send(snapshot);
  }));
  app.post("/trading/orders/:orderId/resolve", auth, async (request, reply) => respond(reply, () => {
    const { orderId } = orderParamsSchema.parse(request.params);
    const { expectedRevision, brokerOrderId } = resolveSchema.parse(request.body);
    return account(request).resolveOrder(orderId, brokerOrderId, expectedRevision, request.authUser!.id);
  }));
  app.post("/trading/refresh", auth, async (request, reply) => respond(reply, () => {
    emptySchema.parse(request.body);
    return account(request).refresh();
  }));
}
