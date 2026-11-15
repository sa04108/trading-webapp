import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { historyQuerySchema } from "../../../../shared/schemas/backtest-history.js";
import {
  intradayPeriodSchema,
  intradaySymbolSchema,
  intradayTimeframeSchema,
} from "../../../../shared/schemas/intraday.js";
import {
  IntradayError,
  type IntradayService,
} from "../application/intraday-service.js";
const idSchema = z.object({ id: z.string().uuid() }).strict();
const runHistoryQuerySchema = historyQuerySchema
  .extend({ limit: historyQuerySchema.shape.limit.default(100) })
  .refine(
    (q) => q.sort !== "cagrPct",
    "분봉 백테스트의 CAGR은 아직 정의되지 않았습니다.",
  );
const chartSchema = z
  .object({
    symbol: intradaySymbolSchema,
    from: z.string(),
    to: z.string(),
    timeframe: intradayTimeframeSchema,
  })
  .strict();
type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;
export function registerIntradayRoutes(
  app: FastifyInstance,
  service: IntradayService,
  requireAuth: PreHandler,
): void {
  const auth = { preHandler: requireAuth };
  async function respond(reply: FastifyReply, action: () => unknown) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof IntradayError)
        return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: error.issues.map((i) => i.message).join("; ") });
      throw error;
    }
  }
  app.get("/intraday/data", auth, async (request, reply) =>
    respond(reply, () => service.overview(request.authUser!.id)),
  );
  app.get("/intraday/symbols", auth, async (request, reply) =>
    respond(reply, async () => {
      const { q } = z
        .object({ q: z.string().trim().min(1).max(50) })
        .strict()
        .parse(request.query);
      return { symbols: await service.search(q) };
    }),
  );
  app.get("/intraday/chart", auth, async (request, reply) =>
    respond(reply, () => {
      const { symbol, from, to, timeframe } = chartSchema.parse(request.query);
      return service.chart(
        symbol,
        intradayPeriodSchema.parse({ from, to }),
        timeframe,
      );
    }),
  );
  app.post("/intraday/collections", auth, async (request, reply) =>
    respond(reply, () => {
      const result = service.collect(request.authUser!.id, request.body);
      reply.code(202);
      return result;
    }),
  );
  app.delete("/intraday/collections/:id", auth, async (request, reply) =>
    respond(reply, () =>
      service.cancelCollection(
        request.authUser!.id,
        idSchema.parse(request.params).id,
      ),
    ),
  );
  app.get("/intraday/runs/groups", auth, async (request, reply) =>
    respond(reply, () => ({ groups: service.listRunGroups(request.authUser!.id) })),
  );
  app.get("/intraday/runs", auth, async (request, reply) =>
    respond(reply, () => {
      const query = runHistoryQuerySchema.parse(request.query ?? {});
      return {
        runs: service.listRuns(request.authUser!.id, query),
        total: service.countRuns(request.authUser!.id, query.strategyId),
      };
    }),
  );
  app.post("/intraday/runs", auth, async (request, reply) =>
    respond(reply, () => {
      const result = service.submit(request.authUser!.id, request.body);
      reply.code(202);
      return result;
    }),
  );
  app.get("/intraday/runs/:id", auth, async (request, reply) =>
    respond(reply, () =>
      service.getRun(request.authUser!.id, idSchema.parse(request.params).id),
    ),
  );
  app.delete("/intraday/runs/:id", auth, async (request, reply) =>
    respond(reply, () =>
      service.cancelRun(
        request.authUser!.id,
        idSchema.parse(request.params).id,
      ),
    ),
  );
}
