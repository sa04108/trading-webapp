import {
  cryptoPaperSettingsSchema,
  cryptoPaperActiveSchema,
  cryptoPaperVersionSchema,
} from "../../../shared/crypto-paper.js";
import type { CryptoPaperTrading } from "./paper-trading.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { cryptoBacktestInputSchema } from "../../../shared/crypto-backtest.js";
import type { CryptoBacktests } from "./crypto-backtests.js";
import { listUpbitKrwMarkets } from "./upbit.js";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function registerCryptoRoutes(
  app: FastifyInstance,
  service: CryptoBacktests,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const auth = { preHandler: requireAuth };
  app.get("/crypto/markets", auth, async (_request, reply) => {
    try {
      return { markets: await listUpbitKrwMarkets() };
    } catch (error) {
      return reply
        .code(502)
        .send({ error: error instanceof Error ? error.message : "업비트 마켓 조회에 실패했습니다." });
    }
  });
  app.get("/crypto/backtests", auth, async (request, reply) => {
    const query = pageSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "목록 범위가 올바르지 않습니다." });
    return service.list(request.authUser!.id, query.data.limit, query.data.offset);
  });
  app.post("/crypto/backtests", auth, async (request, reply) => {
    const input = cryptoBacktestInputSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: input.error.issues.map((i) => i.message).join(", ") });
    return reply.code(202).send(service.submit(request.authUser!.id, input.data));
  });
  app.get<{ Params: { id: string } }>(
    "/crypto/backtests/:id",
    auth,
    async (request, reply) =>
      service.detail(request.authUser!.id, request.params.id) ??
      reply.code(404).send({ error: "코인 백테스트를 찾을 수 없습니다." }),
  );
  app.delete<{ Params: { id: string } }>("/crypto/backtests/:id", auth, async (request, reply) => {
    const owner = request.authUser!.id,
      id = request.params.id;
    if (service.cancel(owner, id)) return reply.code(204).send();
    if (!service.detail(owner, id))
      return reply.code(404).send({ error: "코인 백테스트를 찾을 수 없습니다." });
    return reply.code(409).send({ error: "이미 종료된 백테스트입니다." });
  });
}

export function registerCryptoPaperRoutes(
  app: FastifyInstance,
  paper: CryptoPaperTrading,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const auth = { preHandler: requireAuth };
  app.get("/crypto/paper", auth, async (request) => ({ account: paper.get(request.authUser!.id) }));
  app.post("/crypto/paper/settings", auth, async (request, reply) => {
    const data = cryptoPaperSettingsSchema.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: "원본 백테스트와 초기 자금을 확인하세요." });
    return { account: paper.configure(request.authUser!.id, data.data.sourceRunId, data.data.initialCash) };
  });
  app.post("/crypto/paper/version", auth, async (request, reply) => {
    const parsed = cryptoPaperVersionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "계좌 설정과 적용할 전략 버전을 확인하세요." });
    return {
      account: paper.updateVersion(
        request.authUser!.id,
        parsed.data.expectedRevision,
        parsed.data.targetVersion,
      ),
    };
  });
  app.post("/crypto/paper/active", auth, async (request, reply) => {
    const data = cryptoPaperActiveSchema.safeParse(request.body);
    if (!data.success) return reply.code(400).send({ error: "자동매매 상태가 올바르지 않습니다." });
    return { account: paper.setActive(request.authUser!.id, data.data.active) };
  });
}
