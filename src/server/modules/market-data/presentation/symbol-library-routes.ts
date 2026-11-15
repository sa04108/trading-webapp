import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { intradaySymbolSchema } from "../../../../shared/schemas/intraday.js";
import type { SymbolLibraryService } from "../application/symbol-library-service.js";

export function registerSymbolLibraryRoutes(app: FastifyInstance, service: SymbolLibraryService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>): void {
  const auth = { preHandler: requireAuth };
  app.get("/symbols/library", auth, async (request) => service.list(request.authUser!.id));
  app.patch("/symbols/library/:symbol", auth, async (request, reply) => {
    const params = z.object({ symbol: intradaySymbolSchema }).strict().safeParse(request.params);
    const body = z.object({ favorite: z.boolean().optional(), viewed: z.literal(true).optional() }).strict()
      .refine((value) => value.favorite !== undefined || value.viewed === true).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "종목 코드와 관심·조회 변경 내용을 확인하세요." });
    try { return service.update(request.authUser!.id, params.data.symbol, body.data); }
    catch (error) {
      if (error instanceof Error && error.message === "관심 종목은 최대 100개까지 등록할 수 있습니다.")
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
